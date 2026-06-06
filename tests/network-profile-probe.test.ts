import { afterEach, describe, expect, it, vi } from "vitest";

const createPublicClientMock = vi.hoisted(() => vi.fn());

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: createPublicClientMock,
  };
});

import { loadConfig } from "../src/skills/alphaos/runtime/config";
import {
  getNetworkProfileReadinessSnapshot,
  probeNetworkProfileReadiness,
} from "../src/skills/alphaos/runtime/network-profile-probe";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

function createOnchainClientStub(options?: {
  withTokenCache?: boolean;
  lastV6SuccessAt?: string;
  probeResult?: {
    ok: boolean;
    configured: boolean;
    mode: "unavailable" | "v6";
    pair: string;
    chainIndex: string;
    notionalUsd: number;
    simulateRequired: boolean;
    message: string;
    checkedAt: string;
  };
}) {
  return {
    getIntegrationStatus: () => ({
      authMode: "hmac" as const,
      v6Preferred: true,
      compatFallbackEnabled: true,
      requireSimulate: true,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      chainIndex: "196",
      lastV6SuccessAt: options?.lastV6SuccessAt,
      lastUsedPath: options?.lastV6SuccessAt ? "/api/v6/dex/aggregator/quote" : undefined,
    }),
    probeConnection: vi.fn().mockResolvedValue(
      options?.probeResult ?? {
        ok: false,
        configured: false,
        mode: "unavailable" as const,
        pair: "ETH/USDC",
        chainIndex: "196",
        notionalUsd: 25,
        simulateRequired: true,
        message: "ONCHAINOS_API_BASE is required for production execution",
        checkedAt: "2026-03-07T00:00:00.000Z",
      },
    ),
    getTokenCacheEntry: vi.fn().mockImplementation(() =>
      options?.withTokenCache ? { updatedAt: "2026-03-07T00:00:00.000Z" } : null,
    ),
  };
}

describe("network profile readiness", () => {
  it("marks xlayer-recommended as degraded when production execution backend is unavailable", () => {
    process.env = {
      ...originalEnv,
      NETWORK_PROFILE: "xlayer-recommended",
    };
    delete process.env.ONCHAINOS_API_BASE;
    delete process.env.COMM_RPC_URL;

    const config = loadConfig();
    const diagnostics = getNetworkProfileReadinessSnapshot({
      config,
      onchainClient: createOnchainClientStub(),
    });

    expect(diagnostics.profile.id).toBe("xlayer-recommended");
    expect(diagnostics.readiness).toBe("degraded");
    expect(diagnostics.reasons.some((reason) => reason.includes("production quote retrieval"))).toBe(true);
  });

  it("marks evm-custom as unavailable until explicit chain and rpc are provided", () => {
    process.env = {
      ...originalEnv,
      NETWORK_PROFILE: "evm-custom",
    };
    delete process.env.COMM_RPC_URL;
    delete process.env.COMM_CHAIN_ID;
    delete process.env.ONCHAINOS_CHAIN_INDEX;

    const config = loadConfig();
    const diagnostics = getNetworkProfileReadinessSnapshot({ config });

    expect(diagnostics.profile.id).toBe("evm-custom");
    expect(diagnostics.readiness).toBe("unavailable");
    expect(diagnostics.reasons.some((reason) => reason.includes("explicit chain selection"))).toBe(true);
    expect(diagnostics.reasons.some((reason) => reason.includes("COMM_RPC_URL"))).toBe(true);
  });

  it("marks xlayer-recommended as ready after rpc and onchain probes succeed", async () => {
    process.env = {
      ...originalEnv,
      NETWORK_PROFILE: "xlayer-recommended",
      ONCHAINOS_API_BASE: "https://api.onchain.example",
    };
    delete process.env.COMM_RPC_URL;

    createPublicClientMock.mockReturnValue({
      getChainId: vi.fn().mockResolvedValue(196),
    });

    const config = loadConfig();
    const diagnostics = await probeNetworkProfileReadiness({
      config,
      onchainClient: createOnchainClientStub({
        withTokenCache: true,
        lastV6SuccessAt: "2026-03-07T00:00:00.000Z",
        probeResult: {
          ok: true,
          configured: true,
          mode: "v6",
          pair: "ETH/USDC",
          chainIndex: "196",
          notionalUsd: 25,
          simulateRequired: true,
          message: "v6 probe passed",
          checkedAt: "2026-03-07T00:00:00.000Z",
        },
      }),
      timeoutMs: 50,
    });

    expect(diagnostics.readiness).toBe("ready");
    expect(diagnostics.activeProbe).toBe(true);
    expect(diagnostics.checks.find((check) => check.id === "rpc-chain-id")?.status).toBe("pass");
    expect(diagnostics.checks.find((check) => check.id === "onchain-probe")?.status).toBe("pass");
    expect(createPublicClientMock).toHaveBeenCalledTimes(1);
  });
});
