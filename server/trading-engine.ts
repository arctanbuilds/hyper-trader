/**
 * HyperTrader — Trading Engine v15.9
 *
 * TRIPLE STRATEGY: Breakout & Retest + Overbought/Oversold + Oil News Sentiment
 *
 * STRATEGY A — Breakout & Retest (TV Webhook):
 *   - BTC only — LONG only
 *   - 1/3 of (equity - $100) for margin, max leverage, max 1 position
 *   - Signals from TradingView AlgoAlpha Breakout & Retest webhook
 *   - SL -0.35%, TP +0.35%
 *   - No BE rule
 *
 * STRATEGY B — Overbought / Oversold (RSI):
 *   - BTC only — LONG + SHORT
 *   - 1/3 of (equity - $100) for margin, max leverage, max 1 position
 *   - LONG: 5m RSI ≤ 15 OR 15m RSI ≤ 15
 *   - SHORT: 5m RSI ≥ 88 OR 15m RSI ≥ 88
 *   - SL -0.5%, TP +0.45%
 *   - BE rule: after +0.3% profit → move SL to +0.2% (profit zone)
 *
 * STRATEGY C — Oil News Sentiment:
 *   - WTI Crude Oil (xyz:CL) via XYZ DEX perps — LONG + SHORT
 *   - $100 fixed allocation, 20x leverage, isolated margin
 *   - Every 5 min: Sonar API scans macro/political news → sentiment → direction
 *   - SL -2%, TP +2%, BE at +0.5% → SL moves to entry (v15.9)
 *   - Max 1 position, 1-hour cooldown after loss
 *   - Confidence threshold: ≥ 7/10 to trade
 *
 * Equity Split:
 *   - Oil gets $100 fixed
 *   - Remaining (equity - $100) splits equally: B&R 50% / OBOS 50%
 *
 * Shared:
 *   - Scan every 5 seconds (BTC strategies)
 *   - Oil scans every 5 minutes (separate timer)
 *   - Cancel all orders on close (ghost position prevention)
 *   - Orphan detector on startup
 *   - SL + TP orders placed on HL immediately at fill
 *   - Intra-candle RSI (append current price to closes)
 *   - If bot took 1 trade in a setup and failed, ignore that setup
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

// v15.5: Core-4 majors (BTC, ETH, SOL, XRP) — RSI + SMC support/demand confluence
const ALLOWED_ASSETS: AssetConfig[] = [
  { coin: "BTC",      displayName: "Bitcoin",    dex: "", maxLeverage: 40, szDecimals: 5, category: "crypto", minNotional: 10 },
  { coin: "ETH",      displayName: "Ethereum",   dex: "", maxLeverage: 25, szDecimals: 4, category: "crypto", minNotional: 10 },
  { coin: "SOL",      displayName: "Solana",     dex: "", maxLeverage: 20, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "XRP",      displayName: "XRP",        dex: "", maxLeverage: 20, szDecimals: 0, category: "crypto", minNotional: 10 },
];

// Oil asset — XYZ DEX perp (separate from ALLOWED_ASSETS to avoid BTC scan logic)
const OIL_ASSET: AssetConfig = {
  coin: "xyz:CL", displayName: "WTI Crude Oil", dex: "xyz", maxLeverage: 20, szDecimals: 3,
  category: "commodity", minNotional: 10, isolatedOnly: true,
};

// All tradeable assets (for orphan detection)
const ALL_TRADEABLE_COINS = [...ALLOWED_ASSETS.map(a => a.coin), OIL_ASSET.coin];

// ============ STRATEGY TYPE ============
type StrategyType = "breakout" | "obos" | "oil_news";

// ============ OIL NEWS SENTIMENT ============

const OIL_SCAN_INTERVAL_MS = 5 * 60 * 1000; // v15.7: 5 minutes (was 15)
const OIL_FIXED_CAPITAL = 100; // $100 fixed allocation
const OIL_LEVERAGE = 20;
const OIL_TP_PCT = 0.02;  // v15.9: +2% (was +5%)
const OIL_SL_PCT = 0.02;  // -2%
const OIL_CONFIDENCE_THRESHOLD = 7;
const OIL_LOSS_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour after loss

interface OilSentiment {
  direction: "long" | "short" | "skip";
  confidence: number;
  headlines: string[];
  reasoning: string;
}

async function fetchOilSentiment(apiKey: string): Promise<OilSentiment> {
  const systemPrompt = `You are an elite commodities analyst specializing in crude oil markets. Your job is to evaluate the latest macroeconomic, geopolitical, and energy market news and determine the short-term directional bias for WTI crude oil.

Focus on:
- OPEC+ decisions, production cuts/increases
- Middle East geopolitical tensions (Iran, Saudi, Iraq)
- US inventory data (EIA, API reports)
- US Dollar strength/weakness (DXY)
- China demand signals
- Sanctions, trade wars, embargoes
- Hurricane/weather disruptions to Gulf production
- Fed policy / interest rate expectations
- Recession signals or economic growth data
- Russia-Ukraine conflict energy implications

RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no explanation outside JSON):
{
  "direction": "long" | "short" | "skip",
  "confidence": 1-10,
  "headlines": ["headline1", "headline2", "headline3"],
  "reasoning": "2-3 sentence explanation of the directional thesis"
}

Rules:
- "skip" if no clear directional signal or mixed signals
- confidence 1-4 = weak signal, 5-6 = moderate, 7-8 = strong, 9-10 = very strong
- Only return "long" or "short" with confidence >= 5
- Search for news from the past 2-4 hours specifically`;

  const prompt = `Search for the latest macro, geopolitical, and energy market news from the past 2-4 hours. Evaluate the combined sentiment specifically for WTI crude oil price direction over the next 1-4 hours.

Return ONLY the JSON object. No markdown code blocks.`;

  try {
    const res = await fetch("https://api.perplexity.ai/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "perplexity/sonar",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        max_output_tokens: 1024,
        tools: [{ type: "web_search" }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log(`[OIL NEWS] Sonar API error: ${res.status} ${errText.slice(0, 300)}`, "engine");
      return { direction: "skip", confidence: 0, headlines: [], reasoning: `API error: ${res.status}` };
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
    if (!text) {
      log(`[OIL NEWS] No text output from Sonar`, "engine");
      return { direction: "skip", confidence: 0, headlines: [], reasoning: "No output" };
    }

    // Parse JSON
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }
    const parsed = JSON.parse(jsonStr);

    const direction = parsed.direction === "long" || parsed.direction === "short" ? parsed.direction : "skip";
    const confidence = typeof parsed.confidence === "number" ? Math.min(10, Math.max(0, parsed.confidence)) : 0;
    const headlines = Array.isArray(parsed.headlines) ? parsed.headlines.slice(0, 5) : [];
    const reasoning = String(parsed.reasoning || "").slice(0, 500);

    log(`[OIL NEWS] Sonar verdict: ${direction.toUpperCase()} confidence=${confidence}/10 | ${reasoning.slice(0, 100)}`, "engine");
    return { direction, confidence, headlines, reasoning };
  } catch (e) {
    log(`[OIL NEWS] Sentiment fetch error: ${e}`, "engine");
    return { direction: "skip", confidence: 0, headlines: [], reasoning: `Error: ${e}` };
  }
}

async function fetchXyzMidPrice(coin: string): Promise<number> {
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }),
    });
    const data: any = await res.json();
    if (!data || data.length < 2) return 0;
    const universe = data[0]?.universe || [];
    const ctxs = data[1] || [];
    for (let i = 0; i < universe.length; i++) {
      if (universe[i].name === coin && ctxs[i]?.midPx && ctxs[i].midPx !== "None") {
        return parseFloat(ctxs[i].midPx);
      }
    }
    return 0;
  } catch (e) {
    log(`[OIL] XYZ mid price error for ${coin}: ${e}`, "engine");
    return 0;
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

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 3600 * 1000,
  "4h": 4 * 3600 * 1000,
  "1d": 24 * 3600 * 1000,
};

interface OHLCVCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============ SMC: Support Level & Demand Zone Detection (v15.5) ============
// Pure price-action algorithm — no AI/LLM. Uses 15m candles for structure.

interface SupportResult {
  found: boolean;
  type: "level" | "zone" | null;
  price: number;       // top of zone or level price
  low: number;         // zone low (== price for levels)
  distancePct: number; // (currentPrice - price) / currentPrice * 100
  touches?: number;    // for levels
  details: string;
}

/**
 * Find a horizontal support level (swing-low cluster) or demand zone within `maxDistPct` below currentPrice.
 * - Swing lows: 5-candle fractal (low lower than 2 before + 2 after)
 * - Levels: cluster swing lows within 0.15% of each other, require ≥2 touches
 * - Demand zones: last base candle before an impulse-up ≥1% within 3 candles, unmitigated
 * - Returns the CLOSEST qualifying structure within maxDistPct below price.
 */
function findNearbySupport(candles: OHLCVCandle[], currentPrice: number, maxDistPct: number = 0.3): SupportResult {
  const none: SupportResult = { found: false, type: null, price: 0, low: 0, distancePct: 0, details: "no structure" };
  if (!candles || candles.length < 20) return none;

  // --- Step 1: detect swing-low fractals (skip last 2 candles — can't confirm) ---
  const swings: { idx: number; price: number }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const lo = candles[i].low;
    if (lo < candles[i-1].low && lo < candles[i-2].low && lo < candles[i+1].low && lo < candles[i+2].low) {
      swings.push({ idx: i, price: lo });
    }
  }

  // --- Step 2: cluster swing lows within 0.15% to build horizontal levels (≥2 touches) ---
  const CLUSTER_TOL = 0.0015; // 0.15%
  const levels: { price: number; touches: number }[] = [];
  const used = new Set<number>();
  for (let i = 0; i < swings.length; i++) {
    if (used.has(i)) continue;
    const cluster = [swings[i].price];
    used.add(i);
    for (let j = i + 1; j < swings.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(swings[j].price - swings[i].price) / swings[i].price <= CLUSTER_TOL) {
        cluster.push(swings[j].price);
        used.add(j);
      }
    }
    if (cluster.length >= 2) {
      const avg = cluster.reduce((a, b) => a + b, 0) / cluster.length;
      levels.push({ price: avg, touches: cluster.length });
    }
  }

  // --- Step 3: find unmitigated demand zones ---
  // Base candle = bearish or small-bodied candle followed by strong impulse-up ≥1% close-to-close within 3 candles.
  // Zone = [low, max(open, close)]. Unmitigated if no later candle has low <= zone.low.
  const zones: { low: number; top: number; idx: number }[] = [];
  for (let i = 0; i < candles.length - 4; i++) {
    const base = candles[i];
    // Base candle filter: body must be ≤50% of total range (avoid fat bullish candles)
    const bodySize = Math.abs(base.close - base.open);
    const totalRange = base.high - base.low;
    if (totalRange === 0 || bodySize / totalRange > 0.5) continue;
    // Impulse: max CLOSE of next 3 candles is ≥1% above base.close (real directional move)
    const impulseClose = Math.max(candles[i+1].close, candles[i+2].close, candles[i+3].close);
    if ((impulseClose - base.close) / base.close >= 0.01) {
      const zoneTop = Math.max(base.open, base.close);
      const zoneLow = base.low;
      // Mitigation check: any later candle with low ≤ zoneLow invalidates
      let mitigated = false;
      for (let k = i + 4; k < candles.length; k++) {
        if (candles[k].low <= zoneLow) { mitigated = true; break; }
      }
      if (!mitigated) zones.push({ low: zoneLow, top: zoneTop, idx: i });
    }
  }

  // --- Step 4: find closest qualifying structure BELOW currentPrice within maxDistPct ---
  const maxDist = maxDistPct / 100;
  let best: SupportResult = none;

  for (const lv of levels) {
    if (lv.price >= currentPrice) continue; // must be below
    const dist = (currentPrice - lv.price) / currentPrice;
    if (dist <= maxDist) {
      const distPct = dist * 100;
      if (!best.found || distPct < best.distancePct) {
        best = {
          found: true, type: "level", price: lv.price, low: lv.price, distancePct: distPct,
          touches: lv.touches,
          details: `Level @ $${lv.price.toFixed(4)} (${lv.touches} touches, ${distPct.toFixed(2)}% below)`,
        };
      }
    }
  }

  for (const z of zones) {
    // Price must be ABOVE zone top (not inside/below)
    if (z.top >= currentPrice) continue;
    const dist = (currentPrice - z.top) / currentPrice;
    if (dist <= maxDist) {
      const distPct = dist * 100;
      if (!best.found || distPct < best.distancePct) {
        best = {
          found: true, type: "zone", price: z.top, low: z.low, distancePct: distPct,
          details: `Demand zone [$${z.low.toFixed(4)} – $${z.top.toFixed(4)}] (${distPct.toFixed(2)}% below top)`,
        };
      }
    }
  }

  return best;
}


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
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }));
  } catch (e) { log(`OHLCV error ${coin}/${interval}: ${e}`, "engine"); return []; }
}

async function fetchAllMids(): Promise<Record<string, string>> {
  try {
    const res = await fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
    return await res.json() as any;
  } catch (e) { log(`Mids error: ${e}`, "engine"); return {}; }
}

async function fetchMetaAndAssetCtxs(dex: string = ""): Promise<any> {
  try {
    const body: any = { type: "metaAndAssetCtxs" };
    if (dex) body.dex = dex;
    const res = await fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await res.json();
  } catch (e) { log(`MetaCtx error (dex=${dex}): ${e}`, "engine"); return null; }
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

    // Unified wallet: spot USDC is the true equity source
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
  const closeFills = fills.filter(f =>
    f.coin === coin && f.dir === closeDir && f.time >= afterTime
  );
  if (closeFills.length === 0) return null;

  let closedPnl = 0;
  let totalFee = 0;
  let totalSz = 0;
  let weightedPx = 0;
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

class TradingEngine {
  private scanTimer: NodeJS.Timeout | null = null;
  private oilScanTimer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private isOilScanning = false;
  private lastKnownEquity = 0;
  private startingEquity = 0;
  private dayStartEquity = 0;
  private dayStartDate = "";
  private dailyTradeCount = 0;
  private dailyTradeDate = "";
  private scanCount = 0;
  private oilScanCount = 0;
  private lastLearningReview = 0;
  private pnlResetTimestamp = "";
  private pnlResetEquity = 0;

  // OBOS cross state — only enter once per RSI extreme event
  private obosCrossState: Map<string, { price: number; timestamp: number; rsi: number }> = new Map();

  // Breakout & Retest strategy state — TradingView webhook
  private breakoutCooldown = 0;
  private pendingWebhookSignal: { signal: "LONG" | "SHORT"; price: number; time: number; source: string; coin: string } | null = null;

  // Robust position sync — track consecutive "no position" readings per tradeId
  private syncMissCount: Map<number, number> = new Map();

  // OBOS BE tracking — track whether BE has been applied per tradeId
  private beApplied: Set<number> = new Set();

  // Oil News strategy state
  private oilLossCooldownUntil = 0; // timestamp: don't trade oil until this time
  private lastOilSentiment: OilSentiment | null = null;

  private resetLossTrackers() {
    this.dailyTradeCount = 0;
    this.dailyTradeDate = new Date().toISOString().split("T")[0];
  }

  async start() {
    const config = await storage.getConfig();
    if (!config) return;
    this.resetLossTrackers();

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

    // Restore last review time from DB
    const lastReviewTime = await storage.getLastReviewTime();
    if (lastReviewTime) {
      this.lastLearningReview = new Date(lastReviewTime).getTime();
    }

    // Clean stale scan rows for coins no longer in allowed list
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
            const ac = ALLOWED_ASSETS.find(a => a.coin === pos.coin) || (pos.coin === OIL_ASSET.coin ? OIL_ASSET : null);
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
      message: `Engine v15.9 started | DUAL: RSI-26+SMC Core-4 + Oil News 5-min (TP+2%, BE @+0.5% L+S) | AUM: $${this.lastKnownEquity.toLocaleString()} | Oil: $${OIL_FIXED_CAPITAL} fixed`,

      timestamp: new Date().toISOString(),
    });
    log(`Engine v15.9 started | DUAL: RSI-26+SMC Core-4 + Oil News 5-min (TP+2%, BE @+0.5%) | AUM: $${this.lastKnownEquity.toFixed(2)}`, "engine");
    this.scheduleNextScan();
    this.scheduleOilScan();
  }

  async stop() {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    if (this.oilScanTimer) { clearTimeout(this.oilScanTimer); this.oilScanTimer = null; }
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
    tpPct: number;
    slPct: number;
    rsi5m: number;
    rsi15m: number;
    triggerRSI: number;
    price: number;
    equity: number;
    entryReason: string;
    config: any;
  }): Promise<boolean> {
    const { asset, strategy, side, equityPct, leverage, tpPct, slPct, rsi5m, rsi15m, triggerRSI, price, equity, entryReason, config } = params;
    const stratLabel = strategy === "breakout" ? "B&R" : strategy === "oil_news" ? "OIL" : "RSI-26";
    const isBuy = side === "long";

    // Position sizing — equityPct of equity, at leverage
    const capitalForTrade = equity * equityPct;
    const notionalSize = capitalForTrade * leverage;
    const assetSize = notionalSize / price;

    if (capitalForTrade < 5) {
      log(`[${stratLabel}] SKIP ${asset.coin}: capital too low ($${capitalForTrade.toFixed(2)})`, "engine");
      return false;
    }

    const tp = isBuy ? price * (1 + tpPct) : price * (1 - tpPct);
    const sl = isBuy ? price * (1 - slPct) : price * (1 + slPct);
    const tpPctLabel = `+${(tpPct * 100).toFixed(2)}%`;
    const slPctLabel = `SL -${(slPct * 100).toFixed(1)}%`;

    log(`[${stratLabel}] ${asset.coin} ${side.toUpperCase()} @ $${price} | TP ${tpPctLabel} | ${slPctLabel} | ${leverage}x | ${entryReason}`, "engine");

    let fillPrice = price;
    let filledSz = 0;

    if (config.apiSecret && config.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const isCross = !asset.isolatedOnly;
        await executor.setLeverage(asset.coin, leverage, isCross);
        const orderPrice = isBuy ? price * 1.01 : price * 0.99; // 1% slippage
        const roundedSize = parseFloat(formatHLSize(assetSize, asset.szDecimals));
        if (roundedSize <= 0) {
          log(`[${stratLabel}] SKIP ${asset.coin}: rounded size is 0`, "engine");
          return false;
        }

        const orderResult = await executor.placeOrder({
          coin: asset.coin, isBuy, sz: roundedSize,
          limitPx: parseFloat(formatHLPrice(orderPrice, asset.szDecimals)),
          orderType: { limit: { tif: "Ioc" } }, reduceOnly: false,
        });

        log(`[HL RAW] ${asset.coin} ${strategy} response: ${JSON.stringify(orderResult).slice(0, 500)}`, "engine");
        const status = orderResult?.response?.data?.statuses?.[0];
        const fillPx = status?.filled?.avgPx;
        const totalSz = status?.filled?.totalSz;
        const errorMsg = status?.error || orderResult?.response?.data?.error || (orderResult?.status !== "ok" ? JSON.stringify(orderResult) : undefined);

        if (errorMsg) {
          log(`[${stratLabel}] ORDER REJECTED: ${asset.coin} — ${errorMsg}`, "engine");
          await storage.createLog({ type: "order_error", message: `${stratLabel} REJECTED: ${asset.coin} ${side.toUpperCase()} — ${errorMsg}`, timestamp: new Date().toISOString() });
          return false;
        } else if (fillPx && parseFloat(totalSz) > 0) {
          fillPrice = parseFloat(fillPx);
          filledSz = parseFloat(totalSz);
          log(`[${stratLabel}] FILLED: ${asset.coin} ${side.toUpperCase()} sz=${totalSz} @ $${fillPx}`, "engine");
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
      // Paper mode — simulate fill at current price
      filledSz = parseFloat(formatHLSize(assetSize, asset.szDecimals));
      if (filledSz <= 0) return false;
    }

    if (filledSz <= 0) return false;

    // Recalculate TP and SL based on actual fill price
    const actualTP = isBuy ? fillPrice * (1 + tpPct) : fillPrice * (1 - tpPct);
    const actualSL = isBuy ? fillPrice * (1 - slPct) : fillPrice * (1 + slPct);
    const actualNotional = filledSz * fillPrice;

    const trade = await storage.createTrade({
      coin: asset.coin, side, entryPrice: fillPrice, size: Math.round(equityPct * 100), leverage,
      entryEquity: equity,
      notionalValue: actualNotional,
      rsiAtEntry: triggerRSI, rsi4h: 0, rsi1d: 0,
      ema10: 0, ema21: 0, ema50: 0,
      stopLoss: actualSL,
      takeProfit1: actualTP,
      takeProfit2: actualTP,
      tp1Hit: false,
      confluenceScore: 0,
      confluenceDetails: `${stratLabel}: ${entryReason} | 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`,
      riskRewardRatio: 1.0,
      status: "open",
      reason: `[${stratLabel}] ${asset.coin} ${side.toUpperCase()} | ${entryReason} | ${slPctLabel} | TP ${tpPctLabel} | ${leverage}x`,
      setupType: strategy,
      strategy,
      openedAt: new Date().toISOString(),
    });

    // Place SL + TP orders on HL immediately after fill
    if (config.apiSecret && config.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);

        // SL: stop-market trigger order
        const slTriggerPx = parseFloat(formatHLPrice(actualSL, asset.szDecimals));
        const slFillPx = parseFloat(formatHLPrice(isBuy ? actualSL * 0.98 : actualSL * 1.02, asset.szDecimals));
        await executor.placeOrder({
          coin: asset.coin, isBuy: !isBuy, sz: filledSz,
          limitPx: slFillPx,
          orderType: { trigger: { triggerPx: String(slTriggerPx), isMarket: true, tpsl: "sl" } },
          reduceOnly: true,
        });
        log(`[SL ORDER] ${asset.coin} SL placed @ $${slTriggerPx} (${slPctLabel})`, "engine");

        // TP: limit order (resting on the book)
        const tpLimitPx = parseFloat(formatHLPrice(actualTP, asset.szDecimals));
        await executor.placeOrder({
          coin: asset.coin, isBuy: !isBuy, sz: filledSz,
          limitPx: tpLimitPx,
          orderType: { limit: { tif: "Gtc" } },
          reduceOnly: true,
        });
        log(`[TP ORDER] ${asset.coin} TP placed @ $${tpLimitPx} (${tpPctLabel})`, "engine");
      } catch (orderErr) {
        log(`[SL/TP ORDER] FAILED ${asset.coin}: ${orderErr} — will monitor in checkExits`, "engine");
      }
    }

    await logDecision({
      tradeId: trade.id, coin: asset.coin, action: "entry", side, price: fillPrice,
      reasoning: `${stratLabel}: ${asset.coin} ${side.toUpperCase()} | ${entryReason} | SL $${actualSL.toFixed(2)} (${slPctLabel}) | TP $${actualTP.toFixed(2)} (${tpPctLabel}) | ${leverage}x | $${capitalForTrade.toFixed(0)} capital`,
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

  // ============ MAIN SCAN CYCLE ============

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

      // Equity split: $100 reserved for oil, rest split across up to 3 RSI slots
      // Each slot gets (equity - $100) / 3 of the equity
      const equityForBtcStrategies = Math.max(0, equity - OIL_FIXED_CAPITAL);
      const btcStrategyPct = equityForBtcStrategies > 0 ? (equityForBtcStrategies / 3) / equity : 0;

      log(`Scan #${this.scanCount} | AUM: $${equity.toLocaleString()} | v15.9 DUAL: RSI-26+SMC Core-4 + Oil News 5-min | RSI slot eq: $${(equityForBtcStrategies / 3).toFixed(0)} (×3 slots)`, "engine");

      // Fetch market data for all assets
      const mainData = await fetchMetaAndAssetCtxs("");
      const assetCtxMap: Record<string, any> = {};
      if (mainData && mainData.length >= 2) {
        const universe = mainData[0]?.universe || [];
        const ctxs = mainData[1] || [];
        for (let i = 0; i < universe.length; i++) {
          if (ctxs[i]) assetCtxMap[universe[i].name] = ctxs[i];
        }
      }

      // Open positions
      const openTrades = await storage.getOpenTrades();
      const breakoutOpen = openTrades.filter(t => t.strategy === "breakout" || t.strategy === "trendline");
      const obosOpen = openTrades.filter(t => t.strategy === "obos");

      const BREAKOUT_MAX_POSITIONS = 1;
      const OBOS_MAX_POSITIONS = 3; // v15.5: up to 3 concurrent positions across Core-4 assets

      let totalEntries = 0;

      // ================================================================
      // STRATEGY A: Breakout & Retest — DISABLED (v15.2)
      // Webhook signals are discarded. Historical trades still display.
      // ================================================================
      if (this.pendingWebhookSignal) {
        log(`[B&R] Strategy disabled (v15.2) — discarding ${this.pendingWebhookSignal.signal} signal`, "engine");
        this.pendingWebhookSignal = null;
      }

      // ================================================================
      // STRATEGY B: Overbought / Oversold — RSI-based
      // BTC only, LONG (RSI ≤ 15 on 5m OR 15m) + SHORT (RSI ≥ 88 on 5m OR 15m)
      // 50% equity, max leverage, SL -0.5%, TP +0.45%
      // BE: after +0.3% → move SL to +0.2% (profit zone)
      // ================================================================
      // v15.5: RSI-26 + SMC Core-4 — LONG only when 5m AND 15m RSI ≤ 26 AND support/demand within 0.3%
      {
        const RSI_OVERSOLD = 26;
        const RSI_RESET = 35;  // reset long cross state when RSI > 35 on both TFs (prevents re-entry same dip)

        for (const asset of ALLOWED_ASSETS) {
          const ctx = assetCtxMap[asset.coin];
          if (!ctx?.midPx || ctx.midPx === "None") continue;
          const price = parseFloat(ctx.midPx);
          if (isNaN(price) || price <= 0) continue;

          const volume24h = parseFloat(ctx.dayNtlVlm || "0");
          const funding = parseFloat(ctx.funding || "0");
          const openInterest = parseFloat(ctx.openInterest || "0");
          const prevDayPx = parseFloat(ctx.prevDayPx || String(price));
          const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;

          const [ohlcv5m, ohlcv15m] = await Promise.all([
            fetchCandlesOHLCV(asset.coin, "5m", 30),
            fetchCandlesOHLCV(asset.coin, "15m", 150), // v15.5: deeper history for SMC structure detection
          ]);

          const c5m = ohlcv5m.map(c => c.close);
          const c15m = ohlcv15m.map(c => c.close);

          if (c5m.length >= 15 || c15m.length >= 15) {
            // Intra-candle RSI — append current live price
            const rsi5m = c5m.length >= 15 ? calculateRSI([...c5m, price]) : 50;
            const rsi15m = c15m.length >= 15 ? calculateRSI([...c15m, price]) : 50;

            // v15.5: Dual-TF RSI condition
            const oversold = rsi5m <= RSI_OVERSOLD && rsi15m <= RSI_OVERSOLD;

            // v15.5: SMC support/demand zone confluence — only check when RSI is oversold (saves CPU)
            const support = oversold ? findNearbySupport(ohlcv15m, price, 0.3) : { found: false, type: null, price: 0, low: 0, distancePct: 0, details: "rsi not oversold" } as SupportResult;
            const confluence = oversold && support.found;

            let scanSignal: string = "neutral";
            let scanDetails = "";

            if (confluence) {
              scanSignal = "obos_confluence";
              scanDetails = `RSI-26+SMC: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)} | ${support.details}`;
            } else if (oversold) {
              scanSignal = "obos_oversold_no_sr";
              scanDetails = `RSI oversold but no S/R ≤0.3% | 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`;
            } else {
              scanDetails = `RSI-26: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)} | Need BOTH ≤${RSI_OVERSOLD} + S/R ≤0.3%`;
            }

            await storage.upsertMarketScan({
              coin: asset.coin, price, rsi5m, rsi15m, rsi: 50, rsi4h: 50, rsi1d: 50,
              ema10: 0, ema21: 0, ema50: 0,
              volume24h, change24h,
              signal: scanSignal,
              fundingRate: funding, openInterest,
              confluenceScore: oversold ? 10 : 0,
              confluenceDetails: scanDetails,
              riskRewardRatio: 0,
              timestamp: new Date().toISOString(),
            });

            // === LONG entry: BOTH 5m AND 15m RSI ≤ 26 AND support/demand within 0.3% ===
            const longCrossKey = `${asset.coin}_obos_long`;
            // Reset cross state when EITHER timeframe recovers above 35 (setup invalidated)
            if (!oversold && (rsi5m > RSI_RESET || rsi15m > RSI_RESET)) {
              if (this.obosCrossState.has(longCrossKey)) {
                this.obosCrossState.delete(longCrossKey);
                log(`[RSI-26+SMC] ${asset.coin} cross state reset — 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)} (either > ${RSI_RESET})`, "engine");
              }
            }

            const coinHasPosition = openTrades.some(t => t.coin === asset.coin);
            if (confluence && obosOpen.length < OBOS_MAX_POSITIONS && !coinHasPosition) {
              if (!this.obosCrossState.has(longCrossKey)) {
                const triggerRSI = Math.max(rsi5m, rsi15m); // higher of the two (both ≤ 26)
                const triggeredTF = "5m+15m";
                this.obosCrossState.set(longCrossKey, { price, timestamp: Date.now(), rsi: triggerRSI });

                const entryReason = `RSI-26+SMC LONG: ${asset.coin} ${triggeredTF}=${triggerRSI.toFixed(1)} ≤${RSI_OVERSOLD} + ${support.details}`;
                const entered = await this.executeEntry({
                  asset,
                  strategy: "obos",
                  side: "long",
                  equityPct: btcStrategyPct,
                  leverage: asset.maxLeverage,
                  tpPct: 0.005,          // v15.5: +0.50%
                  slPct: 0.0045,         // v15.5: -0.45%
                  rsi5m, rsi15m, triggerRSI, price, equity,
                  entryReason,
                  config,
                });

                if (entered) {
                  totalEntries++;
                  this.dailyTradeCount++;
                  // Increment in-scan slot counter so next iteration respects MAX_POSITIONS
                  obosOpen.push({ coin: asset.coin, strategy: "obos", side: "long" } as any);
                } else {
                  this.obosCrossState.delete(longCrossKey);
                }
              }
            }
          }
        }
      }

      // Log scan summary
      await storage.createLog({
        type: "scan",
        message: `Scan #${this.scanCount}: ${totalEntries} entries | AUM: $${equity.toLocaleString()} | v15.9 DUAL: RSI-26+SMC Core-4 + Oil News 5-min`,
        timestamp: new Date().toISOString(),
      });

      // CHECK EXITS
      await this.checkExits(equity);
      await this.takePnlSnapshot(equity);

    } catch (e) {
      const stack = e instanceof Error ? e.stack : String(e);
      log(`Scan error: ${stack}`, "engine");
      await storage.createLog({ type: "error", message: `Scan error: ${stack}`.slice(0, 500), timestamp: new Date().toISOString() }).catch(() => {});
    }
    this.isScanning = false;
    this.scheduleNextScan();
  }

  private async checkExits(equity?: number) {
    const config = await storage.getConfig();
    if (!config) return;
    let openTrades = await storage.getOpenTrades();
    const mids: Record<string, string> = (await fetchAllMids()) || {};
    // allMids doesn't include xyz DEX — fetch oil price separately if needed
    const hasOilTrade = openTrades.some(t => t.coin === OIL_ASSET.coin);
    if (hasOilTrade) {
      const oilPrice = await fetchXyzMidPrice(OIL_ASSET.coin);
      if (oilPrice > 0) mids[OIL_ASSET.coin] = String(oilPrice);
    }
    const currentEquity = equity || this.lastKnownEquity || 0;

    // ============================================================
    // READ ALL P&L DIRECTLY FROM HYPERLIQUID
    // ============================================================

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
          // 5-minute grace period
          const tradeAge = Date.now() - new Date(trade.openedAt || 0).getTime();
          if (tradeAge < 300_000) {
            log(`[SYNC] Skipping trade #${trade.id} ${trade.coin} — opened ${(tradeAge/1000).toFixed(0)}s ago (5m grace)`, "engine");
            this.syncMissCount.delete(trade.id);
            continue;
          }

          if (hlPosMap.has(trade.coin)) {
            if (this.syncMissCount.has(trade.id)) {
              log(`[SYNC] Trade #${trade.id} ${trade.coin} — position confirmed on HL (was at ${this.syncMissCount.get(trade.id)} misses, reset)`, "engine");
              this.syncMissCount.delete(trade.id);
            }
          } else {
            const misses = (this.syncMissCount.get(trade.id) || 0) + 1;
            this.syncMissCount.set(trade.id, misses);
            log(`[SYNC] Trade #${trade.id} ${trade.coin} — no HL position (miss ${misses}/3)`, "engine");

            if (misses < 3) continue;

            // 3 consecutive misses — position genuinely closed on HL
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
              log(`[SYNC] Trade #${trade.id} ${trade.coin} — HL fills P&L: gross=$${hlPnl.closedPnl.toFixed(4)} fee=$${hlPnl.totalFee.toFixed(4)} net=$${netPnl.toFixed(4)} exitPx=$${exitPrice.toFixed(2)}`, "engine");
            } else {
              exitPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
              const isLong = trade.side === "long";
              const pv = (trade as any).notionalValue || (syncEq * (trade.size / 100) * trade.leverage);
              const rm = isLong
                ? (exitPrice - trade.entryPrice) / trade.entryPrice
                : (trade.entryPrice - exitPrice) / trade.entryPrice;
              netPnl = pv * rm - pv * 0.00045 * 2;
              log(`[SYNC] Trade #${trade.id} ${trade.coin} — no HL fills found, estimated P&L: $${netPnl.toFixed(4)}`, "engine");
            }

            const pnlOfAum = syncEq > 0 ? (netPnl / syncEq) * 100 : 0;
            await storage.updateTrade(trade.id, {
              exitPrice, pnl: 0, pnlPct: pnlOfAum,
              hlPnlUsd: netPnl, hlCloseFee: closeFee,
              status: "closed", closeReason: `Position closed on HL (sync) | P&L: $${netPnl.toFixed(2)} (from HL)`,
              closedAt: new Date().toISOString(),
            });
            const syncStratLabel = trade.strategy === "oil_news" ? "OIL" : (trade.strategy === "breakout" || trade.strategy === "trendline" ? "B&R" : "OBOS");
            log(`[SYNC] Trade #${trade.id} ${trade.coin} ${trade.side} auto-closed [${syncStratLabel}] | HL P&L: $${netPnl.toFixed(2)}`, "engine");
            // Oil loss cooldown on sync close
            if (trade.strategy === "oil_news" && netPnl < 0) {
              this.oilLossCooldownUntil = Date.now() + OIL_LOSS_COOLDOWN_MS;
              log(`[OIL NEWS] Sync loss ($${netPnl.toFixed(2)}) — cooldown 1 hour`, "engine");
            }
            await storage.createLog({
              type: "trade_close",
              message: `[SYNC] Auto-closed [${syncStratLabel}] ${trade.coin} ${trade.side} #${trade.id} | HL P&L: $${netPnl.toFixed(2)} USDC`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Cleanup syncMissCount for trades no longer open
        for (const [tid] of this.syncMissCount) {
          if (!currentOpenIds.has(tid)) this.syncMissCount.delete(tid);
        }

        openTrades = await storage.getOpenTrades();
      } catch (e) {
        log(`[SYNC] Position sync error: ${e}`, "engine");
      }
    }

    // ============================================================
    // OPEN TRADE MONITORING: read unrealizedPnl from HL + check TP/SL/BE
    // ============================================================
    for (const trade of openTrades) {
      // v15.6: xyz DEX coins (oil) not in allMids — fetch separately
      let currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0 && trade.coin.includes(":")) {
        try { currentPrice = await fetchXyzMidPrice(trade.coin); } catch {}
      }
      if (currentPrice === 0) continue;
      const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin) || (trade.coin === OIL_ASSET.coin ? OIL_ASSET : null);
      const szd = ac?.szDecimals ?? 2;
      const eqForTrade = (trade as any).entryEquity || currentEquity;

      const isBreakout = trade.strategy === "breakout" || trade.strategy === "trendline";
      const isOilNews = trade.strategy === "oil_news";
      const stratLabel = isOilNews ? "OIL" : (isBreakout ? "B&R" : "OBOS");
      const isLong = trade.side === "long";

      // Read unrealizedPnl directly from HL position
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

      // v15.5: BE+ for RSI-26+SMC strategy — when price moves +0.30% (LONG only),
      // cancel existing SL and place new SL at entryPrice * 1.0015 (+0.15% profit lock).
      const isObos = trade.strategy === "obos";
      const priceMovePct = trade.entryPrice > 0
        ? (isLong ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100 : (trade.entryPrice - currentPrice) / trade.entryPrice * 100)
        : 0;
      const isBESL = this.beApplied.has(trade.id);

      if (isObos && isLong && !isBESL && priceMovePct >= 0.30 && config.apiSecret && config.walletAddress) {
        try {
          const executor = createExecutor(config.apiSecret, config.walletAddress);
          const newSL = trade.entryPrice * 1.0015; // +0.15% above entry
          // Cancel existing SL trigger orders for this coin
          const openOrders = await executor.getOpenOrders();
          const slOrders = openOrders.filter((o: any) => o.coin === trade.coin && o.triggerCondition !== undefined);
          for (const o of slOrders) {
            try { await executor.cancelOrder(o.coin, o.oid); } catch (ce) { log(`[BE] Cancel SL error: ${ce}`, "engine"); }
          }
          // Place new SL trigger at +0.15%
          const slTriggerPx = parseFloat(formatHLPrice(newSL, szd));
          const slFillPx = parseFloat(formatHLPrice(newSL * 0.98, szd));
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
            trade.stopLoss = newSL; // reflect in this iteration
            this.beApplied.add(trade.id);
            log(`[BE+] Trade #${trade.id} ${trade.coin} LONG | price moved +${priceMovePct.toFixed(2)}% → SL moved to $${displayPrice(newSL, szd)} (+0.15% profit lock)`, "engine");
            await storage.createLog({
              type: "system",
              message: `[BE+] ${trade.coin} LONG | +${priceMovePct.toFixed(2)}% → SL locked at +0.15% ($${displayPrice(newSL, szd)})`,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (beErr) { log(`[BE+] Error on trade #${trade.id}: ${beErr}`, "engine"); }
      }

      // v15.9: BE for Oil News strategy (LONG + SHORT) — when price moves +0.50% in favor,
      // cancel existing SL and place new SL at entry price (break-even, no profit lock).
      // priceMovePct is already direction-aware (positive = in favor).
      if (isOilNews && !isBESL && priceMovePct >= 0.50 && config.apiSecret && config.walletAddress) {
        try {
          const executor = createExecutor(config.apiSecret, config.walletAddress);
          const newSL = trade.entryPrice; // v15.9: pure BE
          const openOrders = await executor.getOpenOrders();
          const slOrders = openOrders.filter((o: any) => o.coin === trade.coin && o.triggerCondition !== undefined);
          for (const o of slOrders) {
            try { await executor.cancelOrder(o.coin, o.oid); } catch (ce) { log(`[BE] Cancel oil SL error: ${ce}`, "engine"); }
          }
          const slTriggerPx = parseFloat(formatHLPrice(newSL, szd));
          // Fill slippage: LONG sells so fill below trigger (*0.98); SHORT buys so fill above trigger (*1.02)
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
            log(`[BE OIL] Trade #${trade.id} ${trade.coin} ${sideLabel} | price moved +${priceMovePct.toFixed(2)}% in favor → SL moved to entry $${displayPrice(newSL, szd)} (break-even)`, "engine");
            await storage.createLog({
              type: "system",
              message: `[BE OIL] ${trade.coin} ${sideLabel} | +${priceMovePct.toFixed(2)}% in favor → SL moved to BE ($${displayPrice(newSL, szd)})`,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (beErr) { log(`[BE OIL] Error on trade #${trade.id}: ${beErr}`, "engine"); }
      }

      // Exit checks
      const tpPctFromEntry = trade.entryPrice > 0 && trade.takeProfit1 ? (Math.abs(trade.takeProfit1 - trade.entryPrice) / trade.entryPrice * 100).toFixed(2) : "?";
      const tpPctLabel = `TP +${tpPctFromEntry}%`;

      let shouldClose = false;
      let closeReason = "";

      // TP hit
      const tpHit = isLong
        ? currentPrice >= (trade.takeProfit1 || Infinity)
        : currentPrice <= (trade.takeProfit1 || 0);
      // SL hit
      const slActive = trade.stopLoss > 0;
      const slHit = slActive && (isLong ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss);

      const slPctFromEntry = trade.entryPrice > 0 ? (Math.abs(trade.stopLoss - trade.entryPrice) / trade.entryPrice * 100).toFixed(2) : "?";

      if (tpHit) {
        shouldClose = true;
        closeReason = `[${stratLabel}] ${tpPctLabel} @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
      } else if (slHit) {
        shouldClose = true;
        const slLabel = `SL -${slPctFromEntry}%`;
        closeReason = `[${stratLabel}] ${slLabel} hit @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
        log(`[SL HIT] Trade #${trade.id} ${trade.coin} ${trade.side.toUpperCase()} [${stratLabel}] | Price $${displayPrice(currentPrice, szd)} hit SL $${displayPrice(trade.stopLoss, szd)}`, "engine");
      }

      if (shouldClose) {
        this.beApplied.delete(trade.id);

        // Execute full close on Hyperliquid
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            // Cancel ALL open orders for this coin BEFORE closing
            try {
              const openOrders = await executor.getOpenOrders();
              const coinOrders = openOrders.filter((o: any) => o.coin === trade.coin);
              for (const order of coinOrders) {
                await executor.cancelOrder(order.coin, order.oid);
                log(`[SAFETY] Cancelled open order ${order.coin} oid=${order.oid}`, "engine");
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

          // After close, fetch actual P&L from HL fills
          await new Promise(r => setTimeout(r, 1500));
          try {
            const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
            const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
            const hlPnl = extractClosePnlFromFills(fills, trade.coin, trade.side as "long" | "short", tradeOpenTime);
            if (hlPnl) {
              pnlUsd = hlPnl.netPnl;
              const exitLabel = slHit ? (isBESL ? "SL @ BE+ +0.15%" : `SL -${slPctFromEntry}%`) : tpPctLabel;
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
          // Paper mode
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
          equity: currentEquity, leverage: trade.leverage, strategy: (trade.strategy as StrategyType) || "obos",
        });

        // Oil loss cooldown
        if (trade.strategy === "oil_news" && pnlUsd < 0) {
          this.oilLossCooldownUntil = Date.now() + OIL_LOSS_COOLDOWN_MS;
          log(`[OIL NEWS] Loss detected ($${pnlUsd.toFixed(2)}) — cooldown 1 hour until ${new Date(this.oilLossCooldownUntil).toISOString()}`, "engine");
        }

        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [${stratLabel}] ${trade.side.toUpperCase()} ${trade.coin} | HL P&L: $${pnlUsd.toFixed(2)} USDC | ${closeReason}`,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Update open trade with HL unrealized P&L
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

    const isBreakout = trade.strategy === "breakout" || trade.strategy === "trendline";
    const isOilNews = trade.strategy === "oil_news";
    const stratLabel = isOilNews ? "OIL" : (isBreakout ? "B&R" : "OBOS");
    const tradeStrategy = (trade.strategy as StrategyType) || "obos";
    const isLong = trade.side === "long";

    const mids: Record<string, string> = (await fetchAllMids()) || {};
    // Fetch xyz mid for oil if needed
    if (trade.coin === OIL_ASSET.coin) {
      const oilPx = await fetchXyzMidPrice(OIL_ASSET.coin);
      if (oilPx > 0) mids[OIL_ASSET.coin] = String(oilPx);
    }
    const currentPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
    const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin) || (trade.coin === OIL_ASSET.coin ? OIL_ASSET : null);
    const config = await storage.getConfig();

    this.beApplied.delete(tradeId);

    if (config?.apiSecret && config?.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        // Cancel all orders first
        try {
          const openOrders = await executor.getOpenOrders();
          const coinOrders = openOrders.filter((o: any) => o.coin === trade.coin);
          for (const order of coinOrders) {
            await executor.cancelOrder(order.coin, order.oid);
            log(`[FORCE_CLOSE] Cancelled order ${order.coin} oid=${order.oid}`, "engine");
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
            reasoning: `MANUAL CLOSE [${stratLabel}] | HL P&L: $${hlPnl.netPnl.toFixed(2)} (gross=$${hlPnl.closedPnl.toFixed(2)} fee=$${hlPnl.totalFee.toFixed(2)}) | ROI/AUM: ${pnlOfAum.toFixed(3)}%`,
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

    // Fallback: estimate P&L
    const FEE_RATE_MC = 0.00045;
    const eq = this.lastKnownEquity || 0;
    const eqForClose = (trade as any).entryEquity || eq;
    const posValue = (trade as any).notionalValue || (eqForClose * (trade.size / 100) * trade.leverage);
    const rawMove = isLong
      ? (currentPrice - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - currentPrice) / trade.entryPrice;
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

  // ============ WEBHOOK HANDLER (Breakout & Retest) ============

  async handleWebhookSignal(payload: { signal: string; price: string | number; ticker?: string; source?: string; strategy?: string }): Promise<{ accepted: boolean; reason: string }> {
    const signal = (payload.signal || "").toUpperCase();
    if (signal !== "LONG" && signal !== "SHORT") {
      return { accepted: false, reason: `Invalid signal: ${signal}. Expected LONG or SHORT.` };
    }

    const price = typeof payload.price === "string" ? parseFloat(payload.price) : payload.price;
    if (isNaN(price) || price <= 0) {
      return { accepted: false, reason: `Invalid price: ${payload.price}` };
    }

    // Extract coin from ticker (e.g. "BTCUSDT.P" -> "BTC", "ETHUSDT" -> "ETH")
    let coin = "BTC"; // default
    if (payload.ticker) {
      const t = String(payload.ticker).toUpperCase().replace(".P", "");
      if (t.startsWith("BTC")) coin = "BTC";
      else if (t.startsWith("ETH")) coin = "ETH";
      else if (t.startsWith("SOL")) coin = "SOL";
      else coin = t.replace(/USDT$/, "").replace(/USD$/, "");
    }

    // All webhooks go to Breakout & Retest strategy (no more "new" routing)
    const openTrades = await storage.getOpenTrades();
    const breakoutOpen = openTrades.filter(t => t.strategy === "breakout" || t.strategy === "trendline");
    if (breakoutOpen.length >= 1) {
      return { accepted: false, reason: `B&R already has ${breakoutOpen.length} open position(s)` };
    }

    this.pendingWebhookSignal = {
      signal: signal as "LONG" | "SHORT",
      price,
      time: Date.now(),
      source: String(payload.source || "tradingview"),
      coin,
    };

    log(`[WEBHOOK] Received ${signal} @ $${price.toFixed(1)} from ${payload.source || "tradingview"} — queued for B&R`, "engine");
    await storage.createLog({
      type: "system",
      message: `[WEBHOOK] ${signal} signal received @ $${price.toFixed(1)} from ${payload.source || "tradingview"} — B&R strategy`,
      timestamp: new Date().toISOString(),
    });

    return { accepted: true, reason: `${signal} signal queued for Breakout & Retest — will be processed on next scan cycle` };
  }

  async forceScan() { await this.runScanCycle(); }

  // ============ OIL NEWS SCAN CYCLE (every 5 min — v15.7) ============

  private async scheduleOilScan() {
    const config = await storage.getConfig();
    if (!config?.isRunning) return;
    // First oil scan after 30 seconds (let BTC strategies initialize first)
    const delay = this.oilScanCount === 0 ? 30_000 : OIL_SCAN_INTERVAL_MS;
    this.oilScanTimer = setTimeout(() => this.runOilScanCycle(), delay);
  }

  private async runOilScanCycle() {
    if (this.isOilScanning) return;
    this.isOilScanning = true;
    this.oilScanCount++;

    try {
      const config = await storage.getConfig();
      if (!config?.isRunning) { this.isOilScanning = false; return; }

      const pplxKey = process.env.PERPLEXITY_API_KEY || "";
      if (!pplxKey) {
        log(`[OIL NEWS] No PERPLEXITY_API_KEY set — skipping oil scan`, "engine");
        this.isOilScanning = false;
        this.scheduleOilScan();
        return;
      }

      const equity = await this.refreshEquity();
      const openTrades = await storage.getOpenTrades();
      const oilOpen = openTrades.filter(t => t.strategy === "oil_news");

      log(`[OIL NEWS] Scan #${this.oilScanCount} | AUM: $${equity.toFixed(0)} | Oil positions: ${oilOpen.length}/1`, "engine");

      // Skip if already in an oil position
      if (oilOpen.length >= 1) {
        log(`[OIL NEWS] Already have oil position — skipping sentiment check`, "engine");
        await storage.createLog({
          type: "scan",
          message: `[OIL NEWS] Scan #${this.oilScanCount}: skip (position open) | AUM: $${equity.toFixed(0)}`,
          timestamp: new Date().toISOString(),
        });
        this.isOilScanning = false;
        this.scheduleOilScan();
        return;
      }

      // Check cooldown after loss
      if (Date.now() < this.oilLossCooldownUntil) {
        const remainMin = ((this.oilLossCooldownUntil - Date.now()) / 60000).toFixed(1);
        log(`[OIL NEWS] Cooldown active — ${remainMin} min remaining`, "engine");
        await storage.createLog({
          type: "scan",
          message: `[OIL NEWS] Scan #${this.oilScanCount}: cooldown (${remainMin}m left) | AUM: $${equity.toFixed(0)}`,
          timestamp: new Date().toISOString(),
        });
        this.isOilScanning = false;
        this.scheduleOilScan();
        return;
      }

      // Check we have enough equity for oil
      if (equity < OIL_FIXED_CAPITAL + 20) {
        log(`[OIL NEWS] Equity $${equity.toFixed(0)} too low for $${OIL_FIXED_CAPITAL} oil allocation`, "engine");
        this.isOilScanning = false;
        this.scheduleOilScan();
        return;
      }

      // Fetch sentiment from Sonar
      const sentiment = await fetchOilSentiment(pplxKey);
      this.lastOilSentiment = sentiment;

      await storage.createLog({
        type: "system",
        message: `[OIL NEWS] Sonar: ${sentiment.direction.toUpperCase()} confidence=${sentiment.confidence}/10 | ${sentiment.reasoning.slice(0, 150)}`,
        timestamp: new Date().toISOString(),
      });

      // Check if signal is strong enough
      if (sentiment.direction === "skip" || sentiment.confidence < OIL_CONFIDENCE_THRESHOLD) {
        log(`[OIL NEWS] No trade — direction=${sentiment.direction} confidence=${sentiment.confidence} (need ≥${OIL_CONFIDENCE_THRESHOLD})`, "engine");
        await storage.createLog({
          type: "scan",
          message: `[OIL NEWS] Scan #${this.oilScanCount}: no trade (${sentiment.direction} conf=${sentiment.confidence}) | AUM: $${equity.toFixed(0)}`,
          timestamp: new Date().toISOString(),
        });
        this.isOilScanning = false;
        this.scheduleOilScan();
        return;
      }

      // Get current oil price
      const oilPrice = await fetchXyzMidPrice(OIL_ASSET.coin);
      if (oilPrice <= 0) {
        log(`[OIL NEWS] Cannot get oil price — skipping`, "engine");
        this.isOilScanning = false;
        this.scheduleOilScan();
        return;
      }

      // Execute oil trade
      const side = sentiment.direction as "long" | "short";
      const capitalPct = OIL_FIXED_CAPITAL / equity; // e.g. $100/$325 = 0.307

      const entryReason = `OIL NEWS: ${side.toUpperCase()} conf=${sentiment.confidence}/10 | ${sentiment.reasoning.slice(0, 80)}`;

      const entered = await this.executeEntry({
        asset: OIL_ASSET,
        strategy: "oil_news",
        side,
        equityPct: capitalPct,
        leverage: OIL_LEVERAGE,
        tpPct: OIL_TP_PCT,    // v15.9: +2%
        slPct: OIL_SL_PCT,    // -2%
        rsi5m: 50, rsi15m: 50, triggerRSI: 0,
        price: oilPrice,
        equity,
        entryReason,
        config,
      });

      if (entered) {
        this.dailyTradeCount++;
        log(`[OIL NEWS] Entered ${side.toUpperCase()} xyz:CL @ $${oilPrice.toFixed(2)} | confidence=${sentiment.confidence}`, "engine");
      } else {
        log(`[OIL NEWS] Entry failed for ${side.toUpperCase()} xyz:CL`, "engine");
        // Don't cooldown on entry failure — might be a temporary issue
      }

      await storage.createLog({
        type: "scan",
        message: `[OIL NEWS] Scan #${this.oilScanCount}: ${entered ? "ENTERED" : "FAILED"} ${side.toUpperCase()} xyz:CL @ $${oilPrice.toFixed(2)} conf=${sentiment.confidence} | AUM: $${equity.toFixed(0)}`,
        timestamp: new Date().toISOString(),
      });

    } catch (e) {
      const stack = e instanceof Error ? e.stack : String(e);
      log(`[OIL NEWS] Scan error: ${stack}`, "engine");
      await storage.createLog({ type: "error", message: `[OIL NEWS] Scan error: ${stack}`.slice(0, 500), timestamp: new Date().toISOString() }).catch(() => {});
    }

    this.isOilScanning = false;
    this.scheduleOilScan();
  }

  getLastKnownEquity(): number {
    return this.lastKnownEquity;
  }

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
    const activeTrades = resetTs
      ? allTrades.filter(t => t.openedAt >= resetTs)
      : allTrades;
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
      const isBreakout = t.strategy === "breakout" || t.strategy === "trendline";
      const isOilNews = t.strategy === "oil_news";
      const stratBadge = isOilNews ? "OIL" : (isBreakout ? "B&R" : "OBOS");
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)), stratBadge };
    });

    // Strategy A: B&R stats
    const brTrades = activeClosedTrades.filter(t => t.strategy === "breakout" || t.strategy === "trendline");
    const brWins = brTrades.filter(t => (t.hlPnlUsd ?? (t.pnlPct || 0)) > 0).length;
    const brWinRate = brTrades.length > 0 ? (brWins / brTrades.length) * 100 : 0;
    const brPnlUsd = brTrades.reduce((s, t) => s + (t.hlPnlUsd ?? (startEq * (t.pnlPct || 0) / 100)), 0);
    const brPnlOfAum = startEq > 0 ? (brPnlUsd / startEq) * 100 : 0;

    // Strategy B: OBOS stats
    const obosTrades = activeClosedTrades.filter(t => t.strategy === "obos");
    const obosWins = obosTrades.filter(t => (t.hlPnlUsd ?? (t.pnlPct || 0)) > 0).length;
    const obosWinRate = obosTrades.length > 0 ? (obosWins / obosTrades.length) * 100 : 0;
    const obosPnlUsd = obosTrades.reduce((s, t) => s + (t.hlPnlUsd ?? (startEq * (t.pnlPct || 0) / 100)), 0);
    const obosPnlOfAum = startEq > 0 ? (obosPnlUsd / startEq) * 100 : 0;

    // Strategy C: Oil News stats
    const oilTrades = activeClosedTrades.filter(t => t.strategy === "oil_news");
    const oilWins = oilTrades.filter(t => (t.hlPnlUsd ?? (t.pnlPct || 0)) > 0).length;
    const oilWinRate = oilTrades.length > 0 ? (oilWins / oilTrades.length) * 100 : 0;
    const oilPnlUsd = oilTrades.reduce((s, t) => s + (t.hlPnlUsd ?? (startEq * (t.pnlPct || 0) / 100)), 0);
    const oilPnlOfAum = startEq > 0 ? (oilPnlUsd / startEq) * 100 : 0;

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
      dailyTradeTarget: 20,
      equity: currentEquity.toFixed(2),
      startingEquity: startEq.toFixed(2),
      pnlResetTimestamp: this.pnlResetTimestamp || null,
      learningStats: stats,
      allowedAssets: [...ALLOWED_ASSETS.map(a => ({ coin: a.coin, name: a.displayName, category: a.category, maxLev: a.maxLeverage })), { coin: OIL_ASSET.coin, name: OIL_ASSET.displayName, category: OIL_ASSET.category, maxLev: OIL_ASSET.maxLeverage }],
      openTradesWithUsd,
      lastOilSentiment: this.lastOilSentiment,
      oilScanCount: this.oilScanCount,
      strategyStats: {
        breakout: {
          trades: brTrades.length,
          winRate: brWinRate.toFixed(1),
          openPositions: openTrades.filter(t => t.strategy === "breakout" || t.strategy === "trendline").length,
          pnlUsd: brPnlUsd.toFixed(4),
          pnlOfAum: brPnlOfAum.toFixed(3),
          status: "active",
          source: "TradingView webhook",
        },
        obos: {
          trades: obosTrades.length,
          winRate: obosWinRate.toFixed(1),
          openPositions: openTrades.filter(t => t.strategy === "obos").length,
          pnlUsd: obosPnlUsd.toFixed(4),
          pnlOfAum: obosPnlOfAum.toFixed(3),
          status: "active",
          direction: "LONG only",
          riskReward: "SL -0.45% / TP +0.50% | BE+ at +0.30% → SL +0.15%",
          assets: "Core-4 (BTC/ETH/SOL/XRP)",
          entryConditions: "5m+15m RSI≤26 AND support/demand ≤0.3%",
          maxPositions: 3,
        },
        oil_news: {
          trades: oilTrades.length,
          winRate: oilWinRate.toFixed(1),
          openPositions: openTrades.filter(t => t.strategy === "oil_news").length,
          pnlUsd: oilPnlUsd.toFixed(4),
          pnlOfAum: oilPnlOfAum.toFixed(3),
          status: "active",
          asset: "xyz:CL (WTI)",
          allocation: `$${OIL_FIXED_CAPITAL} fixed`,
          riskReward: "SL -2% / TP +2% | BE at +0.5% → SL = entry",
        },
      },
    };
  }
}

export const tradingEngine = new TradingEngine();
export { ALLOWED_ASSETS, OIL_ASSET };
