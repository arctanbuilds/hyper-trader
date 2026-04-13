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
    max_leverage INTEGER DEFAULT 20,
    max_positions INTEGER DEFAULT 5,
    weekly_target_pct REAL DEFAULT 50,
    max_drawdown_pct REAL DEFAULT 10,
    rsi_oversold_threshold INTEGER DEFAULT 20,
    rsi_overbought_threshold INTEGER DEFAULT 80,
    scan_interval_secs INTEGER DEFAULT 60,
    trade_amount_pct REAL DEFAULT 10,
    stop_loss_pct REAL DEFAULT 2,
    take_profit_pct REAL DEFAULT 5,
    trailing_stop_pct REAL DEFAULT 1.5,
    use_trailing_stop INTEGER DEFAULT 1,
    min_volume_24h REAL DEFAULT 1000000,
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
    stop_loss REAL,
    take_profit REAL,
    pnl REAL,
    pnl_pct REAL,
    status TEXT NOT NULL DEFAULT 'open',
    reason TEXT DEFAULT '',
    close_reason TEXT DEFAULT '',
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
    volume_24h REAL,
    change_24h REAL,
    signal TEXT,
    funding_rate REAL,
    open_interest REAL,
    timestamp TEXT NOT NULL
  );
`);

export const db = drizzle(sqlite, { schema });
