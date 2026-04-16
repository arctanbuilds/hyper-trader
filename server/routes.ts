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
      // Temporarily set running to allow scan
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

  // ============ TRADES ============
  app.get("/api/trades", async (req, res) => {
    const status = req.query.status as string | undefined;
    const trades = status === "open"
      ? await storage.getOpenTrades()
      : await storage.getAllTrades(200);

    // Enrich each trade with dollar P&L and ROI as % of AUM
    // v10.5.3: Uses entryEquity (stored at trade time) for accurate position sizing
    // Falls back to current equity for old trades without entryEquity
    const currentEquity = tradingEngine.getLastKnownEquity();
    const FEE_RATE = 0.00045; // Hyperliquid taker fee per side
    const enriched = trades.map((t: any) => {
      // Use entryEquity if stored; otherwise extract from reason field ("80% AUM ($54)")
      let eqForTrade = t.entryEquity;
      if (!eqForTrade && t.reason) {
        const capMatch = t.reason.match(/AUM \(\$(\d+)\)/);
        if (capMatch) {
          const capUsd = parseFloat(capMatch[1]);
          const sizePct = (t.size || 10) / 100;
          eqForTrade = sizePct > 0 ? capUsd / sizePct : currentEquity;
        }
      }
      if (!eqForTrade) eqForTrade = currentEquity;
      const tradeCapUsd = eqForTrade * ((t.size || 10) / 100);
      const positionValue = tradeCapUsd * (t.leverage || 1);
      let pnlUsd: number;
      const exitPx = t.exitPrice || t.entryPrice; // fallback for open trades without exitPrice
      if (t.tp1Hit && t.takeProfit1 && t.exitPrice) {
        // Split: 50% realized at TP1, 50% at exit
        const halfPos = positionValue / 2;
        const tp1Move = t.side === "long"
          ? (t.takeProfit1 - t.entryPrice) / t.entryPrice
          : (t.entryPrice - t.takeProfit1) / t.entryPrice;
        const tp2Move = t.side === "long"
          ? (exitPx - t.entryPrice) / t.entryPrice
          : (t.entryPrice - exitPx) / t.entryPrice;
        pnlUsd = halfPos * tp1Move + halfPos * tp2Move
          - positionValue * FEE_RATE - halfPos * FEE_RATE - halfPos * FEE_RATE;
      } else if (t.exitPrice) {
        // No TP1 hit — full position move
        const rawMove = t.side === "long"
          ? (exitPx - t.entryPrice) / t.entryPrice
          : (t.entryPrice - exitPx) / t.entryPrice;
        pnlUsd = positionValue * rawMove - positionValue * FEE_RATE * 2;
      } else {
        // Open trade — use stored pnl (already corrected by monitoring loop)
        pnlUsd = tradeCapUsd * ((t.pnl || 0) / 100);
      }
      const pnlOfAum = eqForTrade > 0 ? (pnlUsd / eqForTrade) * 100 : 0;
      return { ...t, pnlUsd: parseFloat(pnlUsd.toFixed(4)), pnlOfAum: parseFloat(pnlOfAum.toFixed(4)) };
    });
    res.json(enriched);
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
  // Supports both Standard and Unified Account modes
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
      
      // Unified account: balance is in spot state, perps shows $0
      const perpsEquity = parseFloat(perpsData?.marginSummary?.accountValue || "0");
      const spotBalances = spotData?.balances || [];
      const usdcBalance = spotBalances.find((b: any) => b.coin === "USDC");
      const spotEquity = parseFloat(usdcBalance?.total || "0");
      const effectiveEquity = Math.max(perpsEquity, spotEquity);
      
      // Override marginSummary with correct values for unified accounts
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
      // Fetch both main perps and HIP-3 xyz dex
      const [mainRes, xyzRes] = await Promise.all([
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        }),
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }),
        }),
      ]);
      const overview: any[] = [];
      for (const resp of [mainRes, xyzRes]) {
        const data: any = await resp.json();
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
      }
      res.json(overview);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ TRENDLINE VISUALIZATION ============
  app.get("/api/trendlines", async (req, res) => {
    try {
      const coin = (req.query.coin as string) || "BTC";
      const data = await tradingEngine.getTrendlineData(coin);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ AUTO-START ON DEPLOY ============
  // If the engine was running before a deploy/restart, auto-resume it
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
