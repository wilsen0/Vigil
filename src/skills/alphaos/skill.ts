import type { Logger } from "pino";
import { DexArbitragePlugin } from "./plugins/dex-arbitrage";
import { AlphaEngine } from "./engine/alpha-engine";
import type { SkillManifest, StrategyPlugin } from "./types";
import { MarketWatch } from "./runtime/market-watch";
import { OnchainOsClient } from "./runtime/onchainos-client";
import { OpenClawNotifier } from "./runtime/notifier";
import { RiskEngine } from "./runtime/risk-engine";
import { Simulator } from "./runtime/simulator";
import { StateStore } from "./runtime/state-store";
import { DiscoveryEngine } from "./runtime/discovery/discovery-engine";
import type { AlphaOsConfig } from "./runtime/config";

function buildPlugins(config: AlphaOsConfig): StrategyPlugin[] {
  const plugins: StrategyPlugin[] = [];
  const enabled = new Set(config.enabledStrategies);

  if (enabled.has("dex-arbitrage")) {
    plugins.push(
      new DexArbitragePlugin({
        takerFeeBps: config.takerFeeBps,
        mevPenaltyBps: config.mevPenaltyBps,
        riskPolicy: config.riskPolicy,
        slippageBps: config.slippageBps,
        liquidityUsdDefault: config.liquidityUsdDefault,
        volatilityDefault: config.volatilityDefault,
        avgLatencyMsDefault: config.avgLatencyMsDefault,
        gasUsdDefault: config.gasUsdDefault,
        evalNotionalUsdDefault: config.evalNotionalUsdDefault,
      }),
    );
  }

  if (plugins.length === 0) {
    plugins.push(
      new DexArbitragePlugin({
        takerFeeBps: config.takerFeeBps,
        mevPenaltyBps: config.mevPenaltyBps,
        riskPolicy: config.riskPolicy,
        slippageBps: config.slippageBps,
        liquidityUsdDefault: config.liquidityUsdDefault,
        volatilityDefault: config.volatilityDefault,
        avgLatencyMsDefault: config.avgLatencyMsDefault,
        gasUsdDefault: config.gasUsdDefault,
        evalNotionalUsdDefault: config.evalNotionalUsdDefault,
      }),
    );
  }

  return plugins;
}

export function createAlphaOsSkill(config: AlphaOsConfig, logger: Logger) {
  const store = new StateStore(config.dataDir);
  const plugins = buildPlugins(config);

  for (const plugin of plugins) {
    const rawDefaults = config.strategyProfileDefaults[plugin.id];
    const defaults =
      rawDefaults && typeof rawDefaults === "object" && !Array.isArray(rawDefaults)
        ? (rawDefaults as Record<string, unknown>)
        : {};
    const variant = defaults.variant === "B" ? "B" : "A";
    const params = {
      notionalMultiplier:
        typeof defaults.notionalMultiplier === "number" ? defaults.notionalMultiplier : 1,
      ...(typeof defaults === "object" ? defaults : {}),
    };
    store.upsertStrategy(plugin.id, {
      pair: config.pair,
      dexes: config.dexes,
      enabled: true,
    });
    store.upsertStrategyProfile(plugin.id, variant, params);
  }

  const manifest: SkillManifest = {
    id: "alphaos",
    version: "0.2.0",
    description: "Plugin-first autonomous execution skill for the Vigil runtime",
    strategyIds: plugins.map((plugin) => plugin.id),
  };

  const onchain = new OnchainOsClient({
    apiBase: config.onchainOsApiBase,
    apiKey: config.onchainOsApiKey,
    apiSecret: config.onchainOsApiSecret,
    passphrase: config.onchainOsPassphrase,
    projectId: config.onchainOsProjectId,
    authMode: config.onchainAuthMode,
    apiKeyHeader: config.onchainApiKeyHeader,
    gasUsdDefault: config.gasUsdDefault,
    chainIndex: config.onchainChainIndex,
    requireSimulate: config.onchainRequireSimulate,
    enableCompatFallback: config.onchainEnableCompatFallback,
    allowSerialDualLeg: config.onchainAllowSerialDualLeg,
    userWalletAddress: config.onchainUserWalletAddress,
    tokenCacheTtlSeconds: config.onchainTokenCacheTtlSeconds,
    tokenProfilePath: config.onchainTokenProfilePath,
    privateRpcUrl: config.onchainPrivateRpcUrl,
    relayUrl: config.onchainRelayUrl,
    usePrivateSubmit: config.onchainUsePrivateSubmit,
    quoteStaleMs: config.quoteStaleMs,
    store,
    takerFeeBps: config.takerFeeBps,
    mevPenaltyBps: config.mevPenaltyBps,
    slippageBps: config.slippageBps,
    liquidityUsdDefault: config.liquidityUsdDefault,
    volatilityDefault: config.volatilityDefault,
    avgLatencyMsDefault: config.avgLatencyMsDefault,
  });

  const market = new MarketWatch(onchain, store, {
    quoteStaleMs: config.quoteStaleMs,
    wsEnabled: config.wsEnabled,
    wsUrl: config.wsUrl,
    wsReconnectMs: config.wsReconnectMs,
  });
  const simulator = new Simulator({
    slippageBps: config.slippageBps,
    takerFeeBps: config.takerFeeBps,
    gasUsdDefault: config.gasUsdDefault,
    mevPenaltyBps: config.mevPenaltyBps,
    liquidityUsdDefault: config.liquidityUsdDefault,
    volatilityDefault: config.volatilityDefault,
    avgLatencyMsDefault: config.avgLatencyMsDefault,
  });
  const riskEngine = new RiskEngine(config.riskPolicy);
  const notifier = new OpenClawNotifier(store, {
    hookUrl: config.openClawHookUrl,
    hookToken: config.openClawHookToken,
  });

  const engine = AlphaEngine.withDefaultExecutor(
    manifest,
    plugins,
    {
      intervalMs: config.engineIntervalMs,
      pair: config.pair,
      dexes: config.dexes,
      startMode: config.startMode,
      liveEnabled: config.liveEnabled,
      autoPromoteToLive: config.autoPromoteToLive,
      quoteStaleMs: config.quoteStaleMs,
      opportunityDedupTtlMs: config.opportunityDedupTtlMs,
      opportunityDedupMinEdgeDeltaBps: config.opportunityDedupMinEdgeDeltaBps,
      paperStartingBalanceUsd: config.paperStartingBalanceUsd,
      liveBalanceUsd: config.liveBalanceUsd,
      riskPolicy: config.riskPolicy,
    },
    logger,
    market,
    simulator,
    riskEngine,
    store,
    notifier,
    onchain,
  );

  const discovery = new DiscoveryEngine(
    store,
    onchain,
    notifier,
    {
      dexes: config.dexes,
      defaultDurationMinutes: config.discoveryDefaultDurationMinutes,
      defaultSampleIntervalSec: config.discoveryDefaultSampleIntervalSec,
      defaultTopN: config.discoveryDefaultTopN,
      lookbackSamples: config.discoveryLookbackSamples,
      zEnter: config.discoveryZEnter,
      volRatioMin: config.discoveryVolRatioMin,
      minSpreadBps: config.discoveryMinSpreadBps,
      notionalUsd: config.discoveryNotionalUsd,
      takerFeeBps: config.takerFeeBps,
      slippageBps: config.slippageBps,
      mevPenaltyBps: config.mevPenaltyBps,
      gasUsdDefault: config.gasUsdDefault,
    },
    async (candidate, mode) => engine.executeApprovedCandidate(candidate, mode),
  );

  return {
    manifest,
    engine,
    discovery,
    store,
    onchain,
  };
}
