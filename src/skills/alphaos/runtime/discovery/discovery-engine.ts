import crypto from "node:crypto";
import type {
  DiscoveryApproveResult,
  DiscoveryCandidate,
  DiscoverySession,
  DiscoverySessionConfig,
  DiscoveryStrategyId,
  ExecutionMode,
  Quote,
} from "../../types";
import { OnchainOsClient } from "../onchainos-client";
import { OpenClawNotifier } from "../notifier";
import { StateStore } from "../state-store";
import { DiscoveryReportBuilder } from "./report-builder";
import { MeanReversionStrategy } from "./strategies/mean-reversion";
import { SpreadThresholdStrategy } from "./strategies/spread-threshold";
import type { DiscoveryStrategy } from "./strategies/types";
import { mean, stdDev } from "./strategies/types";
import { VolatilityBreakoutStrategy } from "./strategies/volatility-breakout";

export interface DiscoveryStartRequest {
  strategyId: DiscoveryStrategyId;
  pairs: string[];
  durationMinutes?: number;
  sampleIntervalSec?: number;
  topN?: number;
}

export interface DiscoveryEngineOptions {
  dexes: [string, string];
  defaultDurationMinutes: number;
  defaultSampleIntervalSec: number;
  defaultTopN: number;
  lookbackSamples: number;
  zEnter: number;
  volRatioMin: number;
  minSpreadBps: number;
  notionalUsd: number;
  takerFeeBps: number;
  slippageBps: number;
  mevPenaltyBps: number;
  gasUsdDefault: number;
}

type CandidateExecutor = (
  candidate: DiscoveryCandidate,
  mode: ExecutionMode,
) => Promise<Omit<DiscoveryApproveResult, "approved" | "sessionId" | "candidateId" | "mode">>;

function ensureValidStrategyId(input: string): DiscoveryStrategyId | null {
  if (input === "spread-threshold" || input === "mean-reversion" || input === "volatility-breakout") {
    return input;
  }
  return null;
}

function parseErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "internal";
  }
  const maybeCode = (error as { code?: string }).code;
  if (typeof maybeCode === "string") {
    return maybeCode;
  }
  return "internal";
}

function normalizePairs(pairs: string[]): string[] {
  return [...new Set(pairs.map((pair) => String(pair).trim().toUpperCase()).filter(Boolean))];
}

function midpoint(quote: Quote): number {
  return (quote.bid + quote.ask) / 2;
}

function calculateSpreadBps(buyAsk: number, sellBid: number): number {
  if (!Number.isFinite(buyAsk) || !Number.isFinite(sellBid) || buyAsk <= 0 || sellBid <= 0) {
    return 0;
  }
  return ((sellBid - buyAsk) / buyAsk) * 10_000;
}

function createConfig(options: DiscoveryEngineOptions, request: DiscoveryStartRequest): DiscoverySessionConfig {
  return {
    strategyId: request.strategyId,
    pairs: normalizePairs(request.pairs),
    durationMinutes: Math.max(1, Math.min(24 * 60, Math.floor(request.durationMinutes ?? options.defaultDurationMinutes))),
    sampleIntervalSec: Math.max(2, Math.min(600, Math.floor(request.sampleIntervalSec ?? options.defaultSampleIntervalSec))),
    topN: Math.max(1, Math.min(200, Math.floor(request.topN ?? options.defaultTopN))),
    lookbackSamples: options.lookbackSamples,
    zEnter: options.zEnter,
    volRatioMin: options.volRatioMin,
    minSpreadBps: options.minSpreadBps,
    notionalUsd: options.notionalUsd,
  };
}

export class DiscoveryEngine {
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private readonly reportBuilder: DiscoveryReportBuilder;
  private readonly strategies: Record<DiscoveryStrategyId, DiscoveryStrategy>;

  constructor(
    private readonly store: StateStore,
    private readonly onchain: OnchainOsClient,
    private readonly notifier: OpenClawNotifier,
    private readonly options: DiscoveryEngineOptions,
    private readonly executeCandidate: CandidateExecutor,
  ) {
    this.reportBuilder = new DiscoveryReportBuilder(store);
    this.strategies = {
      "spread-threshold": new SpreadThresholdStrategy(),
      "mean-reversion": new MeanReversionStrategy(),
      "volatility-breakout": new VolatilityBreakoutStrategy(),
    };
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  getActiveSession(): DiscoverySession | null {
    return this.store.getActiveDiscoverySession();
  }

  getSession(sessionId: string): DiscoverySession | null {
    return this.store.getDiscoverySession(sessionId);
  }

  listCandidates(sessionId: string, limit: number): DiscoveryCandidate[] {
    return this.store.listDiscoveryCandidates(sessionId, limit);
  }

  getReport(sessionId: string) {
    return this.store.getDiscoveryReport(sessionId);
  }

  async startSession(request: DiscoveryStartRequest): Promise<DiscoverySession> {
    const strategyId = ensureValidStrategyId(String(request.strategyId));
    if (!strategyId) {
      const error = new Error("invalid strategyId");
      (error as { code?: string }).code = "invalid_strategy";
      throw error;
    }
    const active = this.store.getActiveDiscoverySession();
    if (active) {
      const error = new Error("an active discovery session already exists");
      (error as { code?: string }).code = "session_conflict";
      throw error;
    }

    const config = createConfig(this.options, { ...request, strategyId });
    if (config.pairs.length === 0) {
      const error = new Error("pairs must contain at least one item");
      (error as { code?: string }).code = "invalid_pairs";
      throw error;
    }

    const startedAt = new Date().toISOString();
    const plannedEndAt = new Date(Date.now() + config.durationMinutes * 60_000).toISOString();
    const session = this.store.insertDiscoverySession({
      strategyId,
      pairs: config.pairs,
      config,
      startedAt,
      plannedEndAt,
    });

    await this.notifier.publish({
      mode: "paper",
      level: "info",
      event: "discovery_started",
      strategyId,
      sessionId: session.id,
      detail: `pairs=${config.pairs.length} durationMin=${config.durationMinutes}`,
    });

    return session;
  }

  async stopSession(sessionId: string): Promise<DiscoverySession> {
    const session = this.store.getDiscoverySession(sessionId);
    if (!session) {
      const error = new Error("session not found");
      (error as { code?: string }).code = "not_found";
      throw error;
    }
    if (session.status !== "active") {
      return session;
    }

    const endedAt = new Date().toISOString();
    const stopped = this.store.updateDiscoverySessionStatus(session.id, "stopped", endedAt);
    await this.finalizeSession(stopped);
    return stopped;
  }

  async approveCandidate(sessionId: string, candidateId: string, mode: ExecutionMode): Promise<DiscoveryApproveResult> {
    const session = this.store.getDiscoverySession(sessionId);
    if (!session) {
      const error = new Error("session not found");
      (error as { code?: string }).code = "not_found";
      throw error;
    }
    if (session.status === "active") {
      const error = new Error("session still active");
      (error as { code?: string }).code = "session_active";
      throw error;
    }
    const candidate = this.store.getDiscoveryCandidate(sessionId, candidateId);
    if (!candidate) {
      const error = new Error("candidate not found");
      (error as { code?: string }).code = "candidate_not_found";
      throw error;
    }
    if (candidate.status !== "pending") {
      const error = new Error(`candidate status ${candidate.status} cannot be approved`);
      (error as { code?: string }).code = "candidate_not_pending";
      throw error;
    }

    const approvedAt = new Date().toISOString();
    this.store.updateDiscoveryCandidateStatus(candidate.id, "approved", approvedAt);
    await this.notifier.publish({
      mode,
      level: "info",
      event: "discovery_candidate_approved",
      strategyId: candidate.strategyId,
      pair: candidate.pair,
      sessionId,
      candidateId,
      detail: `score=${candidate.score.toFixed(2)}`,
    });

    try {
      const execution = await this.executeCandidate(candidate, mode);
      const nextStatus = execution.tradeResult.success ? "executed" : "failed";
      this.store.updateDiscoveryCandidateExecution(candidate.id, nextStatus, execution.tradeId);
      await this.notifier.publish({
        mode: execution.effectiveMode,
        level: execution.tradeResult.success ? "info" : "warn",
        event: execution.tradeResult.success ? "discovery_candidate_executed" : "discovery_candidate_failed",
        strategyId: candidate.strategyId,
        pair: candidate.pair,
        sessionId,
        candidateId,
        txHash: execution.tradeResult.txHash,
        netUsd: execution.tradeResult.netUsd,
      });
      return {
        approved: true,
        sessionId,
        candidateId,
        mode,
        ...execution,
      };
    } catch (error) {
      this.store.updateDiscoveryCandidateExecution(candidate.id, "failed");
      await this.notifier.publish({
        mode,
        level: "error",
        event: "discovery_candidate_failed",
        strategyId: candidate.strategyId,
        pair: candidate.pair,
        sessionId,
        candidateId,
        detail: String(error),
      });
      throw error;
    }
  }

  private async tick(): Promise<void> {
    if (this.sampling) {
      return;
    }

    const active = this.store.getActiveDiscoverySession();
    if (!active) {
      return;
    }
    if (Date.now() >= Date.parse(active.plannedEndAt)) {
      this.store.updateDiscoverySessionStatus(active.id, "completed", new Date().toISOString());
      await this.finalizeSession(this.store.getDiscoverySession(active.id) ?? active);
      return;
    }

    const latestSampleAt = this.store.getLatestDiscoverySampleTs(active.id);
    const intervalMs = Math.max(2_000, active.config.sampleIntervalSec * 1000);
    if (latestSampleAt) {
      const diff = Date.now() - Date.parse(latestSampleAt);
      if (Number.isFinite(diff) && diff < intervalMs) {
        return;
      }
    }

    this.sampling = true;
    try {
      const created = await this.collectSessionSample(active);
      await this.notifier.publish({
        mode: "paper",
        level: "info",
        event: "discovery_progress",
        strategyId: active.strategyId,
        sessionId: active.id,
        detail: `pairs=${active.pairs.length} newCandidates=${created}`,
      });
    } catch (error) {
      this.store.insertAlert("error", "discovery_tick_failed", String(error));
      this.store.updateDiscoverySessionStatus(active.id, "failed", new Date().toISOString());
      await this.finalizeSession(this.store.getDiscoverySession(active.id) ?? active);
    } finally {
      this.sampling = false;
    }
  }

  private async collectSessionSample(session: DiscoverySession): Promise<number> {
    const strategy = this.strategies[session.strategyId];
    const lookback = Math.max(5, session.config.lookbackSamples);
    let createdCandidates = 0;

    for (const pair of session.pairs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let quotes: any[];
      try {
        quotes = await this.onchain.getQuotes(pair, this.options.dexes);
      } catch (pairError) {
        this.store.insertAlert("warn", "discovery_pair_skip", `pair=${pair} ${pairError}`);
        continue;
      }
      if (quotes.length < 2) {
        continue;
      }

      const quoteA = quotes.find((quote) => quote.dex === this.options.dexes[0]) ?? quotes[0];
      const quoteB = quotes.find((quote) => quote.dex === this.options.dexes[1]) ?? quotes[1];
      if (!quoteA || !quoteB) {
        continue;
      }

      const bestBuy = [...quotes].sort((left, right) => left.ask - right.ask)[0];
      const bestSell = [...quotes].sort((left, right) => right.bid - left.bid)[0];
      if (!bestBuy || !bestSell || bestBuy.ask <= 0 || bestSell.bid <= 0 || bestBuy.dex === bestSell.dex) {
        continue;
      }

      const spreadBps = calculateSpreadBps(bestBuy.ask, bestSell.bid);
      const history = this.store.listRecentDiscoverySamples(session.id, pair, lookback);
      const historySpreads = history.map((sample) => sample.spreadBps);
      const volatility = stdDev([...historySpreads, spreadBps]);
      const baseline = historySpreads.length > 0 ? historySpreads : [spreadBps];
      const avg = mean(baseline);
      const sigma = stdDev(baseline);
      const zScore = sigma > 0 ? (spreadBps - avg) / sigma : 0;
      const ts = new Date().toISOString();

      this.store.insertDiscoverySample({
        sessionId: session.id,
        pair,
        ts,
        dexAMid: midpoint(quoteA),
        dexBMid: midpoint(quoteB),
        spreadBps,
        volatility,
        zScore,
        features: {
          dexA: quoteA.dex,
          dexB: quoteB.dex,
          quoteCount: quotes.length,
          bestBuyDex: bestBuy.dex,
          bestSellDex: bestSell.dex,
          bestBuyAsk: bestBuy.ask,
          bestSellBid: bestSell.bid,
        },
      });

      const dynamicThresholdBps = this.calculateDynamicThresholdBps(session.config.notionalUsd);
      const expectedNetBpsBase = spreadBps - dynamicThresholdBps;
      const expectedNetUsdBase = (session.config.notionalUsd * expectedNetBpsBase) / 10_000;
      const candidate = strategy.evaluate({
        pair,
        sessionId: session.id,
        strategyId: session.strategyId,
        ts,
        config: session.config,
        quotes,
        historySpreads,
        spreadBps,
        dynamicThresholdBps,
        expectedNetBpsBase,
        expectedNetUsdBase,
      });
      if (!candidate || candidate.score <= 0) {
        continue;
      }

      this.store.insertDiscoveryCandidate({
        ...candidate,
        input: {
          ...(candidate.input ?? {}),
          notionalUsd: session.config.notionalUsd,
        },
      });
      createdCandidates += 1;
    }

    return createdCandidates;
  }

  private calculateDynamicThresholdBps(notionalUsd: number): number {
    const feeBps = Math.max(0, this.options.takerFeeBps) * 2;
    const slippageBps = Math.max(0, this.options.slippageBps) * 2;
    const mevBps = Math.max(0, this.options.mevPenaltyBps);
    const safeNotional = Math.max(1, notionalUsd);
    const gasUsd = Math.max(0, this.options.gasUsdDefault) * 2;
    const gasBps = (gasUsd / safeNotional) * 10_000;
    const bufferBps = 5;
    return feeBps + slippageBps + mevBps + gasBps + bufferBps;
  }

  private async finalizeSession(session: DiscoverySession): Promise<void> {
    const latest = this.store.getDiscoverySession(session.id);
    if (!latest) {
      return;
    }
    const report = this.reportBuilder.build({
      session: latest,
      topN: latest.config.topN,
    });
    this.store.upsertDiscoveryReport(latest.id, report, report.generatedAt);
    this.store.updateDiscoverySessionSummary(latest.id, report.summary);
    await this.notifier.publish({
      mode: "paper",
      level: "info",
      event: "discovery_report_ready",
      strategyId: latest.strategyId,
      sessionId: latest.id,
      detail: `candidates=${report.summary.candidates} topPair=${report.summary.topPair ?? "na"}`,
    });
  }

  static errorCode(error: unknown): string {
    return parseErrorCode(error);
  }
}
