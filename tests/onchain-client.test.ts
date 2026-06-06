import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnchainOsClient } from "../src/skills/alphaos/runtime/onchainos-client";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEST_WALLET = "0x2222222222222222222222222222222222222222";

describe("OnchainOsClient v6 integration", () => {
  const originalFetch = globalThis.fetch;
  const stores: StateStore[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) {
      store.close();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds hmac signature with query and includes project header", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));

    const mockFetch = vi.fn(async () => jsonResponse({ data: [{ fromTokenAmount: "100", toTokenAmount: "1" }] }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      apiSecret: "s1",
      passphrase: "p1",
      projectId: "proj-1",
      authMode: "hmac",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: true,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
    });

    await client.getQuoteV6({
      chainIndex: "196",
      fromTokenAddress: "0xfrom",
      toTokenAddress: "0xto",
      amount: "1000000",
    });

    const call = (mockFetch.mock.calls as unknown as Array<[URL, { headers: Record<string, string> }]>)[0];
    const url = new URL(String(call[0]));
    const headers = call[1].headers;

    const timestamp = "2026-03-01T00:00:00.000Z";
    const message = `${timestamp}GET${url.pathname}${url.search}`;
    const expectedSign = crypto.createHmac("sha256", "s1").update(message).digest("base64");

    expect(headers["OK-ACCESS-KEY"]).toBe("k1");
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBe("p1");
    expect(headers["OK-ACCESS-PROJECT"]).toBe("proj-1");
    expect(headers["OK-ACCESS-SIGN"]).toBe(expectedSign);
  });

  it("falls back to legacy path on 404/405 when enabled", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse({ code: "404" }, 404))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ fromTokenAmount: "100", toTokenAmount: "1" }] }, 200));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: true,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
    });

    const quote = await client.getQuoteV6({
      chainIndex: "196",
      fromTokenAddress: "0xfrom",
      toTokenAddress: "0xto",
      amount: "1000000",
    });

    expect(Number(quote.fromTokenAmount)).toBe(100);
    expect(client.getIntegrationStatus().lastFallbackAt).toBeTruthy();
  });

  it("maps configured slippage bps into swap request slippage", async () => {
    const mockFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const tokenSymbol = url.searchParams.get("tokenSymbol");
      if (pathname.includes("/market/token/profile/current")) {
        if (tokenSymbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathname.includes("/aggregator/quote")) {
        return jsonResponse({ data: [{ fromTokenAmount: "1000000", toTokenAmount: "500000000000000", dexRouterList: [{ dexName: "dex-a" }] }] });
      }
      if (pathname.includes("/aggregator/swap")) {
        return jsonResponse({ data: [{ txData: "0xabc", to: "0xrouter", value: "0" }] });
      }
      if (pathname.includes("/pre-transaction/simulate")) {
        return jsonResponse({ data: [{ success: true }] });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      slippageBps: 12,
    });

    await client.probeConnection({
      pair: "ETH/USDC",
      chainIndex: "196",
      notionalUsd: 25,
      userWalletAddress: TEST_WALLET,
    });

    const swapCall = (mockFetch.mock.calls as Array<[URL | RequestInfo]>).find(([value]) =>
      new URL(String(value)).pathname.includes("/aggregator/swap"),
    );
    expect(swapCall).toBeTruthy();
    const url = new URL(String(swapCall?.[0]));
    expect(url.searchParams.get("slippage")).toBe("0.12");
  });

  it("resolves token with fresh cache and fails closed on expired cache when remote profile fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-token-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const mockFetch = vi.fn(async () =>
      jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: true,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      userWalletAddress: TEST_WALLET,
    });

    const first = await client.resolveToken("ETH/USDC", "base", "196");
    expect(first.source).toBe("remote");

    const second = await client.resolveToken("ETH/USDC", "base", "196");
    expect(second.source).toBe("cache");

    store.upsertTokenCache({
      symbol: "ETH",
      chainIndex: "196",
      address: "0xeth-old",
      decimals: 18,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const failingFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = failingFetch as unknown as typeof fetch;

    await expect(client.resolveToken("ETH/USDC", "base", "196")).rejects.toThrow("network down");
  });

  it("classifies restricted simulate error for live flow", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-live-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const mockFetch = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ fromTokenAmount: "1000000", toTokenAmount: "330000000000000000" }] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ txData: "0xabc", to: "0xrouter", value: "0" }] }))
      .mockImplementationOnce(async () => jsonResponse({ code: "FORBIDDEN", msg: "whitelist required" }, 403));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executePlan({
      opportunityId: "opp-1",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "a",
      sellDex: "b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 100,
    });

    expect(result.success).toBe(false);
    expect(["permission_denied", "whitelist_restricted"]).toContain(result.errorType);
  });

  it("fails live execution as config_error without a real wallet before backend calls", async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ code: "UNEXPECTED" }, 500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const baseOptions = {
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer" as const,
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
    };
    const plan = {
      opportunityId: "opp-wallet-required",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 10,
    };

    const missingWallet = new OnchainOsClient(baseOptions);
    const missingResult = await missingWallet.executePlan(plan);

    const dummyWallet = new OnchainOsClient({
      ...baseOptions,
      userWalletAddress: "0x1111111111111111111111111111111111111111",
    });
    const dummyResult = await dummyWallet.executePlan(plan);

    expect(missingResult.success).toBe(false);
    expect(missingResult.errorType).toBe("config_error");
    expect(dummyResult.success).toBe(false);
    expect(dummyResult.errorType).toBe("config_error");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("probes v6 integration without broadcasting", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-probe-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const mockFetch = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ fromTokenAmount: "1000000", toTokenAmount: "330000000000000000" }] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ txData: "0xabc", to: "0xrouter", value: "0" }] }))
      .mockImplementationOnce(async () => jsonResponse({ data: [{ success: true, message: "ok" }] }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: true,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
    });

    const probe = await client.probeConnection({
      pair: "ETH/USDC",
      chainIndex: "196",
      notionalUsd: 25,
      userWalletAddress: TEST_WALLET,
    });

    expect(probe.ok).toBe(true);
    expect(probe.mode).toBe("v6");
    expect(probe.quotePath).toContain("/api/v6/dex/aggregator/quote");
    expect(probe.swapPath).toContain("/api/v6/dex/aggregator/swap");
    expect(probe.simulatePath).toContain("/api/v6/dex/pre-transaction/simulate");
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("fails simulation closed when backend omits explicit success fields", async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ data: [{ message: "missing success flag" }] }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
    });

    const result = await client.simulateV6({
      chainIndex: "196",
      txData: "0xabc",
      to: "0xrouter",
      value: "0",
      userWalletAddress: TEST_WALLET,
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("missing success flag");
  });

  it("executes atomic dual-leg with buy/sell dex constraints", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-dual-leg-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const from = url.searchParams.get("fromTokenAddress");
      const to = url.searchParams.get("toTokenAddress");
      const dexIds = url.searchParams.get("dexIds");
      const tokenSymbol = url.searchParams.get("tokenSymbol");

      if (pathname.includes("/market/token/profile/current")) {
        if (tokenSymbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathname.includes("/aggregator/quote")) {
        if (from === "0xusdc" && to === "0xeth") {
          expect(dexIds).toBe("dex-a");
          return jsonResponse({
            data: [
              {
                fromTokenAmount: "100000000",
                toTokenAmount: "50000000000000000",
                estimateGasFee: "0",
                tradeFee: "0",
                dexRouterList: [{ dexName: "dex-a" }],
              },
            ],
          });
        }
        expect(dexIds).toBe("dex-b");
        return jsonResponse({
          data: [
            {
              fromTokenAmount: "50000000000000000",
              toTokenAmount: "100000000",
              estimateGasFee: "0",
              tradeFee: "0",
              dexRouterList: [{ dexName: "dex-b" }],
            },
          ],
        });
      }
      if (pathname.includes("/aggregator/swap")) {
        if (from === "0xusdc" && to === "0xeth") {
          expect(dexIds).toBe("dex-a");
          return jsonResponse({ data: [{ txData: "0xbuy", to: "0xrouter-a", value: "0" }] });
        }
        expect(dexIds).toBe("dex-b");
        return jsonResponse({ data: [{ txData: "0xsell", to: "0xrouter-b", value: "0" }] });
      }
      if (pathname.includes("/pre-transaction/simulate")) {
        return jsonResponse({ data: [{ success: true }] });
      }
      if (pathname.includes("/broadcast-transaction")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { bundleTxs?: Array<{ txData?: string }> };
        expect(Array.isArray(body.bundleTxs)).toBe(true);
        expect(body.bundleTxs?.length).toBe(2);
        return jsonResponse({ data: [{ txHash: "0xatomic-tx-1", atomic: true }] });
      }
      if (pathname.includes("/aggregator/history")) {
        return jsonResponse({ data: [{ status: "confirmed" }] });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executePlan({
      opportunityId: "opp-2",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 100.5,
      notionalUsd: 100,
    });

    expect(result.success).toBe(true);
    expect(result.grossUsd).toBe(0);
    expect(result.netUsd).toBe(0);
    expect(result.txHash).toBe("0xatomic-tx-1");
    expect(result.latencyMs).toBeTypeOf("number");
  });

  it("fails closed when atomic bundle response lacks explicit atomic acknowledgement", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-atomic-ack-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    let broadcastCount = 0;
    const mockFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const from = url.searchParams.get("fromTokenAddress");
      const to = url.searchParams.get("toTokenAddress");
      const tokenSymbol = url.searchParams.get("tokenSymbol");

      if (pathname.includes("/market/token/profile/current")) {
        if (tokenSymbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathname.includes("/aggregator/quote")) {
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({
            data: [{ fromTokenAmount: "10000000", toTokenAmount: "5000000000000000", dexRouterList: [{ dexName: "dex-a" }] }],
          });
        }
        return jsonResponse({
          data: [{ fromTokenAmount: "5000000000000000", toTokenAmount: "10050000", dexRouterList: [{ dexName: "dex-b" }] }],
        });
      }
      if (pathname.includes("/aggregator/swap")) {
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({ data: [{ txData: "0xbuy", to: "0xrouter-a", value: "0" }] });
        }
        return jsonResponse({ data: [{ txData: "0xsell", to: "0xrouter-b", value: "0" }] });
      }
      if (pathname.includes("/pre-transaction/simulate")) {
        return jsonResponse({ data: [{ success: true }] });
      }
      if (pathname.includes("/broadcast-transaction")) {
        broadcastCount += 1;
        return jsonResponse({ data: [{ txHash: "0xnon-atomic-response" }] });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executePlan({
      opportunityId: "opp-atomic-ack",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 10,
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("validation");
    expect(result.error).toContain("ATOMIC_BUNDLE_ACK_REQUIRED");
    expect(broadcastCount).toBe(1);
    expect(store.listAlerts(5).some((alert) => alert.eventType === "atomic_dual_leg_fallback")).toBe(false);
  });

  it("builds bid/ask from real buy and sell quotes on the same dex", async () => {
    const mockFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const from = url.searchParams.get("fromTokenAddress");
      const to = url.searchParams.get("toTokenAddress");
      const dexIds = url.searchParams.get("dexIds");
      const tokenSymbol = url.searchParams.get("tokenSymbol");

      if (pathname.includes("/market/token/profile/current")) {
        if (tokenSymbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathname.includes("/aggregator/quote")) {
        if (dexIds === "dex-a" && from === "0xusdc" && to === "0xeth") {
          return jsonResponse({
            data: [{ fromTokenAmount: "100000000", toTokenAmount: "50000000000000000", estimateGasFee: "1.2" }],
          });
        }
        if (dexIds === "dex-a" && from === "0xeth" && to === "0xusdc") {
          return jsonResponse({
            data: [{ fromTokenAmount: "50000000000000000", toTokenAmount: "99500000", estimateGasFee: "1.4" }],
          });
        }
        if (dexIds === "dex-b" && from === "0xusdc" && to === "0xeth") {
          return jsonResponse({
            data: [{ fromTokenAmount: "100000000", toTokenAmount: "49019607843137250", estimateGasFee: "0.9" }],
          });
        }
        return jsonResponse({
          data: [{ fromTokenAmount: "49019607843137250", toTokenAmount: "100500000", estimateGasFee: "1.1" }],
        });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
    });

    const quotes = await client.getQuotes("ETH/USDC", ["dex-a", "dex-b"]);
    const dexA = quotes.find((quote) => quote.dex === "dex-a");
    const dexB = quotes.find((quote) => quote.dex === "dex-b");

    expect(dexA?.ask).toBeCloseTo(2000, 6);
    expect(dexA?.bid).toBeCloseTo(1990, 6);
    expect(dexA?.gasUsd).toBe(1.4);
    expect(dexB?.ask).toBeCloseTo(2040, 6);
    expect(dexB?.bid).toBeCloseTo(2050.2, 6);
  });

  it("uses conservative live pnl accounting when cost model inputs are configured", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-live-pnl-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const from = url.searchParams.get("fromTokenAddress");
      const to = url.searchParams.get("toTokenAddress");
      const tokenSymbol = url.searchParams.get("tokenSymbol");

      if (pathname.includes("/market/token/profile/current")) {
        if (tokenSymbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathname.includes("/aggregator/quote")) {
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({
            data: [
              {
                fromTokenAmount: "100000000",
                toTokenAmount: "50000000000000000",
                estimateGasFee: "0",
                tradeFee: "0",
                dexRouterList: [{ dexName: "dex-a" }],
              },
            ],
          });
        }
        return jsonResponse({
          data: [
            {
              fromTokenAmount: "50000000000000000",
              toTokenAmount: "101000000",
              estimateGasFee: "0",
              tradeFee: "0",
              dexRouterList: [{ dexName: "dex-b" }],
            },
          ],
        });
      }
      if (pathname.includes("/aggregator/swap")) {
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({ data: [{ txData: "0xbuy", to: "0xrouter-a", value: "0" }] });
        }
        return jsonResponse({ data: [{ txData: "0xsell", to: "0xrouter-b", value: "0" }] });
      }
      if (pathname.includes("/pre-transaction/simulate")) {
        return jsonResponse({ data: [{ success: true }] });
      }
      if (pathname.includes("/broadcast-transaction")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { bundleTxs?: Array<{ txData?: string }> };
        expect(body.bundleTxs?.length).toBe(2);
        return jsonResponse({ data: [{ txHash: "0xatomic-pnl", atomic: true }] });
      }
      if (pathname.includes("/aggregator/history")) {
        return jsonResponse({ data: [{ status: "confirmed" }] });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 0,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      takerFeeBps: 20,
      mevPenaltyBps: 5,
      slippageBps: 12,
      liquidityUsdDefault: 1_000_000,
      volatilityDefault: 0,
      avgLatencyMsDefault: 100,
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executePlan({
      opportunityId: "opp-live-pnl",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 100,
      metadata: {
        liquidityUsd: 1_000_000,
        volatility: 0,
        avgLatencyMs: 100,
      },
    });

    expect(result.success).toBe(true);
    expect(result.grossUsd).toBeCloseTo(1, 6);
    expect(result.feeUsd).toBeGreaterThan(0.4);
    expect(result.netUsd).toBeLessThan(result.grossUsd);
  });

  it("uses settled history amounts and fees for dual-leg pnl when available", async () => {
    let broadcastCount = 0;
    const mockFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const from = url.searchParams.get("fromTokenAddress");
      const to = url.searchParams.get("toTokenAddress");
      const tokenSymbol = url.searchParams.get("tokenSymbol");
      const txHash = url.searchParams.get("txHash");

      if (pathname.includes("/market/token/profile/current")) {
        if (tokenSymbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathname.includes("/aggregator/quote")) {
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({
            data: [
              {
                fromTokenAmount: "100000000",
                toTokenAmount: "50000000000000000",
                estimateGasFee: "0",
                tradeFee: "0",
                dexRouterList: [{ dexName: "dex-a" }],
              },
            ],
          });
        }
        return jsonResponse({
          data: [
            {
              fromTokenAmount: "50000000000000000",
              toTokenAmount: "100000000",
              estimateGasFee: "0",
              tradeFee: "0",
              dexRouterList: [{ dexName: "dex-b" }],
            },
          ],
        });
      }
      if (pathname.includes("/aggregator/swap")) {
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({ data: [{ txData: "0xbuy", to: "0xrouter-a", value: "0" }] });
        }
        return jsonResponse({ data: [{ txData: "0xsell", to: "0xrouter-b", value: "0" }] });
      }
      if (pathname.includes("/broadcast-transaction")) {
        broadcastCount += 1;
        return jsonResponse({ data: [{ txHash: broadcastCount === 1 ? "0xbuytx" : "0xselltx" }] });
      }
      if (pathname.includes("/aggregator/history")) {
        if (txHash === "0xbuytx") {
          return jsonResponse({
            data: [{ fromTokenAmount: "100000000", toTokenAmount: "49000000000000000", gasFee: "2", tradeFee: "1" }],
          });
        }
        return jsonResponse({
          data: [{ fromTokenAmount: "49000000000000000", toTokenAmount: "99000000", gasFee: "3", tradeFee: "1" }],
        });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 0,
      chainIndex: "196",
      requireSimulate: false,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executeDualLeg({
      opportunityId: "opp-history-pnl",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 100,
    });

    expect(result.success).toBe(true);
    expect(result.grossUsd).toBeCloseTo(-1, 6);
    expect(result.feeUsd).toBeCloseTo(7, 6);
    expect(result.netUsd).toBeCloseTo(-8, 6);
  });

  it("fails when quote route does not match constrained dex", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-route-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const mockFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/market/token/profile/current")) {
        const symbol = url.searchParams.get("tokenSymbol");
        if (symbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (url.pathname.includes("/aggregator/quote")) {
        return jsonResponse({
          data: [
            {
              fromTokenAmount: "1000000",
              toTokenAmount: "1000000000000000",
              dexRouterList: [{ dexName: "wrong-dex" }],
            },
          ],
        });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executePlan({
      opportunityId: "opp-3",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 10,
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("validation");
  });

  it("fetches quotes concurrently and drops stale quotes", async () => {
    const quoteStartedAt: Record<string, number> = {};
    const mockFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/market/token/profile/current")) {
        const symbol = url.searchParams.get("tokenSymbol");
        if (symbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (url.pathname.includes("/aggregator/quote")) {
        const dexIds = String(url.searchParams.get("dexIds") ?? "");
        if (!(dexIds in quoteStartedAt)) {
          quoteStartedAt[dexIds] = Date.now();
        }
        if (dexIds === "dex-a") {
          await new Promise((resolve) => setTimeout(resolve, 80));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const from = url.searchParams.get("fromTokenAddress");
        const to = url.searchParams.get("toTokenAddress");
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({
            data: [{ fromTokenAmount: "100000000", toTokenAmount: "50000000000000000", dexRouterList: [{ dexName: dexIds }] }],
          });
        }
        return jsonResponse({
          data: [{ fromTokenAmount: "50000000000000000", toTokenAmount: "100000000", dexRouterList: [{ dexName: dexIds }] }],
        });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      quoteStaleMs: 30,
    });

    const quotes = await client.getQuotes("ETH/USDC", ["dex-a", "dex-b"]);

    expect(Math.abs(quoteStartedAt["dex-a"] - quoteStartedAt["dex-b"])).toBeLessThan(30);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.dex).toBe("dex-b");
    expect(quotes[0]?.ts).toBeTruthy();
  });

  it("prefers private relay submission when configured", async () => {
    let publicSubmitCount = 0;
    const mockFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "relay.local") {
        return jsonResponse({ data: [{ txHash: "0xrelay-tx", status: "submitted" }] });
      }
      if (url.pathname.includes("/broadcast-transaction")) {
        publicSubmitCount += 1;
        return jsonResponse({ data: [{ txHash: "0xpublic-tx" }] });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      usePrivateSubmit: true,
      relayUrl: "http://relay.local/submit",
    });

    const result = await client.broadcastV6({
      chainIndex: "196",
      txData: "0xabc",
      to: "0xrouter",
      value: "0",
      userWalletAddress: TEST_WALLET,
    });

    expect(result.txHash).toBe("0xrelay-tx");
    expect(publicSubmitCount).toBe(0);
    expect(client.getIntegrationStatus().lastSubmitChannel).toBe("private-relay");
  });

  it("does not fall back to serial dual-leg when atomic bundle submit is unavailable by default", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-no-serial-fallback-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    let quoteCount = 0;
    let swapCount = 0;
    let broadcastCount = 0;
    const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const symbol = url.searchParams.get("tokenSymbol");
      const from = url.searchParams.get("fromTokenAddress");
      const to = url.searchParams.get("toTokenAddress");

      if (pathname.includes("/market/token/profile/current")) {
        if (symbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathname.includes("/aggregator/quote")) {
        quoteCount += 1;
        if (from === "0xusdc" && to === "0xeth") {
          return jsonResponse({
            data: [{ fromTokenAmount: "1000000", toTokenAmount: "2000000000000000", dexRouterList: [{ dexName: "dex-a" }] }],
          });
        }
        return jsonResponse({
          data: [{ fromTokenAmount: "2000000000000000", toTokenAmount: "1005000", dexRouterList: [{ dexName: "dex-b" }] }],
        });
      }
      if (pathname.includes("/aggregator/swap")) {
        swapCount += 1;
        return jsonResponse({ data: [{ txData: `0xswap-${swapCount}`, to: "0xrouter", value: "0" }] });
      }
      if (pathname.includes("/broadcast-transaction")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { bundleTxs?: Array<{ txData?: string }> };
        expect(body.bundleTxs?.length).toBe(2);
        broadcastCount += 1;
        return jsonResponse({ code: "NOT_SUPPORTED", msg: "bundle unsupported" }, 404);
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: false,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executePlan({
      opportunityId: "opp-no-serial-fallback",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 1,
    });

    const alerts = store.listAlerts(5);
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("network");
    expect(quoteCount).toBe(2);
    expect(swapCount).toBe(2);
    expect(broadcastCount).toBe(1);
    expect(alerts.some((alert) => alert.eventType === "atomic_dual_leg_fallback")).toBe(false);
    expect(alerts.some((alert) => alert.eventType === "dual_leg_partial_fill")).toBe(false);
  });

  it("falls back to serial + hedge when atomic bundle submit is unavailable and explicitly enabled", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-partial-"));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    let quoteCount = 0;
    let swapCount = 0;
    let broadcastCount = 0;
    const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathName = url.pathname;
      const symbol = url.searchParams.get("tokenSymbol");
      const dexIds = url.searchParams.get("dexIds");

      if (pathName.includes("/market/token/profile/current")) {
        if (symbol === "USDC") {
          return jsonResponse({ data: [{ tokenContractAddress: "0xusdc", tokenDecimal: "6" }] });
        }
        return jsonResponse({ data: [{ tokenContractAddress: "0xeth", tokenDecimal: "18" }] });
      }
      if (pathName.includes("/aggregator/quote")) {
        quoteCount += 1;
        if (quoteCount === 1 || quoteCount === 3) {
          expect(dexIds).toBe("dex-a");
          return jsonResponse({
            data: [{ fromTokenAmount: "1000000", toTokenAmount: "2000000000000000", dexRouterList: [{ dexName: "dex-a" }] }],
          });
        }
        if (quoteCount === 2 || quoteCount === 4 || quoteCount === 5) {
          expect(dexIds).toBe("dex-b");
          return jsonResponse({
            data: [{ fromTokenAmount: "2000000000000000", toTokenAmount: "999000", dexRouterList: [{ dexName: "dex-b" }] }],
          });
        }
        expect(dexIds).toBe("dex-a");
        return jsonResponse({
          data: [{ fromTokenAmount: "2000000000000000", toTokenAmount: "998000", dexRouterList: [{ dexName: "dex-a" }] }],
        });
      }
      if (pathName.includes("/aggregator/swap")) {
        swapCount += 1;
        if (swapCount === 4) {
          return jsonResponse({ code: "FAIL", msg: "sell failed" }, 500);
        }
        return jsonResponse({ data: [{ txData: `0xswap-${swapCount}`, to: "0xrouter", value: "0" }] });
      }
      if (pathName.includes("/pre-transaction/simulate")) {
        return jsonResponse({ data: [{ success: true }] });
      }
      if (pathName.includes("/broadcast-transaction")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { bundleTxs?: Array<{ txData?: string }> };
        if (Array.isArray(body.bundleTxs) && body.bundleTxs.length === 2) {
          return jsonResponse({ code: "NOT_SUPPORTED", msg: "bundle unsupported" }, 404);
        }
        broadcastCount += 1;
        return jsonResponse({ data: [{ txHash: `0xhedge-${broadcastCount}` }] });
      }
      if (pathName.includes("/aggregator/history")) {
        return jsonResponse({ data: [{ status: "confirmed" }] });
      }
      return jsonResponse({ code: "404" }, 404);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = new OnchainOsClient({
      apiBase: "http://localhost:9999",
      apiKey: "k1",
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: false,
      enableCompatFallback: false,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
      allowSerialDualLeg: true,
      userWalletAddress: TEST_WALLET,
    });

    const result = await client.executePlan({
      opportunityId: "opp-4",
      strategyId: "dex-arbitrage",
      pair: "ETH/USDC",
      buyDex: "dex-a",
      sellDex: "dex-b",
      buyPrice: 100,
      sellPrice: 101,
      notionalUsd: 1,
    });

    const alerts = store.listAlerts(5);
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("validation");
    expect(result.netUsd).toBeLessThan(0);
    expect(result.txHash).toContain("0xhedge-");
    expect(alerts.some((alert) => alert.eventType === "atomic_dual_leg_fallback")).toBe(true);
    expect(alerts.some((alert) => alert.eventType === "dual_leg_partial_fill")).toBe(true);
    expect(alerts.some((alert) => alert.message.includes("hedge=submitted"))).toBe(true);
  });
});
