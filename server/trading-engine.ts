/**
 * Hyperliquid Trading Engine
 * 
 * Strategy: Long severely oversold assets (RSI < threshold), short severely overbought (RSI > threshold)
 * Additional confluence: Volume filter, funding rate alignment, 24h momentum
 * Goal: Aggressive position-taking with high leverage to target 50%/week returns
 */

import { storage } from "./storage";
import { log } from "./index";
import { createExecutor } from "./hyperliquid-executor";

// ============ RSI CALCULATION ============
function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // neutral if not enough data
  
  let gains = 0;
  let losses = 0;
  
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
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ============ HYPERLIQUID API HELPERS ============
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";

interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

interface MarketData {
  coin: string;
  price: number;
  volume24h: number;
  change24h: number;
  fundingRate: number;
  openInterest: number;
}

async function fetchMeta(): Promise<{ universe: AssetMeta[] }> {
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    return await res.json() as any;
  } catch (e) {
    log(`Error fetching meta: ${e}`, "engine");
    return { universe: [] };
  }
}

async function fetchAllMids(): Promise<Record<string, string>> {
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    return await res.json() as any;
  } catch (e) {
    log(`Error fetching mids: ${e}`, "engine");
    return {};
  }
}

async function fetchCandles(coin: string, interval: string = "1h", limit: number = 100): Promise<number[]> {
  try {
    const endTime = Date.now();
    const startTime = endTime - (limit * 3600 * 1000); // approximate for 1h candles
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin, interval, startTime, endTime },
      }),
    });
    const candles: any[] = await res.json() as any;
    return candles.map((c: any) => parseFloat(c.c)); // close prices
  } catch (e) {
    log(`Error fetching candles for ${coin}: ${e}`, "engine");
    return [];
  }
}

async function fetchUserState(address: string): Promise<any> {
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    });
    return await res.json();
  } catch (e) {
    log(`Error fetching user state: ${e}`, "engine");
    return null;
  }
}

async function fetchFundingRates(): Promise<Record<string, number>> {
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    });
    const data: any = await res.json();
    const rates: Record<string, number> = {};
    if (data && data.length === 2) {
      const universe = data[0]?.universe || [];
      const ctxs = data[1] || [];
      for (let i = 0; i < universe.length; i++) {
        if (ctxs[i]) {
          rates[universe[i].name] = parseFloat(ctxs[i].funding || "0");
        }
      }
    }
    return rates;
  } catch (e) {
    log(`Error fetching funding rates: ${e}`, "engine");
    return {};
  }
}

async function fetchMetaAndAssetCtxs(): Promise<any> {
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    });
    return await res.json();
  } catch (e) {
    log(`Error fetching metaAndAssetCtxs: ${e}`, "engine");
    return null;
  }
}

// ============ TRADING ENGINE CLASS ============
class TradingEngine {
  private scanTimer: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;

  async start() {
    const config = storage.getConfig();
    if (!config) return;

    storage.createLog({
      type: "system",
      message: "Trading engine started",
      timestamp: new Date().toISOString(),
    });

    log("Trading engine started", "engine");
    this.scheduleNextScan();
  }

  stop() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    storage.createLog({
      type: "system",
      message: "Trading engine stopped",
      timestamp: new Date().toISOString(),
    });
    log("Trading engine stopped", "engine");
  }

  private scheduleNextScan() {
    const config = storage.getConfig();
    if (!config?.isRunning) return;

    const interval = (config.scanIntervalSecs || 60) * 1000;
    this.scanTimer = setTimeout(() => this.runScanCycle(), interval);
  }

  async runScanCycle() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      const config = storage.getConfig();
      if (!config?.isRunning) {
        this.isScanning = false;
        return;
      }

      log("Starting market scan cycle...", "engine");

      // 1. Fetch all market data
      const metaAndCtxs = await fetchMetaAndAssetCtxs();
      if (!metaAndCtxs || metaAndCtxs.length < 2) {
        log("Failed to fetch market data", "engine");
        this.isScanning = false;
        this.scheduleNextScan();
        return;
      }

      const universe = metaAndCtxs[0]?.universe || [];
      const ctxs = metaAndCtxs[1] || [];

      // 2. Scan each asset for signals
      const signals: Array<{
        coin: string;
        price: number;
        rsi: number;
        volume24h: number;
        change24h: number;
        fundingRate: number;
        openInterest: number;
        signal: string;
        score: number;
      }> = [];

      for (let i = 0; i < Math.min(universe.length, ctxs.length); i++) {
        const asset = universe[i];
        const ctx = ctxs[i];
        if (!ctx || !ctx.midPx) continue;

        const price = parseFloat(ctx.midPx);
        const volume24h = parseFloat(ctx.dayNtlVlm || "0");
        const funding = parseFloat(ctx.funding || "0");
        const openInterest = parseFloat(ctx.openInterest || "0");
        const prevDayPx = parseFloat(ctx.prevDayPx || String(price));
        const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;

        // Skip low-volume assets
        if (volume24h < (config.minVolume24h || 1000000)) continue;

        // Fetch candles and calculate RSI
        const closes = await fetchCandles(asset.name, "1h", 50);
        if (closes.length < 20) continue;

        const rsi = calculateRSI(closes);
        
        let signal = "neutral";
        let score = 0;

        // LONG signal: severely oversold
        if (rsi <= (config.rsiOversoldThreshold || 20)) {
          signal = "oversold_long";
          score = (config.rsiOversoldThreshold || 20) - rsi; // lower RSI = stronger signal
          
          // Bonus: negative funding = shorts are paying (favors longs)
          if (funding < -0.0001) score += 10;
          // Bonus: price down significantly 
          if (change24h < -5) score += 5;
          // Penalty: price in freefall (> -15%)
          if (change24h < -15) score -= 15;
        }
        
        // SHORT signal: severely overbought
        if (rsi >= (config.rsiOverboughtThreshold || 80)) {
          signal = "overbought_short";
          score = rsi - (config.rsiOverboughtThreshold || 80);
          
          // Bonus: positive funding = longs are paying (favors shorts)
          if (funding > 0.0001) score += 10;
          // Bonus: price up significantly
          if (change24h > 5) score += 5;
          // Penalty: parabolic move (> +15%)
          if (change24h > 15) score -= 15;
        }

        // Store scan result
        storage.upsertMarketScan({
          coin: asset.name,
          price,
          rsi,
          volume24h,
          change24h,
          signal,
          fundingRate: funding,
          openInterest,
          timestamp: new Date().toISOString(),
        });

        if (signal !== "neutral" && score > 0) {
          signals.push({
            coin: asset.name,
            price, rsi, volume24h, change24h,
            fundingRate: funding, openInterest,
            signal, score,
          });
        }

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 200));
      }

      // 3. Sort signals by strength
      signals.sort((a, b) => b.score - a.score);

      storage.createLog({
        type: "scan",
        message: `Scan complete: ${signals.length} signals found from ${universe.length} assets`,
        data: JSON.stringify(signals.slice(0, 5).map(s => `${s.coin} RSI:${s.rsi.toFixed(1)} ${s.signal}`)),
        timestamp: new Date().toISOString(),
      });

      // 4. Execute trades on top signals
      const openTrades = storage.getOpenTrades();
      const openCoins = new Set(openTrades.map(t => t.coin));
      const maxPos = config.maxPositions || 5;
      const slotsAvailable = maxPos - openTrades.length;

      if (slotsAvailable > 0 && signals.length > 0) {
        for (const sig of signals.slice(0, slotsAvailable)) {
          if (openCoins.has(sig.coin)) continue; // skip if already have position

          // Calculate position size and leverage
          const leverage = Math.min(config.maxLeverage || 20, 20);
          const tradeAmountPct = config.tradeAmountPct || 10;

          const side = sig.signal === "oversold_long" ? "long" : "short";
          const stopLossPct = config.stopLossPct || 2;
          const takeProfitPct = config.takeProfitPct || 5;

          const stopLoss = side === "long"
            ? sig.price * (1 - stopLossPct / 100)
            : sig.price * (1 + stopLossPct / 100);
          const takeProfit = side === "long"
            ? sig.price * (1 + takeProfitPct / 100)
            : sig.price * (1 - takeProfitPct / 100);

          // === REAL ORDER EXECUTION ===
          let executionResult: any = null;
          if (config.apiSecret && config.walletAddress) {
            try {
              const executor = createExecutor(config.apiSecret, config.walletAddress);
              
              // Set leverage first
              await executor.setLeverage(sig.coin, leverage, true);
              
              // Place market order (IOC at current price with slippage)
              const slippageMult = side === "long" ? 1.005 : 0.995;
              const orderPrice = sig.price * slippageMult;
              
              // Calculate size in asset units from percentage
              const { equity } = await executor.getAccountValue();
              const capitalForTrade = equity * (tradeAmountPct / 100);
              const notionalSize = capitalForTrade * leverage;
              const assetSize = notionalSize / sig.price;
              
              executionResult = await executor.placeOrder({
                coin: sig.coin,
                isBuy: side === "long",
                sz: parseFloat(assetSize.toFixed(6)),
                limitPx: parseFloat(orderPrice.toFixed(2)),
                orderType: { limit: { tif: "Ioc" } },
                reduceOnly: false,
              });
              
              log(`ORDER EXECUTED: ${side} ${sig.coin} size=${assetSize.toFixed(6)} @ $${orderPrice.toFixed(2)} | Result: ${JSON.stringify(executionResult)}`, "engine");
            } catch (execErr) {
              log(`ORDER EXECUTION FAILED: ${execErr}`, "engine");
              storage.createLog({
                type: "error",
                message: `Order execution failed for ${sig.coin}: ${execErr}`,
                timestamp: new Date().toISOString(),
              });
              continue; // Skip this trade if execution fails
            }
          } else {
            log(`SIMULATED: ${side} ${sig.coin} (no API keys configured)`, "engine");
          }

          const trade = storage.createTrade({
            coin: sig.coin,
            side,
            entryPrice: sig.price,
            size: tradeAmountPct, // percentage of capital
            leverage,
            rsiAtEntry: sig.rsi,
            stopLoss,
            takeProfit,
            status: "open",
            reason: `${sig.signal} | RSI: ${sig.rsi.toFixed(1)} | Funding: ${(sig.fundingRate * 100).toFixed(4)}% | 24h: ${sig.change24h.toFixed(1)}%`,
            openedAt: new Date().toISOString(),
          });

          storage.createLog({
            type: "trade_open",
            message: `Opened ${side.toUpperCase()} ${sig.coin} @ $${sig.price.toFixed(2)} | ${leverage}x | RSI: ${sig.rsi.toFixed(1)}`,
            data: JSON.stringify(trade),
            timestamp: new Date().toISOString(),
          });

          log(`TRADE: ${side.toUpperCase()} ${sig.coin} @ $${sig.price} (RSI: ${sig.rsi.toFixed(1)})`, "engine");
          openCoins.add(sig.coin);
        }
      }

      // 5. Check existing positions for exit conditions
      await this.checkExits();

      // 6. Take PnL snapshot
      this.takePnlSnapshot();

    } catch (e) {
      log(`Scan cycle error: ${e}`, "engine");
      storage.createLog({
        type: "error",
        message: `Scan cycle error: ${e}`,
        timestamp: new Date().toISOString(),
      });
    }

    this.isScanning = false;
    this.scheduleNextScan();
  }

  private async checkExits() {
    const config = storage.getConfig();
    if (!config) return;

    const openTrades = storage.getOpenTrades();
    const mids = await fetchAllMids();

    for (const trade of openTrades) {
      const currentPrice = parseFloat(mids[trade.coin] || "0");
      if (currentPrice === 0) continue;

      const pnlPct = trade.side === "long"
        ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;

      const leveragedPnlPct = pnlPct * trade.leverage;
      const pnl = (trade.size / 100) * leveragedPnlPct; // simplified P&L calc

      let shouldClose = false;
      let closeReason = "";

      // Check stop loss
      if (trade.side === "long" && currentPrice <= (trade.stopLoss || 0)) {
        shouldClose = true;
        closeReason = `Stop loss hit @ $${currentPrice.toFixed(2)}`;
      }
      if (trade.side === "short" && currentPrice >= (trade.stopLoss || Infinity)) {
        shouldClose = true;
        closeReason = `Stop loss hit @ $${currentPrice.toFixed(2)}`;
      }

      // Check take profit
      if (trade.side === "long" && currentPrice >= (trade.takeProfit || Infinity)) {
        shouldClose = true;
        closeReason = `Take profit hit @ $${currentPrice.toFixed(2)}`;
      }
      if (trade.side === "short" && currentPrice <= (trade.takeProfit || 0)) {
        shouldClose = true;
        closeReason = `Take profit hit @ $${currentPrice.toFixed(2)}`;
      }

      // Check trailing stop (if enabled)
      if (config.useTrailingStop && !shouldClose) {
        const trailingPct = config.trailingStopPct || 1.5;
        // If we're in significant profit and price pulls back
        if (leveragedPnlPct > trailingPct * 2) {
          // Use trailing from highest profit point
          if (leveragedPnlPct < trailingPct) {
            shouldClose = true;
            closeReason = `Trailing stop triggered | P&L: ${leveragedPnlPct.toFixed(2)}%`;
          }
        }
      }

      // RSI recovery exit — if RSI returned to neutral zone
      if (!shouldClose) {
        const closes = await fetchCandles(trade.coin, "1h", 25);
        if (closes.length >= 15) {
          const currentRsi = calculateRSI(closes);
          // If was oversold long and RSI recovered above 50
          if (trade.side === "long" && (trade.rsiAtEntry || 50) < 30 && currentRsi > 55) {
            shouldClose = true;
            closeReason = `RSI recovered to ${currentRsi.toFixed(1)} (entered at ${trade.rsiAtEntry?.toFixed(1)})`;
          }
          // If was overbought short and RSI dropped below 50
          if (trade.side === "short" && (trade.rsiAtEntry || 50) > 70 && currentRsi < 45) {
            shouldClose = true;
            closeReason = `RSI recovered to ${currentRsi.toFixed(1)} (entered at ${trade.rsiAtEntry?.toFixed(1)})`;
          }
        }
      }

      if (shouldClose) {
        storage.updateTrade(trade.id, {
          exitPrice: currentPrice,
          pnl: leveragedPnlPct,
          pnlPct: leveragedPnlPct,
          status: "closed",
          closeReason,
          closedAt: new Date().toISOString(),
        });

        storage.createLog({
          type: "trade_close",
          message: `Closed ${trade.side.toUpperCase()} ${trade.coin} @ $${currentPrice.toFixed(2)} | P&L: ${leveragedPnlPct.toFixed(2)}% | ${closeReason}`,
          timestamp: new Date().toISOString(),
        });

        log(`CLOSE: ${trade.coin} ${closeReason} (P&L: ${leveragedPnlPct.toFixed(2)}%)`, "engine");
      } else {
        // Update live P&L
        storage.updateTrade(trade.id, {
          pnl: leveragedPnlPct,
          pnlPct: leveragedPnlPct,
        });
      }
    }
  }

  private takePnlSnapshot() {
    const trades = storage.getAllTrades();
    const openTrades = storage.getOpenTrades();
    
    const closedPnl = trades
      .filter(t => t.status === "closed")
      .reduce((sum, t) => sum + (t.pnl || 0), 0);
    
    const openPnl = openTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalPnl = closedPnl + openPnl;

    storage.createPnlSnapshot({
      totalEquity: 100 + totalPnl, // base 100% equity
      totalPnl,
      totalPnlPct: totalPnl,
      openPositions: openTrades.length,
      timestamp: new Date().toISOString(),
    });
  }

  // Force close a specific trade
  async forceCloseTrade(tradeId: number) {
    const trade = storage.getTradeById(tradeId);
    if (!trade || trade.status !== "open") return null;

    const mids = await fetchAllMids();
    const currentPrice = parseFloat(mids[trade.coin] || String(trade.entryPrice));

    // Execute real close if API keys exist
    const config = storage.getConfig();
    if (config?.apiSecret && config?.walletAddress) {
      try {
        const executor = createExecutor(config.apiSecret, config.walletAddress);
        const positions = await executor.getPositions();
        const pos = positions.find((p: any) => p.position?.coin === trade.coin);
        if (pos) {
          const posSize = Math.abs(parseFloat(pos.position.szi || "0"));
          const slippageMult = trade.side === "long" ? 0.995 : 1.005;
          await executor.placeOrder({
            coin: trade.coin,
            isBuy: trade.side === "short", // reverse direction to close
            sz: posSize,
            limitPx: parseFloat((currentPrice * slippageMult).toFixed(2)),
            orderType: { limit: { tif: "Ioc" } },
            reduceOnly: true,
          });
          log(`REAL CLOSE EXECUTED: ${trade.coin}`, "engine");
        }
      } catch (e) {
        log(`Close execution error: ${e}`, "engine");
      }
    }

    const pnlPct = trade.side === "long"
      ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage
      : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100 * trade.leverage;

    const updated = storage.updateTrade(trade.id, {
      exitPrice: currentPrice,
      pnl: pnlPct,
      pnlPct: pnlPct,
      status: "closed",
      closeReason: "Manual close from admin panel",
      closedAt: new Date().toISOString(),
    });

    storage.createLog({
      type: "trade_close",
      message: `Manually closed ${trade.side.toUpperCase()} ${trade.coin} @ $${currentPrice.toFixed(2)} | P&L: ${pnlPct.toFixed(2)}%`,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  // Force trigger a scan
  async forceScan() {
    await this.runScanCycle();
  }

  getStatus() {
    const config = storage.getConfig();
    const openTrades = storage.getOpenTrades();
    const allTrades = storage.getAllTrades();
    const closedTrades = allTrades.filter(t => t.status === "closed");
    
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const openPnl = openTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
    const winRate = closedTrades.length > 0 ? (winTrades.length / closedTrades.length) * 100 : 0;

    return {
      isRunning: config?.isRunning || false,
      openPositions: openTrades.length,
      totalTrades: allTrades.length,
      closedTrades: closedTrades.length,
      winRate: winRate.toFixed(1),
      totalPnl: totalPnl.toFixed(2),
      openPnl: openPnl.toFixed(2),
      combinedPnl: (totalPnl + openPnl).toFixed(2),
    };
  }
}

export const tradingEngine = new TradingEngine();
