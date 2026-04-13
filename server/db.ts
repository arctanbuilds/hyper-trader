import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";

const sqlite = new Database("./data.db");
sqlite.pragma("journal_mode = WAL");

// Auto-create tables at startup (no drizzle-kit needed at runtime)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS bot_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    is_running INTEGER DEFAULT 0,
    api_key TEXT DEFAULT '',
    api_secret TEXT DEFAULT '',
    wallet_address TEXT DEFAULT '',
    max_leverage INTEGER DEFAULT 50,
    max_positions INTEGER DEFAULT 5,
    trade_amount_pct REAL DEFAULT 10,
    weekly_target_pct REAL DEFAULT 50,
    max_drawdown_pct REAL DEFAULT 10,
    rsi_oversold_threshold INTEGER DEFAULT 20,
    rsi_overbought_threshold INTEGER DEFAULT 80,
    stop_loss_pct REAL DEFAULT 0.35,
    take_profit_pct REAL DEFAULT 0.5,
    take_profit_2_pct REAL DEFAULT 1.0,
    trailing_stop_pct REAL DEFAULT 0.3,
    use_trailing_stop INTEGER DEFAULT 1,
    max_risk_per_trade_pct REAL DEFAULT 0.25,
    min_risk_reward_ratio REAL DEFAULT 1.0,
    min_confluence_score INTEGER DEFAULT 3,
    min_volume_24h REAL DEFAULT 1000000,
    use_macro_filter INTEGER DEFAULT 1,
    use_session_filter INTEGER DEFAULT 1,
    use_ema_filter INTEGER DEFAULT 1,
    use_liquidation_filter INTEGER DEFAULT 1,
    scan_interval_secs INTEGER DEFAULT 60,
    max_daily_loss_pct REAL DEFAULT 0.75,
    max_weekly_loss_pct REAL DEFAULT 1.5,
    updated_at TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    size REAL NOT NULL,
    leverage INTEGER NOT NULL,
    rsi_at_entry REAL,
    rsi_4h REAL,
    rsi_1d REAL,
    ema_10 REAL,
    ema_21 REAL,
    ema_50 REAL,
    stop_loss REAL,
    take_profit_1 REAL,
    take_profit_2 REAL,
    tp1_hit INTEGER DEFAULT 0,
    confluence_score INTEGER DEFAULT 0,
    confluence_details TEXT DEFAULT '',
    risk_reward_ratio REAL,
    pnl REAL,
    pnl_pct REAL,
    peak_pnl_pct REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    reason TEXT DEFAULT '',
    close_reason TEXT DEFAULT '',
    setup_type TEXT DEFAULT '',
    opened_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_equity REAL NOT NULL,
    total_pnl REAL NOT NULL,
    total_pnl_pct REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT DEFAULT '',
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS market_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin TEXT NOT NULL,
    price REAL NOT NULL,
    rsi REAL,
    rsi_4h REAL,
    rsi_1d REAL,
    ema_10 REAL,
    ema_21 REAL,
    ema_50 REAL,
    volume_24h REAL,
    change_24h REAL,
    signal TEXT,
    funding_rate REAL,
    open_interest REAL,
    confluence_score INTEGER DEFAULT 0,
    confluence_details TEXT DEFAULT '',
    risk_reward_ratio REAL,
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trade_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER,
    coin TEXT NOT NULL,
    action TEXT NOT NULL,
    side TEXT,
    price REAL NOT NULL,
    rsi_1h REAL,
    rsi_4h REAL,
    rsi_1d REAL,
    ema_10 REAL,
    ema_21 REAL,
    ema_50 REAL,
    volume_24h REAL,
    change_24h REAL,
    funding_rate REAL,
    open_interest REAL,
    confluence_score INTEGER,
    confluence_details TEXT,
    risk_reward_ratio REAL,
    reasoning TEXT NOT NULL,
    equity REAL,
    leverage INTEGER,
    position_size_usd REAL,
    session TEXT,
    day_of_week INTEGER,
    hour_utc INTEGER,
    outcome TEXT,
    outcome_pnl_pct REAL,
    outcome_pnl_usd REAL,
    hold_duration_mins INTEGER,
    exit_type TEXT,
    was_good_decision INTEGER,
    review_notes TEXT,
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS learning_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    rule TEXT NOT NULL,
    description TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    win_rate REAL,
    avg_pnl_pct REAL,
    avg_pnl_win_pct REAL,
    avg_pnl_loss_pct REAL,
    confidence REAL NOT NULL,
    is_active INTEGER DEFAULT 1,
    trades_affected INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export const db = drizzle(sqlite, { schema });
