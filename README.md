# HyperTrader — Automated Hyperliquid Perpetual Futures Trading Bot

Fully autonomous trading bot that scans all Hyperliquid perpetual futures for RSI-based signals and executes trades with real orders. Includes a dark-mode admin panel for monitoring, controlling, and managing everything.

## Quick Start (Run Locally)

### Prerequisites
- **Node.js 20+** — [Download](https://nodejs.org)
- **A Hyperliquid account** with deposited USDC — [app.hyperliquid.xyz](https://app.hyperliquid.xyz)

### Install & Run
```bash
git clone <this-repo> hyper-trader
cd hyper-trader
npm install
npm run dev
```

Open **http://localhost:5000** in your browser.

---

## Connect to Hyperliquid (Step by Step)

### Step 1 — Fund Your Hyperliquid Account
1. Go to [app.hyperliquid.xyz](https://app.hyperliquid.xyz)
2. Click **Connect** → select your wallet (MetaMask, Rabby, etc.)
3. Click **Deposit** → select **Arbitrum One** (lowest gas) → deposit **USDC**
4. Wait for confirmation — your balance appears in the portfolio

### Step 2 — Generate API Keys
1. On Hyperliquid, click **More** (top menu) → **API**
   - Direct link: [app.hyperliquid.xyz/API](https://app.hyperliquid.xyz/API)
2. Enter a name for the API wallet (e.g. `hyper-trader`)
3. Click **Generate**
4. Click **Authorize API Wallet**
5. Set **Days Valid** → choose **MAX** (180 days)
6. **COPY THE PRIVATE KEY** — it's shown only once, store it safely
7. Click **Authorize** and sign the transaction in your wallet

> **Security note:** API wallets can ONLY trade. They cannot withdraw your funds. Even if the key leaks, your capital is safe.

### Step 3 — Get Your Wallet Address
1. On Hyperliquid, click your **wallet address** in the top-right corner
2. Copy your **Account Wallet Address** (starts with `0x...`)
3. This is your MAIN wallet address, not the API wallet address

### Step 4 — Configure HyperTrader
1. Open HyperTrader at **http://localhost:5000**
2. Go to **Settings**
3. Paste your **Wallet Address** (from Step 3)
4. Paste your **API Secret Key** (the private key from Step 2)
5. Adjust strategy parameters as desired:
   - RSI thresholds (default: oversold ≤20, overbought ≥80)
   - Max leverage (default: 20x)
   - Position size (default: 10% of capital per trade)
   - Stop loss / Take profit percentages
6. Click **Save All**

### Step 5 — Start Trading
1. Click **Start Bot** in the sidebar
2. The bot will immediately begin scanning all Hyperliquid perps
3. When it finds severely oversold/overbought assets, it executes real trades
4. Monitor everything from the Dashboard

---

## Deploy on a VPS (24/7 Trading)

For the bot to trade continuously, run it on a VPS. Recommended: **Hetzner** ($5/mo), **DigitalOcean** ($6/mo), or **Railway** (pay-per-use).

### Option A — Docker (Recommended)
```bash
# On your VPS:
git clone <this-repo> hyper-trader
cd hyper-trader
docker compose up -d
```

The bot runs on port 5000, auto-restarts on crash, and persists data in `./data/`.

### Option B — Direct Node.js
```bash
# On your VPS:
git clone <this-repo> hyper-trader
cd hyper-trader
npm install
npm run build

# Run with pm2 for auto-restart
npm install -g pm2
pm2 start dist/index.cjs --name hyper-trader
pm2 save
pm2 startup  # auto-start on reboot
```

### Option C — Railway (Easiest, No Server Setup)
1. Push code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Railway auto-detects Node.js, builds, and deploys
4. Set environment: `NODE_ENV=production`, `PORT=5000`
5. You get a public URL for your admin panel

---

## Strategy Overview

The bot runs a **mean-reversion strategy** on all Hyperliquid perpetual futures:

| Signal | Condition | Action |
|--------|-----------|--------|
| **Oversold Long** | RSI(14, 1h) ≤ 20 | Open LONG position |
| **Overbought Short** | RSI(14, 1h) ≥ 80 | Open SHORT position |

### Confluence Scoring
Each signal is scored by additional factors:
- **Funding rate alignment** — Negative funding boosts long signals, positive funding boosts short signals
- **24h momentum** — Large drops boost long signals, large pumps boost short signals  
- **Extreme momentum penalty** — Signals in >15% moves are penalized (catching falling knives)

### Exit Conditions
1. **Take profit** — Configurable % from entry (default: 5%)
2. **Stop loss** — Configurable % from entry (default: 2%)
3. **Trailing stop** — Auto-trails as profit grows (default: 1.5%)
4. **RSI recovery** — Closes when RSI normalizes back to 50

### Risk Controls
- Maximum open positions (default: 5)
- Maximum leverage (default: 20x)
- Position size as % of capital (default: 10%)
- Scan interval (default: 60 seconds)
- Minimum 24h volume filter (default: $1M)

---

## Admin Panel Pages

| Page | Description |
|------|-------------|
| **Dashboard** | KPI cards, equity curve chart, open positions, activity feed |
| **Trades** | Open positions with close buttons, full trade history |
| **Scanner** | RSI heat map of all assets, active signal cards |
| **Settings** | All configuration, API connection, risk parameters |
| **Logs** | Complete activity history with color-coded entries |

---

## Adding Capital / Withdrawing Profits

Your funds stay in your Hyperliquid wallet at all times. The bot's API key can only trade — it cannot move money.

- **Add capital:** Deposit more USDC on [app.hyperliquid.xyz](https://app.hyperliquid.xyz)
- **Withdraw profits:** Go to Portfolio → Withdraw on Hyperliquid

---

## Architecture

```
┌─────────────────────────────────────────┐
│           Admin Panel (React)            │
│  Dashboard │ Trades │ Scanner │ Settings │
└──────────────────┬──────────────────────┘
                   │ HTTP/WebSocket
┌──────────────────┴──────────────────────┐
│          Express API Server              │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │ Trading      │  │ Hyperliquid      │  │
│  │ Engine       │  │ Executor         │  │
│  │ (RSI scan,   │  │ (EIP-712 signing,│  │
│  │  signals,    │  │  real orders,    │  │
│  │  exits)      │  │  positions)      │  │
│  └──────┬──────┘  └────────┬─────────┘  │
│         │                  │             │
│  ┌──────┴──────────────────┴─────────┐  │
│  │         SQLite Database            │  │
│  │  configs, trades, P&L, logs, scans │  │
│  └────────────────────────────────────┘  │
└──────────────────┬──────────────────────┘
                   │ HTTPS
┌──────────────────┴──────────────────────┐
│       Hyperliquid API (REST)             │
│  Market data, order execution, account   │
└──────────────────────────────────────────┘
```

## ⚠️ Risk Warning

This bot uses high leverage and targets aggressive returns. Crypto perpetual futures carry extreme risk of loss, including total loss of capital. Only trade with money you can afford to lose. Past performance does not indicate future results. You are solely responsible for your trading decisions.
