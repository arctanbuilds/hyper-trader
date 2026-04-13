import { db, initDatabase } from "./db";
import { eq, desc, and, gte, isNull, isNotNull } from "drizzle-orm";
import {
  botConfig, trades, pnlSnapshots, activityLog, marketScans,
  tradeDecisions, learningInsights,
  type BotConfig, type InsertBotConfig,
  type Trade, type InsertTrade,
  type PnlSnapshot, type InsertPnlSnapshot,
  type ActivityLogEntry, type InsertActivityLog,
  type MarketScan, type InsertMarketScan,
  type TradeDecision, type InsertTradeDecision,
  type LearningInsight, type InsertLearningInsight,
} from "@shared/schema";

export interface IStorage {
  init(): Promise<void>;
  // Bot Config
  getConfig(): Promise<BotConfig | undefined>;
  updateConfig(data: Partial<InsertBotConfig>): Promise<BotConfig>;
  
  // Trades
  createTrade(trade: InsertTrade): Promise<Trade>;
  updateTrade(id: number, data: Partial<InsertTrade>): Promise<Trade | undefined>;
  getOpenTrades(): Promise<Trade[]>;
  getAllTrades(limit?: number): Promise<Trade[]>;
  getTradeById(id: number): Promise<Trade | undefined>;
  getClosedTradesSince(since: string): Promise<Trade[]>;
  
  // PnL Snapshots
  createPnlSnapshot(snap: InsertPnlSnapshot): Promise<PnlSnapshot>;
  getPnlSnapshots(since?: string): Promise<PnlSnapshot[]>;
  
  // Activity Log
  createLog(entry: InsertActivityLog): Promise<ActivityLogEntry>;
  getLogs(limit?: number): Promise<ActivityLogEntry[]>;
  
  // Market Scans
  upsertMarketScan(scan: InsertMarketScan): Promise<MarketScan>;
  getLatestScans(): Promise<MarketScan[]>;
  getScansWithSignal(): Promise<MarketScan[]>;
  
  // Trade Decisions (Learning Memory)
  createDecision(decision: InsertTradeDecision): Promise<TradeDecision>;
  updateDecision(id: number, data: Partial<InsertTradeDecision>): Promise<TradeDecision | undefined>;
  getDecisionsByTradeId(tradeId: number): Promise<TradeDecision[]>;
  getUnreviewedDecisions(limit?: number): Promise<TradeDecision[]>;
  getAllDecisions(limit?: number): Promise<TradeDecision[]>;
  getDecisionsByCoin(coin: string, limit?: number): Promise<TradeDecision[]>;
  getDecisionsByOutcome(outcome: string, limit?: number): Promise<TradeDecision[]>;
  
  // Learning Insights
  createInsight(insight: InsertLearningInsight): Promise<LearningInsight>;
  updateInsight(id: number, data: Partial<InsertLearningInsight>): Promise<LearningInsight | undefined>;
  getActiveInsights(): Promise<LearningInsight[]>;
  getAllInsights(): Promise<LearningInsight[]>;
  getInsightByRule(rule: string): Promise<LearningInsight | undefined>;
}

export class DatabaseStorage implements IStorage {
  async init() {
    await initDatabase();
    // Ensure default config exists
    const rows = await db.select().from(botConfig);
    if (rows.length === 0) {
      await db.insert(botConfig).values({
        isRunning: false,
        maxLeverage: 50,
        maxPositions: 5,
        weeklyTargetPct: 50,
        maxDrawdownPct: 10,
        rsiOversoldThreshold: 20,
        rsiOverboughtThreshold: 80,
        scanIntervalSecs: 60,
        tradeAmountPct: 10,
        stopLossPct: 0.35,
        takeProfitPct: 0.5,
        takeProfit2Pct: 1.0,
        trailingStopPct: 0.3,
        useTrailingStop: true,
        maxRiskPerTradePct: 0.25,
        minRiskRewardRatio: 1.0,
        minConfluenceScore: 3,
        minVolume24h: 1000000,
        useMacroFilter: true,
        useSessionFilter: true,
        useEmaFilter: true,
        useLiquidationFilter: true,
        maxDailyLossPct: 0.75,
        maxWeeklyLossPct: 1.5,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async getConfig(): Promise<BotConfig | undefined> {
    const rows = await db.select().from(botConfig);
    return rows[0];
  }

  async updateConfig(data: Partial<InsertBotConfig>): Promise<BotConfig> {
    const existing = await this.getConfig();
    if (!existing) throw new Error("No config found");
    await db.update(botConfig)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(botConfig.id, existing.id));
    return (await this.getConfig())!;
  }

  async createTrade(trade: InsertTrade): Promise<Trade> {
    const rows = await db.insert(trades).values(trade).returning();
    return rows[0];
  }

  async updateTrade(id: number, data: Partial<InsertTrade>): Promise<Trade | undefined> {
    await db.update(trades).set(data).where(eq(trades.id, id));
    const rows = await db.select().from(trades).where(eq(trades.id, id));
    return rows[0];
  }

  async getOpenTrades(): Promise<Trade[]> {
    return db.select().from(trades).where(eq(trades.status, "open"));
  }

  async getAllTrades(limit: number = 100): Promise<Trade[]> {
    return db.select().from(trades).orderBy(desc(trades.id)).limit(limit);
  }

  async getTradeById(id: number): Promise<Trade | undefined> {
    const rows = await db.select().from(trades).where(eq(trades.id, id));
    return rows[0];
  }

  async getClosedTradesSince(since: string): Promise<Trade[]> {
    return db.select().from(trades)
      .where(and(eq(trades.status, "closed"), gte(trades.closedAt, since)))
      .orderBy(desc(trades.id));
  }

  async createPnlSnapshot(snap: InsertPnlSnapshot): Promise<PnlSnapshot> {
    const rows = await db.insert(pnlSnapshots).values(snap).returning();
    return rows[0];
  }

  async getPnlSnapshots(since?: string): Promise<PnlSnapshot[]> {
    if (since) {
      return db.select().from(pnlSnapshots)
        .where(gte(pnlSnapshots.timestamp, since))
        .orderBy(pnlSnapshots.timestamp);
    }
    return db.select().from(pnlSnapshots).orderBy(desc(pnlSnapshots.timestamp)).limit(500);
  }

  async createLog(entry: InsertActivityLog): Promise<ActivityLogEntry> {
    const rows = await db.insert(activityLog).values(entry).returning();
    return rows[0];
  }

  async getLogs(limit: number = 200): Promise<ActivityLogEntry[]> {
    return db.select().from(activityLog).orderBy(desc(activityLog.id)).limit(limit);
  }

  async upsertMarketScan(scan: InsertMarketScan): Promise<MarketScan> {
    await db.delete(marketScans).where(eq(marketScans.coin, scan.coin));
    const rows = await db.insert(marketScans).values(scan).returning();
    return rows[0];
  }

  async getLatestScans(): Promise<MarketScan[]> {
    return db.select().from(marketScans).orderBy(desc(marketScans.rsi));
  }

  async getScansWithSignal(): Promise<MarketScan[]> {
    const all = await db.select().from(marketScans);
    return all.filter(s => s.signal && s.signal !== "neutral");
  }

  // ============ TRADE DECISIONS ============

  async createDecision(decision: InsertTradeDecision): Promise<TradeDecision> {
    const rows = await db.insert(tradeDecisions).values(decision).returning();
    return rows[0];
  }

  async updateDecision(id: number, data: Partial<InsertTradeDecision>): Promise<TradeDecision | undefined> {
    await db.update(tradeDecisions).set(data).where(eq(tradeDecisions.id, id));
    const rows = await db.select().from(tradeDecisions).where(eq(tradeDecisions.id, id));
    return rows[0];
  }

  async getDecisionsByTradeId(tradeId: number): Promise<TradeDecision[]> {
    return db.select().from(tradeDecisions)
      .where(eq(tradeDecisions.tradeId, tradeId))
      .orderBy(tradeDecisions.id);
  }

  async getUnreviewedDecisions(limit: number = 50): Promise<TradeDecision[]> {
    return db.select().from(tradeDecisions)
      .where(and(
        eq(tradeDecisions.action, "entry"),
        isNull(tradeDecisions.outcome),
        isNotNull(tradeDecisions.tradeId),
      ))
      .orderBy(desc(tradeDecisions.id)).limit(limit);
  }

  async getAllDecisions(limit: number = 500): Promise<TradeDecision[]> {
    return db.select().from(tradeDecisions)
      .orderBy(desc(tradeDecisions.id)).limit(limit);
  }

  async getDecisionsByCoin(coin: string, limit: number = 100): Promise<TradeDecision[]> {
    return db.select().from(tradeDecisions)
      .where(eq(tradeDecisions.coin, coin))
      .orderBy(desc(tradeDecisions.id)).limit(limit);
  }

  async getDecisionsByOutcome(outcome: string, limit: number = 100): Promise<TradeDecision[]> {
    return db.select().from(tradeDecisions)
      .where(eq(tradeDecisions.outcome, outcome))
      .orderBy(desc(tradeDecisions.id)).limit(limit);
  }

  // ============ LEARNING INSIGHTS ============

  async createInsight(insight: InsertLearningInsight): Promise<LearningInsight> {
    const rows = await db.insert(learningInsights).values(insight).returning();
    return rows[0];
  }

  async updateInsight(id: number, data: Partial<InsertLearningInsight>): Promise<LearningInsight | undefined> {
    await db.update(learningInsights).set(data).where(eq(learningInsights.id, id));
    const rows = await db.select().from(learningInsights).where(eq(learningInsights.id, id));
    return rows[0];
  }

  async getActiveInsights(): Promise<LearningInsight[]> {
    return db.select().from(learningInsights)
      .where(eq(learningInsights.isActive, true))
      .orderBy(desc(learningInsights.confidence));
  }

  async getAllInsights(): Promise<LearningInsight[]> {
    return db.select().from(learningInsights)
      .orderBy(desc(learningInsights.updatedAt));
  }

  async getInsightByRule(rule: string): Promise<LearningInsight | undefined> {
    const rows = await db.select().from(learningInsights)
      .where(eq(learningInsights.rule, rule));
    return rows[0];
  }
}

export const storage = new DatabaseStorage();
