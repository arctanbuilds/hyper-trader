/**
 * HyperTrader — Trading Engine v14.2
 *
 * SINGLE STRATEGY: RSI18
 *   - BTC ONLY, LONG only, RSI ≤ 18 on 5m OR 15m
 *   - 90% equity, 40x leverage, max 1 position
 *   - SL -0.5% from fill (placed immediately)
 *   - TP +0.5%
 *   - Breakeven SL: move SL to entry when price hits +0.25%
 *   - Scan every 5 seconds
 *   - Cancel all orders on close (ghost position prevention)
 *   - Orphan detector on startup
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

const ALLOWED_ASSETS: AssetConfig[] = [
  { coin: "BTC",  displayName: "Bitcoin",     dex: "", maxLeverage: 40, szDecimals: 5, category: "crypto", minNotional: 10 },
];

// ============ STRATEGY TYPE ============
type StrategyType = "rsi18";

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

// ============ HORIZONTAL SUPPORT DETECTION ============

function findHorizontalSupport(candles: OHLCVCandle[], currentPrice: number): { level: number; touches: number } | null {
  if (candles.length < 20) return null;

  const lows = candles.map(c => c.low);
  const clusters: { level: number; touches: number }[] = [];
  const used = new Set<number>();

  for (let i = 0; i < lows.length; i++) {
    if (used.has(i)) continue;
    let sumPx = lows[i];
    let count = 1;
    const group = [i];

    for (let j = i + 1; j < lows.length; j++) {
      if (used.has(j)) continue;
      const avg = sumPx / count;
      if (Math.abs(lows[j] - avg) / avg <= 0.003) { // within 0.3%
        sumPx += lows[j];
        count++;
        group.push(j);
      }
    }

    if (count >= 3) {
      const avgLevel = sumPx / count;
      if (avgLevel < currentPrice) {
        clusters.push({ level: parseFloat(avgLevel.toFixed(6)), touches: count });
        group.forEach(idx => used.add(idx));
      }
    }
  }

  if (clusters.length === 0) return null;

  clusters.sort((a, b) => Math.abs(currentPrice - a.level) - Math.abs(currentPrice - b.level));
  return clusters[0];
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
  private scanCount = 0;
  private lastLearningReview = 0;
  private pnlResetTimestamp = "";
  private pnlResetEquity = 0;

  // RSI18 cross state — only enter once per RSI extreme event (BTC only)
  private rsi18CrossState: Map<string, { price: number; timestamp: number; rsi: number }> = new Map();

  // Robust position sync — track consecutive "no position" readings per tradeId
  private syncMissCount: Map<number, number> = new Map();

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

    // v14.2: Force fresh P&L baseline on v14.2 deploy
    const V14_DEPLOY = "2026-04-19T18:00:00.000Z";
    if (!config.pnlBaselineTimestamp || config.pnlBaselineTimestamp < V14_DEPLOY) {
      this.pnlResetTimestamp = new Date().toISOString();
      this.pnlResetEquity = this.lastKnownEquity;
      this.startingEquity = this.lastKnownEquity;
      await storage.updateConfig({
        pnlBaselineEquity: this.lastKnownEquity,
        pnlBaselineTimestamp: this.pnlResetTimestamp,
      });
      log(`[v14.1] Fresh start — P&L baseline reset to $${this.lastKnownEquity.toFixed(2)}`, "engine");
    } else {
      // Normal restore: baseline already set to v14.1 or later
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

    // Clean stale scan rows for coins no longer in ALLOWED_ASSETS
    await storage.deleteScansNotIn(ALLOWED_ASSETS.map(a => a.coin));

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
      message: `Engine v14.2 started | RSI18 (BTC only, ≤18, 5m OR 15m) | 90% equity | 40x | SL -0.5% | TP +0.5% | BE @ +0.25% | AUM: $${this.lastKnownEquity.toLocaleString()}`,
      timestamp: new Date().toISOString(),
    });
    log(`Engine v14.2 started | RSI18 (BTC only, ≤18) | 90% equity | 40x | SL -0.5% | TP +0.5% | BE @ +0.25% — AUM: $${this.lastKnownEquity.toFixed(2)}`, "engine");
    this.scheduleNextScan();
  }

  async stop() {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
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
    equityPct: number;    // 0.50 for both
    leverage: number;
    tpMultiplier: number; // 1.005 for rsi18, 1.0043 for div
    slMultiplier: number; // 0.995 for both
    rsi5m: number;
    rsi15m: number;
    triggerRSI: number;
    price: number;
    equity: number;
    entryReason: string;
    config: any;
  }): Promise<boolean> {
    const { asset, strategy, equityPct, leverage, tpMultiplier, slMultiplier, rsi5m, rsi15m, triggerRSI, price, equity, entryReason, config } = params;
    const stratLabel = strategy === "rsi18" ? "RSI18" : "DIV";

    // Position sizing — equityPct of equity, at leverage
    const capitalForTrade = equity * equityPct;
    const notionalSize = capitalForTrade * leverage;
    const assetSize = notionalSize / price;

    if (capitalForTrade < 5) {
      log(`[${stratLabel}] SKIP ${asset.coin}: capital too low ($${capitalForTrade.toFixed(2)})`, "engine");
      return false;
    }

    const tp = price * tpMultiplier;
    const sl = price * slMultiplier;
    const tpPctLabel = strategy === "rsi18" ? "+0.5%" : "+0.43%";

    log(`[${stratLabel}] ${asset.coin} LONG @ $${price} | TP ${tpPctLabel} | SL -0.5% | BE @ +0.25% | ${leverage}x | ${entryReason}`, "engine");

    let fillPrice = price;
    let filledSz = 0;

    if (config.apiSecret && config.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const isCross = !asset.isolatedOnly;
        await executor.setLeverage(asset.coin, leverage, isCross);
        const orderPrice = price * 1.01; // 1% slippage for long
        const roundedSize = parseFloat(formatHLSize(assetSize, asset.szDecimals));
        if (roundedSize <= 0) {
          log(`[${stratLabel}] SKIP ${asset.coin}: rounded size is 0`, "engine");
          return false;
        }

        const orderResult = await executor.placeOrder({
          coin: asset.coin, isBuy: true, sz: roundedSize,
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
          await storage.createLog({ type: "order_error", message: `${stratLabel} REJECTED: ${asset.coin} LONG — ${errorMsg}`, timestamp: new Date().toISOString() });
          return false;
        } else if (fillPx && parseFloat(totalSz) > 0) {
          fillPrice = parseFloat(fillPx);
          filledSz = parseFloat(totalSz);
          log(`[${stratLabel}] FILLED: ${asset.coin} LONG sz=${totalSz} @ $${fillPx}`, "engine");
        } else {
          log(`[${stratLabel}] IOC NOT FILLED: ${asset.coin} LONG`, "engine");
          await storage.createLog({ type: "order_unfilled", message: `${stratLabel} NOT FILLED: ${asset.coin} LONG`, timestamp: new Date().toISOString() });
          return false;
        }
      } catch (execErr) {
        log(`[${stratLabel}] ORDER FAILED: ${asset.coin} — ${execErr}`, "engine");
        await storage.createLog({ type: "order_error", message: `${stratLabel} FAILED: ${asset.coin} LONG — ${execErr}`, timestamp: new Date().toISOString() });
        return false;
      }
    } else {
      // Paper mode — simulate fill at current price
      filledSz = parseFloat(formatHLSize(assetSize, asset.szDecimals));
      if (filledSz <= 0) return false;
    }

    if (filledSz <= 0) return false;

    // Recalculate TP and SL based on actual fill price
    const actualTP = fillPrice * tpMultiplier;
    const actualSL = fillPrice * slMultiplier;
    const actualNotional = filledSz * fillPrice;

    const trade = await storage.createTrade({
      coin: asset.coin, side: "long", entryPrice: fillPrice, size: Math.round(equityPct * 100), leverage,
      entryEquity: equity,
      notionalValue: actualNotional,
      rsiAtEntry: triggerRSI, rsi4h: 0, rsi1d: 0,
      ema10: 0, ema21: 0, ema50: 0,
      stopLoss: actualSL,  // SL -0.5% placed immediately
      takeProfit1: actualTP,
      takeProfit2: actualTP,
      tp1Hit: false,
      confluenceScore: 0,
      confluenceDetails: `${stratLabel}: ${entryReason} | 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`,
      riskRewardRatio: strategy === "rsi18" ? 1.0 : 0.86,
      status: "open",
      reason: `[${stratLabel}] ${asset.coin} LONG | ${entryReason} | SL -0.5% | TP ${tpPctLabel} | BE @ +0.25% | ${leverage}x`,
      setupType: strategy,
      strategy,
      openedAt: new Date().toISOString(),
    });

    // Place SL order on HL immediately (-0.5%)
    if (config.apiSecret && config.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const slTriggerPx = parseFloat(formatHLPrice(actualSL, asset.szDecimals));
        const slFillPx = parseFloat(formatHLPrice(actualSL * 0.98, asset.szDecimals));
        await executor.placeOrder({
          coin: asset.coin, isBuy: false, sz: filledSz,
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
      tradeId: trade.id, coin: asset.coin, action: "entry", side: "long", price: fillPrice,
      reasoning: `${stratLabel}: ${asset.coin} LONG | ${entryReason} | SL $${actualSL.toFixed(2)} (-0.5%) | TP $${actualTP.toFixed(2)} (${tpPctLabel}) | BE @ +0.25% | ${leverage}x | $${capitalForTrade.toFixed(0)} capital`,
      equity, leverage, positionSizeUsd: capitalForTrade, strategy,
    });

    await storage.createLog({
      type: "trade_open",
      message: `[${stratLabel}] ${asset.coin} LONG @ $${displayPrice(fillPrice, asset.szDecimals)} | ${leverage}x | ${entryReason} | SL -0.5% | TP ${tpPctLabel} | BE @ +0.25% | $${capitalForTrade.toFixed(0)}`,
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

      log(`Scan #${this.scanCount} | AUM: $${equity.toLocaleString()} | v14.2 RSI18 (BTC, ≤18) | 90% equity | 40x`, "engine");

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
      const rsi18Open = openTrades.filter(t => t.strategy === "rsi18");

      const RSI18_MAX_POSITIONS = 1;

      let totalEntries = 0;

      // ================================================================
      // STRATEGY A: RSI18 — BTC ONLY
      // Signal: 5m RSI ≤ 18 OR 15m RSI ≤ 18
      // 50% equity, 40x, max 1 position, TP +0.5%, SL -0.5%, BE @ +0.25%
      // ================================================================
      {
        const RSI18_THRESHOLD = 18;
        const RSI18_RESET_THRESHOLD = 25;
        const btcAsset = ALLOWED_ASSETS.find(a => a.coin === "BTC")!;

        const ctx = assetCtxMap["BTC"];
        if (ctx?.midPx && ctx.midPx !== "None") {
          const price = parseFloat(ctx.midPx);
          if (!isNaN(price) && price > 0) {
            const volume24h = parseFloat(ctx.dayNtlVlm || "0");
            const funding = parseFloat(ctx.funding || "0");
            const openInterest = parseFloat(ctx.openInterest || "0");
            const prevDayPx = parseFloat(ctx.prevDayPx || String(price));
            const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;

            const [ohlcv5m, ohlcv15m] = await Promise.all([
              fetchCandlesOHLCV("BTC", "5m", 30),
              fetchCandlesOHLCV("BTC", "15m", 30),
            ]);

            const c5m = ohlcv5m.map(c => c.close);
            const c15m = ohlcv15m.map(c => c.close);

            if (c5m.length >= 15 || c15m.length >= 15) {
              // Intra-candle RSI — append current live price
              const rsi5m = c5m.length >= 15 ? calculateRSI([...c5m, price]) : 50;
              const rsi15m = c15m.length >= 15 ? calculateRSI([...c15m, price]) : 50;

              // Signal: 5m OR 15m ≤ 18
              const rsi18Signal = rsi5m <= RSI18_THRESHOLD || rsi15m <= RSI18_THRESHOLD;
              const triggerRSI = Math.min(rsi5m, rsi15m);
              const triggeredTF = rsi5m <= RSI18_THRESHOLD ? (rsi15m <= RSI18_THRESHOLD ? "5m+15m" : "5m") : "15m";

              let scanSignal: string = "neutral";
              let scanDetails = "";

              if (rsi18Signal) {
                scanSignal = "rsi18_oversold";
                scanDetails = `RSI18: ${triggeredTF} triggered | 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`;
              } else {
                scanDetails = `RSI18: 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)} | Need ≤18 on either TF`;
              }

              await storage.upsertMarketScan({
                coin: "BTC", price, rsi5m, rsi15m, rsi: 50, rsi4h: 50, rsi1d: 50,
                ema10: 0, ema21: 0, ema50: 0,
                volume24h, change24h,
                signal: scanSignal,
                fundingRate: funding, openInterest,
                confluenceScore: rsi18Signal ? 10 : 0,
                confluenceDetails: scanDetails,
                riskRewardRatio: 0,
                timestamp: new Date().toISOString(),
              });

              const crossKey = `BTC_rsi18_long`;

              // Reset cross state when RSI recovers above 25 on BOTH timeframes
              if (!rsi18Signal && rsi5m > RSI18_RESET_THRESHOLD && rsi15m > RSI18_RESET_THRESHOLD) {
                if (this.rsi18CrossState.has(crossKey)) {
                  this.rsi18CrossState.delete(crossKey);
                  log(`[RSI18] BTC cross state reset — 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)} both > ${RSI18_RESET_THRESHOLD}`, "engine");
                }
              }

              // Entry: RSI18 signal, no position already open for this strategy, slot available
              if (rsi18Signal && rsi18Open.length < RSI18_MAX_POSITIONS) {
                if (!this.rsi18CrossState.has(crossKey)) {
                  this.rsi18CrossState.set(crossKey, { price, timestamp: Date.now(), rsi: triggerRSI });

                  const entryReason = `RSI18: ${triggeredTF}=${triggerRSI.toFixed(1)} ≤ 18`;
                  const entered = await this.executeEntry({
                    asset: btcAsset,
                    strategy: "rsi18",
                    equityPct: 0.90,
                    leverage: btcAsset.maxLeverage, // 40x
                    tpMultiplier: 1.005,   // +0.5%
                    slMultiplier: 0.995,   // -0.5%
                    rsi5m, rsi15m, triggerRSI, price, equity,
                    entryReason,
                    config,
                  });

                  if (entered) {
                    totalEntries++;
                    this.dailyTradeCount++;
                  } else {
                    // Remove cross state if entry failed (didn't fill)
                    this.rsi18CrossState.delete(crossKey);
                  }
                }
              }
            }
          }
        }
      }

      // Log scan summary
      await storage.createLog({
        type: "scan",
        message: `Scan #${this.scanCount}: ${totalEntries} entries | AUM: $${equity.toLocaleString()} | v14.2 RSI18 (BTC, ≤18) | 90% equity | 40x`,
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
    const currentEquity = equity || this.lastKnownEquity || 0;

    // ============================================================
    // READ ALL P&L DIRECTLY FROM HYPERLIQUID
    // Open positions: unrealizedPnl from clearinghouseState
    // Closed positions: closedPnl + fee from userFills
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
              const pv = (trade as any).notionalValue || (syncEq * (trade.size / 100) * trade.leverage);
              const rm = (exitPrice - trade.entryPrice) / trade.entryPrice; // long only
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
            log(`[SYNC] Trade #${trade.id} ${trade.coin} long auto-closed | HL P&L: $${netPnl.toFixed(2)}`, "engine");
            await storage.createLog({
              type: "trade_close",
              message: `[SYNC] Auto-closed ${trade.coin} long #${trade.id} | HL P&L: $${netPnl.toFixed(2)} USDC`,
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
    // OPEN TRADE MONITORING: read unrealizedPnl from HL + check TP/BE
    // RSI18: LONG only, SL -0.5%, TP +0.5%, BE @ +0.25%
    // ============================================================
    for (const trade of openTrades) {
      const currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0) continue;
      const ac = ALLOWED_ASSETS.find(a => a.coin === trade.coin);
      const szd = ac?.szDecimals ?? 2;
      const eqForTrade = (trade as any).entryEquity || currentEquity;

      const stratLabel = "RSI18";
      const tpPctLabel = "TP +0.5%";

      // Read unrealizedPnl directly from HL position
      const hlPos = hlPosMap.get(trade.coin);
      let pnlUsd: number;
      if (hlPos?.unrealizedPnl !== undefined) {
        pnlUsd = parseFloat(hlPos.unrealizedPnl);
      } else {
        const positionValue = (trade as any).notionalValue || (eqForTrade * (trade.size / 100) * trade.leverage);
        const rawMove = (currentPrice - trade.entryPrice) / trade.entryPrice; // long only
        pnlUsd = positionValue * rawMove - positionValue * 0.00045 * 2;
      }
      const pnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;

      // Breakeven SL at +0.25%
      // SL starts at -0.5% from entry — move to entry (BE) when price reaches +0.25%
      const rawPricePct = (currentPrice - trade.entryPrice) / trade.entryPrice; // long only
      const beSL = trade.entryPrice; // breakeven = entry price
      const originalSL = trade.entryPrice * 0.995; // -0.5% from entry
      const slStillAtOriginal = trade.stopLoss > 0 && Math.abs(trade.stopLoss - originalSL) < trade.entryPrice * 0.001;

      if (slStillAtOriginal && rawPricePct >= 0.0025) {
        // Price moved +0.25% — activate BE SL at entry price
        await storage.updateTrade(trade.id, { stopLoss: beSL });
        trade.stopLoss = beSL;
        log(`[BE SL] Trade #${trade.id} ${trade.coin} LONG [${stratLabel}] | Price +${(rawPricePct*100).toFixed(2)}% → BE SL activated @ $${displayPrice(beSL, szd)}`, "engine");

        // Place stop-market SL on HL at entry price
        if (config.apiSecret && config.walletAddress) {
          try {
            const executor = createExecutor(config.apiSecret, config.walletAddress);
            // Cancel any existing orders for this coin
            const openOrders = await executor.getOpenOrders();
            for (const order of openOrders.filter((o: any) => o.coin === trade.coin)) {
              await executor.cancelOrder(order.coin, order.oid);
            }
            // Place BE SL
            const posFromMap = hlPosMap.get(trade.coin);
            const sz = posFromMap ? Math.abs(parseFloat(posFromMap.szi || "0")) : 0;
            if (sz > 0) {
              const slTriggerPx = parseFloat(formatHLPrice(beSL, szd));
              const slFillPx = parseFloat(formatHLPrice(beSL * 0.98, szd)); // sell slightly below BE
              await executor.placeOrder({
                coin: trade.coin, isBuy: false, sz, // sell to close long
                limitPx: slFillPx,
                orderType: { trigger: { triggerPx: String(slTriggerPx), isMarket: true, tpsl: "sl" } },
                reduceOnly: true,
              });
              log(`[BE SL] ${trade.coin} SL order placed @ $${slTriggerPx} (entry price, BE SL activated @ +0.25%) [${stratLabel}]`, "engine");
            }
          } catch (beErr) { log(`[BE SL] SL update error: ${beErr}`, "engine"); }
        }

        await storage.createLog({
          type: "system",
          message: `[${stratLabel}] BE SL activated @ +0.25% | ${trade.coin} LONG | SL now @ $${displayPrice(beSL, szd)}`,
          timestamp: new Date().toISOString(),
        });
      }

      // Exit checks
      let shouldClose = false;
      let closeReason = "";

      // TP hit: price >= takeProfit1
      // trade.takeProfit1 is stored at entry: rsi18 = entry * 1.005, div = entry * 1.0043
      const tpHit = currentPrice >= (trade.takeProfit1 || Infinity);
      // SL hit: either at original -0.5% or at BE (entry price)
      const slActive = trade.stopLoss > 0;
      const slHit = slActive && currentPrice <= trade.stopLoss;

      const isBE = slActive && trade.stopLoss >= trade.entryPrice * 0.999; // SL is at or near entry = BE was activated

      if (tpHit) {
        shouldClose = true;
        closeReason = `[${stratLabel}] ${tpPctLabel} @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
      } else if (slHit) {
        shouldClose = true;
        closeReason = isBE
          ? `[${stratLabel}] SL @ BE $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`
          : `[${stratLabel}] SL -0.5% hit @ $${displayPrice(currentPrice, szd)} | $${pnlUsd.toFixed(2)}`;
        log(`[SL HIT] Trade #${trade.id} ${trade.coin} LONG [${stratLabel}] | Price $${displayPrice(currentPrice, szd)} hit SL $${displayPrice(trade.stopLoss, szd)}`, "engine");
      }

      if (shouldClose) {
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
              await executor.placeOrder({
                coin: trade.coin, isBuy: false, sz, // sell to close long
                limitPx: parseFloat(formatHLPrice(currentPrice * 0.99, szd)), // 1% slippage
                orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
              });
            }
          } catch (e) { log(`Close error: ${e}`, "engine"); }

          // After close, fetch actual P&L from HL fills
          await new Promise(r => setTimeout(r, 1500));
          try {
            const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
            const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
            const hlPnl = extractClosePnlFromFills(fills, trade.coin, "long", tradeOpenTime);
            if (hlPnl) {
              pnlUsd = hlPnl.netPnl;
              const exitLabel = slHit ? (isBE ? "SL @ BE" : "SL -0.5%") : tpPctLabel;
              closeReason = `[${stratLabel}] ${exitLabel} | HL P&L: $${hlPnl.netPnl.toFixed(2)} (gross=$${hlPnl.closedPnl.toFixed(2)} fee=$${hlPnl.totalFee.toFixed(2)})`;
              const finalPnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
              await storage.updateTrade(trade.id, {
                exitPrice: hlPnl.exitPrice, pnl: 0, pnlPct: finalPnlOfAum,
                hlPnlUsd: hlPnl.netPnl, hlCloseFee: hlPnl.totalFee,
                peakPnlPct: 0, status: "closed", closeReason, closedAt: new Date().toISOString(),
              });
              log(`[CLOSE] Trade #${trade.id} ${trade.coin} LONG [${stratLabel}] | HL P&L: $${hlPnl.netPnl.toFixed(2)}`, "engine");
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
          tradeId: trade.id, coin: trade.coin, action: "exit", side: "long", price: currentPrice,
          reasoning: `EXIT [${stratLabel}]: ${closeReason} | HL P&L: $${pnlUsd.toFixed(2)} | ROI/AUM: ${(eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0).toFixed(3)}%`,
          equity: currentEquity, leverage: trade.leverage, strategy: (trade.strategy as StrategyType) || "rsi18",
        });

        await storage.createLog({
          type: "trade_close",
          message: `CLOSED [${stratLabel}] LONG ${trade.coin} | HL P&L: $${pnlUsd.toFixed(2)} USDC | ${closeReason}`,
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

    const stratLabel = "RSI18";

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
          await executor.placeOrder({
            coin: trade.coin, isBuy: false, sz, // sell to close long
            limitPx: parseFloat(formatHLPrice(currentPrice * 0.99, ac?.szDecimals ?? 2)),
            orderType: { limit: { tif: "Ioc" } }, reduceOnly: true,
          });
        }
      } catch (e) { log(`Close error: ${e}`, "engine"); }

      await new Promise(r => setTimeout(r, 1500));
      try {
        const tradeOpenTime = new Date(trade.openedAt || 0).getTime();
        const fills = await fetchUserFills(config.walletAddress, tradeOpenTime);
        const hlPnl = extractClosePnlFromFills(fills, trade.coin, "long", tradeOpenTime);
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
            tradeId: trade.id, coin: trade.coin, action: "exit", side: "long", price: hlPnl.exitPrice,
            reasoning: `MANUAL CLOSE [${stratLabel}] | HL P&L: $${hlPnl.netPnl.toFixed(2)} (gross=$${hlPnl.closedPnl.toFixed(2)} fee=$${hlPnl.totalFee.toFixed(2)}) | ROI/AUM: ${pnlOfAum.toFixed(3)}%`,
            equity: eq, leverage: trade.leverage, strategy,
          });
          await storage.createLog({
            type: "trade_close",
            message: `Manual close [${stratLabel}] LONG ${trade.coin} | HL P&L: $${hlPnl.netPnl.toFixed(2)} USDC`,
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
    const rawMove = (currentPrice - trade.entryPrice) / trade.entryPrice; // long only
    const pnlUsd = posValue * rawMove - posValue * FEE_RATE_MC * 2;
    const pnlOfAum = eqForClose > 0 ? (pnlUsd / eqForClose) * 100 : 0;

    const updated = await storage.updateTrade(trade.id, {
      exitPrice: currentPrice, pnl: 0, pnlPct: pnlOfAum,
      hlPnlUsd: pnlUsd, hlCloseFee: 0,
      status: "closed", closeReason: `Manual close [${stratLabel}] (estimated P&L)`,
      closedAt: new Date().toISOString(),
    });
    await logDecision({
      tradeId: trade.id, coin: trade.coin, action: "exit", side: "long", price: currentPrice,
      reasoning: `MANUAL CLOSE [${stratLabel}] | Est P&L: $${pnlUsd.toFixed(2)} | ROI/AUM: ${pnlOfAum.toFixed(3)}%`,
      equity: eq, leverage: trade.leverage, strategy,
    });
    await storage.createLog({
      type: "trade_close",
      message: `Manual close [${stratLabel}] LONG ${trade.coin} | Est P&L: $${pnlUsd.toFixed(2)} USDC`,
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
      const stratBadge = "RSI18";
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)), stratBadge };
    });

    // Strategy A: RSI18 stats
    const rsi18Trades = activeClosedTrades.filter(t => t.strategy === "rsi18");
    const rsi18Wins = rsi18Trades.filter(t => (t.hlPnlUsd ?? (t.pnlPct || 0)) > 0).length;
    const rsi18WinRate = rsi18Trades.length > 0 ? (rsi18Wins / rsi18Trades.length) * 100 : 0;
    const rsi18PnlUsd = rsi18Trades.reduce((s, t) => s + (t.hlPnlUsd ?? (startEq * (t.pnlPct || 0) / 100)), 0);
    const rsi18PnlOfAum = startEq > 0 ? (rsi18PnlUsd / startEq) * 100 : 0;


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
      allowedAssets: ALLOWED_ASSETS.map(a => ({ coin: a.coin, name: a.displayName, category: a.category, maxLev: a.maxLeverage })),
      openTradesWithUsd,
      strategyStats: {
        rsi18: {
          trades: rsi18Trades.length,
          winRate: rsi18WinRate.toFixed(1),
          openPositions: openTrades.filter(t => t.strategy === "rsi18").length,
          pnlUsd: rsi18PnlUsd.toFixed(4),
          pnlOfAum: rsi18PnlOfAum.toFixed(3),
          status: "active",
        },
      },
    };
  }
}

export const tradingEngine = new TradingEngine();
export { ALLOWED_ASSETS };
