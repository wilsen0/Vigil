export type ExecutionMode = "paper" | "live";

export interface RiskPolicy {
  minNetEdgeBpsPaper: number;
  minNetEdgeBpsLive: number;
  maxTradePctBalance: number;
  maxDailyLossPct: number;
  maxConsecutiveFailures: number;
}

export interface Quote {
  pair: string;
  dex: string;
  bid: number;
  ask: number;
  gasUsd: number;
  ts: string;
}

export interface Opportunity {
  id: string;
  strategyId: string;
  pair: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  grossEdgeBps: number;
  detectedAt: string;
  metadata?: Record<string, unknown>;
}

export interface EvalResult {
  accepted: boolean;
  reason: string;
  opportunity: Opportunity;
}

export interface ExecutionPlan {
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

export interface SimulationResult {
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  netEdgeBps: number;
  pFail: number;
  expectedShortfall: number;
  latencyAdjustedNetUsd: number;
  pass: boolean;
  reason: string;
}

export interface TradeResult {
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
}

export interface StrategyPlugin {
  id: string;
  version: string;
  scan(ctx: ScanContext): Promise<Opportunity[]>;
  evaluate(input: Opportunity, ctx: EvalContext): Promise<EvalResult>;
  plan(input: EvalResult, ctx: PlanContext): Promise<ExecutionPlan | null>;
}

export interface ScanContext {
  pair: string;
  quotes: Quote[];
  nowIso: string;
}

export interface EvalContext {
  mode: ExecutionMode;
  quotes?: Quote[];
  nowIso?: string;
  balanceUsd?: number;
  riskPolicy?: RiskPolicy;
}

export interface PlanContext {
  balanceUsd: number;
  riskPolicy: RiskPolicy;
}

export interface GateCheck {
  simulationNetUsd24h: number;
  simulationWinRate24h: number;
  consecutiveFailures: number;
  permissionFailures24h: number;
  rejectRate24h: number;
  avgLatencyMs24h: number;
  avgSlippageDeviationBps24h: number;
  liveEnabled: boolean;
}

export interface EngineModeResponse {
  ok: boolean;
  requestedMode: ExecutionMode;
  currentMode: ExecutionMode;
  reasons: string[];
}

export interface TodayMetrics {
  day: string;
  opportunities: number;
  trades: number;
  netUsd: number;
  grossUsd: number;
  feeUsd: number;
  staleQuotes: number;
  avgQuoteLatencyMs: number;
  curve: Array<{ ts: string; netUsd: number }>;
}

export interface SkillManifest {
  id: "alphaos";
  version: string;
  description: string;
  strategyIds: string[];
}

export interface StrategyStatus {
  strategyId: string;
  opportunities: number;
  trades: number;
  netUsd: number;
}

export interface ShareCard {
  title: string;
  text: string;
  txHash: string;
  strategyId: string;
  pair: string;
  mode: ExecutionMode;
  netUsd: number;
  timestamp: string;
}

export interface GrowthMoment {
  id: string;
  category: "summary" | "trade" | "streak" | "safety";
  title: string;
  text: string;
  timestamp: string;
  valueUsd?: number;
  tags: string[];
}

export type DiscoveryStrategyId = "spread-threshold" | "mean-reversion" | "volatility-breakout";
export type DiscoverySessionStatus = "active" | "completed" | "stopped" | "failed";
export type DiscoveryCandidateStatus = "pending" | "approved" | "executed" | "failed" | "rejected";

export interface DiscoverySessionConfig {
  strategyId: DiscoveryStrategyId;
  pairs: string[];
  durationMinutes: number;
  sampleIntervalSec: number;
  topN: number;
  lookbackSamples: number;
  zEnter: number;
  volRatioMin: number;
  minSpreadBps: number;
  notionalUsd: number;
}

export interface DiscoverySessionSummary {
  samples: number;
  candidates: number;
  topPair?: string;
  topScore?: number;
  status: DiscoverySessionStatus;
}

export interface DiscoverySession {
  id: string;
  strategyId: DiscoveryStrategyId;
  status: DiscoverySessionStatus;
  pairs: string[];
  startedAt: string;
  plannedEndAt: string;
  endedAt?: string;
  config: DiscoverySessionConfig;
  summary?: DiscoverySessionSummary;
}

export interface DiscoverySample {
  id: string;
  sessionId: string;
  pair: string;
  ts: string;
  dexAMid: number;
  dexBMid: number;
  spreadBps: number;
  volatility: number | null;
  zScore: number | null;
  features: Record<string, unknown>;
}

export interface DiscoveryCandidate {
  id: string;
  sessionId: string;
  strategyId: DiscoveryStrategyId;
  pair: string;
  buyDex: string;
  sellDex: string;
  signalTs: string;
  score: number;
  expectedNetBps: number;
  expectedNetUsd: number;
  confidence: number;
  reason: string;
  input: Record<string, unknown>;
  status: DiscoveryCandidateStatus;
  approvedAt?: string;
  executedTradeId?: string;
}

export interface ChartPoint {
  ts: string;
  pair: string;
  spreadBps: number;
  volatility: number | null;
  zScore: number | null;
}

export interface DiscoveryReport {
  sessionId: string;
  generatedAt: string;
  summary: DiscoverySessionSummary & {
    strategyId: DiscoveryStrategyId;
    startedAt: string;
    endedAt?: string;
    pairs: string[];
  };
  topCandidates: DiscoveryCandidate[];
  charts: Record<string, ChartPoint[]>;
}

export interface DiscoveryApproveResult {
  approved: boolean;
  sessionId: string;
  candidateId: string;
  mode: ExecutionMode;
  effectiveMode: ExecutionMode;
  opportunityId: string;
  simulation: SimulationResult;
  tradeResult: TradeResult;
  degradedToPaper: boolean;
  tradeId?: string;
}

export interface DiscoveryPipelineItem extends DiscoveryCandidate {
  tradeTxHash?: string;
  tradeGrossUsd?: number;
  tradeFeeUsd?: number;
  tradeNetUsd?: number;
  tradeStatus?: string;
}

export interface StrategyProfile {
  strategyId: string;
  variant: "A" | "B";
  params: Record<string, unknown>;
  updatedAt: string;
}

export interface BacktestSnapshotRow {
  strategyId: string;
  opportunities: number;
  planned: number;
  executed: number;
  failed: number;
  rejected: number;
  avgEstimatedNetUsd: number;
  realizedNetUsd: number;
  tradeWinRate: number;
}

export interface TokenResolution {
  symbol: string;
  chainIndex: string;
  address: string;
  decimals: number;
  source: "cache" | "remote";
  updatedAt: string;
}

export interface TokenCacheEntry {
  symbol: string;
  chainIndex: string;
  address: string;
  decimals: number;
  expiresAt: string;
  updatedAt: string;
}

export interface OnchainV6QuoteRequest {
  chainIndex: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  dexIds?: string;
}

export interface OnchainV6QuoteResponse {
  fromTokenAmount: string;
  toTokenAmount: string;
  estimateGasFee?: string;
  tradeFee?: string;
  dexRouterList?: Array<{
    dexName?: string;
    fromTokenAmount?: string;
    toTokenAmount?: string;
  }>;
  raw: unknown;
}

export interface OnchainV6SwapRequest extends OnchainV6QuoteRequest {
  userWalletAddress: string;
  slippage?: string;
}

export interface OnchainV6SwapResponse {
  txData?: string;
  to?: string;
  value?: string;
  gasLimit?: string;
  raw: unknown;
}

export interface OnchainV6SimulateResponse {
  success: boolean;
  message?: string;
  raw: unknown;
}

export interface OnchainV6BroadcastResponse {
  txHash: string;
  status?: string;
  raw: unknown;
}

export interface OnchainIntegrationStatus {
  authMode: "bearer" | "api-key" | "hmac";
  v6Preferred: boolean;
  compatFallbackEnabled: boolean;
  requireSimulate: boolean;
  tokenProfilePath: string;
  chainIndex: string;
  allowSerialDualLeg?: boolean;
  userWalletConfigured?: boolean;
  lastSubmitChannel?: "public" | "private-rpc" | "private-relay";
  lastError?: string;
  lastErrorAt?: string;
  lastV6SuccessAt?: string;
  lastFallbackAt?: string;
  lastUsedPath?: string;
}

export interface OnchainProbeResult {
  ok: boolean;
  configured: boolean;
  mode: "unavailable" | "v6";
  pair: string;
  chainIndex: string;
  notionalUsd: number;
  quotePath?: string;
  swapPath?: string;
  simulatePath?: string;
  simulateRequired: boolean;
  failureStep?: "token" | "quote" | "swap" | "simulate";
  message: string;
  checkedAt: string;
}
