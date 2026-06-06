import crypto from "node:crypto";
import type { Logger } from "pino";
import type {
  DiscoveryApproveResult,
  DiscoveryCandidate,
  EngineModeResponse,
  ExecutionMode,
  GateCheck,
  Opportunity,
  Quote,
  RiskPolicy,
  SimulationResult,
  SkillManifest,
  StrategyPlugin,
  TradeResult,
} from "../types";
import { MarketWatch } from "../runtime/market-watch";
import { Simulator } from "../runtime/simulator";
import { RiskEngine } from "../runtime/risk-engine";
import { StateStore } from "../runtime/state-store";
import { OpenClawNotifier } from "../runtime/notifier";
import { OnchainOsClient } from "../runtime/onchainos-client";

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

interface EngineOptions {
  intervalMs: number;
  pair: string;
  dexes: [string, string];
  startMode: ExecutionMode;
  liveEnabled: boolean;
  autoPromoteToLive: boolean;
  quoteStaleMs?: number;
  opportunityDedupTtlMs?: number;
  opportunityDedupMinEdgeDeltaBps?: number;
  paperStartingBalanceUsd: number;
  liveBalanceUsd: number;
  riskPolicy: RiskPolicy;
}

interface ExecutionPlanInput {
  opportunityId: string;
  strategyId: string;
  pair: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  notionalUsd: number;
  metadata?: Record<string, unknown>;
}

interface TradeExecutor {
  execute(
    mode: ExecutionMode,
    plan: ExecutionPlanInput,
    simulation: SimulationResult,
  ): Promise<{
    success: boolean;
    txHash: string;
    status: "submitted" | "confirmed" | "failed";
    grossUsd: number;
    feeUsd: number;
    netUsd: number;
    error?: string;
    errorType?: "permission_denied" | "whitelist_restricted" | "network" | "validation" | "config_error" | "unknown";
    latencyMs?: number;
    slippageDeviationBps?: number;
  }>;
}

class DefaultExecutor implements TradeExecutor {
  constructor(private readonly client: OnchainOsClient) {}

  async execute(
    mode: ExecutionMode,
    plan: ExecutionPlanInput,
    simulation: SimulationResult,
  ) {
    if (mode === "paper") {
      return {
        success: true,
        txHash: `paper-${plan.opportunityId}`,
        status: "confirmed" as const,
        grossUsd: simulation.grossUsd,
        feeUsd: simulation.feeUsd,
        netUsd: simulation.netUsd,
      };
    }

    return this.client.executePlan(plan);
  }
}

export class AlphaEngine {
  private mode: ExecutionMode;
  private desiredMode: ExecutionMode;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private circuitBreakerUntil = 0;
  private readonly quoteStaleMs: number;
  private readonly opportunityDedupTtlMs: number;
  private readonly opportunityDedupMinEdgeDeltaBps: number;
  private readonly recentOpportunityKeys = new Map<string, { seenAtMs: number; grossEdgeBps: number }>();

  constructor(
    private readonly manifest: SkillManifest,
    private readonly plugins: StrategyPlugin[],
    private readonly options: EngineOptions,
    private readonly logger: Logger,
    private readonly marketWatch: MarketWatch,
    private readonly simulator: Simulator,
    private readonly riskEngine: RiskEngine,
    private readonly store: StateStore,
    private readonly notifier: OpenClawNotifier,
    private readonly executor: TradeExecutor,
  ) {
    this.mode = options.startMode;
    this.desiredMode = options.liveEnabled ? "live" : options.startMode;
    this.quoteStaleMs = Math.max(1, Math.floor(options.quoteStaleMs ?? 1000));
    this.opportunityDedupTtlMs = Math.max(
      0,
      Math.floor(options.opportunityDedupTtlMs ?? Math.max(options.intervalMs, 1000)),
    );
    this.opportunityDedupMinEdgeDeltaBps = Math.max(
      0,
      options.opportunityDedupMinEdgeDeltaBps ?? 2,
    );
    this.store.ensureBalanceBaseline("paper", options.paperStartingBalanceUsd);
    this.store.ensureBalanceBaseline("live", options.liveBalanceUsd);
  }

  static withDefaultExecutor(
    manifest: SkillManifest,
    plugins: StrategyPlugin[],
    options: EngineOptions,
    logger: Logger,
    marketWatch: MarketWatch,
    simulator: Simulator,
    riskEngine: RiskEngine,
    store: StateStore,
    notifier: OpenClawNotifier,
    onchainClient: OnchainOsClient,
  ): AlphaEngine {
    return new AlphaEngine(
      manifest,
      plugins,
      options,
      logger,
      marketWatch,
      simulator,
      riskEngine,
      store,
      notifier,
      new DefaultExecutor(onchainClient),
    );
  }

  start(): void {
    this.logger.info(
      { skill: this.manifest.id, mode: this.mode, strategies: this.plugins.map((p) => p.id) },
      "alpha engine starting",
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getCurrentMode(): ExecutionMode {
    return this.mode;
  }

  requestMode(mode: ExecutionMode): EngineModeResponse {
    this.desiredMode = mode;
    if (mode === "paper") {
      this.mode = "paper";
      return {
        ok: true,
        requestedMode: mode,
        currentMode: this.mode,
        reasons: [],
      };
    }

    const gate = this.evaluateLiveGate();
    if (!gate.passed) {
      this.mode = "paper";
      return {
        ok: false,
        requestedMode: mode,
        currentMode: this.mode,
        reasons: gate.reasons,
      };
    }

    this.mode = "live";
    return {
      ok: true,
      requestedMode: mode,
      currentMode: this.mode,
      reasons: [],
    };
  }

  async executeApprovedCandidate(
    candidate: DiscoveryCandidate,
    requestedMode: ExecutionMode,
  ): Promise<Omit<DiscoveryApproveResult, "approved" | "sessionId" | "candidateId" | "mode">> {
    const effectiveMode: ExecutionMode =
      requestedMode === "live" && this.options.liveEnabled && this.evaluateLiveGate().passed ? "live" : "paper";
    const degradedToPaper = requestedMode === "live" && effectiveMode === "paper";

    const quotes = this.filterFreshQuotes(await this.marketWatch.fetch(candidate.pair, [candidate.buyDex, candidate.sellDex]));
    const buyQuote = quotes.find((quote) => quote.dex === candidate.buyDex && quote.pair === candidate.pair);
    const sellQuote = quotes.find((quote) => quote.dex === candidate.sellDex && quote.pair === candidate.pair);

    if (!buyQuote || !sellQuote || buyQuote.ask <= 0 || sellQuote.bid <= 0) {
      throw new Error(`missing fresh quotes for candidate ${candidate.id}`);
    }

    const balance = this.store.getCurrentBalance(effectiveMode);
    const maxNotional = this.riskEngine.maxNotional(balance);
    const candidateNotional = asNumber(candidate.input?.notionalUsd);
    const desiredNotional = candidateNotional ?? maxNotional;
    const boundedNotional = Math.max(0, Math.min(desiredNotional, maxNotional));
    if (boundedNotional <= 0) {
      throw new Error(`risk policy blocked execution for candidate ${candidate.id}`);
    }

    const grossEdgeBps = ((sellQuote.bid - buyQuote.ask) / buyQuote.ask) * 10_000;
    const opportunity: Opportunity = {
      id: crypto.randomUUID(),
      strategyId: candidate.strategyId,
      pair: candidate.pair,
      buyDex: candidate.buyDex,
      sellDex: candidate.sellDex,
      buyPrice: buyQuote.ask,
      sellPrice: sellQuote.bid,
      grossEdgeBps,
      detectedAt: new Date().toISOString(),
      metadata: {
        ...(candidate.input ?? {}),
        source: "discovery-approval",
        discoveryCandidateId: candidate.id,
        discoverySessionId: candidate.sessionId,
        confidence: candidate.confidence,
        reason: candidate.reason,
        gasBuyUsd: buyQuote.gasUsd,
        gasSellUsd: sellQuote.gasUsd,
      },
    };

    this.store.insertOpportunity(
      opportunity,
      Math.max(0, buyQuote.gasUsd) + Math.max(0, sellQuote.gasUsd),
      candidate.expectedNetUsd,
      "detected",
    );

    const plan = {
      opportunityId: opportunity.id,
      strategyId: candidate.strategyId,
      pair: candidate.pair,
      buyDex: candidate.buyDex,
      sellDex: candidate.sellDex,
      buyPrice: buyQuote.ask,
      sellPrice: sellQuote.bid,
      notionalUsd: boundedNotional,
      metadata: opportunity.metadata,
    };

    const simulation = this.simulator.estimate(plan, effectiveMode, this.options.riskPolicy);
    this.recordSimulationOutcome(opportunity.id, effectiveMode, plan, simulation);

    if (!simulation.pass) {
      return {
        effectiveMode,
        opportunityId: opportunity.id,
        simulation,
        tradeResult: {
          success: false,
          txHash: "",
          status: "failed",
          grossUsd: simulation.grossUsd,
          feeUsd: simulation.feeUsd,
          netUsd: simulation.netUsd,
          error: simulation.reason,
          errorType: "validation",
        },
        degradedToPaper,
      };
    }

    const trade = await this.executor.execute(effectiveMode, plan, simulation);
    const tradeForStore = this.toTradeForStore(trade, simulation, plan.notionalUsd);

    if (this.shouldDegradeToPaper(effectiveMode, trade)) {
      const degraded = await this.handleLivePermissionDegrade(
        candidate.strategyId,
        opportunity,
        plan,
        simulation,
        trade.errorType,
        trade.error,
      );
      return {
        effectiveMode: "paper",
        opportunityId: opportunity.id,
        simulation,
        tradeResult: degraded.trade,
        degradedToPaper: true,
        tradeId: degraded.tradeId,
      };
    }

    const stored = await this.handleTradeResult(
      candidate.strategyId,
      opportunity,
      effectiveMode,
      trade,
      tradeForStore,
    );
    return {
      effectiveMode,
      opportunityId: opportunity.id,
      simulation,
      tradeResult: trade,
      degradedToPaper,
      tradeId: stored.tradeId,
    };
  }

  private recordSimulationOutcome(
    opportunityId: string,
    mode: ExecutionMode,
    plan: ExecutionPlanInput,
    simulation: SimulationResult,
  ): void {
    this.store.insertSimulation({
      opportunityId,
      mode,
      inputJson: JSON.stringify(plan),
      resultJson: JSON.stringify(simulation),
      createdAt: new Date().toISOString(),
    });
    this.store.updateOpportunityEstimate(
      opportunityId,
      simulation.feeUsd,
      simulation.netUsd,
      simulation.pass ? "planned" : "rejected",
    );
  }

  private toTradeForStore(
    trade: TradeResult,
    simulation: SimulationResult,
    notionalUsd: number,
  ): TradeResult {
    const computedDeviation = this.estimateSlippageDeviationBps(
      trade.success,
      simulation.netUsd,
      trade.netUsd,
      notionalUsd,
    );
    return {
      ...trade,
      slippageDeviationBps: trade.slippageDeviationBps ?? computedDeviation,
    };
  }

  private estimateSlippageDeviationBps(
    tradeSuccess: boolean,
    simulatedNetUsd: number,
    actualNetUsd: number,
    notionalUsd: number,
  ): number | undefined {
    if (!tradeSuccess || notionalUsd <= 0) {
      return undefined;
    }
    return Math.abs(simulatedNetUsd - actualNetUsd) / notionalUsd * 10_000;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.notifier.flushOutbox();

      if (this.isCircuitBreakerActive()) {
        this.mode = "paper";
        return;
      }

      await this.maybePromoteToLive();

      const quotes = await this.marketWatch.fetch(this.options.pair, this.options.dexes);
      const freshQuotes = this.filterFreshQuotes(quotes);
      await this.scanPlugins(freshQuotes);
    } catch (error) {
      this.logger.error({ err: error }, "engine tick failed");
      this.store.insertAlert("error", "engine_tick_failure", String(error));
    } finally {
      this.running = false;
    }
  }

  private async processOpportunity(
    plugin: StrategyPlugin,
    opportunity: Opportunity,
    quotes: Quote[],
  ): Promise<void> {
    const quoteGas = quotes.find((q) => q.dex === opportunity.buyDex)?.gasUsd ?? 1;
    this.store.insertOpportunity(opportunity, quoteGas, 0, "detected");
    await this.notifier.publish({
      mode: this.resolveExecutionMode(),
      level: "info",
      event: "alpha_found",
      pair: opportunity.pair,
      strategyId: plugin.id,
    });

    const balance = this.store.getCurrentBalance(this.mode);
    const evalResult = await plugin.evaluate(opportunity, {
      mode: this.mode,
      quotes,
      nowIso: new Date().toISOString(),
      balanceUsd: balance,
      riskPolicy: this.options.riskPolicy,
    });
    if (!evalResult.accepted) {
      this.store.updateOpportunityStatus(opportunity.id, "rejected");
      return;
    }

    const profile = this.store.getStrategyProfile(plugin.id);
    const rawPlan = await plugin.plan(evalResult, {
      balanceUsd: balance,
      riskPolicy: this.options.riskPolicy,
    });

    if (!rawPlan) {
      this.store.updateOpportunityStatus(opportunity.id, "rejected");
      return;
    }

    const multiplierRaw = asNumber(profile?.params?.notionalMultiplier ?? null) ?? 1;
    const multiplier = clamp(multiplierRaw, 0.2, 2.5);
    const adjustedNotional = rawPlan.notionalUsd * multiplier;
    const boundedNotional = Math.min(adjustedNotional, this.riskEngine.maxNotional(balance));
    if (boundedNotional <= 0) {
      this.store.updateOpportunityStatus(opportunity.id, "rejected");
      return;
    }

    const plan = {
      ...rawPlan,
      notionalUsd: boundedNotional,
      strategyId: rawPlan.strategyId || plugin.id,
      metadata: {
        ...rawPlan.metadata,
        profileVariant: profile?.variant ?? "A",
        profileNotionalMultiplier: multiplier,
      },
    };

    const localRiskPolicy: RiskPolicy = { ...this.options.riskPolicy };
    const overridePaper = asNumber(profile?.params?.minNetEdgeBpsPaper ?? null);
    const overrideLive = asNumber(profile?.params?.minNetEdgeBpsLive ?? null);
    if (overridePaper !== null) {
      localRiskPolicy.minNetEdgeBpsPaper = clamp(overridePaper, 1, 500);
    }
    if (overrideLive !== null) {
      localRiskPolicy.minNetEdgeBpsLive = clamp(overrideLive, 1, 700);
    }

    const simulation = this.simulator.estimate(plan, this.mode, localRiskPolicy);
    this.recordSimulationOutcome(opportunity.id, this.mode, plan, simulation);

    if (!simulation.pass) {
      return;
    }

    const effectiveMode = this.resolveExecutionMode();
    await this.notifier.publish({
      mode: effectiveMode,
      level: "info",
      event: "paper_passed",
      pair: opportunity.pair,
      netUsd: simulation.netUsd,
      strategyId: plugin.id,
    });

    const trade = await this.executor.execute(effectiveMode, plan, simulation);
    const tradeForStore = this.toTradeForStore(trade, simulation, plan.notionalUsd);

    if (this.shouldDegradeToPaper(effectiveMode, trade)) {
      await this.handleLivePermissionDegrade(plugin.id, opportunity, plan, simulation, trade.errorType, trade.error);
      return;
    }

    await this.handleTradeResult(plugin.id, opportunity, effectiveMode, trade, tradeForStore);
  }

  private async maybePromoteToLive(): Promise<void> {
    if (this.desiredMode !== "live" || !this.options.autoPromoteToLive || this.mode === "live") {
      return;
    }

    const gate = this.evaluateLiveGate();
    if (!gate.passed) {
      return;
    }

    this.mode = "live";
    await this.notifier.publish({ mode: "live", level: "info", event: "engine_recovered" });
  }

  private isCircuitBreakerActive(nowMs = Date.now()): boolean {
    return this.circuitBreakerUntil > nowMs;
  }

  private async scanPlugins(quotes: Quote[]): Promise<void> {
    for (const plugin of this.plugins) {
      await this.processPluginScan(plugin, quotes);
    }
  }

  private resolveExecutionMode(): ExecutionMode {
    if (this.mode !== "live") {
      return "paper";
    }
    return this.evaluateLiveGate().passed ? "live" : "paper";
  }

  private filterFreshQuotes(quotes: Quote[]): Quote[] {
    return quotes.filter((quote) => {
      const quoteMs = Date.parse(quote.ts);
      if (!Number.isFinite(quoteMs)) {
        this.store.recordQuoteQuality({ stale: true, latencyMs: null });
        this.store.insertAlert("warn", "stale_quote_engine", `invalid quote ts ${quote.pair}@${quote.dex}`);
        return false;
      }

      const latencyMs = Math.max(0, Date.now() - quoteMs);
      const fresh = latencyMs <= this.quoteStaleMs;
      if (fresh) {
        return true;
      }

      this.store.recordQuoteQuality({ stale: true, latencyMs });
      this.store.insertAlert(
        "warn",
        "stale_quote_engine",
        `stale quote dropped ${quote.pair}@${quote.dex} latencyMs=${latencyMs}`,
      );
      return false;
    });
  }

  private async processPluginScan(plugin: StrategyPlugin, quotes: Quote[]): Promise<void> {
    try {
      const opportunities = await plugin.scan({
        pair: this.options.pair,
        quotes,
        nowIso: new Date().toISOString(),
      });
      for (const opportunity of opportunities) {
        if (this.shouldSkipDuplicateOpportunity(plugin.id, opportunity)) {
          continue;
        }
        await this.processOpportunity(plugin, opportunity, quotes);
      }
    } catch (error) {
      this.logger.error({ err: error, strategy: plugin.id }, "plugin scan failed");
      this.store.insertAlert("error", "plugin_scan_failure", `${plugin.id}: ${String(error)}`);
    }
  }

  private shouldSkipDuplicateOpportunity(strategyId: string, opportunity: Opportunity): boolean {
    if (this.opportunityDedupTtlMs <= 0) {
      return false;
    }

    const nowMs = Date.now();
    this.pruneDedupCache(nowMs);
    const key = this.buildOpportunityDedupKey(strategyId, opportunity, nowMs);
    const existing = this.recentOpportunityKeys.get(key);

    if (
      existing &&
      nowMs - existing.seenAtMs <= this.opportunityDedupTtlMs &&
      Math.abs(existing.grossEdgeBps - opportunity.grossEdgeBps) < this.opportunityDedupMinEdgeDeltaBps
    ) {
      return true;
    }

    this.recentOpportunityKeys.set(key, {
      seenAtMs: nowMs,
      grossEdgeBps: opportunity.grossEdgeBps,
    });
    return false;
  }

  private pruneDedupCache(nowMs: number): void {
    if (this.recentOpportunityKeys.size < 512) {
      return;
    }

    const staleBefore = nowMs - this.opportunityDedupTtlMs * 2;
    for (const [key, value] of this.recentOpportunityKeys) {
      if (value.seenAtMs < staleBefore) {
        this.recentOpportunityKeys.delete(key);
      }
    }
  }

  private buildOpportunityDedupKey(strategyId: string, opportunity: Opportunity, nowMs: number): string {
    const timeBucket =
      this.opportunityDedupTtlMs > 0 ? Math.floor(nowMs / this.opportunityDedupTtlMs) : nowMs;
    const buyBucket = this.toPriceBucket(opportunity.buyPrice);
    const sellBucket = this.toPriceBucket(opportunity.sellPrice);
    return `${strategyId}|${opportunity.pair}|${opportunity.buyDex}|${opportunity.sellDex}|${buyBucket}|${sellBucket}|${timeBucket}`;
  }

  private toPriceBucket(price: number): number {
    if (!Number.isFinite(price) || price <= 0) {
      return 0;
    }
    const step = Math.max(0.000001, price * 0.0005);
    return Math.round(price / step);
  }

  private shouldDegradeToPaper(mode: ExecutionMode, trade: TradeResult): boolean {
    if (mode !== "live" || trade.success) {
      return false;
    }
    return trade.errorType === "permission_denied" || trade.errorType === "whitelist_restricted";
  }

  private async handleLivePermissionDegrade(
    strategyId: string,
    opportunity: Opportunity,
    plan: ExecutionPlanInput,
    simulation: SimulationResult,
    errorType: TradeResult["errorType"],
    errorMessage: string | undefined,
  ): Promise<{ trade: TradeResult; tradeId: string }> {
    this.store.updateOpportunityStatus(opportunity.id, "degraded_to_paper");
    this.store.insertAlert(
      "warn",
      "live_permission_degraded",
      `degraded to paper: ${errorType} ${errorMessage ?? ""}`.trim(),
    );
    await this.notifier.publish({
      mode: "live",
      level: "warn",
      event: "risk_alert",
      pair: opportunity.pair,
      strategyId,
    });

    const paperTrade = await this.executor.execute("paper", plan, simulation);
    const tradeId = this.store.insertTrade(opportunity.id, "paper", paperTrade, new Date().toISOString());
    await this.notifier.publish({
      mode: "paper",
      level: "info",
      event: "trade_executed",
      pair: opportunity.pair,
      netUsd: paperTrade.netUsd,
      txHash: paperTrade.txHash,
      strategyId,
    });
    return {
      trade: paperTrade,
      tradeId,
    };
  }

  private async handleTradeResult(
    strategyId: string,
    opportunity: Opportunity,
    effectiveMode: ExecutionMode,
    trade: TradeResult,
    tradeForStore: TradeResult,
  ): Promise<{ tradeId: string }> {
    const tradeId = this.store.insertTrade(opportunity.id, effectiveMode, tradeForStore, new Date().toISOString());

    if (trade.success) {
      this.consecutiveFailures = 0;
      this.store.updateOpportunityStatus(opportunity.id, "executed");
      await this.notifier.publish({
        mode: effectiveMode,
        level: "info",
        event: "trade_executed",
        pair: opportunity.pair,
        netUsd: trade.netUsd,
        txHash: trade.txHash,
        strategyId,
      });
      await this.maybeTriggerCircuitBreaker(strategyId, opportunity, effectiveMode);
      return { tradeId };
    }

    this.consecutiveFailures += 1;
    this.store.updateOpportunityStatus(opportunity.id, "failed");
    this.store.insertAlert("warn", "trade_failed", trade.error ?? "unknown error");
    await this.notifier.publish({
      mode: effectiveMode,
      level: "error",
      event: "risk_alert",
      pair: opportunity.pair,
      netUsd: trade.netUsd,
      txHash: trade.txHash,
      strategyId,
    });

    await this.maybeTriggerCircuitBreaker(strategyId, opportunity, effectiveMode);
    return { tradeId };
  }

  private async maybeTriggerCircuitBreaker(
    strategyId: string,
    opportunity: Opportunity,
    effectiveMode: ExecutionMode,
  ): Promise<void> {
    const dailyNet = this.store.getTodayNetUsd(effectiveMode);
    const balanceNow = this.store.getCurrentBalance(effectiveMode);
    const quality = this.store.getExecutionQualityStats(24);
    const breakDecision = this.riskEngine.shouldCircuitBreak({
      consecutiveFailures: this.consecutiveFailures,
      dailyNetUsd: dailyNet,
      balanceUsd: balanceNow,
      permissionFailures24h: quality.permissionFailures,
      rejectRate24h: quality.rejectRate,
      avgLatencyMs24h: quality.avgLatencyMs,
      avgSlippageDeviationBps24h: quality.avgSlippageDeviationBps,
    }, this.store.getMarketStateStats(24));
    if (!breakDecision.breakNow) {
      return;
    }

    this.mode = "paper";
    this.circuitBreakerUntil = Date.now() + 5 * 60 * 1000;
    this.store.insertAlert("error", "circuit_breaker", breakDecision.reasons.join("; "));
    await this.notifier.publish({
      mode: "paper",
      level: "error",
      event: "risk_alert",
      pair: opportunity.pair,
      strategyId,
    });
  }

  private evaluateLiveGate(): { passed: boolean; reasons: string[] } {
    const simulationStats = this.store.getSimulationStats(24);
    const quality = this.store.getExecutionQualityStats(24);
    const gateInput: GateCheck = {
      simulationNetUsd24h: simulationStats.netUsd,
      simulationWinRate24h: simulationStats.winRate,
      consecutiveFailures: Math.max(this.consecutiveFailures, this.store.getRecentConsecutiveFailures(3)),
      permissionFailures24h: quality.permissionFailures,
      rejectRate24h: quality.rejectRate,
      avgLatencyMs24h: quality.avgLatencyMs,
      avgSlippageDeviationBps24h: quality.avgSlippageDeviationBps,
      liveEnabled: this.options.liveEnabled,
    };
    return this.riskEngine.canPromoteToLive(gateInput, this.store.getMarketStateStats(24));
  }
}
