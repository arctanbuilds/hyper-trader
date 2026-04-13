import { db } from "./db";
import { eq, desc, and, gte } from "drizzle-orm";
import {
  botConfig, trades, pnlSnapshots, activityLog, marketScans,
  type BotConfig, type InsertBotConfig,
  type Trade, type InsertTrade,
  type PnlSnapshot, type InsertPnlSnapshot,
  type ActivityLogEntry, type InsertActivityLog,
  type MarketScan, type InsertMarketScan,
} from "@shared/schema";

export interface IStorage {
  // Bot Config
  getConfig(): BotConfig | undefined;
  updateConfig(data: Partial<InsertBotConfig>): BotConfig;
  
  // Trades
  createTrade(trade: InsertTrade): Trade;
  updateTrade(id: number, data: Partial<InsertTrade>): Trade | undefined;
  getOpenTrades(): Trade[];
  getAllTrades(limit?: number): Trade[];
  getTradeById(id: number): Trade | undefined;
  
  // PnL Snapshots
  createPnlSnapshot(snap: InsertPnlSnapshot): PnlSnapshot;
  getPnlSnapshots(since?: string): PnlSnapshot[];
  
  // Activity Log
  createLog(entry: InsertActivityLog): ActivityLogEntry;
  getLogs(limit?: number): ActivityLogEntry[];
  
  // Market Scans
  upsertMarketScan(scan: InsertMarketScan): MarketScan;
  getLatestScans(): MarketScan[];
  getScansWithSignal(): MarketScan[];
}

export class DatabaseStorage implements IStorage {
  constructor() {
    // Ensure default config exists
    const existing = db.select().from(botConfig).get();
    if (!existing) {
      db.insert(botConfig).values({
        isRunning: false,
        maxLeverage: 20,
        maxPositions: 5,
        weeklyTargetPct: 50,
        maxDrawdownPct: 10,
        rsiOversoldThreshold: 20,
        rsiOverboughtThreshold: 80,
        scanIntervalSecs: 60,
        tradeAmountPct: 10,
        stopLossPct: 2,
        takeProfitPct: 5,
        trailingStopPct: 1.5,
        useTrailingStop: true,
        minVolume24h: 1000000,
        updatedAt: new Date().toISOString(),
      }).run();
    }
  }

  getConfig(): BotConfig | undefined {
    return db.select().from(botConfig).get();
  }

  updateConfig(data: Partial<InsertBotConfig>): BotConfig {
    const existing = this.getConfig();
    if (!existing) throw new Error("No config found");
    db.update(botConfig)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(botConfig.id, existing.id))
      .run();
    return this.getConfig()!;
  }

  createTrade(trade: InsertTrade): Trade {
    return db.insert(trades).values(trade).returning().get();
  }

  updateTrade(id: number, data: Partial<InsertTrade>): Trade | undefined {
    db.update(trades).set(data).where(eq(trades.id, id)).run();
    return db.select().from(trades).where(eq(trades.id, id)).get();
  }

  getOpenTrades(): Trade[] {
    return db.select().from(trades).where(eq(trades.status, "open")).all();
  }

  getAllTrades(limit: number = 100): Trade[] {
    return db.select().from(trades).orderBy(desc(trades.id)).limit(limit).all();
  }

  getTradeById(id: number): Trade | undefined {
    return db.select().from(trades).where(eq(trades.id, id)).get();
  }

  createPnlSnapshot(snap: InsertPnlSnapshot): PnlSnapshot {
    return db.insert(pnlSnapshots).values(snap).returning().get();
  }

  getPnlSnapshots(since?: string): PnlSnapshot[] {
    if (since) {
      return db.select().from(pnlSnapshots)
        .where(gte(pnlSnapshots.timestamp, since))
        .orderBy(pnlSnapshots.timestamp).all();
    }
    return db.select().from(pnlSnapshots).orderBy(desc(pnlSnapshots.timestamp)).limit(500).all();
  }

  createLog(entry: InsertActivityLog): ActivityLogEntry {
    return db.insert(activityLog).values(entry).returning().get();
  }

  getLogs(limit: number = 200): ActivityLogEntry[] {
    return db.select().from(activityLog).orderBy(desc(activityLog.id)).limit(limit).all();
  }

  upsertMarketScan(scan: InsertMarketScan): MarketScan {
    // Delete old scan for this coin, then insert new
    db.delete(marketScans).where(eq(marketScans.coin, scan.coin)).run();
    return db.insert(marketScans).values(scan).returning().get();
  }

  getLatestScans(): MarketScan[] {
    return db.select().from(marketScans).orderBy(desc(marketScans.rsi)).all();
  }

  getScansWithSignal(): MarketScan[] {
    return db.select().from(marketScans)
      .where(
        and(
          // not null signal and not neutral
        )
      ).all()
      .filter(s => s.signal && s.signal !== "neutral");
  }
}

export const storage = new DatabaseStorage();
