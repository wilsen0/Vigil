---
name: alphaos
description: Plugin-based DEX arbitrage engine with scan/evaluate/simulate/execute/record/notify workflow, SQLite state tracking, AES-256 vault, and current execution-backend integration. Use when implementing strategy plugins, risk gating, execution mode transitions (paper/live), cost modeling, growth telemetry, or operating the arbitrage runtime. For agent-to-agent communication see the agent-comm skill. For opportunity scanning see the discovery skill.
---

# AlphaOS Skill

Core arbitrage engine. Runs a tick loop that scans DEX quotes, evaluates spread opportunities through strategy plugins, simulates execution, and records results. Integrates with the current execution backend for live execution.

## Related Skills

- **agent-comm** — P2P encrypted messaging, identity, contact cards, connection handshake
- **discovery** — multi-strategy opportunity scanning sessions with reports

## Code Location

- `src/skills/alphaos/engine/alpha-engine.ts` — orchestrator, tick loop, mode gates
- `src/skills/alphaos/plugins/dex-arbitrage.ts` — DEX spread strategy plugin
- `src/skills/alphaos/types.ts` — all shared types
- `src/skills/alphaos/api/server.ts` — HTTP API, demo page, SSE stream
- `src/skills/alphaos/runtime/` — supporting services:
  - `state-store.ts` — SQLite persistence (trades, opportunities, strategies, profiles, outbox)
  - `vault.ts` — AES-256-GCM + PBKDF2 secret storage
  - `onchainos-client.ts` — execution-backend adapter (quote → swap → simulate → broadcast)
  - `risk-engine.ts` — risk policy enforcement
  - `simulator.ts` — pre-execution simulation
  - `cost-model.ts` — fee/slippage/MEV/gas cost estimation
  - `notifier.ts` — OpenClaw webhook delivery
  - `config.ts` — env-based configuration
  - `network-profile.ts` / `network-profile-probe.ts` — execution readiness assessment
  - `logger.ts` — structured logging (pino)
  - `time.ts` — time utilities
- `src/skills/alphaos/living-assistant/` — proactive notification system:
  - `contact-policy/` — 3-level decision engine (`log` / `notify` / `call`)
  - `delivery/` — Telegram + Aliyun voice call sender, callback handler
  - `voice-brief/` — voice brief generation (template + LLM natural language)
  - `llm/` — LLM client (DashScope/Qwen) for brief generation
  - `digest-batching/` — low-priority signal batching scheduler
  - `signal-radar/` — Binance announcement / Square pollers
  - `tts/` — TTS providers (CosyVoice, DashScope Qwen, OpenAI-compatible)
  - `loop.ts` — main orchestration loop (policy → brief → TTS → delivery)

## Engine Tick Loop

```
scan → evaluate → plan → simulate → execute → record → notify
```

1. **scan** — plugin fetches quotes from two DEXes, identifies spread
2. **evaluate** — plugin applies strategy logic, accepts/rejects opportunity
3. **plan** — plugin outputs execution plan with bounded notional
4. **simulate** — simulator validates plan against risk policy
5. **execute** — paper: record virtual trade / live: execution-backend broadcast
6. **record** — persist trade + PnL to SQLite
7. **notify** — fire OpenClaw webhook with trade summary

## Plugin Contract

```typescript
interface StrategyPlugin {
  id: string;
  scan(ctx: ScanContext): Promise<Opportunity[]>;
  evaluate(opp: Opportunity): EvaluationResult;
  plan(opp: Opportunity): ExecutionPlan;
}
```

Plugins live in `src/skills/alphaos/plugins/`. Currently: `dex-arbitrage.ts`.

## Execution Modes

| Mode | Behavior |
|------|----------|
| `paper` | Virtual execution, no on-chain tx, full PnL tracking |
| `live` | Real execution-backend flow (quote → swap → simulate → broadcast) |

### Live Gate (paper → live promotion)

Automatic promotion requires all conditions met in trailing 24h:
- Net profit > 0
- Win rate ≥ 55%
- Permission failures = 0
- Reject rate, latency, slippage within dynamic thresholds

## Execution Backend Integration

Prefer official v6 flow: `quote → swap → simulate → broadcast → history`.

- Controlled fallback on `404/405` only when compat mode enabled
- If simulate/broadcast is permission-limited, degrade to `paper` + emit risk alert
- Validate connectivity: `POST /api/v1/integration/execution/probe` (legacy onchainos path still works)

## API Endpoints

### Engine Control
```
GET  /api/v1/status              — engine status + mode
POST /api/v1/mode                — switch paper/live
GET  /api/v1/opportunities       — recent opportunities
GET  /api/v1/trades              — trade history
```

### Strategy Profiles
```
GET  /api/v1/strategies/profile  — current tuning profile
POST /api/v1/strategies/profile  — update A/B tuning params
```

### Growth & Distribution
```
GET  /api/v1/growth/moments      — auto-generated shareable content
GET  /api/v1/growth/share/latest — battle report export
GET  /api/v1/stream/metrics      — SSE real-time stream
```

### Backtest & Replay
```
GET  /api/v1/backtest/snapshot   — export historical data (JSON/CSV)
POST /api/v1/replay/sandbox      — deterministic risk replay
```

### Discovery Pipeline
```
GET  /api/v1/discovery/sessions              — list all sessions (history)
GET  /api/v1/discovery/sessions/:id/pipeline  — candidates + trade results
GET  /api/v1/discovery/sessions/:id/report    — full report (summary + charts)
POST /api/v1/discovery/sessions/:id/approve   — approve → simulate → execute
```

### Living Assistant
```
POST /api/v1/living-assistant/evaluate        — evaluate signal → decision + brief
GET  /api/v1/living-assistant/demo/:scenario  — run demo scenario
GET  /api/v1/living-assistant/digest/status   — digest queue status
POST /api/v1/living-assistant/digest/flush    — flush digest queue
```

### Execution Backend Health
```
POST /api/v1/integration/execution/probe — execution path health check
```

### Demo
```
GET  /demo                       — built-in browser dashboard (SSE-powered)
```

## State & Security

- Business state: `data/alpha.db` (SQLite)
- Vault secrets: `data/vault.db` (AES-256-GCM + PBKDF2-HMAC-SHA256)
- Token cache: `token_cache` table in alpha.db

```bash
# Store a secret
VAULT_MASTER_PASSWORD=xxx npx tsx src/index.ts vault:set <alias> <value>

# Retrieve a secret
VAULT_MASTER_PASSWORD=xxx npx tsx src/index.ts vault:get <alias>
```

## Notifications

OpenClaw webhook format:
```
[alphaos][{mode}][{level}] {event} pair={pair} net={netUsd} tx={txHash|na}
```

## Living Assistant

Proactive notification system. Monitors BNB ecosystem signals (Binance announcements, Square posts) and decides whether/how to interrupt the user.

### 3-Level Attention Model

| Level | Channel | Trigger |
|-------|---------|---------|
| `log` | none (silent) | Low/medium urgency, not on watchlist, quiet hours, rate limited |
| `notify` | Telegram text/voice | High urgency + relevant, or critical + not relevant |
| `call` | Aliyun phone + Telegram urgent + inline buttons | Critical urgency + relevant (or `allowCallEscalation`) |

Built-in quiet hours degradation (default 23:00–08:00), rate limiting (max 3/hour, 12/day), and watchlist relevance matching.

### Delivery Channels

- **Telegram**: text messages, voice messages, inline keyboard buttons (act_now / defer_5m / ignore)
- **Aliyun Voice Call**: TTS phone call for critical escalations

### Data Flow

```
Signal → evaluateContactPolicy → generateNaturalBrief (LLM) → TTS → executeDelivery
                                                    ↓
                                          DigestBatchScheduler (for log-level)
```

## Demo Scripts

```bash
npm run demo:run              # full arbitrage cycle → demo-output/
npm run demo:discovery        # discovery engine demo → demo-output/
npm run demo:smoke:live       # execution-backend integration smoke test
```

## Extension Points

- Add strategy plugins in `src/skills/alphaos/plugins/`
- Add execution-backend adapters in `runtime/onchainos-client.ts`
- Add custom webhook mappers in `runtime/notifier.ts`
- Extend cost model in `runtime/cost-model.ts`

## Docs

- `docs/ALGORITHM.md` — profitability formula, risk gates, circuit breakers (Chinese)
- `docs/ALPHAOS_OPERATIONS.md` — operator runbook
- `docs/JUDGE_ONE_PAGER.md` — one-pager for judges
