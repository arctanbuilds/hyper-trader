/**
 * HyperTrader — Trading Engine v12.0 (Quant HF)
 *
 * QUANT HIGH-FREQUENCY STRATEGY:
 *   - 50 crypto assets, 1-min timeframe
 *   - LONG when 1m RSI ≤ 30 AND price ≤ BB lower band
 *   - SHORT when 1m RSI ≥ 70 AND price ≥ BB upper band
 *   - MAKER limit orders (Alo) — 0.02% entry fee
 *   - TP: +0.20% (limit GTC), SL: -0.10% (stop-market)
 *   - 10x leverage cap, sequential execution (one trade at a time)
 *   - Streak sizing: half after 2 losses, quarter after 3
 *   - Target: 100+ trades/day, 100%+/week compound
 *   - Scan batch: 10 assets per 5-second cycle (full rotation every ~25s)
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
  maxLeverage: number;     // ALWAYS used — no scaling down
  szDecimals: number;
  category: "crypto" | "commodity" | "forex" | "index";
  minNotional: number;
  isolatedOnly?: boolean;  // Some HIP-3 assets only support isolated margin
}

const ALLOWED_ASSETS: AssetConfig[] = [
  // === TOP TIER (most liquid) — all capped at 10x ===
  { coin: "BTC",    displayName: "Bitcoin",      dex: "", maxLeverage: 10, szDecimals: 5, category: "crypto", minNotional: 10 },
  { coin: "ETH",    displayName: "Ethereum",     dex: "", maxLeverage: 10, szDecimals: 4, category: "crypto", minNotional: 10 },
  { coin: "SOL",    displayName: "Solana",       dex: "", maxLeverage: 10, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "XRP",    displayName: "XRP",          dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "MATIC",  displayName: "Polygon",      dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "RNDR",   displayName: "Render",       dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  // === MID TIER (maxLev 10 on HL, capped at 10) ===
  { coin: "AVAX",   displayName: "Avalanche",    dex: "", maxLeverage: 10, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "BNB",    displayName: "BNB",          dex: "", maxLeverage: 10, szDecimals: 3, category: "crypto", minNotional: 10 },
  { coin: "LTC",    displayName: "Litecoin",     dex: "", maxLeverage: 10, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "ARB",    displayName: "Arbitrum",     dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "DOGE",   displayName: "Dogecoin",     dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "SUI",    displayName: "Sui",          dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "kPEPE",  displayName: "PEPE",         dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "CRV",    displayName: "Curve",        dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "LINK",   displayName: "Chainlink",    dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "FTM",    displayName: "Fantom",       dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "BCH",    displayName: "Bitcoin Cash", dex: "", maxLeverage: 10, szDecimals: 3, category: "crypto", minNotional: 10 },
  { coin: "APT",    displayName: "Aptos",        dex: "", maxLeverage: 10, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "AAVE",   displayName: "Aave",         dex: "", maxLeverage: 10, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "MKR",    displayName: "Maker",        dex: "", maxLeverage: 10, szDecimals: 4, category: "crypto", minNotional: 10 },
  { coin: "WLD",    displayName: "Worldcoin",    dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "TRX",    displayName: "Tron",         dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "kSHIB",  displayName: "SHIB",         dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "UNI",    displayName: "Uniswap",      dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "DOT",    displayName: "Polkadot",     dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "ADA",    displayName: "Cardano",      dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "TON",    displayName: "Toncoin",      dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "NEAR",   displayName: "Near",         dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "kBONK",  displayName: "BONK",         dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "JUP",    displayName: "Jupiter",      dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "ONDO",   displayName: "Ondo",         dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "ENA",    displayName: "Ethena",       dex: "", maxLeverage: 10, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "HYPE",   displayName: "Hyperliquid",  dex: "", maxLeverage: 10, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "TRUMP",  displayName: "Trump",        dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "FARTCOIN", displayName: "Fartcoin",   dex: "", maxLeverage: 10, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "ZEC",    displayName: "Zcash",        dex: "", maxLeverage: 10, szDecimals: 2, category: "crypto", minNotional: 10 },
  // === LOWER TIER (5x on HL) ===
  { coin: "OP",      displayName: "Optimism",    dex: "", maxLeverage: 5, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "INJ",     displayName: "Injective",   dex: "", maxLeverage: 5, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "SEI",     displayName: "Sei",         dex: "", maxLeverage: 5, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "TIA",     displayName: "Celestia",    dex: "", maxLeverage: 5, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "PENDLE",  displayName: "Pendle",      dex: "", maxLeverage: 5, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "FET",     displayName: "Fetch.ai",    dex: "", maxLeverage: 5, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "WIF",     displayName: "dogwifhat",   dex: "", maxLeverage: 5, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "PYTH",    displayName: "Pyth",        dex: "", maxLeverage: 5, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "FIL",     displayName: "Filecoin",    dex: "", maxLeverage: 5, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "TAO",     displayName: "Bittensor",   dex: "", maxLeverage: 5, szDecimals: 3, category: "crypto", minNotional: 10 },
  { coin: "HBAR",    displayName: "Hedera",      dex: "", maxLeverage: 5, szDecimals: 0, category: "crypto", minNotional: 10 },
  { coin: "EIGEN",   displayName: "EigenLayer",  dex: "", maxLeverage: 5, szDecimals: 2, category: "crypto", minNotional: 10 },
  { coin: "VIRTUAL", displayName: "Virtuals",    dex: "", maxLeverage: 5, szDecimals: 1, category: "crypto", minNotional: 10 },
  { coin: "BERA",    displayName: "Berachain",   dex: "", maxLeverage: 5, szDecimals: 1, category: "crypto", minNotional: 10 },
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

function calculateBollingerBands(closes: number[], period: number = 20, stdDevMult: number = 2): { upper: number; middle: number; lower: number; width: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + stdDevMult * stdDev,
    middle: mean,
    lower: mean - stdDevMult * stdDev,
    width: stdDev > 0 ? ((mean + stdDevMult * stdDev) - (mean - stdDevMult * stdDev)) / mean * 100 : 0,
  };
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

    // Unified wallet: spot USDC is the true equity source (perps accountValue = 0)
    // Use whichever is higher — spot total includes all margin + free balance
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

// Fetch recent fills for a user (returns all fills since startTime)
async function fetchUserFills(address: string, startTime?: number): Promise<any[]> {
  try {
    const body: any = { type: "userFillsByTime", user: address, startTime: startTime || (Date.now() - 24 * 3600 * 1000) };
    const res = await fetch(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as any[];
  } catch (e) { log(`Fills error: ${e}`, "engine"); return []; }
}

// Get the realized P&L for a specific coin's close from HL fills
// Aggregates all close fills for the coin within a time window
// Returns { closedPnl, totalFee, exitPrice, exitSize } or null if not found
function extractClosePnlFromFills(fills: any[], coin: string, side: "long" | "short", afterTime: number): {
  closedPnl: number; totalFee: number; netPnl: number; exitPrice: number; exitSize: number;
} | null {
  // Close fills: "Close Long" or "Close Short"
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
  // netPnl = closedPnl - totalFee (closedPnl is gross before close-side fee)
  // Actually HL's closedPnl already accounts for entry fee, so net = closedPnl - closeFee
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
  private isScanning = false;
  private lastKnownEquity = 0;
  private startingEquity = 0;
  private dayStartEquity = 0;
  private dayStartDate = "";
  private dailyTradeCount = 0;
  private dailyTradeDate = "";
  private drawdownPaused = false;
  private scanCount = 0;
  private lastLearningReview = 0;
  private pnlResetTimestamp = "";
  private pnlResetEquity = 0;
  // v12.0: Quant HF state
  private consecutiveLosses = 0;
  private failedSetups: Map<string, number> = new Map(); // "COIN_side" -> timestamp
  private assetScanOffset = 0; // rotates through ALLOWED_ASSETS in batches
  // v10.9.3: Robust position sync — track consecutive "no position" readings per tradeId
  private syncMissCount: Map<number, number> = new Map();

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

    // Restore persisted P&L baseline (survives restarts)
    if (config.pnlBaselineTimestamp && config.pnlBaselineEquity && config.pnlBaselineEquity > 0) {
      this.pnlResetTimestamp = config.pnlBaselineTimestamp;
      this.pnlResetEquity = config.pnlBaselineEquity;
      this.startingEquity = config.pnlBaselineEquity;
      log(`[BASELINE] Restored P&L baseline: $${config.pnlBaselineEquity.toFixed(2)} from ${config.pnlBaselineTimestamp}`, "engine");
    } else {
      // First-time start: set baseline to current equity
      this.pnlResetTimestamp = new Date().toISOString();
      this.pnlResetEquity = this.lastKnownEquity;
      await storage.updateConfig({
        pnlBaselineEquity: this.lastKnownEquity,
        pnlBaselineTimestamp: this.pnlResetTimestamp,
      });
      log(`[BASELINE] Initial P&L baseline set: $${this.lastKnownEquity.toFixed(2)}`, "engine");
    }

    // Restore last review time from DB
    const lastReviewTime = await storage.getLastReviewTime();
    if (lastReviewTime) {
      this.lastLearningReview = new Date(lastReviewTime).getTime();
    }

    const insights = await storage.getActiveInsights();


    // Clean stale scan rows for coins no longer in ALLOWED_ASSETS
    await storage.deleteScansNotIn(ALLOWED_ASSETS.map(a => a.coin));

    await storage.createLog({
      type: "system",
      message: `Engine v12.0 (QHF) started | RSI≤30/≥70 + BB | ${ALLOWED_ASSETS.length} assets | 10x cap | TP +0.20% | SL -0.10% | Maker orders | AUM: $${this.lastKnownEquity.toLocaleString()}`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v12.0 (QHF) started — RSI≤30/≥70 + BB — ${ALLOWED_ASSETS.length} assets — 10x cap — TP +0.20% SL -0.10% — Maker — AUM: $${this.lastKnownEquity.toFixed(2)}`, "engine");
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

      log(`Scan #${this.scanCount} | AUM: $${equity.toLocaleString()} | v12.0 QHF | ${ALLOWED_ASSETS.length} assets | Trades today: ${this.dailyTradeCount} | Consec losses: ${this.consecutiveLosses}`, "engine");

      // Fetch market data (crypto only — no xyz)
      const mainData = await fetchMetaAndAssetCtxs("");
      const assetCtxMap: Record<string, any> = {};
      if (mainData && mainData.length >= 2) {
        const universe = mainData[0]?.universe || [];
        const ctxs = mainData[1] || [];
        for (let i = 0; i < universe.length; i++) {
          if (ctxs[i]) assetCtxMap[universe[i].name] = ctxs[i];
        }
      }

      // Open positions — sequential: only trade if NO open positions
      const openTrades = await storage.getOpenTrades();
      const hasOpenPosition = openTrades.length > 0;

      // ======================================================================
      // v12.0: QUANT HIGH-FREQUENCY STRATEGY
      // LONG: 1m RSI ≤ 30 AND price ≤ BB lower band
      // SHORT: 1m RSI ≥ 70 AND price ≥ BB upper band
      // Maker (Alo) limit orders, TP +0.20%, SL -0.10%, 10x cap, sequential
      // Batch scan: 10 assets per cycle, rotating through all 50
      // ======================================================================

      const BATCH_SIZE = 10;
      const startIdx = this.assetScanOffset % ALLOWED_ASSETS.length;
      const batch: AssetConfig[] = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        batch.push(ALLOWED_ASSETS[(startIdx + i) % ALLOWED_ASSETS.length]);
      }
      this.assetScanOffset += BATCH_SIZE;

      let entered = false;

      for (const asset of batch) {
        const ctx = assetCtxMap[asset.coin];
        if (!ctx?.midPx || ctx.midPx === "None") continue;
        const price = parseFloat(ctx.midPx);
        if (isNaN(price) || price <= 0) continue;
        const volume24h = parseFloat(ctx.dayNtlVlm || "0");
        const funding = parseFloat(ctx.funding || "0");
        const openInterest = parseFloat(ctx.openInterest || "0");
        const prevDayPx = parseFloat(ctx.prevDayPx || String(price));
        const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;

        // Fetch 1m candles for RSI + Bollinger Bands
        const ohlcv1m = await fetchCandlesOHLCV(asset.coin, "1m", 30);
        const closes1m = ohlcv1m.map(c => c.close);
        if (closes1m.length < 20) continue;

        // Intra-candle: append current live price
        const closesWithLive = [...closes1m, price];
        const rsi1m = calculateRSI(closesWithLive);
        const bb = calculateBollingerBands(closesWithLive, 20, 2);

        // Update dashboard scan row
        let scanSignal: "neutral" | "oversold_long" | "overbought_short" = "neutral";
        let scanDetails = "";
        const LONG_RSI = 30;
        const SHORT_RSI = 70;

        const bbLong = bb && price <= bb.lower;
        const bbShort = bb && price >= bb.upper;

        if (rsi1m <= LONG_RSI && bbLong) {
          scanSignal = "oversold_long";
          scanDetails = `QHF: 1m RSI=${rsi1m.toFixed(1)} ≤${LONG_RSI} + price≤BB.low($${bb!.lower.toFixed(2)})`;
        } else if (rsi1m >= SHORT_RSI && bbShort) {
          scanSignal = "overbought_short";
          scanDetails = `QHF: 1m RSI=${rsi1m.toFixed(1)} ≥${SHORT_RSI} + price≥BB.up($${bb!.upper.toFixed(2)})`;
        } else {
          const bbStr = bb ? `BB[${bb.lower.toFixed(2)}-${bb.upper.toFixed(2)}]` : "BB N/A";
          scanDetails = `1m RSI=${rsi1m.toFixed(1)} | ${bbStr}`;
        }

        await storage.upsertMarketScan({
          coin: asset.coin, price, rsi5m: rsi1m, rsi15m: 0, rsi: rsi1m, rsi4h: 0, rsi1d: 0,
          ema10: bb?.lower || 0, ema21: bb?.middle || 0, ema50: bb?.upper || 0,
          volume24h, change24h,
          signal: scanSignal,
          fundingRate: funding, openInterest,
          confluenceScore: scanSignal !== "neutral" ? 10 : 0,
          confluenceDetails: scanDetails,
          riskRewardRatio: 2.0,
          timestamp: new Date().toISOString(),
        });

        // --- ENTRY LOGIC ---
        if (scanSignal === "neutral") continue;
        if (hasOpenPosition || entered) continue; // Sequential: one at a time

        const side: "long" | "short" = scanSignal === "oversold_long" ? "long" : "short";

        // Failed setup cooldown: skip if this coin+side failed within 1 hour
        const setupKey = `${asset.coin}_${side}`;
        const failedAt = this.failedSetups.get(setupKey);
        if (failedAt && (Date.now() - failedAt) < 3600_000) {
          log(`[QHF] SKIP ${asset.coin} ${side}: failed setup cooldown (${((Date.now() - failedAt) / 60000).toFixed(0)}m ago)`, "engine");
          continue;
        }

        // Streak-based position sizing
        let marginPct = 0.80;
        if (this.consecutiveLosses >= 3) marginPct = 0.20; // quarter
        else if (this.consecutiveLosses >= 2) marginPct = 0.40; // half

        const leverage = asset.maxLeverage; // already capped at 10 in ALLOWED_ASSETS
        const capitalForTrade = equity * marginPct;
        const notionalSize = capitalForTrade * leverage;
        const assetSize = notionalSize / price;

        if (capitalForTrade < 5) {
          log(`[QHF] SKIP ${asset.coin}: Capital too low ($${capitalForTrade.toFixed(2)})`, "engine");
          continue;
        }

        // TP +0.20%, SL -0.10% (2:1 R:R)
        const tp = side === "long" ? price * 1.002 : price * 0.998;
        const sl = side === "long" ? price * 0.999 : price * 1.001;

        log(`[QHF] ${asset.coin} 1m RSI=${rsi1m.toFixed(1)} BB=${bbLong ? "LOW" : "UP"} → ${side.toUpperCase()} @ $${price} | TP: $${tp.toFixed(4)} (+0.20%) | SL: $${sl.toFixed(4)} (-0.10%) | margin=${(marginPct*100).toFixed(0)}% | ${leverage}x`, "engine");

        // Execute MAKER limit order (Alo)
        let fillPrice = price;
        let filledSz = 0;
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            await executor.setLeverage(asset.coin, leverage, true); // cross margin
            const limitOffset = side === "long" ? 0.9999 : 1.0001;
            const entryLimitPx = parseFloat(formatHLPrice(price * limitOffset, asset.szDecimals));
            const roundedSize = parseFloat(formatHLSize(assetSize, asset.szDecimals));
            if (roundedSize <= 0) { log(`[QHF] SKIP ${asset.coin}: Rounded size is 0`, "engine"); continue; }

            const orderResult = await executor.placeOrder({
              coin: asset.coin, isBuy: side === "long", sz: roundedSize,
              limitPx: entryLimitPx,
              orderType: { limit: { tif: "Alo" } }, // Maker-only!
              reduceOnly: false,
            });

            log(`[HL RAW] ${asset.coin} qhf response: ${JSON.stringify(orderResult).slice(0, 500)}`, "engine");
            const status = orderResult?.response?.data?.statuses?.[0];
            const errorMsg = status?.error || orderResult?.response?.data?.error || (orderResult?.status !== "ok" ? JSON.stringify(orderResult) : undefined);

            if (errorMsg) {
              log(`[QHF] ORDER REJECTED: ${asset.coin} — ${errorMsg}`, "engine");
              await storage.createLog({ type: "order_error", message: `ORDER REJECTED: ${asset.coin} ${side} — ${errorMsg}`, timestamp: new Date().toISOString() });
              continue;
            }

            // Alo might rest on book — wait 2s then check fill
            await new Promise(r => setTimeout(r, 2000));
            const positions = await executor.getPositions();
            const pos = positions.find((p: any) => p.position?.coin === asset.coin);
            const filledSzFromPos = pos ? Math.abs(parseFloat(pos.position?.szi || "0")) : 0;

            if (filledSzFromPos <= 0) {
              // Not filled — cancel pending orders
              try {
                const openOrders = await executor.getOpenOrders();
                for (const o of openOrders) {
                  if (o.coin === asset.coin) await executor.cancelOrder(asset.coin, o.oid);
                }
              } catch (cancelErr) { log(`[QHF] Cancel error: ${cancelErr}`, "engine"); }
              log(`[QHF] Alo not filled: ${asset.coin} ${side} — cancelled`, "engine");
              continue;
            }

            filledSz = filledSzFromPos;
            // Read fill price from position
            fillPrice = parseFloat(pos.position?.entryPx || String(price));
            log(`[QHF] FILLED: ${asset.coin} ${side} sz=${filledSz} @ $${fillPrice}`, "engine");

          } catch (execErr) {
            log(`[QHF] ORDER FAILED: ${asset.coin} — ${execErr}`, "engine");
            await storage.createLog({ type: "order_error", message: `ORDER FAILED: ${asset.coin} ${side} — ${execErr}`, timestamp: new Date().toISOString() });
            continue;
          }
        }

        // Recalculate TP and SL based on actual fill price
        const actualTP = side === "long" ? fillPrice * 1.002 : fillPrice * 0.998;
        const actualSL = side === "long" ? fillPrice * 0.999 : fillPrice * 1.001;
        const actualNotional = (filledSz > 0 ? filledSz : assetSize) * fillPrice;

        const trade = await storage.createTrade({
          coin: asset.coin, side, entryPrice: fillPrice, size: marginPct * 100, leverage,
          entryEquity: equity,
          notionalValue: actualNotional,
          rsiAtEntry: rsi1m, rsi4h: 0, rsi1d: 0,
          ema10: bb?.lower || 0, ema21: bb?.middle || 0, ema50: bb?.upper || 0,
          stopLoss: actualSL,
          takeProfit1: actualTP,
          takeProfit2: actualTP,
          tp1Hit: false,
          confluenceScore: 10,
          confluenceDetails: `QHF: 1m RSI=${rsi1m.toFixed(1)} + BB ${side === "long" ? "lower" : "upper"} touch`,
          riskRewardRatio: 2.0,
          status: "open",
          reason: `[QHF] ${side.toUpperCase()} | 1m RSI ${rsi1m.toFixed(1)} + BB | TP +0.20% | SL -0.10% | ${leverage}x | margin ${(marginPct*100).toFixed(0)}%`,
          setupType: "bb_rsi_reversion",
          strategy: "bb_rsi_reversion",
          openedAt: new Date().toISOString(),
        });

        // Place TP as GTC limit order (maker fee on exit!) + SL as stop-market
        if (config.apiSecret && config.walletAddress && filledSz > 0) {
          const executor = createExecutor(config.apiSecret, config.walletAddress);
          // TP: GTC limit
          try {
            await executor.placeOrder({
              coin: asset.coin,
              isBuy: side === "short",
              sz: filledSz,
              limitPx: parseFloat(formatHLPrice(actualTP, asset.szDecimals)),
              orderType: { limit: { tif: "Gtc" } },
              reduceOnly: true,
            });
            log(`[QHF TP] ${asset.coin} TP limit @ $${displayPrice(actualTP, asset.szDecimals)} (+0.20%)`, "engine");
          } catch (tpErr) {
            log(`[QHF TP] FAILED ${asset.coin}: ${tpErr}`, "engine");
          }
          // SL: stop-market
          try {
            const slTriggerPx = parseFloat(formatHLPrice(actualSL, asset.szDecimals));
            const slFillPx = side === "long"
              ? parseFloat(formatHLPrice(actualSL * 0.98, asset.szDecimals))
              : parseFloat(formatHLPrice(actualSL * 1.02, asset.szDecimals));
            await executor.placeOrder({
              coin: asset.coin,
              isBuy: side === "short",
              sz: filledSz,
              limitPx: slFillPx,
              orderType: { trigger: { triggerPx: String(slTriggerPx), isMarket: true, tpsl: "sl" } },
              reduceOnly: true,
            });
            log(`[QHF SL] ${asset.coin} SL stop @ $${slTriggerPx} (-0.10%)`, "engine");
          } catch (slErr) {
            log(`[QHF SL] FAILED ${asset.coin}: ${slErr}`, "engine");
          }
        }

        await logDecision({
          tradeId: trade.id, coin: asset.coin, action: "entry", side, price: fillPrice,
          reasoning: `QHF: ${side.toUpperCase()} ${asset.displayName} | 1m RSI ${rsi1m.toFixed(1)} + BB | TP $${actualTP.toFixed(4)} (+0.20%) | SL $${actualSL.toFixed(4)} (-0.10%) | ${leverage}x | margin ${(marginPct*100).toFixed(0)}% | $${capitalForTrade.toFixed(0)}`,
          equity, leverage, positionSizeUsd: capitalForTrade, strategy: "bb_rsi_reversion",
        });

        await storage.createLog({
          type: "trade_open",
          message: `[QHF] ${side.toUpperCase()} ${asset.displayName} @ $${displayPrice(fillPrice, asset.szDecimals)} | ${leverage}x | 1m RSI ${rsi1m.toFixed(1)} + BB | TP +0.20% | SL -0.10% | $${capitalForTrade.toFixed(0)}`,
          data: JSON.stringify(trade),
          timestamp: new Date().toISOString(),
        });

        entered = true;
        this.dailyTradeCount++;
      }

      // Log scan summary
      await storage.createLog({
        type: "scan",
        message: `Scan #${this.scanCount}: ${entered ? 1 : 0} entries | Batch ${startIdx}-${startIdx + BATCH_SIZE - 1} | AUM: $${equity.toLocaleString()} | v12.0 QHF | Streak: ${this.consecutiveLosses}`,
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

    // ============================================================
    // v11.2: READ ALL P&L DIRECTLY FROM HYPERLIQUID
    // Open positions: unrealizedPnl from clearinghouseState
    // Closed positions: closedPnl + fee from userFills
    // ============================================================

    // Build map of HL positions: coin -> { unrealizedPnl, returnOnEquity, szi, entryPx, ... }
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

        // Track which tradeIds we still see as open for cleanup
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
            // Position confirmed on HL — reset miss count
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
            // v11.2: Fetch actual P&L from HL fills instead of calculating
            this.syncMissCount.delete(trade.id);
            const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
            const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
            const hlPnl = extractClosePnlFromFills(fills, trade.coin, trade.side as any, tradeOpenTime);

            const syncEq = (trade as any).entryEquity || currentEquity;
            let netPnl: number;
            let exitPrice: number;
            let closeFee = 0;

            if (hlPnl) {
              // GROUND TRUTH: P&L straight from Hyperliquid
              netPnl = hlPnl.netPnl;
              exitPrice = hlPnl.exitPrice;
              closeFee = hlPnl.totalFee;
              log(`[SYNC] Trade #${trade.id} ${trade.coin} — HL fills P&L: gross=$${hlPnl.closedPnl.toFixed(4)} fee=$${hlPnl.totalFee.toFixed(4)} net=$${netPnl.toFixed(4)} exitPx=$${exitPrice.toFixed(2)}`, "engine");
            } else {
              // Fallback: no fills found (rare) — estimate from mid price
              exitPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));
              const pv = (trade as any).notionalValue || (syncEq * (trade.size / 100) * trade.leverage);
              const rm = trade.side === "long" ? (exitPrice - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - exitPrice) / trade.entryPrice;
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
            log(`[SYNC] Trade #${trade.id} ${trade.coin} ${trade.side} auto-closed | HL P&L: $${netPnl.toFixed(2)}`, "engine");
            // v12.0: Track consecutive losses + failed setups
            if (netPnl < 0) {
              this.consecutiveLosses++;
              this.failedSetups.set(`${trade.coin}_${trade.side}`, Date.now());
              log(`[QHF] Loss streak: ${this.consecutiveLosses} | Failed setup: ${trade.coin}_${trade.side}`, "engine");
            } else {
              this.consecutiveLosses = 0;
            }
            await storage.createLog({
              type: "trade_close",
              message: `[SYNC] Auto-closed ${trade.coin} ${trade.side} #${trade.id} | HL P&L: $${netPnl.toFixed(2)} USDC`,
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
    // OPEN TRADE MONITORING: read unrealizedPnl from HL + check TP
    // ============================================================
    for (const trade of openTrades) {
      const currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0) continue;
      const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
      const szd = ac?.szDecimals ?? 2;
      const eqForTrade = (trade as any).entryEquity || currentEquity;

      // v11.2: Read unrealizedPnl directly from HL position
      const hlPos = hlPosMap.get(trade.coin);
      let pnlUsd: number;
      if (hlPos?.unrealizedPnl !== undefined) {
        // GROUND TRUTH: P&L straight from Hyperliquid
        pnlUsd = parseFloat(hlPos.unrealizedPnl);
      } else {
        // Fallback: calculate (when HL data not available)
        const positionValue = (trade as any).notionalValue || (eqForTrade * (trade.size / 100) * trade.leverage);
        const rawMove = trade.side === "long"
          ? (currentPrice - trade.entryPrice) / trade.entryPrice
          : (trade.entryPrice - currentPrice) / trade.entryPrice;
        pnlUsd = positionValue * rawMove - positionValue * 0.00045 * 2;
      }
      const pnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;

      // v11.2: Exit on TP (+0.5%) or SL (-1%)
      let shouldClose = false;
      let closeReason = "";

      const tpHit = (trade.side === "long" && currentPrice >= (trade.takeProfit1 || Infinity)) ||
                    (trade.side === "short" && currentPrice <= (trade.takeProfit1 || 0));
      const slHit = trade.stopLoss > 0 && (
        (trade.side === "long" && currentPrice <= trade.stopLoss) ||
        (trade.side === "short" && currentPrice >= trade.stopLoss)
      );

      if (tpHit) {
        shouldClose = true;
        closeReason = `[QHF] TP +0.20% @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
      } else if (slHit) {
        shouldClose = true;
        closeReason = `[QHF] SL -0.10% @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
        log(`[SL HIT] Trade #${trade.id} ${trade.coin} ${trade.side} | Price $${displayPrice(currentPrice, szd)} hit SL $${displayPrice(trade.stopLoss, szd)}`, "engine");
      }

      if (shouldClose) {
        // Execute full close on Hyperliquid
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            const pos = hlPos || (await executor.getPositions()).find((p: any) => p.position?.coin === trade.coin)?.position;
            if (pos) {
              const sz = Math.abs(parseFloat(pos.szi || "0"));
              const slippage = trade.side === "long" ? 0.99 : 1.01;
              await executor.placeOrder({
                coin: trade.coin, isBuy: trade.side === "short", sz,
                limitPx: parseFloat(formatHLPrice(currentPrice * slippage, szd)),
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
              });
            }
          } catch (e) { log(`Close error: ${e}`, "engine"); }

          // v11.2: After close, fetch actual P&L from HL fills
          await new Promise(r => setTimeout(r, 1500)); // wait for fill to appear
          try {
            const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
            const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
            const hlPnl = extractClosePnlFromFills(fills, trade.coin, trade.side as any, tradeOpenTime);
            if (hlPnl) {
              pnlUsd = hlPnl.netPnl;
              const exitLabel = slHit ? "SL -0.10%" : "TP +0.20%";
              closeReason = `[QHF] ${exitLabel} | HL P&L: $${hlPnl.netPnl.toFixed(2)} (gross=$${hlPnl.closedPnl.toFixed(2)} fee=$${hlPnl.totalFee.toFixed(2)})`;
              const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
              await storage.updateTrade(trade.id, {
                exitPrice: hlPnl.exitPrice, pnl: 0, pnlPct: finalPnlOfAum,
                hlPnlUsd: hlPnl.netPnl, hlCloseFee: hlPnl.totalFee,
                peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
              });
              log(`[TP CLOSE] Trade #${trade.id} ${trade.coin} ${trade.side} | HL P&L: $${hlPnl.netPnl.toFixed(2)}`, "engine");
            } else {
              // Fill not yet available — store estimate, sync will fix later
              const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
              await storage.updateTrade(trade.id, {
                exitPrice: currentPrice, pnl: 0, pnlPct: finalPnlOfAum,
                hlPnlUsd: pnlUsd, hlCloseFee: 0,
                peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
              });
            }
          } catch (e) {
            log(`[TP CLOSE] Fill fetch error: ${e}`, "engine");
            const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
            await storage.updateTrade(trade.id, {
              exitPrice: currentPrice, pnl: 0, pnlPct: finalPnlOfAum,
              hlPnlUsd: pnlUsd, hlCloseFee: 0,
              peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
            });
          }
        } else {
          // No API — paper mode
          const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
          await storage.updateTrade(trade.id, {
            exitPrice: currentPrice, pnl: 0, pnlPct: finalPnlOfAum,
            hlPnlUsd: pnlUsd, hlCloseFee: 0,
            peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
          });
        }

        await logDecision({
          tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
          reasoning: `EXIT: ${closeReason} | HL P&L: $${pnlUsd.toFixed(2)} | ROI/AUM: ${(eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0).toFixed(3)}%`,
          equity: currentEquity, leverage: trade.leverage, strategy: "bb_rsi_reversion",
        });

        // v12.0: Track consecutive losses + failed setups
        if (pnlUsd < 0) {
          this.consecutiveLosses++;
          this.failedSetups.set(`${trade.coin}_${trade.side}`, Date.now());
          log(`[QHF] Loss streak: ${this.consecutiveLosses} | Failed setup: ${trade.coin}_${trade.side}`, "engine");
        } else {
          this.consecutiveLosses = 0;
        }
        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [QHF] ${trade.side.toUpperCase()} ${trade.coin} | HL P&L: $${pnlUsd.toFixed(2)} USDC | ${closeReason}`,
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

    // v11.2: Use hlPnlUsd directly for P&L snapshot
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

      // v11.2: After close, fetch actual P&L from HL fills
      await new Promise(r => setTimeout(r, 1500));
      try {
        const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
        const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
        const hlPnl = extractClosePnlFromFills(fills, trade.coin, trade.side as any, tradeOpenTime);
        if (hlPnl) {
          const eq = this.lastKnownEquity || 0;
          const eqForClose = (trade as any).entryEquity || eq;
          const pnlOfAum = eqForClose > 0 ? (hlPnl.netPnl / eqForClose) * 100 : 0;
          const updated = await storage.updateTrade(trade.id, {
            exitPrice: hlPnl.exitPrice, pnl: 0, pnlPct: pnlOfAum,
            hlPnlUsd: hlPnl.netPnl, hlCloseFee: hlPnl.totalFee,
            status: "closed", closeReason: `Manual close | HL P&L: $${hlPnl.netPnl.toFixed(2)}`,
            closedAt: new Date().toISOString(),
          });
          await logDecision({
            tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: hlPnl.exitPrice,
            reasoning: `MANUAL CLOSE | HL P&L: $${hlPnl.netPnl.toFixed(2)} (gross=$${hlPnl.closedPnl.toFixed(2)} fee=$${hlPnl.totalFee.toFixed(2)}) | ROI/AUM: ${pnlOfAum.toFixed(3)}%`,
            equity: eq, leverage: trade.leverage, strategy,
          });
          await storage.createLog({
            type: "trade_close",
            message: `Manual close ${trade.side.toUpperCase()} ${trade.coin} | HL P&L: $${hlPnl.netPnl.toFixed(2)} USDC`,
            timestamp: new Date().toISOString(),
          });
          return updated;
        }
      } catch (e) { log(`[FORCE_CLOSE] Fill fetch error: ${e}`, "engine"); }
    }

    // Fallback: no HL fills available — estimate P&L
    const FEE_RATE_MC = 0.00045;
    const eq = this.lastKnownEquity || 0;
    const eqForClose = (trade as any).entryEquity || eq;
    const posValue = (trade as any).notionalValue || (eqForClose * (trade.size / 100) * trade.leverage);
    const rawMove = trade.side === "long"
      ? (currentPrice - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - currentPrice) / trade.entryPrice;
    const pnlUsd = posValue * rawMove - posValue * FEE_RATE_MC * 2;
    const pnlOfAum = eqForClose > 0 ? (pnlUsd / eqForClose) * 100 : 0;

    const updated = await storage.updateTrade(trade.id, {
      exitPrice: currentPrice, pnl: 0, pnlPct: pnlOfAum,
      hlPnlUsd: pnlUsd, hlCloseFee: 0,
      status: "closed", closeReason: "Manual close (estimated P&L)",
      closedAt: new Date().toISOString(),
    });
    await logDecision({
      tradeId: trade.id, coin: trade.coin, action: "exit", side: trade.side as any, price: currentPrice,
      reasoning: `MANUAL CLOSE | Est P&L: $${pnlUsd.toFixed(2)} | ROI/AUM: ${pnlOfAum.toFixed(3)}%`,
      equity: eq, leverage: trade.leverage, strategy,
    });
    await storage.createLog({
      type: "trade_close",
      message: `Manual close ${trade.side.toUpperCase()} ${trade.coin} | Est P&L: $${pnlUsd.toFixed(2)} USDC`,
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
    // Persist baseline so it survives restarts
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
    // Only count trades opened after the P&L reset for the main display
    const resetTs = this.pnlResetTimestamp;
    const activeTrades = resetTs
      ? allTrades.filter(t => t.openedAt >= resetTs)
      : allTrades;
    const activeClosedTrades = activeTrades.filter(t => t.status === "closed");
    const allClosedTrades = allTrades.filter(t => t.status === "closed"); // for all-time stats
    // v11.2: Win/loss uses hlPnlUsd (ground truth from HL) — falls back to pnlPct for legacy
    const winTrades = activeClosedTrades.filter(t => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return t.hlPnlUsd > 0;
      return (t.pnlPct || 0) > 0;
    });
    const winRate = activeClosedTrades.length > 0 ? (winTrades.length / activeClosedTrades.length) * 100 : 0;
    const si = getSessionInfo();
    const stats = await getLearningStats();

    const currentEquity = this.lastKnownEquity || 0;
    const startEq = this.pnlResetEquity || this.startingEquity || currentEquity;

    // v11.2: Use hlPnlUsd directly for USDC P&L totals — THE source of truth
    // Closed trades: sum hlPnlUsd (net realized P&L from HL)
    const closedPnlUsd = activeClosedTrades.reduce((s, t) => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return s + t.hlPnlUsd;
      // Legacy fallback: reconstruct from pnlPct
      return s + (startEq > 0 ? startEq * ((t.pnlPct || 0) / 100) : 0);
    }, 0);
    // Open trades: sum hlPnlUsd (unrealized P&L from HL clearinghouseState)
    const openPnlUsd = openTrades.reduce((s, t) => {
      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return s + t.hlPnlUsd;
      // Legacy fallback
      return s + (currentEquity > 0 ? currentEquity * ((t.pnlPct || 0) / 100) : 0);
    }, 0);
    const combinedPnlUsd = closedPnlUsd + openPnlUsd;

    // Derive % of AUM from USDC amounts
    const closedPnlOfAum = startEq > 0 ? (closedPnlUsd / startEq) * 100 : 0;
    const openPnlOfAum = currentEquity > 0 ? (openPnlUsd / currentEquity) * 100 : 0;
    const combinedPnlOfAum = startEq > 0 ? (combinedPnlUsd / startEq) * 100 : 0;

    // Drawdown from day start
    const drawdownPct = this.dayStartEquity > 0 ? ((this.dayStartEquity - currentEquity) / this.dayStartEquity) * 100 : 0;
    const drawdownUsd = this.dayStartEquity - currentEquity;

    // v11.2: Per-trade P&L for open positions — prefer hlPnlUsd
    const openTradesWithUsd = openTrades.map(t => {
      const eqForT = (t as any).entryEquity || currentEquity;
      const pnlUsd = (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) ? t.hlPnlUsd : 0;
      const pnlOfAum = eqForT > 0 ? (pnlUsd / eqForT) * 100 : 0;
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)) };
    });

    // Per-strategy stats (using post-reset trades only)
    const closedTrades = activeClosedTrades;
    const confluenceTrades = closedTrades.filter(t => (t.strategy || "confluence") === "confluence");
    const extremeTrades = closedTrades.filter(t => t.strategy === "extreme_rsi");
    const bbReversionTrades = closedTrades.filter(t => t.strategy === "bb_rsi_reversion");
    const breakoutRetestTrades = closedTrades.filter(t => t.strategy === "breakout_retest");
    // v11.2: Win rate uses hlPnlUsd
    const winRateCalc = (trades: typeof closedTrades) => {
      if (trades.length === 0) return 0;
      const wins = trades.filter(t => {
        if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return t.hlPnlUsd > 0;
        return (t.pnlPct || 0) > 0;
      });
      return (wins.length / trades.length) * 100;
    };
    const confluenceWinRate = winRateCalc(confluenceTrades);
    const extremeWinRate = winRateCalc(extremeTrades);
    const bbReversionWinRate = winRateCalc(bbReversionTrades);
    const breakoutRetestWinRate = winRateCalc(breakoutRetestTrades);

    // v11.2: Per-strategy P&L from hlPnlUsd directly
    const strategyPnlCalc = (trades: typeof closedTrades) => {
      const pnlUsd = trades.reduce((s, t) => {
        if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) return s + t.hlPnlUsd;
        return s + (startEq > 0 ? startEq * ((t.pnlPct || 0) / 100) : 0);
      }, 0);
      const pnlOfAumPct = startEq > 0 ? (pnlUsd / startEq) * 100 : 0;
      return { pnlOfAumPct, pnlUsd };
    };
    const confluenceStats = strategyPnlCalc(confluenceTrades);
    const extremeStats = strategyPnlCalc(extremeTrades);
    const bbReversionStats = strategyPnlCalc(bbReversionTrades);
    const breakoutRetestStats = strategyPnlCalc(breakoutRetestTrades);

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
      dailyTradeTarget: 200,
      equity: currentEquity.toFixed(2),
      startingEquity: startEq.toFixed(2),
      pnlResetTimestamp: this.pnlResetTimestamp || null,
      learningStats: stats,
      allowedAssets: ALLOWED_ASSETS.map(a => ({ coin: a.coin, name: a.displayName, category: a.category, maxLev: a.maxLeverage })),
      openTradesWithUsd,
      // Per-strategy breakdown (post-reset only)
      strategyStats: {
        confluence: { trades: confluenceTrades.length, winRate: confluenceWinRate.toFixed(1), openPositions: openTrades.filter(t => (t.strategy || "confluence") === "confluence").length, pnlUsd: confluenceStats.pnlUsd.toFixed(4), pnlOfAum: confluenceStats.pnlOfAumPct.toFixed(3), status: "disabled" },
        extreme_rsi: { trades: extremeTrades.length, winRate: extremeWinRate.toFixed(1), openPositions: openTrades.filter(t => t.strategy === "extreme_rsi").length, pnlUsd: extremeStats.pnlUsd.toFixed(4), pnlOfAum: extremeStats.pnlOfAumPct.toFixed(3), status: "active" },
        bb_rsi_reversion: { trades: bbReversionTrades.length, winRate: bbReversionWinRate.toFixed(1), openPositions: openTrades.filter(t => t.strategy === "bb_rsi_reversion").length, pnlUsd: bbReversionStats.pnlUsd.toFixed(4), pnlOfAum: bbReversionStats.pnlOfAumPct.toFixed(3), status: "active" },
        breakout_retest: { trades: breakoutRetestTrades.length, winRate: breakoutRetestWinRate.toFixed(1), openPositions: openTrades.filter(t => t.strategy === "breakout_retest").length, pnlUsd: breakoutRetestStats.pnlUsd.toFixed(4), pnlOfAum: breakoutRetestStats.pnlOfAumPct.toFixed(3), status: "active" },
      },
    };
  }
}

export const tradingEngine = new TradingEngine();
export { ALLOWED_ASSETS };
