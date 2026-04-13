/**
 * HyperTrader — Elite Trading Engine v4 (AUM-Adaptive + Self-Learning)
 * 
 * Multi-asset strategy across crypto + HIP-3 commodities/forex/indices.
 * Always uses MAX AVAILABLE LEVERAGE per asset.
 * 
 * Self-improvement loop:
 *   1. Every entry, skip, and exit decision is logged with full context + reasoning
 *   2. After trades close, the learning engine reviews outcomes
 *   3. Statistical patterns are built: asset/session/confluence/exit performance
 *   4. Active insights are checked before every new trade
 *   5. Bad patterns are automatically avoided, good patterns prioritized
 * 
 * AUM-Adaptive: works from $50 to $10M+ with dynamic position sizing.
 * Leverage: ALWAYS max available per asset (BTC 40x, ETH 25x, SP500 50x, etc.)
 */

import { storage } from "./storage";
import { log } from "./index";
import { createExecutor } from "./hyperliquid-executor";
import { logDecision, reviewClosedTrades, generateInsights, checkInsights, getLearningStats } from "./learning-engine";

// ============ ASSET CONFIGURATION ============

interface AssetConfig {
  coin: string;
  displayName: string;
  dex: string;
  maxLeverage: number;     // ALWAYS used — no scaling down
  szDecimals: number;
  pricePrecision: number;
  category: "crypto" | "commodity" | "forex" | "index";
  minNotional: number;
}

const ALLOWED_ASSETS: AssetConfig[] = [
  { coin: "BTC",           displayName: "Bitcoin",     dex: "",    maxLeverage: 40, szDecimals: 5, pricePrecision: 1, category: "crypto",    minNotional: 10 },
  { coin: "ETH",           displayName: "Ethereum",    dex: "",    maxLeverage: 25, szDecimals: 4, pricePrecision: 2, category: "crypto",    minNotional: 10 },
  { coin: "SOL",           displayName: "Solana",      dex: "",    maxLeverage: 20, szDecimals: 2, pricePrecision: 3, category: "crypto",    minNotional: 10 },
  { coin: "xyz:GOLD",      displayName: "Gold",        dex: "xyz", maxLeverage: 25, szDecimals: 4, pricePrecision: 2, category: "commodity", minNotional: 10 },
  { coin: "xyz:SILVER",    displayName: "Silver",      dex: "xyz", maxLeverage: 25, szDecimals: 2, pricePrecision: 3, category: "commodity", minNotional: 10 },
  { coin: "xyz:CL",        displayName: "Oil (WTI)",   dex: "xyz", maxLeverage: 20, szDecimals: 3, pricePrecision: 3, category: "commodity", minNotional: 10 },
  { coin: "xyz:BRENTOIL",  displayName: "Oil (Brent)", dex: "xyz", maxLeverage: 20, szDecimals: 2, pricePrecision: 3, category: "commodity", minNotional: 10 },
  { coin: "xyz:SP500",     displayName: "S&P 500",     dex: "xyz", maxLeverage: 50, szDecimals: 3, pricePrecision: 2, category: "index",     minNotional: 10 },
  { coin: "xyz:EUR",       displayName: "EUR/USD",     dex: "xyz", maxLeverage: 50, szDecimals: 1, pricePrecision: 5, category: "forex",     minNotional: 10 },
];

// ============ AUM-ADAPTIVE SIZING (max leverage always) ============

function calculateAdaptivePosition(params: {
  equity: number;
  price: number;
  asset: AssetConfig;
  config: any;
}): {
  capitalForTrade: number;
  leverage: number;
  notionalSize: number;
  assetSize: number;
  canTrade: boolean;
  skipReason: string;
} {
  const { equity, price, asset, config } = params;
  
  // ALWAYS max leverage for the asset
  const leverage = asset.maxLeverage;
  
  const baseTradeAmountPct = config.tradeAmountPct || 10;
  let capitalForTrade = equity * (baseTradeAmountPct / 100);
  
  // Enforce minimum viable trade size
  const minCapital = Math.max(5, asset.minNotional / leverage);
  if (capitalForTrade < minCapital) {
    capitalForTrade = Math.min(minCapital, equity * 0.5);
  }
  
  // Never risk more than 50% of total equity in a single position's margin
  if (capitalForTrade > equity * 0.5) {
    capitalForTrade = equity * 0.5;
  }
  
  const notionalSize = capitalForTrade * leverage;
  const assetSize = notionalSize / price;
  const roundedSize = parseFloat(assetSize.toFixed(asset.szDecimals));
  
  // Validate minimum notional
  const actualNotional = roundedSize * price;
  if (actualNotional < asset.minNotional) {
    return {
      capitalForTrade, leverage, notionalSize, assetSize: roundedSize,
      canTrade: false,
      skipReason: `Notional $${actualNotional.toFixed(2)} below min $${asset.minNotional}`,
    };
  }
  
  return {
    capitalForTrade, leverage, notionalSize, assetSize: roundedSize,
    canTrade: true, skipReason: "",
  };
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

function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema.push(sum / period);
  for (let i = period; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

function getLastEMA(closes: number[], period: number): number {
  const ema = calculateEMA(closes, period);
  return ema.length > 0 ? ema[ema.length - 1] : closes[closes.length - 1];
}

// ============ HYPERLIQUID API ============
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

async function fetchCandles(coin: string, interval: string = "1h", limit: number = 100): Promise<number[]> {
  try {
    const endTime = Date.now();
    let ms = 3600 * 1000;
    if (interval === "4h") ms = 4 * 3600 * 1000;
    else if (interval === "1d") ms = 24 * 3600 * 1000;
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime: endTime - limit * ms, endTime } }),
    });
    const candles: any[] = await res.json() as any;
    if (!Array.isArray(candles)) return [];
    return candles.map((c: any) => parseFloat(c.c));
  } catch (e) { log(`Candle error ${coin}: ${e}`, "engine"); return []; }
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
    // Query both perps and spot clearinghouse — unified account mode reports balance in spot
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
    
    // For unified accounts, inject spot balance into marginSummary
    if (spotEquity > perpsEquity) {
      perpsData.marginSummary = {
        ...perpsData.marginSummary,
        accountValue: spotEquity.toString(),
        totalRawUsd: spotEquity.toString(),
      };
    }
    return perpsData;
  } catch (e) { log(`UserState error: ${e}`, "engine"); return null; }
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

// ============ CONFLUENCE SCORING ============

interface ConfluenceResult {
  score: number;
  details: string[];
  signal: "long" | "short" | "neutral";
  suggestedEntry: number;
  suggestedSL: number;
  suggestedTP1: number;
  suggestedTP2: number;
  riskRewardRatio: number;
}

function calculateConfluence(params: {
  price: number; rsi1h: number; rsi4h: number; rsi1d: number;
  ema10: number; ema21: number; ema50: number;
  fundingRate: number; change24h: number; volume24h: number;
  config: any; category: string;
}): ConfluenceResult {
  const { price, rsi1h, rsi4h, rsi1d, ema10, ema21, ema50, fundingRate, change24h, volume24h, config } = params;
  let score = 0;
  const details: string[] = [];
  let signal: "long" | "short" | "neutral" = "neutral";
  
  const oversold = config.rsiOversoldThreshold || 20;
  const overbought = config.rsiOverboughtThreshold || 80;
  const slPct = config.stopLossPct || 0.35;
  const tp1Pct = config.takeProfitPct || 0.5;
  const tp2Pct = config.takeProfit2Pct || 1.0;
  
  if (rsi1h <= oversold) { signal = "long"; details.push(`1H RSI oversold: ${rsi1h.toFixed(1)}`); }
  else if (rsi1h >= overbought) { signal = "short"; details.push(`1H RSI overbought: ${rsi1h.toFixed(1)}`); }
  
  if (signal === "neutral") {
    return { score: 0, details: ["No RSI signal"], signal: "neutral", suggestedEntry: price, suggestedSL: price, suggestedTP1: price, suggestedTP2: price, riskRewardRatio: 0 };
  }
  
  // Multi-TF RSI alignment
  if (signal === "long") {
    if (rsi4h < 40) { score++; details.push(`4H RSI confirms: ${rsi4h.toFixed(1)}`); }
    if (rsi1d < 45) { score++; details.push(`1D RSI supports: ${rsi1d.toFixed(1)}`); }
  } else {
    if (rsi4h > 60) { score++; details.push(`4H RSI confirms: ${rsi4h.toFixed(1)}`); }
    if (rsi1d > 55) { score++; details.push(`1D RSI supports: ${rsi1d.toFixed(1)}`); }
  }
  
  // EMA alignment
  if (signal === "long" && price < ema21) { score++; details.push("Price below EMA21 (discount)"); }
  else if (signal === "short" && price > ema21) { score++; details.push("Price above EMA21 (premium)"); }
  
  // Funding
  if (signal === "long" && fundingRate < -0.0001) { score++; details.push(`Negative funding: ${(fundingRate * 100).toFixed(4)}%`); }
  else if (signal === "short" && fundingRate > 0.0001) { score++; details.push(`Positive funding: ${(fundingRate * 100).toFixed(4)}%`); }
  if (signal === "long" && fundingRate > 0.0005) { score--; details.push("WARNING: funding opposes long"); }
  else if (signal === "short" && fundingRate < -0.0005) { score--; details.push("WARNING: funding opposes short"); }
  
  // 24h momentum
  if (signal === "long" && change24h < -3) { score++; details.push(`24h drop ${change24h.toFixed(1)}%`); }
  else if (signal === "short" && change24h > 3) { score++; details.push(`24h pump ${change24h.toFixed(1)}%`); }
  if (signal === "long" && change24h < -15) { score--; details.push("WARNING: freefall"); }
  else if (signal === "short" && change24h > 15) { score--; details.push("WARNING: parabolic"); }
  
  // Volume
  if (volume24h > (config.minVolume24h || 1e6) * 2) { score++; details.push(`High volume: $${(volume24h / 1e6).toFixed(1)}M`); }
  
  // Price levels
  const slDist = price * (slPct / 100);
  const sl = signal === "long" ? price - slDist : price + slDist;
  const tp1 = signal === "long" ? price + price * (tp1Pct / 100) : price - price * (tp1Pct / 100);
  const tp2 = signal === "long" ? price + price * (tp2Pct / 100) : price - price * (tp2Pct / 100);
  const rr = slDist > 0 ? Math.abs(tp1 - price) / slDist : 0;
  
  return { score, details, signal, suggestedEntry: price, suggestedSL: sl, suggestedTP1: tp1, suggestedTP2: tp2, riskRewardRatio: rr };
}

// ============ TRADING ENGINE ============

class TradingEngine {
  private scanTimer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private dailyLoss = 0;
  private weeklyLoss = 0;
  private dailyLossUsd = 0;
  private weeklyLossUsd = 0;
  private dailyLossReset = "";
  private weeklyLossReset = "";
  private lastKnownEquity = 0;
  private startingEquity = 0;
  private scanCount = 0; // Track scans for periodic learning review

  async start() {
    const config = storage.getConfig();
    if (!config) return;
    this.resetLossTrackers();
    
    if (config.walletAddress) {
      const state = await fetchUserState(config.walletAddress);
      if (state?.marginSummary?.accountValue) {
        this.lastKnownEquity = parseFloat(state.marginSummary.accountValue);
        this.startingEquity = this.lastKnownEquity;
      }
    }

    const insights = storage.getActiveInsights();
    storage.createLog({
      type: "system",
      message: `Engine v4 started | ${ALLOWED_ASSETS.length} assets | AUM: $${this.lastKnownEquity.toLocaleString()} | MAX leverage per asset | ${insights.length} active learning insights`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v4 started — AUM: $${this.lastKnownEquity.toFixed(2)} | ${insights.length} learned insights`, "engine");
    this.scheduleNextScan();
  }

  stop() {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    storage.createLog({ type: "system", message: "Trading engine stopped", timestamp: new Date().toISOString() });
  }

  private resetLossTrackers() {
    const today = new Date().toISOString().split("T")[0];
    const ws = new Date(); ws.setDate(ws.getDate() - ws.getDay());
    const week = ws.toISOString().split("T")[0];
    if (this.dailyLossReset !== today) { this.dailyLoss = 0; this.dailyLossUsd = 0; this.dailyLossReset = today; }
    if (this.weeklyLossReset !== week) { this.weeklyLoss = 0; this.weeklyLossUsd = 0; this.weeklyLossReset = week; }
  }

  private scheduleNextScan() {
    const config = storage.getConfig();
    if (!config?.isRunning) return;
    this.scanTimer = setTimeout(() => this.runScanCycle(), (config.scanIntervalSecs || 60) * 1000);
  }

  private async refreshEquity(): Promise<number> {
    const config = storage.getConfig();
    if (!config?.walletAddress) return this.lastKnownEquity;
    try {
      const state = await fetchUserState(config.walletAddress);
      if (state?.marginSummary?.accountValue) {
        const val = parseFloat(state.marginSummary.accountValue);
        if (val > 0) {
          this.lastKnownEquity = val;
          if (this.startingEquity === 0) this.startingEquity = val;
        }
      }
    } catch { /* use last known */ }
    return this.lastKnownEquity;
  }

  async runScanCycle() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.scanCount++;

    try {
      const config = storage.getConfig();
      if (!config?.isRunning) { this.isScanning = false; return; }
      this.resetLossTrackers();
      const equity = await this.refreshEquity();

      // HARD GUARD: never trade with fake/zero equity — must read real AUM
      if (equity <= 0) {
        log(`Skipping scan — could not read real AUM (equity: $${equity})`, "engine");
        this.isScanning = false;
        this.scheduleNextScan();
        return;
      }

      // === PERIODIC LEARNING REVIEW (every 10 scans) ===
      if (this.scanCount % 10 === 0) {
        const reviewed = reviewClosedTrades();
        if (reviewed > 0) {
          generateInsights();
          const stats = getLearningStats();
          storage.createLog({
            type: "learning",
            message: `Learning review: ${stats.reviewedDecisions} decisions reviewed, ${stats.activeInsights} active insights, ${(stats.overallWinRate * 100).toFixed(0)}% overall win rate`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Circuit breakers
      const maxDailyLoss = config.maxDailyLossPct || 0.75;
      const maxWeeklyLoss = config.maxWeeklyLossPct || 1.5;
      if (this.dailyLoss >= maxDailyLoss) {
        logDecision({ coin: "ALL", action: "circuit_breaker", price: 0, reasoning: `Daily loss ${this.dailyLoss.toFixed(2)}% >= ${maxDailyLoss}% limit ($${this.dailyLossUsd.toFixed(2)}) — all entries paused`, equity });
        storage.createLog({ type: "circuit_breaker", message: `Daily loss limit: ${this.dailyLoss.toFixed(2)}% ($${this.dailyLossUsd.toFixed(2)})`, timestamp: new Date().toISOString() });
        this.isScanning = false; this.scheduleNextScan(); return;
      }
      if (this.weeklyLoss >= maxWeeklyLoss) {
        logDecision({ coin: "ALL", action: "circuit_breaker", price: 0, reasoning: `Weekly loss ${this.weeklyLoss.toFixed(2)}% >= ${maxWeeklyLoss}% limit — all entries paused`, equity });
        this.isScanning = false; this.scheduleNextScan(); return;
      }

      const sessionInfo = getSessionInfo();
      const useSessionFilter = config.useSessionFilter !== false;
      
      log(`Scan #${this.scanCount} — ${sessionInfo.description} | AUM: $${equity.toLocaleString()} | ${ALLOWED_ASSETS.length} assets`, "engine");

      // Fetch market data
      const [mainData, xyzData] = await Promise.all([fetchMetaAndAssetCtxs(""), fetchMetaAndAssetCtxs("xyz")]);
      const assetCtxMap: Record<string, any> = {};
      for (const [data, prefix] of [[mainData, ""], [xyzData, ""]] as any[]) {
        if (data && data.length >= 2) {
          const universe = data[0]?.universe || [];
          const ctxs = data[1] || [];
          for (let i = 0; i < universe.length; i++) {
            if (ctxs[i]) assetCtxMap[universe[i].name] = ctxs[i];
          }
        }
      }

      // Scan assets
      const signals: Array<{
        asset: AssetConfig; price: number; confluence: ConfluenceResult;
        volume24h: number; change24h: number; fundingRate: number; openInterest: number;
        rsi1h: number; rsi4h: number; rsi1d: number; ema10: number; ema21: number; ema50: number;
      }> = [];

      for (const asset of ALLOWED_ASSETS) {
        const ctx = assetCtxMap[asset.coin];
        if (!ctx?.midPx) continue;
        const price = parseFloat(ctx.midPx);
        const volume24h = parseFloat(ctx.dayNtlVlm || "0");
        const funding = parseFloat(ctx.funding || "0");
        const openInterest = parseFloat(ctx.openInterest || "0");
        const prevDayPx = parseFloat(ctx.prevDayPx || String(price));
        const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;

        if (volume24h < (config.minVolume24h || 1e6)) continue;

        const [c1h, c4h, c1d] = await Promise.all([
          fetchCandles(asset.coin, "1h", 60),
          fetchCandles(asset.coin, "4h", 60),
          fetchCandles(asset.coin, "1d", 30),
        ]);
        if (c1h.length < 20) continue;

        const rsi1h = calculateRSI(c1h);
        const rsi4h = c4h.length >= 15 ? calculateRSI(c4h) : 50;
        const rsi1d = c1d.length >= 15 ? calculateRSI(c1d) : 50;
        const ema10 = getLastEMA(c1h, 10);
        const ema21 = getLastEMA(c1h, 21);
        const ema50 = c1h.length >= 50 ? getLastEMA(c1h, 50) : ema21;

        const confluence = calculateConfluence({
          price, rsi1h, rsi4h, rsi1d, ema10, ema21, ema50,
          fundingRate: funding, change24h, volume24h, config, category: asset.category,
        });

        storage.upsertMarketScan({
          coin: asset.coin, price, rsi: rsi1h, rsi4h, rsi1d, ema10, ema21, ema50,
          volume24h, change24h,
          signal: confluence.signal === "neutral" ? "neutral" : confluence.signal === "long" ? "oversold_long" : "overbought_short",
          fundingRate: funding, openInterest,
          confluenceScore: confluence.score,
          confluenceDetails: confluence.details.join(" | "),
          riskRewardRatio: confluence.riskRewardRatio,
          timestamp: new Date().toISOString(),
        });

        if (confluence.signal !== "neutral" && confluence.score > 0) {
          signals.push({ asset, price, confluence, volume24h, change24h, fundingRate: funding, openInterest, rsi1h, rsi4h, rsi1d, ema10, ema21, ema50 });
        }
        await new Promise(r => setTimeout(r, 150));
      }

      signals.sort((a, b) => b.confluence.score - a.confluence.score);
      storage.createLog({
        type: "scan",
        message: `Scan: ${signals.length} signals | ${sessionInfo.session} | AUM: $${equity.toLocaleString()}`,
        data: JSON.stringify(signals.slice(0, 5).map(s => `${s.asset.displayName} RSI:${s.rsi1h.toFixed(0)} C:${s.confluence.score} ${s.confluence.signal}`)),
        timestamp: new Date().toISOString(),
      });

      // === EXECUTE TRADES ===
      const openTrades = storage.getOpenTrades();
      const openCoins = new Set(openTrades.map(t => t.coin));
      const maxPos = config.maxPositions || 5;
      const slotsAvailable = maxPos - openTrades.length;
      const minConfluence = config.minConfluenceScore || 4;
      const minRR = config.minRiskRewardRatio || 1.0;
      const now = new Date();

      if (slotsAvailable > 0 && signals.length > 0) {
        for (const sig of signals.slice(0, slotsAvailable)) {
          if (openCoins.has(sig.asset.coin)) continue;

          // Build full reasoning chain
          const reasoning: string[] = [];
          reasoning.push(`Signal: ${sig.confluence.signal.toUpperCase()} ${sig.asset.displayName}`);
          reasoning.push(`Confluence: ${sig.confluence.score}/7 (min: ${minConfluence})`);
          reasoning.push(`R:R: ${sig.confluence.riskRewardRatio.toFixed(2)} (min: ${minRR})`);
          reasoning.push(`RSI 1H:${sig.rsi1h.toFixed(1)} 4H:${sig.rsi4h.toFixed(1)} 1D:${sig.rsi1d.toFixed(1)}`);
          reasoning.push(`EMA10:${sig.ema10.toFixed(2)} EMA21:${sig.ema21.toFixed(2)} EMA50:${sig.ema50.toFixed(2)}`);
          reasoning.push(`Session: ${sessionInfo.session} | Funding: ${(sig.fundingRate * 100).toFixed(4)}%`);
          reasoning.push(`24h: ${sig.change24h.toFixed(2)}% | Vol: $${(sig.volume24h / 1e6).toFixed(1)}M`);
          reasoning.push(`Details: ${sig.confluence.details.join(", ")}`);

          // Confluence gate
          if (sig.confluence.score < minConfluence) {
            reasoning.push(`SKIP: Confluence ${sig.confluence.score} < min ${minConfluence}`);
            logDecision({
              coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price,
              rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
              ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
              volume24h: sig.volume24h, change24h: sig.change24h,
              fundingRate: sig.fundingRate, openInterest: sig.openInterest,
              confluenceScore: sig.confluence.score, confluenceDetails: sig.confluence.details.join(" | "),
              riskRewardRatio: sig.confluence.riskRewardRatio,
              reasoning: reasoning.join(" | "), equity,
            });
            continue;
          }

          // R:R gate
          if (sig.confluence.riskRewardRatio < minRR) {
            reasoning.push(`SKIP: R:R ${sig.confluence.riskRewardRatio.toFixed(2)} < min ${minRR}`);
            logDecision({
              coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price,
              rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
              confluenceScore: sig.confluence.score, riskRewardRatio: sig.confluence.riskRewardRatio,
              reasoning: reasoning.join(" | "), equity,
            });
            continue;
          }

          // Session filter
          if (useSessionFilter && !sessionInfo.isHighVolume && sig.asset.category !== "crypto") {
            reasoning.push(`SKIP: ${sig.asset.category} asset in low-volume ${sessionInfo.session} session`);
            logDecision({
              coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price,
              confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity,
            });
            continue;
          }

          // === CHECK LEARNING INSIGHTS ===
          const insightCheck = checkInsights({
            coin: sig.asset.coin,
            side: sig.confluence.signal,
            session: sessionInfo.session,
            confluenceScore: sig.confluence.score,
            dayOfWeek: now.getUTCDay(),
          });

          if (insightCheck.shouldBlock) {
            reasoning.push(`BLOCKED BY LEARNING: ${insightCheck.blockReason}`);
            logDecision({
              coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price,
              rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
              confluenceScore: sig.confluence.score, riskRewardRatio: sig.confluence.riskRewardRatio,
              reasoning: reasoning.join(" | "), equity,
            });
            storage.createLog({
              type: "learning",
              message: `BLOCKED: ${sig.asset.displayName} ${sig.confluence.signal} — ${insightCheck.blockReason}`,
              timestamp: new Date().toISOString(),
            });
            continue;
          }

          // Apply learning confidence adjustments
          const adjustedConfluence = sig.confluence.score + insightCheck.confidenceAdjustment;
          if (insightCheck.warnings.length > 0) reasoning.push(`LEARNED WARNINGS: ${insightCheck.warnings.join("; ")}`);
          if (insightCheck.boosts.length > 0) reasoning.push(`LEARNED BOOSTS: ${insightCheck.boosts.join("; ")}`);
          if (insightCheck.confidenceAdjustment !== 0) reasoning.push(`Confidence adjusted: ${sig.confluence.score} → ${adjustedConfluence}`);

          // Re-check adjusted confluence
          if (adjustedConfluence < minConfluence) {
            reasoning.push(`SKIP: Adjusted confluence ${adjustedConfluence} < min ${minConfluence} (learning penalized)`);
            logDecision({
              coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price,
              confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity,
            });
            continue;
          }

          // === AUM-ADAPTIVE POSITION SIZING (max leverage always) ===
          const pos = calculateAdaptivePosition({ equity, price: sig.price, asset: sig.asset, config });
          if (!pos.canTrade) {
            reasoning.push(`SKIP: ${pos.skipReason}`);
            logDecision({
              coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price,
              confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity,
            });
            continue;
          }

          const { leverage, capitalForTrade, assetSize, notionalSize } = pos;
          const side = sig.confluence.signal;
          const { suggestedSL, suggestedTP1, suggestedTP2 } = sig.confluence;
          const tradeAmountPct = (capitalForTrade / equity) * 100;

          reasoning.push(`ENTRY: ${side.toUpperCase()} ${sig.asset.displayName} | ${leverage}x (MAX) | $${capitalForTrade.toFixed(2)} capital ($${notionalSize.toFixed(0)} notional)`);

          // === REAL ORDER EXECUTION ===
          if (config.apiSecret && config.walletAddress) {
            try {
              const executor = createExecutor(config.apiSecret, config.walletAddress);
              await executor.setLeverage(sig.asset.coin, leverage, true);
              const slippageMult = side === "long" ? 1.005 : 0.995;
              const orderPrice = sig.price * slippageMult;
              const roundedSize = parseFloat(assetSize.toFixed(sig.asset.szDecimals));
              await executor.placeOrder({
                coin: sig.asset.coin, isBuy: side === "long", sz: roundedSize,
                limitPx: parseFloat(orderPrice.toFixed(sig.asset.pricePrecision)),
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: false,
              });
              reasoning.push(`Order placed: sz=${roundedSize} @ $${orderPrice.toFixed(sig.asset.pricePrecision)}`);
            } catch (execErr) {
              reasoning.push(`ORDER FAILED: ${execErr}`);
              logDecision({
                coin: sig.asset.coin, action: "skip", side, price: sig.price,
                confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity,
              });
              continue;
            }
          }

          const trade = storage.createTrade({
            coin: sig.asset.coin, side, entryPrice: sig.price, size: tradeAmountPct, leverage,
            rsiAtEntry: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            stopLoss: suggestedSL, takeProfit1: suggestedTP1, takeProfit2: suggestedTP2, tp1Hit: false,
            confluenceScore: sig.confluence.score, confluenceDetails: sig.confluence.details.join(" | "),
            riskRewardRatio: sig.confluence.riskRewardRatio,
            status: "open",
            reason: `${side.toUpperCase()} | C:${sig.confluence.score}/7 | R:R ${sig.confluence.riskRewardRatio.toFixed(1)}:1 | ${leverage}x MAX | $${capitalForTrade.toFixed(0)}`,
            setupType: "rsi_reversion",
            openedAt: new Date().toISOString(),
          });

          // Log entry decision with full reasoning
          logDecision({
            tradeId: trade.id, coin: sig.asset.coin, action: "entry", side, price: sig.price,
            rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            volume24h: sig.volume24h, change24h: sig.change24h,
            fundingRate: sig.fundingRate, openInterest: sig.openInterest,
            confluenceScore: sig.confluence.score, confluenceDetails: sig.confluence.details.join(" | "),
            riskRewardRatio: sig.confluence.riskRewardRatio,
            reasoning: reasoning.join(" | "), equity, leverage, positionSizeUsd: capitalForTrade,
          });

          storage.createLog({
            type: "trade_open",
            message: `${side.toUpperCase()} ${sig.asset.displayName} @ $${sig.price.toFixed(sig.asset.pricePrecision)} | ${leverage}x MAX | C:${sig.confluence.score} | $${capitalForTrade.toFixed(0)} capital`,
            data: JSON.stringify(trade),
            timestamp: new Date().toISOString(),
          });

          openCoins.add(sig.asset.coin);
        }
      }

      await this.checkExits(equity);
      this.takePnlSnapshot(equity);

    } catch (e) {
      log(`Scan error: ${e}`, "engine");
      storage.createLog({ type: "error", message: `Scan error: ${e}`, timestamp: new Date().toISOString() });
    }
    this.isScanning = false;
    this.scheduleNextScan();
  }

  private async checkExits(equity?: number) {
    const config = storage.getConfig();
    if (!config) return;
    const openTrades = storage.getOpenTrades();
    const mids = await fetchAllMids();
    
    const xyzData = await fetchMetaAndAssetCtxs("xyz");
    if (xyzData && xyzData.length >= 2) {
      const universe = xyzData[0]?.universe || [];
      const ctxs = xyzData[1] || [];
      for (let i = 0; i < universe.length; i++) {
        if (ctxs[i]?.midPx) mids[universe[i].name] = ctxs[i].midPx;
      }
    }
    const currentEquity = equity || this.lastKnownEquity || 0;

    for (const trade of openTrades) {
      const currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0) continue;
      const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
      const pp = ac?.pricePrecision || 2;

      const pnlPct = trade.side === "long"
        ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;
      const leveragedPnl = pnlPct * trade.leverage;
      const tradeCapUsd = currentEquity * (trade.size / 100);
      const pnlUsd = tradeCapUsd * (leveragedPnl / 100);
      const currentPeak = Math.max(trade.peakPnlPct || 0, leveragedPnl);

      let shouldClose = false;
      let closeReason = "";
      let exitType = "";

      // SL
      if (trade.side === "long" && currentPrice <= (trade.stopLoss || 0)) { shouldClose = true; closeReason = `SL @ $${currentPrice.toFixed(pp)}`; exitType = "sl"; }
      if (trade.side === "short" && currentPrice >= (trade.stopLoss || Infinity)) { shouldClose = true; closeReason = `SL @ $${currentPrice.toFixed(pp)}`; exitType = "sl"; }

      // TP1
      if (!trade.tp1Hit && !shouldClose) {
        const tp1Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit1 || Infinity)) ||
                       (trade.side === "short" && currentPrice <= (trade.takeProfit1 || 0));
        if (tp1Hit) {
          storage.updateTrade(trade.id, { tp1Hit: true, stopLoss: trade.entryPrice, peakPnlPct: currentPeak, pnl: leveragedPnl, pnlPct: leveragedPnl });
          logDecision({
            tradeId: trade.id, coin: trade.coin, action: "tp1_hit", side: trade.side as any, price: currentPrice,
            reasoning: `TP1 hit @ $${currentPrice.toFixed(pp)} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | SL moved to breakeven $${trade.entryPrice.toFixed(pp)}`,
            equity: currentEquity, leverage: trade.leverage,
          });
          storage.createLog({ type: "trade_tp1", message: `TP1 HIT: ${trade.coin} @ $${currentPrice.toFixed(pp)} | SL → breakeven`, timestamp: new Date().toISOString() });
          continue;
        }
      }

      // TP2
      if (!shouldClose) {
        const tp2Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit2 || Infinity)) ||
                       (trade.side === "short" && currentPrice <= (trade.takeProfit2 || 0));
        if (tp2Hit) { shouldClose = true; closeReason = `TP2 @ $${currentPrice.toFixed(pp)} (+$${pnlUsd.toFixed(2)})`; exitType = "tp2"; }
      }

      // Trailing stop
      if (config.useTrailingStop && trade.tp1Hit && !shouldClose) {
        const trailingPct = config.trailingStopPct || 0.3;
        const drawdown = currentPeak - leveragedPnl;
        if (currentPeak > trailingPct * 2 && drawdown > trailingPct) {
          shouldClose = true;
          closeReason = `Trailing: peak ${currentPeak.toFixed(2)}% → ${leveragedPnl.toFixed(2)}%`;
          exitType = "trailing";
        }
      }

      // RSI recovery
      if (!shouldClose) {
        const closes = await fetchCandles(trade.coin, "1h", 25);
        if (closes.length >= 15) {
          const rsi = calculateRSI(closes);
          if (trade.side === "long" && (trade.rsiAtEntry || 50) < 30 && rsi > 55) {
            shouldClose = true; closeReason = `RSI recovered: ${(trade.rsiAtEntry || 0).toFixed(0)} → ${rsi.toFixed(0)}`; exitType = "rsi_recovery";
          }
          if (trade.side === "short" && (trade.rsiAtEntry || 50) > 70 && rsi < 45) {
            shouldClose = true; closeReason = `RSI recovered: ${(trade.rsiAtEntry || 0).toFixed(0)} → ${rsi.toFixed(0)}`; exitType = "rsi_recovery";
          }
        }
      }

      if (shouldClose) {
        if (leveragedPnl < 0) {
          this.dailyLoss += Math.abs(leveragedPnl); this.weeklyLoss += Math.abs(leveragedPnl);
          this.dailyLossUsd += Math.abs(pnlUsd); this.weeklyLossUsd += Math.abs(pnlUsd);
        }

        // Execute real close
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            const positions = await executor.getPositions();
            const pos = positions.find((p: any) => p.position?.coin === trade.coin);
            if (pos) {
              const sz = Math.abs(parseFloat(pos.position.szi || "0"));
              const slippage = trade.side === "long" ? 0.995 : 1.005;
              await executor.placeOrder({
                coin: trade.coin, isBuy: trade.side === "short", sz,
                limitPx: parseFloat((currentPrice * slippage).toFixed(pp)),
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
              });
            }
          } catch (e) { log(`Close error: ${e}`, "engine"); }
        }

        storage.updateTrade(trade.id, {
          exitPrice: currentPrice, pnl: leveragedPnl, pnlPct: leveragedPnl, peakPnlPct: currentPeak,
          status: "closed", closeReason, closedAt: new Date().toISOString(),
        });

        // Log exit decision
        logDecision({
          tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
          reasoning: `EXIT: ${closeReason} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | Held: ${trade.openedAt ? Math.round((Date.now() - new Date(trade.openedAt).getTime()) / 60000) : 0}min | Peak: ${currentPeak.toFixed(2)}%`,
          equity: currentEquity, leverage: trade.leverage,
        });

        storage.createLog({
          type: "trade_close",
          message: `CLOSED ${trade.side.toUpperCase()} ${trade.coin} | ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | ${closeReason}`,
          timestamp: new Date().toISOString(),
        });
      } else {
        storage.updateTrade(trade.id, { pnl: leveragedPnl, pnlPct: leveragedPnl, peakPnlPct: currentPeak });
      }
    }
  }

  private takePnlSnapshot(equity?: number) {
    const allTrades = storage.getAllTrades();
    const openTrades = storage.getOpenTrades();
    const currentEquity = equity || this.lastKnownEquity || 0;
    const closedPnl = allTrades.filter(t => t.status === "closed").reduce((s, t) => s + (t.pnl || 0), 0);
    const openPnl = openTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const totalPnl = closedPnl + openPnl;

    storage.createPnlSnapshot({
      totalEquity: currentEquity > 0 ? currentEquity : (this.startingEquity || 0) * (1 + totalPnl / 100),
      totalPnl, totalPnlPct: totalPnl, openPositions: openTrades.length,
      timestamp: new Date().toISOString(),
    });
  }

  async forceCloseTrade(tradeId: number) {
    const trade = storage.getTradeById(tradeId);
    if (!trade || trade.status !== "open") return null;
    const mids = await fetchAllMids();
    const xyzData = await fetchMetaAndAssetCtxs("xyz");
    if (xyzData && xyzData.length >= 2) {
      const universe = xyzData[0]?.universe || [];
      const ctxs = xyzData[1] || [];
      for (let i = 0; i < universe.length; i++) { if (ctxs[i]?.midPx) mids[universe[i].name] = ctxs[i].midPx; }
    }
    const currentPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
    const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
    const config = storage.getConfig();
    if (config?.apiSecret && config?.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const positions = await executor.getPositions();
        const pos = positions.find((p: any) => p.position?.coin === trade.coin);
        if (pos) {
          const sz = Math.abs(parseFloat(pos.position.szi || "0"));
          const slippage = trade.side === "long" ? 0.995 : 1.005;
          await executor.placeOrder({
            coin: trade.coin, isBuy: trade.side === "short", sz,
            limitPx: parseFloat((currentPrice * slippage).toFixed(ac?.pricePrecision || 2)),
            orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
          });
        }
      } catch (e) { log(`Close error: ${e}`, "engine"); }
    }
    const pnlPct = trade.side === "long"
      ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage
      : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100 * trade.leverage;
    const eq = this.lastKnownEquity || 0;
    const pnlUsd = (eq * (trade.size / 100)) * (pnlPct / 100);

    const updated = storage.updateTrade(trade.id, {
      exitPrice: currentPrice, pnl: pnlPct, pnlPct, status: "closed",
      closeReason: "Manual close", closedAt: new Date().toISOString(),
    });
    logDecision({
      tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
      reasoning: `MANUAL CLOSE | P&L: ${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`, equity: eq, leverage: trade.leverage,
    });
    storage.createLog({
      type: "trade_close",
      message: `Manual close ${trade.side.toUpperCase()} ${trade.coin} | ${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`,
      timestamp: new Date().toISOString(),
    });
    return updated;
  }

  async forceScan() { await this.runScanCycle(); }

  getStatus() {
    const config = storage.getConfig();
    const openTrades = storage.getOpenTrades();
    const allTrades = storage.getAllTrades();
    const closedTrades = allTrades.filter(t => t.status === "closed");
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const openPnl = openTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const winTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
    const winRate = closedTrades.length > 0 ? (winTrades.length / closedTrades.length) * 100 : 0;
    const si = getSessionInfo();
    const stats = getLearningStats();

    return {
      isRunning: config?.isRunning || false,
      openPositions: openTrades.length,
      totalTrades: allTrades.length,
      closedTrades: closedTrades.length,
      winRate: winRate.toFixed(1),
      totalPnl: totalPnl.toFixed(2),
      openPnl: openPnl.toFixed(2),
      combinedPnl: (totalPnl + openPnl).toFixed(2),
      session: si.session,
      sessionDescription: si.description,
      dailyLoss: this.dailyLoss.toFixed(2),
      weeklyLoss: this.weeklyLoss.toFixed(2),
      equity: (this.lastKnownEquity || 0).toFixed(2),
      // Learning stats
      learningStats: stats,
      allowedAssets: ALLOWED_ASSETS.map(a => ({ coin: a.coin, name: a.displayName, category: a.category, maxLev: a.maxLeverage })),
    };
  }
}

export const tradingEngine = new TradingEngine();
