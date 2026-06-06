# Arbitrage Production Hardening Plan

## Objective

Make the arbitrage module fail closed in production. Demo data, mock trades, compatibility fallbacks, and serial dual-leg execution must not be implicit defaults. Live execution must have a single clear path with explicit operator configuration and backend acknowledgements.

## Execution Chain Target

The production chain is:

1. Fetch fresh quotes from the configured execution backend.
2. Detect a spread only when buy ask and sell bid are both current.
3. Re-price both legs using route-constrained v6 quote calls.
4. Build both swaps for the configured live wallet.
5. Simulate both swaps when `ONCHAINOS_REQUIRE_SIMULATE=true`.
6. Broadcast both legs as one atomic bundle.
7. Require explicit backend acknowledgement that the bundle is atomic/all-or-nothing.
8. Reconcile settlement from history when available and account PnL conservatively.

## Phase 1: Production Boundaries

Status: implemented.

- `ONCHAINOS_API_BASE` is required for quote retrieval and live execution.
- Mock quotes and mock trade results are not synthesized by `OnchainOsClient`.
- Legacy endpoint compatibility fallback defaults to disabled.
- Live execution requires a real wallet through `ONCHAINOS_USER_WALLET_ADDRESS` or `plan.metadata.userWalletAddress`.
- Dummy, zero, and invalid wallet addresses are rejected before any backend call.
- Serial dual-leg fallback is disabled unless `ONCHAINOS_ALLOW_SERIAL_DUAL_LEG=true`.

## Phase 2: Fail-Closed Execution Semantics

Status: implemented.

- Simulation results default to failed unless the backend explicitly returns `success`, `simulateResult`, or `ok`.
- Atomic bundle broadcasts must include an explicit atomic acknowledgement such as `atomic=true`, `allOrNothing=true`, or an accepted atomic status.
- Missing atomic acknowledgement is treated as validation failure and does not silently continue into serial execution.
- Route-constrained quote responses are validated against the planned buy and sell DEX.
- Token profile cache misses and expired cache entries fail closed if remote token profile retrieval fails.

## Phase 3: Profitability Controls

Status: implemented with remaining settlement work.

- Detection uses gross edge from live buy/sell quotes.
- Simulation and execution PnL use a conservative cost model: taker fees, gas, slippage, latency, liquidity, volatility, and MEV penalty.
- Notional is capped by risk policy and current mode balance.
- Engine live gate and circuit breaker block promotion or degrade to paper after unhealthy execution behavior.

Remaining work:

- Replace quote-derived settlement estimates with canonical filled amounts from backend history wherever supported.
- Add explicit allowance, balance, nonce, and deadline checks before swap build.
- Add per-leg revert reason capture and persisted execution traces.
- Add a settlement reconciliation job that compares stored PnL with final chain/backend state after delayed finality.

## Phase 4: Operator Configuration

Status: implemented.

Required production variables:

- `ONCHAINOS_API_BASE`
- `ONCHAINOS_API_KEY`
- `ONCHAINOS_API_SECRET`
- `ONCHAINOS_PASSPHRASE`
- `ONCHAINOS_PROJECT_ID`
- `ONCHAINOS_USER_WALLET_ADDRESS`

Production defaults:

- `ONCHAINOS_REQUIRE_SIMULATE=true`
- `ONCHAINOS_ENABLE_COMPAT_FALLBACK=false`
- `ONCHAINOS_ALLOW_SERIAL_DUAL_LEG=false`

## Validation Checklist

- `npm test -- tests/onchain-client.test.ts tests/config.test.ts`
- `npm run build`
- Probe execution backend with a real wallet configured.
- Confirm bundle broadcast response includes an explicit atomic acknowledgement.
- Confirm live mode cannot be entered without the configured live gate passing.
