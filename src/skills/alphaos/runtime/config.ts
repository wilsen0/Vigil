import dotenv from "dotenv";
import { z } from "zod";
import type { ExecutionMode, RiskPolicy } from "../types";
import { commListenerModeSchema, x402ModeSchema } from "./agent-comm/types";
import {
  type NetworkProfileId,
  type OnchainAuthMode,
  getNetworkProfile,
  getPreferredCommRpcUrl,
  networkProfileIds,
  readNetworkProfileId,
} from "./network-profile";

dotenv.config();

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readMode(name: string, fallback: ExecutionMode): ExecutionMode {
  const raw = process.env[name];
  if (raw === "paper" || raw === "live") {
    return raw;
  }
  return fallback;
}

function readCsv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function readJsonObject(name: string, fallback: Record<string, unknown>): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function readAuthMode(name: string, fallback: OnchainAuthMode): OnchainAuthMode {
  const raw = process.env[name];
  if (raw === "bearer" || raw === "api-key" || raw === "hmac") {
    return raw;
  }
  return fallback;
}

function readCommListenerMode(name: string, fallback: z.infer<typeof commListenerModeSchema>) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return commListenerModeSchema.parse(raw);
}

function readX402Mode(name: string, fallback: z.infer<typeof x402ModeSchema>) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return x402ModeSchema.parse(raw.trim().toLowerCase());
}

export interface AlphaOsConfig {
  networkProfileId: NetworkProfileId;
  port: number;
  logLevel: string;
  apiSecret?: string;
  demoPublic: boolean;
  engineIntervalMs: number;
  pair: string;
  dexes: [string, string];
  startMode: ExecutionMode;
  liveEnabled: boolean;
  paperStartingBalanceUsd: number;
  liveBalanceUsd: number;
  onchainOsApiBase?: string;
  onchainOsApiKey?: string;
  onchainOsApiSecret?: string;
  onchainOsPassphrase?: string;
  onchainOsProjectId?: string;
  onchainAuthMode: OnchainAuthMode;
  onchainApiKeyHeader: string;
  onchainChainIndex: string;
  onchainRequireSimulate: boolean;
  onchainEnableCompatFallback: boolean;
  onchainAllowSerialDualLeg: boolean;
  onchainUserWalletAddress?: string;
  onchainTokenCacheTtlSeconds: number;
  onchainTokenProfilePath: string;
  onchainPrivateRpcUrl?: string;
  onchainRelayUrl?: string;
  onchainUsePrivateSubmit: boolean;
  openClawHookUrl?: string;
  openClawHookToken?: string;
  dataDir: string;
  enabledStrategies: string[];
  mirrorMinConfidence: number;
  slippageBps: number;
  takerFeeBps: number;
  gasUsdDefault: number;
  mevPenaltyBps: number;
  liquidityUsdDefault: number;
  volatilityDefault: number;
  avgLatencyMsDefault: number;
  evalNotionalUsdDefault: number;
  autoPromoteToLive: boolean;
  wsEnabled: boolean;
  wsUrl: string;
  wsReconnectMs: number;
  quoteStaleMs: number;
  opportunityDedupTtlMs: number;
  opportunityDedupMinEdgeDeltaBps: number;
  riskPolicy: RiskPolicy;
  strategyProfileDefaults: Record<string, unknown>;
  discoveryDefaultDurationMinutes: number;
  discoveryDefaultSampleIntervalSec: number;
  discoveryDefaultTopN: number;
  discoveryLookbackSamples: number;
  discoveryZEnter: number;
  discoveryVolRatioMin: number;
  discoveryMinSpreadBps: number;
  discoveryNotionalUsd: number;
  commEnabled: boolean;
  commAutoAcceptInvites: boolean;
  commArtifactExpiryWarningDays: number;
  commChainId: number;
  commRpcUrl?: string;
  commRelayUrl?: string;
  commRelayTimeoutMs: number;
  commSubmitMode: z.infer<typeof commSubmitModeSchema>;
  commListenerMode: z.infer<typeof commListenerModeSchema>;
  commPollIntervalMs: number;
  commWalletAlias: string;
  commPaymasterUrl?: string;
  commWebhookUrl?: string;
  commWebhookToken?: string;
  x402Mode: z.infer<typeof x402ModeSchema>;
}

type AgentCommConfig = Pick<
  AlphaOsConfig,
  | "commEnabled"
  | "commAutoAcceptInvites"
  | "commArtifactExpiryWarningDays"
  | "commChainId"
  | "commRpcUrl"
  | "commRelayUrl"
  | "commRelayTimeoutMs"
  | "commSubmitMode"
  | "commListenerMode"
  | "commPollIntervalMs"
  | "commWalletAlias"
  | "commPaymasterUrl"
  | "commWebhookUrl"
  | "commWebhookToken"
>;

const networkProfileIdSchema: z.ZodType<NetworkProfileId> = z.enum(networkProfileIds);
const executionModeSchema: z.ZodType<ExecutionMode> = z.enum(["paper", "live"]);
const onchainAuthModeSchema: z.ZodType<OnchainAuthMode> = z.enum(["bearer", "api-key", "hmac"]);
const commSubmitModeSchema = z.enum(["direct", "relay"]);
const riskPolicySchema: z.ZodType<RiskPolicy> = z
  .object({
    minNetEdgeBpsPaper: z.number().finite(),
    minNetEdgeBpsLive: z.number().finite(),
    maxTradePctBalance: z.number().finite(),
    maxDailyLossPct: z.number().finite(),
    maxConsecutiveFailures: z.number().finite(),
  })
  .strict();

export const alphaOsConfigSchema: z.ZodType<AlphaOsConfig> = z
  .object({
    networkProfileId: networkProfileIdSchema,
    port: z.number().int().nonnegative(),
    logLevel: z.string(),
    apiSecret: z.string().optional(),
    demoPublic: z.boolean(),
    engineIntervalMs: z.number().finite(),
    pair: z.string(),
    dexes: z.tuple([z.string(), z.string()]),
    startMode: executionModeSchema,
    liveEnabled: z.boolean(),
    paperStartingBalanceUsd: z.number().finite(),
    liveBalanceUsd: z.number().finite(),
    onchainOsApiBase: z.string().optional(),
    onchainOsApiKey: z.string().optional(),
    onchainOsApiSecret: z.string().optional(),
    onchainOsPassphrase: z.string().optional(),
    onchainOsProjectId: z.string().optional(),
    onchainAuthMode: onchainAuthModeSchema,
    onchainApiKeyHeader: z.string(),
    onchainChainIndex: z.string(),
    onchainRequireSimulate: z.boolean(),
    onchainEnableCompatFallback: z.boolean(),
    onchainAllowSerialDualLeg: z.boolean(),
    onchainUserWalletAddress: z.string().optional(),
    onchainTokenCacheTtlSeconds: z.number().finite(),
    onchainTokenProfilePath: z.string(),
    onchainPrivateRpcUrl: z.string().optional(),
    onchainRelayUrl: z.string().optional(),
    onchainUsePrivateSubmit: z.boolean(),
    openClawHookUrl: z.string().optional(),
    openClawHookToken: z.string().optional(),
    dataDir: z.string(),
    enabledStrategies: z.array(z.string()),
    mirrorMinConfidence: z.number().finite(),
    slippageBps: z.number().finite(),
    takerFeeBps: z.number().finite(),
    gasUsdDefault: z.number().finite(),
    mevPenaltyBps: z.number().finite(),
    liquidityUsdDefault: z.number().finite(),
    volatilityDefault: z.number().finite(),
    avgLatencyMsDefault: z.number().finite(),
    evalNotionalUsdDefault: z.number().finite(),
    autoPromoteToLive: z.boolean(),
    wsEnabled: z.boolean(),
    wsUrl: z.string(),
    wsReconnectMs: z.number().finite(),
    quoteStaleMs: z.number().finite(),
    opportunityDedupTtlMs: z.number().finite(),
    opportunityDedupMinEdgeDeltaBps: z.number().finite(),
    riskPolicy: riskPolicySchema,
    strategyProfileDefaults: z.record(z.string(), z.unknown()),
    discoveryDefaultDurationMinutes: z.number().finite(),
    discoveryDefaultSampleIntervalSec: z.number().finite(),
    discoveryDefaultTopN: z.number().finite(),
    discoveryLookbackSamples: z.number().finite(),
    discoveryZEnter: z.number().finite(),
    discoveryVolRatioMin: z.number().finite(),
    discoveryMinSpreadBps: z.number().finite(),
    discoveryNotionalUsd: z.number().finite(),
    commEnabled: z.boolean(),
    commAutoAcceptInvites: z.boolean(),
    commArtifactExpiryWarningDays: z.number().int().nonnegative(),
    commChainId: z.number().int().positive(),
    commRpcUrl: z.string().optional(),
    commRelayUrl: z.string().optional(),
    commRelayTimeoutMs: z.number().int().positive(),
    commSubmitMode: commSubmitModeSchema,
    commListenerMode: commListenerModeSchema,
    commPollIntervalMs: z.number().finite(),
    commWalletAlias: z.string().min(1),
    commPaymasterUrl: z.string().optional(),
    commWebhookUrl: z.string().optional(),
    commWebhookToken: z.string().optional(),
    x402Mode: x402ModeSchema,
  })
  .strict();

function readAgentCommConfig(options: {
  resolvedOnchainChainIndex: string;
  commChainIdDefault?: number;
  commRpcUrlDefault?: string;
  commListenerModeDefault?: z.infer<typeof commListenerModeSchema>;
}): AgentCommConfig {
  const chainIdFromChainIndex = Number(options.resolvedOnchainChainIndex);
  const commChainIdFallback = Number.isFinite(chainIdFromChainIndex)
    ? chainIdFromChainIndex
    : options.commChainIdDefault ?? 196;

  return {
    commEnabled: readBoolean("COMM_ENABLED", false),
    commAutoAcceptInvites: readBoolean("COMM_AUTO_ACCEPT_INVITES", false),
    commArtifactExpiryWarningDays: Math.max(
      0,
      Math.floor(readNumber("COMM_ARTIFACT_EXPIRY_WARNING_DAYS", 7)),
    ),
    commChainId: readNumber("COMM_CHAIN_ID", commChainIdFallback),
    commRpcUrl: process.env.COMM_RPC_URL ?? options.commRpcUrlDefault,
    commRelayUrl: process.env.COMM_RELAY_URL,
    commRelayTimeoutMs: Math.max(1, Math.floor(readNumber("COMM_RELAY_TIMEOUT_MS", 10_000))),
    commSubmitMode: commSubmitModeSchema.parse((process.env.COMM_SUBMIT_MODE ?? "direct").trim().toLowerCase()),
    commListenerMode: readCommListenerMode(
      "COMM_LISTENER_MODE",
      options.commListenerModeDefault ?? "disabled",
    ),
    commPollIntervalMs: readNumber("COMM_POLL_INTERVAL_MS", 5000),
    commWalletAlias: process.env.COMM_WALLET_ALIAS ?? "agent-comm",
    commPaymasterUrl: process.env.COMM_PAYMASTER_URL,
    commWebhookUrl: process.env.COMM_WEBHOOK_URL,
    commWebhookToken: process.env.COMM_WEBHOOK_TOKEN,
  };
}

function assertSupportedCommListenerMode(mode: AgentCommConfig["commListenerMode"]): void {
  if (mode === "ws") {
    throw new Error("COMM_LISTENER_MODE=ws is not supported in agent-comm v0.1 (use disabled|poll)");
  }
}

function assertEnabledCommHasRpcUrl(config: Pick<AgentCommConfig, "commEnabled" | "commRpcUrl">): void {
  if (config.commEnabled && !config.commRpcUrl?.trim()) {
    throw new Error("COMM_ENABLED=true requires COMM_RPC_URL");
  }
}

function assertAgentCommConfig(config: AgentCommConfig): void {
  assertSupportedCommListenerMode(config.commListenerMode);
  assertEnabledCommHasRpcUrl(config);
}

export function loadConfig(): AlphaOsConfig {
  const networkProfileId = readNetworkProfileId(process.env.NETWORK_PROFILE);
  const networkProfile = getNetworkProfile(networkProfileId);
  const resolvedOnchainChainIndex =
    process.env.ONCHAINOS_CHAIN_INDEX ?? networkProfile.defaults.onchainChainIndex ?? "196";

  // Resolution boundary:
  // 1. defaultable fields use env -> profile defaults -> legacy fallback
  // 2. auto-detectable fields remain in network-profile probes for later runtime checks
  // 3. required user inputs stay explicit and are never synthesized here
  const config = {
    networkProfileId,
    port: readNumber("PORT", 3000),
    logLevel: process.env.LOG_LEVEL ?? "info",
    apiSecret: process.env.API_SECRET,
    demoPublic: readBoolean("DEMO_PUBLIC", false),
    engineIntervalMs: readNumber("ENGINE_INTERVAL_MS", 5000),
    pair: process.env.PAIR ?? networkProfile.defaults.pair ?? "ETH/USDC",
    dexes: [process.env.DEX_A ?? "okx-dex-a", process.env.DEX_B ?? "okx-dex-b"],
    startMode: readMode("START_MODE", "paper"),
    liveEnabled: readBoolean("LIVE_ENABLED", false),
    paperStartingBalanceUsd: readNumber("PAPER_START_BALANCE_USD", 10000),
    liveBalanceUsd: readNumber("LIVE_BALANCE_USD", 3000),
    onchainOsApiBase: process.env.ONCHAINOS_API_BASE,
    onchainOsApiKey: process.env.ONCHAINOS_API_KEY,
    onchainOsApiSecret: process.env.ONCHAINOS_API_SECRET,
    onchainOsPassphrase: process.env.ONCHAINOS_PASSPHRASE,
    onchainOsProjectId: process.env.ONCHAINOS_PROJECT_ID,
    onchainAuthMode: readAuthMode(
      "ONCHAINOS_AUTH_MODE",
      networkProfile.defaults.onchainAuthMode ?? "bearer",
    ),
    onchainApiKeyHeader: process.env.ONCHAINOS_API_KEY_HEADER ?? "X-API-Key",
    onchainChainIndex: resolvedOnchainChainIndex,
    onchainRequireSimulate: readBoolean(
      "ONCHAINOS_REQUIRE_SIMULATE",
      networkProfile.defaults.onchainRequireSimulate ?? true,
    ),
    onchainEnableCompatFallback: readBoolean(
      "ONCHAINOS_ENABLE_COMPAT_FALLBACK",
      networkProfile.defaults.onchainEnableCompatFallback ?? false,
    ),
    onchainAllowSerialDualLeg: readBoolean("ONCHAINOS_ALLOW_SERIAL_DUAL_LEG", false),
    onchainUserWalletAddress: process.env.ONCHAINOS_USER_WALLET_ADDRESS,
    onchainTokenCacheTtlSeconds: readNumber("ONCHAINOS_TOKEN_CACHE_TTL_SECONDS", 600),
    onchainTokenProfilePath:
      process.env.ONCHAINOS_TOKEN_PROFILE_PATH ?? "/api/v6/market/token/profile/current",
    onchainPrivateRpcUrl: process.env.ONCHAINOS_PRIVATE_RPC_URL,
    onchainRelayUrl: process.env.ONCHAINOS_RELAY_URL,
    onchainUsePrivateSubmit: readBoolean("ONCHAINOS_USE_PRIVATE_SUBMIT", false),
    openClawHookUrl: process.env.OPENCLAW_HOOK_URL,
    openClawHookToken: process.env.OPENCLAW_HOOK_TOKEN,
    dataDir: process.env.DATA_DIR ?? "data",
    enabledStrategies: readCsv("ENABLED_STRATEGIES", ["dex-arbitrage", "smart-money-mirror"]),
    mirrorMinConfidence: readNumber("MIRROR_MIN_CONFIDENCE", 0.62),
    slippageBps: readNumber("SLIPPAGE_BPS", 12),
    takerFeeBps: readNumber("TAKER_FEE_BPS", 20),
    gasUsdDefault: readNumber("GAS_USD_DEFAULT", 1.25),
    mevPenaltyBps: readNumber("MEV_PENALTY_BPS", 5),
    liquidityUsdDefault: readNumber("LIQUIDITY_USD_DEFAULT", 250000),
    volatilityDefault: readNumber("VOLATILITY_DEFAULT", 0.02),
    avgLatencyMsDefault: readNumber("AVG_LATENCY_MS_DEFAULT", 250),
    evalNotionalUsdDefault: readNumber("EVAL_NOTIONAL_USD_DEFAULT", 1000),
    autoPromoteToLive: readBoolean("AUTO_PROMOTE_TO_LIVE", false),
    wsEnabled: readBoolean("WS_ENABLED", false),
    wsUrl: process.env.WS_URL ?? "",
    wsReconnectMs: readNumber("WS_RECONNECT_MS", 2000),
    quoteStaleMs: readNumber("QUOTE_STALE_MS", 1000),
    opportunityDedupTtlMs: readNumber("OPPORTUNITY_DEDUP_TTL_MS", 5000),
    opportunityDedupMinEdgeDeltaBps: readNumber("OPPORTUNITY_DEDUP_MIN_EDGE_DELTA_BPS", 2),
    riskPolicy: {
      minNetEdgeBpsPaper: readNumber("MIN_NET_EDGE_BPS_PAPER", 45),
      minNetEdgeBpsLive: readNumber("MIN_NET_EDGE_BPS_LIVE", 60),
      maxTradePctBalance: readNumber("MAX_TRADE_PCT_BALANCE", 0.03),
      maxDailyLossPct: readNumber("MAX_DAILY_LOSS_PCT", 0.015),
      maxConsecutiveFailures: readNumber("MAX_CONSECUTIVE_FAILURES", 3),
    },
    strategyProfileDefaults: readJsonObject("STRATEGY_PROFILE_DEFAULTS", {
      "dex-arbitrage": { variant: "A", notionalMultiplier: 1 },
      "smart-money-mirror": { variant: "A", notionalMultiplier: 1 },
    }),
    discoveryDefaultDurationMinutes: readNumber("DISCOVERY_DEFAULT_DURATION_MINUTES", 30),
    discoveryDefaultSampleIntervalSec: readNumber("DISCOVERY_DEFAULT_SAMPLE_INTERVAL_SEC", 60),
    discoveryDefaultTopN: readNumber("DISCOVERY_DEFAULT_TOPN", 10),
    discoveryLookbackSamples: readNumber("DISCOVERY_LOOKBACK_SAMPLES", 100),
    discoveryZEnter: readNumber("DISCOVERY_Z_ENTER", 2.0),
    discoveryVolRatioMin: readNumber("DISCOVERY_VOL_RATIO_MIN", 0.5),
    discoveryMinSpreadBps: readNumber("DISCOVERY_MIN_SPREAD_BPS", 20),
    discoveryNotionalUsd: readNumber("DISCOVERY_NOTIONAL_USD", 1000),
    ...readAgentCommConfig({
      resolvedOnchainChainIndex,
      commChainIdDefault: networkProfile.defaults.commChainId,
      commRpcUrlDefault: getPreferredCommRpcUrl(networkProfile),
      commListenerModeDefault: networkProfile.defaults.commListenerMode,
    }),
    x402Mode: readX402Mode("X402_MODE", "disabled"),
  };
  const parsed = alphaOsConfigSchema.parse(config);

  assertAgentCommConfig(parsed);

  return parsed;
}
