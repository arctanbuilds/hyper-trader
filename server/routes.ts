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
    const equity = tradingEngine.getLastKnownEquity();
    const enriched = trades.map((t: any) => {
      const tradeCapUsd = equity * ((t.size || 10) / 100);
      const pnlUsd = tradeCapUsd * ((t.pnl || 0) / 100);
      // ROI as % of total AUM
      const pnlOfAum = equity > 0 ? (pnlUsd / equity) * 100 : 0;
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
      const response = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      });
      const data: any = await response.json();
      if (data && data.length === 2) {
        const universe = data[0]?.universe || [];
        const ctxs = data[1] || [];
        const overview = universe.map((asset: any, i: number) => ({
          name: asset.name,
          price: ctxs[i]?.midPx || "0",
          volume24h: ctxs[i]?.dayNtlVlm || "0",
          funding: ctxs[i]?.funding || "0",
          openInterest: ctxs[i]?.openInterest || "0",
          change24h: ctxs[i]?.prevDayPx
            ? (((parseFloat(ctxs[i].midPx) - parseFloat(ctxs[i].prevDayPx)) / parseFloat(ctxs[i].prevDayPx)) * 100).toFixed(2)
            : "0",
        }));
        res.json(overview);
      } else {
        res.json([]);
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return httpServer;
}
