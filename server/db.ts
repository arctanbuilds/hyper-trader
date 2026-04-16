import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export const db = drizzle(pool, { schema });

// Create all tables at startup (idempotent)
export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        id SERIAL PRIMARY KEY,
        is_running BOOLEAN DEFAULT false,
        api_key TEXT DEFAULT '',
        api_secret TEXT DEFAULT '',
        wallet_address TEXT DEFAULT '',
        max_leverage INTEGER DEFAULT 50,
        max_positions INTEGER DEFAULT 5,
        trade_amount_pct DOUBLE PRECISION DEFAULT 10,
        weekly_target_pct DOUBLE PRECISION DEFAULT 50,
        max_drawdown_pct DOUBLE PRECISION DEFAULT 10,
        rsi_oversold_threshold INTEGER DEFAULT 20,
        rsi_overbought_threshold INTEGER DEFAULT 80,
        stop_loss_pct DOUBLE PRECISION DEFAULT 0.35,
        take_profit_pct DOUBLE PRECISION DEFAULT 0.5,
        take_profit_2_pct DOUBLE PRECISION DEFAULT 1.0,
        trailing_stop_pct DOUBLE PRECISION DEFAULT 0.3,
        use_trailing_stop BOOLEAN DEFAULT true,
        max_risk_per_trade_pct DOUBLE PRECISION DEFAULT 0.25,
        min_risk_reward_ratio DOUBLE PRECISION DEFAULT 1.0,
        min_confluence_score INTEGER DEFAULT 3,
        min_volume_24h DOUBLE PRECISION DEFAULT 1000000,
        use_macro_filter BOOLEAN DEFAULT true,
        use_session_filter BOOLEAN DEFAULT true,
        use_ema_filter BOOLEAN DEFAULT true,
        use_liquidation_filter BOOLEAN DEFAULT true,
        scan_interval_secs INTEGER DEFAULT 60,
        max_daily_loss_pct DOUBLE PRECISION DEFAULT 0.75,
        max_weekly_loss_pct DOUBLE PRECISION DEFAULT 1.5,
        updated_at TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        coin TEXT NOT NULL,
        side TEXT NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        exit_price DOUBLE PRECISION,
        size DOUBLE PRECISION NOT NULL,
        leverage INTEGER NOT NULL,
        rsi_at_entry DOUBLE PRECISION,
        rsi_4h DOUBLE PRECISION,
        rsi_1d DOUBLE PRECISION,
        ema_10 DOUBLE PRECISION,
        ema_21 DOUBLE PRECISION,
        ema_50 DOUBLE PRECISION,
        stop_loss DOUBLE PRECISION,
        take_profit_1 DOUBLE PRECISION,
        take_profit_2 DOUBLE PRECISION,
        tp1_hit BOOLEAN DEFAULT false,
        confluence_score INTEGER DEFAULT 0,
        confluence_details TEXT DEFAULT '',
        risk_reward_ratio DOUBLE PRECISION,
        pnl DOUBLE PRECISION,
        pnl_pct DOUBLE PRECISION,
        peak_pnl_pct DOUBLE PRECISION DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        reason TEXT DEFAULT '',
        close_reason TEXT DEFAULT '',
        setup_type TEXT DEFAULT '',
        strategy TEXT DEFAULT 'confluence',
        opened_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS pnl_snapshots (
        id SERIAL PRIMARY KEY,
        total_equity DOUBLE PRECISION NOT NULL,
        total_pnl DOUBLE PRECISION NOT NULL,
        total_pnl_pct DOUBLE PRECISION NOT NULL,
        open_positions INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS market_scans (
        id SERIAL PRIMARY KEY,
        coin TEXT NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        rsi DOUBLE PRECISION,
        rsi_4h DOUBLE PRECISION,
        rsi_1d DOUBLE PRECISION,
        ema_10 DOUBLE PRECISION,
        ema_21 DOUBLE PRECISION,
        ema_50 DOUBLE PRECISION,
        volume_24h DOUBLE PRECISION,
        change_24h DOUBLE PRECISION,
        signal TEXT,
        funding_rate DOUBLE PRECISION,
        open_interest DOUBLE PRECISION,
        confluence_score INTEGER DEFAULT 0,
        confluence_details TEXT DEFAULT '',
        risk_reward_ratio DOUBLE PRECISION,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trade_decisions (
        id SERIAL PRIMARY KEY,
        trade_id INTEGER,
        coin TEXT NOT NULL,
        action TEXT NOT NULL,
        side TEXT,
        price DOUBLE PRECISION NOT NULL,
        rsi_1h DOUBLE PRECISION,
        rsi_4h DOUBLE PRECISION,
        rsi_1d DOUBLE PRECISION,
        ema_10 DOUBLE PRECISION,
        ema_21 DOUBLE PRECISION,
        ema_50 DOUBLE PRECISION,
        volume_24h DOUBLE PRECISION,
        change_24h DOUBLE PRECISION,
        funding_rate DOUBLE PRECISION,
        open_interest DOUBLE PRECISION,
        confluence_score INTEGER,
        confluence_details TEXT,
        risk_reward_ratio DOUBLE PRECISION,
        reasoning TEXT NOT NULL,
        strategy TEXT DEFAULT 'confluence',
        equity DOUBLE PRECISION,
        leverage INTEGER,
        position_size_usd DOUBLE PRECISION,
        session TEXT,
        day_of_week INTEGER,
        hour_utc INTEGER,
        outcome TEXT,
        outcome_pnl_pct DOUBLE PRECISION,
        outcome_pnl_usd DOUBLE PRECISION,
        hold_duration_mins INTEGER,
        exit_type TEXT,
        was_good_decision BOOLEAN,
        review_notes TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_reviews (
        id SERIAL PRIMARY KEY,
        review_type TEXT NOT NULL,
        trades_analyzed INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        total_pnl_pct DOUBLE PRECISION NOT NULL,
        insights_generated INTEGER NOT NULL,
        insights_updated INTEGER NOT NULL,
        summary TEXT NOT NULL,
        mistakes_identified TEXT DEFAULT '',
        improvements_applied TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_insights (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        rule TEXT NOT NULL,
        description TEXT NOT NULL,
        sample_size INTEGER NOT NULL,
        win_rate DOUBLE PRECISION,
        avg_pnl_pct DOUBLE PRECISION,
        avg_pnl_win_pct DOUBLE PRECISION,
        avg_pnl_loss_pct DOUBLE PRECISION,
        confidence DOUBLE PRECISION NOT NULL,
        is_active BOOLEAN DEFAULT true,
        trades_affected INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Add new columns to existing tables (safe — IF NOT EXISTS equivalent via catching errors)
    const alterQueries = [
      "ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy TEXT DEFAULT 'confluence'",
      "ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS strategy TEXT DEFAULT 'confluence'",
      "ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_equity DOUBLE PRECISION",
      "ALTER TABLE market_scans ADD COLUMN IF NOT EXISTS rsi_5m DOUBLE PRECISION",
      "ALTER TABLE market_scans ADD COLUMN IF NOT EXISTS rsi_15m DOUBLE PRECISION",
      "ALTER TABLE trades ADD COLUMN IF NOT EXISTS notional_value DOUBLE PRECISION",
      "ALTER TABLE trades ADD COLUMN IF NOT EXISTS hl_pnl_usd DOUBLE PRECISION",
      "ALTER TABLE trades ADD COLUMN IF NOT EXISTS hl_close_fee DOUBLE PRECISION",
    ];
    for (const q of alterQueries) {
      try { await client.query(q); } catch (e) { /* column may already exist */ }
    }
    console.log("[DB] PostgreSQL tables initialized");
  } finally {
    client.release();
  }
}
