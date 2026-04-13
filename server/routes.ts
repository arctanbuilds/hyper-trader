import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { tradingEngine } from "./trading-engine";
import { getLearningStats, reviewClosedTrades, generateInsights } from "./learning-engine";
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
  setInterval(() => {
    const status = tradingEngine.getStatus();
    broadcast({ type: "status", data: status });
  }, 10000);

  // ============ STATUS ============
  app.get("/api/status", (_req, res) => {
    const status = tradingEngine.getStatus();
    res.json(status);
  });

  // ============ BOT CONFIG ============
  app.get("/api/config", (_req, res) => {
    const config = storage.getConfig();
    res.json(config);
  });

  app.patch("/api/config", (req, res) => {
    try {
      const updated = storage.updateConfig(req.body);
      storage.createLog({
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
  app.post("/api/bot/start", (_req, res) => {
    const config = storage.getConfig();
    if (!config) return res.status(400).json({ error: "No config found" });
    
    storage.updateConfig({ isRunning: true });
    tradingEngine.start();
    broadcast({ type: "status", data: tradingEngine.getStatus() });
    res.json({ success: true, message: "Bot started" });
  });

  app.post("/api/bot/stop", (_req, res) => {
    storage.updateConfig({ isRunning: false });
    tradingEngine.stop();
    broadcast({ type: "status", data: tradingEngine.getStatus() });
    res.json({ success: true, message: "Bot stopped" });
  });

  app.post("/api/bot/scan", async (_req, res) => {
    try {
      // Temporarily set running to allow scan
      const config = storage.getConfig();
      const wasRunning = config?.isRunning;
      if (!wasRunning) storage.updateConfig({ isRunning: true });
      
      await tradingEngine.forceScan();
      
      if (!wasRunning) storage.updateConfig({ isRunning: false });
      
      res.json({ success: true, message: "Scan completed" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ TRADES ============
  app.get("/api/trades", (req, res) => {
    const status = req.query.status as string | undefined;
    if (status === "open") {
      res.json(storage.getOpenTrades());
    } else {
      res.json(storage.getAllTrades(200));
    }
  });

  app.get("/api/trades/:id", (req, res) => {
    const trade = storage.getTradeById(parseInt(req.params.id));
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
  app.get("/api/pnl", (req, res) => {
    const since = req.query.since as string | undefined;
    res.json(storage.getPnlSnapshots(since));
  });

  // ============ MARKET SCANS ============
  app.get("/api/scans", (_req, res) => {
    res.json(storage.getLatestScans());
  });

  app.get("/api/scans/signals", (_req, res) => {
    res.json(storage.getScansWithSignal());
  });

  // ============ ACTIVITY LOG ============
  app.get("/api/logs", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 200;
    res.json(storage.getLogs(limit));
  });

  // ============ ACCOUNT INFO (proxied from Hyperliquid) ============
  app.get("/api/account", async (req, res) => {
    const config = storage.getConfig();
    if (!config?.walletAddress) {
      return res.json({ connected: false, balance: 0, positions: [] });
    }

    try {
      const response = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "clearinghouseState",
          user: config.walletAddress,
        }),
      });
      const data = await response.json();
      res.json({ connected: true, ...data as any });
    } catch (e: any) {
      res.json({ connected: false, error: e.message });
    }
  });

  // ============ LEARNING / DECISIONS ============
  app.get("/api/learning/stats", (_req, res) => {
    const stats = getLearningStats();
    res.json(stats);
  });

  app.get("/api/learning/insights", (_req, res) => {
    res.json(storage.getAllInsights());
  });

  app.get("/api/learning/decisions", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(storage.getAllDecisions(limit));
  });

  app.post("/api/learning/review", async (_req, res) => {
    try {
      const reviewed = reviewClosedTrades();
      generateInsights();
      res.json({ success: true, reviewed });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
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
