/**
 * HyperTrader — Elite Trading Engine v8 (RSI + BB + Volume + ADX + S/R Levels)
 *
 * SINGLE STRATEGY — EXTREME RSI + BOLLINGER BAND REVERSION:
 *   - Confluence strategy DISABLED based on 12-month BTC backtest analysis
 *   - Mean reversion via extreme RSI outperformed trend-following in 2025-2026
 *   - Enhanced with Bollinger Bands, Volume Exhaustion, ADX Regime, and S/R Levels
 *
 * TWO ENTRY TRIGGERS:
 *   Trigger A — EXTREME RSI (multi-TF):
 *     - RSI < 10 on 2+ of (1m, 5m, 15m) → LONG
 *     - RSI > 80 on 2+ of (1m, 5m, 15m) → SHORT
 *     - BB/volume/ADX are bonus confirmations (increase confidence)
 *   Trigger B — BOLLINGER BAND REVERSION (NEW):
 *     - Price touches 2-3 SD Bollinger Band on 5m OR 15m
 *     - RSI on same TF confirms: < 30 for long, > 70 for short
 *     - Volume exhaustion + ADX < 25 preferred but not required
 *
 * ADX REGIME ADAPTATION:
 *   - ADX < 25 (ranging): standard TP targets
 *   - ADX >= 25 (trending): widen TP by 50%, reduce position to 75%
 *
 * 24h Learning Cycle:
 *   - Every 24 hours: deep review of all trades, pattern analysis,
 *     mistake identification, and insight generation
 *   - Continuous improvement stored in PostgreSQL forever
 */

// minifyIdentifiers: false — keep readable names for debugging

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
type StrategyType = "confluence" | "extreme_rsi" | "bb_rsi_reversion";

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
  sizeMultiplier?: number;
}): {
  capitalForTrade: number;
  leverage: number;
  notionalSize: number;
  assetSize: number;
  canTrade: boolean;
  skipReason: string;
} {
  const { equity, price, asset, config, sizeMultiplier = 1.0 } = params;
  const leverage = asset.maxLeverage;

  const baseTradeAmountPct = config.tradeAmountPct || 10;
  let capitalForTrade = equity * (baseTradeAmountPct / 100) * sizeMultiplier;

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

// ============ BOLLINGER BANDS ============

interface BollingerBands {
  upper: number;
  middle: number; // SMA
  lower: number;
  bandwidth: number; // (upper - lower) / middle
  percentB: number;  // (price - lower) / (upper - lower)
  stdDev: number;
}

function calculateBollingerBands(closes: number[], period: number = 20, multiplier: number = 2): BollingerBands {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last, bandwidth: 0, percentB: 0.5, stdDev: 0 };
  }

  // Use the last `period` closes for SMA and StdDev
  const slice = closes.slice(closes.length - period);
  const sma = slice.reduce((s, v) => s + v, 0) / period;

  const variance = slice.reduce((s, v) => s + (v - sma) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + multiplier * stdDev;
  const lower = sma - multiplier * stdDev;
  const currentPrice = closes[closes.length - 1];
  const bandwidth = sma > 0 ? (upper - lower) / sma : 0;
  const range = upper - lower;
  const percentB = range > 0 ? (currentPrice - lower) / range : 0.5;

  return { upper, middle: sma, lower, bandwidth, percentB, stdDev };
}

// ============ ADX CALCULATION ============

function calculateADX(candles: { high: number; low: number; close: number }[], period: number = 14): number {
  if (candles.length < period * 2 + 1) return 25; // default neutral

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;

    // True Range
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  if (trueRanges.length < period) return 25;

  // Initial smoothed values (Wilder's smoothing)
  let smoothedTR = trueRanges.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothedPlusDM = plusDMs.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothedMinusDM = minusDMs.slice(0, period).reduce((s, v) => s + v, 0);

  const dxValues: number[] = [];

  for (let i = period; i < trueRanges.length; i++) {
    if (i > period) {
      smoothedTR = smoothedTR - smoothedTR / period + trueRanges[i];
      smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDMs[i];
      smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDMs[i];
    }

    const plusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
    const minusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return 25;

  // Smooth ADX
  let adx = dxValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return adx;
}

// ============ VOLUME EXHAUSTION DETECTION ============

interface VolumeAnalysis {
  isExhausting: boolean;     // Volume declining over recent bars
  volumeRatio: number;       // Current volume vs 20-period average
  trend: "increasing" | "decreasing" | "stable";
}

function analyzeVolume(volumes: number[], lookback: number = 20): VolumeAnalysis {
  if (volumes.length < lookback) {
    return { isExhausting: false, volumeRatio: 1.0, trend: "stable" };
  }

  const recentSlice = volumes.slice(volumes.length - lookback);
  const avgVolume = recentSlice.reduce((s, v) => s + v, 0) / lookback;

  // Recent 5-bar average
  const recent5 = volumes.slice(volumes.length - 5);
  const recent5Avg = recent5.reduce((s, v) => s + v, 0) / recent5.length;

  const volumeRatio = avgVolume > 0 ? recent5Avg / avgVolume : 1.0;

  // Volume declining = exhaustion move (< 70% of average)
  const isExhausting = volumeRatio < 0.7;

  let trend: "increasing" | "decreasing" | "stable";
  if (volumeRatio > 1.3) trend = "increasing";
  else if (volumeRatio < 0.7) trend = "decreasing";
  else trend = "stable";

  return { isExhausting, volumeRatio, trend };
}

// ============ SUPPORT / RESISTANCE DETECTION ============

interface SRLevel {
  price: number;
  type: "support" | "resistance";
  touches: number;       // how many times price tested this zone
  strength: number;      // 1-5 score (touches + recency + rejection strength)
  lastTouchIdx: number;  // index of most recent touch (for recency)
  zone: [number, number]; // [low, high] of the clustered zone
}

interface SRAnalysis {
  levels: SRLevel[];
  nearestSupport: SRLevel | null;
  nearestResistance: SRLevel | null;
  atSupport: boolean;      // price within 0.3% of a strong support
  atResistance: boolean;   // price within 0.3% of a strong resistance
  supportDistance: number; // % distance to nearest support (negative = below)
  resistanceDistance: number; // % distance to nearest resistance (negative = above)
}

/**
 * Detect horizontal S/R levels from OHLCV candle data.
 * Uses swing high/low pivot detection, then clusters nearby pivots into zones.
 * Scores each zone by touch count, recency, and rejection strength.
 */
function detectSupportResistance(
  candles: OHLCVCandle[],
  currentPrice: number,
  pivotWindow: number = 5,
  clusterPct: number = 0.003, // 0.3% price cluster tolerance
): SRAnalysis {
  const noResult: SRAnalysis = {
    levels: [], nearestSupport: null, nearestResistance: null,
    atSupport: false, atResistance: false, supportDistance: 0, resistanceDistance: 0,
  };
  if (candles.length < pivotWindow * 2 + 1) return noResult;

  // Step 1: Find swing highs and swing lows (pivot points)
  const pivots: { price: number; type: "high" | "low"; idx: number; rejectionSize: number }[] = [];

  for (let i = pivotWindow; i < candles.length - pivotWindow; i++) {
    const c = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= pivotWindow; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isSwingHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isSwingLow = false;
    }

    if (isSwingHigh) {
      // Rejection strength: how far price wicked above close
      const rejectionSize = c.high > 0 ? ((c.high - Math.max(c.open, c.close)) / c.high) * 100 : 0;
      pivots.push({ price: c.high, type: "high", idx: i, rejectionSize });
    }
    if (isSwingLow) {
      const rejectionSize = c.low > 0 ? ((Math.min(c.open, c.close) - c.low) / c.low) * 100 : 0;
      pivots.push({ price: c.low, type: "low", idx: i, rejectionSize });
    }
  }

  if (pivots.length === 0) return noResult;

  // Step 2: Cluster nearby pivots into zones
  // Sort pivots by price
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: { pivots: typeof pivots; avgPrice: number; zoneLow: number; zoneHigh: number }[] = [];

  let currentCluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const pctDiff = Math.abs(sorted[i].price - currentCluster[0].price) / currentCluster[0].price;
    if (pctDiff <= clusterPct) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push({
        pivots: currentCluster,
        avgPrice: currentCluster.reduce((s, p) => s + p.price, 0) / currentCluster.length,
        zoneLow: Math.min(...currentCluster.map(p => p.price)),
        zoneHigh: Math.max(...currentCluster.map(p => p.price)),
      });
      currentCluster = [sorted[i]];
    }
  }
  clusters.push({
    pivots: currentCluster,
    avgPrice: currentCluster.reduce((s, p) => s + p.price, 0) / currentCluster.length,
    zoneLow: Math.min(...currentCluster.map(p => p.price)),
    zoneHigh: Math.max(...currentCluster.map(p => p.price)),
  });

  // Step 3: Score each cluster
  const totalCandles = candles.length;
  const levels: SRLevel[] = clusters.map(cl => {
    const touches = cl.pivots.length;
    const lastTouchIdx = Math.max(...cl.pivots.map(p => p.idx));
    const avgRejection = cl.pivots.reduce((s, p) => s + p.rejectionSize, 0) / touches;

    // Recency bonus: levels tested more recently are stronger
    const recencyScore = lastTouchIdx / totalCandles; // 0-1, higher = more recent

    // Strength: touches (max 3pts) + recency (max 1pt) + rejection (max 1pt)
    let strength = Math.min(touches, 3);
    if (recencyScore > 0.7) strength += 1;
    if (avgRejection > 0.1) strength += 1;
    strength = Math.min(strength, 5);

    // Determine type based on position relative to current price
    const type: "support" | "resistance" = cl.avgPrice < currentPrice ? "support" : "resistance";

    return {
      price: cl.avgPrice,
      type,
      touches,
      strength,
      lastTouchIdx,
      zone: [cl.zoneLow, cl.zoneHigh] as [number, number],
    };
  });

  // Step 4: Find nearest support/resistance and proximity
  const supports = levels.filter(l => l.type === "support").sort((a, b) => b.price - a.price); // closest first
  const resistances = levels.filter(l => l.type === "resistance").sort((a, b) => a.price - b.price); // closest first

  const nearestSupport = supports[0] || null;
  const nearestResistance = resistances[0] || null;

  const proximityThreshold = 0.003; // 0.3% = "at" a level
  const atSupport = nearestSupport
    ? Math.abs(currentPrice - nearestSupport.price) / currentPrice <= proximityThreshold && nearestSupport.strength >= 2
    : false;
  const atResistance = nearestResistance
    ? Math.abs(currentPrice - nearestResistance.price) / currentPrice <= proximityThreshold && nearestResistance.strength >= 2
    : false;

  const supportDistance = nearestSupport
    ? ((currentPrice - nearestSupport.price) / currentPrice) * 100
    : 0;
  const resistanceDistance = nearestResistance
    ? ((nearestResistance.price - currentPrice) / currentPrice) * 100
    : 0;

  // Keep only the top levels by strength (max 8)
  const topLevels = [...levels].sort((a, b) => b.strength - a.strength).slice(0, 8);

  return {
    levels: topLevels,
    nearestSupport,
    nearestResistance,
    atSupport,
    atResistance,
    supportDistance,
    resistanceDistance,
  };
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

interface OHLCVCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

// ============ CONFLUENCE SCORING (Dashboard Display Only — No Trade Execution) ============

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

// ============ ENHANCED EXTREME RSI DETECTION (with BB + Volume + ADX) ============

interface EnhancedRsiResult {
  triggered: boolean;
  signal: "long" | "short" | "none";
  triggerType: "extreme_rsi" | "bb_rsi_reversion" | "none";
  triggerTF: string;
  triggerRSI: number;
  allRSIs: { tf: string; rsi: number }[];
  bollingerConfirm: boolean;
  volumeExhaustion: boolean;
  adxRegime: "ranging" | "trending";
  adxValue: number;
  suggestedSL: number;
  suggestedTP1: number;
  suggestedTP2: number;
  confidenceScore: number;
  srAnalysis: SRAnalysis;
  srConfirm: boolean;      // true if S/R supports the trade direction
  srBlock: boolean;         // true if trading INTO a strong level (should skip)
}

function detectEnhancedRSI(params: {
  price: number;
  rsi1m: number; rsi5m: number; rsi15m: number; rsi1h: number; rsi4h: number; rsi1d: number;
  bb5m: BollingerBands;
  bb15m: BollingerBands;
  volume5m: VolumeAnalysis;
  volume15m: VolumeAnalysis;
  adxValue: number;
  srAnalysis: SRAnalysis;
}): EnhancedRsiResult {
  const { price, rsi1m, rsi5m, rsi15m, rsi1h, rsi4h, rsi1d, bb5m, bb15m, volume5m, volume15m, adxValue, srAnalysis } = params;

  const allRSIs = [
    { tf: "1m", rsi: rsi1m },
    { tf: "5m", rsi: rsi5m },
    { tf: "15m", rsi: rsi15m },
    { tf: "1h", rsi: rsi1h },
    { tf: "4h", rsi: rsi4h },
    { tf: "1d", rsi: rsi1d },
  ];

  const adxRegime: "ranging" | "trending" = adxValue < 25 ? "ranging" : "trending";
  const noResult: EnhancedRsiResult = {
    triggered: false, signal: "none", triggerType: "none", triggerTF: "", triggerRSI: 0, allRSIs,
    bollingerConfirm: false, volumeExhaustion: false, adxRegime, adxValue,
    suggestedSL: 0, suggestedTP1: 0, suggestedTP2: 0, confidenceScore: 0,
    srAnalysis, srConfirm: false, srBlock: false,
  };

  // ---- Trigger A: Extreme RSI (existing logic) ----
  const EXTREME_OVERSOLD = 10;
  const EXTREME_OVERBOUGHT = 80;

  const shortTFs = [
    { tf: "1m", rsi: rsi1m },
    { tf: "5m", rsi: rsi5m },
    { tf: "15m", rsi: rsi15m },
  ].filter(r => r.rsi > 0);

  const oversoldTFs = shortTFs.filter(r => r.rsi < EXTREME_OVERSOLD);
  const overboughtTFs = shortTFs.filter(r => r.rsi > EXTREME_OVERBOUGHT);

  let triggerASignal: "long" | "short" | "none" = "none";
  let triggerATF = "";
  let triggerARSI = 0;

  if (oversoldTFs.length >= 2) {
    triggerASignal = "long";
    triggerARSI = oversoldTFs.reduce((s, r) => s + r.rsi, 0) / oversoldTFs.length;
    triggerATF = shortTFs.map(r => `${r.tf}(${r.rsi.toFixed(1)}${r.rsi < EXTREME_OVERSOLD ? '*' : ''})`).join('+');
  } else if (overboughtTFs.length >= 2) {
    triggerASignal = "short";
    triggerARSI = overboughtTFs.reduce((s, r) => s + r.rsi, 0) / overboughtTFs.length;
    triggerATF = shortTFs.map(r => `${r.tf}(${r.rsi.toFixed(1)}${r.rsi > EXTREME_OVERBOUGHT ? '*' : ''})`).join('+');
  }

  // ---- Trigger B: Bollinger Band Reversion (NEW) ----
  let triggerBSignal: "long" | "short" | "none" = "none";
  let triggerBTF = "";
  let triggerBRSI = 0;

  // Check 5m: price at lower BB + RSI < 30 → long; price at upper BB + RSI > 70 → short
  const bb5mStdDist = bb5m.stdDev > 0 ? Math.abs(price - bb5m.middle) / bb5m.stdDev : 0;
  const bb15mStdDist = bb15m.stdDev > 0 ? Math.abs(price - bb15m.middle) / bb15m.stdDev : 0;

  // 5m BB check
  if (triggerBSignal === "none" && bb5mStdDist >= 2) {
    if (price <= bb5m.lower && rsi5m < 30) {
      triggerBSignal = "long";
      triggerBTF = `5m(BB_lower,RSI:${rsi5m.toFixed(1)},${bb5mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi5m;
    } else if (price >= bb5m.upper && rsi5m > 70) {
      triggerBSignal = "short";
      triggerBTF = `5m(BB_upper,RSI:${rsi5m.toFixed(1)},${bb5mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi5m;
    }
  }

  // 15m BB check
  if (triggerBSignal === "none" && bb15mStdDist >= 2) {
    if (price <= bb15m.lower && rsi15m < 30) {
      triggerBSignal = "long";
      triggerBTF = `15m(BB_lower,RSI:${rsi15m.toFixed(1)},${bb15mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi15m;
    } else if (price >= bb15m.upper && rsi15m > 70) {
      triggerBSignal = "short";
      triggerBTF = `15m(BB_upper,RSI:${rsi15m.toFixed(1)},${bb15mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi15m;
    }
  }

  // Pick the trigger — Trigger A takes priority if both fire
  let signal: "long" | "short" | "none" = "none";
  let triggerType: "extreme_rsi" | "bb_rsi_reversion" | "none" = "none";
  let triggerTF = "";
  let triggerRSI = 0;

  if (triggerASignal !== "none") {
    signal = triggerASignal;
    triggerType = "extreme_rsi";
    triggerTF = triggerATF;
    triggerRSI = triggerARSI;
  } else if (triggerBSignal !== "none") {
    signal = triggerBSignal;
    triggerType = "bb_rsi_reversion";
    triggerTF = triggerBTF;
    triggerRSI = triggerBRSI;
  }

  if (signal === "none") return noResult;

  // --- Bollinger confirmation: is price at 2+ SD band in signal direction? ---
  let bollingerConfirm = false;
  if (signal === "long") {
    // Price at/below lower 2SD band on either 5m or 15m
    bollingerConfirm = (bb5mStdDist >= 2 && price <= bb5m.lower) || (bb15mStdDist >= 2 && price <= bb15m.lower);
  } else {
    bollingerConfirm = (bb5mStdDist >= 2 && price >= bb5m.upper) || (bb15mStdDist >= 2 && price >= bb15m.upper);
  }

  // --- Volume exhaustion ---
  const volumeExhaustion = volume5m.isExhausting || volume15m.isExhausting;

  // --- S/R analysis ---
  let srConfirm = false;
  let srBlock = false;

  if (signal === "long") {
    // LONG at support = strong confirmation (price likely to bounce)
    if (srAnalysis.atSupport && srAnalysis.nearestSupport && srAnalysis.nearestSupport.strength >= 2) {
      srConfirm = true;
    }
    // LONG into strong resistance very close above (< 0.3%) = blocked
    if (srAnalysis.nearestResistance && srAnalysis.resistanceDistance < 0.3 && srAnalysis.nearestResistance.strength >= 3) {
      srBlock = true;
    }
  } else {
    // SHORT at resistance = strong confirmation (price likely to reject)
    if (srAnalysis.atResistance && srAnalysis.nearestResistance && srAnalysis.nearestResistance.strength >= 2) {
      srConfirm = true;
    }
    // SHORT into strong support very close below (< 0.3%) = blocked
    if (srAnalysis.nearestSupport && srAnalysis.supportDistance < 0.3 && srAnalysis.nearestSupport.strength >= 3) {
      srBlock = true;
    }
  }

  // --- Confidence scoring (1-5) ---
  let confidenceScore = 1; // base: trigger fired
  if (bollingerConfirm) confidenceScore++;
  if (volumeExhaustion) confidenceScore++;
  if (adxValue < 25) confidenceScore++;
  // 3+ timeframes agree on RSI direction
  const agreeingTFs = signal === "long"
    ? allRSIs.filter(r => r.rsi > 0 && r.rsi < 40).length
    : allRSIs.filter(r => r.rsi > 0 && r.rsi > 60).length;
  if (agreeingTFs >= 3) confidenceScore++;
  // S/R confirmation adds confidence
  if (srConfirm) confidenceScore++;

  // --- TP/SL targets based on trigger type + ADX regime ---
  let tp1Pct: number;
  let tp2Pct: number;
  const slPct = 0.0025; // 0.25% SL for both triggers

  if (triggerType === "extreme_rsi") {
    tp1Pct = 0.003;  // 0.3%
    tp2Pct = 0.01;   // 1%
  } else {
    // bb_rsi_reversion: tighter targets
    tp1Pct = 0.002;  // 0.2%
    tp2Pct = 0.005;  // 0.5%
  }

  // ADX >= 25 (trending): widen TP targets by 50%
  if (adxRegime === "trending") {
    tp1Pct *= 1.5;
    tp2Pct *= 1.5;
  }

  let sl: number, tp1: number, tp2: number;
  if (signal === "long") {
    sl = price * (1 - slPct);
    tp1 = price * (1 + tp1Pct);
    tp2 = price * (1 + tp2Pct);
  } else {
    sl = price * (1 + slPct);
    tp1 = price * (1 - tp1Pct);
    tp2 = price * (1 - tp2Pct);
  }

  return {
    triggered: true, signal, triggerType, triggerTF, triggerRSI, allRSIs,
    bollingerConfirm, volumeExhaustion, adxRegime, adxValue,
    suggestedSL: sl, suggestedTP1: tp1, suggestedTP2: tp2,
    confidenceScore,
    srAnalysis, srConfirm, srBlock,
  };
}

// ============ TRADING ENGINE ============

class TradingEngine {
  private scanTimer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private lastKnownEquity = 0;
  private startingEquity = 0;
  private dayStartEquity = 0;       // equity at start of trading day
  private dayStartDate = "";         // YYYY-MM-DD
  private dailyTradeCount = 0;       // trades opened today
  private dailyTradeDate = "";       // YYYY-MM-DD for trade counter
  private drawdownPaused = false;    // true if 50% drawdown hit today
  private scanCount = 0;
  private lastLearningReview = 0; // timestamp of last 24h review
  private pnlResetTimestamp = ""; // only count trades opened after this for P&L display
  private pnlResetEquity = 0;     // AUM at time of reset — the baseline
  private latestSRLevels: Record<string, SRAnalysis> = {}; // per-asset S/R levels from last scan

  private resetLossTrackers() {
    this.drawdownPaused = false;
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

    // Auto-reset P&L baseline to current AUM on every start
    this.pnlResetTimestamp = new Date().toISOString();
    this.pnlResetEquity = this.lastKnownEquity;

    // Restore last review time from DB
    const lastReviewTime = await storage.getLastReviewTime();
    if (lastReviewTime) {
      this.lastLearningReview = new Date(lastReviewTime).getTime();
    }

    const insights = await storage.getActiveInsights();
    await storage.createLog({
      type: "system",
      message: `Engine v7 started | RSI-ONLY + BB + VOLUME + ADX | ${ALLOWED_ASSETS.length} assets | AUM: $${this.lastKnownEquity.toLocaleString()} | MAX leverage | ${insights.length} learned insights`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v7 started — RSI-ONLY + BB + VOLUME + ADX — AUM: $${this.lastKnownEquity.toFixed(2)} | ${insights.length} learned insights`, "engine");
    this.scheduleNextScan();
  }

  async stop() {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    await storage.createLog({ type: "system", message: "Trading engine stopped", timestamp: new Date().toISOString() });
  }

  private checkNewDay() {
    const today = new Date().toISOString().split("T")[0];
    if (this.dayStartDate !== today) {
      // New trading day — reset drawdown baseline to current equity
      this.dayStartEquity = this.lastKnownEquity;
      this.dayStartDate = today;
      this.drawdownPaused = false;
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
          if (this.dayStartEquity === 0) this.dayStartEquity = val;
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

      // 50% DRAWDOWN CHECK — from day-start AUM
      if (this.dayStartEquity > 0) {
        const drawdownPct = ((this.dayStartEquity - equity) / this.dayStartEquity) * 100;
        if (drawdownPct >= 50 && !this.drawdownPaused) {
          this.drawdownPaused = true;
          const msg = `50% DRAWDOWN HIT — Day start: $${this.dayStartEquity.toFixed(2)} → Current: $${equity.toFixed(2)} (${drawdownPct.toFixed(1)}% down). Pausing new entries for today. Triggering learning review.`;
          await logDecision({ coin: "ALL", action: "circuit_breaker", price: 0, reasoning: msg, equity, strategy: "extreme_rsi" });
          await storage.createLog({ type: "drawdown_stop", message: msg, timestamp: new Date().toISOString() });
          log(msg, "engine");
          // Trigger immediate deep learning review to analyze mistakes
          try {
            await run24hReview();
            this.lastLearningReview = Date.now();
            await storage.createLog({ type: "learning_24h", message: "DRAWDOWN REVIEW — emergency learning review triggered by 50% drawdown", timestamp: new Date().toISOString() });
          } catch (e) { log(`Drawdown review error: ${e}`, "engine"); }
        }
      }
      // If drawdown paused, still check exits but skip new entries
      const canOpenNew = !this.drawdownPaused;

      const sessionInfo = getSessionInfo();
      const useSessionFilter = config.useSessionFilter !== false;

      log(`Scan #${this.scanCount} — ${sessionInfo.description} | AUM: $${equity.toLocaleString()} | ${ALLOWED_ASSETS.length} assets | RSI-ONLY MODE | Trades today: ${this.dailyTradeCount}/20${this.drawdownPaused ? " | DRAWDOWN PAUSED" : ""}`, "engine");

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
      // SCAN EACH ASSET — Enhanced RSI + BB + Volume + ADX
      // ======================================================================

      const enhancedSignals: Array<{
        asset: AssetConfig; price: number; enhanced: EnhancedRsiResult;
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

        // Fetch candles: OHLCV for 5m, 15m (BB/ADX/volume), 1h & 4h (S/R detection); closes for RSI
        const [c1m, ohlcv5m, ohlcv15m, ohlcv1h, ohlcv4h, c1d] = await Promise.all([
          fetchCandles(asset.coin, "1m", 60),
          fetchCandlesOHLCV(asset.coin, "5m", 60),
          fetchCandlesOHLCV(asset.coin, "15m", 60),
          fetchCandlesOHLCV(asset.coin, "1h", 100),   // 100 bars = ~4 days for S/R
          fetchCandlesOHLCV(asset.coin, "4h", 100),   // 100 bars = ~17 days for S/R
          fetchCandles(asset.coin, "1d", 30),
        ]);

        const c5m = ohlcv5m.map(c => c.close);
        const c15m = ohlcv15m.map(c => c.close);
        const c1h = ohlcv1h.map(c => c.close);
        const c4h = ohlcv4h.map(c => c.close);

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

        // Calculate Bollinger Bands on 5m and 15m
        const bb5m = calculateBollingerBands(c5m, 20, 2);
        const bb15m = calculateBollingerBands(c15m, 20, 2);

        // Calculate ADX on 15m (needs H/L/C)
        const adxCandles15m = ohlcv15m.map(c => ({ high: c.high, low: c.low, close: c.close }));
        const adxValue = calculateADX(adxCandles15m, 14);

        // Volume analysis on 5m and 15m
        const volumes5m = ohlcv5m.map(c => c.volume);
        const volumes15m = ohlcv15m.map(c => c.volume);
        const volume5m = analyzeVolume(volumes5m, 20);
        const volume15m = analyzeVolume(volumes15m, 20);

        // S/R level detection: merge 1h and 4h OHLCV for multi-timeframe levels
        // Use 1h as primary (more granular), 4h as secondary (stronger macro levels)
        const sr1h = detectSupportResistance(ohlcv1h, price, 5, 0.003);
        const sr4h = detectSupportResistance(ohlcv4h, price, 3, 0.005);
        // Merge: prefer 4h levels (stronger macro zones), then fill with 1h
        const mergedSRLevels = [...sr4h.levels, ...sr1h.levels]
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 8);
        // Rebuild analysis from merged levels
        const srSupports = mergedSRLevels.filter(l => l.type === "support").sort((a, b) => b.price - a.price);
        const srResistances = mergedSRLevels.filter(l => l.type === "resistance").sort((a, b) => a.price - b.price);
        const srNearestSup = srSupports[0] || null;
        const srNearestRes = srResistances[0] || null;
        const srProximity = 0.003;
        const srAnalysis: SRAnalysis = {
          levels: mergedSRLevels,
          nearestSupport: srNearestSup,
          nearestResistance: srNearestRes,
          atSupport: srNearestSup ? Math.abs(price - srNearestSup.price) / price <= srProximity && srNearestSup.strength >= 2 : false,
          atResistance: srNearestRes ? Math.abs(price - srNearestRes.price) / price <= srProximity && srNearestRes.strength >= 2 : false,
          supportDistance: srNearestSup ? ((price - srNearestSup.price) / price) * 100 : 0,
          resistanceDistance: srNearestRes ? ((srNearestRes.price - price) / price) * 100 : 0,
        };

        // Store S/R for dashboard access
        this.latestSRLevels[asset.coin] = srAnalysis;

        // Calculate confluence for dashboard display only (upsertMarketScan)
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

        // --- ENHANCED RSI + BB + S/R DETECTION ---
        const enhanced = detectEnhancedRSI({
          price, rsi1m, rsi5m, rsi15m, rsi1h, rsi4h, rsi1d,
          bb5m, bb15m, volume5m, volume15m, adxValue, srAnalysis,
        });
        if (enhanced.triggered) {
          enhancedSignals.push({
            asset, price, enhanced, volume24h, change24h, fundingRate: funding, openInterest,
            rsi1h, rsi4h, rsi1d, ema10, ema21, ema50, rsi1m, rsi5m, rsi15m,
          });
        }

        await new Promise(r => setTimeout(r, 150));
      }

      // Log scan summary
      await storage.createLog({
        type: "scan",
        message: `Scan: ${enhancedSignals.length} enhanced RSI/BB signals | ${sessionInfo.session} | AUM: $${equity.toLocaleString()}`,
        data: JSON.stringify([
          ...enhancedSignals.slice(0, 5).map(s => `[${s.enhanced.triggerType}] ${s.asset.coin} RSI:${s.enhanced.triggerRSI.toFixed(1)} ${s.enhanced.signal} @${s.enhanced.triggerTF} conf:${s.enhanced.confidenceScore}`),
        ]),
        timestamp: new Date().toISOString(),
      });

      let slotsUsed = 0;
      const now = new Date();

      // =============================================
      // EXECUTE ENHANCED RSI / BB REVERSION ENTRIES
      // =============================================
      if (canOpenNew && slotsAvailable > slotsUsed && enhancedSignals.length > 0) {
        for (const sig of enhancedSignals.slice(0, slotsAvailable - slotsUsed)) {
          if (sig.enhanced.signal === "none") continue;

          const strategyKey = sig.enhanced.triggerType === "bb_rsi_reversion" ? "bb_rsi_reversion" : "extreme_rsi";
          if (openByCoinStrategy.has(`${sig.asset.coin}_${strategyKey}`)) continue;

          const side = sig.enhanced.signal as "long" | "short";
          const reasoning: string[] = [];
          reasoning.push(`[${sig.enhanced.triggerType.toUpperCase()}] Signal: ${side.toUpperCase()} ${sig.asset.displayName}`);
          reasoning.push(`TRIGGER: RSI ${sig.enhanced.triggerRSI.toFixed(1)} on ${sig.enhanced.triggerTF} (${side === "long" ? "oversold" : "overbought"})`);
          reasoning.push(`All RSIs: ${sig.enhanced.allRSIs.map(r => `${r.tf}:${r.rsi.toFixed(1)}`).join(", ")}`);
          reasoning.push(`BB confirm: ${sig.enhanced.bollingerConfirm} | Vol exhaust: ${sig.enhanced.volumeExhaustion} | ADX: ${sig.enhanced.adxValue.toFixed(1)} (${sig.enhanced.adxRegime})`);
          // S/R level info
          const sr = sig.enhanced.srAnalysis;
          const srInfo: string[] = [];
          if (sr.nearestSupport) srInfo.push(`Sup: $${sr.nearestSupport.price.toFixed(2)}(str:${sr.nearestSupport.strength},t:${sr.nearestSupport.touches}) ${sr.supportDistance.toFixed(3)}% away`);
          if (sr.nearestResistance) srInfo.push(`Res: $${sr.nearestResistance.price.toFixed(2)}(str:${sr.nearestResistance.strength},t:${sr.nearestResistance.touches}) ${sr.resistanceDistance.toFixed(3)}% away`);
          if (sig.enhanced.srConfirm) srInfo.push(`S/R CONFIRMS ${side.toUpperCase()}`);
          if (sig.enhanced.srBlock) srInfo.push(`S/R BLOCKS — trading INTO strong level`);
          if (srInfo.length > 0) reasoning.push(`S/R: ${srInfo.join(" | ")}`);
          reasoning.push(`Confidence: ${sig.enhanced.confidenceScore}/6`);
          reasoning.push(`Price: $${displayPrice(sig.price, sig.asset.szDecimals)}`);
          reasoning.push(`TP1: $${displayPrice(sig.enhanced.suggestedTP1, sig.asset.szDecimals)} | TP2: $${displayPrice(sig.enhanced.suggestedTP2, sig.asset.szDecimals)}`);
          reasoning.push(`SL: $${displayPrice(sig.enhanced.suggestedSL, sig.asset.szDecimals)} → moves to BE after TP1`);
          reasoning.push(`Session: ${sessionInfo.session} | Funding: ${(sig.fundingRate * 100).toFixed(4)}%`);

          // S/R block: skip if trading into a strong level
          if (sig.enhanced.srBlock) {
            reasoning.push(`BLOCKED BY S/R: ${side === "long" ? "Strong resistance" : "Strong support"} too close — likely reversal`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: strategyKey });
            continue;
          }

          // Check learning insights
          const insightCheck = await checkInsights({ coin: sig.asset.coin, side, session: sessionInfo.session, confluenceScore: 7, dayOfWeek: now.getUTCDay() });
          if (insightCheck.shouldBlock) {
            reasoning.push(`BLOCKED BY LEARNING: ${insightCheck.blockReason}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: strategyKey });
            continue;
          }

          // ADX regime: reduce position size to 75% when trending
          const sizeMultiplier = sig.enhanced.adxRegime === "trending" ? 0.75 : 1.0;
          if (sizeMultiplier < 1.0) {
            reasoning.push(`ADX trending (${sig.enhanced.adxValue.toFixed(1)}) — position reduced to 75%`);
          }

          // Position sizing
          const pos = calculateAdaptivePosition({ equity, price: sig.price, asset: sig.asset, config, sizeMultiplier });
          if (!pos.canTrade) {
            reasoning.push(`SKIP: ${pos.skipReason}`);
            await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: strategyKey });
            continue;
          }

          const { leverage, capitalForTrade, assetSize, notionalSize } = pos;
          const tradeAmountPct = (capitalForTrade / equity) * 100;
          reasoning.push(`ENTRY: ${side.toUpperCase()} ${sig.asset.displayName} | ${leverage}x (MAX) | $${capitalForTrade.toFixed(2)} capital ($${notionalSize.toFixed(0)} notional) | sizeMult: ${sizeMultiplier}`);

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

              log(`[HL RAW] ${sig.asset.coin} ${strategyKey} response: ${JSON.stringify(orderResult).slice(0, 500)}`, "engine");
              const status = orderResult?.response?.data?.statuses?.[0];
              const fillPx = status?.filled?.avgPx;
              const totalSz = status?.filled?.totalSz;
              const errorMsg = status?.error || orderResult?.response?.data?.error || (orderResult?.status !== "ok" ? JSON.stringify(orderResult) : undefined);

              if (errorMsg) {
                reasoning.push(`ORDER REJECTED: ${errorMsg}`);
                await storage.createLog({ type: "order_error", message: `ORDER REJECTED: [${strategyKey.toUpperCase()}] ${sig.asset.displayName} — ${errorMsg}`, timestamp: new Date().toISOString() });
                await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: strategyKey });
                continue;
              }

              if (fillPx && parseFloat(totalSz) > 0) {
                reasoning.push(`FILLED: sz=${totalSz} @ $${fillPx}`);
                sig.price = parseFloat(fillPx);
              } else {
                reasoning.push(`IOC NOT FILLED`);
                await storage.createLog({ type: "order_unfilled", message: `IOC NOT FILLED: [${strategyKey.toUpperCase()}] ${sig.asset.displayName} ${side}`, timestamp: new Date().toISOString() });
                await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: strategyKey });
                continue;
              }
            } catch (execErr) {
              reasoning.push(`ORDER FAILED: ${execErr}`);
              await storage.createLog({ type: "order_error", message: `ORDER FAILED: [${strategyKey.toUpperCase()}] ${sig.asset.displayName} — ${execErr}`, timestamp: new Date().toISOString() });
              await logDecision({ coin: sig.asset.coin, action: "skip", side, price: sig.price, reasoning: reasoning.join(" | "), equity, strategy: strategyKey });
              continue;
            }
          }

          const trade = await storage.createTrade({
            coin: sig.asset.coin, side, entryPrice: sig.price, size: tradeAmountPct, leverage,
            rsiAtEntry: sig.enhanced.triggerRSI, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            stopLoss: sig.enhanced.suggestedSL,
            takeProfit1: sig.enhanced.suggestedTP1,
            takeProfit2: sig.enhanced.suggestedTP2,
            tp1Hit: false,
            confluenceScore: 0,
            confluenceDetails: `${sig.enhanced.triggerType.toUpperCase()}: RSI ${sig.enhanced.triggerRSI.toFixed(1)} on ${sig.enhanced.triggerTF} | BB:${sig.enhanced.bollingerConfirm} Vol:${sig.enhanced.volumeExhaustion} ADX:${sig.enhanced.adxValue.toFixed(1)}(${sig.enhanced.adxRegime}) S/R:${sig.enhanced.srConfirm ? 'CONFIRM' : 'none'} Conf:${sig.enhanced.confidenceScore}/6`,
            riskRewardRatio: 0,
            status: "open",
            reason: `[${strategyKey.toUpperCase()}] ${side.toUpperCase()} | RSI ${sig.enhanced.triggerRSI.toFixed(1)} @${sig.enhanced.triggerTF} | ADX:${sig.enhanced.adxValue.toFixed(0)}(${sig.enhanced.adxRegime}) | S/R:${sig.enhanced.srConfirm ? 'Y' : 'N'} | Conf:${sig.enhanced.confidenceScore}/6 | ${leverage}x MAX | $${capitalForTrade.toFixed(0)}`,
            setupType: strategyKey === "bb_rsi_reversion" ? "bb_rsi_reversion" : "extreme_rsi",
            strategy: strategyKey,
            openedAt: new Date().toISOString(),
          });

          await logDecision({
            tradeId: trade.id, coin: sig.asset.coin, action: "entry", side, price: sig.price,
            rsi1h: sig.rsi1h, rsi4h: sig.rsi4h, rsi1d: sig.rsi1d,
            ema10: sig.ema10, ema21: sig.ema21, ema50: sig.ema50,
            volume24h: sig.volume24h, change24h: sig.change24h,
            fundingRate: sig.fundingRate, openInterest: sig.openInterest,
            reasoning: reasoning.join(" | "), equity, leverage, positionSizeUsd: capitalForTrade,
            strategy: strategyKey,
          });

          await storage.createLog({
            type: "trade_open",
            message: `[${strategyKey.toUpperCase()}] ${side.toUpperCase()} ${sig.asset.displayName} @ $${displayPrice(sig.price, sig.asset.szDecimals)} | ${leverage}x | RSI ${sig.enhanced.triggerRSI.toFixed(1)} @${sig.enhanced.triggerTF} | S/R:${sig.enhanced.srConfirm ? 'CONFIRM' : '-'} | Conf:${sig.enhanced.confidenceScore}/6 | $${capitalForTrade.toFixed(0)}`,
            data: JSON.stringify(trade),
            timestamp: new Date().toISOString(),
          });

          openByCoinStrategy.add(`${sig.asset.coin}_${strategyKey}`);
          slotsUsed++;
          this.dailyTradeCount++;
        }
      }

      // =============================================
      // CHECK EXITS — all strategies, isolated logic
      // =============================================
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

      const rawPnlPctMove = trade.side === "long"
        ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;
      const leveragedPnl = rawPnlPctMove * trade.leverage;
      const tradeCapUsd = currentEquity * (trade.size / 100);
      const pnlUsd = tradeCapUsd * (leveragedPnl / 100);
      // ROI as % of total AUM — this is what we display everywhere
      const pnlOfAum = currentEquity > 0 ? (pnlUsd / currentEquity) * 100 : 0;
      const currentPeak = Math.max(trade.peakPnlPct || 0, leveragedPnl);

      let shouldClose = false;
      let closeReason = "";
      let exitType = "";

      // ============================================================
      // STRATEGY-SPECIFIC EXIT LOGIC
      // ============================================================

      if (strategy === "extreme_rsi" || strategy === "bb_rsi_reversion") {
        // ---- EXTREME RSI / BB REVERSION EXIT RULES ----
        // TP1: hit → move SL to breakeven
        // TP2: full close
        // SL: original 0.25% or breakeven (after TP1)

        const stratLabel = strategy.toUpperCase();

        // TP1 check — move SL to breakeven
        if (!trade.tp1Hit) {
          const tp1Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit1 || Infinity)) ||
                         (trade.side === "short" && currentPrice <= (trade.takeProfit1 || 0));
          if (tp1Hit) {
            const breakEvenSL = trade.entryPrice;
            await storage.updateTrade(trade.id, { tp1Hit: true, stopLoss: breakEvenSL, peakPnlPct: currentPeak, pnl: leveragedPnl, pnlPct: pnlOfAum });
            await logDecision({
              tradeId: trade.id, coin: trade.coin, action: "tp1_hit", side: trade.side as any, price: currentPrice,
              reasoning: `[${stratLabel}] TP1 hit @ $${displayPrice(currentPrice, szd)} | SL moved to BREAKEVEN @ $${displayPrice(breakEvenSL, szd)} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)})`,
              equity: currentEquity, leverage: trade.leverage, strategy,
            });
            await storage.createLog({
              type: "trade_tp1",
              message: `[${stratLabel}] TP1 HIT: ${trade.coin} @ $${displayPrice(currentPrice, szd)} | SL → BREAKEVEN`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // TP2 check — full close
        if (!shouldClose) {
          const tp2Hit = (trade.side === "long" && currentPrice >= (trade.takeProfit2 || Infinity)) ||
                         (trade.side === "short" && currentPrice <= (trade.takeProfit2 || 0));
          if (tp2Hit) { shouldClose = true; closeReason = `[${stratLabel}] TP2 @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`; exitType = "tp2"; }
        }

        // SL check (breakeven after TP1, or original SL before TP1)
        if (!shouldClose) {
          const activeSL = trade.stopLoss;
          if (trade.side === "long" && currentPrice <= (activeSL || 0)) { shouldClose = true; closeReason = `[${stratLabel}] SL @ $${displayPrice(currentPrice, szd)}${trade.tp1Hit ? " (breakeven)" : ""}`; exitType = trade.tp1Hit ? "sl_breakeven" : "sl"; }
          if (trade.side === "short" && currentPrice >= (activeSL || Infinity)) { shouldClose = true; closeReason = `[${stratLabel}] SL @ $${displayPrice(currentPrice, szd)}${trade.tp1Hit ? " (breakeven)" : ""}`; exitType = trade.tp1Hit ? "sl_breakeven" : "sl"; }
        }

      } else {
        // ---- CONFLUENCE EXIT RULES (legacy — for any remaining open confluence trades) ----

        // Progressive SL ratcheting
        const rawPnlPct = rawPnlPctMove;
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
            await storage.updateTrade(trade.id, { stopLoss: newSL, tp1Hit: true, peakPnlPct: currentPeak, pnl: leveragedPnl, pnlPct: pnlOfAum });
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
            await storage.updateTrade(trade.id, { tp1Hit: true, peakPnlPct: currentPeak, pnl: leveragedPnl, pnlPct: pnlOfAum });
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
      // SHARED CLOSE EXECUTION (all strategies)
      // ============================================================

      if (shouldClose) {

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
          exitPrice: currentPrice, pnl: leveragedPnl, pnlPct: pnlOfAum, peakPnlPct: currentPeak,
          status: "closed", closeReason, closedAt: new Date().toISOString(),
        });

        await logDecision({
          tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
          reasoning: `EXIT: ${closeReason} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | ROI/AUM: ${pnlOfAum.toFixed(3)}% | Held: ${trade.openedAt ? Math.round((Date.now() - new Date(trade.openedAt).getTime()) / 60000) : 0}min | Peak: ${currentPeak.toFixed(2)}%`,
          equity: currentEquity, leverage: trade.leverage, strategy,
        });

        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [${strategy.toUpperCase()}] ${trade.side.toUpperCase()} ${trade.coin} | ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | AUM: ${pnlOfAum.toFixed(3)}% | ${closeReason}`,
          timestamp: new Date().toISOString(),
        });
      } else {
        await storage.updateTrade(trade.id, { pnl: leveragedPnl, pnlPct: pnlOfAum, peakPnlPct: currentPeak });
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
    const leveragedPnl = trade.side === "long"
      ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage
      : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100 * trade.leverage;
    const eq = this.lastKnownEquity || 0;
    const tradeCapUsd = eq * (trade.size / 100);
    const pnlUsd = tradeCapUsd * (leveragedPnl / 100);
    // ROI as % of total AUM
    const pnlOfAum = eq > 0 ? (pnlUsd / eq) * 100 : 0;

    const updated = await storage.updateTrade(trade.id, {
      exitPrice: currentPrice, pnl: leveragedPnl, pnlPct: pnlOfAum, status: "closed",
      closeReason: "Manual close", closedAt: new Date().toISOString(),
    });
    await logDecision({
      tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
      reasoning: `MANUAL CLOSE [${strategy.toUpperCase()}] | P&L: ${leveragedPnl.toFixed(2)}% (pos) | ROI/AUM: ${pnlOfAum.toFixed(3)}% | $${pnlUsd.toFixed(2)}`, equity: eq, leverage: trade.leverage, strategy,
    });
    await storage.createLog({
      type: "trade_close",
      message: `Manual close [${strategy.toUpperCase()}] ${trade.side.toUpperCase()} ${trade.coin} | ROI: ${pnlOfAum.toFixed(3)}% ($${pnlUsd.toFixed(2)})`,
      timestamp: new Date().toISOString(),
    });
    return updated;
  }

  async forceScan() { await this.runScanCycle(); }

  getLastKnownEquity(): number {
    return this.lastKnownEquity;
  }

  async resetPnlBaseline(): Promise<{ resetEquity: number; resetTimestamp: string }> {
    const equity = await this.refreshEquity();
    this.pnlResetTimestamp = new Date().toISOString();
    this.pnlResetEquity = equity;
    this.startingEquity = equity;
    this.dayStartEquity = equity;
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
    // Only count trades opened after the P&L reset for the main display
    const resetTs = this.pnlResetTimestamp;
    const activeTrades = resetTs
      ? allTrades.filter(t => t.openedAt >= resetTs)
      : allTrades;
    const activeClosedTrades = activeTrades.filter(t => t.status === "closed");
    const allClosedTrades = allTrades.filter(t => t.status === "closed"); // for all-time stats
    const winTrades = activeClosedTrades.filter(t => (t.pnl || 0) > 0);
    const winRate = activeClosedTrades.length > 0 ? (winTrades.length / activeClosedTrades.length) * 100 : 0;
    const si = getSessionInfo();
    const stats = await getLearningStats();

    const currentEquity = this.lastKnownEquity || 0;
    const startEq = this.pnlResetEquity || this.startingEquity || currentEquity;

    const closedPnlOfAum = activeClosedTrades.reduce((s, t) => {
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
    // Drawdown from day start
    const drawdownPct = this.dayStartEquity > 0 ? ((this.dayStartEquity - currentEquity) / this.dayStartEquity) * 100 : 0;
    const drawdownUsd = this.dayStartEquity - currentEquity;

    // Per-trade dollar P&L for open positions
    // pnl = leveraged position P&L %, pnlPct = ROI as % of AUM
    const openTradesWithUsd = openTrades.map(t => {
      const tradeCapUsd = currentEquity * ((t.size || 10) / 100);
      const pnlUsd = tradeCapUsd * ((t.pnl || 0) / 100);
      // Also compute pnlOfAum for display (in case pnlPct not yet updated on open trades)
      const pnlOfAum = currentEquity > 0 ? (pnlUsd / currentEquity) * 100 : 0;
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)) };
    });

    // Per-strategy stats (using post-reset trades only)
    const closedTrades = activeClosedTrades; // alias for strategy breakdown
    const confluenceTrades = closedTrades.filter(t => (t.strategy || "confluence") === "confluence");
    const extremeTrades = closedTrades.filter(t => t.strategy === "extreme_rsi");
    const bbReversionTrades = closedTrades.filter(t => t.strategy === "bb_rsi_reversion");
    const confluenceWinRate = confluenceTrades.length > 0 ? (confluenceTrades.filter(t => (t.pnl || 0) > 0).length / confluenceTrades.length) * 100 : 0;
    const extremeWinRate = extremeTrades.length > 0 ? (extremeTrades.filter(t => (t.pnl || 0) > 0).length / extremeTrades.length) * 100 : 0;
    const bbReversionWinRate = bbReversionTrades.length > 0 ? (bbReversionTrades.filter(t => (t.pnl || 0) > 0).length / bbReversionTrades.length) * 100 : 0;

    // Per-strategy P&L: use pnl (leveraged %) * posWeight to get AUM %, then convert to USD
    const strategyPnlCalc = (trades: typeof closedTrades) => {
      const pnlOfAumPct = trades.reduce((s, t) => s + ((t.pnl || 0) * ((t.size || 10) / 100)), 0);
      const pnlUsd = startEq > 0 ? startEq * (pnlOfAumPct / 100) : 0;
      return { pnlOfAumPct, pnlUsd };
    };
    const confluenceStats = strategyPnlCalc(confluenceTrades);
    const extremeStats = strategyPnlCalc(extremeTrades);
    const bbReversionStats = strategyPnlCalc(bbReversionTrades);
    const confluencePnlUsd = confluenceStats.pnlUsd;
    const extremePnlUsd = extremeStats.pnlUsd;
    const bbReversionPnlUsd = bbReversionStats.pnlUsd;

    return {
      isRunning: config?.isRunning || false,
      openPositions: openTrades.length,
      totalTrades: activeTrades.length,
      totalTradesAllTime: allTrades.length,
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
      drawdownPct: drawdownPct.toFixed(2),
      drawdownUsd: drawdownUsd.toFixed(4),
      drawdownPaused: this.drawdownPaused,
      dayStartEquity: this.dayStartEquity.toFixed(2),
      dailyTradeCount: this.dailyTradeCount,
      dailyTradeTarget: 20,
      equity: currentEquity.toFixed(2),
      startingEquity: startEq.toFixed(2),
      pnlResetTimestamp: this.pnlResetTimestamp || null,
      learningStats: stats,
      allowedAssets: ALLOWED_ASSETS.map(a => ({ coin: a.coin, name: a.displayName, category: a.category, maxLev: a.maxLeverage })),
      openTradesWithUsd,
      // Per-strategy breakdown (post-reset only)
      strategyStats: {
        confluence: { trades: confluenceTrades.length, winRate: confluenceWinRate.toFixed(1), openPositions: openTrades.filter(t => (t.strategy || "confluence") === "confluence").length, pnlUsd: confluencePnlUsd.toFixed(4), pnlOfAum: confluenceStats.pnlOfAumPct.toFixed(3), status: "disabled" },
        extreme_rsi: { trades: extremeTrades.length, winRate: extremeWinRate.toFixed(1), openPositions: openTrades.filter(t => t.strategy === "extreme_rsi").length, pnlUsd: extremePnlUsd.toFixed(4), pnlOfAum: extremeStats.pnlOfAumPct.toFixed(3), status: "active" },
        bb_rsi_reversion: { trades: bbReversionTrades.length, winRate: bbReversionWinRate.toFixed(1), openPositions: openTrades.filter(t => t.strategy === "bb_rsi_reversion").length, pnlUsd: bbReversionPnlUsd.toFixed(4), pnlOfAum: bbReversionStats.pnlOfAumPct.toFixed(3), status: "active" },
      },
      // S/R levels per asset (from last scan)
      srLevels: Object.fromEntries(
        Object.entries(this.latestSRLevels).map(([coin, sr]) => [
          coin,
          {
            nearestSupport: sr.nearestSupport ? { price: sr.nearestSupport.price, strength: sr.nearestSupport.strength, touches: sr.nearestSupport.touches } : null,
            nearestResistance: sr.nearestResistance ? { price: sr.nearestResistance.price, strength: sr.nearestResistance.strength, touches: sr.nearestResistance.touches } : null,
            atSupport: sr.atSupport,
            atResistance: sr.atResistance,
            levels: sr.levels.slice(0, 6).map(l => ({ price: l.price, type: l.type, strength: l.strength, touches: l.touches })),
          },
        ])
      ),
    };
  }
}

export const tradingEngine = new TradingEngine();
