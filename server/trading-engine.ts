/**
 * HyperTrader — Trading Engine v11.0
 *
 * MULTI-ASSET: Crypto + HIP-3 TradFi (Gold, Silver, Oil, S&P 500, EUR/USD)
 *
 * PURE RSI STRATEGY:
 *   - LONG when 5m or 15m RSI ≤ 20 → instant market buy
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

    // Auto-reset P&L baseline to current AUM on every start
    this.pnlResetTimestamp = new Date().toISOString();
    this.pnlResetEquity = this.lastKnownEquity;

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
      message: `Engine v11.0 started | PURE RSI (≤20/≥85) | ${ALLOWED_ASSETS.length} assets | AUM: $${this.lastKnownEquity.toLocaleString()} | MAX leverage | ${insights.length} learned insights | NO SL | TP +0.5%`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v7 started — PURE RSI (≤20/≥85, TP +0.5%) — AUM: $${this.lastKnownEquity.toFixed(2)} | ${insights.length} learned insights | NO SL | TP +0.5%`, "engine");
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
        const LONG_THRESHOLD = 20;
        const SHORT_THRESHOLD = 85;

        if (rsi5m <= LONG_THRESHOLD || rsi15m <= LONG_THRESHOLD) {
          scanSignal = "oversold_long";
          scanDetails = `RSI ≤20: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`;
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
        message: `Scan #${this.scanCount}: ${slotsUsed} entries | AUM: $${equity.toLocaleString()} | v11.0 PURE RSI (≤20/≥85)`,
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

    };
  }
}

export const tradingEngine = new TradingEngine();
export { ALLOWED_ASSETS };
