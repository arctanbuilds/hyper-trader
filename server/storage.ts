import { db } from "./db";
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
  // Bot Config
  getConfig(): BotConfig | undefined;
  updateConfig(data: Partial<InsertBotConfig>): BotConfig;
  
  // Trades
  createTrade(trade: InsertTrade): Trade;
  updateTrade(id: number, data: Partial<InsertTrade>): Trade | undefined;
  getOpenTrades(): Trade[];
  getAllTrades(limit?: number): Trade[];
  getTradeById(id: number): Trade | undefined;
  getClosedTradesSince(since: string): Trade[];
  
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
  
  // Trade Decisions (Learning Memory)
  createDecision(decision: InsertTradeDecision): TradeDecision;
  updateDecision(id: number, data: Partial<InsertTradeDecision>): TradeDecision | undefined;
  getDecisionsByTradeId(tradeId: number): TradeDecision[];
  getUnreviewedDecisions(limit?: number): TradeDecision[];
  getAllDecisions(limit?: number): TradeDecision[];
  getDecisionsByCoin(coin: string, limit?: number): TradeDecision[];
  getDecisionsByOutcome(outcome: string, limit?: number): TradeDecision[];
  
  // Learning Insights
  createInsight(insight: InsertLearningInsight): LearningInsight;
  updateInsight(id: number, data: Partial<InsertLearningInsight>): LearningInsight | undefined;
  getActiveInsights(): LearningInsight[];
  getAllInsights(): LearningInsight[];
  getInsightByRule(rule: string): LearningInsight | undefined;
}

export class DatabaseStorage implements IStorage {
  constructor() {
    // Ensure default config exists
    const existing = db.select().from(botConfig).get();
    if (!existing) {
      db.insert(botConfig).values({
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

  getClosedTradesSince(since: string): Trade[] {
    return db.select().from(trades)
      .where(and(eq(trades.status, "closed"), gte(trades.closedAt, since)))
      .orderBy(desc(trades.id)).all();
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

  // ============ TRADE DECISIONS ============

  createDecision(decision: InsertTradeDecision): TradeDecision {
    return db.insert(tradeDecisions).values(decision).returning().get();
  }

  updateDecision(id: number, data: Partial<InsertTradeDecision>): TradeDecision | undefined {
    db.update(tradeDecisions).set(data).where(eq(tradeDecisions.id, id)).run();
    return db.select().from(tradeDecisions).where(eq(tradeDecisions.id, id)).get();
  }

  getDecisionsByTradeId(tradeId: number): TradeDecision[] {
    return db.select().from(tradeDecisions)
      .where(eq(tradeDecisions.tradeId, tradeId))
      .orderBy(tradeDecisions.id).all();
  }

  getUnreviewedDecisions(limit: number = 50): TradeDecision[] {
    return db.select().from(tradeDecisions)
      .where(and(
        eq(tradeDecisions.action, "entry"),
        isNull(tradeDecisions.outcome),
        isNotNull(tradeDecisions.tradeId),
      ))
      .orderBy(desc(tradeDecisions.id)).limit(limit).all();
  }

  getAllDecisions(limit: number = 500): TradeDecision[] {
    return db.select().from(tradeDecisions)
      .orderBy(desc(tradeDecisions.id)).limit(limit).all();
  }

  getDecisionsByCoin(coin: string, limit: number = 100): TradeDecision[] {
    return db.select().from(tradeDecisions)
      .where(eq(tradeDecisions.coin, coin))
      .orderBy(desc(tradeDecisions.id)).limit(limit).all();
  }

  getDecisionsByOutcome(outcome: string, limit: number = 100): TradeDecision[] {
    return db.select().from(tradeDecisions)
      .where(eq(tradeDecisions.outcome, outcome))
      .orderBy(desc(tradeDecisions.id)).limit(limit).all();
  }

  // ============ LEARNING INSIGHTS ============

  createInsight(insight: InsertLearningInsight): LearningInsight {
    return db.insert(learningInsights).values(insight).returning().get();
  }

  updateInsight(id: number, data: Partial<InsertLearningInsight>): LearningInsight | undefined {
    db.update(learningInsights).set(data).where(eq(learningInsights.id, id)).run();
    return db.select().from(learningInsights).where(eq(learningInsights.id, id)).get();
  }

  getActiveInsights(): LearningInsight[] {
    return db.select().from(learningInsights)
      .where(eq(learningInsights.isActive, true))
      .orderBy(desc(learningInsights.confidence)).all();
  }

  getAllInsights(): LearningInsight[] {
    return db.select().from(learningInsights)
      .orderBy(desc(learningInsights.updatedAt)).all();
  }

  getInsightByRule(rule: string): LearningInsight | undefined {
    return db.select().from(learningInsights)
      .where(eq(learningInsights.rule, rule)).get();
  }
}

export const storage = new DatabaseStorage();
