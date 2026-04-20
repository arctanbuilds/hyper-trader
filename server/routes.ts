import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { tradingEngine } from "./trading-engine";
import { getLearningStats, reviewClosedTrades, generateInsights, run24hReview } from "./learning-engine";
import { insertBotConfigSchema } from "@shared/schema";
import { WebSocketServer, WebSocket } from "ws";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ============ WEBSOCKET FOR LIVE UPDATES ============
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  
  function broadcast(data: any) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }

  // Broadcast status every 10 seconds
  setInterval(async () => {
    const status = await tradingEngine.getStatus();
    broadcast({ type: "status", data: status });
  }, 10000);

  // ============ STATUS ============
  app.get("/api/status", async (_req, res) => {
    const status = await tradingEngine.getStatus();
    res.json(status);
  });

  // ============ BOT CONFIG ============
  app.get("/api/config", async (_req, res) => {
    const config = await storage.getConfig();
    res.json(config);
  });

  app.patch("/api/config", async (req, res) => {
    try {
      const updated = await storage.updateConfig(req.body);
      await storage.createLog({
        type: "config_change",
        message: `Config updated: ${Object.keys(req.body).join(", ")}`,
        data: JSON.stringify(req.body),
        timestamp: new Date().toISOString(),
      });
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ============ BOT CONTROL ============
  app.post("/api/bot/start", async (_req, res) => {
    const config = await storage.getConfig();
    if (!config) return res.status(400).json({ error: "No config found" });
    
    await storage.updateConfig({ isRunning: true });
    tradingEngine.start();
    broadcast({ type: "status", data: await tradingEngine.getStatus() });
    res.json({ success: true, message: "Bot started" });
  });

  app.post("/api/bot/stop", async (_req, res) => {
    await storage.updateConfig({ isRunning: false });
    tradingEngine.stop();
    broadcast({ type: "status", data: await tradingEngine.getStatus() });
    res.json({ success: true, message: "Bot stopped" });
  });

  app.post("/api/bot/scan", async (_req, res) => {
    try {
      const config = await storage.getConfig();
      const wasRunning = config?.isRunning;
      if (!wasRunning) await storage.updateConfig({ isRunning: true });
      
      await tradingEngine.forceScan();
      
      if (!wasRunning) await storage.updateConfig({ isRunning: false });
      
      res.json({ success: true, message: "Scan completed" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ TRADINGVIEW WEBHOOK ============
  app.post("/api/webhook/tradingview", async (req, res) => {
    try {
      const payload = req.body;
      console.log(`[WEBHOOK] Received: ${JSON.stringify(payload).slice(0, 500)}`);

      if (!payload || !payload.signal) {
        return res.status(400).json({ error: "Missing signal in payload" });
      }

      const result = await tradingEngine.handleWebhookSignal(payload);
      broadcast({ type: "webhook", data: { ...result, payload, timestamp: new Date().toISOString() } });
      res.json(result);
    } catch (e: any) {
      console.error(`[WEBHOOK] Error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ============ TRADES ============
  app.get("/api/trades", async (req, res) => {
    const status = req.query.status as string | undefined;
    const trades = status === "open"
      ? await storage.getOpenTrades()
      : await storage.getAllTrades(200);

    // Use hlPnlUsd directly from Hyperliquid as THE source of truth
    const currentEquity = tradingEngine.getLastKnownEquity();
    const FEE_RATE = 0.00045;
    const enriched = trades.map((t: any) => {
      let pnlUsd: number;
      let eqForTrade = t.entryEquity || currentEquity;

      if (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) {
        pnlUsd = t.hlPnlUsd;
      } else {
        if (!eqForTrade && t.reason) {
          const capMatch = t.reason.match(/AUM \(\$(\d+)\)/);
          if (capMatch) {
            const capUsd = parseFloat(capMatch[1]);
            const sizePct = (t.size || 10) / 100;
            eqForTrade = sizePct > 0 ? capUsd / sizePct : currentEquity;
          }
        }
        if (!eqForTrade) eqForTrade = currentEquity;
        const positionValue = t.notionalValue || (eqForTrade * ((t.size || 10) / 100) * (t.leverage || 1));
        const marginCap = (t.leverage || 1) > 0 ? positionValue / (t.leverage || 1) : positionValue;
        const exitPx = t.exitPrice || t.entryPrice;
        if (t.exitPrice) {
          const rawMove = t.side === "long"
            ? (exitPx - t.entryPrice) / t.entryPrice
            : (t.entryPrice - exitPx) / t.entryPrice;
          pnlUsd = positionValue * rawMove - positionValue * FEE_RATE * 2;
        } else {
          pnlUsd = marginCap * ((t.pnl || 0) / 100);
        }
      }
      const pnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)) };
    });
    res.json(enriched);
  });

  // ============ STRATEGY STATS ============
  // v14.1: Dual strategy — RSI18 + DIVERGENCE — counts trades after v14.1 deploy
  const V141_START = "2026-04-18T17:30:00.000Z";

  app.get("/api/strategies", async (req, res) => {
    const allTrades = await storage.getAllTrades(500);
    const currentEquity = tradingEngine.getLastKnownEquity();

    type StratBucket = {
      trades: any[]; wins: number; losses: number; totalPnl: number;
      grossProfit: number; grossLoss: number;
      bestTrade: number; worstTrade: number;
      peakPnl: number; maxDrawdownUsd: number;
      cumPnlSeries: { tradeNum: number; cumPnl: number; timestamp: string }[];
      streakCurrent: number; streakBest: number; streakWorst: number; streakType: string;
    };
    const makeBucket = (): StratBucket => ({
      trades: [], wins: 0, losses: 0, totalPnl: 0,
      grossProfit: 0, grossLoss: 0,
      bestTrade: 0, worstTrade: 0,
      peakPnl: 0, maxDrawdownUsd: 0,
      cumPnlSeries: [],
      streakCurrent: 0, streakBest: 0, streakWorst: 0, streakType: "none",
    });

    const rsi18Bucket = makeBucket();
    const divBucket = makeBucket();

    const closedTrades = allTrades
      .filter((t: any) => t.status === "closed" && t.closedAt && t.openedAt >= V141_START)
      .sort((a: any, b: any) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());

    for (const t of closedTrades) {
      const pnl = t.hlPnlUsd ?? 0;
      const bucket = t.strategy === "divergence" ? divBucket : rsi18Bucket;

      bucket.trades.push(t);
      bucket.totalPnl += pnl;
      if (pnl > 0) {
        bucket.wins++;
        bucket.grossProfit += pnl;
      } else {
        bucket.losses++;
        bucket.grossLoss += Math.abs(pnl);
      }

      if (pnl > bucket.bestTrade) bucket.bestTrade = pnl;
      if (pnl < bucket.worstTrade) bucket.worstTrade = pnl;

      if (bucket.totalPnl > bucket.peakPnl) bucket.peakPnl = bucket.totalPnl;
      const dd = bucket.peakPnl - bucket.totalPnl;
      if (dd > bucket.maxDrawdownUsd) bucket.maxDrawdownUsd = dd;

      if (pnl > 0) {
        if (bucket.streakType === "win") {
          bucket.streakCurrent++;
        } else {
          bucket.streakType = "win";
          bucket.streakCurrent = 1;
        }
        if (bucket.streakCurrent > bucket.streakBest) bucket.streakBest = bucket.streakCurrent;
      } else {
        if (bucket.streakType === "loss") {
          bucket.streakCurrent++;
        } else {
          bucket.streakType = "loss";
          bucket.streakCurrent = 1;
        }
        if (bucket.streakCurrent > bucket.streakWorst) bucket.streakWorst = bucket.streakCurrent;
      }

      bucket.cumPnlSeries.push({
        tradeNum: bucket.trades.length,
        cumPnl: parseFloat(bucket.totalPnl.toFixed(2)),
        timestamp: t.closedAt,
      });
    }

    const openTrades = allTrades.filter((t: any) => t.status === "open");
    const openRsi18 = openTrades.filter((t: any) => t.strategy === "rsi18").length;
    const openDiv = openTrades.filter((t: any) => t.strategy === "divergence").length;

    const raceStartMs = new Date(V141_START).getTime();
    const raceHours = parseFloat(((Date.now() - raceStartMs) / 3600000).toFixed(1));

    function formatBucket(d: StratBucket, strategy: string, label: string, openCount: number) {
      return {
        strategy,
        label,
        totalTrades: d.trades.length,
        wins: d.wins,
        losses: d.losses,
        winRate: d.trades.length > 0 ? parseFloat(((d.wins / d.trades.length) * 100).toFixed(1)) : 0,
        totalPnlUsd: parseFloat(d.totalPnl.toFixed(2)),
        totalPnlPct: currentEquity > 0 ? parseFloat(((d.totalPnl / currentEquity) * 100).toFixed(2)) : 0,
        avgPnlPerTrade: d.trades.length > 0 ? parseFloat((d.totalPnl / d.trades.length).toFixed(2)) : 0,
        bestTradeUsd: parseFloat(d.bestTrade.toFixed(2)),
        worstTradeUsd: parseFloat(d.worstTrade.toFixed(2)),
        maxDrawdownUsd: parseFloat(d.maxDrawdownUsd.toFixed(2)),
        maxDrawdownPct: currentEquity > 0 ? parseFloat(((d.maxDrawdownUsd / currentEquity) * 100).toFixed(2)) : 0,
        profitFactor: d.grossLoss > 0 ? parseFloat((d.grossProfit / d.grossLoss).toFixed(2)) : d.grossProfit > 0 ? 999 : 0,
        bestWinStreak: d.streakBest,
        worstLossStreak: d.streakWorst,
        openPositions: openCount,
        cumPnlSeries: d.cumPnlSeries,
      };
    }

    const result = [
      formatBucket(rsi18Bucket, "rsi18", "RSI18 (BTC only)", openRsi18),
      formatBucket(divBucket, "divergence", "DIVERGENCE (10 assets)", openDiv),
    ];

    res.json({ raceStartedAt: V141_START, raceHours, strategies: result });
  });

  app.get("/api/trades/:id", async (req, res) => {
    const trade = await storage.getTradeById(parseInt(req.params.id));
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    res.json(trade);
  });

  app.post("/api/trades/:id/close", async (req, res) => {
    try {
      const result = await tradingEngine.forceCloseTrade(parseInt(req.params.id));
      if (!result) return res.status(400).json({ error: "Trade not found or already closed" });
      broadcast({ type: "trade_closed", data: result });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ PATCH TRADE (fix SL/TP values) ============
  app.patch("/api/trades/:id", async (req, res) => {
    try {
      const tradeId = parseInt(req.params.id);
      const trade = await storage.getTradeById(tradeId);
      if (!trade) return res.status(404).json({ error: "Trade not found" });
      const allowed = ["stopLoss", "takeProfit1", "takeProfit2", "tp1Hit", "status", "closeReason", "exitPrice", "pnl", "pnlPct", "size", "leverage", "entryEquity", "peakPnlPct", "notionalValue", "hlPnlUsd", "hlCloseFee"];
      const updates: any = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }
      const updated = await storage.updateTrade(tradeId, updates);
      await storage.createLog({ type: "system", message: `Trade #${tradeId} patched: ${JSON.stringify(updates)}`, timestamp: new Date().toISOString() });
      broadcast({ type: "status", data: await tradingEngine.getStatus() });
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ============ SYNC POSITIONS FROM HL ============
  app.post("/api/trades/sync-from-hl", async (_req, res) => {
    try {
      const config = await storage.getConfig();
      if (!config?.apiSecret || !config?.walletAddress) return res.status(400).json({ error: "No API config" });
      const { createExecutor } = await import("./hyperliquid-executor");
      const executor = createExecutor(config.apiSecret, config.walletAddress);
      const hlPositions = await executor.getPositions();
      const openTrades = await storage.getOpenTrades();
      const openCoins = new Set(openTrades.map(t => t.coin));
      const synced: any[] = [];
      for (const p of hlPositions) {
        const pos = p.position;
        const sz = Math.abs(parseFloat(pos?.szi || "0"));
        if (sz <= 0) continue;
        const coin = pos.coin;
        if (openCoins.has(coin)) continue;
        const side = parseFloat(pos.szi) > 0 ? "long" : "short";
        const entryPrice = parseFloat(pos.entryPx || "0");
        const leverage = parseInt(pos.leverage?.value || "1");
        const equity = tradingEngine.getLastKnownEquity();
        const actualNotional = sz * entryPrice;
        // Default to divergence strategy for non-BTC, rsi18 for BTC
        const strategy = coin === "BTC" ? "rsi18" : "divergence";
        const tpMult = strategy === "rsi18" ? 1.005 : 1.0043;
        const tp = entryPrice * tpMult;
        const sl = entryPrice * 0.995; // SL -0.5%
        const tpLabel = strategy === "rsi18" ? "+0.5%" : "+0.43%";
        const trade = await storage.createTrade({
          coin, side, entryPrice, size: 50, leverage,
          entryEquity: equity,
          notionalValue: actualNotional,
          rsiAtEntry: 0, rsi4h: 0, rsi1d: 0,
          ema10: 0, ema21: 0, ema50: 0,
          stopLoss: sl,
          takeProfit1: tp,
          takeProfit2: tp,
          tp1Hit: false,
          confluenceScore: 0, confluenceDetails: "Synced from HL position",
          riskRewardRatio: 0, status: "open",
          reason: `[SYNC] Imported from HL: ${coin} ${side} ${leverage}x @ $${entryPrice} | SL -0.5% | TP ${tpLabel} | ${strategy.toUpperCase()}`,
          setupType: strategy, strategy,
          openedAt: new Date().toISOString(),
        });
        synced.push({ id: trade.id, coin, side, entryPrice, leverage, tp, strategy });
        await storage.createLog({ type: "system", message: `[SYNC-IMPORT] Created DB entry for ${coin} ${side} @ $${entryPrice} (${leverage}x) — trade #${trade.id} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | ${strategy.toUpperCase()}`, timestamp: new Date().toISOString() });
      }
      broadcast({ type: "status", data: await tradingEngine.getStatus() });
      res.json({ success: true, synced, message: `Imported ${synced.length} position(s) from Hyperliquid (v14.1: RSI18 + DIVERGENCE)` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ P&L RESET ============
  app.post("/api/pnl/reset", async (_req, res) => {
    try {
      const result = await tradingEngine.resetPnlBaseline();
      broadcast({ type: "pnl_reset", data: result });
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ P&L ============
  app.get("/api/pnl", async (req, res) => {
    const since = req.query.since as string | undefined;
    res.json(await storage.getPnlSnapshots(since));
  });

  // Equity curve built from actual trade closes — ground truth
  app.get("/api/equity-curve", async (_req, res) => {
    try {
      const config = await storage.getConfig();
      const baselineEquity = config?.pnlBaselineEquity || 658;
      const baselineTs = config?.pnlBaselineTimestamp || V141_START;

      const allTrades = await storage.getAllTrades(500);
      const closedAfterBaseline = allTrades
        .filter(t => t.status === "closed" && t.closedAt && t.openedAt >= baselineTs)
        .sort((a, b) => (a.closedAt || "").localeCompare(b.closedAt || ""));

      const curve: { timestamp: string; equity: number; trade: string; pnl: number }[] = [];
      curve.push({ timestamp: baselineTs, equity: baselineEquity, trade: "Baseline", pnl: 0 });

      let runningEquity = baselineEquity;
      for (const t of closedAfterBaseline) {
        const tradePnl = (t.hlPnlUsd !== null && t.hlPnlUsd !== undefined) ? t.hlPnlUsd : 0;
        runningEquity += tradePnl;
        const stratTag = " [RSI18]";
        curve.push({
          timestamp: t.closedAt || t.openedAt,
          equity: parseFloat(runningEquity.toFixed(2)),
          trade: `${t.side.toUpperCase()} ${t.coin}${stratTag}`,
          pnl: parseFloat(tradePnl.toFixed(2)),
        });
      }

      const currentEquity = tradingEngine.getLastKnownEquity();
      if (currentEquity > 0) {
        curve.push({
          timestamp: new Date().toISOString(),
          equity: parseFloat(currentEquity.toFixed(2)),
          trade: "Now",
          pnl: 0,
        });
      }

      res.json(curve);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ MARKET SCANS ============
  app.get("/api/scans", async (_req, res) => {
    res.json(await storage.getLatestScans());
  });

  app.get("/api/scans/signals", async (_req, res) => {
    res.json(await storage.getScansWithSignal());
  });

  // ============ ACTIVITY LOG ============
  app.get("/api/logs", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 200;
    res.json(await storage.getLogs(limit));
  });

  // ============ ACCOUNT INFO (proxied from Hyperliquid) ============
  app.get("/api/account", async (req, res) => {
    const config = await storage.getConfig();
    if (!config?.walletAddress) {
      return res.json({ connected: false, balance: 0, positions: [] });
    }

    try {
      const [perpsResponse, spotResponse] = await Promise.all([
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "clearinghouseState",
            user: config.walletAddress,
          }),
        }),
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "spotClearinghouseState",
            user: config.walletAddress,
          }),
        }),
      ]);
      
      const perpsData: any = await perpsResponse.json();
      const spotData: any = await spotResponse.json();
      
      const perpsEquity = parseFloat(perpsData?.marginSummary?.accountValue || "0");
      const spotBalances = spotData?.balances || [];
      const usdcBalance = spotBalances.find((b: any) => b.coin === "USDC");
      const spotEquity = parseFloat(usdcBalance?.total || "0");
      const effectiveEquity = Math.max(perpsEquity, spotEquity);
      
      if (spotEquity > perpsEquity) {
        perpsData.marginSummary = {
          ...perpsData.marginSummary,
          accountValue: spotEquity.toString(),
          totalRawUsd: spotEquity.toString(),
        };
        perpsData.crossMarginSummary = {
          ...perpsData.crossMarginSummary,
          accountValue: spotEquity.toString(),
          totalRawUsd: spotEquity.toString(),
        };
        perpsData.withdrawable = spotEquity.toString();
      }
      
      res.json({ 
        connected: true, 
        accountMode: spotEquity > perpsEquity ? "unified" : "standard",
        spotBalances,
        ...perpsData,
      });
    } catch (e: any) {
      res.json({ connected: false, error: e.message });
    }
  });

  // ============ LEARNING / DECISIONS ============
  app.get("/api/learning/stats", async (_req, res) => {
    const stats = await getLearningStats();
    res.json(stats);
  });

  app.get("/api/learning/insights", async (_req, res) => {
    res.json(await storage.getAllInsights());
  });

  app.get("/api/learning/decisions", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(await storage.getAllDecisions(limit));
  });

  app.post("/api/learning/review", async (_req, res) => {
    try {
      const reviewed = await reviewClosedTrades();
      await generateInsights();
      res.json({ success: true, reviewed });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/learning/deep-review", async (_req, res) => {
    try {
      await run24hReview();
      res.json({ success: true, message: "24-hour deep review completed" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/learning/reviews", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 10;
    res.json(await storage.getRecentReviews(limit));
  });

  // ============ MARKET OVERVIEW ============
  app.get("/api/market/overview", async (_req, res) => {
    try {
      const mainRes = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      });
      const overview: any[] = [];
      const data: any = await mainRes.json();
      if (data && data.length === 2) {
        const universe = data[0]?.universe || [];
        const ctxs = data[1] || [];
        for (let i = 0; i < universe.length; i++) {
          if (!ctxs[i]?.midPx || ctxs[i].midPx === "None") continue;
          overview.push({
            name: universe[i].name,
            price: ctxs[i].midPx || "0",
            volume24h: ctxs[i].dayNtlVlm || "0",
            funding: ctxs[i].funding || "0",
            openInterest: ctxs[i].openInterest || "0",
            change24h: ctxs[i].prevDayPx
              ? (((parseFloat(ctxs[i].midPx) - parseFloat(ctxs[i].prevDayPx)) / parseFloat(ctxs[i].prevDayPx)) * 100).toFixed(2)
              : "0",
          });
        }
      }
      res.json(overview);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ AUTO-START ON DEPLOY ============
  (async () => {
    try {
      const config = await storage.getConfig();
      if (config?.isRunning) {
        console.log("[auto-start] Config shows isRunning=true, resuming engine...");
        tradingEngine.start();
      } else {
        console.log("[auto-start] Engine was stopped before deploy, staying stopped.");
      }
    } catch (e) {
      console.error("[auto-start] Failed to check/resume engine:", e);
    }
  })();

  return httpServer;
}
