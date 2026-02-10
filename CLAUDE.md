# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket paper trading bot that copy-trades from a specified user's Polymarket profile. It maintains a virtual ledger with position tracking, P&L calculations, and fee accounting, exposed through a real-time web dashboard.

## Commands

```bash
npm start          # Run the bot (uses tsx to execute TypeScript directly)
npm install        # Install dependencies
npx tsc            # Type-check without running (compiled output goes to dist/)
```

There are no test or lint scripts configured.

## Environment Variables (.env)

| Variable | Default | Description |
|---|---|---|
| `PROFILE_ADDRESS` | (required) | Polymarket user address to copy trades from |
| `POLL_INTERVAL_MS` | 1000 | Polling interval in milliseconds |
| `MAX_TRADE_SIZE_USD` | 10 | Maximum trade size per position |
| `MAX_EXPOSURE_PCT` | 0.2 | Max portfolio exposure (defined but not enforced) |
| `PORT` | 3000 | Dashboard web server port |
| `EXPECTED_EDGE` | 0.06 | Historical edge of source profile (e.g., 0.06 for 6%) |
| `SLIPPAGE_DELAY_PENALTY` | 0.003 | Latency penalty in slippage calc (0.2%-0.5%, default 0.3%) |
| `ENABLE_SLIPPAGE_FILTER` | true | Enable/disable slippage-based trade filtering |

## Architecture

**Entry point**: `src/index.ts` boots all services in sequence and starts the polling loop.

**Singleton services** (all accessed via `ServiceName.getInstance()`):

- **TradingEngine** (`src/services/TradingEngine.ts`) — Core loop: polls Polymarket API for the tracked user's activity, processes new trades, runs a watchdog every 10 ticks to detect resolved markets and price extremes, and updates market prices for unrealized P&L. **Includes slippage filtering** before trade execution.
- **SlippageCalculator** (`src/services/SlippageCalculator.ts`) — Calculates expected slippage based on market spread, order book depth, and execution delay. Enforces a hard rule: only execute if slippage ≤ 40% of expected edge.
- **LedgerService** (`src/services/LedgerService.ts`) — Persists all state to `data/ledger.json`: balances, open/closed positions, trade events, market metadata cache, and processed transaction hashes for deduplication. Position keys use the format `${marketId}-${side}`.
- **PolymarketService** (`src/services/PolymarketService.ts`) — HTTP client layer wrapping four Polymarket APIs: `data-api` (user activity), `gamma-api` (market metadata), `clob` (live prices and order books), and `api` (market ID mappings).
- **LogService** (`src/services/LogService.ts`) — Writes daily CSV trade logs to `logs/` and broadcasts messages via Socket.io to dashboard clients.

**Dashboard** (`src/dashboard/`):

- `server.ts` — Express server with Socket.io. REST endpoints: `GET /api/stats`, `POST /api/control/toggle`, `POST /api/control/close-all`, `POST /api/close`.
- `public/index.html` — Single-file vanilla JS/HTML/CSS dashboard. Polls `/api/stats` every second and receives real-time log events via Socket.io.

**Dashboard API Endpoints**:

- `GET /api/stats` — Returns complete portfolio state including:
  - Bot status (RUNNING/STOPPED)
  - Current balance and total fees
  - Daily realized P&L and fees
  - Total unrealized P&L
  - Active positions (with current prices, values, unrealized P&L)
  - Closed positions history
  - Trade events log

- `POST /api/control/toggle` — Start or stop the polling bot. Returns new running state.

- `POST /api/control/close-all` — Immediately close all open positions. Used for emergency exits or end-of-day reconciliation.

- `POST /api/close` — Close a specific position. Body: `{ marketId: string, side: "YES" | "NO" }`.

## Data Flow

1. TradingEngine polls Polymarket data-api for user trades
2. New trades (deduplicated by tx hash) are processed: market metadata fetched, outcome mapped to YES/NO, position limits applied
3. LedgerService updates positions and balance, persists to `data/ledger.json`
4. LogService writes CSV log entry and emits Socket.io event
5. Dashboard displays current state via REST polling + Socket.io logs

## Slippage Estimation & Filtering

**Purpose**: Before copying a trade, the bot calculates expected slippage costs and compares them against the source profile's historical edge. Trades are skipped if slippage is too high.

**Components** (calculated by `SlippageCalculator`):

1. **Market Spread Percentage** — How wide the bid-ask spread is:
   - Formula: `(bestAsk - bestBid) / midPrice`

2. **Depth-Based Impact** — How much the order will move the market based on available liquidity:
   - For BUY: Sum USDC of all asks within 1% of bestAsk
   - For SELL: Sum USDC of all bids within 1% of bestBid
   - Formula: `tradeSize / totalLiquidity`
   - Returns `Infinity` if liquidity is empty (trade fails)

3. **Execution Delay Penalty** — Hard-coded latency cost (default 0.3%, configurable 0.2%-0.5%)

**Go/No-Go Rule** (Hard enforcement):
```
threshold = expectedEdge * 0.4  // Only allow 40% of edge to be consumed by slippage
if (totalSlippage > threshold) {
  SKIP TRADE
} else {
  EXECUTE TRADE
}
```

**Configuration**:
- `EXPECTED_EDGE`: Historical edge of the source trader (default 6%)
- `SLIPPAGE_DELAY_PENALTY`: Latency cost in decimal form (default 0.003 for 0.3%)
- `ENABLE_SLIPPAGE_FILTER`: Toggle slippage checking on/off

**Logging**: When a trade is skipped due to slippage, console logs detailed breakdown of spread %, impact %, delay penalty, total slippage, and threshold.

## Key Conventions

- ES modules throughout (`"type": "module"` in package.json, `.js` extensions in imports)
- TypeScript strict mode enabled
- All domain types defined in `src/types.ts` (Position, ClosedPosition, TradeEvent, LedgerSchema, MarketMetadata)
- Fees calculated at 2% of transaction notional value
- Trade events are append-only (event sourcing pattern in tradeEvents array)
- Slippage filtering runs on every trade in `processAutoTrade()`, before position update
