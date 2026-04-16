/**
 * HyperTrader — Trading Engine v11.0
 *
 * MULTI-ASSET: Crypto + HIP-3 TradFi (Gold, Silver, Oil, S&P 500, EUR/USD)
 *
 * PURE RSI STRATEGY:
 *   - LONG when 5m or 15m RSI ≤ 16 → instant market buy
 *   - SHORT when 5m or 15m RSI ≥ 85 → instant market sell
 *   - NO STOP LOSS
 *   - TP: +0.5% from entry (full close)
 *   - 80% margin, max leverage per asset
 *   - All 9 assets: BTC, ETH, SOL, XRP, GOLD, SILVER, OIL, SP500, EUR
 *   - Scan every 5 seconds
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
  // === CRYPTO (main perps dex) ===
  { coin: "BTC",  displayName: "Bitcoin",    dex: "",    maxLeverage: 40, szDecimals: 5, category: "crypto",    minNotional: 10 },
  { coin: "ETH",  displayName: "Ethereum",   dex: "",    maxLeverage: 25, szDecimals: 4, category: "crypto",    minNotional: 10 },
  { coin: "SOL",  displayName: "Solana",     dex: "",    maxLeverage: 20, szDecimals: 2, category: "crypto",    minNotional: 10 },
  { coin: "XRP",  displayName: "XRP",        dex: "",    maxLeverage: 20, szDecimals: 0, category: "crypto",    minNotional: 10 },
  // === HIP-3 TradFi (xyz perp dex) ===
  { coin: "xyz:GOLD",     displayName: "Gold",         dex: "xyz", maxLeverage: 25, szDecimals: 4, category: "commodity", minNotional: 10 },
  { coin: "xyz:SILVER",   displayName: "Silver",       dex: "xyz", maxLeverage: 25, szDecimals: 2, category: "commodity", minNotional: 10 },
  { coin: "xyz:CL",       displayName: "WTI Oil",      dex: "xyz", maxLeverage: 20, szDecimals: 3, category: "commodity", minNotional: 10, isolatedOnly: true },
  { coin: "xyz:SP500",    displayName: "S&P 500",      dex: "xyz", maxLeverage: 50, szDecimals: 3, category: "index",     minNotional: 10 },
  { coin: "xyz:EUR",      displayName: "EUR/USD",      dex: "xyz", maxLeverage: 50, szDecimals: 1, category: "forex",     minNotional: 10, isolatedOnly: true },
];

// ============ STRATEGY TYPES ============
type StrategyType = "confluence" | "extreme_rsi" | "bb_rsi_reversion" | "breakout_retest";

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

/**
 * Calculate full RSI series (for pattern detection like double bottom/top).
 * Returns array of RSI values aligned with closes (first `period` entries are null).
 */
function calculateRSISeries(closes: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = new Array(period + 1).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
    result.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  }
  return result;
}

/**
 * v10.7.3: Detect double bottom or double top on RSI + price.
 * 
 * Double Bottom (bullish): Two RSI troughs at similar levels in oversold territory,
 * with price making equal or lower lows. Shows selling exhaustion → reversal likely.
 * 
 * Double Top (bearish): Two RSI peaks at similar levels in overbought territory,
 * with price making equal or higher highs. Shows buying exhaustion → reversal likely.
 * 
 * @param closes - 5m close prices (100 bars)
 * @param rsiSeries - pre-calculated RSI series aligned with closes
 * @param currentPrice - live price
 * @param lookback - how many bars back to search (default 30 = 2.5h on 5m)
 * @returns { hasDoubleBottom, hasDoubleTop, bottomRSI, topRSI, details }
 */
function detectDoubleBottomTop(
  closes: number[],
  rsiSeries: (number | null)[],
  currentPrice: number,
  lookback: number = 30,
): { hasDoubleBottom: boolean; hasDoubleTop: boolean; bottomRSI: number; topRSI: number; details: string } {
  const noResult = { hasDoubleBottom: false, hasDoubleTop: false, bottomRSI: 0, topRSI: 100, details: "" };
  if (rsiSeries.length < lookback || closes.length < lookback) return noResult;

  const len = rsiSeries.length;
  const startIdx = len - lookback;

  // --- Find RSI troughs (local minima) in the lookback window ---
  const troughs: { idx: number; rsi: number; price: number }[] = [];
  const peaks: { idx: number; rsi: number; price: number }[] = [];

  for (let i = startIdx + 1; i < len - 1; i++) {
    const prev = rsiSeries[i - 1];
    const curr = rsiSeries[i];
    const next = rsiSeries[i + 1];
    if (prev === null || curr === null || next === null) continue;

    // Trough: RSI goes down then up, and RSI is in oversold-ish territory (< 40)
    if (curr < prev && curr < next && curr < 40) {
      troughs.push({ idx: i, rsi: curr, price: closes[i] });
    }
    // Peak: RSI goes up then down, and RSI is in overbought-ish territory (> 60)
    if (curr > prev && curr > next && curr > 60) {
      peaks.push({ idx: i, rsi: curr, price: closes[i] });
    }
  }

  let hasDoubleBottom = false;
  let bottomRSI = 0;
  let bottomDetails = "";

  // --- Double Bottom: two troughs with similar RSI, separated by at least 5 bars ---
  // The second trough should be the more recent one (closer to current bar)
  // RSI tolerance: within 5 points. Price: second low must be within 0.5% of first (or lower)
  for (let a = 0; a < troughs.length - 1; a++) {
    for (let b = a + 1; b < troughs.length; b++) {
      const t1 = troughs[a], t2 = troughs[b];
      const barGap = t2.idx - t1.idx;
      if (barGap < 5) continue; // need separation (25 min on 5m)
      if (barGap > 25) continue; // not too far apart

      const rsiDiff = Math.abs(t1.rsi - t2.rsi);
      // RSI tolerance: scale with how deep the RSI is
      // Below 30: allow 5pt tolerance. 30-40: allow 3pt.
      const avgRSI = (t1.rsi + t2.rsi) / 2;
      const rsiTolerance = avgRSI < 30 ? 5 : 3;
      if (rsiDiff > rsiTolerance) continue;

      // Price: second low within 0.5% of first (roughly equal or lower)
      const priceDiff = Math.abs(t2.price - t1.price) / t1.price;
      if (priceDiff > 0.005) continue;

      // Between the two troughs, RSI must have bounced up at least 8 points (real valley between them)
      let maxBetween = 0;
      for (let k = t1.idx + 1; k < t2.idx; k++) {
        if (rsiSeries[k] !== null && rsiSeries[k]! > maxBetween) maxBetween = rsiSeries[k]!;
      }
      if (maxBetween - Math.min(t1.rsi, t2.rsi) < 8) continue;

      hasDoubleBottom = true;
      bottomRSI = Math.min(t1.rsi, t2.rsi);
      bottomDetails = `DB: RSI ${t1.rsi.toFixed(1)}→${maxBetween.toFixed(0)}→${t2.rsi.toFixed(1)} | Price $${t1.price.toFixed(0)}/$${t2.price.toFixed(0)} | gap:${barGap}bars`;
      break;
    }
    if (hasDoubleBottom) break;
  }

  let hasDoubleTop = false;
  let topRSI = 100;
  let topDetails = "";

  // --- Double Top: two peaks with similar RSI, separated by at least 5 bars ---
  for (let a = 0; a < peaks.length - 1; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const p1 = peaks[a], p2 = peaks[b];
      const barGap = p2.idx - p1.idx;
      if (barGap < 5) continue;
      if (barGap > 25) continue;

      const rsiDiff = Math.abs(p1.rsi - p2.rsi);
      const avgRSI = (p1.rsi + p2.rsi) / 2;
      const rsiTolerance = avgRSI > 75 ? 5 : 3;
      if (rsiDiff > rsiTolerance) continue;

      const priceDiff = Math.abs(p2.price - p1.price) / p1.price;
      if (priceDiff > 0.005) continue;

      // Between the two peaks, RSI must have dipped at least 8 points
      let minBetween = 100;
      for (let k = p1.idx + 1; k < p2.idx; k++) {
        if (rsiSeries[k] !== null && rsiSeries[k]! < minBetween) minBetween = rsiSeries[k]!;
      }
      if (Math.max(p1.rsi, p2.rsi) - minBetween < 8) continue;

      hasDoubleTop = true;
      topRSI = Math.max(p1.rsi, p2.rsi);
      topDetails = `DT: RSI ${p1.rsi.toFixed(1)}→${minBetween.toFixed(0)}→${p2.rsi.toFixed(1)} | Price $${p1.price.toFixed(0)}/$${p2.price.toFixed(0)} | gap:${barGap}bars`;
      break;
    }
    if (hasDoubleTop) break;
  }

  return {
    hasDoubleBottom,
    hasDoubleTop,
    bottomRSI,
    topRSI,
    details: [bottomDetails, topDetails].filter(Boolean).join(" | "),
  };
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

// ============ TRENDLINE BREAKOUT / RETEST DETECTION ============

interface Trendline {
  type: "descending" | "ascending";
  startIdx: number;
  endIdx: number;
  startPrice: number;
  endPrice: number;
  slope: number;         // price change per bar
  touches: number;       // how many swing points touch the line
  strength: number;      // 1-5
}

interface BreakoutRetestResult {
  triggered: boolean;
  signal: "long" | "short" | "none";
  trendlineType: "descending" | "ascending" | "none";
  trendlineValueAtBreak: number;  // trendline price at breakout bar
  trendlineValueNow: number;      // trendline price at current bar
  retestPrice: number;
  barsSinceBreakout: number;
  trendlineTouches: number;
  trendlineStrength: number;
  rejectionConfirm: boolean;
  confidenceScore: number;  // 1-5
  triggerTF: string;
  suggestedSL: number;
  suggestedTP1: number;
  suggestedTP2: number;
  // v10.6: TL signature for blacklisting failed setups
  tlSignature: { type: string; startPrice: number; slope: number };
}

/** Get the trendline price at a given candle index using linear projection */
function trendlineAt(tl: Trendline, idx: number): number {
  return tl.startPrice + tl.slope * (idx - tl.startIdx);
}

/**
 * v10.6 OVERHAUL — Detect REAL trendlines only.
 *
 * A real trendline (from user's chart examples):
 *   1. Must span at least 20 candles on the 5m timeframe
 *   2. Must have at least 2 clear rejections (price touches TL and bounces back)
 *   3. The TL must have HELD as support/resistance — no candle body closed beyond it
 *   4. Only on the 3rd+ touch or later does it break through
 *   5. Then we wait for the retest
 *
 * Descending TL: 2+ swing HIGHS forming lower highs, well spaced apart
 * Ascending TL: 2+ swing LOWS forming higher lows, well spaced apart
 */
function detectTrendlines(candles: OHLCVCandle[], pivotWindow: number = 3): Trendline[] {
  if (candles.length < pivotWindow * 2 + 20) return [];

  // Find swing highs and swing lows with proper pivot window
  const swingHighs: { idx: number; price: number }[] = [];
  const swingLows: { idx: number; price: number }[] = [];

  for (let i = pivotWindow; i < candles.length - pivotWindow; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= pivotWindow; j++) {
      if (candles[i - j].high >= candles[i].high || candles[i + j].high >= candles[i].high) isHigh = false;
      if (candles[i - j].low <= candles[i].low || candles[i + j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) swingHighs.push({ idx: i, price: candles[i].high });
    if (isLow) swingLows.push({ idx: i, price: candles[i].low });
  }

  // QUALITY FILTER: Remove pivots that are too close together (keep the most significant one)
  // Minimum spacing: 8 bars apart (40 min on 5m) — pivots must be real, not noise
  const MIN_PIVOT_SPACING = 8;
  function filterPivots(pivots: { idx: number; price: number }[], keepHigher: boolean): typeof pivots {
    if (pivots.length <= 1) return pivots;
    const filtered: typeof pivots = [pivots[0]];
    for (let i = 1; i < pivots.length; i++) {
      const last = filtered[filtered.length - 1];
      if (pivots[i].idx - last.idx < MIN_PIVOT_SPACING) {
        // Too close — keep the more extreme one
        if (keepHigher ? pivots[i].price > last.price : pivots[i].price < last.price) {
          filtered[filtered.length - 1] = pivots[i];
        }
      } else {
        filtered.push(pivots[i]);
      }
    }
    return filtered;
  }

  const cleanHighs = filterPivots(swingHighs, true);
  const cleanLows = filterPivots(swingLows, false);

  const trendlines: Trendline[] = [];
  const tolerancePct = 0.0015; // 0.15% tolerance for "touching" the trendline (tighter = cleaner lines)
  const MIN_PRICE_RANGE_PCT = 0.008; // v10.6.6: TL must span at least 0.8% in price — only real structural TLs

  // Build DESCENDING trendlines from swing highs (lower highs)
  for (let a = 0; a < cleanHighs.length - 1; a++) {
    for (let b = a + 1; b < cleanHighs.length; b++) {
      const p1 = cleanHighs[a], p2 = cleanHighs[b];
      if (p2.price >= p1.price) continue; // must be descending
      if (p2.idx - p1.idx < 20) continue;  // v10.6: minimum 20 candles — real trendlines only
      if (Math.abs(p2.price - p1.price) / p1.price < MIN_PRICE_RANGE_PCT) continue; // skip micro TLs

      const slope = (p2.price - p1.price) / (p2.idx - p1.idx);

      // Count touches (p1 and p2 are the anchor points, count additional touches)
      let touches = 2;
      for (let c = 0; c < cleanHighs.length; c++) {
        if (c === a || c === b) continue;
        const expected = p1.price + slope * (cleanHighs[c].idx - p1.idx);
        if (Math.abs(cleanHighs[c].price - expected) / expected <= tolerancePct) touches++;
      }

      // v10.6.3: MINIMUM 2 touches (rejections) required — TL can break on 3rd touch
      if (touches < 2) continue;

      // VALIDITY CHECK: no candle body should have CLOSED above the TL between p1 and p2
      // (the TL must have held as resistance until the actual breakout)
      let tlHeld = true;
      for (let i = p1.idx + 1; i <= p2.idx; i++) {
        const tlVal = p1.price + slope * (i - p1.idx);
        if (candles[i].close > tlVal * (1 + tolerancePct)) { tlHeld = false; break; }
      }
      if (!tlHeld) continue;

      let strength = Math.min(touches, 3);
      if (p2.idx - p1.idx >= 30) strength++;  // bonus for longer TLs (30+ candles = 2.5h on 5m)
      if (touches >= 4) strength++;            // bonus for 4+ rejections
      strength = Math.min(strength, 5);

      trendlines.push({
        type: "descending", startIdx: p1.idx, endIdx: p2.idx,
        startPrice: p1.price, endPrice: p2.price, slope, touches, strength,
      });
    }
  }

  // Build ASCENDING trendlines from swing lows (higher lows)
  for (let a = 0; a < cleanLows.length - 1; a++) {
    for (let b = a + 1; b < cleanLows.length; b++) {
      const p1 = cleanLows[a], p2 = cleanLows[b];
      if (p2.price <= p1.price) continue; // must be ascending
      if (p2.idx - p1.idx < 20) continue;  // v10.6: minimum 20 candles — real trendlines only
      if (Math.abs(p2.price - p1.price) / p1.price < MIN_PRICE_RANGE_PCT) continue; // skip micro TLs

      const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
      let touches = 2;
      for (let c = 0; c < cleanLows.length; c++) {
        if (c === a || c === b) continue;
        const expected = p1.price + slope * (cleanLows[c].idx - p1.idx);
        if (Math.abs(cleanLows[c].price - expected) / expected <= tolerancePct) touches++;
      }

      // v10.6.3: MINIMUM 2 touches (rejections) required — TL can break on 3rd touch
      if (touches < 2) continue;

      // VALIDITY CHECK: no candle body should have CLOSED below the TL between p1 and p2
      let tlHeld = true;
      for (let i = p1.idx + 1; i <= p2.idx; i++) {
        const tlVal = p1.price + slope * (i - p1.idx);
        if (candles[i].close < tlVal * (1 - tolerancePct)) { tlHeld = false; break; }
      }
      if (!tlHeld) continue;

      let strength = Math.min(touches, 3);
      if (p2.idx - p1.idx >= 30) strength++;  // bonus for longer TLs
      if (touches >= 4) strength++;            // bonus for 4+ rejections
      strength = Math.min(strength, 5);

      trendlines.push({
        type: "ascending", startIdx: p1.idx, endIdx: p2.idx,
        startPrice: p1.price, endPrice: p2.price, slope, touches, strength,
      });
    }
  }

  // Sort by strength desc, keep top candidates
  trendlines.sort((a, b) => b.strength - a.strength || b.touches - a.touches);
  return trendlines.slice(0, 10);
}

/**
 * v10.4 OVERHAUL — Trendline Break + Retest + 1m Reaction.
 *
 * The pattern (from user chart examples):
 *   1. Build clean trendlines on 5m/15m
 *   2. Price BREAKS through the trendline (close beyond it)
 *   3. Price comes BACK to retest the trendline
 *   4. On the 1m timeframe, a candle REACTS off the trendline
 *      (wick touches TL, body closes away = rejection candle)
 *   5. ENTER in the direction dictated by the TL polarity flip:
 *      - Descending TL broken upward → retest from above → LONG ONLY
 *      - Ascending TL broken downward → retest from below → SHORT ONLY
 *      - NEVER the other way around
 *   6. 1m reaction candle must CONFIRM the expected direction
 *   7. SL: as wide as safely possible (recent swing extreme beyond the TL)
 *   8. TP: standard 0.3% TP1 → BE → dynamic TP2
 */
function detectBreakoutRetest(
  candles: OHLCVCandle[],
  currentPrice: number,
  tf: string,
  candles1m: OHLCVCandle[],   // 1m OHLCV for reaction confirmation
  retestTolerance: number = 0.001,  // 0.1% proximity to trendline
  maxBreakoutAge: number = 30,
): BreakoutRetestResult {
  const noResult: BreakoutRetestResult = {
    triggered: false, signal: "none", trendlineType: "none",
    trendlineValueAtBreak: 0, trendlineValueNow: 0, retestPrice: currentPrice,
    barsSinceBreakout: 0, trendlineTouches: 0, trendlineStrength: 0,
    rejectionConfirm: false, confidenceScore: 0, triggerTF: tf,
    suggestedSL: 0, suggestedTP1: 0, suggestedTP2: 0,
    tlSignature: { type: "none", startPrice: 0, slope: 0 },
  };

  if (candles.length < 30) return noResult;

  const trendlines = detectTrendlines(candles, 3);
  if (trendlines.length === 0) return noResult;

  const candidates: BreakoutRetestResult[] = [];
  const lastIdx = candles.length - 1;

  for (const tl of trendlines) {
    // Find the breakout candle: the FIRST close beyond the trendline after TL end
    let breakoutIdx = -1;
    const scanStart = Math.max(tl.endIdx + 1, lastIdx - maxBreakoutAge - 10);

    for (let i = scanStart; i <= lastIdx; i++) {
      const tlValue = trendlineAt(tl, i);
      const c = candles[i];

      if (tl.type === "descending") {
        // Breakout upward: candle closes ABOVE descending TL
        if (c.close > tlValue * (1 + 0.001)) {
          breakoutIdx = i;
          break;
        }
      } else {
        // Breakout downward: candle closes BELOW ascending TL
        if (c.close < tlValue * (1 - 0.001)) {
          breakoutIdx = i;
          break;
        }
      }
    }

    if (breakoutIdx === -1) continue;

    const barsSinceBreak = lastIdx - breakoutIdx;
    if (barsSinceBreak < 1 || barsSinceBreak > maxBreakoutAge) continue;

    // Current trendline value (projected to the current bar)
    const tlValueNow = trendlineAt(tl, lastIdx);
    const tlValueAtBreak = trendlineAt(tl, breakoutIdx);

    // How close is the current price to the trendline?
    const distToTL = Math.abs(currentPrice - tlValueNow) / tlValueNow;

    // Price must be near the trendline (within tolerance) for a retest
    if (distToTL > retestTolerance) continue;

    // VERIFY: After breakout, price must have moved away from the TL at some point
    // then come back to it (a real retest, not just hovering at the break level)
    let maxMoveAway = 0;
    for (let i = breakoutIdx + 1; i <= lastIdx; i++) {
      const tlv = trendlineAt(tl, i);
      const distUp = (candles[i].close - tlv) / tlv;
      const distDown = (tlv - candles[i].close) / tlv;
      const dist = Math.max(distUp, distDown);
      if (dist > maxMoveAway) maxMoveAway = dist;
    }
    // Must have moved at least 0.1% away from TL before coming back
    if (maxMoveAway < 0.001) continue;

    // === 1-MINUTE REACTION CANDLE CONFIRMATION ===
    // Look at the last 3 completed 1m candles for a clear reaction off the TL
    // A reaction candle: wick touches/crosses TL, body closes AWAY from it
    let signal: "long" | "short" | "none" = "none";
    let rejectionConfirm = false;
    const lookback1m = Math.min(3, candles1m.length - 1); // check last 3 completed 1m candles

    for (let k = candles1m.length - 2; k >= Math.max(0, candles1m.length - 1 - lookback1m); k--) {
      const c1 = candles1m[k];
      // Bullish reaction: wick dipped to/below TL, closed above it (bounce UP)
      const wickTouchedBelow = c1.low <= tlValueNow * (1 + 0.001);
      const closedAbove = c1.close > tlValueNow && c1.close > c1.open; // green candle closing above TL
      const bullishBody = c1.close - c1.open > 0; // green candle
      const bullishWickRatio = bullishBody ? (c1.close - c1.open) / (c1.high - c1.low + 1e-10) : 0;

      // Bearish reaction: wick reached up to/above TL, closed below it (rejection DOWN)
      const wickTouchedAbove = c1.high >= tlValueNow * (1 - 0.001);
      const closedBelow = c1.close < tlValueNow && c1.close < c1.open; // red candle closing below TL
      const bearishBody = c1.open - c1.close > 0; // red candle

      if (wickTouchedBelow && closedAbove && bullishBody) {
        signal = "long";
        rejectionConfirm = true;
        break;
      }
      if (wickTouchedAbove && closedBelow && bearishBody) {
        signal = "short";
        rejectionConfirm = true;
        break;
      }
    }

    // No 1m reaction candle found → skip this trendline
    if (signal === "none" || !rejectionConfirm) continue;

    // === DIRECTION RULE (strict) ===
    // Descending TL broken upward → retest from above → LONG ONLY
    // Ascending TL broken downward → retest from below → SHORT ONLY
    // Never the other way around.
    if (tl.type === "descending" && signal !== "long") continue;
    if (tl.type === "ascending" && signal !== "short") continue;

    // Confidence scoring
    let conf = 2; // base: TL exists + break + retest + 1m reaction = already strong
    if (tl.strength >= 3) conf++;
    if (tl.touches >= 3) conf++;
    if (barsSinceBreak >= 3) conf++; // not too fresh
    conf = Math.min(conf, 5);

    // === WIDE SL: find the furthest safe level ===
    // Look for recent swing extreme beyond the TL in the last 20 higher-TF candles
    const slScanBars = Math.min(20, candles.length);
    let wideSL: number;
    if (signal === "long") {
      // SL below: find the lowest low in recent candles that's below the TL
      let lowestLow = tlValueNow;
      for (let i = lastIdx; i >= Math.max(0, lastIdx - slScanBars); i--) {
        if (candles[i].low < lowestLow) lowestLow = candles[i].low;
      }
      wideSL = lowestLow * 0.999; // tiny buffer below the swing low
    } else {
      // SL above: find the highest high in recent candles that's above the TL
      let highestHigh = tlValueNow;
      for (let i = lastIdx; i >= Math.max(0, lastIdx - slScanBars); i--) {
        if (candles[i].high > highestHigh) highestHigh = candles[i].high;
      }
      wideSL = highestHigh * 1.001; // tiny buffer above the swing high
    }

    // v10.6: SL capped at 0.50% of position — hard max
    const maxSlDist = tlValueNow * 0.005;
    if (Math.abs(wideSL - tlValueNow) > maxSlDist) {
      wideSL = signal === "long" ? tlValueNow - maxSlDist : tlValueNow + maxSlDist;
    }
    // Minimum SL distance: at least 0.3% from TL entry to avoid getting stopped on noise
    const minSlDist = tlValueNow * 0.003;
    if (Math.abs(wideSL - tlValueNow) < minSlDist) {
      wideSL = signal === "long" ? tlValueNow - minSlDist : tlValueNow + minSlDist;
    }

    // v10.6: TP1 0.35%, TP2 1% — TL value as entry basis
    const entryAtTL = tlValueNow;
    const tp1Pct = 0.0035;
    const tp2Pct = 0.01;

    let tp1: number, tp2: number;
    if (signal === "long") {
      tp1 = entryAtTL * (1 + tp1Pct);
      tp2 = entryAtTL * (1 + tp2Pct);
    } else {
      tp1 = entryAtTL * (1 - tp1Pct);
      tp2 = entryAtTL * (1 - tp2Pct);
    }

    candidates.push({
      triggered: true, signal, trendlineType: tl.type,
      trendlineValueAtBreak: tlValueAtBreak, trendlineValueNow: tlValueNow,
      retestPrice: currentPrice, barsSinceBreakout: barsSinceBreak,
      trendlineTouches: tl.touches, trendlineStrength: tl.strength,
      rejectionConfirm, confidenceScore: conf, triggerTF: tf,
      suggestedSL: wideSL, suggestedTP1: tp1, suggestedTP2: tp2,
      tlSignature: { type: tl.type, startPrice: tl.startPrice, slope: tl.slope },
    });
  }

  if (candidates.length === 0) return noResult;

  // Sort by confidence, then by how close price is to the TL (closer = better entry)
  candidates.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    const distA = Math.abs(a.retestPrice - a.trendlineValueNow) / a.trendlineValueNow;
    const distB = Math.abs(b.retestPrice - b.trendlineValueNow) / b.trendlineValueNow;
    return distA - distB;
  });
  return candidates[0];
}

// ============ DYNAMIC TP2 DETERMINATION ============
// After TP1 hit, scan price structure to find optimal exit:
// 1. Nearest S/R level in the direction of the trade
// 2. Recent swing high/low from 5m/15m candles
// 3. Bollinger Band middle or opposite band
// 4. Fallback: 0.5% from entry if nothing found
function determineDynamicTP2(params: {
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  ohlcv5m: Array<{ open: number; high: number; low: number; close: number }>;
  ohlcv15m: Array<{ open: number; high: number; low: number; close: number }>;
  bb15m: { upper: number; middle: number; lower: number; stdDev: number };
  srLevels: Array<{ price: number; strength: number; type: string }>;
}): { tp2: number; reason: string } {
  const { side, entryPrice, currentPrice, ohlcv5m, ohlcv15m, bb15m, srLevels } = params;
  const candidates: Array<{ price: number; reason: string; priority: number }> = [];

  // 1. S/R levels in the trade direction (strongest signal)
  if (srLevels && srLevels.length > 0) {
    for (const sr of srLevels) {
      if (side === "long" && sr.price > currentPrice && sr.price > entryPrice) {
        // Resistance above — natural exit for longs
        candidates.push({ price: sr.price * 0.999, reason: `S/R resistance @ $${sr.price.toFixed(0)} (str:${sr.strength})`, priority: sr.strength >= 3 ? 1 : 2 });
      } else if (side === "short" && sr.price < currentPrice && sr.price < entryPrice) {
        // Support below — natural exit for shorts
        candidates.push({ price: sr.price * 1.001, reason: `S/R support @ $${sr.price.toFixed(0)} (str:${sr.strength})`, priority: sr.strength >= 3 ? 1 : 2 });
      }
    }
  }

  // 2. Recent swing highs/lows from 15m candles (last 30 candles)
  const swingCandles = ohlcv15m.slice(-30);
  if (swingCandles.length >= 5) {
    for (let i = 2; i < swingCandles.length - 2; i++) {
      const c = swingCandles[i];
      if (side === "long") {
        // Swing high = potential resistance
        if (c.high > swingCandles[i-1].high && c.high > swingCandles[i-2].high &&
            c.high > swingCandles[i+1].high && c.high > swingCandles[i+2].high &&
            c.high > currentPrice && c.high > entryPrice) {
          candidates.push({ price: c.high * 0.999, reason: `15m swing high @ $${c.high.toFixed(0)}`, priority: 3 });
        }
      } else {
        // Swing low = potential support
        if (c.low < swingCandles[i-1].low && c.low < swingCandles[i-2].low &&
            c.low < swingCandles[i+1].low && c.low < swingCandles[i+2].low &&
            c.low < currentPrice && c.low < entryPrice) {
          candidates.push({ price: c.low * 1.001, reason: `15m swing low @ $${c.low.toFixed(0)}`, priority: 3 });
        }
      }
    }
  }

  // 3. Also check 5m swings for closer targets
  const swing5m = ohlcv5m.slice(-40);
  if (swing5m.length >= 5) {
    for (let i = 2; i < swing5m.length - 2; i++) {
      const c = swing5m[i];
      if (side === "long") {
        if (c.high > swing5m[i-1].high && c.high > swing5m[i-2].high &&
            c.high > swing5m[i+1].high && c.high > swing5m[i+2].high &&
            c.high > currentPrice && c.high > entryPrice) {
          candidates.push({ price: c.high * 0.999, reason: `5m swing high @ $${c.high.toFixed(0)}`, priority: 4 });
        }
      } else {
        if (c.low < swing5m[i-1].low && c.low < swing5m[i-2].low &&
            c.low < swing5m[i+1].low && c.low < swing5m[i+2].low &&
            c.low < currentPrice && c.low < entryPrice) {
          candidates.push({ price: c.low * 1.001, reason: `5m swing low @ $${c.low.toFixed(0)}`, priority: 4 });
        }
      }
    }
  }

  // 4. Bollinger Band targets
  if (bb15m.stdDev > 0) {
    if (side === "long" && bb15m.upper > currentPrice) {
      candidates.push({ price: bb15m.upper * 0.999, reason: `BB upper band @ $${bb15m.upper.toFixed(0)}`, priority: 5 });
    } else if (side === "short" && bb15m.lower < currentPrice) {
      candidates.push({ price: bb15m.lower * 1.001, reason: `BB lower band @ $${bb15m.lower.toFixed(0)}`, priority: 5 });
    }
    // BB middle as conservative target
    if (side === "long" && bb15m.middle > currentPrice && bb15m.middle > entryPrice) {
      candidates.push({ price: bb15m.middle, reason: `BB middle @ $${bb15m.middle.toFixed(0)}`, priority: 6 });
    } else if (side === "short" && bb15m.middle < currentPrice && bb15m.middle < entryPrice) {
      candidates.push({ price: bb15m.middle, reason: `BB middle @ $${bb15m.middle.toFixed(0)}`, priority: 6 });
    }
  }

  // Filter: TP2 must be profitable (better than entry)
  const profitable = candidates.filter(c => {
    if (side === "long") return c.price > entryPrice * 1.001; // at least 0.1% profit
    return c.price < entryPrice * 0.999;
  });

  // Sort by priority (lower = better), then by distance from current price (nearest first for same priority)
  profitable.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const distA = Math.abs(a.price - currentPrice);
    const distB = Math.abs(b.price - currentPrice);
    return distA - distB;
  });

  if (profitable.length > 0) {
    return { tp2: profitable[0].price, reason: profitable[0].reason };
  }

  // Fallback: 0.5% from entry
  const fallbackTp2 = side === "long" ? entryPrice * 1.005 : entryPrice * 0.995;
  return { tp2: fallbackTp2, reason: `Fallback 0.5% from entry` };
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

  // ---- Trigger A: Extreme RSI — DISABLED (data analysis: -$48.60 across 103 trades, negative EV) ----
  // The extreme_rsi/confluence strategy had 57% win rate but wins avg $1.12 vs losses avg $2.23
  // Fired too often on noise, both directions. Responsible for 89% of all losses.
  // Keeping the code for reference but forcing signal to "none"
  const triggerASignal: "long" | "short" | "none" = "none";
  const triggerATF = "";
  const triggerARSI = 0;

  // ---- Trigger B: Bollinger Band Reversion (NEW) ----
  let triggerBSignal: "long" | "short" | "none" = "none";
  let triggerBTF = "";
  let triggerBRSI = 0;

  // RSI REVERSAL: LONG when RSI ≤ 25 (extreme oversold), SHORT when RSI ≥ 85 (extreme overbought)
  // These are very rare, high-conviction signals — price at BB + extreme RSI = strong mean reversion
  // SL: 0.5%, TP1: 0.3% (move SL→BE), TP2: dynamic (bot determines)
  const REVERSAL_LONG_RSI = 25;   // RSI must be ≤ this to go LONG
  const REVERSAL_SHORT_RSI = 85;  // RSI must be ≥ this to go SHORT

  const bb5mStdDist = bb5m.stdDev > 0 ? Math.abs(price - bb5m.middle) / bb5m.stdDev : 0;
  const bb15mStdDist = bb15m.stdDev > 0 ? Math.abs(price - bb15m.middle) / bb15m.stdDev : 0;

  // 5m BB check — require 2.5+ SD for higher-quality entries
  if (triggerBSignal === "none" && bb5mStdDist >= 2.5) {
    if (price <= bb5m.lower && rsi5m <= REVERSAL_LONG_RSI) {
      triggerBSignal = "long";
      triggerBTF = `5m(BB_lower,RSI:${rsi5m.toFixed(1)},${bb5mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi5m;
    } else if (price >= bb5m.upper && rsi5m >= REVERSAL_SHORT_RSI) {
      triggerBSignal = "short";
      triggerBTF = `5m(BB_upper,RSI:${rsi5m.toFixed(1)},${bb5mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi5m;
    }
  }

  // 15m BB check — require 2.5+ SD for higher-quality entries
  if (triggerBSignal === "none" && bb15mStdDist >= 2.5) {
    if (price <= bb15m.lower && rsi15m <= REVERSAL_LONG_RSI) {
      triggerBSignal = "long";
      triggerBTF = `15m(BB_lower,RSI:${rsi15m.toFixed(1)},${bb15mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi15m;
    } else if (price >= bb15m.upper && rsi15m >= REVERSAL_SHORT_RSI) {
      triggerBSignal = "short";
      triggerBTF = `15m(BB_upper,RSI:${rsi15m.toFixed(1)},${bb15mStdDist.toFixed(1)}SD)`;
      triggerBRSI = rsi15m;
    }
  }

  // Pick the trigger — Only BB Reversion is active (extreme_rsi disabled by data analysis)
  let signal: "long" | "short" | "none" = "none";
  let triggerType: "extreme_rsi" | "bb_rsi_reversion" | "none" = "none";
  let triggerTF = "";
  let triggerRSI = 0;

  // Trigger A (extreme_rsi) is disabled — skip it entirely
  if (triggerBSignal !== "none") {
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

  // --- TP/SL targets for BB_RSI_REVERSION ---
  // NOTE: This SL is a fallback default. At execution time (v10.5), it's OVERRIDDEN with a
  // wide SL computed from the swing extreme of recent 15m candles, matching trendline strategy.
  // Fee-adjusted: Hyperliquid taker fee = 0.045% per side, round-trip = 0.09%
  // TP1 at 0.3% = 0.21% net profit after fees — always profitable
  const slPct = 0.005;    // 0.5% fallback SL — overridden by wide swing SL at execution
  const tp1Pct = 0.003;   // 0.3% TP1 — lock in profit, move SL to BE
  const tp2Pct = 0.01;    // 1% initial TP2 placeholder — dynamic TP2 overrides this after TP1 hit

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
  // Track Hyperliquid SL order OIDs per trade — allows cancel+replace on TP1 hit and cleanup on close
  private slOrderOids: Map<number, number[]> = new Map(); // tradeId → [oid1, oid2, ...]
  // v10.6: Track failed TL setups — if a TL trade loses, blacklist that TL signature so bot doesn't retry
  // Key = "type|startPrice|slope" rounded, Value = timestamp of failure
  private failedTLSetups: Map<string, number> = new Map();
  // v10.6.6: RSI cross tracking — record price at the moment RSI first hits extreme
  // Key = "coin_tf_direction", Value = { price, timestamp, rsi }
  private rsiCrossState: Map<string, { price: number; timestamp: number; rsi: number }> = new Map();
  // v10.9.3: Robust position sync — track consecutive "no position" readings per tradeId
  // Only sync-close after 3 consecutive misses to avoid intermittent HL API empty responses
  private syncMissCount: Map<number, number> = new Map();

  private getTLSignature(tl: { type: string; startPrice: number; slope: number }): string {
    // Round to create a stable key — same TL detected across scans will match
    return `${tl.type}|${Math.round(tl.startPrice)}|${(tl.slope * 1000).toFixed(3)}`;
  }

  private blacklistTL(tl: { type: string; startPrice: number; slope: number }) {
    const sig = this.getTLSignature(tl);
    this.failedTLSetups.set(sig, Date.now());
    // Clean old entries (>6h) to avoid unbounded growth
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const [k, v] of this.failedTLSetups) {
      if (v < cutoff) this.failedTLSetups.delete(k);
    }
  }

  private isTLBlacklisted(tl: { type: string; startPrice: number; slope: number }): boolean {
    // Check exact signature match first
    const sig = this.getTLSignature(tl);
    const failedAt = this.failedTLSetups.get(sig);
    if (failedAt) {
      if (Date.now() - failedAt > 6 * 3600 * 1000) {
        this.failedTLSetups.delete(sig);
      } else {
        return true;
      }
    }
    // Also check price proximity — if any failed TL of same type was within 0.5% of this TL, block it
    // This catches the same TL being slightly recalculated across scans
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const [k, v] of this.failedTLSetups) {
      if (v < cutoff) { this.failedTLSetups.delete(k); continue; }
      const [fType, fPrice] = k.split("|");
      if (fType === tl.type && Math.abs(parseFloat(fPrice) - tl.startPrice) / tl.startPrice < 0.005) {
        return true; // same type TL within 0.5% price range — blocked
      }
    }
    return false;
  }

  private resetLossTrackers() {
    this.drawdownPaused = false;
    this.dailyTradeCount = 0;
    this.dailyTradeDate = new Date().toISOString().split("T")[0];
  }

  /**
   * Place a real stop-loss trigger order on Hyperliquid.
   * Returns the order OID if successful, null otherwise.
   */
  private async placeHLStopLoss(executor: ReturnType<typeof createExecutor>, coin: string, side: "long" | "short", slPrice: number, sz: number, szDecimals: number): Promise<number | null> {
    try {
      // For a LONG position, SL sells when price drops to slPrice
      // For a SHORT position, SL buys when price rises to slPrice
      const isBuy = side === "short";
      const triggerPx = formatHLPrice(slPrice, szDecimals);
      // Limit price with 1% slippage tolerance to ensure fill
      const limitSlippage = side === "long" ? 0.99 : 1.01;
      const limitPx = formatHLPrice(slPrice * limitSlippage, szDecimals);

      const result = await executor.placeOrder({
        coin,
        isBuy,
        sz: parseFloat(formatHLSize(sz, szDecimals)),
        limitPx: parseFloat(limitPx),
        orderType: { trigger: { triggerPx, isMarket: true, tpsl: "sl" } },
        reduceOnly: true,
      });

      const status = result?.response?.data?.statuses?.[0];
      const oid = status?.resting?.oid;
      if (oid) {
        log(`[HL_SL] Placed SL order: ${coin} ${side} trigger@$${triggerPx} oid=${oid}`, "engine");
        return oid;
      } else {
        const errMsg = status?.error || JSON.stringify(result).slice(0, 200);
        log(`[HL_SL] SL order not placed for ${coin}: ${errMsg}`, "engine");
        return null;
      }
    } catch (e) {
      log(`[HL_SL] Error placing SL: ${e}`, "engine");
      return null;
    }
  }

  /**
   * Cancel all tracked SL orders for a trade.
   */
  private async cancelSLOrders(executor: ReturnType<typeof createExecutor>, tradeId: number, coin: string): Promise<void> {
    const oids = this.slOrderOids.get(tradeId) || [];
    for (const oid of oids) {
      try {
        await executor.cancelOrder(coin, oid);
        log(`[HL_SL] Cancelled SL oid=${oid} for trade #${tradeId} ${coin}`, "engine");
      } catch (e) {
        log(`[HL_SL] Cancel SL oid=${oid} error: ${e}`, "engine");
      }
    }
    this.slOrderOids.delete(tradeId);
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

    // Re-sync SL orders for any open trades (in case bot restarted and lost in-memory OIDs)
    if (config.apiSecret && config.walletAddress) {
      try {
        const openTrades = await storage.getOpenTrades();
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const existingOrders = await executor.getOpenOrders();
        const triggerOrders = (existingOrders || []).filter((o: any) => o.orderType === "Stop Market" || o.orderType === "Stop Limit" || o.isTrigger);
        const positions = await executor.getPositions();

        for (const trade of openTrades) {
          if (!trade.stopLoss) continue;
          const asset = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
          if (!asset) continue;
          const pos = positions.find((p: any) => p.position?.coin === trade.coin);
          if (!pos) continue;
          const posSize = Math.abs(parseFloat(pos.position.szi || "0"));
          if (posSize <= 0) continue;

          // Check if there's already a trigger order for this coin
          const hasSL = triggerOrders.some((o: any) => o.coin === trade.coin);
          if (!hasSL) {
            const slOid = await this.placeHLStopLoss(executor, trade.coin, trade.side as "long" | "short", trade.stopLoss, posSize, asset.szDecimals);
            if (slOid) this.slOrderOids.set(trade.id, [slOid]);
            log(`[HL_SL] Startup: placed missing SL for trade #${trade.id} ${trade.coin} @ $${trade.stopLoss}`, "engine");
          } else {
            // Track the existing trigger order OID
            const existingTrigger = triggerOrders.find((o: any) => o.coin === trade.coin);
            if (existingTrigger?.oid) this.slOrderOids.set(trade.id, [existingTrigger.oid]);
            log(`[HL_SL] Startup: found existing SL for trade #${trade.id} ${trade.coin} oid=${existingTrigger?.oid}`, "engine");
          }
        }
      } catch (e) {
        log(`[HL_SL] Startup SL sync error: ${e}`, "engine");
      }
    }

    // Clean stale scan rows for coins no longer in ALLOWED_ASSETS
    await storage.deleteScansNotIn(ALLOWED_ASSETS.map(a => a.coin));

    await storage.createLog({
      type: "system",
      message: `Engine v7 started | RSI-ONLY + BB + VOLUME + ADX | ${ALLOWED_ASSETS.length} assets | AUM: $${this.lastKnownEquity.toLocaleString()} | MAX leverage | ${insights.length} learned insights | SL orders: ON`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v7 started — RSI-ONLY + BB + VOLUME + ADX — AUM: $${this.lastKnownEquity.toFixed(2)} | ${insights.length} learned insights | REAL SL ORDERS`, "engine");
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
    this.scanTimer = setTimeout(() => this.runScanCycle(), (config.scanIntervalSecs || 10) * 1000);
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

      // Drawdown check removed — user disabled all exposure reduction
      const canOpenNew = true;

      log(`Scan #${this.scanCount} | AUM: $${equity.toLocaleString()} | ${ALLOWED_ASSETS.length} assets | v11.0 PURE RSI | Trades today: ${this.dailyTradeCount}`, "engine");

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
      const maxPos = config.maxPositions || 8;
      const slotsAvailable = maxPos - openTrades.length;

      // ======================================================================
      // v11.0: PURE RSI STRATEGY
      // LONG: RSI ≤ 16 on 5m or 15m → instant market buy, NO SL, TP 0.5%
      // SHORT: RSI ≥ 85 on 5m or 15m → instant market sell, NO SL, TP 0.5%
      // 80% margin, max leverage, all 9 assets
      // ======================================================================

      let slotsUsed = 0;

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

        // Fetch 5m and 15m candles for RSI only
        const [ohlcv5m, ohlcv15m] = await Promise.all([
          fetchCandlesOHLCV(asset.coin, "5m", 30),
          fetchCandlesOHLCV(asset.coin, "15m", 30),
        ]);

        const c5m = ohlcv5m.map(c => c.close);
        const c15m = ohlcv15m.map(c => c.close);

        if (c5m.length < 15 && c15m.length < 15) continue;

        // Intra-candle RSI — append current live price
        const rsi5m = c5m.length >= 15 ? calculateRSI([...c5m, price]) : 50;
        const rsi15m = c15m.length >= 15 ? calculateRSI([...c15m, price]) : 50;

        // Update dashboard scan row
        let scanSignal: "neutral" | "oversold_long" | "overbought_short" = "neutral";
        let scanDetails = "";
        const LONG_THRESHOLD = 16;
        const SHORT_THRESHOLD = 85;

        if (rsi5m <= LONG_THRESHOLD || rsi15m <= LONG_THRESHOLD) {
          scanSignal = "oversold_long";
          scanDetails = `RSI ≤16: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`;
        } else if (rsi5m >= SHORT_THRESHOLD || rsi15m >= SHORT_THRESHOLD) {
          scanSignal = "overbought_short";
          scanDetails = `RSI ≥85: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`;
        } else {
          const distToLong = Math.min(Math.abs(rsi5m - LONG_THRESHOLD), Math.abs(rsi15m - LONG_THRESHOLD));
          const distToShort = Math.min(Math.abs(rsi5m - SHORT_THRESHOLD), Math.abs(rsi15m - SHORT_THRESHOLD));
          scanDetails = `RSI 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)} | Nearest: ${Math.min(distToLong, distToShort).toFixed(1)} pts`;
        }

        await storage.upsertMarketScan({
          coin: asset.coin, price, rsi5m, rsi15m, rsi: 50, rsi4h: 50, rsi1d: 50,
          ema10: 0, ema21: 0, ema50: 0,
          volume24h, change24h,
          signal: scanSignal,
          fundingRate: funding, openInterest,
          confluenceScore: scanSignal !== "neutral" ? 10 : 0,
          confluenceDetails: scanDetails,
          riskRewardRatio: 0,
          timestamp: new Date().toISOString(),
        });

        // --- ENTRY LOGIC ---
        if (scanSignal === "neutral") {
          // Reset cross state when RSI recovers
          if (rsi5m > LONG_THRESHOLD + 5 && rsi15m > LONG_THRESHOLD + 5) {
            this.rsiCrossState.delete(`${asset.coin}_5m_long`);
            this.rsiCrossState.delete(`${asset.coin}_15m_long`);
          }
          if (rsi5m < SHORT_THRESHOLD - 5 && rsi15m < SHORT_THRESHOLD - 5) {
            this.rsiCrossState.delete(`${asset.coin}_5m_short`);
            this.rsiCrossState.delete(`${asset.coin}_15m_short`);
          }
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        // Skip if already have an open trade on this coin
        if (openCoins.has(asset.coin)) { await new Promise(r => setTimeout(r, 100)); continue; }
        if (slotsAvailable <= slotsUsed) { await new Promise(r => setTimeout(r, 100)); continue; }

        // Determine side and which TF triggered
        let side: "long" | "short";
        let triggerTF = "";
        let triggerRSI = 50;
        if (scanSignal === "oversold_long") {
          side = "long";
          if (rsi5m <= LONG_THRESHOLD) { triggerTF = "5m"; triggerRSI = rsi5m; }
          else { triggerTF = "15m"; triggerRSI = rsi15m; }
        } else {
          side = "short";
          if (rsi5m >= SHORT_THRESHOLD) { triggerTF = "5m"; triggerRSI = rsi5m; }
          else { triggerTF = "15m"; triggerRSI = rsi15m; }
        }

        // Check cross state — only enter once per RSI extreme event
        const crossKey = `${asset.coin}_${triggerTF}_${side}`;
        if (this.rsiCrossState.has(crossKey)) { await new Promise(r => setTimeout(r, 100)); continue; }
        this.rsiCrossState.set(crossKey, { price, timestamp: Date.now(), rsi: triggerRSI });

        // TP at 0.5%, NO SL
        const tp = side === "long" ? price * 1.005 : price * 0.995;

        log(`[PURE_RSI] ${asset.coin} ${triggerTF} RSI=${triggerRSI.toFixed(1)} → ${side.toUpperCase()} @ $${price} | TP: $${tp.toFixed(2)} (+0.5%) | NO SL`, "engine");

        // Position sizing — 80% margin, max leverage
        const leverage = asset.maxLeverage;
        const capitalForTrade = equity * 0.80;
        const notionalSize = capitalForTrade * leverage;
        const assetSize = notionalSize / price;

        if (capitalForTrade < 5) {
          log(`[PURE_RSI] SKIP ${asset.coin}: Capital too low ($${capitalForTrade.toFixed(2)})`, "engine");
          continue;
        }

        // Execute market order (IOC)
        let fillPrice = price;
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            const isCross = !asset.isolatedOnly;
            await executor.setLeverage(asset.coin, leverage, isCross);
            const slippageMult = side === "long" ? 1.01 : 0.99;
            const orderPrice = price * slippageMult;
            const roundedSize = parseFloat(formatHLSize(assetSize, asset.szDecimals));
            if (roundedSize <= 0) { log(`[PURE_RSI] SKIP ${asset.coin}: Rounded size is 0`, "engine"); continue; }
            const orderResult = await executor.placeOrder({
              coin: asset.coin, isBuy: side === "long", sz: roundedSize,
              limitPx: parseFloat(formatHLPrice(orderPrice, asset.szDecimals)),
              orderType: { limit: { tif: "Ioc" } }, reduceOnly: false,
            });

            log(`[HL RAW] ${asset.coin} pure_rsi response: ${JSON.stringify(orderResult).slice(0, 500)}`, "engine");
            const status = orderResult?.response?.data?.statuses?.[0];
            const fillPx = status?.filled?.avgPx;
            const totalSz = status?.filled?.totalSz;
            const errorMsg = status?.error || orderResult?.response?.data?.error || (orderResult?.status !== "ok" ? JSON.stringify(orderResult) : undefined);

            if (errorMsg) {
              log(`[PURE_RSI] ORDER REJECTED: ${asset.coin} — ${errorMsg}`, "engine");
              await storage.createLog({ type: "order_error", message: `ORDER REJECTED: ${asset.coin} ${side} — ${errorMsg}`, timestamp: new Date().toISOString() });
              continue;
            }

            if (fillPx && parseFloat(totalSz) > 0) {
              fillPrice = parseFloat(fillPx);
              log(`[PURE_RSI] FILLED: ${asset.coin} ${side} sz=${totalSz} @ $${fillPx}`, "engine");
            } else {
              log(`[PURE_RSI] IOC NOT FILLED: ${asset.coin} ${side}`, "engine");
              await storage.createLog({ type: "order_unfilled", message: `IOC NOT FILLED: ${asset.coin} ${side}`, timestamp: new Date().toISOString() });
              continue;
            }
          } catch (execErr) {
            log(`[PURE_RSI] ORDER FAILED: ${asset.coin} — ${execErr}`, "engine");
            await storage.createLog({ type: "order_error", message: `ORDER FAILED: ${asset.coin} ${side} — ${execErr}`, timestamp: new Date().toISOString() });
            continue;
          }
        }

        // Recalculate TP based on actual fill price
        const actualTP = side === "long" ? fillPrice * 1.005 : fillPrice * 0.995;

        const trade = await storage.createTrade({
          coin: asset.coin, side, entryPrice: fillPrice, size: 80, leverage,
          entryEquity: equity,
          rsiAtEntry: triggerRSI, rsi4h: 0, rsi1d: 0,
          ema10: 0, ema21: 0, ema50: 0,
          stopLoss: 0, // NO SL
          takeProfit1: actualTP,
          takeProfit2: actualTP, // Same — single TP
          tp1Hit: false,
          confluenceScore: 0,
          confluenceDetails: `PURE RSI: ${triggerTF} RSI=${triggerRSI.toFixed(1)}`,
          riskRewardRatio: 0,
          status: "open",
          reason: `[PURE_RSI] ${side.toUpperCase()} | RSI ${triggerRSI.toFixed(1)} @${triggerTF} | NO SL | TP +0.5% | ${leverage}x`,
          setupType: "bb_rsi_reversion",
          strategy: "bb_rsi_reversion",
          openedAt: new Date().toISOString(),
        });

        // NO SL order on HL — user explicitly requested no stop loss

        await logDecision({
          tradeId: trade.id, coin: asset.coin, action: "entry", side, price: fillPrice,
          reasoning: `PURE RSI: ${side.toUpperCase()} ${asset.displayName} | RSI ${triggerRSI.toFixed(1)} @${triggerTF} | NO SL | TP $${actualTP.toFixed(2)} (+0.5%) | ${leverage}x MAX | $${capitalForTrade.toFixed(0)} capital`,
          equity, leverage, positionSizeUsd: capitalForTrade, strategy: "bb_rsi_reversion",
        });

        await storage.createLog({
          type: "trade_open",
          message: `[PURE_RSI] ${side.toUpperCase()} ${asset.displayName} @ $${displayPrice(fillPrice, asset.szDecimals)} | ${leverage}x | RSI ${triggerRSI.toFixed(1)} @${triggerTF} | NO SL | TP +0.5% | $${capitalForTrade.toFixed(0)}`,
          data: JSON.stringify(trade),
          timestamp: new Date().toISOString(),
        });

        openCoins.add(asset.coin);
        slotsUsed++;
        this.dailyTradeCount++;

        await new Promise(r => setTimeout(r, 100));
      }

      // Log scan summary
      await storage.createLog({
        type: "scan",
        message: `Scan #${this.scanCount}: ${slotsUsed} entries | AUM: $${equity.toLocaleString()} | v11.0 PURE RSI (≤16/≥85)`,
        timestamp: new Date().toISOString(),
      });

      // =============================================
      // CHECK EXITS
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
    let openTrades = await storage.getOpenTrades();
    const mids: Record<string, string> = (await fetchAllMids()) || {};

    const xyzData = await fetchMetaAndAssetCtxs("xyz");
    if (xyzData && xyzData.length >= 2) {
      const universe = xyzData[0]?.universe || [];
      const ctxs = xyzData[1] || [];
      for (let i = 0; i < universe.length; i++) {
        if (ctxs[i]?.midPx && ctxs[i].midPx !== "None") mids[universe[i].name] = ctxs[i].midPx;
      }
    }
    const currentEquity = equity || this.lastKnownEquity || 0;

    // v10.9.3: POSITION SYNC — detect ghost trades (bot thinks open, HL says closed)
    // ROBUST: Requires 3 CONSECUTIVE "no position" readings before sync-closing.
    // This prevents false closes from intermittent HL API empty responses.
    // Also has a 5-minute grace period for newly opened/imported trades.
    if (config.apiSecret && config.walletAddress && openTrades.length > 0) {
      try {
        const syncExec = createExecutor(config.apiSecret, config.walletAddress);
        const hlPositions = await syncExec.getPositions();
        const hlCoinsWithPos = new Set<string>();
        for (const p of hlPositions) {
          const sz = Math.abs(parseFloat(p.position?.szi || "0"));
          if (sz > 0) hlCoinsWithPos.add(p.position.coin);
        }

        // Track which tradeIds we still see as open for cleanup
        const currentOpenIds = new Set(openTrades.map(t => t.id));

        for (const trade of openTrades) {
          // v10.9.3: 5-minute grace period — don't sync-close trades opened less than 5 min ago
          const tradeAge = Date.now() - new Date(trade.openedAt || 0).getTime();
          if (tradeAge < 300_000) {
            log(`[SYNC] Skipping trade #${trade.id} ${trade.coin} — opened ${(tradeAge/1000).toFixed(0)}s ago (5m grace)`, "engine");
            this.syncMissCount.delete(trade.id); // reset miss count during grace
            continue;
          }

          if (hlCoinsWithPos.has(trade.coin)) {
            // Position confirmed on HL — reset miss count
            if (this.syncMissCount.has(trade.id)) {
              log(`[SYNC] Trade #${trade.id} ${trade.coin} — position confirmed on HL (was at ${this.syncMissCount.get(trade.id)} misses, reset)`, "engine");
              this.syncMissCount.delete(trade.id);
            }
          } else {
            // No position found — increment consecutive miss counter
            const misses = (this.syncMissCount.get(trade.id) || 0) + 1;
            this.syncMissCount.set(trade.id, misses);
            log(`[SYNC] Trade #${trade.id} ${trade.coin} — no HL position (miss ${misses}/3)`, "engine");

            if (misses < 3) {
              continue; // Wait for more consecutive misses before acting
            }

            // 3 consecutive misses — position is genuinely closed on HL
            this.syncMissCount.delete(trade.id);
            const closePrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
            const FEE_SYNC = 0.00045;
            const syncEq = (trade as any).entryEquity || currentEquity;
            const tcap = syncEq * (trade.size / 100);
            const pv = tcap * trade.leverage;
            let syncPnl: number;
            if (trade.tp1Hit && trade.takeProfit1) {
              const hp = pv / 2;
              const t1m = trade.side === "long" ? (trade.takeProfit1 - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - trade.takeProfit1) / trade.entryPrice;
              const t2m = trade.side === "long" ? (closePrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - closePrice) / trade.entryPrice;
              syncPnl = hp * t1m + hp * t2m - pv * FEE_SYNC - hp * FEE_SYNC - hp * FEE_SYNC;
            } else {
              const rm = trade.side === "long" ? (closePrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - closePrice) / trade.entryPrice;
              syncPnl = pv * rm - pv * FEE_SYNC * 2;
            }
            const syncLevPnl = tcap > 0 ? (syncPnl / tcap) * 100 : 0;
            const syncAumPnl = syncEq > 0 ? (syncPnl / syncEq) * 100 : 0;
            await storage.updateTrade(trade.id, {
              exitPrice: closePrice, pnl: syncLevPnl, pnlPct: syncAumPnl,
              status: "closed", closeReason: "Position closed on Hyperliquid (sync — 3 consecutive confirmations)",
              closedAt: new Date().toISOString(),
            });
            log(`[SYNC] Trade #${trade.id} ${trade.coin} ${trade.side} auto-closed — no HL position (3 consecutive confirms) | P&L: $${syncPnl.toFixed(2)}`, "engine");
            // v10.6: Blacklist TL if sync-closed at a loss
            if (trade.strategy === "breakout_retest" && syncPnl < -0.5) {
              const r = trade.reason || "";
              const tt = r.includes("ascending") ? "ascending" : r.includes("descending") ? "descending" : "";
              if (tt) {
                this.blacklistTL({ type: tt, startPrice: trade.entryPrice, slope: 0 });
                log(`[BLACKLIST] TL setup blacklisted (sync): ${tt} near $${trade.entryPrice}`, "engine");
              }
            }
            await storage.createLog({
              type: "trade_close",
              message: `[SYNC] Auto-closed ${trade.coin} ${trade.side} #${trade.id} — no matching HL position (3x confirmed) | P&L: $${syncPnl.toFixed(2)}`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Cleanup syncMissCount for trades that are no longer open
        for (const [tid] of this.syncMissCount) {
          if (!currentOpenIds.has(tid)) this.syncMissCount.delete(tid);
        }

        // Refresh open trades after sync
        openTrades = await storage.getOpenTrades();
      } catch (e) {
        log(`[SYNC] Position sync error: ${e}`, "engine");
      }
    }

    for (const trade of openTrades) {
      const currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0) continue;
      const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
      const szd = ac?.szDecimals ?? 2;

      // v11.0: Simple P&L calculation — full position, no partial closes
      const FEE_RATE = 0.00045;
      const eqForTrade = (trade as any).entryEquity || currentEquity;
      const tradeCapUsd = eqForTrade * (trade.size / 100);
      const positionValue = tradeCapUsd * trade.leverage;
      const rawMove = trade.side === "long"
        ? (currentPrice - trade.entryPrice) / trade.entryPrice
        : (trade.entryPrice - currentPrice) / trade.entryPrice;
      const pnlUsd = positionValue * rawMove - positionValue * FEE_RATE * 2;
      const leveragedPnl = tradeCapUsd > 0 ? (pnlUsd / tradeCapUsd) * 100 : 0;
      const pnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
      const currentPeak = Math.max(trade.peakPnlPct || 0, leveragedPnl);

      // v11.0: ONLY exit on TP hit (+0.5%) — NO SL
      let shouldClose = false;
      let closeReason = "";

      const tpHit = (trade.side === "long" && currentPrice >= (trade.takeProfit1 || Infinity)) ||
                    (trade.side === "short" && currentPrice <= (trade.takeProfit1 || 0));
      if (tpHit) {
        shouldClose = true;
        closeReason = `[PURE_RSI] TP +0.5% @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
      }

      if (shouldClose) {
        // Execute full close on Hyperliquid
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
          reasoning: `EXIT: ${closeReason} | P&L: ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | ROI/AUM: ${pnlOfAum.toFixed(3)}% | Held: ${trade.openedAt ? Math.round((Date.now() - new Date(trade.openedAt).getTime()) / 60000) : 0}min`,
          equity: currentEquity, leverage: trade.leverage, strategy: "bb_rsi_reversion",
        });

        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [PURE_RSI] ${trade.side.toUpperCase()} ${trade.coin} | ${leveragedPnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | AUM: ${pnlOfAum.toFixed(3)}% | ${closeReason}`,
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
    const mids: Record<string, string> = (await fetchAllMids()) || {};
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
    // v10.5 FIX: Accurate P&L for manual close (accounts for TP1 partial + fees)
    const FEE_RATE_MC = 0.00045;
    const eq = this.lastKnownEquity || 0;
    const eqForClose = (trade as any).entryEquity || eq;
    const tradeCapUsd = eqForClose * (trade.size / 100);
    const posValue = tradeCapUsd * trade.leverage;
    let pnlUsd: number;
    if (trade.tp1Hit && trade.takeProfit1) {
      const halfPos = posValue / 2;
      const tp1Move = trade.side === "long"
        ? (trade.takeProfit1 - trade.entryPrice) / trade.entryPrice
        : (trade.entryPrice - trade.takeProfit1) / trade.entryPrice;
      const tp2Move = trade.side === "long"
        ? (currentPrice - trade.entryPrice) / trade.entryPrice
        : (trade.entryPrice - currentPrice) / trade.entryPrice;
      pnlUsd = halfPos * tp1Move + halfPos * tp2Move
        - posValue * FEE_RATE_MC - halfPos * FEE_RATE_MC - halfPos * FEE_RATE_MC;
    } else {
      const rawMove = trade.side === "long"
        ? (currentPrice - trade.entryPrice) / trade.entryPrice
        : (trade.entryPrice - currentPrice) / trade.entryPrice;
      pnlUsd = posValue * rawMove - posValue * FEE_RATE_MC * 2;
    }
    const leveragedPnl = tradeCapUsd > 0 ? (pnlUsd / tradeCapUsd) * 100 : 0;
    const pnlOfAum = eqForClose > 0 ? (pnlUsd / eqForClose) * 100 : 0;

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

  /**
   * v10.9.3: Place SL/TP orders on HL for a synced/imported trade.
   * Called from the sync-from-hl endpoint after creating the DB entry.
   */
  async placeSLTPForSyncedTrade(tradeId: number): Promise<{ slOid: number | null }> {
    const config = await storage.getConfig();
    if (!config?.apiSecret || !config?.walletAddress) return { slOid: null };
    const trade = await storage.getTradeById(tradeId);
    if (!trade || trade.status !== "open" || !trade.stopLoss) return { slOid: null };

    const asset = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
    if (!asset) return { slOid: null };

    const executor = createExecutor(config.apiSecret, config.walletAddress);

    // Get actual position size from HL to place correctly sized SL
    const positions = await executor.getPositions();
    const hlPos = positions.find((p: any) => p.position?.coin === trade.coin);
    const posSize = hlPos ? Math.abs(parseFloat(hlPos.position?.szi || "0")) : 0;
    if (posSize <= 0) {
      log(`[SYNC-SL] No HL position found for ${trade.coin} trade #${tradeId} — cannot place SL`, "engine");
      return { slOid: null };
    }

    const slOid = await this.placeHLStopLoss(executor, trade.coin, trade.side as "long" | "short", trade.stopLoss, posSize, asset.szDecimals);
    if (slOid) {
      const existing = this.slOrderOids.get(tradeId) || [];
      existing.push(slOid);
      this.slOrderOids.set(tradeId, existing);
      log(`[SYNC-SL] Placed SL for synced trade #${tradeId} ${trade.coin} ${trade.side} @ $${trade.stopLoss} oid=${slOid}`, "engine");
    }
    return { slOid };
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

    // Per-trade dollar P&L for open positions (uses already-corrected pnl from monitoring loop)
    // pnl field now accounts for TP1 partial close split + fees (v10.5 fix)
    const openTradesWithUsd = openTrades.map(t => {
      const tradeCapUsd = currentEquity * ((t.size || 10) / 100);
      const pnlUsd = tradeCapUsd * ((t.pnl || 0) / 100);
      const pnlOfAum = currentEquity > 0 ? (pnlUsd / currentEquity) * 100 : 0;
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)) };
    });

    // Per-strategy stats (using post-reset trades only)
    const closedTrades = activeClosedTrades; // alias for strategy breakdown
    const confluenceTrades = closedTrades.filter(t => (t.strategy || "confluence") === "confluence");
    const extremeTrades = closedTrades.filter(t => t.strategy === "extreme_rsi");
    const bbReversionTrades = closedTrades.filter(t => t.strategy === "bb_rsi_reversion");
    const breakoutRetestTrades = closedTrades.filter(t => t.strategy === "breakout_retest");
    const confluenceWinRate = confluenceTrades.length > 0 ? (confluenceTrades.filter(t => (t.pnl || 0) > 0).length / confluenceTrades.length) * 100 : 0;
    const extremeWinRate = extremeTrades.length > 0 ? (extremeTrades.filter(t => (t.pnl || 0) > 0).length / extremeTrades.length) * 100 : 0;
    const bbReversionWinRate = bbReversionTrades.length > 0 ? (bbReversionTrades.filter(t => (t.pnl || 0) > 0).length / bbReversionTrades.length) * 100 : 0;
    const breakoutRetestWinRate = breakoutRetestTrades.length > 0 ? (breakoutRetestTrades.filter(t => (t.pnl || 0) > 0).length / breakoutRetestTrades.length) * 100 : 0;

    // Per-strategy P&L: use pnl (leveraged %) * posWeight to get AUM %, then convert to USD
    const strategyPnlCalc = (trades: typeof closedTrades) => {
      const pnlOfAumPct = trades.reduce((s, t) => s + ((t.pnl || 0) * ((t.size || 10) / 100)), 0);
      const pnlUsd = startEq > 0 ? startEq * (pnlOfAumPct / 100) : 0;
      return { pnlOfAumPct, pnlUsd };
    };
    const confluenceStats = strategyPnlCalc(confluenceTrades);
    const extremeStats = strategyPnlCalc(extremeTrades);
    const bbReversionStats = strategyPnlCalc(bbReversionTrades);
    const breakoutRetestStats = strategyPnlCalc(breakoutRetestTrades);
    const confluencePnlUsd = confluenceStats.pnlUsd;
    const extremePnlUsd = extremeStats.pnlUsd;
    const bbReversionPnlUsd = bbReversionStats.pnlUsd;
    const breakoutRetestPnlUsd = breakoutRetestStats.pnlUsd;

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
      drawdownPaused: false,
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
        breakout_retest: { trades: breakoutRetestTrades.length, winRate: breakoutRetestWinRate.toFixed(1), openPositions: openTrades.filter(t => t.strategy === "breakout_retest").length, pnlUsd: breakoutRetestPnlUsd.toFixed(4), pnlOfAum: breakoutRetestStats.pnlOfAumPct.toFixed(3), status: "active" },
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
  // v10.6.1: Expose detected trendlines + candle data for dashboard visualization
  async getTrendlineData(coin: string = "BTC") {
    try {
      const candles5m = await fetchCandlesOHLCV(coin, "5m", 200);
      if (candles5m.length < 30) return { candles: [], trendlines: [], breakouts: [] };

      const trendlines = detectTrendlines(candles5m, 3);
      const price = candles5m[candles5m.length - 1]?.close || 0;

      // For each TL, compute touch points and breakout info
      const tlData = trendlines.map(tl => {
        // Find touch points — swing points that are near the TL
        const touchPoints: { idx: number; price: number; time: number }[] = [];
        const tolerancePct = 0.0015;
        for (let i = tl.startIdx; i <= tl.endIdx; i++) {
          const tlVal = trendlineAt(tl, i);
          if (tl.type === "descending") {
            if (Math.abs(candles5m[i].high - tlVal) / tlVal <= tolerancePct) {
              touchPoints.push({ idx: i, price: candles5m[i].high, time: candles5m[i].time });
            }
          } else {
            if (Math.abs(candles5m[i].low - tlVal) / tlVal <= tolerancePct) {
              touchPoints.push({ idx: i, price: candles5m[i].low, time: candles5m[i].time });
            }
          }
        }

        // TL line coordinates (start and projected end)
        const startTime = candles5m[tl.startIdx]?.time || 0;
        const endIdx = Math.min(tl.endIdx + 30, candles5m.length - 1); // extend 30 bars past end
        const endTime = candles5m[endIdx]?.time || 0;
        const startPriceVal = trendlineAt(tl, tl.startIdx);
        const endPriceVal = trendlineAt(tl, endIdx);

        // Check breakout
        let breakoutIdx = -1;
        for (let i = tl.endIdx + 1; i < candles5m.length; i++) {
          const tlv = trendlineAt(tl, i);
          if (tl.type === "descending" && candles5m[i].close > tlv * 1.001) { breakoutIdx = i; break; }
          if (tl.type === "ascending" && candles5m[i].close < tlv * 0.999) { breakoutIdx = i; break; }
        }

        const isBlacklisted = this.isTLBlacklisted({ type: tl.type, startPrice: tl.startPrice, slope: tl.slope });

        return {
          type: tl.type,
          touches: tl.touches,
          strength: tl.strength,
          span: tl.endIdx - tl.startIdx,
          startTime, endTime,
          startPrice: startPriceVal,
          endPrice: endPriceVal,
          touchPoints: touchPoints.slice(0, 10), // limit
          broken: breakoutIdx !== -1,
          breakoutTime: breakoutIdx >= 0 ? candles5m[breakoutIdx]?.time : null,
          breakoutPrice: breakoutIdx >= 0 ? candles5m[breakoutIdx]?.close : null,
          currentTLValue: trendlineAt(tl, candles5m.length - 1),
          distFromPrice: price > 0 ? ((price - trendlineAt(tl, candles5m.length - 1)) / price * 100) : 0,
          blacklisted: isBlacklisted,
        };
      });

      return {
        candles: candles5m.map(c => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
        trendlines: tlData,
        currentPrice: price,
      };
    } catch (e) {
      log(`getTrendlineData error: ${e}`, "engine");
      return { candles: [], trendlines: [], currentPrice: 0 };
    }
  }
}

export const tradingEngine = new TradingEngine();
export { ALLOWED_ASSETS };
