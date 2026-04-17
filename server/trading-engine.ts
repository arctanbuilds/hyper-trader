/**
 * HyperTrader — Trading Engine v13.0
 *
 * PURE RSI STRATEGY — BTC + ETH:
 *   - LONG when 5m or 15m RSI ≤ 20 → instant market buy
 *   - SHORT when 5m or 15m RSI ≥ 81 → instant market sell
 *   - SL: -0.50% from entry (full close)
 *   - TP: +0.43% from entry (full close)
 *   - 80% margin, max leverage per asset (BTC 40x, ETH 25x)
 *   - Scan every 5 seconds
 *   - Up to 2 parallel positions (one per coin)
 *   - Bug fixes: cancel all orders on close, orphan position detector
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
  { coin: "BTC",  displayName: "Bitcoin",    dex: "", maxLeverage: 40, szDecimals: 5, category: "crypto", minNotional: 10 },
  { coin: "ETH",  displayName: "Ethereum",   dex: "", maxLeverage: 25, szDecimals: 4, category: "crypto", minNotional: 10 },
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
  // v11.0: RSI cross tracking — record price at the moment RSI first hits extreme
  private rsiCrossState: Map<string, { price: number; timestamp: number; rsi: number }> = new Map();
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

    // v13 SAFETY: Orphan position detector — close HL positions not tracked in DB
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
          // This is an orphan — position on HL but no open trade in DB
          log(`[ORPHAN] Found orphan position: ${pos.coin} size=${pos.szi} entry=${pos.entryPx} — closing`, "engine");
          try {
            // Cancel any orders first
            const openOrders = await executor.getOpenOrders();
            for (const order of openOrders.filter((o: any) => o.coin === pos.coin)) {
              await executor.cancelOrder(order.coin, order.oid);
              log(`[ORPHAN] Cancelled order ${order.coin} oid=${order.oid}`, "engine");
            }
            // Close the position
            const isBuy = parseFloat(pos.szi) < 0; // buy to close short, sell to close long
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
      message: `Engine v13.0 started | PURE RSI (≤20/≥81) | ${ALLOWED_ASSETS.length} assets | AUM: $${this.lastKnownEquity.toLocaleString()} | MAX leverage | SL -0.5% | TP +0.43%`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v13.0 started — PURE RSI (≤20/≥81, TP +0.43%, SL -0.5%) — BTC+ETH — AUM: $${this.lastKnownEquity.toFixed(2)}`, "engine");
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

      // Drawdown check removed — user disabled all exposure reduction
      const canOpenNew = true;

      log(`Scan #${this.scanCount} | AUM: $${equity.toLocaleString()} | BTC+ETH | v13.0 PURE RSI | Trades today: ${this.dailyTradeCount}`, "engine");

      // Fetch market data (crypto only)
      const mainData = await fetchMetaAndAssetCtxs("");
      const assetCtxMap: Record<string, any> = {};
      if (mainData && mainData.length >= 2) {
        const universe = mainData[0]?.universe || [];
        const ctxs = mainData[1] || [];
        for (let i = 0; i < universe.length; i++) {
          if (ctxs[i]) assetCtxMap[universe[i].name] = ctxs[i];
        }
      }

      // Open positions — shared pool
      const openTrades = await storage.getOpenTrades();
      const openCoins = new Set(openTrades.map(t => t.coin));
      const maxPos = config.maxPositions || 8;
      const slotsAvailable = maxPos - openTrades.length;

      // ======================================================================
      // v11.0: PURE RSI STRATEGY
      // LONG: RSI ≤ 20 on 5m or 15m → instant market buy, SL -0.5%, TP +0.35%
      // SHORT: RSI ≥ 81 on 5m or 15m → instant market sell, SL -0.5%, TP +0.35%
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
        const LONG_THRESHOLD = 20;
        const SHORT_THRESHOLD = 81;

        if (rsi5m <= LONG_THRESHOLD || rsi15m <= LONG_THRESHOLD) {
          scanSignal = "oversold_long";
          scanDetails = `RSI ≤20: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`;
        } else if (rsi5m >= SHORT_THRESHOLD || rsi15m >= SHORT_THRESHOLD) {
          scanSignal = "overbought_short";
          scanDetails = `RSI ≥81: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`;
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

        // TP at +0.43%, SL at -0.5%
        const tp = side === "long" ? price * 1.0043 : price * 0.9957;
        const sl = side === "long" ? price * 0.995 : price * 1.005;

        log(`[PURE_RSI] ${asset.coin} ${triggerTF} RSI=${triggerRSI.toFixed(1)} → ${side.toUpperCase()} @ $${price} | TP: $${tp.toFixed(2)} (+0.43%) | SL: $${sl.toFixed(2)} (-0.5%)`, "engine");

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
        let filledSz = 0; // actual filled asset quantity from HL
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
              filledSz = parseFloat(totalSz);
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

        // Recalculate TP and SL based on actual fill price
        const actualTP = side === "long" ? fillPrice * 1.0043 : fillPrice * 0.9957;
        const actualSL = side === "long" ? fillPrice * 0.995 : fillPrice * 1.005;
        // Actual notional = filled size * fill price (GROUND TRUTH for P&L)
        const actualNotional = (filledSz > 0 ? filledSz : assetSize) * fillPrice;

        const trade = await storage.createTrade({
          coin: asset.coin, side, entryPrice: fillPrice, size: 80, leverage,
          entryEquity: equity,
          notionalValue: actualNotional,
          rsiAtEntry: triggerRSI, rsi4h: 0, rsi1d: 0,
          ema10: 0, ema21: 0, ema50: 0,
          stopLoss: actualSL,
          takeProfit1: actualTP,
          takeProfit2: actualTP,
          tp1Hit: false,
          confluenceScore: 0,
          confluenceDetails: `PURE RSI: ${triggerTF} RSI=${triggerRSI.toFixed(1)}`,
          riskRewardRatio: 0.5,
          status: "open",
          reason: `[PURE_RSI] ${side.toUpperCase()} | RSI ${triggerRSI.toFixed(1)} @${triggerTF} | SL -0.5% | TP +0.43% | ${leverage}x`,
          setupType: "bb_rsi_reversion",
          strategy: "bb_rsi_reversion",
          openedAt: new Date().toISOString(),
        });

        // Place SL order on Hyperliquid as stop-market
        if (config.apiSecret && config.walletAddress && filledSz > 0) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            const slTriggerPx = parseFloat(formatHLPrice(actualSL, asset.szDecimals));
            // Stop-market: trigger at SL price, fill at slippage price
            const slFillPx = side === "long"
              ? parseFloat(formatHLPrice(actualSL * 0.98, asset.szDecimals))  // sell below SL
              : parseFloat(formatHLPrice(actualSL * 1.02, asset.szDecimals)); // buy above SL
            await executor.placeOrder({
              coin: asset.coin,
              isBuy: side === "short",  // close direction
              sz: filledSz,
              limitPx: slFillPx,
              orderType: { trigger: { triggerPx: String(slTriggerPx), isMarket: true, tpsl: "sl" } },
              reduceOnly: true,
            });
            log(`[SL ORDER] ${asset.coin} SL placed @ $${slTriggerPx} (-0.5%)`, "engine");
          } catch (slErr) {
            log(`[SL ORDER] FAILED ${asset.coin}: ${slErr} — will monitor in checkExits`, "engine");
          }
        }

        await logDecision({
          tradeId: trade.id, coin: asset.coin, action: "entry", side, price: fillPrice,
          reasoning: `PURE RSI: ${side.toUpperCase()} ${asset.displayName} | RSI ${triggerRSI.toFixed(1)} @${triggerTF} | SL $${actualSL.toFixed(2)} (-0.5%) | TP $${actualTP.toFixed(2)} (+0.43%) | ${leverage}x MAX | $${capitalForTrade.toFixed(0)} capital`,
          equity, leverage, positionSizeUsd: capitalForTrade, strategy: "bb_rsi_reversion",
        });

        await storage.createLog({
          type: "trade_open",
          message: `[PURE_RSI] ${side.toUpperCase()} ${asset.displayName} @ $${displayPrice(fillPrice, asset.szDecimals)} | ${leverage}x | RSI ${triggerRSI.toFixed(1)} @${triggerTF} | SL -0.5% | TP +0.43% | $${capitalForTrade.toFixed(0)}`,
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
        message: `Scan #${this.scanCount}: ${slotsUsed} entries | AUM: $${equity.toLocaleString()} | v13.0 PURE RSI (≤20/≥81) BTC+ETH`,
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
            // v13 SAFETY: Cancel any lingering orders for this coin
            try {
              const openOrders = await syncExec.getOpenOrders();
              const coinOrders = openOrders.filter((o: any) => o.coin === trade.coin);
              for (const order of coinOrders) {
                await syncExec.cancelOrder(order.coin, order.oid);
                log(`[SYNC SAFETY] Cancelled lingering order ${order.coin} oid=${order.oid}`, "engine");
              }
            } catch (cancelErr) { log(`[SYNC SAFETY] Cancel error: ${cancelErr}`, "engine"); }
            // Fetch actual P&L from HL fills
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

      // v13: Move SL to breakeven once price reaches +0.2% profit
      const rawPricePct = trade.side === "long"
        ? (currentPrice - trade.entryPrice) / trade.entryPrice
        : (trade.entryPrice - currentPrice) / trade.entryPrice;
      const beSL = trade.entryPrice; // breakeven = entry price
      const currentSL = trade.stopLoss;
      const isStillOriginalSL = trade.side === "long"
        ? currentSL < trade.entryPrice * 0.999  // SL is below entry (original)
        : currentSL > trade.entryPrice * 1.001;  // SL is above entry (original)
      if (rawPricePct >= 0.002 && isStillOriginalSL) {
        // Move SL to breakeven
        await storage.updateTrade(trade.id, { stopLoss: beSL });
        trade.stopLoss = beSL;
        log(`[BE] Trade #${trade.id} ${trade.coin} ${trade.side} | Price +${(rawPricePct*100).toFixed(2)}% → SL moved to BE @ $${displayPrice(beSL, szd)}`, "engine");
        // Update SL order on HL
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            // Cancel existing SL order
            const openOrders = await executor.getOpenOrders();
            for (const order of openOrders.filter((o: any) => o.coin === trade.coin)) {
              await executor.cancelOrder(order.coin, order.oid);
            }
            // Place new SL at breakeven
            const hlPos = hlPosMap.get(trade.coin);
            const sz = hlPos ? Math.abs(parseFloat(hlPos.szi || "0")) : 0;
            if (sz > 0) {
              const slTriggerPx = parseFloat(formatHLPrice(beSL, szd));
              const slFillPx = trade.side === "long"
                ? parseFloat(formatHLPrice(beSL * 0.98, szd))
                : parseFloat(formatHLPrice(beSL * 1.02, szd));
              await executor.placeOrder({
                coin: trade.coin, isBuy: trade.side === "short", sz,
                limitPx: slFillPx,
                orderType: { trigger: { triggerPx: String(slTriggerPx), isMarket: true, tpsl: "sl" } },
                reduceOnly: true,
              });
              log(`[BE] ${trade.coin} new SL order @ $${slTriggerPx} (breakeven)`, "engine");
            }
          } catch (beErr) { log(`[BE] SL update error: ${beErr}`, "engine"); }
        }
      }

      // v13: Exit on TP (+0.43%) or SL
      let shouldClose = false;
      let closeReason = "";

      const tpHit = (trade.side === "long" && currentPrice >= (trade.takeProfit1 || Infinity)) ||
                    (trade.side === "short" && currentPrice <= (trade.takeProfit1 || 0));
      const slHit = trade.stopLoss > 0 && (
        (trade.side === "long" && currentPrice <= trade.stopLoss) ||
        (trade.side === "short" && currentPrice >= trade.stopLoss)
      );

      const isBE = !isStillOriginalSL; // SL was moved to breakeven
      if (tpHit) {
        shouldClose = true;
        closeReason = `[PURE_RSI] TP +0.43% @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
      } else if (slHit) {
        shouldClose = true;
        closeReason = isBE
          ? `[PURE_RSI] SL @ BE $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`
          : `[PURE_RSI] SL -0.5% @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
        log(`[SL HIT] Trade #${trade.id} ${trade.coin} ${trade.side} | Price $${displayPrice(currentPrice, szd)} hit SL $${displayPrice(trade.stopLoss, szd)}`, "engine");
      }

      if (shouldClose) {
        // Execute full close on Hyperliquid
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            // v13 SAFETY: Cancel ALL open orders for this coin BEFORE closing
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
              const exitLabel = slHit ? (isBE ? "SL @ BE" : "SL -0.5%") : "TP +0.43%";
              closeReason = `[PURE_RSI] ${exitLabel} | HL P&L: $${hlPnl.netPnl.toFixed(2)} (gross=$${hlPnl.closedPnl.toFixed(2)} fee=$${hlPnl.totalFee.toFixed(2)})`;
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

        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [PURE_RSI] ${trade.side.toUpperCase()} ${trade.coin} | HL P&L: $${pnlUsd.toFixed(2)} USDC | ${closeReason}`,
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
      dailyTradeTarget: 20,
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
