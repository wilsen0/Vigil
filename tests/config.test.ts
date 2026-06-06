import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/skills/alphaos/runtime/config";
import { xlayerRecommendedRpcUrls } from "../src/skills/alphaos/runtime/network-profile";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadConfig security defaults", () => {
  it("applies xlayer-recommended profile defaults when env is unset", () => {
    delete process.env.NETWORK_PROFILE;
    delete process.env.PAIR;
    delete process.env.ONCHAINOS_CHAIN_INDEX;
    delete process.env.COMM_CHAIN_ID;
    delete process.env.COMM_RPC_URL;
    delete process.env.COMM_LISTENER_MODE;
    delete process.env.ONCHAINOS_AUTH_MODE;

    const config = loadConfig();
    expect(config.networkProfileId).toBe("xlayer-recommended");
    expect(config.pair).toBe("ETH/USDC");
    expect(config.onchainChainIndex).toBe("196");
    expect(config.commChainId).toBe(196);
    expect(config.commRpcUrl).toBe(xlayerRecommendedRpcUrls[0]);
    expect(config.commListenerMode).toBe("poll");
    expect(config.onchainAuthMode).toBe("hmac");
  });

  it("lets explicit env override xlayer-recommended defaults", () => {
    process.env.NETWORK_PROFILE = "xlayer-recommended";
    process.env.PAIR = "OKB/USDT";
    process.env.ONCHAINOS_CHAIN_INDEX = "8453";
    process.env.COMM_CHAIN_ID = "8453";
    process.env.COMM_RPC_URL = "https://rpc.base.example";
    process.env.COMM_LISTENER_MODE = "disabled";
    process.env.ONCHAINOS_AUTH_MODE = "bearer";

    const config = loadConfig();
    expect(config.networkProfileId).toBe("xlayer-recommended");
    expect(config.pair).toBe("OKB/USDT");
    expect(config.onchainChainIndex).toBe("8453");
    expect(config.commChainId).toBe(8453);
    expect(config.commRpcUrl).toBe("https://rpc.base.example");
    expect(config.commListenerMode).toBe("disabled");
    expect(config.onchainAuthMode).toBe("bearer");
  });

  it("keeps evm-custom free of xlayer transport defaults", () => {
    process.env.NETWORK_PROFILE = "evm-custom";
    delete process.env.COMM_RPC_URL;
    delete process.env.COMM_LISTENER_MODE;
    delete process.env.ONCHAINOS_AUTH_MODE;

    const config = loadConfig();
    expect(config.networkProfileId).toBe("evm-custom");
    expect(config.commRpcUrl).toBeUndefined();
    expect(config.commListenerMode).toBe("disabled");
    expect(config.onchainAuthMode).toBe("bearer");
  });

  it("defaults live toggles to false", () => {
    delete process.env.LIVE_ENABLED;
    delete process.env.AUTO_PROMOTE_TO_LIVE;
    delete process.env.ONCHAINOS_ENABLE_COMPAT_FALLBACK;
    delete process.env.ONCHAINOS_ALLOW_SERIAL_DUAL_LEG;
    delete process.env.ONCHAINOS_USER_WALLET_ADDRESS;

    const config = loadConfig();
    expect(config.liveEnabled).toBe(false);
    expect(config.autoPromoteToLive).toBe(false);
    expect(config.onchainEnableCompatFallback).toBe(false);
    expect(config.onchainAllowSerialDualLeg).toBe(false);
    expect(config.onchainUserWalletAddress).toBeUndefined();
  });

  it("reads production onchain execution boundary configuration from env", () => {
    process.env.ONCHAINOS_ALLOW_SERIAL_DUAL_LEG = "true";
    process.env.ONCHAINOS_USER_WALLET_ADDRESS = "0x2222222222222222222222222222222222222222";

    const config = loadConfig();
    expect(config.onchainAllowSerialDualLeg).toBe(true);
    expect(config.onchainUserWalletAddress).toBe("0x2222222222222222222222222222222222222222");
  });

  it("reads API secret and demo visibility from env", () => {
    process.env.API_SECRET = "example-secret";
    process.env.DEMO_PUBLIC = "true";

    const config = loadConfig();
    expect(config.apiSecret).toBe("example-secret");
    expect(config.demoPublic).toBe(true);
  });

  it("reads private submit configuration from env", () => {
    process.env.ONCHAINOS_PRIVATE_RPC_URL = "https://private-rpc.example";
    process.env.ONCHAINOS_RELAY_URL = "https://relay.example";
    process.env.ONCHAINOS_USE_PRIVATE_SUBMIT = "true";

    const config = loadConfig();
    expect(config.onchainPrivateRpcUrl).toBe("https://private-rpc.example");
    expect(config.onchainRelayUrl).toBe("https://relay.example");
    expect(config.onchainUsePrivateSubmit).toBe(true);
  });

  it("reads agent-comm relay submission configuration from env", () => {
    process.env.COMM_RELAY_URL = "https://comm-relay.example/submit";
    process.env.COMM_RELAY_TIMEOUT_MS = "12345";
    process.env.COMM_SUBMIT_MODE = "relay";

    const config = loadConfig();
    expect(config.commRelayUrl).toBe("https://comm-relay.example/submit");
    expect(config.commRelayTimeoutMs).toBe(12345);
    expect(config.commSubmitMode).toBe("relay");
  });

  it("reads cost-model parameters from env", () => {
    process.env.MEV_PENALTY_BPS = "7";
    process.env.LIQUIDITY_USD_DEFAULT = "900000";
    process.env.VOLATILITY_DEFAULT = "0.05";
    process.env.AVG_LATENCY_MS_DEFAULT = "320";
    process.env.EVAL_NOTIONAL_USD_DEFAULT = "1800";

    const config = loadConfig();
    expect(config.mevPenaltyBps).toBe(7);
    expect(config.liquidityUsdDefault).toBe(900000);
    expect(config.volatilityDefault).toBe(0.05);
    expect(config.avgLatencyMsDefault).toBe(320);
    expect(config.evalNotionalUsdDefault).toBe(1800);
  });

  it("reads websocket and quote freshness configuration from env", () => {
    process.env.WS_ENABLED = "true";
    process.env.WS_URL = "wss://quotes.example/ws";
    process.env.WS_RECONNECT_MS = "750";
    process.env.QUOTE_STALE_MS = "850";

    const config = loadConfig();
    expect(config.wsEnabled).toBe(true);
    expect(config.wsUrl).toBe("wss://quotes.example/ws");
    expect(config.wsReconnectMs).toBe(750);
    expect(config.quoteStaleMs).toBe(850);
  });

  it("supports X402_MODE observe and enforce", () => {
    process.env.X402_MODE = "observe";
    expect(loadConfig().x402Mode).toBe("observe");

    process.env.X402_MODE = "enforce";
    expect(loadConfig().x402Mode).toBe("enforce");
  });

  it("reads opportunity dedup configuration from env", () => {
    process.env.OPPORTUNITY_DEDUP_TTL_MS = "12000";
    process.env.OPPORTUNITY_DEDUP_MIN_EDGE_DELTA_BPS = "3.5";

    const config = loadConfig();
    expect(config.opportunityDedupTtlMs).toBe(12000);
    expect(config.opportunityDedupMinEdgeDeltaBps).toBe(3.5);
  });

  it("uses discovery defaults when env is unset", () => {
    delete process.env.DISCOVERY_DEFAULT_DURATION_MINUTES;
    delete process.env.DISCOVERY_DEFAULT_SAMPLE_INTERVAL_SEC;
    delete process.env.DISCOVERY_DEFAULT_TOPN;
    delete process.env.DISCOVERY_LOOKBACK_SAMPLES;
    delete process.env.DISCOVERY_Z_ENTER;
    delete process.env.DISCOVERY_VOL_RATIO_MIN;
    delete process.env.DISCOVERY_MIN_SPREAD_BPS;
    delete process.env.DISCOVERY_NOTIONAL_USD;

    const config = loadConfig();
    expect(config.discoveryDefaultDurationMinutes).toBe(30);
    expect(config.discoveryDefaultSampleIntervalSec).toBe(60);
    expect(config.discoveryDefaultTopN).toBe(10);
    expect(config.discoveryLookbackSamples).toBe(100);
    expect(config.discoveryZEnter).toBe(2);
    expect(config.discoveryVolRatioMin).toBe(0.5);
    expect(config.discoveryMinSpreadBps).toBe(20);
    expect(config.discoveryNotionalUsd).toBe(1000);
  });

  it("reads discovery configuration from env", () => {
    process.env.DISCOVERY_DEFAULT_DURATION_MINUTES = "45";
    process.env.DISCOVERY_DEFAULT_SAMPLE_INTERVAL_SEC = "15";
    process.env.DISCOVERY_DEFAULT_TOPN = "25";
    process.env.DISCOVERY_LOOKBACK_SAMPLES = "180";
    process.env.DISCOVERY_Z_ENTER = "1.8";
    process.env.DISCOVERY_VOL_RATIO_MIN = "0.7";
    process.env.DISCOVERY_MIN_SPREAD_BPS = "12";
    process.env.DISCOVERY_NOTIONAL_USD = "2500";

    const config = loadConfig();
    expect(config.discoveryDefaultDurationMinutes).toBe(45);
    expect(config.discoveryDefaultSampleIntervalSec).toBe(15);
    expect(config.discoveryDefaultTopN).toBe(25);
    expect(config.discoveryLookbackSamples).toBe(180);
    expect(config.discoveryZEnter).toBe(1.8);
    expect(config.discoveryVolRatioMin).toBe(0.7);
    expect(config.discoveryMinSpreadBps).toBe(12);
    expect(config.discoveryNotionalUsd).toBe(2500);
  });

  it("rejects COMM_ENABLED without COMM_RPC_URL", () => {
    process.env.NETWORK_PROFILE = "evm-custom";
    process.env.COMM_ENABLED = "true";
    delete process.env.COMM_RPC_URL;

    expect(() => loadConfig()).toThrow("COMM_ENABLED=true requires COMM_RPC_URL");
  });

  it("rejects unsupported COMM_LISTENER_MODE=ws", () => {
    process.env.COMM_LISTENER_MODE = "ws";

    expect(() => loadConfig()).toThrow("COMM_LISTENER_MODE=ws is not supported in agent-comm v0.1");
  });

  it("rejects unsupported X402_MODE values", () => {
    process.env.X402_MODE = "strict";
    expect(() => loadConfig()).toThrow();
  });
});
