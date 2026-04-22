import { pgTable, text, integer, doublePrecision, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Bot configuration — enhanced with elite strategy params
export const botConfig = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  isRunning: boolean("is_running").default(false),
  apiKey: text("api_key").default(""),
  apiSecret: text("api_secret").default(""),
  walletAddress: text("wallet_address").default(""),
  // Leverage & Position
  maxLeverage: integer("max_leverage").default(50),
  maxPositions: integer("max_positions").default(5),
  tradeAmountPct: doublePrecision("trade_amount_pct").default(10),
  // Weekly target
  weeklyTargetPct: doublePrecision("weekly_target_pct").default(50),
  maxDrawdownPct: doublePrecision("max_drawdown_pct").default(10),
  // RSI thresholds
  rsiOversoldThreshold: integer("rsi_oversold_threshold").default(20),
  rsiOverboughtThreshold: integer("rsi_overbought_threshold").default(80),
  // Risk management — elite params
  stopLossPct: doublePrecision("stop_loss_pct").default(0.35),
  takeProfitPct: doublePrecision("take_profit_pct").default(0.5),
  takeProfit2Pct: doublePrecision("take_profit_2_pct").default(1.0),
  trailingStopPct: doublePrecision("trailing_stop_pct").default(0.3),
  // P&L baseline — persisted across restarts
  pnlBaselineEquity: doublePrecision("pnl_baseline_equity").default(0),
  pnlBaselineTimestamp: text("pnl_baseline_timestamp").default(""),
  useTrailingStop: boolean("use_trailing_stop").default(true),
  maxRiskPerTradePct: doublePrecision("max_risk_per_trade_pct").default(0.25),
  minRiskRewardRatio: doublePrecision("min_risk_reward_ratio").default(1.0),
  // Confluence & filters
  minConfluenceScore: integer("min_confluence_score").default(3),
  minVolume24h: doublePrecision("min_volume_24h").default(1000000),
  useMacroFilter: boolean("use_macro_filter").default(true),
  useSessionFilter: boolean("use_session_filter").default(true),
  useEmaFilter: boolean("use_ema_filter").default(true),
  useLiquidationFilter: boolean("use_liquidation_filter").default(true),
  // Scan settings
  scanIntervalSecs: integer("scan_interval_secs").default(5),
  // Max daily/weekly loss
  maxDailyLossPct: doublePrecision("max_daily_loss_pct").default(0.75),
  maxWeeklyLossPct: doublePrecision("max_weekly_loss_pct").default(1.5),
  // v17.4.1: persist session state across restarts (JSON-serialised SessionState)
  sessionState: text("session_state").default(""),
  updatedAt: text("updated_at").default(""),
});

// Enhanced trades with dual TP, confluence data, multi-TF info
export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  coin: text("coin").notNull(),
  side: text("side").notNull(), // "long" or "short"
  entryPrice: doublePrecision("entry_price").notNull(),
  exitPrice: doublePrecision("exit_price"),
  size: doublePrecision("size").notNull(),
  leverage: integer("leverage").notNull(),
  // RSI at entry across timeframes
  rsiAtEntry: doublePrecision("rsi_at_entry"),
  rsi4h: doublePrecision("rsi_4h"),
  rsi1d: doublePrecision("rsi_1d"),
  // EMA values at entry
  ema10: doublePrecision("ema_10"),
  ema21: doublePrecision("ema_21"),
  ema50: doublePrecision("ema_50"),
  // Dual take profit
  stopLoss: doublePrecision("stop_loss"),
  takeProfit1: doublePrecision("take_profit_1"),
  takeProfit2: doublePrecision("take_profit_2"),
  tp1Hit: boolean("tp1_hit").default(false),
  // Confluence & scoring
  confluenceScore: integer("confluence_score").default(0),
  confluenceDetails: text("confluence_details").default(""),
  riskRewardRatio: doublePrecision("risk_reward_ratio"),
  // Equity at trade open (for accurate P&L calculation)
  entryEquity: doublePrecision("entry_equity"),
  // Actual notional position value in USDC (filled size * fill price)
  notionalValue: doublePrecision("notional_value"),
  // P&L — read DIRECTLY from Hyperliquid (never calculated)
  pnl: doublePrecision("pnl"),        // leveraged % (legacy, kept for backward compat)
  pnlPct: doublePrecision("pnl_pct"),  // % of AUM (legacy)
  // v11.2: Actual USD P&L from Hyperliquid — THE source of truth
  hlPnlUsd: doublePrecision("hl_pnl_usd"),  // unrealizedPnl (open) or closedPnl-fee (closed), directly from HL
  hlCloseFee: doublePrecision("hl_close_fee"),  // close-side fee from HL fills
  peakPnlPct: doublePrecision("peak_pnl_pct").default(0),
  // Status
  status: text("status").notNull().default("open"), // open, closed, liquidated
  reason: text("reason").default(""),
  closeReason: text("close_reason").default(""),
  setupType: text("setup_type").default(""), // which of the 7 setups
  strategy: text("strategy").default("confluence"), // "confluence" or "extreme_rsi"
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
});

// P&L snapshots for charts
export const pnlSnapshots = pgTable("pnl_snapshots", {
  id: serial("id").primaryKey(),
  totalEquity: doublePrecision("total_equity").notNull(),
  totalPnl: doublePrecision("total_pnl").notNull(),
  totalPnlPct: doublePrecision("total_pnl_pct").notNull(),
  openPositions: integer("open_positions").notNull(),
  timestamp: text("timestamp").notNull(),
});

// Bot activity log
export const activityLog = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  data: text("data").default(""),
  timestamp: text("timestamp").notNull(),
});

// Enhanced market scans with multi-TF and confluence
export const marketScans = pgTable("market_scans", {
  id: serial("id").primaryKey(),
  coin: text("coin").notNull(),
  price: doublePrecision("price").notNull(),
  // Multi-timeframe RSI
  rsi5m: doublePrecision("rsi_5m"),
  rsi15m: doublePrecision("rsi_15m"),
  rsi: doublePrecision("rsi"),
  rsi4h: doublePrecision("rsi_4h"),
  rsi1d: doublePrecision("rsi_1d"),
  // EMAs
  ema10: doublePrecision("ema_10"),
  ema21: doublePrecision("ema_21"),
  ema50: doublePrecision("ema_50"),
  // Market data
  volume24h: doublePrecision("volume_24h"),
  change24h: doublePrecision("change_24h"),
  signal: text("signal"),
  fundingRate: doublePrecision("funding_rate"),
  openInterest: doublePrecision("open_interest"),
  // Confluence
  confluenceScore: integer("confluence_score").default(0),
  confluenceDetails: text("confluence_details").default(""),
  riskRewardRatio: doublePrecision("risk_reward_ratio"),
  timestamp: text("timestamp").notNull(),
});

// ============ LEARNING REVIEW LOG — 24h Deep Reviews ============
export const learningReviews = pgTable("learning_reviews", {
  id: serial("id").primaryKey(),
  reviewType: text("review_type").notNull(), // "24h_cycle", "manual"
  tradesAnalyzed: integer("trades_analyzed").notNull(),
  wins: integer("wins").notNull(),
  losses: integer("losses").notNull(),
  totalPnlPct: doublePrecision("total_pnl_pct").notNull(),
  insightsGenerated: integer("insights_generated").notNull(),
  insightsUpdated: integer("insights_updated").notNull(),
  summary: text("summary").notNull(), // Full text summary of learnings
  mistakesIdentified: text("mistakes_identified").default(""),
  improvementsApplied: text("improvements_applied").default(""),
  timestamp: text("timestamp").notNull(),
});

// ============ TRADE DECISION LOG — The Learning Memory ============
export const tradeDecisions = pgTable("trade_decisions", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id"),
  coin: text("coin").notNull(),
  action: text("action").notNull(),
  side: text("side"),
  price: doublePrecision("price").notNull(),
  rsi1h: doublePrecision("rsi_1h"),
  rsi4h: doublePrecision("rsi_4h"),
  rsi1d: doublePrecision("rsi_1d"),
  ema10: doublePrecision("ema_10"),
  ema21: doublePrecision("ema_21"),
  ema50: doublePrecision("ema_50"),
  volume24h: doublePrecision("volume_24h"),
  change24h: doublePrecision("change_24h"),
  fundingRate: doublePrecision("funding_rate"),
  openInterest: doublePrecision("open_interest"),
  confluenceScore: integer("confluence_score"),
  confluenceDetails: text("confluence_details"),
  riskRewardRatio: doublePrecision("risk_reward_ratio"),
  reasoning: text("reasoning").notNull(),
  strategy: text("strategy").default("confluence"), // "confluence" or "extreme_rsi"
  equity: doublePrecision("equity"),
  leverage: integer("leverage"),
  positionSizeUsd: doublePrecision("position_size_usd"),
  session: text("session"),
  dayOfWeek: integer("day_of_week"),
  hourUtc: integer("hour_utc"),
  outcome: text("outcome"),
  outcomePnlPct: doublePrecision("outcome_pnl_pct"),
  outcomePnlUsd: doublePrecision("outcome_pnl_usd"),
  holdDurationMins: integer("hold_duration_mins"),
  exitType: text("exit_type"),
  wasGoodDecision: boolean("was_good_decision"),
  reviewNotes: text("review_notes"),
  timestamp: text("timestamp").notNull(),
});

// ============ LEARNING INSIGHTS — Accumulated Wisdom ============
export const learningInsights = pgTable("learning_insights", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  rule: text("rule").notNull(),
  description: text("description").notNull(),
  sampleSize: integer("sample_size").notNull(),
  winRate: doublePrecision("win_rate"),
  avgPnlPct: doublePrecision("avg_pnl_pct"),
  avgPnlWinPct: doublePrecision("avg_pnl_win_pct"),
  avgPnlLossPct: doublePrecision("avg_pnl_loss_pct"),
  confidence: doublePrecision("confidence").notNull(),
  isActive: boolean("is_active").default(true),
  tradesAffected: integer("trades_affected").default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============ AIWEEKLY RESEARCH CYCLES ============
export const aiweeklyResearch = pgTable("aiweekly_research", {
  id: serial("id").primaryKey(),
  cycleId: text("cycle_id").notNull(), // unique per research run e.g. "2026-04-17T20:00:00Z"
  status: text("status").notNull().default("pending"), // pending, researching, voting, executing, complete, failed
  // Raw research from Sonar
  sonarResearch: text("sonar_research").default(""), // JSON blob of all research
  // Model votes (JSON: { longs: string[], shorts: string[], commodities: {...} })
  sonarPicks: text("sonar_picks").default(""),
  claudePicks: text("claude_picks").default(""),
  gptPicks: text("gpt_picks").default(""),
  // Final consensus picks
  consensusPicks: text("consensus_picks").default(""), // JSON: { longs, shorts, commodities, confidence }
  // Execution
  tradesOpened: integer("trades_opened").default(0),
  tradesClosed: integer("trades_closed").default(0),
  cyclePnlUsd: doublePrecision("cycle_pnl_usd").default(0),
  // Timing
  researchStartedAt: text("research_started_at"),
  researchCompletedAt: text("research_completed_at"),
  positionsOpenedAt: text("positions_opened_at"),
  positionsClosedAt: text("positions_closed_at"),
  nextCycleAt: text("next_cycle_at"),
  createdAt: text("created_at").notNull(),
});

// Insert schemas
export const insertAiweeklyResearchSchema = createInsertSchema(aiweeklyResearch).omit({ id: true });
export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });
export const insertTradeSchema = createInsertSchema(trades).omit({ id: true });
export const insertPnlSnapshotSchema = createInsertSchema(pnlSnapshots).omit({ id: true });
export const insertActivityLogSchema = createInsertSchema(activityLog).omit({ id: true });
export const insertMarketScanSchema = createInsertSchema(marketScans).omit({ id: true });
export const insertTradeDecisionSchema = createInsertSchema(tradeDecisions).omit({ id: true });
export const insertLearningInsightSchema = createInsertSchema(learningInsights).omit({ id: true });
export const insertLearningReviewSchema = createInsertSchema(learningReviews).omit({ id: true });

// Types — AIWEEKLY
export type AiweeklyResearch = typeof aiweeklyResearch.$inferSelect;
export type InsertAiweeklyResearch = z.infer<typeof insertAiweeklyResearchSchema>;

// Types
export type BotConfig = typeof botConfig.$inferSelect;
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type Trade = typeof trades.$inferSelect;
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type PnlSnapshot = typeof pnlSnapshots.$inferSelect;
export type InsertPnlSnapshot = z.infer<typeof insertPnlSnapshotSchema>;
export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type MarketScan = typeof marketScans.$inferSelect;
export type InsertMarketScan = z.infer<typeof insertMarketScanSchema>;
export type TradeDecision = typeof tradeDecisions.$inferSelect;
export type InsertTradeDecision = z.infer<typeof insertTradeDecisionSchema>;
export type LearningInsight = typeof learningInsights.$inferSelect;
export type InsertLearningInsight = z.infer<typeof insertLearningInsightSchema>;
export type LearningReview = typeof learningReviews.$inferSelect;
export type InsertLearningReview = z.infer<typeof insertLearningReviewSchema>;
