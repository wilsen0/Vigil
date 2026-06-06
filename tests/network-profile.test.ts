import { afterEach, describe, expect, it } from "vitest";
import {
  defaultNetworkProfileId,
  getNetworkProfile,
  getPreferredCommRpcUrl,
  networkProfileIds,
  readNetworkProfileId,
} from "../src/skills/alphaos/runtime/network-profile";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("network-profile constants and types", () => {
  it("exports correct default profile id", () => {
    expect(defaultNetworkProfileId).toBe("xlayer-recommended");
  });

  it("exports exactly two profile ids", () => {
    expect(networkProfileIds).toEqual(["xlayer-recommended", "evm-custom"]);
    expect(networkProfileIds.length).toBe(2);
  });
});

describe("readNetworkProfileId", () => {
  it("returns default when undefined", () => {
    expect(readNetworkProfileId(undefined)).toBe("xlayer-recommended");
  });

  it("returns default when empty string", () => {
    expect(readNetworkProfileId("")).toBe("xlayer-recommended");
  });

  it("accepts xlayer-recommended", () => {
    expect(readNetworkProfileId("xlayer-recommended")).toBe("xlayer-recommended");
  });

  it("accepts evm-custom", () => {
    expect(readNetworkProfileId("evm-custom")).toBe("evm-custom");
  });

  it("throws on unsupported profile id", () => {
    expect(() => readNetworkProfileId("unsupported")).toThrow("Unsupported NETWORK_PROFILE=unsupported");
  });

  it("throws on case-mismatched profile id", () => {
    expect(() => readNetworkProfileId("XLayer-Recommended")).toThrow("Unsupported NETWORK_PROFILE=XLayer-Recommended");
  });
});

describe("getNetworkProfile", () => {
  it("returns xlayer-recommended profile with correct structure", () => {
    const profile = getNetworkProfile("xlayer-recommended");

    expect(profile.id).toBe("xlayer-recommended");
    expect(profile.label).toBe("X Layer recommended");
    expect(profile.mode).toBe("recommended");
    expect(profile.defaults.pair).toBe("ETH/USDC");
    expect(profile.defaults.onchainChainIndex).toBe("196");
    expect(profile.defaults.commChainId).toBe(196);
    expect(profile.defaults.commRpcUrls).toEqual(["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"]);
    expect(profile.defaults.commListenerMode).toBe("poll");
    expect(profile.defaults.onchainAuthMode).toBe("hmac");
    expect(profile.defaults.onchainRequireSimulate).toBe(true);
    expect(profile.defaults.onchainEnableCompatFallback).toBe(false);
  });

  it("returns evm-custom profile with empty defaults", () => {
    const profile = getNetworkProfile("evm-custom");

    expect(profile.id).toBe("evm-custom");
    expect(profile.label).toBe("EVM custom");
    expect(profile.mode).toBe("custom");
    expect(Object.keys(profile.defaults).length).toBe(0);
  });

  it("xlayer-recommended has correct capability flags", () => {
    const profile = getNetworkProfile("xlayer-recommended");
    const flags = profile.capabilityFlags;

    expect(flags.recommendedPath).toBe(true);
    expect(flags.evmCompatible).toBe(true);
    expect(flags.chainDefaults).toBe(true);
    expect(flags.onchainDiagnostics).toBe(true);
    expect(flags.tokenMetadata).toBe(true);
    expect(flags.chainMetadata).toBe(true);
    expect(flags.relayOverride).toBe(true);
    expect(flags.privateSubmitOverride).toBe(true);
    expect(flags.wsListenerImplemented).toBe(false);
    expect(flags.paymasterImplemented).toBe(false);
    expect(flags.aaImplemented).toBe(false);
    expect(flags.x402Implemented).toBe(false);
  });

  it("evm-custom has correct capability flags", () => {
    const profile = getNetworkProfile("evm-custom");
    const flags = profile.capabilityFlags;

    expect(flags.recommendedPath).toBe(false);
    expect(flags.evmCompatible).toBe(true);
    expect(flags.chainDefaults).toBe(false);
    expect(flags.onchainDiagnostics).toBe(true);
    expect(flags.tokenMetadata).toBe(true);
    expect(flags.chainMetadata).toBe(true);
    expect(flags.relayOverride).toBe(true);
    expect(flags.privateSubmitOverride).toBe(true);
    expect(flags.wsListenerImplemented).toBe(false);
    expect(flags.paymasterImplemented).toBe(false);
    expect(flags.aaImplemented).toBe(false);
    expect(flags.x402Implemented).toBe(false);
  });

  it("both profiles share the same probe definitions", () => {
    const xlayer = getNetworkProfile("xlayer-recommended");
    const evm = getNetworkProfile("evm-custom");

    expect(xlayer.probes).toEqual(evm.probes);
    expect(xlayer.probes.length).toBe(5);
    expect(xlayer.probes.map((p) => p.id)).toEqual([
      "rpc-connectivity",
      "rpc-chain-id",
      "onchain-status",
      "onchain-probe",
      "token-resolution",
    ]);
  });

  it("xlayer-recommended has fewer required inputs than evm-custom", () => {
    const xlayer = getNetworkProfile("xlayer-recommended");
    const evm = getNetworkProfile("evm-custom");

    expect(xlayer.requiredUserInputs.length).toBeLessThan(evm.requiredUserInputs.length);
  });
});

describe("getPreferredCommRpcUrl", () => {
  it("returns first RPC URL for xlayer-recommended", () => {
    const profile = getNetworkProfile("xlayer-recommended");
    const url = getPreferredCommRpcUrl(profile);

    expect(url).toBe("https://rpc.xlayer.tech");
  });

  it("returns undefined for evm-custom", () => {
    const profile = getNetworkProfile("evm-custom");
    const url = getPreferredCommRpcUrl(profile);

    expect(url).toBeUndefined();
  });
});
