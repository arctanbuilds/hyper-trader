/**
 * HyperTrader — Elite Trading Engine v5 (Dual Strategy + 24h Learning)
 * 
 * TWO INDEPENDENT STRATEGIES running in parallel:
 * 
 * 1. CONFLUENCE STRATEGY (original):
 *    - Multi-TF RSI + EMA + funding + volume confluence scoring (3/7+ to enter)
 *    - SL: 0.25%, TP1: 0.35%, TP2: 0.7%
 *    - Progressive SL ratcheting + quick profit at 3%+ leveraged P&L
 * 
 * 2. EXTREME RSI STRATEGY (multi-TF):
 *    - RSI < 10 on ANY timeframe → LONG
 *    - RSI > 80 on ANY timeframe → SHORT (user said <80 but meant >80 for short)
 *    - TP1: 0.3% of position, TP2: 1% of position
 *    - After TP1 hit → move SL to breakeven (entry price)
 *    - No confluence required — extreme RSI is the only trigger
 * 
 * Both strategies:
 *   - Share the same position limit pool (maxPositions total)
 *   - Have independent entry logic — one doesn't block the other
 *   - Have independent exit logic — different TP/SL rules per strategy
 *   - Both log full reasoning to the learning engine
 *   - Learning engine reviews ALL trades from BOTH strategies
 * 
 * 24h Learning Cycle:
 *   - Every 24 hours: deep review of all trades, pattern analysis,
 *     mistake identification, and insight generation
 *   - Continuous improvement stored in PostgreSQL forever
 */

import { storage } from "./storage";
import { log } from "./index";
import { createExecutor } from "./hyperliquid-executor";
import { logDecision, reviewClosedTrades, generateInsights, checkInsights, getLearningStats, run24hReview } from "./learning-engine";

// ============ ASSET CONFIGURATION ============

interface AssetConfig {
  coin: string;
  displayName: string;
  dex: string;
  maxLeverage: number;     // ALWAYS used — no scaling down
  szDecimals: number;
  category: "crypto" | "commodity" | "forex" | "index";
  minNotional: number;
  isolatedOnly?: boolean;  // Some HIP-3 assets only support isolated margin
}

const ALLOWED_ASSETS: AssetConfig[] = [
  { coin: "BTC",  displayName: "Bitcoin",  dex: "", maxLeverage: 40, szDecimals: 5, category: "crypto", minNotional: 10 },
  { coin: "ETH",  displayName: "Ethereum", dex: "", maxLeverage: 25, szDecimals: 4, category: "crypto", minNotional: 10 },
  { coin: "SOL",  displayName: "Solana",   dex: "", maxLeverage: 20, szDecimals: 2, category: "crypto", minNotional: 10 },
];

// ============ STRATEGY TYPES ============
type StrategyType = "confluence" | "extreme_rsi";

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
  const leverage = asset.maxLeverage;
  
  const baseTradeAmountPct = config.tradeAmountPct || 10;
  let capitalForTrade = equity * (baseTradeAmountPct / 100);
  
  const minCapital = Math.max(5, asset.minNotional / leverage);
  if (capitalForTrade < minCapital) {
    capitalForTrade = Math.min(minCapital, equity * 0.5);
  }
  
  if (capitalForTrade > equity * 0.5) {
    capitalForTrade = equity * 0.5;
  }
  
  const notionalSize = capitalForTrade * leverage;
  const assetSize = notionalSize / price;
  const roundedSize = parseFloat(formatHLSize(assetSize, asset.szDecimals));
  
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

const INTERVAL_MS: Record<string, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 3600 * 1000,
  "4h": 4 * 3600 * 1000,
  "1d": 24 * 3600 * 1000,
};

async function fetchCandles(coin: string, interval: string = "1h", limit: number = 100): Promise<number[]> {
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
    return candles.map((c: any) => parseFloat(c.c));
  } catch (e) { log(`Candle error ${coin}/${interval}: ${e}`, "engine"); return []; }
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

// ============ CONFLUENCE SCORING (Strategy 1) ============

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
  price: number;
  rsi1m: number; rsi5m: number; rsi15m: number; rsi1h: number; rsi4h: number; rsi1d: number;
  ema10: number; ema21: number; ema50: number;
  fundingRate: number; change24h: number; volume24h: number;
  config: any; category: string;
}): ConfluenceResult {
  const { price, rsi1m, rsi5m, rsi15m, rsi1h, rsi4h, rsi1d, ema10, ema21, ema50, fundingRate, change24h, volume24h, config } = params;
  let score = 0;
  const details: string[] = [];
  let signal: "long" | "short" | "neutral" = "neutral";
  
  const oversold = config.rsiOversoldThreshold || 35;
  const overbought = config.rsiOverboughtThreshold || 65;
  const slPct = config.stopLossPct || 0.25;
  const tp1Pct = config.takeProfitPct || 0.35;
  const tp2Pct = config.takeProfit2Pct || 0.7;

  const entryTFs = [
    { tf: "1m", rsi: rsi1m, weight: 1 },
    { tf: "5m", rsi: rsi5m, weight: 1.2 },
    { tf: "15m", rsi: rsi15m, weight: 1.5 },
    { tf: "1h", rsi: rsi1h, weight: 2 },
  ];

  const oversoldTFs = entryTFs.filter(t => t.rsi <= oversold);
  const overboughtTFs = entryTFs.filter(t => t.rsi >= overbought);
  const softOversoldTFs = entryTFs.filter(t => t.rsi > oversold && t.rsi <= oversold + 8);
  const softOverboughtTFs = entryTFs.filter(t => t.rsi < overbought && t.rsi >= overbought - 8);

  if (oversoldTFs.length > 0) {
    signal = "long";
    const tfStr = oversoldTFs.map(t => `${t.tf}:${t.rsi.toFixed(1)}`).join(", ");
    details.push(`RSI oversold on ${oversoldTFs.length} TF(s): ${tfStr}`);
    if (oversoldTFs.length >= 2) { score++; details.push(`Multi-TF oversold (${oversoldTFs.length}/4)`); }
    if (oversoldTFs.length >= 3) { score++; details.push(`Strong multi-TF oversold (${oversoldTFs.length}/4)`); }
  } else if (overboughtTFs.length > 0) {
    signal = "short";
    const tfStr = overboughtTFs.map(t => `${t.tf}:${t.rsi.toFixed(1)}`).join(", ");
    details.push(`RSI overbought on ${overboughtTFs.length} TF(s): ${tfStr}`);
    if (overboughtTFs.length >= 2) { score++; details.push(`Multi-TF overbought (${overboughtTFs.length}/4)`); }
    if (overboughtTFs.length >= 3) { score++; details.push(`Strong multi-TF overbought (${overboughtTFs.length}/4)`); }
  } else if (softOversoldTFs.length >= 3) {
    signal = "long";
    const tfStr = softOversoldTFs.map(t => `${t.tf}:${t.rsi.toFixed(1)}`).join(", ");
    details.push(`Soft oversold convergence (${softOversoldTFs.length} TFs leaning low): ${tfStr}`);
  } else if (softOverboughtTFs.length >= 3) {
    signal = "short";
    const tfStr = softOverboughtTFs.map(t => `${t.tf}:${t.rsi.toFixed(1)}`).join(", ");
    details.push(`Soft overbought convergence (${softOverboughtTFs.length} TFs leaning high): ${tfStr}`);
  }
  
  if (signal === "neutral") {
    return { score: 0, details: ["No RSI signal on any timeframe"], signal: "neutral", suggestedEntry: price, suggestedSL: price, suggestedTP1: price, suggestedTP2: price, riskRewardRatio: 0 };
  }
  
  if (signal === "long") {
    if (rsi4h < 45) { score++; details.push(`4H RSI confirms: ${rsi4h.toFixed(1)}`); }
    if (rsi1d < 50) { score++; details.push(`1D RSI supports: ${rsi1d.toFixed(1)}`); }
  } else {
    if (rsi4h > 55) { score++; details.push(`4H RSI confirms: ${rsi4h.toFixed(1)}`); }
    if (rsi1d > 50) { score++; details.push(`1D RSI supports: ${rsi1d.toFixed(1)}`); }
  }
  
  if (signal === "long" && price < ema21) { score++; details.push("Price below EMA21 (discount)"); }
  else if (signal === "short" && price > ema21) { score++; details.push("Price above EMA21 (premium)"); }
  
  if (signal === "long" && fundingRate < -0.0001) { score++; details.push(`Negative funding: ${(fundingRate * 100).toFixed(4)}%`); }
  else if (signal === "short" && fundingRate > 0.0001) { score++; details.push(`Positive funding: ${(fundingRate * 100).toFixed(4)}%`); }
  if (signal === "long" && fundingRate > 0.0005) { score--; details.push("WARNING: funding opposes long"); }
  else if (signal === "short" && fundingRate < -0.0005) { score--; details.push("WARNING: funding opposes short"); }
  
  if (signal === "long" && change24h < -3) { score++; details.push(`24h drop ${change24h.toFixed(1)}%`); }
  else if (signal === "short" && change24h > 3) { score++; details.push(`24h pump ${change24h.toFixed(1)}%`); }
  if (signal === "long" && change24h < -15) { score--; details.push("WARNING: freefall"); }
  else if (signal === "short" && change24h > 15) { score--; details.push("WARNING: parabolic"); }
  
  if (volume24h > (config.minVolume24h || 1e6) * 2) { score++; details.push(`High volume: $${(volume24h / 1e6).toFixed(1)}M`); }
  
  const slDist = price * (slPct / 100);
  const sl = signal === "long" ? price - slDist : price + slDist;
  const tp1 = signal === "long" ? price + price * (tp1Pct / 100) : price - price * (tp1Pct / 100);
  const tp2 = signal === "long" ? price + price * (tp2Pct / 100) : price - price * (tp2Pct / 100);
  const rr = slDist > 0 ? Math.abs(tp1 - price) / slDist : 0;
  
  return { score, details, signal, suggestedEntry: price, suggestedSL: sl, suggestedTP1: tp1, suggestedTP2: tp2, riskRewardRatio: rr };
}

// ============ EXTREME RSI DETECTION (Strategy 2) ============

interface ExtremeRsiResult {
  triggered: boolean;
  signal: "long" | "short" | "none";
  triggerTF: string;
  triggerRSI: number;
  allRSIs: { tf: string; rsi: number }[];
  suggestedSL: number;
  suggestedTP1: number;
  suggestedTP2: number;
}

function detectExtremeRSI(params: {
  price: number;
  rsi1m: number; rsi5m: number; rsi15m: number; rsi1h: number; rsi4h: number; rsi1d: number;
}): ExtremeRsiResult {
  const { price, rsi1m, rsi5m, rsi15m, rsi1h, rsi4h, rsi1d } = params;
  
  const allRSIs = [
    { tf: "1m", rsi: rsi1m },
    { tf: "5m", rsi: rsi5m },
    { tf: "15m", rsi: rsi15m },
    { tf: "1h", rsi: rsi1h },
    { tf: "4h", rsi: rsi4h },
    { tf: "1d", rsi: rsi1d },
  ];
  
  // Extreme RSI thresholds — these are HARD, no confluence needed
  const EXTREME_OVERSOLD = 10;  // RSI < 10 → LONG
  const EXTREME_OVERBOUGHT = 80; // RSI > 80 → SHORT
  
  // At least 2 of 3 short timeframes (1m, 5m, 15m) must be extreme
  const shortTFs = [
    { tf: "1m", rsi: rsi1m },
    { tf: "5m", rsi: rsi5m },
    { tf: "15m", rsi: rsi15m },
  ].filter(r => r.rsi > 0); // exclude missing data
  
  // Check for extreme oversold (LONG signal) — at least 2/3 must be < 10
  const oversoldTFs = shortTFs.filter(r => r.rsi < EXTREME_OVERSOLD);
  if (oversoldTFs.length >= 2) {
    const avgRsi = oversoldTFs.reduce((s, r) => s + r.rsi, 0) / oversoldTFs.length;
    const tfLabel = shortTFs.map(r => `${r.tf}(${r.rsi.toFixed(1)}${r.rsi < EXTREME_OVERSOLD ? '*' : ''})`).join('+');
    const sl = price * (1 - 0.0025);   // 0.25% below
    const tp1 = price * (1 + 0.003);   // 0.3% above
    const tp2 = price * (1 + 0.01);    // 1% above
    return { triggered: true, signal: "long", triggerTF: tfLabel, triggerRSI: avgRsi, allRSIs, suggestedSL: sl, suggestedTP1: tp1, suggestedTP2: tp2 };
  }
  
  // Check for extreme overbought (SHORT signal) — at least 2/3 must be > 80
  const overboughtTFs = shortTFs.filter(r => r.rsi > EXTREME_OVERBOUGHT);
  if (overboughtTFs.length >= 2) {
    const avgRsi = overboughtTFs.reduce((s, r) => s + r.rsi, 0) / overboughtTFs.length;
    const tfLabel = shortTFs.map(r => `${r.tf}(${r.rsi.toFixed(1)}${r.rsi > EXTREME_OVERBOUGHT ? '*' : ''})`).join('+');
    const sl = price * (1 + 0.0025);   // 0.25% above
    const tp1 = price * (1 - 0.003);   // 0.3% below
    const tp2 = price * (1 - 0.01);    // 1% below
    return { triggered: true, signal: "short", triggerTF: tfLabel, triggerRSI: avgRsi, allRSIs, suggestedSL: sl, suggestedTP1: tp1, suggestedTP2: tp2 };
  }
  
  return { triggered: false, signal: "none", triggerTF: "", triggerRSI: 0, allRSIs, suggestedSL: 0, suggestedTP1: 0, suggestedTP2: 0 };
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
  private scanCount = 0;
  private lastLearningReview = 0; // timestamp of last 24h review

  async start() {
    const config = await storage.getConfig();
    if (!config) return;
    this.resetLossTrackers();
    
    if (config.walletAddress) {
      const state = await fetchUserState(config.walletAddress);
      if (state?.marginSummary?.accountValue) {
        this.lastKnownEquity = parseFloat(state.marginSummary.accountValue);
        this.startingEquity = this.lastKnownEquity;
      }
    }

    // Restore last review time from DB
    const lastReviewTime = await storage.getLastReviewTime();
    if (lastReviewTime) {
      this.lastLearningReview = new Date(lastReviewTime).getTime();
    }

    const insights = await storage.getActiveInsights();
    await storage.createLog({
      type: "system",
      message: `Engine v5 started | DUAL STRATEGY | ${ALLOWED_ASSETS.length} assets | AUM: $${this.lastKnownEquity.toLocaleString()} | MAX leverage | ${insights.length} learned insights`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v5 started — DUAL STRATEGY — AUM: $${this.lastKnownEquity.toFixed(2)} | ${insights.length} learned insights`, "engine");
    this.scheduleNextScan();
  }

  async stop() {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    await storage.createLog({ type: "system", message: "Trading engine stopped", timestamp: new Date().toISOString() });
  }

  private resetLossTrackers() {
    const today = new Date().toISOString().split("T")[0];
    const ws = new Date(); ws.setDate(ws.getDate() - ws.getDay());
    const week = ws.toISOString().split("T")[0];
    if (this.dailyLossReset !== today) { this.dailyLoss = 0; this.dailyLossUsd = 0; this.dailyLossReset = today; }
    if (this.weeklyLossReset !== week) { this.weeklyLoss = 0; this.weeklyLossUsd = 0; this.weeklyLossReset = week; }
  }

  private async scheduleNextScan() {
    const config = await storage.getConfig();
    if (!config?.isRunning) return;
    this.scanTimer = setTimeout(() => this.runScanCycle(), (config.scanIntervalSecs || 30) * 1000);
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
      const config = await storage.getConfig();
      if (!config?.isRunning) { this.isScanning = false; return; }
      this.resetLossTrackers();
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

      // Circuit breakers
      const maxDailyLoss = config.maxDailyLossPct || 0.75;
      const maxWeeklyLoss = config.maxWeeklyLossPct || 1.5;
      if (this.dailyLoss >= maxDailyLoss) {
        await logDecision({ coin: "ALL", action: "circuit_breaker", price: 0, reasoning: `Daily loss ${this.dailyLoss.toFixed(2)}% >= ${maxDailyLoss}% limit ($${this.dailyLossUsd.toFixed(2)}) — all entries paused`, equity, strategy: "confluence" });
        await storage.createLog({ type: "circuit_breaker", message: `Daily loss limit: ${this.dailyLoss.toFixed(2)}% ($${this.dailyLossUsd.toFixed(2)})`, timestamp: new Date().toISOString() });
        this.isScanning = false; this.scheduleNextScan(); return;
      }
      if (this.weeklyLoss >= maxWeeklyLoss) {
        await logDecision({ coin: "ALL", action: "circuit_breaker", price: 0, reasoning: `Weekly loss ${this.weeklyLoss.toFixed(2)}% >= ${maxWeeklyLoss}% limit — all entries paused`, equity, strategy: "confluence" });
        this.isScanning = false; this.scheduleNextScan(); return;
      }

      const sessionInfo = getSessionInfo();
      const useSessionFilter = config.useSessionFilter !== false;
      
      log(`Scan #${this.scanCount} — ${sessionInfo.description} | AUM: $${equity.toLocaleString()} | ${ALLOWED_ASSETS.length} assets | DUAL STRATEGY`, "engine");

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

      // Open positions — shared pool
      const openTrades = await storage.getOpenTrades();
      const openCoins = new Set(openTrades.map(t => t.coin));
      // Track per-strategy per-coin: allow same coin with different strategies
      const openByCoinStrategy = new Set(openTrades.map(t => `${t.coin}_${t.strategy || "confluence"}`));
      const maxPos = config.maxPositions || 8;
      const slotsAvailable = maxPos - openTrades.length;

      // ======================================================================
      // SCAN EACH ASSET — run BOTH strategies independently
      // ======================================================================

      const confluenceSignals: Array<{
        asset: AssetConfig; price: number; confluence: ConfluenceResult;
        volume24h: number; change24h: number; fundingRate: number; openInterest: number;
        rsi1h: number; rsi4h: number; rsi1d: number; ema10: number; ema21: number; ema50: number;
      }> = [];

      const extremeRsiSignals: Array<{
        asset: AssetConfig; price: number; extreme: ExtremeRsiResult;
        volume24h: number; change24h: number; fundingRate: number; openInterest: number;
        rsi1h: number; rsi4h: number; rsi1d: number; ema10: number; ema21: number; ema50: number;
        rsi1m: number; rsi5m: number; rsi15m: number;
      }> = [];

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

        if (volume24h < (config.minVolume24h || 1e6)) continue;

        const [c1m, c5m, c15m, c1h, c4h, c1d] = await Promise.all([
          fetchCandles(asset.coin, "1m", 60),
          fetchCandles(asset.coin, "5m", 60),
          fetchCandles(asset.coin, "15m", 60),
          fetchCandles(asset.coin, "1h", 60),
          fetchCandles(asset.coin, "4h", 60),
          fetchCandles(asset.coin, "1d", 30),
        ]);
        if (c1m.length < 15 && c5m.length < 15 && c15m.length < 15 && c1h.length < 15) continue;

        const rsi1m = c1m.length >= 15 ? calculateRSI(c1m) : 50;
        const rsi5m = c5m.length >= 15 ? calculateRSI(c5m) : 50;
        const rsi15m = c15m.length >= 15 ? calculateRSI(c15m) : 50;
        const rsi1h = c1h.length >= 15 ? calculateRSI(c1h) : 50;
        const rsi4h = c4h.length >= 15 ? calculateRSI(c4h) : 50;
        const rsi1d = c1d.length >= 15 ? calculateRSI(c1d) : 50;
        const emaSource = c15m.length >= 50 ? c15m : c1h;
        const ema10 = getLastEMA(emaSource, 10);
        const ema21 = getLastEMA(emaSource, 21);
        const ema50 = emaSource.length >= 50 ? getLastEMA(emaSource, 50) : ema21;

        // --- STRATEGY 1: CONFLUENCE ---
        const confluence = calculateConfluence({
          price, rsi1m, rsi5m, rsi15m, rsi1h, rsi4h, rsi1d, ema10, ema21, ema50,
          fundingRate: funding, change24h, volume24h, config, category: asset.category,
        });

        await storage.upsertMarketScan({
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
          confluenceSignals.push({ asset, price, confluence, volume24h, change24h, fundingRate: funding, openInterest, rsi1h, rsi4h, rsi1d, ema10, ema21, ema50 });
        }

        // --- STRATEGY 2: EXTREME RSI ---
        const extreme = detectExtremeRSI({ price, rsi1m, rsi5m, rsi15m, rsi1h, rsi4h, rsi1d });
        if (extreme.triggered) {
          extremeRsiSignals.push({ asset, price, extreme, volume24h, change24h, fundingRate: funding, openInterest, rsi1h, rsi4h, rsi1d, ema10, ema21, ema50, rsi1m, rsi5m, rsi15m });
        }

        await new Promise(r => setTimeout(r, 150));
      }

      // Log scan summary
      confluenceSignals.sort((a, b) => b.confluence.score - a.confluence.score);
      await storage.createLog({
        type: "scan",
        message: `Scan: ${confluenceSignals.length} confluence + ${extremeRsiSignals.length} extreme_rsi signals | ${sessionInfo.session} | AUM: $${equity.toLocaleString()}`,
        data: JSON.stringify([
          ...confluenceSignals.slice(0, 3).map(s => `[C] ${s.asset.coin} C:${s.confluence.score} ${s.confluence.signal}`),
          ...extremeRsiSignals.slice(0, 3).map(s => `[E] ${s.asset.coin} RSI:${s.extreme.triggerRSI.toFixed(1)} ${s.extreme.signal} @${s.extreme.triggerTF}`),
        ]),
        timestamp: new Date().toISOString(),
      });

      let slotsUsed = 0;
      const minConfluence = config.minConfluenceScore || 3;
      const minRR = config.minRiskRewardRatio || 0.8;
      const now = new Date();

      // =============================================
      // EXECUTE STRATEGY 1: CONFLUENCE ENTRIES
      // =============================================
      if (slotsAvailable > slotsUsed && confluenceSignals.length > 0) {
        for (const sig of confluenceSignals.slice(0, slotsAvailable - slotsUsed)) {
          if (openByCoinStrategy.has(`${sig.asset.coin}_confluence`)) continue;

          const reasoning: string[] = [];
          reasoning.push(`[CONFLUENCE] Signal: ${sig.confluence.signal.toUpperCase()} ${sig.asset.displayName}`);
          reasoning.push(`Confluence: ${sig.confluence.score}/7 (min: ${minConfluence})`);
          reasoning.push(`R:R: ${sig.confluence.riskRewardRatio.toFixed(2)} (min: ${minRR})`);
          reasoning.push(`RSI 1H:${sig.rsi1h.toFixed(1)} 4H:${sig.rsi4h.toFixed(1)} 1D:${sig.rsi1d.toFixed(1)}`);
          reasoning.push(`EMA10:${sig.ema10.toFixed(2)} EMA21:${sig.ema21.toFixed(2)} EMA50:${sig.ema50.toFixed(2)}`);
          reasoning.push(`Session: ${sessionInfo.session} | Funding: ${(sig.fundingRate * 100).toFixed(4)}%`);
          reasoning.push(`24h: ${sig.change24h.toFixed(2)}% | Vol: $${(sig.volume24h / 1e6).toFixed(1)}M`);
          reasoning.push(`Details: ${sig.confluence.details.join(", ")}`);

          if (sig.confluence.score < minConfluence) {
            reasoning.push(`SKIP: Confluence ${sig.confluence.score} < min ${minConfluence}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price, rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d, ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50, volume24h: sig.volume24h, change24h: sig.change24h, fundingRate: sig.fundingRate, openInterest: sig.openInterest, confluenceScore: sig.confluence.score, confluenceDetails: sig.confluence.details.join(" | "), riskRewardRatio: sig.confluence.riskRewardRatio, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
            continue;
          }

          if (sig.confluence.riskRewardRatio < minRR) {
            reasoning.push(`SKIP: R:R ${sig.confluence.riskRewardRatio.toFixed(2)} < min ${minRR}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price, rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d, confluenceScore: sig.confluence.score, riskRewardRatio: sig.confluence.riskRewardRatio, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
            continue;
          }

          if (useSessionFilter && !sessionInfo.isHighVolume && sig.asset.category !== "crypto") {
            reasoning.push(`SKIP: ${sig.asset.category} asset in low-volume ${sessionInfo.session} session`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price, confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
            continue;
          }

          // Check learning insights
          const insightCheck = await checkInsights({ coin: sig.asset.coin, side: sig.confluence.signal, session: sessionInfo.session, confluenceScore: sig.confluence.score, dayOfWeek: now.getUTCDay() });
          if (insightCheck.shouldBlock) {
            reasoning.push(`BLOCKED BY LEARNING: ${insightCheck.blockReason}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price, rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d, confluenceScore: sig.confluence.score, riskRewardRatio: sig.confluence.riskRewardRatio, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
            continue;
          }

          const adjustedConfluence = sig.confluence.score + insightCheck.confidenceAdjustment;
          if (insightCheck.warnings.length > 0) reasoning.push(`LEARNED WARNINGS: ${insightCheck.warnings.join("; ")}`);
          if (insightCheck.boosts.length > 0) reasoning.push(`LEARNED BOOSTS: ${insightCheck.boosts.join("; ")}`);
          if (insightCheck.confidenceAdjustment !== 0) reasoning.push(`Confidence adjusted: ${sig.confluence.score} → ${adjustedConfluence}`);

          if (adjustedConfluence < minConfluence) {
            reasoning.push(`SKIP: Adjusted confluence ${adjustedConfluence} < min ${minConfluence}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price, confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
            continue;
          }

          // Position sizing
          const pos = calculateAdaptivePosition({ equity, price: sig.price, asset: sig.asset, config });
          if (!pos.canTrade) {
            reasoning.push(`SKIP: ${pos.skipReason}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side: sig.confluence.signal, price: sig.price, confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
            continue;
          }

          const { leverage, capitalForTrade, assetSize, notionalSize } = pos;
          const side = sig.confluence.signal;
          const { suggestedSL, suggestedTP1, suggestedTP2 } = sig.confluence;
          const tradeAmountPct = (capitalForTrade / equity) * 100;

          reasoning.push(`ENTRY: ${side.toUpperCase()} ${sig.asset.displayName} | ${leverage}x (MAX) | $${capitalForTrade.toFixed(2)} capital ($${notionalSize.toFixed(0)} notional)`);

          // Execute order
          if (config.apiSecret && config.walletAddress) {
            try {
              const executor = createExecutor(config.apiSecret, config.walletAddress);
              const isCross = !sig.asset.isolatedOnly;
              await executor.setLeverage(sig.asset.coin, leverage, isCross);
              const slippageMult = side === "long" ? 1.01 : 0.99;
              const orderPrice = sig.price * slippageMult;
              const roundedSize = parseFloat(formatHLSize(assetSize, sig.asset.szDecimals));
              if (roundedSize <= 0) { reasoning.push(`SKIP: Rounded size is 0`); continue; }
              const orderResult = await executor.placeOrder({
                coin: sig.asset.coin, isBuy: side === "long", sz: roundedSize,
                limitPx: parseFloat(formatHLPrice(orderPrice, sig.asset.szDecimals)),
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: false,
              });
              
              log(`[HL RAW] ${sig.asset.coin} confluence response: ${JSON.stringify(orderResult).slice(0, 500)}`, "engine");
              const status = orderResult?.response?.data?.statuses?.[0];
              const fillPx = status?.filled?.avgPx;
              const totalSz = status?.filled?.totalSz;
              const errorMsg = status?.error || orderResult?.response?.data?.error || (orderResult?.status !== "ok" ? JSON.stringify(orderResult) : undefined);
              
              if (errorMsg) {
                reasoning.push(`ORDER REJECTED: ${errorMsg}`);
                await storage.createLog({ type: "order_error", message: `ORDER REJECTED: ${sig.asset.displayName} — ${errorMsg}`, timestamp: new Date().toISOString() });
                await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
                continue;
              }
              
              if (fillPx && parseFloat(totalSz) > 0) {
                reasoning.push(`FILLED: sz=${totalSz} @ $${fillPx}`);
                sig.price = parseFloat(fillPx);
              } else if (status?.resting) {
                reasoning.push(`Order resting (oid: ${status.resting.oid})`);
              } else {
                reasoning.push(`IOC NOT FILLED`);
                await storage.createLog({ type: "order_unfilled", message: `IOC NOT FILLED: [CONFLUENCE] ${sig.asset.displayName} ${side}`, timestamp: new Date().toISOString() });
                await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
                continue;
              }
            } catch (execErr) {
              reasoning.push(`ORDER FAILED: ${execErr}`);
              await storage.createLog({ type: "order_error", message: `ORDER FAILED: [CONFLUENCE] ${sig.asset.displayName} — ${execErr}`, timestamp: new Date().toISOString() });
              await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, confluenceScore: sig.confluence.score, reasoning: reasoning.join(" | "), equity, strategy: "confluence" });
              continue;
            }
          }

          const trade = await storage.createTrade({
            coin: sig.asset.coin, side, entryPrice: sig.price, size: tradeAmountPct, leverage,
            rsiAtEntry: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            stopLoss: suggestedSL, takeProfit1: suggestedTP1, takeProfit2: suggestedTP2, tp1Hit: false,
            confluenceScore: sig.confluence.score, confluenceDetails: sig.confluence.details.join(" | "),
            riskRewardRatio: sig.confluence.riskRewardRatio,
            status: "open",
            reason: `[CONFLUENCE] ${side.toUpperCase()} | C:${sig.confluence.score}/7 | R:R ${sig.confluence.riskRewardRatio.toFixed(1)}:1 | ${leverage}x MAX | $${capitalForTrade.toFixed(0)}`,
            setupType: "rsi_reversion",
            strategy: "confluence",
            openedAt: new Date().toISOString(),
          });

          await logDecision({
            tradeId: trade.id, coin: sig.asset.coin, action: "entry", side, price: sig.price,
            rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            volume24h: sig.volume24h, change24h: sig.change24h,
            fundingRate: sig.fundingRate, openInterest: sig.openInterest,
            confluenceScore: sig.confluence.score, confluenceDetails: sig.confluence.details.join(" | "),
            riskRewardRatio: sig.confluence.riskRewardRatio,
            reasoning: reasoning.join(" | "), equity, leverage, positionSizeUsd: capitalForTrade,
            strategy: "confluence",
          });

          await storage.createLog({
            type: "trade_open",
            message: `[CONFLUENCE] ${side.toUpperCase()} ${sig.asset.displayName} @ $${displayPrice(sig.price, sig.asset.szDecimals)} | ${leverage}x | C:${sig.confluence.score} | $${capitalForTrade.toFixed(0)}`,
            data: JSON.stringify(trade),
            timestamp: new Date().toISOString(),
          });

          openByCoinStrategy.add(`${sig.asset.coin}_confluence`);
          slotsUsed++;
        }
      }

      // =============================================
      // EXECUTE STRATEGY 2: EXTREME RSI ENTRIES
      // =============================================
      if (slotsAvailable > slotsUsed && extremeRsiSignals.length > 0) {
        for (const sig of extremeRsiSignals.slice(0, slotsAvailable - slotsUsed)) {
          if (sig.extreme.signal === "none") continue;
          if (openByCoinStrategy.has(`${sig.asset.coin}_extreme_rsi`)) continue;

          const side = sig.extreme.signal as "long" | "short";
          const reasoning: string[] = [];
          reasoning.push(`[EXTREME_RSI] Signal: ${side.toUpperCase()} ${sig.asset.displayName}`);
          reasoning.push(`TRIGGER: RSI ${sig.extreme.triggerRSI.toFixed(1)} on ${sig.extreme.triggerTF} (${side === "long" ? "<10 oversold" : ">80 overbought"})`);
          reasoning.push(`All RSIs: ${sig.extreme.allRSIs.map(r => `${r.tf}:${r.rsi.toFixed(1)}`).join(", ")}`);
          reasoning.push(`Price: $${displayPrice(sig.price, sig.asset.szDecimals)}`);
          reasoning.push(`TP1: 0.3% ($${displayPrice(sig.extreme.suggestedTP1, sig.asset.szDecimals)}) | TP2: 1% ($${displayPrice(sig.extreme.suggestedTP2, sig.asset.szDecimals)})`);
          reasoning.push(`SL: 0.25% ($${displayPrice(sig.extreme.suggestedSL, sig.asset.szDecimals)}) → moves to BE after TP1`);
          reasoning.push(`Session: ${sessionInfo.session} | Funding: ${(sig.fundingRate * 100).toFixed(4)}%`);

          // Check learning insights for extreme_rsi
          const insightCheck = await checkInsights({ coin: sig.asset.coin, side, session: sessionInfo.session, confluenceScore: 7, dayOfWeek: now.getUTCDay() });
          if (insightCheck.shouldBlock) {
            reasoning.push(`BLOCKED BY LEARNING: ${insightCheck.blockReason}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: "extreme_rsi" });
            continue;
          }

          // Position sizing
          const pos = calculateAdaptivePosition({ equity, price: sig.price, asset: sig.asset, config });
          if (!pos.canTrade) {
            reasoning.push(`SKIP: ${pos.skipReason}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: "extreme_rsi" });
            continue;
          }

          const { leverage, capitalForTrade, assetSize, notionalSize } = pos;
          const tradeAmountPct = (capitalForTrade / equity) * 100;
          reasoning.push(`ENTRY: ${side.toUpperCase()} ${sig.asset.displayName} | ${leverage}x (MAX) | $${capitalForTrade.toFixed(2)} capital ($${notionalSize.toFixed(0)} notional)`);

          // Execute order
          if (config.apiSecret && config.walletAddress) {
            try {
              const executor = createExecutor(config.apiSecret, config.walletAddress);
              const isCross = !sig.asset.isolatedOnly;
              await executor.setLeverage(sig.asset.coin, leverage, isCross);
              const slippageMult = side === "long" ? 1.01 : 0.99;
              const orderPrice = sig.price * slippageMult;
              const roundedSize = parseFloat(formatHLSize(assetSize, sig.asset.szDecimals));
              if (roundedSize <= 0) { reasoning.push(`SKIP: Rounded size is 0`); continue; }
              const orderResult = await executor.placeOrder({
                coin: sig.asset.coin, isBuy: side === "long", sz: roundedSize,
                limitPx: parseFloat(formatHLPrice(orderPrice, sig.asset.szDecimals)),
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: false,
              });

              log(`[HL RAW] ${sig.asset.coin} extreme_rsi response: ${JSON.stringify(orderResult).slice(0, 500)}`, "engine");
              const status = orderResult?.response?.data?.statuses?.[0];
              const fillPx = status?.filled?.avgPx;
              const totalSz = status?.filled?.totalSz;
              const errorMsg = status?.error || orderResult?.response?.data?.error || (orderResult?.status !== "ok" ? JSON.stringify(orderResult) : undefined);

              if (errorMsg) {
                reasoning.push(`ORDER REJECTED: ${errorMsg}`);
                await storage.createLog({ type: "order_error", message: `ORDER REJECTED: [EXTREME_RSI] ${sig.asset.displayName} — ${errorMsg}`, timestamp: new Date().toISOString() });
                await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: "extreme_rsi" });
                continue;
              }

              if (fillPx && parseFloat(totalSz) > 0) {
                reasoning.push(`FILLED: sz=${totalSz} @ $${fillPx}`);
                sig.price = parseFloat(fillPx);
              } else {
                reasoning.push(`IOC NOT FILLED`);
                await storage.createLog({ type: "order_unfilled", message: `IOC NOT FILLED: [EXTREME_RSI] ${sig.asset.displayName} ${side}`, timestamp: new Date().toISOString() });
                await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: "extreme_rsi" });
                continue;
              }
            } catch (execErr) {
              reasoning.push(`ORDER FAILED: ${execErr}`);
              await storage.createLog({ type: "order_error", message: `ORDER FAILED: [EXTREME_RSI] ${sig.asset.displayName} — ${execErr}`, timestamp: new Date().toISOString() });
              await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: "extreme_rsi" });
              continue;
            }
          }

          const trade = await storage.createTrade({
            coin: sig.asset.coin, side, entryPrice: sig.price, size: tradeAmountPct, leverage,
            rsiAtEntry: sig.extreme.triggerRSI, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            stopLoss: sig.extreme.suggestedSL,
            takeProfit1: sig.extreme.suggestedTP1,
            takeProfit2: sig.extreme.suggestedTP2,
            tp1Hit: false,
            confluenceScore: 0, // Not applicable for extreme RSI
            confluenceDetails: `EXTREME RSI: ${sig.extreme.triggerRSI.toFixed(1)} on ${sig.extreme.triggerTF}`,
            riskRewardRatio: 0,
            status: "open",
            reason: `[EXTREME_RSI] ${side.toUpperCase()} | RSI ${sig.extreme.triggerRSI.toFixed(1)} @${sig.extreme.triggerTF} | ${leverage}x MAX | $${capitalForTrade.toFixed(0)}`,
            setupType: "extreme_rsi",
            strategy: "extreme_rsi",
            openedAt: new Date().toISOString(),
          });

          await logDecision({
            tradeId: trade.id, coin: sig.asset.coin, action: "entry", side, price: sig.price,
            rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            volume24h: sig.volume24h, change24h: sig.change24h,
            fundingRate: sig.fundingRate, openInterest: sig.openInterest,
            reasoning: reasoning.join(" | "), equity, leverage, positionSizeUsd: capitalForTrade,
            strategy: "extreme_rsi",
          });

          await storage.createLog({
            type: "trade_open",
            message: `[EXTREME_RSI] ${side.toUpperCase()} ${sig.asset.displayName} @ $${displayPrice(sig.price, sig.asset.szDecimals)} | ${leverage}x | RSI ${sig.extreme.triggerRSI.toFixed(1)} @${sig.extreme.triggerTF} | $${capitalForTrade.toFixed(0)}`,
            data: JSON.stringify(trade),
            timestamp: new Date().toISOString(),
          });

          openByCoinStrategy.add(`${sig.asset.coin}_extreme_rsi`);
          slotsUsed++;
        }
      }

      // =============================================
      // CHECK EXITS — BOTH strategies, isolated logic
      // =============================================
      await this.checkExits(equity);
      await this.takePnlSnapshot(equity);

    } catch (e) {
      log(`Scan error: ${e}`, "engine");
      await storage.createLog({ type: "error", message: `Scan error: ${e}`, timestamp: new Date().toISOString() }).catch(() => {});
    }
    this.isScanning = false;
    this.scheduleNextScan();
  }

  private async checkExits(equity?: number) {
    const config = await storage.getConfig();
    if (!config) return;
    const openTrades = await storage.getOpenTrades();
    const mids = await fetchAllMids();
    
    const xyzData = await fetchMetaAndAssetCtxs("xyz");
    if (xyzData && xyzData.length >= 2) {
      const universe = xyzData[0]?.universe || [];
      const ctxs = xyzData[1] || [];
      for (let i = 0; i < universe.length; i++) {
        if (ctxs[i]?.midPx && ctxs[i].midPx !== "None") mids[universe[i].name] = ctxs[i].midPx;
      }
    }
    const currentEquity = equity || this.lastKnownEquity || 0;

    for (const trade of openTrades) {
      const currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0) continue;
      const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
      const szd = ac?.szDecimals ?? 2;
      const strategy: StrategyType = (trade.strategy as StrategyType) || "confluence";

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

      // ============================================================
      // STRATEGY-SPECIFIC EXIT LOGIC
      // ============================================================

      if (strategy === "extreme_rsi") {
        // ---- EXTREME RSI EXIT RULES ----
        // TP1: 0.3% from entry → move SL to breakeven
        // TP2: 1% from entry → full close
        // SL: original 0.25% or breakeven (after TP1)

        // TP1 check — move SL to breakeven
        if (!trade.tp1Hit) {
          const tp1Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit1 || Infinity)) ||
                         (trade.side === "short" && currentPrice <= (trade.takeProfit1 || 0));
          if (tp1Hit) {
            // Move SL to breakeven (entry price)
            const breakEvenSL = trade.entryPrice;
            await storage.updateTrade(trade.id, { tp1Hit: true, stopLoss: breakEvenSL, peakPnlPct: currentPeak, pnl: leveragedPnl, pnlPct: leveragedPnl });
            await logDecision({
              tradeId: trade.id, coin: trade.coin, action: "tp1_hit", side: trade.side as any, price: currentPrice,
              reasoning: `[EXTREME_RSI] TP1 hit @ $${displayPrice(currentPrice, szd)} (+0.3%) | SL moved to BREAKEVEN @ $${displayPrice(breakEvenSL, szd)} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)})`,
              equity: currentEquity, leverage: trade.leverage, strategy: "extreme_rsi",
            });
            await storage.createLog({
              type: "trade_tp1",
              message: `[EXTREME_RSI] TP1 HIT: ${trade.coin} @ $${displayPrice(currentPrice, szd)} | SL → BREAKEVEN`,
              timestamp: new Date().toISOString(),
            });
            // Don't close yet — let it ride to TP2 with BE protection
          }
        }

        // TP2 check — full close at 1%
        if (!shouldClose) {
          const tp2Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit2 || Infinity)) ||
                         (trade.side === "short" && currentPrice <= (trade.takeProfit2 || 0));
          if (tp2Hit) { shouldClose = true; closeReason = `[EXTREME_RSI] TP2 @ $${displayPrice(currentPrice, szd)} (+1%) | $${pnlUsd.toFixed(2)}`; exitType = "tp2"; }
        }

        // SL check (breakeven after TP1, or original SL before TP1)
        if (!shouldClose) {
          const activeSL = trade.stopLoss;
          if (trade.side === "long" && currentPrice <= (activeSL || 0)) { shouldClose = true; closeReason = `[EXTREME_RSI] SL @ $${displayPrice(currentPrice, szd)}${trade.tp1Hit ? " (breakeven)" : ""}`; exitType = trade.tp1Hit ? "sl_breakeven" : "sl"; }
          if (trade.side === "short" && currentPrice >= (activeSL || Infinity)) { shouldClose = true; closeReason = `[EXTREME_RSI] SL @ $${displayPrice(currentPrice, szd)}${trade.tp1Hit ? " (breakeven)" : ""}`; exitType = trade.tp1Hit ? "sl_breakeven" : "sl"; }
        }

      } else {
        // ---- CONFLUENCE EXIT RULES (original) ----
        
        // Progressive SL ratcheting
        const rawPnlPct = pnlPct;
        const slRatchetThreshold = 0.08;
        const slRatchetDistance = 0.06;

        if (rawPnlPct > slRatchetThreshold) {
          const peakRawPnl = currentPeak / trade.leverage;
          const lockPct = Math.max(0, peakRawPnl - slRatchetDistance);
          let newSL: number;
          if (trade.side === "long") { newSL = trade.entryPrice * (1 + lockPct / 100); }
          else { newSL = trade.entryPrice * (1 - lockPct / 100); }
          const currentSL = trade.stopLoss || (trade.side === "long" ? 0 : Infinity);
          const shouldUpdate = trade.side === "long" ? newSL > currentSL : newSL < currentSL;
          if (shouldUpdate) {
            const lockedProfit = lockPct * trade.leverage;
            await storage.updateTrade(trade.id, { stopLoss: newSL, tp1Hit: true, peakPnlPct: currentPeak, pnl: leveragedPnl, pnlPct: leveragedPnl });
            if (lockedProfit > 0.5) {
              await storage.createLog({ type: "trade_sl_ratchet", message: `[CONFLUENCE] SL RATCHET: ${trade.coin} SL → $${displayPrice(newSL, szd)} (locking ${lockedProfit.toFixed(1)}% profit)`, timestamp: new Date().toISOString() });
            }
          }
        }

        // SL check
        const activeSL = trade.stopLoss;
        if (trade.side === "long" && currentPrice <= (activeSL || 0)) { shouldClose = true; closeReason = `[CONFLUENCE] SL @ $${displayPrice(currentPrice, szd)}`; exitType = "sl"; }
        if (trade.side === "short" && currentPrice >= (activeSL || Infinity)) { shouldClose = true; closeReason = `[CONFLUENCE] SL @ $${displayPrice(currentPrice, szd)}`; exitType = "sl"; }

        // Quick profit-taking
        const quickProfitThreshold = 3.0;
        if (!shouldClose && leveragedPnl >= quickProfitThreshold) {
          shouldClose = true;
          closeReason = `[CONFLUENCE] QUICK PROFIT: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)})`;
          exitType = "quick_profit";
        }

        // TP1 — mark hit
        if (!trade.tp1Hit && !shouldClose) {
          const tp1Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit1 || Infinity)) ||
                         (trade.side === "short" && currentPrice <= (trade.takeProfit1 || 0));
          if (tp1Hit) {
            await storage.updateTrade(trade.id, { tp1Hit: true, peakPnlPct: currentPeak, pnl: leveragedPnl, pnlPct: leveragedPnl });
            await logDecision({
              tradeId: trade.id, coin: trade.coin, action: "tp1_hit", side: trade.side as any, price: currentPrice,
              reasoning: `[CONFLUENCE] TP1 hit @ $${displayPrice(currentPrice, szd)} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)})`,
              equity: currentEquity, leverage: trade.leverage, strategy: "confluence",
            });
            await storage.createLog({ type: "trade_tp1", message: `[CONFLUENCE] TP1 HIT: ${trade.coin} @ $${displayPrice(currentPrice, szd)}`, timestamp: new Date().toISOString() });
            continue;
          }
        }

        // TP2
        if (!shouldClose) {
          const tp2Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit2 || Infinity)) ||
                         (trade.side === "short" && currentPrice <= (trade.takeProfit2 || 0));
          if (tp2Hit) { shouldClose = true; closeReason = `[CONFLUENCE] TP2 @ $${displayPrice(currentPrice, szd)} (+$${pnlUsd.toFixed(2)})`; exitType = "tp2"; }
        }

        // Trailing stop
        if (config.useTrailingStop && trade.tp1Hit && !shouldClose) {
          const trailingPct = config.trailingStopPct || 0.3;
          const drawdown = currentPeak - leveragedPnl;
          if (currentPeak > trailingPct * 2 && drawdown > trailingPct) {
            shouldClose = true;
            closeReason = `[CONFLUENCE] Trailing: peak ${currentPeak.toFixed(2)}% → ${leveragedPnl.toFixed(2)}%`;
            exitType = "trailing";
          }
        }

        // RSI recovery
        if (!shouldClose) {
          const closes = await fetchCandles(trade.coin, "1h", 25);
          if (closes.length >= 15) {
            const rsi = calculateRSI(closes);
            if (trade.side === "long" && (trade.rsiAtEntry || 50) < 30 && rsi > 55) {
              shouldClose = true; closeReason = `[CONFLUENCE] RSI recovered: ${(trade.rsiAtEntry || 0).toFixed(0)} → ${rsi.toFixed(0)}`; exitType = "rsi_recovery";
            }
            if (trade.side === "short" && (trade.rsiAtEntry || 50) > 70 && rsi < 45) {
              shouldClose = true; closeReason = `[CONFLUENCE] RSI recovered: ${(trade.rsiAtEntry || 0).toFixed(0)} → ${rsi.toFixed(0)}`; exitType = "rsi_recovery";
            }
          }
        }
      }

      // ============================================================
      // SHARED CLOSE EXECUTION (both strategies)
      // ============================================================

      if (shouldClose) {
        if (leveragedPnl < 0) {
          this.dailyLoss += Math.abs(leveragedPnl); this.weeklyLoss += Math.abs(leveragedPnl);
          this.dailyLossUsd += Math.abs(pnlUsd); this.weeklyLossUsd += Math.abs(pnlUsd);
        }

        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            const positions = await executor.getPositions();
            const pos = positions.find((p: any) => p.position?.coin === trade.coin);
            if (pos) {
              const sz = Math.abs(parseFloat(pos.position.szi || "0"));
              const slippage = trade.side === "long" ? 0.99 : 1.01;
              await executor.placeOrder({
                coin: trade.coin, isBuy: trade.side === "short", sz,
                limitPx: parseFloat(formatHLPrice(currentPrice * slippage, szd)),
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
              });
            }
          } catch (e) { log(`Close error: ${e}`, "engine"); }
        }

        await storage.updateTrade(trade.id, {
          exitPrice: currentPrice, pnl: leveragedPnl, pnlPct: leveragedPnl, peakPnlPct: currentPeak,
          status: "closed", closeReason, closedAt: new Date().toISOString(),
        });

        await logDecision({
          tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
          reasoning: `EXIT: ${closeReason} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | Held: ${trade.openedAt ? Math.round((Date.now() - new Date(trade.openedAt).getTime()) / 60000) : 0}min | Peak: ${currentPeak.toFixed(2)}%`,
          equity: currentEquity, leverage: trade.leverage, strategy,
        });

        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [${strategy.toUpperCase()}] ${trade.side.toUpperCase()} ${trade.coin} | ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | ${closeReason}`,
          timestamp: new Date().toISOString(),
        });
      } else {
        await storage.updateTrade(trade.id, { pnl: leveragedPnl, pnlPct: leveragedPnl, peakPnlPct: currentPeak });
      }
    }
  }

  private async takePnlSnapshot(equity?: number) {
    const allTrades = await storage.getAllTrades();
    const openTrades = await storage.getOpenTrades();
    const closedTrades = allTrades.filter(t => t.status === "closed");
    const currentEquity = equity || this.lastKnownEquity || 0;

    const closedPnlOfAum = closedTrades.reduce((s, t) => s + ((t.pnl || 0) * ((t.size || 10) / 100)), 0);
    const openPnlOfAum = openTrades.reduce((s, t) => s + ((t.pnl || 0) * ((t.size || 10) / 100)), 0);
    const totalPnl = closedPnlOfAum + openPnlOfAum;

    await storage.createPnlSnapshot({
      totalEquity: currentEquity > 0 ? currentEquity : (this.startingEquity || 0) * (1 + totalPnl / 100),
      totalPnl, totalPnlPct: totalPnl, openPositions: openTrades.length,
      timestamp: new Date().toISOString(),
    });
  }

  async forceCloseTrade(tradeId: number) {
    const trade = await storage.getTradeById(tradeId);
    if (!trade || trade.status !== "open") return null;
    const strategy: StrategyType = (trade.strategy as StrategyType) || "confluence";
    const mids = await fetchAllMids();
    const xyzData = await fetchMetaAndAssetCtxs("xyz");
    if (xyzData && xyzData.length >= 2) {
      const universe = xyzData[0]?.universe || [];
      const ctxs = xyzData[1] || [];
      for (let i = 0; i < universe.length; i++) { if (ctxs[i]?.midPx && ctxs[i].midPx !== "None") mids[universe[i].name] = ctxs[i].midPx; }
    }
    const currentPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
    const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
    const config = await storage.getConfig();
    if (config?.apiSecret && config?.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const positions = await executor.getPositions();
        const pos = positions.find((p: any) => p.position?.coin === trade.coin);
        if (pos) {
          const sz = Math.abs(parseFloat(pos.position.szi || "0"));
          const slippage = trade.side === "long" ? 0.99 : 1.01;
          await executor.placeOrder({
            coin: trade.coin, isBuy: trade.side === "short", sz,
            limitPx: parseFloat(formatHLPrice(currentPrice * slippage, ac?.szDecimals ?? 2)),
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

    const updated = await storage.updateTrade(trade.id, {
      exitPrice: currentPrice, pnl: pnlPct, pnlPct, status: "closed",
      closeReason: "Manual close", closedAt: new Date().toISOString(),
    });
    await logDecision({
      tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
      reasoning: `MANUAL CLOSE [${strategy.toUpperCase()}] | P&L: ${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`, equity: eq, leverage: trade.leverage, strategy,
    });
    await storage.createLog({
      type: "trade_close",
      message: `Manual close [${strategy.toUpperCase()}] ${trade.side.toUpperCase()} ${trade.coin} | ${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`,
      timestamp: new Date().toISOString(),
    });
    return updated;
  }

  async forceScan() { await this.runScanCycle(); }

  getLastKnownEquity(): number {
    return this.lastKnownEquity;
  }

  async getStatus() {
    const config = await storage.getConfig();
    const openTrades = await storage.getOpenTrades();
    const allTrades = await storage.getAllTrades();
    const closedTrades = allTrades.filter(t => t.status === "closed");
    const winTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
    const winRate = closedTrades.length > 0 ? (winTrades.length / closedTrades.length) * 100 : 0;
    const si = getSessionInfo();
    const stats = await getLearningStats();

    const currentEquity = this.lastKnownEquity || 0;
    const startEq = this.startingEquity || currentEquity;

    const closedPnlOfAum = closedTrades.reduce((s, t) => {
      const leveragedPnl = t.pnl || 0;
      const posWeight = (t.size || 10) / 100;
      return s + (leveragedPnl * posWeight);
    }, 0);

    const openPnlOfAum = openTrades.reduce((s, t) => {
      const leveragedPnl = t.pnl || 0;
      const posWeight = (t.size || 10) / 100;
      return s + (leveragedPnl * posWeight);
    }, 0);

    const combinedPnlOfAum = closedPnlOfAum + openPnlOfAum;

    // Dollar P&L: % of AUM → actual USDC
    const closedPnlUsd = startEq > 0 ? startEq * (closedPnlOfAum / 100) : 0;
    const openPnlUsd = currentEquity > 0 ? currentEquity * (openPnlOfAum / 100) : 0;
    const combinedPnlUsd = closedPnlUsd + openPnlUsd;
    const dailyLossUsd = currentEquity > 0 ? currentEquity * (this.dailyLoss / 100) : 0;
    const weeklyLossUsd = currentEquity > 0 ? currentEquity * (this.weeklyLoss / 100) : 0;

    // Per-trade dollar P&L for open positions
    const openTradesWithUsd = openTrades.map(t => {
      const tradeCapUsd = currentEquity * ((t.size || 10) / 100);
      const pnlUsd = tradeCapUsd * ((t.pnl || 0) / 100);
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)) };
    });

    // Per-strategy stats
    const confluenceTrades = closedTrades.filter(t => (t.strategy || "confluence") === "confluence");
    const extremeTrades = closedTrades.filter(t => t.strategy === "extreme_rsi");
    const confluenceWinRate = confluenceTrades.length > 0 ? (confluenceTrades.filter(t => (t.pnl || 0) > 0).length / confluenceTrades.length) * 100 : 0;
    const extremeWinRate = extremeTrades.length > 0 ? (extremeTrades.filter(t => (t.pnl || 0) > 0).length / extremeTrades.length) * 100 : 0;

    // Per-strategy dollar P&L
    const confluencePnlUsd = confluenceTrades.reduce((s, t) => {
      const cap = startEq * ((t.size || 10) / 100);
      return s + cap * ((t.pnl || 0) / 100);
    }, 0);
    const extremePnlUsd = extremeTrades.reduce((s, t) => {
      const cap = startEq * ((t.size || 10) / 100);
      return s + cap * ((t.pnl || 0) / 100);
    }, 0);

    return {
      isRunning: config?.isRunning || false,
      openPositions: openTrades.length,
      totalTrades: allTrades.length,
      closedTrades: closedTrades.length,
      winRate: winRate.toFixed(1),
      totalPnl: closedPnlOfAum.toFixed(2),
      totalPnlUsd: closedPnlUsd.toFixed(4),
      openPnl: openPnlOfAum.toFixed(2),
      openPnlUsd: openPnlUsd.toFixed(4),
      combinedPnl: combinedPnlOfAum.toFixed(2),
      combinedPnlUsd: combinedPnlUsd.toFixed(4),
      session: si.session,
      sessionDescription: si.description,
      dailyLoss: this.dailyLoss.toFixed(2),
      dailyLossUsd: dailyLossUsd.toFixed(4),
      weeklyLoss: this.weeklyLoss.toFixed(2),
      weeklyLossUsd: weeklyLossUsd.toFixed(4),
      equity: currentEquity.toFixed(2),
      startingEquity: startEq.toFixed(2),
      learningStats: stats,
      allowedAssets: ALLOWED_ASSETS.map(a => ({ coin: a.coin, name: a.displayName, category: a.category, maxLev: a.maxLeverage })),
      openTradesWithUsd,
      // Per-strategy breakdown
      strategyStats: {
        confluence: { trades: confluenceTrades.length, winRate: confluenceWinRate.toFixed(1), openPositions: openTrades.filter(t => (t.strategy || "confluence") === "confluence").length, pnlUsd: confluencePnlUsd.toFixed(4) },
        extreme_rsi: { trades: extremeTrades.length, winRate: extremeWinRate.toFixed(1), openPositions: openTrades.filter(t => t.strategy === "extreme_rsi").length, pnlUsd: extremePnlUsd.toFixed(4) },
      },
    };
  }
}

export const tradingEngine = new TradingEngine();
