import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Bot configuration — enhanced with elite strategy params
export const botConfig = sqliteTable("bot_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  isRunning: integer("is_running", { mode: "boolean" }).default(false),
  apiKey: text("api_key").default(""),
  apiSecret: text("api_secret").default(""),
  walletAddress: text("wallet_address").default(""),
  // Leverage & Position
  maxLeverage: integer("max_leverage").default(50),
  maxPositions: integer("max_positions").default(5),
  tradeAmountPct: real("trade_amount_pct").default(10),
  // Weekly target
  weeklyTargetPct: real("weekly_target_pct").default(50),
  maxDrawdownPct: real("max_drawdown_pct").default(10),
  // RSI thresholds
  rsiOversoldThreshold: integer("rsi_oversold_threshold").default(20),
  rsiOverboughtThreshold: integer("rsi_overbought_threshold").default(80),
  // Risk management — elite params
  stopLossPct: real("stop_loss_pct").default(0.35),
  takeProfitPct: real("take_profit_pct").default(0.5),
  takeProfit2Pct: real("take_profit_2_pct").default(1.0),
  trailingStopPct: real("trailing_stop_pct").default(0.3),
  useTrailingStop: integer("use_trailing_stop", { mode: "boolean" }).default(true),
  maxRiskPerTradePct: real("max_risk_per_trade_pct").default(0.25),
  minRiskRewardRatio: real("min_risk_reward_ratio").default(1.0),
  // Confluence & filters
  minConfluenceScore: integer("min_confluence_score").default(3),
  minVolume24h: real("min_volume_24h").default(1000000),
  useMacroFilter: integer("use_macro_filter", { mode: "boolean" }).default(true),
  useSessionFilter: integer("use_session_filter", { mode: "boolean" }).default(true),
  useEmaFilter: integer("use_ema_filter", { mode: "boolean" }).default(true),
  useLiquidationFilter: integer("use_liquidation_filter", { mode: "boolean" }).default(true),
  // Scan settings
  scanIntervalSecs: integer("scan_interval_secs").default(60),
  // Max daily/weekly loss
  maxDailyLossPct: real("max_daily_loss_pct").default(0.75),
  maxWeeklyLossPct: real("max_weekly_loss_pct").default(1.5),
  updatedAt: text("updated_at").default(""),
});

// Enhanced trades with dual TP, confluence data, multi-TF info
export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  coin: text("coin").notNull(),
  side: text("side").notNull(), // "long" or "short"
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  size: real("size").notNull(),
  leverage: integer("leverage").notNull(),
  // RSI at entry across timeframes
  rsiAtEntry: real("rsi_at_entry"),
  rsi4h: real("rsi_4h"),
  rsi1d: real("rsi_1d"),
  // EMA values at entry
  ema10: real("ema_10"),
  ema21: real("ema_21"),
  ema50: real("ema_50"),
  // Dual take profit
  stopLoss: real("stop_loss"),
  takeProfit1: real("take_profit_1"),
  takeProfit2: real("take_profit_2"),
  tp1Hit: integer("tp1_hit", { mode: "boolean" }).default(false),
  // Confluence & scoring
  confluenceScore: integer("confluence_score").default(0),
  confluenceDetails: text("confluence_details").default(""),
  riskRewardRatio: real("risk_reward_ratio"),
  // P&L
  pnl: real("pnl"),
  pnlPct: real("pnl_pct"),
  peakPnlPct: real("peak_pnl_pct").default(0),
  // Status
  status: text("status").notNull().default("open"), // open, closed, liquidated
  reason: text("reason").default(""),
  closeReason: text("close_reason").default(""),
  setupType: text("setup_type").default(""), // which of the 7 setups
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
});

// P&L snapshots for charts
export const pnlSnapshots = sqliteTable("pnl_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  totalEquity: real("total_equity").notNull(),
  totalPnl: real("total_pnl").notNull(),
  totalPnlPct: real("total_pnl_pct").notNull(),
  openPositions: integer("open_positions").notNull(),
  timestamp: text("timestamp").notNull(),
});

// Bot activity log
export const activityLog = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  message: text("message").notNull(),
  data: text("data").default(""),
  timestamp: text("timestamp").notNull(),
});

// Enhanced market scans with multi-TF and confluence
export const marketScans = sqliteTable("market_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  coin: text("coin").notNull(),
  price: real("price").notNull(),
  // Multi-timeframe RSI
  rsi: real("rsi"),
  rsi4h: real("rsi_4h"),
  rsi1d: real("rsi_1d"),
  // EMAs
  ema10: real("ema_10"),
  ema21: real("ema_21"),
  ema50: real("ema_50"),
  // Market data
  volume24h: real("volume_24h"),
  change24h: real("change_24h"),
  signal: text("signal"),
  fundingRate: real("funding_rate"),
  openInterest: real("open_interest"),
  // Confluence
  confluenceScore: integer("confluence_score").default(0),
  confluenceDetails: text("confluence_details").default(""),
  riskRewardRatio: real("risk_reward_ratio"),
  timestamp: text("timestamp").notNull(),
});

// ============ TRADE DECISION LOG — The Learning Memory ============
// Every entry/skip/exit decision is recorded here with full reasoning.
// The learning engine reviews closed trades and builds adaptive rules.
export const tradeDecisions = sqliteTable("trade_decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tradeId: integer("trade_id"),                 // FK to trades (null if skipped)
  coin: text("coin").notNull(),
  action: text("action").notNull(),             // "entry", "skip", "exit", "tp1_hit", "circuit_breaker"
  side: text("side"),                           // "long" or "short"
  // Full market snapshot at decision time
  price: real("price").notNull(),
  rsi1h: real("rsi_1h"),
  rsi4h: real("rsi_4h"),
  rsi1d: real("rsi_1d"),
  ema10: real("ema_10"),
  ema21: real("ema_21"),
  ema50: real("ema_50"),
  volume24h: real("volume_24h"),
  change24h: real("change_24h"),
  fundingRate: real("funding_rate"),
  openInterest: real("open_interest"),
  // Decision reasoning
  confluenceScore: integer("confluence_score"),
  confluenceDetails: text("confluence_details"),
  riskRewardRatio: real("risk_reward_ratio"),
  reasoning: text("reasoning").notNull(),       // Human-readable full reasoning chain
  // Positioning at time of decision
  equity: real("equity"),                       // AUM at decision time
  leverage: integer("leverage"),
  positionSizeUsd: real("position_size_usd"),
  // Session context
  session: text("session"),                     // london, ny, overlap, asia, afterhours
  dayOfWeek: integer("day_of_week"),            // 0=Sun to 6=Sat
  hourUtc: integer("hour_utc"),
  // Outcome (filled after trade closes — null for skips and open trades)
  outcome: text("outcome"),                     // "win", "loss", "breakeven", null
  outcomePnlPct: real("outcome_pnl_pct"),
  outcomePnlUsd: real("outcome_pnl_usd"),
  holdDurationMins: integer("hold_duration_mins"),
  exitType: text("exit_type"),                  // "tp1", "tp2", "sl", "trailing", "rsi_recovery", "manual"
  // Was the decision "correct" in hindsight?
  wasGoodDecision: integer("was_good_decision", { mode: "boolean" }),
  reviewNotes: text("review_notes"),            // Learning engine's hindsight analysis
  timestamp: text("timestamp").notNull(),
});

// ============ LEARNING INSIGHTS — Accumulated Wisdom ============
// Patterns the bot has learned from its trade history.
// Each row is a rule/insight derived from analyzing past decisions.
export const learningInsights = sqliteTable("learning_insights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // What was learned
  category: text("category").notNull(),         // "asset", "session", "confluence", "exit", "sizing", "pattern"
  rule: text("rule").notNull(),                 // Machine-readable rule key, e.g. "btc_avoid_asia_short"
  description: text("description").notNull(),   // Human-readable insight
  // Evidence
  sampleSize: integer("sample_size").notNull(), // How many trades this is based on
  winRate: real("win_rate"),                     // Win rate for this pattern
  avgPnlPct: real("avg_pnl_pct"),              // Average P&L when this pattern occurs
  avgPnlWinPct: real("avg_pnl_win_pct"),       // Average winning P&L
  avgPnlLossPct: real("avg_pnl_loss_pct"),     // Average losing P&L
  // Confidence
  confidence: real("confidence").notNull(),     // 0.0-1.0 confidence in this insight
  isActive: integer("is_active", { mode: "boolean" }).default(true), // Whether this rule is being applied
  // Impact tracking
  tradesAffected: integer("trades_affected").default(0), // How many future trades it influenced
  // Timestamps
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Insert schemas
export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });
export const insertTradeSchema = createInsertSchema(trades).omit({ id: true });
export const insertPnlSnapshotSchema = createInsertSchema(pnlSnapshots).omit({ id: true });
export const insertActivityLogSchema = createInsertSchema(activityLog).omit({ id: true });
export const insertMarketScanSchema = createInsertSchema(marketScans).omit({ id: true });
export const insertTradeDecisionSchema = createInsertSchema(tradeDecisions).omit({ id: true });
export const insertLearningInsightSchema = createInsertSchema(learningInsights).omit({ id: true });

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
