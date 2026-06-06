# Vigil Operations Guide (Current Execution Stack)

A step-by-step operator runbook for the current Vigil execution stack — from configuration to data export.

---

## 1. Environment Configuration

Copy the example and fill in your credentials:

```bash
cd ~/apps/apps/personal-butler
cp .env.example .env
```

**Required fields:**

| Variable | Description | Example |
|----------|-------------|---------|
| `ONCHAINOS_API_BASE` | Current execution backend API endpoint | `https://www.okx.com` |
| `ONCHAINOS_API_KEY` | API key | `your-api-key` |
| `ONCHAINOS_API_SECRET` | API secret (for HMAC signing) | `your-api-secret` |
| `ONCHAINOS_PASSPHRASE` | API passphrase | `your-passphrase` |
| `ONCHAINOS_PROJECT_ID` | Project ID | `your-project-id` |
| `ONCHAINOS_USER_WALLET_ADDRESS` | Real live wallet used to build swaps | `0x...` |

Without `ONCHAINOS_API_BASE`, arbitrage quote retrieval and live execution are unavailable. The production runtime does not synthesize mock quotes or mock trades.

**Network profile (choose one):**

| Profile | When to use |
|---------|-------------|
| `xlayer-recommended` (default) | Quick start on X Layer (chain 196). Auto-configures RPC, chain ID, poll mode, HMAC auth. |
| `evm-custom` | Any other EVM chain. You must set `ONCHAINOS_CHAIN_INDEX`, `COMM_CHAIN_ID`, `COMM_RPC_URL` manually. |

**Key tuning parameters (with defaults):**

```bash
START_MODE=paper               # paper or live
ENGINE_INTERVAL_MS=5000        # tick interval (ms)
PAIR=ETH/USDC                  # trading pair
DEX_A=okx-dex-a                # first DEX source
DEX_B=okx-dex-b                # second DEX source
PAPER_START_BALANCE_USD=10000  # paper mode starting balance
MIN_NET_EDGE_BPS_PAPER=45      # minimum net edge to execute (paper)
MIN_NET_EDGE_BPS_LIVE=60       # minimum net edge to execute (live)
SLIPPAGE_BPS=12                # estimated slippage
TAKER_FEE_BPS=20               # taker fee per side
GAS_USD_DEFAULT=1.25           # estimated gas cost per tx
ONCHAINOS_ENABLE_COMPAT_FALLBACK=false # legacy endpoint fallback, disabled for production
ONCHAINOS_ALLOW_SERIAL_DUAL_LEG=false  # serial dual-leg fallback, disabled for production
```

---

## 2. Start the Engine

```bash
npm run dev
```

This starts:
- HTTP API server on `http://localhost:3000`
- Engine tick loop (every `ENGINE_INTERVAL_MS`)
- Market watch (polls the current execution backend for quotes)
- Operator dashboard at `http://localhost:3000/demo`

The engine immediately begins scanning for arbitrage opportunities in paper mode.

---

## 3. Observe

**Browser — Operator Dashboard:**

Open `http://localhost:3000/demo` in a browser. It streams:
- Real-time opportunities and trades
- Growth moments (daily summary, best trade, streaks)
- Execution backend probe status (current v6 path readiness)

**API — Key Endpoints:**

```bash
# Today's metrics (opportunities, trades, PnL)
curl http://localhost:3000/api/v1/metrics/today

# Recent opportunities
curl http://localhost:3000/api/v1/opportunities?limit=20

# Recent trades
curl http://localhost:3000/api/v1/trades?limit=20

# Strategy status
curl http://localhost:3000/api/v1/strategies/status

# Growth moments (shareable content)
curl http://localhost:3000/api/v1/growth/moments?limit=5

# Battle report
curl http://localhost:3000/api/v1/growth/share/latest

# Current execution backend integration health
curl http://localhost:3000/api/v1/integration/execution/status
```

**SSE — Real-time Stream:**

```bash
curl -N http://localhost:3000/api/v1/stream/metrics
```

Streams JSON events with opportunities, trades, PnL updates, and mode changes.

---

## 4. Mode Switching

**Paper mode** (default): simulates trades against real quotes, no on-chain execution.

**Live mode**: executes real trades through the current v6 flow (`quote → swap → simulate → broadcast`).

Live mode requires `ONCHAINOS_USER_WALLET_ADDRESS`. Simulation fails closed unless the backend explicitly returns a success flag. Atomic dual-leg broadcast also fails closed unless the backend explicitly acknowledges the submitted bundle as atomic/all-or-nothing. Serial dual-leg fallback is disabled unless `ONCHAINOS_ALLOW_SERIAL_DUAL_LEG=true`; enabling it accepts partial-fill and hedge risk.

```bash
# Switch to paper
curl -X POST http://localhost:3000/api/v1/engine/mode \
  -H 'Content-Type: application/json' -d '{"mode":"paper"}'

# Switch to live (requires LIVE_ENABLED=true in .env)
curl -X POST http://localhost:3000/api/v1/engine/mode \
  -H 'Content-Type: application/json' -d '{"mode":"live"}'
```

**Auto-promotion**: if `AUTO_PROMOTE_TO_LIVE=true`, the engine automatically promotes from paper to live when all gate conditions pass (see Risk & Circuit Breakers below).

---

## 5. Strategy Tuning

The current execution stack supports strategy profiles with variant switching:

```bash
# Set variant B with custom parameters
curl -X POST http://localhost:3000/api/v1/strategies/profile \
  -H 'Content-Type: application/json' \
  -d '{"strategyId":"dex-arbitrage","variant":"B","params":{"notionalMultiplier":1.25,"minNetEdgeBpsPaper":35}}'

# View current profiles
curl http://localhost:3000/api/v1/strategies/profiles
```

**Variant A** (default): conservative baseline.
**Variant B**: tunable — adjust `notionalMultiplier`, `minNetEdgeBpsPaper`, etc.

You can also set defaults in `.env`:

```bash
STRATEGY_PROFILE_DEFAULTS={"dex-arbitrage":{"variant":"A","notionalMultiplier":1}}
```

---

## 6. Risk & Circuit Breakers

### Live Gate (promotion conditions)

The engine only promotes to live when ALL conditions pass:

| Condition | Default |
|-----------|---------|
| `LIVE_ENABLED` | `true` |
| 24h simulation net PnL | > 0 |
| 24h simulation win rate | ≥ 55% |
| Consecutive failures | < `MAX_CONSECUTIVE_FAILURES` (3) |
| 24h permission failures | = 0 |
| 24h reject rate | ≤ dynamic threshold (~40%) |
| 24h avg latency | ≤ dynamic threshold (~3500ms) |
| 24h avg slippage deviation | ≤ dynamic threshold (~45bps) |

Thresholds are **dynamically adjusted** based on market stress (volatility, gas, liquidity).

### Circuit Breaker (auto-degrade to paper)

Triggers when ANY condition fires:

| Trigger | Default |
|---------|---------|
| Consecutive failures | ≥ `MAX_CONSECUTIVE_FAILURES` (3) |
| Daily loss | > `MAX_DAILY_LOSS_PCT` × balance (1.5%) |
| Permission failures (24h) | ≥ 2 |
| Reject rate (24h) | > dynamic threshold (~60%) |
| Avg latency (24h) | > dynamic threshold (~5000ms) |
| Avg slippage deviation (24h) | > dynamic threshold (~80bps) |

When triggered, the engine automatically degrades to paper mode and emits an alert.

---

## 7. Data Export

### One-Click Demo (recommended for first run)

```bash
# Start the service first: npm run dev
npm run demo:run
```

Outputs to `demo-output/`:
- `demo-YYYYMMDD-HHMMSS.json` — metrics, strategies, share report, moments, replay
- `backtest-YYYYMMDD-HHMMSS.csv` — historical data in CSV

### Manual Export

```bash
# Backtest snapshot (JSON)
curl http://localhost:3000/api/v1/backtest/snapshot?hours=24&format=json

# Backtest snapshot (CSV)
curl http://localhost:3000/api/v1/backtest/snapshot?hours=24&format=csv -o backtest.csv

# Battle report
curl http://localhost:3000/api/v1/growth/share/latest

# Sandbox replay (re-run under different params)
curl -X POST http://localhost:3000/api/v1/replay/sandbox \
  -H 'Content-Type: application/json' \
  -d '{"seed":"test-1","hours":24,"mode":"paper","strategyId":"dex-arbitrage"}'
```

### Discovery Engine

```bash
# Start a discovery session
curl -X POST http://localhost:3000/api/v1/discovery/sessions/start \
  -H 'Content-Type: application/json' \
  -d '{"strategyId":"spread-threshold","pairs":["ETH/USDC"],"durationMinutes":30}'

# Check active sessions
curl http://localhost:3000/api/v1/discovery/sessions/active

# View candidates
curl http://localhost:3000/api/v1/discovery/sessions/<sessionId>/candidates

# View report
curl http://localhost:3000/api/v1/discovery/sessions/<sessionId>/report

# Or use the discovery smoke script
npm run discovery:smoke
```

---

## 8. Execution Backend Probe

Verify the full v6 execution path is healthy:

```bash
curl -X POST http://localhost:3000/api/v1/integration/execution/probe \
  -H 'Content-Type: application/json' \
  -d '{"pair":"ETH/USDC","chainIndex":"196","notionalUsd":25,"userWalletAddress":"0x..."}'
```

Returns readiness level: `ready` / `degraded` / `unavailable`, with per-path status for quote, swap, simulate, and broadcast.

---

## 9. Database

All state is stored in SQLite (zero-config, embedded):

| File | Contents |
|------|----------|
| `data/alpha.db` | Opportunities, trades, simulations, PnL, alerts, strategies, discovery |
| `data/vault.db` | Encrypted secrets (wallet keys, API tokens) |

No external database required. Data persists across restarts.

---

## Quick Reference

| Task | Command |
|------|---------|
| Start engine | `npm run dev` |
| Open dashboard | `http://localhost:3000/demo` |
| Run full demo | `npm run demo:run` |
| Run discovery smoke | `npm run discovery:smoke` |
| Live smoke test | `npm run demo:smoke:live` |
| Switch to paper | `curl -X POST localhost:3000/api/v1/engine/mode -d '{"mode":"paper"}'` |
| Today's metrics | `curl localhost:3000/api/v1/metrics/today` |
| Export CSV | `curl localhost:3000/api/v1/backtest/snapshot?hours=24&format=csv` |
| Battle report | `curl localhost:3000/api/v1/growth/share/latest` |
| Probe execution backend | `curl -X POST localhost:3000/api/v1/integration/execution/probe -d '{"pair":"ETH/USDC","chainIndex":"196","notionalUsd":25}'` |
