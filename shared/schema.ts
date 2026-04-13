import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Bot configuration
export const botConfig = sqliteTable("bot_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  isRunning: integer("is_running", { mode: "boolean" }).default(false),
  apiKey: text("api_key").default(""),
  apiSecret: text("api_secret").default(""),
  walletAddress: text("wallet_address").default(""),
  maxLeverage: integer("max_leverage").default(20),
  maxPositions: integer("max_positions").default(5),
  weeklyTargetPct: real("weekly_target_pct").default(50),
  maxDrawdownPct: real("max_drawdown_pct").default(10),
  rsiOversoldThreshold: integer("rsi_oversold_threshold").default(20),
  rsiOverboughtThreshold: integer("rsi_overbought_threshold").default(80),
  scanIntervalSecs: integer("scan_interval_secs").default(60),
  tradeAmountPct: real("trade_amount_pct").default(10),
  stopLossPct: real("stop_loss_pct").default(2),
  takeProfitPct: real("take_profit_pct").default(5),
  trailingStopPct: real("trailing_stop_pct").default(1.5),
  useTrailingStop: integer("use_trailing_stop", { mode: "boolean" }).default(true),
  minVolume24h: real("min_volume_24h").default(1000000),
  updatedAt: text("updated_at").default(""),
});

// Active and historical trades
export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  coin: text("coin").notNull(),
  side: text("side").notNull(), // "long" or "short"
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  size: real("size").notNull(),
  leverage: integer("leverage").notNull(),
  rsiAtEntry: real("rsi_at_entry"),
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  pnl: real("pnl"),
  pnlPct: real("pnl_pct"),
  status: text("status").notNull().default("open"), // open, closed, liquidated
  reason: text("reason").default(""), // why trade was taken
  closeReason: text("close_reason").default(""), // why closed
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
  type: text("type").notNull(), // trade_open, trade_close, scan, error, config_change, withdrawal
  message: text("message").notNull(),
  data: text("data").default(""), // JSON string for extra data
  timestamp: text("timestamp").notNull(),
});

// Market scanner results (cached)
export const marketScans = sqliteTable("market_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  coin: text("coin").notNull(),
  price: real("price").notNull(),
  rsi: real("rsi"),
  volume24h: real("volume_24h"),
  change24h: real("change_24h"),
  signal: text("signal"), // "oversold_long", "overbought_short", "neutral"
  fundingRate: real("funding_rate"),
  openInterest: real("open_interest"),
  timestamp: text("timestamp").notNull(),
});

// Insert schemas
export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });
export const insertTradeSchema = createInsertSchema(trades).omit({ id: true });
export const insertPnlSnapshotSchema = createInsertSchema(pnlSnapshots).omit({ id: true });
export const insertActivityLogSchema = createInsertSchema(activityLog).omit({ id: true });
export const insertMarketScanSchema = createInsertSchema(marketScans).omit({ id: true });

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
