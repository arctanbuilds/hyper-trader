/**
 * HyperTrader — Trading Engine v17.6 (adds TLBR parallel strategy)
 *
 * SINGLE STRATEGY: BTC NY Open Session Trader (Mon–Fri)
 *
 *   - BTC only — LONG + SHORT
 *   - Session runs once per US trading day:
 *       08:30 ET — Sonar fetches overnight news + macro headlines
 *       08:45 ET — Claude Opus 4.7 analyzes news + technicals → direction + entry zone + confidence
 *       09:30 ET — NY Open: if Opus confidence ≥ 7 and direction is long/short, place entry
 *                   If Opus returned an entry zone, place a LIMIT for 1 min, then MARKET
 *                   If no zone, place MARKET at open
 *       Until 10:00 ET — if zone was provided but not touched, take MARKET at 10:00 cutoff
 *                       (user rule: "open market always if you see an opportunity")
 *   - Size: 80% of AUM, 20x leverage
 *   - TP1 +0.5% (close 50%) → TP2 +1.0% (close remaining 50%) / SL -0.5%
 *   - On TP1 fill: SL moves to entry +0.25% (BE+ profit lock) on remaining 50%
 *   - Technicals-first prompt + hard-veto guard (overbought at EMA200 = SKIP regardless of news)
 *   - BE+ rule (v17.5): triggered on TP1 fill (position size halved), SL moves to +0.25% profit lock
 *   - Re-entry: allowed if TP hits within the same session window; blocked if SL hits (one failed setup = done)
 *   - Confidence threshold: ≥ 7/10
 *
 * Shared infra:
 *   - Scan every 5 seconds (TP/SL/BE+ monitoring only — no entry scanning)
 *   - Cancel all orders on close (ghost position prevention)
 *   - Orphan detector on startup
 *   - SL + TP orders placed on HL immediately at fill
 *
 * Removed in v17.1:
 *   - Breakout & Retest (TradingView webhook) strategy
 *   - RSI-30 Multi-Asset OBOS strategy
 *   - Oil News Sentiment strategy (xyz:CL)
 */

// minifyIdentifiers: false — keep readable names for debugging

import { storage } from "./storage";
import { log } from "./index";
import { createExecutor } from "./hyperliquid-executor";
import { logDecision, reviewClosedTrades, generateInsights, getLearningStats, run24hReview } from "./learning-engine";

// ============ ASSET CONFIGURATION ============

interface AssetConfig {
  coin: string;
  displayName: string;
  dex: string;
  maxLeverage: number;
  szDecimals: number;
  category: "crypto" | "commodity" | "forex" | "index";
  minNotional: number;
  isolatedOnly?: boolean;
}

// v17.1 BTC Session Trader — single asset
const ALLOWED_ASSETS: AssetConfig[] = [
  { coin: "BTC", displayName: "Bitcoin", dex: "", maxLeverage: 40, szDecimals: 5, category: "crypto", minNotional: 10 },
];
const BTC_ASSET = ALLOWED_ASSETS[0];

// v17.5 Session constants — technicals-first, TP1/TP2 scale-out
const SESSION_TP1_PCT = 0.005;            // +0.5% — close 50%, move SL to BE+
const SESSION_TP2_PCT = 0.01;             // +1.0% — close remaining 50%
const SESSION_SL_PCT  = 0.005;            // -0.5%
const SESSION_TP1_SIZE_PCT = 0.50;        // 50% of position at TP1
const SESSION_BE_LOCK_PCT = 0.0025;       // after TP1 fills, SL moves to entry ± 0.25%
const SESSION_EQUITY_PCT = 0.80;          // 80% of AUM per trade
const SESSION_LEVERAGE = 20;              // 20x
const SESSION_CONFIDENCE_THRESHOLD = 7;   // min confidence to trade
const SESSION_ENTRY_LIMIT_MS = 60 * 1000; // 1 min limit window, then market

// NY schedule (ET). We compute UTC hour at runtime using America/New_York TZ.
const SESSION_NEWS_ET = { hour: 8, minute: 30 };     // Sonar news scan
const SESSION_DECISION_ET = { hour: 8, minute: 45 }; // Opus first decision
const SESSION_OPEN_ET = { hour: 9, minute: 30 };     // NY open entry
const SESSION_CUTOFF_ET = { hour: 15, minute: 30 };  // v17.3 hard cutoff — 1hr buffer before NY close; positions can run overnight
// v17.3 qualification-gate retry loop — all day until cutoff
const SESSION_RETRY_INTERVAL_MIN = 15;  // retry every 15 minutes
const SESSION_MAX_RETRIES = 27;         // 09:00 through 15:30 (every 15 min = 27 retries after 08:45 first call)
const SESSION_RETRY_START_ET = { hour: 9, minute: 0 };  // first retry slot (after 08:45 first call)

const ALL_TRADEABLE_COINS = [...ALLOWED_ASSETS.map(a => a.coin)];

// ============ STRATEGY TYPE ============
// Legacy types kept in union for DB compatibility with historical closed trades.
type StrategyType = "btc_session" | "breakout" | "obos" | "oil_news" | "trendline" | "tlbr";

// ============ v17.6 TLBR (Trend Line Breakout & Retest) ============
// Parallel strategy: Opus 4.7 scans BTC every 60 min on weekdays for descending-trendline
// breakouts. If valid setup found (breakout confirmed + retest zone + FVG confluence),
// store the retest level. Each 5s scan loop checks if current price enters the retest
// zone AND FVG is still valid → execute market LONG. TP +0.35% / SL -0.30%.
// Kill switch: cumulative TLBR P&L ≤ -$50 disables TLBR only (SESSION keeps running).
const TLBR_MARGIN_USD = 100;                       // fixed $100 margin per trade
const TLBR_LEVERAGE = 20;                          // 20x → $2,000 notional
const TLBR_TP_PCT = 0.0035;                        // +0.35%
const TLBR_SL_PCT = 0.003;                         // -0.30%
const TLBR_OPUS_INTERVAL_MIN = 60;                 // discovery cadence (weekdays only)
const TLBR_KILL_SWITCH_USD = -50;                  // cumulative P&L floor
const TLBR_SETUP_MAX_AGE_MS = 15 * 60 * 1000;      // 15min — expire pending setup if no retest touches
const TLBR_INVALIDATE_DISTANCE_PCT = 0.01;         // 1% below retest level = trendline broken

interface TlbrTrendline {
  p1: { t: number; price: number };   // anchor point 1 (earlier high)
  p2: { t: number; price: number };   // anchor point 2 (later high)
  slope: number;                       // price change per ms
}
interface TlbrFvg {
  low: number;  // FVG lower bound
  high: number; // FVG upper bound
}
interface TlbrPendingSetup {
  trendline: TlbrTrendline;
  breakoutPrice: number;        // price at which breakout was confirmed
  retestLevel: number;          // projected retest price
  retestZoneLow: number;        // zone tolerance (usually retestLevel * 0.998)
  retestZoneHigh: number;       // retestLevel * 1.002
  fvg: TlbrFvg | null;
  confidence: number;           // 1-10 from Opus
  reasoning: string;
  discoveredAt: number;         // ms timestamp
}
interface TlbrState {
  disabled: boolean;            // killed by kill switch
  cumulativePnlUsd: number;     // running total of TLBR trade P&L
  lastOpusCallAt: number;       // ms timestamp of last discovery scan
  pendingSetup: TlbrPendingSetup | null;
  consumedTrendlineIds: string[];   // hashes of trendlines already traded — never retry
  openTradeId: number | null;   // id of current open TLBR trade (if any)
}
function emptyTlbrState(): TlbrState {
  return {
    disabled: false,
    cumulativePnlUsd: 0,
    lastOpusCallAt: 0,
    pendingSetup: null,
    consumedTrendlineIds: [],
    openTradeId: null,
  };
}
function tlbrTrendlineId(tl: TlbrTrendline): string {
  return `${Math.round(tl.p1.price)}_${Math.round(tl.p2.price)}_${tl.p1.t}_${tl.p2.t}`;
}

// ============ PERPLEXITY / SONAR / OPUS CLIENT ============

const PPLX_ENDPOINT = "https://api.perplexity.ai/v1/responses";
const SONAR_MODEL = "perplexity/sonar";
const OPUS_MODEL = "anthropic/claude-opus-4-7";

interface SessionNews {
  headlines: string[];
  summary: string;
  sentimentHint: string;
}

async function fetchBtcNews(apiKey: string): Promise<SessionNews> {
  const systemPrompt = `You are a Bitcoin macro/micro news analyst. Pull the latest Bitcoin, crypto, and macro headlines from the past 12 hours that could affect BTC price direction during the upcoming US cash session (09:30–16:00 ET).

Focus on:
- Bitcoin spot ETF flows (IBIT, FBTC, BITB, GBTC)
- Institutional BTC purchases/sales (MicroStrategy, BlackRock, etc.)
- On-chain flows — large withdrawals, exchange inflows, miner activity
- US economic data released overnight / premarket (CPI, NFP, PPI, FOMC, retail sales, Fed speakers)
- Regulatory news (SEC, CFTC, Treasury, legislation)
- Macro: DXY, US10Y yield, S&P futures, gold
- Asia session close tone (was it risk-on or risk-off?)
- Major BTC whale moves, liquidation cascades overnight

RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no code fences):
{
  "headlines": ["headline 1", "headline 2", "headline 3", "headline 4", "headline 5"],
  "summary": "2-3 sentence summary of overnight tone for BTC",
  "sentimentHint": "bullish" | "bearish" | "mixed" | "quiet"
}`;

  const prompt = `Search for Bitcoin and macro headlines from the past 12 hours. Return the JSON object only.`;

  try {
    const res = await fetch(PPLX_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SONAR_MODEL,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        max_output_tokens: 1500,
        tools: [{ type: "web_search" }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      log(`[SESSION NEWS] Sonar API error: ${res.status} ${errText.slice(0, 300)}`, "engine");
      return { headlines: [], summary: `API error: ${res.status}`, sentimentHint: "quiet" };
    }
    const data: any = await res.json();
    let text = "";
    if (data.output && Array.isArray(data.output)) {
      for (const block of data.output) {
        if (block.type === "message" && block.content) {
          for (const c of block.content) {
            if (c.type === "output_text") text = c.text;
          }
        }
      }
    }
    if (!text && data.output_text) text = data.output_text;
    if (!text) return { headlines: [], summary: "No output from Sonar", sentimentHint: "quiet" };

    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);
    return {
      headlines: Array.isArray(parsed.headlines) ? parsed.headlines.slice(0, 8).map(String) : [],
      summary: String(parsed.summary || "").slice(0, 600),
      sentimentHint: ["bullish", "bearish", "mixed", "quiet"].includes(parsed.sentimentHint) ? parsed.sentimentHint : "mixed",
    };
  } catch (e) {
    log(`[SESSION NEWS] Fetch error: ${e}`, "engine");
    return { headlines: [], summary: `Error: ${e}`, sentimentHint: "quiet" };
  }
}

interface SessionDecision {
  direction: "long" | "short" | "skip";
  entry: number | null;
  confidence: number;
  reasoning: string;
  raw: string;
}

async function fetchBtcDecision(apiKey: string, news: SessionNews, tech: BtcTechnicals, currentPrice: number): Promise<SessionDecision> {
  const systemPrompt = `You are an institutional-grade Bitcoin day-trader preparing for the US cash session (09:30–16:00 ET). You have overnight news AND multi-timeframe technicals. Your job is to decide ONE directional call.

=== DECISION HIERARCHY (strict order) ===
1. TECHNICALS ARE PRIMARY — price action, RSI, EMAs, key levels determine direction and can VETO any trade.
2. NEWS IS SECONDARY — used only to CONFIRM a technical setup or add marginal confidence. News NEVER overrides technicals. A bullish news tape into overbought technicals is a SHORT candidate, not a LONG chase.

=== HARD VETOES — force SKIP regardless of news sentiment ===
- LONG VETO: if 1h RSI ≥ 68 AND 24h change ≥ +3% AND price within 0.3% of 4h EMA200 → SKIP (do not chase overbought into resistance)
- SHORT VETO: if 1h RSI ≤ 32 AND 24h change ≤ -3% AND price within 0.3% of 4h EMA200 → SKIP (do not short oversold into support)
- If news contradicts technicals → cap confidence at 6 (= SKIP).

=== DIRECTION LOGIC (technicals-first) ===
- LONG setup: pullback into support, RSI oversold recovering (1h RSI rising from <40), EMA stack bullish (price above EMA20>EMA50 on 1h, above 4h EMA200). News bullish = confirm.
- SHORT setup: rejection at resistance, RSI overbought rolling over (1h RSI falling from >65), EMA stack bearish (price below EMA20<EMA50 on 1h, below 4h EMA200). News bearish = confirm.
- SKIP: chop, mid-range, RSI 45–55 with no clear momentum, price between key levels, news-only setups.

=== OUTPUT RULES ===
- Output "long", "short", or "skip"
- confidence 1-4 = weak (= skip), 5-6 = moderate (= skip), 7-8 = strong, 9-10 = very strong
- Only recommend a trade you would take at 10/10 institutional standards
- Entry price: provide a specific BTC price if you see a better-than-market entry zone within 0.3% of current price; otherwise set entry = null (meaning "market at open")
- In reasoning, state the TECHNICAL thesis FIRST, then use news as confirmation/tiebreaker.
- If any HARD VETO triggers, you must output "skip" and state which veto fired.

RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no code fences):
{
  "direction": "long" | "short" | "skip",
  "entry": <number or null>,
  "confidence": 1-10,
  "reasoning": "3-5 sentences explaining the thesis: news + technicals + risk"
}`;

  const userPrompt = `CURRENT BTC PRICE: $${currentPrice.toFixed(2)}

OVERNIGHT NEWS (past 12h):
Sentiment hint: ${news.sentimentHint}
Summary: ${news.summary}
Headlines:
${news.headlines.map((h, i) => `  ${i + 1}. ${h}`).join("\n") || "  (none collected)"}

TECHNICALS:
- 1h RSI: ${tech.rsi1h.toFixed(1)}
- 4h RSI: ${tech.rsi4h.toFixed(1)}
- 1d RSI: ${tech.rsi1d.toFixed(1)}
- EMA20 (1h): $${tech.ema20_1h.toFixed(2)}
- EMA50 (1h): $${tech.ema50_1h.toFixed(2)}
- EMA200 (4h): $${tech.ema200_4h.toFixed(2)}
- 24h range: $${tech.low24h.toFixed(2)} – $${tech.high24h.toFixed(2)}
- 24h change: ${tech.change24h.toFixed(2)}%
- Last swing high (4h): $${tech.swingHigh.toFixed(2)}
- Last swing low (4h): $${tech.swingLow.toFixed(2)}

Decide direction for the NY session. Return the JSON object only.`;

  try {
    const res = await fetch(PPLX_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPUS_MODEL,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_output_tokens: 1200,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      log(`[SESSION DECISION] Opus API error: ${res.status} ${errText.slice(0, 300)}`, "engine");
      return { direction: "skip", entry: null, confidence: 0, reasoning: `API error: ${res.status}`, raw: errText.slice(0, 500) };
    }
    const data: any = await res.json();
    let text = "";
    if (data.output && Array.isArray(data.output)) {
      for (const block of data.output) {
        if (block.type === "message" && block.content) {
          for (const c of block.content) {
            if (c.type === "output_text") text = c.text;
          }
        }
      }
    }
    if (!text && data.output_text) text = data.output_text;
    if (!text) return { direction: "skip", entry: null, confidence: 0, reasoning: "No output", raw: "" };

    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);
    let direction = parsed.direction === "long" || parsed.direction === "short" ? parsed.direction : "skip";
    let confidence = typeof parsed.confidence === "number" ? Math.min(10, Math.max(0, parsed.confidence)) : 0;
    let entry: number | null = null;
    if (typeof parsed.entry === "number" && parsed.entry > 0) entry = parsed.entry;
    let reasoning = String(parsed.reasoning || "").slice(0, 800);

    // v17.5 CODE-LEVEL VETO GUARD — belt-and-suspenders: override Opus if it still picks long/short under extreme conditions
    const distToEma200Pct = tech.ema200_4h > 0 ? Math.abs(currentPrice - tech.ema200_4h) / tech.ema200_4h * 100 : 999;
    const longVeto  = tech.rsi1h >= 68 && tech.change24h >= 3.0 && distToEma200Pct <= 0.3;
    const shortVeto = tech.rsi1h <= 32 && tech.change24h <= -3.0 && distToEma200Pct <= 0.3;
    if (direction === "long" && longVeto) {
      const vetoMsg = `VETO-LONG: 1h RSI ${tech.rsi1h.toFixed(1)}≥68, 24h chg ${tech.change24h.toFixed(2)}%≥+3%, dist to 4h EMA200 ${distToEma200Pct.toFixed(2)}%≤0.3% — forcing SKIP`;
      log(`[SESSION VETO] ${vetoMsg}`, "engine");
      reasoning = `[CODE VETO] ${vetoMsg} | Original Opus: ${reasoning}`;
      direction = "skip"; confidence = Math.min(confidence, 4); entry = null;
    } else if (direction === "short" && shortVeto) {
      const vetoMsg = `VETO-SHORT: 1h RSI ${tech.rsi1h.toFixed(1)}≤32, 24h chg ${tech.change24h.toFixed(2)}%≤-3%, dist to 4h EMA200 ${distToEma200Pct.toFixed(2)}%≤0.3% — forcing SKIP`;
      log(`[SESSION VETO] ${vetoMsg}`, "engine");
      reasoning = `[CODE VETO] ${vetoMsg} | Original Opus: ${reasoning}`;
      direction = "skip"; confidence = Math.min(confidence, 4); entry = null;
    }

    log(`[SESSION DECISION] Opus: ${direction.toUpperCase()} conf=${confidence}/10 entry=${entry ?? "MARKET"} | ${reasoning.slice(0, 150)}`, "engine");
    return { direction, entry, confidence, reasoning, raw: text.slice(0, 1500) };
  } catch (e) {
    log(`[SESSION DECISION] Error: ${e}`, "engine");
    return { direction: "skip", entry: null, confidence: 0, reasoning: `Error: ${e}`, raw: "" };
  }
}

// ============ v17.6 TLBR OPUS ANALYSIS ============
// Sends 96x5m candles (8 hours) + current price to Claude Opus 4.7. Opus returns a
// structured JSON with trendline, breakout confirmation, retest zone, and FVG.
// Response is parsed into TlbrPendingSetup. Called every 60 min on weekdays by the
// main scan cycle when tlbrState has no pendingSetup.

interface TlbrAnalysisResult {
  setup: TlbrPendingSetup | null;
  raw: string;
  confidence: number;
  reasoning: string;
}

async function fetchTlbrAnalysis(apiKey: string, candles5m: OHLCVCandle[], currentPrice: number): Promise<TlbrAnalysisResult> {
  // Build a compact OHLCV table for Opus. Use last 96 candles (8h of 5m data).
  const slice = candles5m.slice(-96);
  const now = Date.now();
  const intervalMs = 5 * 60 * 1000;
  const baseTs = now - slice.length * intervalMs;
  const candleRows = slice.map((c, i) => {
    const t = baseTs + i * intervalMs;
    return `${i},${t},${c.open.toFixed(1)},${c.high.toFixed(1)},${c.low.toFixed(1)},${c.close.toFixed(1)},${c.volume.toFixed(0)}`;
  }).join("\n");

  const systemPrompt = `You are an institutional-grade technical analyst specialized in trendline breakout-and-retest (TLBR) setups on BTC 5m charts.

YOUR JOB: Given 96 candles of BTC 5m OHLCV data, identify a VALID descending-trendline breakout that has broken UP through a descending resistance line, and project where the retest should occur.

=== A VALID SETUP REQUIRES ALL OF ===
1. QUALIFIED DESCENDING TRENDLINE (STRICT): at least 3 distinct swing-high rejections where price touched or pierced the trendline and then sold off. Each subsequent rejection must occur at a LOWER price than the prior. The trendline must span AT LEAST 3 HOURS (36+ candles) and ideally 4–5 hours between the first and last rejection. A trendline drawn on only 2 touches or spanning less than 3 hours is NOT valid — return setup=null.
2. BREAKOUT: at least one 5m candle closed ABOVE the extended trendline, with the close > trendline value at that time by at least 0.10%. Must have occurred within the last 20 candles (last 100 min).
3. RETEST PROJECTION: after the breakout, project where the extended trendline line now sits. The retest zone is that price ± 0.2%. The retest level must be BELOW current price (so price has to pull back to retest).
4. FVG (Fair Value Gap) CONFLUENCE (optional but preferred): look for a bullish FVG (gap where candle N+1 low > candle N-1 high) within 0.5% of the retest level. If found, report its low/high.

=== REPORT TRENDLINE QUALITY ===
Return "touches" = number of distinct rejections (must be ≥3). Return "durationHours" = hours between first and last rejection (must be ≥3.0).

=== HARD RULES ===
- LONG-ONLY (we only trade descending-trendline breakouts = bullish reversal).
- If no valid setup exists, return setup=null. DO NOT force a setup.
- Confidence: 1-4 weak (no setup), 5-6 marginal (report setup but mark low conf), 7-8 strong (textbook setup), 9-10 very strong (multi-touch trendline + FVG + volume expansion on breakout).
- We will only enter setups with confidence ≥ 7.
- Retest level must be between (currentPrice * 0.985) and currentPrice. If the projected retest is above current price or more than 1.5% below, return setup=null (too stale).

=== OUTPUT ===
RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no code fences):
{
  "setup": {
    "trendline": { "p1": { "t": <ms_timestamp>, "price": <number> }, "p2": { "t": <ms_timestamp>, "price": <number> } },
    "touches": <integer ≥3>,
    "durationHours": <number ≥3.0>,
    "breakoutPrice": <number>,
    "retestLevel": <number>,
    "fvg": { "low": <number>, "high": <number> } | null
  } | null,
  "confidence": 1-10,
  "reasoning": "2-4 sentences explaining what you see, or why no setup"
}`;

  const userPrompt = `CURRENT BTC PRICE: $${currentPrice.toFixed(2)}
CURRENT TIME (ms): ${now}

96 CANDLES (5m interval). Columns: idx,timestamp_ms,open,high,low,close,volume
${candleRows}

Analyze the chart for a descending-trendline breakout + retest setup. Return the JSON object only.`;

  try {
    const res = await fetch(PPLX_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPUS_MODEL,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_output_tokens: 1500,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      log(`[TLBR] Opus API error: ${res.status} ${errText.slice(0, 300)}`, "engine");
      return { setup: null, raw: errText.slice(0, 500), confidence: 0, reasoning: `API error: ${res.status}` };
    }
    const data: any = await res.json();
    let text = "";
    if (data.output && Array.isArray(data.output)) {
      for (const block of data.output) {
        if (block.type === "message" && block.content) {
          for (const c of block.content) {
            if (c.type === "output_text") text = c.text;
          }
        }
      }
    }
    if (!text && data.output_text) text = data.output_text;
    if (!text) return { setup: null, raw: "", confidence: 0, reasoning: "No output from Opus" };

    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);
    const confidence = typeof parsed.confidence === "number" ? Math.min(10, Math.max(0, parsed.confidence)) : 0;
    const reasoning = String(parsed.reasoning || "").slice(0, 600);

    // Validate setup structure
    if (!parsed.setup || !parsed.setup.trendline || !parsed.setup.retestLevel) {
      log(`[TLBR] No setup found (conf=${confidence}): ${reasoning.slice(0, 150)}`, "engine");
      return { setup: null, raw: text.slice(0, 1000), confidence, reasoning };
    }
    const tl = parsed.setup.trendline;
    const retestLevel = Number(parsed.setup.retestLevel);
    const breakoutPrice = Number(parsed.setup.breakoutPrice) || currentPrice;
    if (!tl.p1 || !tl.p2 || !Number.isFinite(retestLevel) || retestLevel <= 0) {
      log(`[TLBR] Malformed setup — rejecting. reasoning=${reasoning.slice(0, 120)}`, "engine");
      return { setup: null, raw: text.slice(0, 1000), confidence, reasoning };
    }

    // Sanity: retest must be below current price and within 1.5%
    const minRetest = currentPrice * 0.985;
    if (retestLevel >= currentPrice || retestLevel < minRetest) {
      log(`[TLBR] Retest level $${retestLevel.toFixed(2)} out of band (current $${currentPrice.toFixed(2)}, min $${minRetest.toFixed(2)}) — rejecting`, "engine");
      return { setup: null, raw: text.slice(0, 1000), confidence, reasoning };
    }

    // Quality gate: enforce ≥3 touches and ≥3h duration (code-level double-check)
    const touches = Number(parsed.setup.touches) || 0;
    const durationHours = Number(parsed.setup.durationHours) || 0;
    if (touches < 3 || durationHours < 3.0) {
      log(`[TLBR] Trendline quality insufficient — touches=${touches} (need ≥3), durationHours=${durationHours.toFixed(1)} (need ≥3.0) — rejecting`, "engine");
      return { setup: null, raw: text.slice(0, 1000), confidence, reasoning };
    }

    const trendline: TlbrTrendline = {
      p1: { t: Number(tl.p1.t), price: Number(tl.p1.price) },
      p2: { t: Number(tl.p2.t), price: Number(tl.p2.price) },
      slope: (Number(tl.p2.price) - Number(tl.p1.price)) / Math.max(1, (Number(tl.p2.t) - Number(tl.p1.t))),
    };
    const fvg: TlbrFvg | null = parsed.setup.fvg && typeof parsed.setup.fvg.low === "number" && typeof parsed.setup.fvg.high === "number"
      ? { low: Number(parsed.setup.fvg.low), high: Number(parsed.setup.fvg.high) }
      : null;

    const setup: TlbrPendingSetup = {
      trendline,
      breakoutPrice,
      retestLevel,
      retestZoneLow: retestLevel * 0.998,
      retestZoneHigh: retestLevel * 1.002,
      fvg,
      confidence,
      reasoning,
      discoveredAt: now,
    };
    log(`[TLBR] Setup found: retest $${retestLevel.toFixed(2)} (zone $${setup.retestZoneLow.toFixed(2)}-$${setup.retestZoneHigh.toFixed(2)}) | touches=${touches} dur=${durationHours.toFixed(1)}h | FVG ${fvg ? `[${fvg.low.toFixed(0)}-${fvg.high.toFixed(0)}]` : "none"} | conf ${confidence}/10`, "engine");
    return { setup, raw: text.slice(0, 1000), confidence, reasoning };
  } catch (e) {
    log(`[TLBR] Analysis error: ${e}`, "engine");
    return { setup: null, raw: "", confidence: 0, reasoning: `Error: ${e}` };
  }
}

// ============ HYPERLIQUID PRICE & SIZE FORMATTING ============

function formatHLPrice(price: number, szDecimals: number): string {
  if (Number.isInteger(price)) return price.toString();
  const maxDecimals = Math.max(6 - szDecimals, 0);
  let s = truncateToDecimals(price, maxDecimals);
  s = truncateToSigFigs(s, 5);
  return s;
}

function formatHLSize(size: number, szDecimals: number): string {
  return truncateToDecimals(size, szDecimals);
}

function truncateToDecimals(value: number, decimals: number): string {
  let s = value.toFixed(decimals + 4);
  const dotIdx = s.indexOf('.');
  if (dotIdx === -1 || decimals === 0) {
    return dotIdx === -1 ? s : s.substring(0, dotIdx);
  }
  s = s.substring(0, dotIdx + 1 + decimals);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

function truncateToSigFigs(s: string, sigFigs: number): string {
  const num = parseFloat(s);
  if (num === 0 || isNaN(num)) return "0";
  if (Number.isInteger(num)) return num.toString();
  const isNeg = s.startsWith('-');
  const abs = isNeg ? s.slice(1) : s;
  const [intPart, decPart = ''] = abs.split('.');
  const combined = intPart + decPart;
  let sigCount = 0;
  let started = false;
  let cutIdx = -1;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] !== '0') started = true;
    if (started) {
      sigCount++;
      if (sigCount === sigFigs) { cutIdx = i; break; }
    }
  }
  if (cutIdx === -1) return s;
  const intLen = intPart.length;
  if (cutIdx < intLen) {
    const kept = intPart.substring(0, cutIdx + 1);
    const zeroed = '0'.repeat(intLen - cutIdx - 1);
    return (isNeg ? '-' : '') + kept + zeroed;
  } else {
    const decIdx = cutIdx - intLen;
    let result = intPart + '.' + decPart.substring(0, decIdx + 1);
    result = result.replace(/0+$/, '').replace(/\.$/, '');
    return (isNeg ? '-' : '') + result;
  }
}

function displayPrice(price: number, szDecimals: number): string {
  return formatHLPrice(price, szDecimals);
}

// ============ TECHNICAL INDICATORS ============

function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60 * 1000, "5m": 5 * 60 * 1000, "15m": 15 * 60 * 1000,
  "1h": 3600 * 1000, "4h": 4 * 3600 * 1000, "1d": 24 * 3600 * 1000,
};

interface OHLCVCandle { open: number; high: number; low: number; close: number; volume: number; }

async function fetchCandlesOHLCV(coin: string, interval: string = "1h", limit: number = 100): Promise<OHLCVCandle[]> {
  try {
    const endTime = Date.now();
    const ms = INTERVAL_MS[interval] || 3600 * 1000;
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime: endTime - limit * ms, endTime } }),
    });
    const candles: any[] = await res.json() as any;
    if (!Array.isArray(candles)) return [];
    return candles.map((c: any) => ({
      open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l),
      close: parseFloat(c.c), volume: parseFloat(c.v),
    }));
  } catch (e) { log(`OHLCV error ${coin}/${interval}: ${e}`, "engine"); return []; }
}

async function fetchAllMids(): Promise<Record<string, string>> {
  try {
    const res = await fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
    return await res.json() as any;
  } catch (e) { log(`Mids error: ${e}`, "engine"); return {}; }
}

async function fetchMetaAndAssetCtxs(): Promise<any> {
  try {
    const res = await fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) });
    return await res.json();
  } catch (e) { log(`MetaCtx error: ${e}`, "engine"); return null; }
}

async function fetchUserState(address: string): Promise<any> {
  try {
    const [perpsRes, spotRes] = await Promise.all([
      fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: address }) }),
      fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "spotClearinghouseState", user: address }) }),
    ]);
    const perpsData: any = await perpsRes.json();
    const spotData: any = await spotRes.json();
    const perpsEquity = parseFloat(perpsData?.marginSummary?.accountValue || "0");
    const spotBalances = spotData?.balances || [];
    const usdcBalance = spotBalances.find((b: any) => b.coin === "USDC");
    const spotEquity = parseFloat(usdcBalance?.total || "0");
    const trueEquity = Math.max(spotEquity, perpsEquity);
    perpsData.marginSummary = {
      ...perpsData.marginSummary,
      accountValue: trueEquity.toString(),
      totalRawUsd: trueEquity.toString(),
    };
    return perpsData;
  } catch (e) { log(`UserState error: ${e}`, "engine"); return null; }
}

// ============ HL FILLS — GROUND TRUTH P&L ============

async function fetchUserFills(address: string, startTime?: number): Promise<any[]> {
  try {
    const body: any = { type: "userFillsByTime", user: address, startTime: startTime || (Date.now() - 24 * 3600 * 1000) };
    const res = await fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as any[];
  } catch (e) { log(`Fills error: ${e}`, "engine"); return []; }
}

function extractClosePnlFromFills(fills: any[], coin: string, side: "long" | "short", afterTime: number): {
  closedPnl: number; totalFee: number; netPnl: number; exitPrice: number; exitSize: number;
} | null {
  const closeDir = side === "long" ? "Close Long" : "Close Short";
  const closeFills = fills.filter(f => f.coin === coin && f.dir === closeDir && f.time >= afterTime);
  if (closeFills.length === 0) return null;
  let closedPnl = 0, totalFee = 0, totalSz = 0, weightedPx = 0;
  for (const f of closeFills) {
    closedPnl += parseFloat(f.closedPnl || "0");
    totalFee += parseFloat(f.fee || "0");
    const sz = parseFloat(f.sz || "0");
    totalSz += sz;
    weightedPx += parseFloat(f.px || "0") * sz;
  }
  const exitPrice = totalSz > 0 ? weightedPx / totalSz : 0;
  const netPnl = closedPnl - totalFee;
  return { closedPnl, totalFee, netPnl, exitPrice, exitSize: totalSz };
}

// ============ BTC TECHNICALS HELPER ============

interface BtcTechnicals {
  rsi1h: number;
  rsi4h: number;
  rsi1d: number;
  ema20_1h: number;
  ema50_1h: number;
  ema200_4h: number;
  high24h: number;
  low24h: number;
  change24h: number;
  swingHigh: number;
  swingLow: number;
}

async function computeBtcTechnicals(currentPrice: number): Promise<BtcTechnicals> {
  const [c1h, c4h, c1d] = await Promise.all([
    fetchCandlesOHLCV("BTC", "1h", 250),
    fetchCandlesOHLCV("BTC", "4h", 100),
    fetchCandlesOHLCV("BTC", "1d", 50),
  ]);
  const closes1h = c1h.map(c => c.close);
  const closes4h = c4h.map(c => c.close);
  const closes1d = c1d.map(c => c.close);
  const rsi1h = calculateRSI([...closes1h, currentPrice]);
  const rsi4h = calculateRSI([...closes4h, currentPrice]);
  const rsi1d = calculateRSI([...closes1d, currentPrice]);
  const ema20_1h = calculateEMA(closes1h, 20);
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema200_4h = calculateEMA(closes4h, 200);

  // 24h window = last 24 1h candles
  const last24 = c1h.slice(-24);
  const high24h = last24.length > 0 ? Math.max(...last24.map(c => c.high)) : currentPrice;
  const low24h = last24.length > 0 ? Math.min(...last24.map(c => c.low)) : currentPrice;
  const openOf24h = last24.length > 0 ? last24[0].open : currentPrice;
  const change24h = openOf24h > 0 ? ((currentPrice - openOf24h) / openOf24h) * 100 : 0;

  // swing high/low from 4h fractals (5-candle)
  let swingHigh = currentPrice, swingLow = currentPrice;
  if (c4h.length >= 10) {
    for (let i = c4h.length - 3; i >= 2; i--) {
      const ch = c4h[i];
      if (ch.high >= c4h[i-1].high && ch.high >= c4h[i-2].high && ch.high >= c4h[i+1].high && ch.high >= c4h[i+2].high) {
        swingHigh = ch.high;
        break;
      }
    }
    for (let i = c4h.length - 3; i >= 2; i--) {
      const cl = c4h[i];
      if (cl.low <= c4h[i-1].low && cl.low <= c4h[i-2].low && cl.low <= c4h[i+1].low && cl.low <= c4h[i+2].low) {
        swingLow = cl.low;
        break;
      }
    }
  }

  return { rsi1h, rsi4h, rsi1d, ema20_1h, ema50_1h, ema200_4h, high24h, low24h, change24h, swingHigh, swingLow };
}

// ============ TIMEZONE HELPERS (America/New_York) ============

interface ETDateParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number; }

function getEtParts(d: Date = new Date()): ETDateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const obj: any = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  // weekday abbreviation -> 0=Sun, 1=Mon, ..., 6=Sat
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(obj.year), month: parseInt(obj.month), day: parseInt(obj.day),
    hour: parseInt(obj.hour === "24" ? "0" : obj.hour), minute: parseInt(obj.minute), second: parseInt(obj.second),
    weekday: wdMap[obj.weekday] ?? 0,
  };
}

function isWeekdayET(): boolean {
  const p = getEtParts();
  return p.weekday >= 1 && p.weekday <= 5;
}

// Returns minutes since midnight ET for given Date (default now).
function etMinutesOfDay(d?: Date): number {
  const p = getEtParts(d);
  return p.hour * 60 + p.minute;
}

function etDateKey(d?: Date): string {
  const p = getEtParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// ============ SESSION ============

function getSessionInfo(): { session: string; isHighVolume: boolean; description: string } {
  const h = new Date().getUTCHours();
  if (h >= 0 && h < 8) return { session: "asia", isHighVolume: false, description: "Asian Session" };
  if (h >= 8 && h < 13) return { session: "london", isHighVolume: true, description: "London Session" };
  if (h >= 13 && h < 16) return { session: "overlap", isHighVolume: true, description: "London/NY Overlap" };
  if (h >= 16 && h < 20) return { session: "ny", isHighVolume: true, description: "NY Session" };
  return { session: "afterhours", isHighVolume: false, description: "After Hours" };
}

// ============ TRADING ENGINE ============

// Persisted session state shape (stored in storage.config as JSON)
interface SessionState {
  date: string;                  // ET date key (YYYY-MM-DD)
  newsDone: boolean;
  decisionDone: boolean;
  entryDone: boolean;            // one of: filled, cutoff_taken
  entryClosed: boolean;          // session trade has closed (TP or SL)
  sessionResult: "tp" | "sl" | "" ; // what the last session trade ended as
  news?: SessionNews | null;
  decision?: SessionDecision | null;
  entryOrderPlacedAt?: number;   // ms timestamp of limit placement (for 1-min timeout)
  entryOrderCoin?: string;
  notes?: string;
  // v17.2/17.3 retry loop
  firstDecisionAttempted?: boolean;      // v17.3-fix: true once the 08:45 first decision has run (prevents every-tick re-fire)
  retryCount: number;                    // 0..SESSION_MAX_RETRIES — increments on each failed qualification
  lastRetryMinute?: number;              // ET minute-of-day of last retry fire (prevents duplicate fires in same 15-min window)
  retriesExhausted?: boolean;            // true when retry loop gave up (all retries failed)
  retryHistory?: Array<{ at: string; minute: number; confidence: number; direction: string }>;
}

function emptySessionState(dateKey: string): SessionState {
  return {
    date: dateKey,
    newsDone: false,
    decisionDone: false,
    entryDone: false,
    entryClosed: false,
    sessionResult: "",
    news: null,
    decision: null,
    firstDecisionAttempted: false,
    retryCount: 0,
    retriesExhausted: false,
    retryHistory: [],
  };
}

class TradingEngine {
  private scanTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private isSessionRunning = false;
  private lastKnownEquity = 0;
  private startingEquity = 0;
  private dayStartEquity = 0;
  private dayStartDate = "";
  private dailyTradeCount = 0;
  private dailyTradeDate = "";
  private scanCount = 0;
  private sessionTickCount = 0;
  private lastLearningReview = 0;
  private pnlResetTimestamp = "";
  private pnlResetEquity = 0;

  // Robust position sync — track consecutive "no position" readings per tradeId
  private syncMissCount: Map<number, number> = new Map();

  // BE tracking — track whether BE+ has been applied per tradeId
  private beApplied: Set<number> = new Set();

  // v17.1 session state (in-memory cache; persisted to storage.config.sessionState)
  private sessionState: SessionState = emptySessionState("");

  // v17.6 TLBR state (in-memory cache; persisted to storage.config.tlbrState)
  private tlbrState: TlbrState = emptyTlbrState();

  private resetLossTrackers() {
    this.dailyTradeCount = 0;
    this.dailyTradeDate = new Date().toISOString().split("T")[0];
  }

  private async loadSessionState() {
    try {
      const cfg = await storage.getConfig();
      const raw = (cfg as any)?.sessionState;
      if (raw && typeof raw === "string") {
        const parsed = JSON.parse(raw);
        if (parsed?.date) this.sessionState = parsed;
      }
    } catch (e) { log(`[SESSION] loadState error: ${e}`, "engine"); }
  }

  private async saveSessionState() {
    try {
      await storage.updateConfig({ sessionState: JSON.stringify(this.sessionState) } as any);
    } catch (e) { log(`[SESSION] saveState error: ${e}`, "engine"); }
  }

  // ============ v17.6 TLBR STATE PERSISTENCE ============
  private async loadTlbrState() {
    try {
      const cfg = await storage.getConfig();
      const raw = (cfg as any)?.tlbrState;
      if (raw && typeof raw === "string") {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.disabled === "boolean") {
          this.tlbrState = {
            disabled: !!parsed.disabled,
            cumulativePnlUsd: Number(parsed.cumulativePnlUsd) || 0,
            lastOpusCallAt: Number(parsed.lastOpusCallAt) || 0,
            pendingSetup: parsed.pendingSetup || null,
            consumedTrendlineIds: Array.isArray(parsed.consumedTrendlineIds) ? parsed.consumedTrendlineIds : [],
            openTradeId: typeof parsed.openTradeId === "number" ? parsed.openTradeId : null,
          };
          log(`[TLBR] State restored: disabled=${this.tlbrState.disabled} cumPnl=$${this.tlbrState.cumulativePnlUsd.toFixed(2)} pending=${this.tlbrState.pendingSetup ? "yes" : "no"}`, "engine");
        }
      }
    } catch (e) { log(`[TLBR] loadState error: ${e}`, "engine"); }
  }

  private async saveTlbrState() {
    try {
      await storage.updateConfig({ tlbrState: JSON.stringify(this.tlbrState) } as any);
    } catch (e) { log(`[TLBR] saveState error: ${e}`, "engine"); }
  }

  async start() {
    const config = await storage.getConfig();
    if (!config) return;
    this.resetLossTrackers();
    await this.loadSessionState();
    await this.loadTlbrState();

    if (config.walletAddress) {
      const state = await fetchUserState(config.walletAddress);
      if (state?.marginSummary?.accountValue) {
        this.lastKnownEquity = parseFloat(state.marginSummary.accountValue);
        this.startingEquity = this.lastKnownEquity;
        this.dayStartEquity = this.lastKnownEquity;
        this.dayStartDate = new Date().toISOString().split("T")[0];
      }
    }

    // v15.1: Force fresh P&L baseline on v15 deploy
    const V15_DEPLOY = "2026-04-20T12:00:00.000Z";
    if (!config.pnlBaselineTimestamp || config.pnlBaselineTimestamp < V15_DEPLOY) {
      this.pnlResetTimestamp = new Date().toISOString();
      this.pnlResetEquity = this.lastKnownEquity;
      this.startingEquity = this.lastKnownEquity;
      await storage.updateConfig({
        pnlBaselineEquity: this.lastKnownEquity,
        pnlBaselineTimestamp: this.pnlResetTimestamp,
      });
      log(`[v15.1] Fresh start — P&L baseline reset to $${this.lastKnownEquity.toFixed(2)}`, "engine");
    } else {
      this.pnlResetTimestamp = config.pnlBaselineTimestamp;
      this.pnlResetEquity = config.pnlBaselineEquity;
      this.startingEquity = config.pnlBaselineEquity;
      log(`[BASELINE] Restored P&L baseline: $${config.pnlBaselineEquity.toFixed(2)} from ${config.pnlBaselineTimestamp}`, "engine");
    }

    const lastReviewTime = await storage.getLastReviewTime();
    if (lastReviewTime) this.lastLearningReview = new Date(lastReviewTime).getTime();

    await storage.deleteScansNotIn(ALL_TRADEABLE_COINS);

    // SAFETY: Orphan position detector — close HL positions not tracked in DB
    if (config.apiSecret && config.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const hlPositions = await executor.getPositions();
        const openTrades = await storage.getOpenTrades();
        const dbCoins = new Set(openTrades.map((t: any) => t.coin));
        for (const p of hlPositions) {
          const pos = p.position;
          const sz = Math.abs(parseFloat(pos?.szi || "0"));
          if (sz === 0) continue;
          if (dbCoins.has(pos.coin)) continue;
          log(`[ORPHAN] Found orphan position: ${pos.coin} size=${pos.szi} entry=${pos.entryPx} — closing`, "engine");
          try {
            const openOrders = await executor.getOpenOrders();
            for (const order of openOrders.filter((o: any) => o.coin === pos.coin)) {
              await executor.cancelOrder(order.coin, order.oid);
              log(`[ORPHAN] Cancelled order ${order.coin} oid=${order.oid}`, "engine");
            }
            const isBuy = parseFloat(pos.szi) < 0;
            const midPx = parseFloat(pos.entryPx);
            const closePx = isBuy ? midPx * 1.05 : midPx * 0.95;
            const ac = ALLOWED_ASSETS.find(a => a.coin === pos.coin);
            const szd = ac?.szDecimals ?? 2;
            await executor.placeOrder({
              coin: pos.coin, isBuy, sz,
              limitPx: parseFloat(formatHLPrice(closePx, szd)),
              orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
            });
            log(`[ORPHAN] Closed orphan ${pos.coin} size=${pos.szi}`, "engine");
          } catch (closeErr) {
            log(`[ORPHAN] Failed to close ${pos.coin}: ${closeErr}`, "engine");
          }
        }
      } catch (orphanErr) {
        log(`[ORPHAN] Detector error: ${orphanErr}`, "engine");
      }
    }

    await storage.createLog({
      type: "system",
      message: `Engine v17.6 started | SESSION (BTC NY 08:30–15:30 ET, 80% AUM, 20x, TP1/TP2 split, BE+, technicals-first) + TLBR (BTC trendline breakout/retest, $${TLBR_MARGIN_USD} margin × ${TLBR_LEVERAGE}x, TP+${(TLBR_TP_PCT*100).toFixed(2)}%/SL-${(TLBR_SL_PCT*100).toFixed(2)}%, Opus every ${TLBR_OPUS_INTERVAL_MIN}min weekdays, kill $${TLBR_KILL_SWITCH_USD}) | AUM: $${this.lastKnownEquity.toLocaleString()}`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v17.6 started | SESSION (NY 08:30–15:30 ET retry-loop) + TLBR (Opus ${TLBR_OPUS_INTERVAL_MIN}min weekdays, $${TLBR_MARGIN_USD}×${TLBR_LEVERAGE}x, TP+${(TLBR_TP_PCT*100).toFixed(2)}%/SL-${(TLBR_SL_PCT*100).toFixed(2)}%, kill $${TLBR_KILL_SWITCH_USD}) | AUM: $${this.lastKnownEquity.toFixed(2)}`, "engine");
    this.scheduleNextScan();
    this.scheduleNextSessionTick();
  }

  async stop() {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    if (this.sessionTimer) { clearTimeout(this.sessionTimer); this.sessionTimer = null; }
    await storage.createLog({ type: "system", message: "Trading engine stopped", timestamp: new Date().toISOString() });
  }

  private checkNewDay() {
    const today = new Date().toISOString().split("T")[0];
    if (this.dayStartDate !== today) {
      this.dayStartEquity = this.lastKnownEquity;
      this.dayStartDate = today;
      this.dailyTradeCount = 0;
      this.dailyTradeDate = today;
      log(`New trading day ${today} — AUM baseline: $${this.dayStartEquity.toFixed(2)}`, "engine");
    }
    if (this.dailyTradeDate !== today) {
      this.dailyTradeCount = 0;
      this.dailyTradeDate = today;
    }
  }

  private async scheduleNextScan() {
    const config = await storage.getConfig();
    if (!config?.isRunning) return;
    this.scanTimer = setTimeout(() => this.runScanCycle(), (config.scanIntervalSecs || 5) * 1000);
  }

  private async scheduleNextSessionTick() {
    const config = await storage.getConfig();
    if (!config?.isRunning) return;
    // Session tick runs every 30s — fast enough to catch 08:30, 08:45, 09:30 transitions
    this.sessionTimer = setTimeout(() => this.runSessionTick(), 30 * 1000);
  }

  private async refreshEquity(): Promise<number> {
    const config = await storage.getConfig();
    if (!config?.walletAddress) return this.lastKnownEquity;
    try {
      const state = await fetchUserState(config.walletAddress);
      if (state?.marginSummary?.accountValue) {
        const val = parseFloat(state.marginSummary.accountValue);
        if (val > 0) {
          this.lastKnownEquity = val;
          if (this.startingEquity === 0) this.startingEquity = val;
          if (this.dayStartEquity === 0) this.dayStartEquity = val;
        }
      }
    } catch { /* use last known */ }
    return this.lastKnownEquity;
  }

  // ============ ENTRY HELPER ============

  private async executeEntry(params: {
    asset: AssetConfig;
    strategy: StrategyType;
    side: "long" | "short";
    equityPct: number;
    leverage: number;
    tpPct: number;          // legacy/single-TP strategies (PURE_RSI, HSTAR) — used when tp1Pct not provided
    slPct: number;
    tp1Pct?: number;        // v17.5: if provided, split TP into TP1+TP2 (session engine)
    tp2Pct?: number;        // v17.5
    tp1SizePct?: number;    // v17.5: fraction of position closed at TP1 (default 0.5)
    price: number;
    equity: number;
    entryReason: string;
    config: any;
    useLimit?: boolean;              // if true, place LIMIT at params.price (for LLM entry zone)
    limitExpiresAtMs?: number;       // optional: drop to market if unfilled after this timestamp
  }): Promise<boolean> {
    const { asset, strategy, side, equityPct, leverage, tpPct, slPct, price, equity, entryReason, config, useLimit } = params;
    const hasDualTp = typeof params.tp1Pct === "number" && typeof params.tp2Pct === "number";
    const tp1Pct = hasDualTp ? params.tp1Pct! : tpPct;
    const tp2Pct = hasDualTp ? params.tp2Pct! : tpPct;
    const tp1SizePct = typeof params.tp1SizePct === "number" ? params.tp1SizePct : 0.5;
    const stratLabel = strategy === "btc_session" ? "SESSION" : strategy.toUpperCase();
    const isBuy = side === "long";

    const capitalForTrade = equity * equityPct;
    const notionalSize = capitalForTrade * leverage;
    const assetSize = notionalSize / price;

    if (capitalForTrade < 5) {
      log(`[${stratLabel}] SKIP ${asset.coin}: capital too low ($${capitalForTrade.toFixed(2)})`, "engine");
      return false;
    }

    const tp = isBuy ? price * (1 + tp1Pct) : price * (1 - tp1Pct);
    const sl = isBuy ? price * (1 - slPct) : price * (1 + slPct);
    const tpPctLabel = hasDualTp
      ? `TP1 +${(tp1Pct * 100).toFixed(2)}% (50%) → TP2 +${(tp2Pct * 100).toFixed(2)}% (50%)`
      : `+${(tpPct * 100).toFixed(2)}%`;
    const slPctLabel = `SL -${(slPct * 100).toFixed(1)}%`;

    log(`[${stratLabel}] ${asset.coin} ${side.toUpperCase()} ${useLimit ? "LIMIT" : "MKT"} @ $${price} | ${tpPctLabel} | ${slPctLabel} | ${leverage}x | ${entryReason}`, "engine");

    let fillPrice = price;
    let filledSz = 0;

    if (config.apiSecret && config.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const isCross = !asset.isolatedOnly;
        await executor.setLeverage(asset.coin, leverage, isCross);
        // For market: 1% slippage IOC; for limit: exact price GTC
        const tifConfig = useLimit
          ? { limit: { tif: "Gtc" as const } }
          : { limit: { tif: "Ioc" as const } };
        const orderPrice = useLimit
          ? price
          : (isBuy ? price * 1.01 : price * 0.99);
        const roundedSize = parseFloat(formatHLSize(assetSize, asset.szDecimals));
        if (roundedSize <= 0) {
          log(`[${stratLabel}] SKIP ${asset.coin}: rounded size is 0`, "engine");
          return false;
        }

        const orderResult = await executor.placeOrder({
          coin: asset.coin, isBuy, sz: roundedSize,
          limitPx: parseFloat(formatHLPrice(orderPrice, asset.szDecimals)),
          orderType: tifConfig, reduceOnly: false,
        });

        log(`[HL RAW] ${asset.coin} ${strategy} response: ${JSON.stringify(orderResult).slice(0, 500)}`, "engine");
        const status = orderResult?.response?.data?.statuses?.[0];
        const fillPx = status?.filled?.avgPx;
        const totalSz = status?.filled?.totalSz;
        const restingOid = status?.resting?.oid;
        const errorMsg = status?.error || orderResult?.response?.data?.error || (orderResult?.status !== "ok" ? JSON.stringify(orderResult) : undefined);

        if (errorMsg) {
          log(`[${stratLabel}] ORDER REJECTED: ${asset.coin} — ${errorMsg}`, "engine");
          await storage.createLog({ type: "order_error", message: `${stratLabel} REJECTED: ${asset.coin} ${side.toUpperCase()} — ${errorMsg}`, timestamp: new Date().toISOString() });
          return false;
        }
        if (fillPx && parseFloat(totalSz) > 0) {
          fillPrice = parseFloat(fillPx);
          filledSz = parseFloat(totalSz);
          log(`[${stratLabel}] FILLED: ${asset.coin} ${side.toUpperCase()} sz=${totalSz} @ $${fillPx}`, "engine");
        } else if (useLimit && restingOid) {
          // Limit resting — record and return false so caller can poll
          log(`[${stratLabel}] LIMIT RESTING: ${asset.coin} ${side.toUpperCase()} @ $${price} oid=${restingOid}`, "engine");
          this.sessionState.entryOrderPlacedAt = Date.now();
          this.sessionState.entryOrderCoin = asset.coin;
          await this.saveSessionState();
          await storage.createLog({ type: "order_resting", message: `${stratLabel} LIMIT resting: ${asset.coin} ${side.toUpperCase()} @ $${price} oid=${restingOid}`, timestamp: new Date().toISOString() });
          return false;
        } else {
          log(`[${stratLabel}] IOC NOT FILLED: ${asset.coin} ${side.toUpperCase()}`, "engine");
          await storage.createLog({ type: "order_unfilled", message: `${stratLabel} NOT FILLED: ${asset.coin} ${side.toUpperCase()}`, timestamp: new Date().toISOString() });
          return false;
        }
      } catch (execErr) {
        log(`[${stratLabel}] ORDER FAILED: ${asset.coin} — ${execErr}`, "engine");
        await storage.createLog({ type: "order_error", message: `${stratLabel} FAILED: ${asset.coin} ${side.toUpperCase()} — ${execErr}`, timestamp: new Date().toISOString() });
        return false;
      }
    } else {
      filledSz = parseFloat(formatHLSize(assetSize, asset.szDecimals));
      if (filledSz <= 0) return false;
    }

    if (filledSz <= 0) return false;

    const actualTP1 = isBuy ? fillPrice * (1 + tp1Pct) : fillPrice * (1 - tp1Pct);
    const actualTP2 = isBuy ? fillPrice * (1 + tp2Pct) : fillPrice * (1 - tp2Pct);
    const actualSL  = isBuy ? fillPrice * (1 - slPct)  : fillPrice * (1 + slPct);
    const actualNotional = filledSz * fillPrice;

    // v17.5: split filled size into TP1 + TP2 halves (rounded to szDecimals)
    const tp1Sz = hasDualTp ? parseFloat(formatHLSize(filledSz * tp1SizePct, asset.szDecimals)) : filledSz;
    const tp2Sz = hasDualTp ? parseFloat(formatHLSize(filledSz - tp1Sz, asset.szDecimals)) : filledSz;

    const trade = await storage.createTrade({
      coin: asset.coin, side, entryPrice: fillPrice, size: Math.round(equityPct * 100), leverage,
      entryEquity: equity,
      notionalValue: actualNotional,
      rsiAtEntry: 0, rsi4h: 0, rsi1d: 0,
      ema10: 0, ema21: 0, ema50: 0,
      stopLoss: actualSL,
      takeProfit1: actualTP1,
      takeProfit2: hasDualTp ? actualTP2 : actualTP1,
      tp1Hit: false,
      confluenceScore: 0,
      confluenceDetails: `${stratLabel}: ${entryReason}`,
      riskRewardRatio: hasDualTp ? (tp2Pct / slPct) : 1.0,
      status: "open",
      reason: `[${stratLabel}] ${asset.coin} ${side.toUpperCase()} | ${entryReason} | ${slPctLabel} | ${tpPctLabel} | ${leverage}x`,
      setupType: strategy,
      strategy,
      openedAt: new Date().toISOString(),
    });

    // Place SL + TP orders on HL immediately after fill
    if (config.apiSecret && config.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const slTriggerPx = parseFloat(formatHLPrice(actualSL, asset.szDecimals));
        const slFillPx = parseFloat(formatHLPrice(isBuy ? actualSL * 0.98 : actualSL * 1.02, asset.szDecimals));
        await executor.placeOrder({
          coin: asset.coin, isBuy: !isBuy, sz: filledSz,
          limitPx: slFillPx,
          orderType: { trigger: { triggerPx: String(slTriggerPx), isMarket: true, tpsl: "sl" } },
          reduceOnly: true,
        });
        log(`[SL ORDER] ${asset.coin} SL placed @ $${slTriggerPx} (${slPctLabel}) sz=${filledSz}`, "engine");

        if (hasDualTp) {
          // v17.5: TP1 at +0.5% (50% size)  +  TP2 at +1.0% (50% size)
          const tp1LimitPx = parseFloat(formatHLPrice(actualTP1, asset.szDecimals));
          if (tp1Sz > 0) {
            await executor.placeOrder({
              coin: asset.coin, isBuy: !isBuy, sz: tp1Sz,
              limitPx: tp1LimitPx,
              orderType: { limit: { tif: "Gtc" } },
              reduceOnly: true,
            });
            log(`[TP1 ORDER] ${asset.coin} TP1 placed @ $${tp1LimitPx} (+${(tp1Pct*100).toFixed(2)}%) sz=${tp1Sz}`, "engine");
          }
          const tp2LimitPx = parseFloat(formatHLPrice(actualTP2, asset.szDecimals));
          if (tp2Sz > 0) {
            await executor.placeOrder({
              coin: asset.coin, isBuy: !isBuy, sz: tp2Sz,
              limitPx: tp2LimitPx,
              orderType: { limit: { tif: "Gtc" } },
              reduceOnly: true,
            });
            log(`[TP2 ORDER] ${asset.coin} TP2 placed @ $${tp2LimitPx} (+${(tp2Pct*100).toFixed(2)}%) sz=${tp2Sz}`, "engine");
          }
        } else {
          const tpLimitPx = parseFloat(formatHLPrice(actualTP1, asset.szDecimals));
          await executor.placeOrder({
            coin: asset.coin, isBuy: !isBuy, sz: filledSz,
            limitPx: tpLimitPx,
            orderType: { limit: { tif: "Gtc" } },
            reduceOnly: true,
          });
          log(`[TP ORDER] ${asset.coin} TP placed @ $${tpLimitPx} (+${(tp1Pct*100).toFixed(2)}%)`, "engine");
        }
      } catch (orderErr) {
        log(`[SL/TP ORDER] FAILED ${asset.coin}: ${orderErr} — will monitor in checkExits`, "engine");
      }
    }

    await logDecision({
      tradeId: trade.id, coin: asset.coin, action: "entry", side, price: fillPrice,
      reasoning: `${stratLabel}: ${asset.coin} ${side.toUpperCase()} | ${entryReason} | SL $${actualSL.toFixed(2)} (${slPctLabel}) | TP $${actualTP1.toFixed(2)}${hasDualTp ? ` / $${actualTP2.toFixed(2)}` : ""} (${tpPctLabel}) | ${leverage}x | $${capitalForTrade.toFixed(0)} capital`,
      equity, leverage, positionSizeUsd: capitalForTrade, strategy,
    });

    await storage.createLog({
      type: "trade_open",
      message: `[${stratLabel}] ${asset.coin} ${side.toUpperCase()} @ $${displayPrice(fillPrice, asset.szDecimals)} | ${leverage}x | ${entryReason} | ${slPctLabel} | TP ${tpPctLabel} | $${capitalForTrade.toFixed(0)}`,
      data: JSON.stringify(trade),
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  // ============ MAIN SCAN CYCLE (monitoring only — no entries) ============

  async runScanCycle() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.scanCount++;

    try {
      const config = await storage.getConfig();
      if (!config?.isRunning) { this.isScanning = false; return; }
      this.checkNewDay();
      const equity = await this.refreshEquity();
      if (equity <= 0) {
        log(`Skipping scan — could not read real AUM (equity: $${equity})`, "engine");
        this.isScanning = false;
        this.scheduleNextScan();
        return;
      }

      // === PERIODIC QUICK REVIEW (every 10 scans) ===
      if (this.scanCount % 10 === 0) {
        const reviewed = await reviewClosedTrades();
        if (reviewed > 0) {
          await generateInsights();
          const stats = await getLearningStats();
          await storage.createLog({
            type: "learning",
            message: `Quick review: ${stats.reviewedDecisions} decisions, ${stats.activeInsights} insights, ${(stats.overallWinRate * 100).toFixed(0)}% win rate`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // === 24-HOUR DEEP LEARNING REVIEW ===
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      if (Date.now() - this.lastLearningReview > TWENTY_FOUR_HOURS) {
        log("Starting 24-hour deep learning review...", "engine");
        await run24hReview();
        this.lastLearningReview = Date.now();
        await storage.createLog({
          type: "learning_24h",
          message: "24-HOUR DEEP REVIEW completed — analyzed all trades, updated insights, identified mistakes and improvements",
          timestamp: new Date().toISOString(),
        });
      }

      // v17.1: no intra-cycle entries. Session scheduler handles entries on its own timer.
      // This cycle: monitor open trades (TP/SL/BE+) and snapshot P&L.
      await this.checkExits(equity);

      // v17.6 TLBR — every 5s: discovery gate (60min/weekday) + watch for retest fill
      await this.runTlbrTick(equity, config);

      await this.takePnlSnapshot(equity);

    } catch (e) {
      const stack = e instanceof Error ? e.stack : String(e);
      log(`Scan error: ${stack}`, "engine");
      await storage.createLog({ type: "error", message: `Scan error: ${stack}`.slice(0, 500), timestamp: new Date().toISOString() }).catch(() => {});
    }
    this.isScanning = false;
    this.scheduleNextScan();
  }

  // ============ v17.6 TLBR TICK (runs every 5s from main scan cycle) ============
  // Two modes:
  //   DISCOVERY — no pendingSetup, weekday, ≥60min since last call → fetch Opus analysis
  //   WATCH — pendingSetup exists → check if price in retestZone + FVG → execute LONG
  //   EXPIRE — pendingSetup older than 4h, price >1% below retest, or trendline consumed → clear

  private async runTlbrTick(equity: number, config: any) {
    try {
      // Kill switch
      if (this.tlbrState.disabled) return;
      if (this.tlbrState.cumulativePnlUsd <= TLBR_KILL_SWITCH_USD) {
        this.tlbrState.disabled = true;
        await this.saveTlbrState();
        log(`[TLBR] KILL SWITCH TRIPPED — cumulative P&L $${this.tlbrState.cumulativePnlUsd.toFixed(2)} ≤ $${TLBR_KILL_SWITCH_USD} — TLBR DISABLED`, "engine");
        await storage.createLog({ type: "tlbr_disabled", message: `TLBR disabled — kill switch at $${this.tlbrState.cumulativePnlUsd.toFixed(2)}`, timestamp: new Date().toISOString() });
        return;
      }

      // If TLBR already has an open trade — do nothing (max 1 position)
      if (this.tlbrState.openTradeId !== null) {
        const openTrade = (await storage.getOpenTrades()).find(t => t.id === this.tlbrState.openTradeId);
        if (!openTrade) {
          // Trade got closed elsewhere — clear reference (P&L accounted by onTlbrTradeClosed hook)
          this.tlbrState.openTradeId = null;
          await this.saveTlbrState();
        } else {
          return; // active trade, skip everything
        }
      }

      const mids = await fetchAllMids();
      const currentPrice = parseFloat(mids["BTC"] || "0");
      if (!currentPrice || currentPrice <= 0) return;

      // === WATCH MODE: check existing pendingSetup for fill ===
      if (this.tlbrState.pendingSetup) {
        const s = this.tlbrState.pendingSetup;
        const age = Date.now() - s.discoveredAt;

        // Expire 15-min old setup (user rule: cancel if unfilled within 15min)
        if (age > TLBR_SETUP_MAX_AGE_MS) {
          log(`[TLBR] Setup expired (age ${(age / 60000).toFixed(1)}min > 15min) — clearing pendingSetup, returning to discovery`, "engine");
          this.tlbrState.pendingSetup = null;
          await this.saveTlbrState();
          return;
        }

        // Invalidate if price has blown >1% below retest level (trendline broken)
        if (currentPrice < s.retestLevel * (1 - TLBR_INVALIDATE_DISTANCE_PCT)) {
          log(`[TLBR] Trendline invalidated — price $${currentPrice.toFixed(2)} < retest $${s.retestLevel.toFixed(2)} by >1% — consuming & clearing`, "engine");
          this.tlbrState.consumedTrendlineIds.push(tlbrTrendlineId(s.trendline));
          this.tlbrState.pendingSetup = null;
          await this.saveTlbrState();
          return;
        }

        // Entry condition: price inside retestZone + (FVG confluence if provided)
        const inRetestZone = currentPrice >= s.retestZoneLow && currentPrice <= s.retestZoneHigh;
        const inFvg = !s.fvg ? true : (currentPrice >= s.fvg.low && currentPrice <= s.fvg.high);
        if (inRetestZone && inFvg && s.confidence >= 7) {
          // Execute LONG — $100 margin × 20x, TP +0.35%, SL -0.30%
          const equityPctForTlbr = Math.min(1.0, TLBR_MARGIN_USD / Math.max(1, equity));
          const entryReason = `TLBR retest @ $${s.retestLevel.toFixed(2)} | conf ${s.confidence}/10 | ${s.fvg ? "FVG confirmed" : "no FVG"} | ${s.reasoning.slice(0, 120)}`;
          log(`[TLBR] EXECUTING LONG — price $${currentPrice.toFixed(2)} in zone [$${s.retestZoneLow.toFixed(2)}-$${s.retestZoneHigh.toFixed(2)}] — ${entryReason}`, "engine");

          // Mark trendline consumed BEFORE execute to prevent race on failed-entry retry
          this.tlbrState.consumedTrendlineIds.push(tlbrTrendlineId(s.trendline));

          const entered = await this.executeEntry({
            asset: BTC_ASSET,
            strategy: "tlbr",
            side: "long",
            equityPct: equityPctForTlbr,
            leverage: TLBR_LEVERAGE,
            tpPct: TLBR_TP_PCT,
            slPct: TLBR_SL_PCT,
            price: currentPrice,
            equity,
            entryReason,
            config,
          });

          if (entered) {
            // Find the trade just created
            const openTrades = await storage.getOpenTrades();
            const tlbrOpen = openTrades.find(t => t.strategy === "tlbr");
            if (tlbrOpen) {
              this.tlbrState.openTradeId = tlbrOpen.id;
            }
          }
          // Regardless of entered=true/false, clear pendingSetup (one shot per setup rule)
          this.tlbrState.pendingSetup = null;
          await this.saveTlbrState();
        }
        return;
      }

      // === DISCOVERY MODE: no pendingSetup, check 60-min gate ===
      if (!isWeekdayET()) return;  // weekdays only
      const now = Date.now();
      const sinceLast = now - this.tlbrState.lastOpusCallAt;
      const intervalMs = TLBR_OPUS_INTERVAL_MIN * 60 * 1000;
      if (sinceLast < intervalMs) return;

      const pplxKey = config.perplexityApiKey;
      if (!pplxKey) {
        this.tlbrState.lastOpusCallAt = now; // avoid hammering logs
        return;
      }

      log(`[TLBR] Discovery scan starting — ${(sinceLast / 60000).toFixed(0)}min since last call`, "engine");
      this.tlbrState.lastOpusCallAt = now;
      await this.saveTlbrState();

      const candles5m = await fetchCandlesOHLCV("BTC", "5m", 96);
      if (candles5m.length < 50) {
        log(`[TLBR] Only ${candles5m.length} candles available — skipping`, "engine");
        return;
      }

      const analysis = await fetchTlbrAnalysis(pplxKey, candles5m, currentPrice);
      if (!analysis.setup) return;
      if (analysis.confidence < 7) {
        log(`[TLBR] Setup rejected: conf ${analysis.confidence}/10 < 7`, "engine");
        return;
      }

      // Skip if this trendline was already consumed
      const tlId = tlbrTrendlineId(analysis.setup.trendline);
      if (this.tlbrState.consumedTrendlineIds.includes(tlId)) {
        log(`[TLBR] Trendline ${tlId} already consumed — skipping`, "engine");
        return;
      }

      this.tlbrState.pendingSetup = analysis.setup;
      await this.saveTlbrState();
      await storage.createLog({
        type: "tlbr_setup",
        message: `TLBR setup: retest $${analysis.setup.retestLevel.toFixed(2)} zone [$${analysis.setup.retestZoneLow.toFixed(2)}-$${analysis.setup.retestZoneHigh.toFixed(2)}] conf ${analysis.confidence}/10 | ${analysis.reasoning.slice(0, 200)}`,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      log(`[TLBR] runTlbrTick error: ${e}`, "engine");
    }
  }

  // Called from checkExits close paths when a TLBR trade closes. Updates cumulative P&L.
  private async onTlbrTradeClosed(tradeId: number, pnlUsd: number) {
    try {
      this.tlbrState.cumulativePnlUsd += pnlUsd;
      if (this.tlbrState.openTradeId === tradeId) this.tlbrState.openTradeId = null;
      log(`[TLBR] Trade #${tradeId} closed | P&L $${pnlUsd.toFixed(2)} | cumulative $${this.tlbrState.cumulativePnlUsd.toFixed(2)} / kill $${TLBR_KILL_SWITCH_USD}`, "engine");
      if (this.tlbrState.cumulativePnlUsd <= TLBR_KILL_SWITCH_USD && !this.tlbrState.disabled) {
        this.tlbrState.disabled = true;
        log(`[TLBR] KILL SWITCH TRIPPED on close — disabled`, "engine");
        await storage.createLog({ type: "tlbr_disabled", message: `TLBR kill switch tripped at $${this.tlbrState.cumulativePnlUsd.toFixed(2)}`, timestamp: new Date().toISOString() });
      }
      await this.saveTlbrState();
    } catch (e) {
      log(`[TLBR] onTlbrTradeClosed error: ${e}`, "engine");
    }
  }

  // ============ SESSION TICK (every 30s) — handles v17.1 NY Open pipeline ============

  private async runSessionTick() {
    if (this.isSessionRunning) return;
    this.isSessionRunning = true;
    this.sessionTickCount++;
    try {
      const config = await storage.getConfig();
      if (!config?.isRunning) { this.isSessionRunning = false; return; }

      const dateKey = etDateKey();

      // Reset state at the start of each new ET day
      if (this.sessionState.date !== dateKey) {
        this.sessionState = emptySessionState(dateKey);
        await this.saveSessionState();
        log(`[SESSION] New ET day ${dateKey} — session state reset`, "engine");
      }

      // Only Mon–Fri
      if (!isWeekdayET()) { this.isSessionRunning = false; this.scheduleNextSessionTick(); return; }

      const minutes = etMinutesOfDay();
      const newsMin = SESSION_NEWS_ET.hour * 60 + SESSION_NEWS_ET.minute;
      const decisionMin = SESSION_DECISION_ET.hour * 60 + SESSION_DECISION_ET.minute;
      const openMin = SESSION_OPEN_ET.hour * 60 + SESSION_OPEN_ET.minute;
      const cutoffMin = SESSION_CUTOFF_ET.hour * 60 + SESSION_CUTOFF_ET.minute;
      const retryStartMin = SESSION_RETRY_START_ET.hour * 60 + SESSION_RETRY_START_ET.minute;

      // Window guard: only operate within 08:30–10:45 ET (+5 min buffer); outside this we do nothing
      if (minutes < newsMin - 5 || minutes > cutoffMin + 5) {
        this.isSessionRunning = false;
        this.scheduleNextSessionTick();
        return;
      }

      // 1) 08:30 ET — fetch news (first pass)
      if (!this.sessionState.newsDone && minutes >= newsMin) {
        const pplxKey = process.env.PERPLEXITY_API_KEY || "";
        if (!pplxKey) {
          log(`[SESSION] No PERPLEXITY_API_KEY — cannot run NY Open session pipeline`, "engine");
        } else {
          log(`[SESSION] ${dateKey} 08:30 ET — fetching overnight news via Sonar`, "engine");
          const news = await fetchBtcNews(pplxKey);
          this.sessionState.news = news;
          this.sessionState.newsDone = true;
          await this.saveSessionState();
          await storage.createLog({
            type: "system",
            message: `[SESSION] NEWS: ${news.sentimentHint.toUpperCase()} | ${news.summary.slice(0, 200)}`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // 2) 08:45 ET — Opus 4.7 first decision (ONE-SHOT — fires once per session)
      if (this.sessionState.newsDone && !this.sessionState.firstDecisionAttempted && !this.sessionState.decisionDone && !this.sessionState.retriesExhausted && minutes >= decisionMin) {
        const pplxKey = process.env.PERPLEXITY_API_KEY || "";
        if (pplxKey && this.sessionState.news) {
          log(`[SESSION] ${dateKey} 08:45 ET — Opus 4.7 first decision (attempt 1/${SESSION_MAX_RETRIES + 1})`, "engine");
          // Mark attempted BEFORE the pass runs so a crash/timeout doesn't cause re-entry on next tick
          this.sessionState.firstDecisionAttempted = true;
          await this.saveSessionState();
          const ok = await this.runQualificationPass(pplxKey, minutes, /*attemptLabel=*/"first");
          if (!ok) {
            // v17.4-fix (ISSUE-002): seed lastRetryMinute to the CURRENT slot so retry #1
            // has to wait a full 15-min interval before firing. Without this, if the first
            // decision runs past 09:00, retry #1 fires on the very next tick (observed:
            // 16 seconds gap) because slot 0's guard is open.
            const currentSlotIdx = Math.max(0, Math.floor((minutes - retryStartMin) / SESSION_RETRY_INTERVAL_MIN));
            const currentSlotMin = retryStartMin + currentSlotIdx * SESSION_RETRY_INTERVAL_MIN;
            if (minutes >= retryStartMin) {
              this.sessionState.lastRetryMinute = currentSlotMin;
              await this.saveSessionState();
            }
            log(`[SESSION] First pass failed qualification — entering retry loop (up to ${SESSION_MAX_RETRIES} retries every ${SESSION_RETRY_INTERVAL_MIN} min); next retry at ET minute ${currentSlotMin + SESSION_RETRY_INTERVAL_MIN}`, "engine");
          }
        }
      }

      // 2b) Retry loop — every 15 min from 09:00 through cutoff while decision not yet qualified
      if (this.sessionState.newsDone && this.sessionState.firstDecisionAttempted && !this.sessionState.decisionDone && !this.sessionState.retriesExhausted && minutes >= retryStartMin && minutes <= cutoffMin) {
        // Compute which retry slot we're in (0-indexed from 09:00). Clamp to >=0 for safety.
        const slotIdx = Math.max(0, Math.floor((minutes - retryStartMin) / SESSION_RETRY_INTERVAL_MIN));
        const slotMinute = retryStartMin + slotIdx * SESSION_RETRY_INTERVAL_MIN;
        // Fire only if we're IN the slot (minutes >= slotMinute), haven't already fired this slot, and not exhausted
        if (
          this.sessionState.retryCount < SESSION_MAX_RETRIES &&
          (this.sessionState.lastRetryMinute === undefined || this.sessionState.lastRetryMinute < slotMinute) &&
          minutes >= slotMinute
        ) {
          const pplxKey = process.env.PERPLEXITY_API_KEY || "";
          if (pplxKey) {
            const attemptNum = this.sessionState.retryCount + 1; // 1-indexed in log
            log(`[SESSION] ${dateKey} retry ${attemptNum}/${SESSION_MAX_RETRIES} at ET minute ${slotMinute} — fresh news + decision`, "engine");
            // Fresh Sonar news for this retry (overwrite prior)
            try {
              const news = await fetchBtcNews(pplxKey);
              this.sessionState.news = news;
              await storage.createLog({
                type: "system",
                message: `[SESSION] RETRY ${attemptNum} NEWS: ${news.sentimentHint.toUpperCase()} | ${news.summary.slice(0, 180)}`,
                timestamp: new Date().toISOString(),
              });
            } catch (e) {
              log(`[SESSION] Retry news fetch error: ${e}`, "engine");
            }
            this.sessionState.lastRetryMinute = slotMinute;
            await this.runQualificationPass(pplxKey, minutes, `retry ${attemptNum}`);
            // If all retries exhausted and still not qualified — give up
            if (!this.sessionState.decisionDone && this.sessionState.retryCount >= SESSION_MAX_RETRIES) {
              log(`[SESSION] ${dateKey} — ${SESSION_MAX_RETRIES} retries exhausted, no qualifying setup`, "engine");
              this.sessionState.retriesExhausted = true;
              this.sessionState.entryDone = true;
              this.sessionState.notes = `${SESSION_MAX_RETRIES} retries exhausted — no qualifying setup`;
              await this.saveSessionState();
              await storage.createLog({
                type: "system",
                message: `[SESSION] NO TRADE — ${SESSION_MAX_RETRIES} retries exhausted, qualification gate never passed`,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      }

      // 3) Entry — 09:30+ at NY open, or immediately (market) if retry qualified after 09:30
      if (this.sessionState.decisionDone && !this.sessionState.entryDone && minutes >= openMin && minutes <= cutoffMin) {
        // v17.2 Plan A: if qualification passed on a retry at or after 09:30, enter at MARKET immediately
        const qualifiedOnRetry = this.sessionState.retryCount > 0;
        const forceMarketNow = qualifiedOnRetry || minutes >= cutoffMin;
        await this.tryEnterSession(config, forceMarketNow);
      }

      // 3b) Poll limit order timeout — if a limit has been resting >1 min and not filled, upgrade to market
      if (this.sessionState.decisionDone && !this.sessionState.entryDone && this.sessionState.entryOrderPlacedAt) {
        const elapsed = Date.now() - this.sessionState.entryOrderPlacedAt;
        if (elapsed >= SESSION_ENTRY_LIMIT_MS) {
          log(`[SESSION] Limit timeout ${(elapsed/1000).toFixed(0)}s — upgrading to MARKET`, "engine");
          await this.cancelRestingSessionOrders(config);
          // Fall through on next tick to re-enter as market. Clear placedAt so tryEnterSession fires fresh.
          this.sessionState.entryOrderPlacedAt = undefined;
          this.sessionState.entryOrderCoin = undefined;
          await this.saveSessionState();
          await this.tryEnterSession(config, true);
        }
      }

      // 4) 15:30 ET — hard cutoff. If still no entry and decision was valid, take market. Otherwise end session.
      if (this.sessionState.decisionDone && !this.sessionState.entryDone && minutes >= cutoffMin) {
        log(`[SESSION] ${dateKey} 15:30 ET cutoff — forcing market entry if decision valid`, "engine");
        await this.cancelRestingSessionOrders(config);
        await this.tryEnterSession(config, true);
        // Mark session done regardless — no more entries this day
        if (!this.sessionState.entryDone) {
          this.sessionState.entryDone = true;
          this.sessionState.notes = "cutoff — no valid opportunity";
          await this.saveSessionState();
        }
      }

    } catch (e) {
      const stack = e instanceof Error ? e.stack : String(e);
      log(`[SESSION] Tick error: ${stack}`, "engine");
      await storage.createLog({ type: "error", message: `[SESSION] Tick error: ${stack}`.slice(0, 500), timestamp: new Date().toISOString() }).catch(() => {});
    }
    this.isSessionRunning = false;
    this.scheduleNextSessionTick();
  }

  // v17.2 qualification pass — runs Opus decision, either marks decisionDone (on pass) or increments retryCount (on fail).
  // Returns true if qualification passed.
  private async runQualificationPass(pplxKey: string, minutes: number, attemptLabel: string): Promise<boolean> {
    if (!this.sessionState.news) return false;
    const mids = await fetchAllMids();
    const currentPrice = parseFloat(mids["BTC"] || "0");
    if (currentPrice <= 0) {
      log(`[SESSION] ${attemptLabel}: cannot fetch BTC mid price — skipping this pass`, "engine");
      return false;
    }
    const tech = await computeBtcTechnicals(currentPrice);
    const decision = await fetchBtcDecision(pplxKey, this.sessionState.news, tech, currentPrice);
    this.sessionState.decision = decision;
    const passed = decision.direction !== "skip" && decision.confidence >= SESSION_CONFIDENCE_THRESHOLD;

    await storage.createLog({
      type: "system",
      message: `[SESSION] ${attemptLabel.toUpperCase()} DECISION: ${decision.direction.toUpperCase()} conf=${decision.confidence}/10 entry=${decision.entry ?? "MARKET"} — ${passed ? "PASS" : "FAIL"} | ${decision.reasoning.slice(0, 180)}`,
      timestamp: new Date().toISOString(),
    });

    if (passed) {
      this.sessionState.decisionDone = true;
      log(`[SESSION] ${attemptLabel} PASSED qualification (${decision.direction} conf=${decision.confidence}) → proceeding to entry`, "engine");
    } else {
      this.sessionState.retryCount = (this.sessionState.retryCount || 0) + 1;
      if (!this.sessionState.retryHistory) this.sessionState.retryHistory = [];
      this.sessionState.retryHistory.push({
        at: new Date().toISOString(),
        minute: minutes,
        confidence: decision.confidence,
        direction: decision.direction,
      });
      log(`[SESSION] ${attemptLabel} FAILED qualification (dir=${decision.direction} conf=${decision.confidence}) — retryCount=${this.sessionState.retryCount}/${SESSION_MAX_RETRIES}`, "engine");
    }
    await this.saveSessionState();
    return passed;
  }

  private async cancelRestingSessionOrders(config: any) {
    if (!config?.apiSecret || !config?.walletAddress) return;
    try {
      const executor = createExecutor(config.apiSecret, config.walletAddress);
      const orders = await executor.getOpenOrders();
      // Cancel any non-reduce-only BTC entry orders (i.e. our resting limit)
      for (const o of orders) {
        if (o.coin === "BTC" && o.reduceOnly !== true && o.triggerCondition === undefined) {
          try {
            await executor.cancelOrder(o.coin, o.oid);
            log(`[SESSION] Cancelled resting entry order oid=${o.oid}`, "engine");
          } catch (ce) { log(`[SESSION] Cancel error: ${ce}`, "engine"); }
        }
      }
    } catch (e) { log(`[SESSION] cancelRestingSessionOrders error: ${e}`, "engine"); }
  }

  private async tryEnterSession(config: any, forceMarket: boolean) {
    const dec = this.sessionState.decision;
    if (!dec || dec.direction === "skip" || dec.confidence < SESSION_CONFIDENCE_THRESHOLD) {
      log(`[SESSION] No valid trade — direction=${dec?.direction} conf=${dec?.confidence} (need ≥${SESSION_CONFIDENCE_THRESHOLD})`, "engine");
      this.sessionState.entryDone = true;
      this.sessionState.notes = `skipped: ${dec?.direction} conf=${dec?.confidence}`;
      await this.saveSessionState();
      return;
    }

    // Block re-entry if previous session trade closed with SL
    if (this.sessionState.entryClosed && this.sessionState.sessionResult === "sl") {
      log(`[SESSION] Re-entry blocked — last trade closed SL`, "engine");
      this.sessionState.entryDone = true;
      this.sessionState.notes = "re-entry blocked: prior SL";
      await this.saveSessionState();
      return;
    }

    // Skip if already have an open BTC session trade
    const openTrades = await storage.getOpenTrades();
    const openBtcSession = openTrades.find(t => t.coin === "BTC" && t.strategy === "btc_session");
    if (openBtcSession) {
      log(`[SESSION] Already have open BTC session trade #${openBtcSession.id} — not re-entering`, "engine");
      return;
    }

    const equity = await this.refreshEquity();
    const mids = await fetchAllMids();
    const currentPrice = parseFloat(mids["BTC"] || "0");
    if (currentPrice <= 0) {
      log(`[SESSION] BTC mid price unavailable — aborting entry`, "engine");
      return;
    }

    // Entry price selection:
    // - If LLM gave an entry zone AND we're not forceMarket AND zone is reachable (within 0.3% of current), use LIMIT
    // - Otherwise MARKET
    let useLimit = false;
    let entryPrice = currentPrice;
    if (!forceMarket && dec.entry && dec.entry > 0) {
      const dist = Math.abs(dec.entry - currentPrice) / currentPrice;
      if (dist <= 0.003) {
        useLimit = true;
        entryPrice = dec.entry;
      } else {
        log(`[SESSION] LLM entry $${dec.entry.toFixed(2)} is ${(dist*100).toFixed(2)}% from current $${currentPrice.toFixed(2)} — too far, using MARKET`, "engine");
      }
    }

    const entryReason = `NY Open conf=${dec.confidence}/10 | ${dec.reasoning.slice(0, 120)}`;

    const entered = await this.executeEntry({
      asset: BTC_ASSET,
      strategy: "btc_session",
      side: dec.direction as "long" | "short",
      equityPct: SESSION_EQUITY_PCT,
      leverage: SESSION_LEVERAGE,
      tpPct: SESSION_TP1_PCT,  // legacy field (kept for back-compat)
      slPct: SESSION_SL_PCT,
      tp1Pct: SESSION_TP1_PCT,
      tp2Pct: SESSION_TP2_PCT,
      tp1SizePct: SESSION_TP1_SIZE_PCT,
      price: entryPrice,
      equity,
      entryReason,
      config,
      useLimit,
    });

    if (entered) {
      this.sessionState.entryDone = true;
      this.dailyTradeCount++;
      await this.saveSessionState();
      log(`[SESSION] Entered ${dec.direction.toUpperCase()} BTC @ $${entryPrice.toFixed(2)} (${useLimit ? "LIMIT" : "MARKET"}) conf=${dec.confidence}`, "engine");
    } else if (useLimit && this.sessionState.entryOrderPlacedAt) {
      // Limit resting — keep state as-is so next tick can poll
      log(`[SESSION] LIMIT resting @ $${entryPrice.toFixed(2)} — will upgrade to MARKET after 60s`, "engine");
    }
  }

  // ============ EXIT / BE+ MONITORING ============

  private async checkExits(equity?: number) {
    const config = await storage.getConfig();
    if (!config) return;
    let openTrades = await storage.getOpenTrades();
    const mids: Record<string, string> = (await fetchAllMids()) || {};
    const currentEquity = equity || this.lastKnownEquity || 0;

    const hlPosMap: Map<string, any> = new Map();

    if (config.apiSecret && config.walletAddress && openTrades.length > 0) {
      try {
        const syncExec = createExecutor(config.apiSecret, config.walletAddress);
        const hlPositions = await syncExec.getPositions();
        for (const p of hlPositions) {
          const pos = p.position;
          const sz = Math.abs(parseFloat(pos?.szi || "0"));
          if (sz > 0) hlPosMap.set(pos.coin, pos);
        }

        const currentOpenIds = new Set(openTrades.map(t => t.id));

        for (const trade of openTrades) {
          const tradeAge = Date.now() - new Date(trade.openedAt || 0).getTime();
          if (tradeAge < 300_000) {
            this.syncMissCount.delete(trade.id);
            continue;
          }

          if (hlPosMap.has(trade.coin)) {
            if (this.syncMissCount.has(trade.id)) this.syncMissCount.delete(trade.id);
          } else {
            const misses = (this.syncMissCount.get(trade.id) || 0) + 1;
            this.syncMissCount.set(trade.id, misses);
            log(`[SYNC] Trade #${trade.id} ${trade.coin} — no HL position (miss ${misses}/3)`, "engine");

            if (misses < 3) continue;

            try {
              const openOrders = await syncExec.getOpenOrders();
              const coinOrders = openOrders.filter((o: any) => o.coin === trade.coin);
              for (const order of coinOrders) {
                await syncExec.cancelOrder(order.coin, order.oid);
                log(`[SYNC SAFETY] Cancelled lingering order ${order.coin} oid=${order.oid}`, "engine");
              }
            } catch (cancelErr) { log(`[SYNC SAFETY] Cancel error: ${cancelErr}`, "engine"); }

            this.syncMissCount.delete(trade.id);
            this.beApplied.delete(trade.id);
            const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
            const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
            const hlPnl = extractClosePnlFromFills(fills, trade.coin, trade.side as any, tradeOpenTime);
            const syncEq = (trade as any).entryEquity || currentEquity;
            let netPnl: number;
            let exitPrice: number;
            let closeFee = 0;

            if (hlPnl) {
              netPnl = hlPnl.netPnl;
              exitPrice = hlPnl.exitPrice;
              closeFee = hlPnl.totalFee;
            } else {
              exitPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
              const isLong = trade.side === "long";
              const pv = (trade as any).notionalValue || (syncEq * (trade.size / 100) * trade.leverage);
              const rm = isLong
                ? (exitPrice - trade.entryPrice) / trade.entryPrice
                : (trade.entryPrice - exitPrice) / trade.entryPrice;
              netPnl = pv * rm - pv * 0.00045 * 2;
            }
            const pnlOfAum = syncEq > 0 ? (netPnl / syncEq) * 100 : 0;
            await storage.updateTrade(trade.id, {
              exitPrice, pnl: 0, pnlPct: pnlOfAum,
              hlPnlUsd: netPnl, hlCloseFee: closeFee,
              status: "closed", closeReason: `Position closed on HL (sync) | P&L: $${netPnl.toFixed(2)}`,
              closedAt: new Date().toISOString(),
            });
            log(`[SYNC] Trade #${trade.id} ${trade.coin} auto-closed | HL P&L: $${netPnl.toFixed(2)}`, "engine");

            // Mark session state
            if (trade.strategy === "btc_session") {
              this.sessionState.entryClosed = true;
              this.sessionState.sessionResult = netPnl > 0 ? "tp" : "sl";
              // If TP and re-entry allowed, clear entryDone so we can re-enter within window
              if (netPnl > 0) {
                this.sessionState.entryDone = false;
                this.sessionState.entryOrderPlacedAt = undefined;
                this.sessionState.entryOrderCoin = undefined;
              }
              await this.saveSessionState();
            }

            // v17.6 TLBR close accounting
            if (trade.strategy === "tlbr") {
              await this.onTlbrTradeClosed(trade.id, netPnl);
            }

            await storage.createLog({
              type: "trade_close",
              message: `[SYNC] Auto-closed ${trade.coin} ${trade.side} #${trade.id} | HL P&L: $${netPnl.toFixed(2)} USDC`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        for (const [tid] of this.syncMissCount) {
          if (!currentOpenIds.has(tid)) this.syncMissCount.delete(tid);
        }

        openTrades = await storage.getOpenTrades();
      } catch (e) {
        log(`[SYNC] Position sync error: ${e}`, "engine");
      }
    }

    // ============ OPEN TRADE MONITORING ============
    for (const trade of openTrades) {
      const currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0) continue;
      const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
      const szd = ac?.szDecimals ?? 2;
      const eqForTrade = (trade as any).entryEquity || currentEquity;
      const isLong = trade.side === "long";
      const isSession = trade.strategy === "btc_session";
      const stratLabel = isSession ? "SESSION" : String(trade.strategy || "LEGACY").toUpperCase();

      const hlPos = hlPosMap.get(trade.coin);
      let pnlUsd: number;
      if (hlPos?.unrealizedPnl !== undefined) {
        pnlUsd = parseFloat(hlPos.unrealizedPnl);
      } else {
        const positionValue = (trade as any).notionalValue || (eqForTrade * (trade.size / 100) * trade.leverage);
        const rawMove = isLong
          ? (currentPrice - trade.entryPrice) / trade.entryPrice
          : (trade.entryPrice - currentPrice) / trade.entryPrice;
        pnlUsd = positionValue * rawMove - positionValue * 0.00045 * 2;
      }
      const pnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;

      // v17.5 BE+: trigger on TP1 FILL (position size halved) — SL moves to entry +0.25% profit lock on remaining 50%.
      // Detection: if HL position size is now <= ~55% of original tp1+tp2 intended size, TP1 filled.
      const priceMovePct = trade.entryPrice > 0
        ? (isLong ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100 : (trade.entryPrice - currentPrice) / trade.entryPrice * 100)
        : 0;
      const isBESL = this.beApplied.has(trade.id);

      // v17.5: detect TP1 fill via HL position size shrinking relative to original notional
      let tp1Filled = trade.tp1Hit === true;
      if (isSession && !tp1Filled && hlPos?.szi !== undefined) {
        const currentAbsSz = Math.abs(parseFloat(String(hlPos.szi)));
        const originalNotional = (trade as any).notionalValue || 0;
        const originalSz = originalNotional > 0 && trade.entryPrice > 0 ? originalNotional / trade.entryPrice : 0;
        // TP1 considered filled when remaining size ≤ 60% of original (50% +10% rounding buffer)
        if (originalSz > 0 && currentAbsSz > 0 && currentAbsSz <= originalSz * 0.60) {
          tp1Filled = true;
          await storage.updateTrade(trade.id, { tp1Hit: true });
          trade.tp1Hit = true;
          const tp1PctStr = (trade.takeProfit1 && trade.takeProfit1 > 0 && trade.entryPrice > 0)
            ? Math.abs((trade.takeProfit1 - trade.entryPrice) / trade.entryPrice * 100).toFixed(2)
            : "?";
          log(`[TP1 FILLED] Trade #${trade.id} ${trade.coin} ${trade.side.toUpperCase()} | orig size ${originalSz.toFixed(5)} → remaining ${currentAbsSz.toFixed(5)} (~50% closed at TP1)`, "engine");
          await storage.createLog({
            type: "system",
            message: `[TP1 FILLED SESSION] ${trade.coin} ${trade.side.toUpperCase()} +${tp1PctStr}% — 50% closed, moving SL to BE+`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (isSession && !isBESL && tp1Filled && config.apiSecret && config.walletAddress) {
        try {
          const executor = createExecutor(config.apiSecret, config.walletAddress);
          const newSL = isLong
            ? trade.entryPrice * (1 + SESSION_BE_LOCK_PCT)
            : trade.entryPrice * (1 - SESSION_BE_LOCK_PCT);
          const openOrders = await executor.getOpenOrders();
          const slOrders = openOrders.filter((o: any) => o.coin === trade.coin && o.triggerCondition !== undefined);
          for (const o of slOrders) {
            try { await executor.cancelOrder(o.coin, o.oid); } catch (ce) { log(`[BE+] Cancel SL error: ${ce}`, "engine"); }
          }
          const slTriggerPx = parseFloat(formatHLPrice(newSL, szd));
          const slFillPx = parseFloat(formatHLPrice(isLong ? newSL * 0.98 : newSL * 1.02, szd));
          const pos = hlPos || (await executor.getPositions()).find((p: any) => p.position?.coin === trade.coin)?.position;
          const sz = pos ? Math.abs(parseFloat(pos.szi || "0")) : 0;
          if (sz > 0) {
            await executor.placeOrder({
              coin: trade.coin, isBuy: !isLong, sz,
              limitPx: slFillPx,
              orderType: { trigger: { triggerPx: String(slTriggerPx), isMarket: true, tpsl: "sl" } },
              reduceOnly: true,
            });
            await storage.updateTrade(trade.id, { stopLoss: newSL });
            trade.stopLoss = newSL;
            this.beApplied.add(trade.id);
            const sideLabel = isLong ? "LONG" : "SHORT";
            log(`[BE+ SESSION] Trade #${trade.id} ${trade.coin} ${sideLabel} | TP1 filled → SL $${displayPrice(newSL, szd)} (+0.25% profit lock on remaining ${sz.toFixed(5)})`, "engine");
            await storage.createLog({
              type: "system",
              message: `[BE+ SESSION] ${trade.coin} ${sideLabel} | TP1 hit → SL locked at +0.25% ($${displayPrice(newSL, szd)})`,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (beErr) { log(`[BE+ SESSION] Error on trade #${trade.id}: ${beErr}`, "engine"); }
      }

      // Exit checks
      const tpPctFromEntry = trade.entryPrice > 0 && trade.takeProfit1 ? (Math.abs(trade.takeProfit1 - trade.entryPrice) / trade.entryPrice * 100).toFixed(2) : "?";
      const tpPctLabel = `TP +${tpPctFromEntry}%`;

      let shouldClose = false;
      let closeReason = "";

      const tpHit = isLong ? currentPrice >= (trade.takeProfit1 || Infinity) : currentPrice <= (trade.takeProfit1 || 0);
      const slActive = trade.stopLoss > 0;
      const slHit = slActive && (isLong ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss);
      const slPctFromEntry = trade.entryPrice > 0 ? (Math.abs(trade.stopLoss - trade.entryPrice) / trade.entryPrice * 100).toFixed(2) : "?";

      if (tpHit) {
        shouldClose = true;
        closeReason = `[${stratLabel}] ${tpPctLabel} @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
      } else if (slHit) {
        shouldClose = true;
        closeReason = `[${stratLabel}] SL -${slPctFromEntry}% @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
        log(`[SL HIT] Trade #${trade.id} ${trade.coin} ${trade.side.toUpperCase()} [${stratLabel}] | Price $${displayPrice(currentPrice, szd)} hit SL $${displayPrice(trade.stopLoss, szd)}`, "engine");
      }

      if (shouldClose) {
        this.beApplied.delete(trade.id);

        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            try {
              const openOrders = await executor.getOpenOrders();
              const coinOrders = openOrders.filter((o: any) => o.coin === trade.coin);
              for (const order of coinOrders) {
                await executor.cancelOrder(order.coin, order.oid);
              }
            } catch (cancelErr) { log(`[SAFETY] Cancel orders error: ${cancelErr}`, "engine"); }

            const pos = hlPos || (await executor.getPositions()).find((p: any) => p.position?.coin === trade.coin)?.position;
            if (pos) {
              const sz = Math.abs(parseFloat(pos.szi || "0"));
              const closePx = isLong ? currentPrice * 0.99 : currentPrice * 1.01;
              await executor.placeOrder({
                coin: trade.coin, isBuy: !isLong, sz,
                limitPx: parseFloat(formatHLPrice(closePx, szd)),
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
              });
            }
          } catch (e) { log(`Close error: ${e}`, "engine"); }

          await new Promise(r => setTimeout(r, 1500));
          try {
            const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
            const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
            const hlPnl = extractClosePnlFromFills(fills, trade.coin, trade.side as "long" | "short", tradeOpenTime);
            if (hlPnl) {
              pnlUsd = hlPnl.netPnl;
              const exitLabel = slHit ? (isBESL ? "SL @ +0.25% (BE+ profit lock)" : `SL -${slPctFromEntry}%`) : tpPctLabel;
              closeReason = `[${stratLabel}] ${exitLabel} | HL P&L: $${hlPnl.netPnl.toFixed(2)} (gross=$${hlPnl.closedPnl.toFixed(2)} fee=$${hlPnl.totalFee.toFixed(2)})`;
              const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
              await storage.updateTrade(trade.id, {
                exitPrice: hlPnl.exitPrice, pnl: 0, pnlPct: finalPnlOfAum,
                hlPnlUsd: hlPnl.netPnl, hlCloseFee: hlPnl.totalFee,
                peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
              });
              log(`[CLOSE] Trade #${trade.id} ${trade.coin} ${trade.side.toUpperCase()} [${stratLabel}] | HL P&L: $${hlPnl.netPnl.toFixed(2)}`, "engine");
            } else {
              const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
              await storage.updateTrade(trade.id, {
                exitPrice: currentPrice, pnl: 0, pnlPct: finalPnlOfAum,
                hlPnlUsd: pnlUsd, hlCloseFee: 0,
                peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
              });
            }
          } catch (e) {
            log(`[CLOSE] Fill fetch error: ${e}`, "engine");
            const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
            await storage.updateTrade(trade.id, {
              exitPrice: currentPrice, pnl: 0, pnlPct: finalPnlOfAum,
              hlPnlUsd: pnlUsd, hlCloseFee: 0,
              peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
            });
          }
        } else {
          const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
          await storage.updateTrade(trade.id, {
            exitPrice: currentPrice, pnl: 0, pnlPct: finalPnlOfAum,
            hlPnlUsd: pnlUsd, hlCloseFee: 0,
            peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
          });
        }

        await logDecision({
          tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side || "long", price: currentPrice,
          reasoning: `EXIT [${stratLabel}]: ${closeReason} | HL P&L: $${pnlUsd.toFixed(2)} | ROI/AUM: ${(eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0).toFixed(3)}%`,
          equity: currentEquity, leverage: trade.leverage, strategy: (trade.strategy as StrategyType) || "btc_session",
        });

        // Mark session state
        if (isSession) {
          this.sessionState.entryClosed = true;
          this.sessionState.sessionResult = tpHit ? "tp" : "sl";
          // Re-entry allowed on TP only
          if (tpHit) {
            this.sessionState.entryDone = false;
            this.sessionState.entryOrderPlacedAt = undefined;
            this.sessionState.entryOrderCoin = undefined;
          }
          await this.saveSessionState();
        }

        // v17.6 TLBR close accounting
        if (trade.strategy === "tlbr") {
          await this.onTlbrTradeClosed(trade.id, pnlUsd);
        }

        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [${stratLabel}] ${trade.side.toUpperCase()} ${trade.coin} | HL P&L: $${pnlUsd.toFixed(2)} USDC | ${closeReason}`,
          timestamp: new Date().toISOString(),
        });
      } else {
        await storage.updateTrade(trade.id, { hlPnlUsd: pnlUsd, pnlPct: pnlOfAum });
      }
    }
  }

  private async takePnlSnapshot(equity?: number) {
    const allTrades = await storage.getAllTrades();
    const openTrades = await storage.getOpenTrades();
    const closedTrades = allTrades.filter(t => t.status === "closed");
    const currentEquity = equity || this.lastKnownEquity || 0;
    const startEq = this.pnlResetEquity || this.startingEquity || currentEquity;

    const closedPnlUsd = closedTrades.reduce((s, t) => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return s + t.hlPnlUsd;
      return s + (startEq > 0 ? startEq * ((t.pnlPct || 0) / 100) : 0);
    }, 0);
    const openPnlUsd = openTrades.reduce((s, t) => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return s + t.hlPnlUsd;
      return s + (currentEquity > 0 ? currentEquity * ((t.pnlPct || 0) / 100) : 0);
    }, 0);
    const totalPnlUsd = closedPnlUsd + openPnlUsd;
    const totalPnlPct = startEq > 0 ? (totalPnlUsd / startEq) * 100 : 0;

    await storage.createPnlSnapshot({
      totalEquity: currentEquity > 0 ? currentEquity : startEq + totalPnlUsd,
      totalPnl: totalPnlPct, totalPnlPct, openPositions: openTrades.length,
      timestamp: new Date().toISOString(),
    });
  }

  async forceCloseTrade(tradeId: number) {
    const trade = await storage.getTradeById(tradeId);
    if (!trade || trade.status !== "open") return null;

    const stratLabel = trade.strategy === "btc_session" ? "SESSION" : String(trade.strategy || "LEGACY").toUpperCase();
    const tradeStrategy = (trade.strategy as StrategyType) || "btc_session";
    const isLong = trade.side === "long";

    const mids: Record<string, string> = (await fetchAllMids()) || {};
    const currentPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
    const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
    const config = await storage.getConfig();

    this.beApplied.delete(tradeId);

    if (config?.apiSecret && config?.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        try {
          const openOrders = await executor.getOpenOrders();
          const coinOrders = openOrders.filter((o: any) => o.coin === trade.coin);
          for (const order of coinOrders) {
            await executor.cancelOrder(order.coin, order.oid);
          }
        } catch (cancelErr) { log(`[FORCE_CLOSE] Cancel error: ${cancelErr}`, "engine"); }

        const positions = await executor.getPositions();
        const pos = positions.find((p: any) => p.position?.coin === trade.coin);
        if (pos) {
          const sz = Math.abs(parseFloat(pos.position.szi || "0"));
          const closePx = isLong ? currentPrice * 0.99 : currentPrice * 1.01;
          await executor.placeOrder({
            coin: trade.coin, isBuy: !isLong, sz,
            limitPx: parseFloat(formatHLPrice(closePx, ac?.szDecimals ?? 2)),
            orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
          });
        }
      } catch (e) { log(`Close error: ${e}`, "engine"); }

      await new Promise(r => setTimeout(r, 1500));
      try {
        const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
        const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
        const hlPnl = extractClosePnlFromFills(fills, trade.coin, trade.side as "long" | "short", tradeOpenTime);
        if (hlPnl) {
          const eq = this.lastKnownEquity || 0;
          const eqForClose = (trade as any).entryEquity || eq;
          const pnlOfAum = eqForClose > 0 ? (hlPnl.netPnl / eqForClose) * 100 : 0;
          const updated = await storage.updateTrade(trade.id, {
            exitPrice: hlPnl.exitPrice, pnl: 0, pnlPct: pnlOfAum,
            hlPnlUsd: hlPnl.netPnl, hlCloseFee: hlPnl.totalFee,
            status: "closed", closeReason: `Manual close [${stratLabel}] | HL P&L: $${hlPnl.netPnl.toFixed(2)}`,
            closedAt: new Date().toISOString(),
          });
          await logDecision({
            tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side || "long", price: hlPnl.exitPrice,
            reasoning: `MANUAL CLOSE [${stratLabel}] | HL P&L: $${hlPnl.netPnl.toFixed(2)} | ROI/AUM: ${pnlOfAum.toFixed(3)}%`,
            equity: eq, leverage: trade.leverage, strategy: tradeStrategy,
          });
          await storage.createLog({
            type: "trade_close",
            message: `Manual close [${stratLabel}] ${trade.side.toUpperCase()} ${trade.coin} | HL P&L: $${hlPnl.netPnl.toFixed(2)} USDC`,
            timestamp: new Date().toISOString(),
          });
          return updated;
        }
      } catch (e) { log(`[FORCE_CLOSE] Fill fetch error: ${e}`, "engine"); }
    }

    const FEE_RATE_MC = 0.00045;
    const eq = this.lastKnownEquity || 0;
    const eqForClose = (trade as any).entryEquity || eq;
    const posValue = (trade as any).notionalValue || (eqForClose * (trade.size / 100) * trade.leverage);
    const rawMove = isLong ? (currentPrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - currentPrice) / trade.entryPrice;
    const pnlUsd = posValue * rawMove - posValue * FEE_RATE_MC * 2;
    const pnlOfAum = eqForClose > 0 ? (pnlUsd / eqForClose) * 100 : 0;

    const updated = await storage.updateTrade(trade.id, {
      exitPrice: currentPrice, pnl: 0, pnlPct: pnlOfAum,
      hlPnlUsd: pnlUsd, hlCloseFee: 0,
      status: "closed", closeReason: `Manual close [${stratLabel}] (estimated P&L)`,
      closedAt: new Date().toISOString(),
    });
    await logDecision({
      tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side || "long", price: currentPrice,
      reasoning: `MANUAL CLOSE [${stratLabel}] | Est P&L: $${pnlUsd.toFixed(2)} | ROI/AUM: ${pnlOfAum.toFixed(3)}%`,
      equity: eq, leverage: trade.leverage, strategy: tradeStrategy,
    });
    await storage.createLog({
      type: "trade_close",
      message: `Manual close [${stratLabel}] ${trade.side.toUpperCase()} ${trade.coin} | Est P&L: $${pnlUsd.toFixed(2)} USDC`,
      timestamp: new Date().toISOString(),
    });
    return updated;
  }

  // v17.1: Webhook handler disabled — no breakout/trendline strategy. Preserved for API compat.
  async handleWebhookSignal(_payload: any): Promise<{ accepted: boolean; reason: string }> {
    return { accepted: false, reason: "Webhook strategies disabled in v17.1 (BTC Session Trader only)" };
  }

  async forceScan() { await this.runScanCycle(); }

  async forceSessionTick() { await this.runSessionTick(); }

  getLastKnownEquity(): number { return this.lastKnownEquity; }

  getSessionState(): SessionState { return this.sessionState; }

  async resetPnlBaseline(): Promise<{ resetEquity: number; resetTimestamp: string }> {
    const equity = await this.refreshEquity();
    this.pnlResetTimestamp = new Date().toISOString();
    this.pnlResetEquity = equity;
    this.startingEquity = equity;
    this.dayStartEquity = equity;
    await storage.updateConfig({
      pnlBaselineEquity: equity,
      pnlBaselineTimestamp: this.pnlResetTimestamp,
    });
    await storage.createLog({
      type: "system",
      message: `P&L RESET: New baseline AUM $${equity.toFixed(2)} at ${this.pnlResetTimestamp}`,
      timestamp: this.pnlResetTimestamp,
    });
    log(`P&L baseline reset — new AUM: $${equity.toFixed(2)}`, "engine");
    return { resetEquity: equity, resetTimestamp: this.pnlResetTimestamp };
  }

  async getStatus() {
    const config = await storage.getConfig();
    const openTrades = await storage.getOpenTrades();
    const allTrades = await storage.getAllTrades();
    const resetTs = this.pnlResetTimestamp;
    const activeTrades = resetTs ? allTrades.filter(t => t.openedAt >= resetTs) : allTrades;
    const activeClosedTrades = activeTrades.filter(t => t.status === "closed");
    const winTrades = activeClosedTrades.filter(t => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return t.hlPnlUsd > 0;
      return (t.pnlPct || 0) > 0;
    });
    const winRate = activeClosedTrades.length > 0 ? (winTrades.length / activeClosedTrades.length) * 100 : 0;
    const si = getSessionInfo();
    const stats = await getLearningStats();

    const currentEquity = this.lastKnownEquity || 0;
    const startEq = this.pnlResetEquity || this.startingEquity || currentEquity;

    const closedPnlUsd = activeClosedTrades.reduce((s, t) => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return s + t.hlPnlUsd;
      return s + (startEq > 0 ? startEq * ((t.pnlPct || 0) / 100) : 0);
    }, 0);
    const openPnlUsd = openTrades.reduce((s, t) => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return s + t.hlPnlUsd;
      return s + (currentEquity > 0 ? currentEquity * ((t.pnlPct || 0) / 100) : 0);
    }, 0);
    const combinedPnlUsd = closedPnlUsd + openPnlUsd;

    const closedPnlOfAum = startEq > 0 ? (closedPnlUsd / startEq) * 100 : 0;
    const openPnlOfAum = currentEquity > 0 ? (openPnlUsd / currentEquity) * 100 : 0;
    const combinedPnlOfAum = startEq > 0 ? (combinedPnlUsd / startEq) * 100 : 0;

    const drawdownPct = this.dayStartEquity > 0 ? ((this.dayStartEquity - currentEquity) / this.dayStartEquity) * 100 : 0;
    const drawdownUsd = this.dayStartEquity - currentEquity;

    const openTradesWithUsd = openTrades.map(t => {
      const eqForT = (t as any).entryEquity || currentEquity;
      const pnlUsd = (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) ? t.hlPnlUsd : 0;
      const pnlOfAum = eqForT > 0 ? (pnlUsd / eqForT) * 100 : 0;
      const stratBadge = t.strategy === "btc_session" ? "SESSION" : String(t.strategy || "LEGACY").toUpperCase();
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)), stratBadge };
    });

    // Session strategy stats (v17.1)
    const sessionTrades = activeClosedTrades.filter(t => t.strategy === "btc_session");
    const sessionWins = sessionTrades.filter(t => (t.hlPnlUsd ?? (t.pnlPct || 0)) > 0).length;
    const sessionWinRate = sessionTrades.length > 0 ? (sessionWins / sessionTrades.length) * 100 : 0;
    const sessionPnlUsd = sessionTrades.reduce((s, t) => s + (t.hlPnlUsd ?? (startEq * (t.pnlPct || 0) / 100)), 0);
    const sessionPnlOfAum = startEq > 0 ? (sessionPnlUsd / startEq) * 100 : 0;

    // v17.6 TLBR stats
    const tlbrTrades = activeClosedTrades.filter(t => t.strategy === "tlbr");
    const tlbrWins = tlbrTrades.filter(t => (t.hlPnlUsd ?? (t.pnlPct || 0)) > 0).length;
    const tlbrWinRate = tlbrTrades.length > 0 ? (tlbrWins / tlbrTrades.length) * 100 : 0;
    const tlbrPnlUsd = tlbrTrades.reduce((s, t) => s + (t.hlPnlUsd ?? 0), 0);
    const tlbrPnlOfAum = startEq > 0 ? (tlbrPnlUsd / startEq) * 100 : 0;

    return {
      isRunning: config?.isRunning || false,
      openPositions: openTrades.length,
      totalTrades: activeTrades.length,
      totalTradesAllTime: allTrades.length,
      closedTrades: activeClosedTrades.length,
      winRate: winRate.toFixed(1),
      totalPnl: closedPnlOfAum.toFixed(2),
      totalPnlUsd: closedPnlUsd.toFixed(4),
      openPnl: openPnlOfAum.toFixed(2),
      openPnlUsd: openPnlUsd.toFixed(4),
      combinedPnl: combinedPnlOfAum.toFixed(2),
      combinedPnlUsd: combinedPnlUsd.toFixed(4),
      session: si.session,
      sessionDescription: si.description,
      drawdownPct: drawdownPct.toFixed(2),
      drawdownUsd: drawdownUsd.toFixed(4),
      drawdownPaused: false,
      dayStartEquity: this.dayStartEquity.toFixed(2),
      dailyTradeCount: this.dailyTradeCount,
      dailyTradeTarget: 1,
      equity: currentEquity.toFixed(2),
      startingEquity: startEq.toFixed(2),
      pnlResetTimestamp: this.pnlResetTimestamp || null,
      learningStats: stats,
      allowedAssets: ALLOWED_ASSETS.map(a => ({ coin: a.coin, name: a.displayName, category: a.category, maxLev: a.maxLeverage })),
      openTradesWithUsd,
      sessionState: this.sessionState,
      tlbrState: this.tlbrState,
      version: "v17.6",
      strategyStats: {
        btc_session: {
          trades: sessionTrades.length,
          winRate: sessionWinRate.toFixed(1),
          openPositions: openTrades.filter(t => t.strategy === "btc_session").length,
          pnlUsd: sessionPnlUsd.toFixed(4),
          pnlOfAum: sessionPnlOfAum.toFixed(3),
          status: "active",
          direction: "LONG + SHORT",
          asset: "BTC",
          schedule: "Mon–Fri 08:30–10:00 ET (Sonar→Opus→NY Open)",
          riskReward: "TP1 +0.5% (50%) → TP2 +1.0% (50%) / SL -0.5% | BE+ @ TP1 fill → SL +0.25% profit lock | Technicals-first + hard veto",
          sizing: `${(SESSION_EQUITY_PCT * 100).toFixed(0)}% of AUM, ${SESSION_LEVERAGE}x leverage`,
          confidenceThreshold: `${SESSION_CONFIDENCE_THRESHOLD}/10`,
          llm: "Claude Opus 4.7 (decision) + Sonar (news)",
        },
        tlbr: {
          trades: tlbrTrades.length,
          winRate: tlbrWinRate.toFixed(1),
          openPositions: openTrades.filter(t => t.strategy === "tlbr").length,
          pnlUsd: tlbrPnlUsd.toFixed(4),
          pnlOfAum: tlbrPnlOfAum.toFixed(3),
          cumulativeTlbrPnl: this.tlbrState.cumulativePnlUsd.toFixed(2),
          status: this.tlbrState.disabled ? "disabled (kill switch)" : "active",
          direction: "LONG only (descending trendline breakout retest)",
          asset: "BTC",
          schedule: "Mon–Fri 24h (Opus discovery every 60min)",
          riskReward: `TP +${(TLBR_TP_PCT * 100).toFixed(2)}% / SL -${(TLBR_SL_PCT * 100).toFixed(2)}% | 1 shot per trendline | setup expires 15min | kill switch $${TLBR_KILL_SWITCH_USD}`,
          sizing: `$${TLBR_MARGIN_USD} margin × ${TLBR_LEVERAGE}x = $${TLBR_MARGIN_USD * TLBR_LEVERAGE} notional`,
          confidenceThreshold: "7/10",
          llm: "Claude Opus 4.7 (trendline + retest + FVG detection)",
          pendingSetup: this.tlbrState.pendingSetup ? {
            retestLevel: this.tlbrState.pendingSetup.retestLevel.toFixed(2),
            retestZone: `$${this.tlbrState.pendingSetup.retestZoneLow.toFixed(2)}–$${this.tlbrState.pendingSetup.retestZoneHigh.toFixed(2)}`,
            confidence: `${this.tlbrState.pendingSetup.confidence}/10`,
            hasFvg: !!this.tlbrState.pendingSetup.fvg,
            ageMin: Math.floor((Date.now() - this.tlbrState.pendingSetup.discoveredAt) / 60000),
          } : null,
        },
      },
    };
  }
}

export const tradingEngine = new TradingEngine();
export { ALLOWED_ASSETS };
