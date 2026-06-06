import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/skills/alphaos/api/server";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";
import type {
  DiscoveryApproveResult,
  DiscoveryCandidate,
  DiscoveryReport,
  DiscoverySession,
  EngineModeResponse,
  SkillManifest,
} from "../src/skills/alphaos/types";

const stores: Array<{ dir: string; store: StateStore }> = [];
const API_SECRET = "discovery-api-test-secret";

type ApiResponse = {
  status: number;
  body: unknown;
};

afterEach(() => {
  for (const entry of stores.splice(0)) {
    entry.store.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

function setupStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-discovery-api-"));
  const store = new StateStore(dir);
  stores.push({ dir, store });
  return store;
}

function auth() {
  return { Authorization: `Bearer ${API_SECRET}` };
}

async function invokeApi(
  app: ReturnType<typeof createServer>,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<ApiResponse> {
  const socket = new PassThrough();
  (socket as { remoteAddress?: string }).remoteAddress = "127.0.0.1";
  const socketDestroy = socket.destroy.bind(socket);
  (socket as { destroy: () => PassThrough }).destroy = () => socket;

  let raw = "";
  const write = socket.write.bind(socket);
  (socket as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
    const chunk = args[0];
    if (Buffer.isBuffer(chunk)) {
      raw += chunk.toString("utf8");
    } else if (typeof chunk === "string") {
      raw += chunk;
    }
    return write(...(args as Parameters<typeof write>));
  };

  const req = new http.IncomingMessage(socket as never);
  req.method = method;
  req.url = url;
  req.headers = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    req.headers[key.toLowerCase()] = value;
  }

  const payloadText = payload ? JSON.stringify(payload) : undefined;
  if (payloadText) {
    req.push(payloadText);
    req.headers["content-type"] = "application/json";
    req.headers["content-length"] = String(Buffer.byteLength(payloadText));
  }
  req.push(null);

  const res = new http.ServerResponse(req);
  res.assignSocket(socket as never);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`request timeout ${method} ${url}`)), 1500);
    const clear = () => clearTimeout(timeout);

    req.on("error", (error) => {
      clear();
      reject(error);
    });
    res.on("error", (error) => {
      clear();
      reject(error);
    });
    res.on("finish", () => {
      clear();
      resolve();
    });

    (
      app as unknown as {
        handle: (r: http.IncomingMessage, s: http.ServerResponse, n: (e?: unknown) => void) => void;
      }
    ).handle(req, res, (error?: unknown) => {
      if (error) {
        clear();
        reject(error);
      }
    });
  });

  const splitAt = raw.indexOf("\r\n\r\n");
  const text = splitAt >= 0 ? raw.slice(splitAt + 4) : "";
  socketDestroy();

  return {
    status: res.statusCode,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

function createDiscoveryStub() {
  const startedAt = new Date().toISOString();
  const plannedEndAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const session: DiscoverySession = {
    id: "session-1",
    strategyId: "spread-threshold",
    status: "active",
    pairs: ["ETH/USDC"],
    startedAt,
    plannedEndAt,
    config: {
      strategyId: "spread-threshold",
      pairs: ["ETH/USDC"],
      durationMinutes: 30,
      sampleIntervalSec: 5,
      topN: 20,
      lookbackSamples: 60,
      zEnter: 2,
      volRatioMin: 1.8,
      minSpreadBps: 35,
      notionalUsd: 1000,
    },
  };

  const candidate: DiscoveryCandidate = {
    id: "candidate-1",
    sessionId: session.id,
    strategyId: "spread-threshold",
    pair: "ETH/USDC",
    buyDex: "a",
    sellDex: "b",
    signalTs: startedAt,
    score: 50,
    expectedNetBps: 40,
    expectedNetUsd: 4,
    confidence: 0.8,
    reason: "spread signal",
    input: { spreadBps: 120, notionalUsd: 1000 },
    status: "pending",
  };

  const report: DiscoveryReport = {
    sessionId: session.id,
    generatedAt: new Date().toISOString(),
    summary: {
      strategyId: "spread-threshold",
      startedAt,
      endedAt: undefined,
      pairs: ["ETH/USDC"],
      status: "active",
      samples: 1,
      candidates: 1,
      topPair: "ETH/USDC",
      topScore: 50,
    },
    topCandidates: [candidate],
    charts: {
      "ETH/USDC": [
        {
          ts: startedAt,
          pair: "ETH/USDC",
          spreadBps: 120,
          volatility: 8,
          zScore: 2.6,
        },
      ],
    },
  };

  let active: DiscoverySession | null = null;
  const approveCalls: Array<{ sessionId: string; candidateId: string; mode: "paper" | "live" }> = [];

  return {
    approveCalls,
    async startSession(input: { strategyId: string; pairs: string[] }): Promise<DiscoverySession> {
      if (active) {
        const error = new Error("active already exists");
        (error as { code?: string }).code = "session_conflict";
        throw error;
      }
      session.strategyId = input.strategyId as DiscoverySession["strategyId"];
      session.pairs = input.pairs;
      active = session;
      return session;
    },
    getActiveSession(): DiscoverySession | null {
      return active;
    },
    getSession(id: string): DiscoverySession | null {
      return id === session.id ? session : null;
    },
    listCandidates(id: string): DiscoveryCandidate[] {
      return id === session.id ? [candidate] : [];
    },
    getReport(id: string): DiscoveryReport | null {
      return id === session.id ? report : null;
    },
    async stopSession(id: string): Promise<DiscoverySession> {
      if (id !== session.id) {
        const error = new Error("not found");
        (error as { code?: string }).code = "not_found";
        throw error;
      }
      session.status = "stopped";
      session.endedAt = new Date().toISOString();
      active = null;
      return session;
    },
    async approveCandidate(id: string, candidateId: string, mode: "paper" | "live"): Promise<DiscoveryApproveResult> {
      approveCalls.push({ sessionId: id, candidateId, mode });
      if (id !== session.id || candidateId !== candidate.id) {
        const error = new Error("candidate not found");
        (error as { code?: string }).code = "candidate_not_found";
        throw error;
      }
      session.status = "completed";
      candidate.status = "executed";
      return {
        approved: true,
        sessionId: session.id,
        candidateId: candidate.id,
        mode,
        effectiveMode: mode,
        opportunityId: "opp-1",
        simulation: {
          grossUsd: 5,
          feeUsd: 1,
          netUsd: 4,
          netEdgeBps: 40,
          pFail: 0.1,
          expectedShortfall: 0.2,
          latencyAdjustedNetUsd: 3.8,
          pass: true,
          reason: "ok",
        },
        tradeResult: {
          success: true,
          txHash: "tx-1",
          status: "confirmed",
          grossUsd: 5,
          feeUsd: 1,
          netUsd: 4,
        },
        degradedToPaper: false,
        tradeId: "trade-1",
      };
    },
  };
}

function makeAdapterInputs() {
  return {
    market: {
      spot: {
        provider: {
          sourceSkill: "binance/spot",
          payload: {
            pair: "ETH/USDC",
            bid: 2048.1,
            ask: 2048.6,
            quoteTs: "2026-03-17T01:00:00.000Z",
            chainId: 56,
          },
        },
      },
    },
    readiness: {
      assets: {
        provider: {
          sourceSkill: "binance/assets",
          payload: {
            accountScope: "default",
            availableNotionalUsd: 2500,
            requiredNotionalUsd: 1000,
            baseAssetReady: true,
            quoteAssetReady: true,
          },
        },
      },
    },
    enrichment: {
      tokenInfo: {
        provider: {
          sourceSkill: "binance-web3/query-token-info",
          payload: {
            name: "Wrapped Ether",
            symbol: "ETH",
            chainId: 56,
          },
        },
      },
      tokenAudit: {
        provider: {
          sourceSkill: "binance-web3/query-token-audit",
          payload: {
            tokenRisk: "normal",
            auditFlags: [],
          },
        },
      },
    },
  };
}

describe("discovery api", () => {
  it("exposes discovery session lifecycle endpoints with auth and validation", async () => {
    const store = setupStore();
    const engine = {
      getCurrentMode: () => "paper",
      requestMode: (mode: "paper" | "live"): EngineModeResponse => ({
        ok: true,
        requestedMode: mode,
        currentMode: mode,
        reasons: [],
      }),
    };
    const manifest: SkillManifest = {
      id: "alphaos",
      version: "0.2.0",
      description: "test",
      strategyIds: ["dex-arbitrage"],
    };
    const discovery = createDiscoveryStub();
    const app = createServer(engine as never, store, manifest, {
      discoveryEngine: discovery as never,
      apiSecret: API_SECRET,
      demoPublic: false,
    });

    const unauthorized = await invokeApi(app, "GET", "/api/v1/discovery/sessions/active");
    expect(unauthorized.status).toBe(401);

    const invalidStart = await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/start",
      { strategyId: "bad", pairs: [] },
      auth(),
    );
    expect(invalidStart.status).toBe(400);

    const start = await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/start",
      {
        strategyId: "spread-threshold",
        pairs: ["eth/usdc"],
        durationMinutes: 10,
        sampleIntervalSec: 5,
        topN: 20,
      },
      auth(),
    );
    expect(start.status).toBe(200);
    expect((start.body as { sessionId: string }).sessionId).toBe("session-1");

    const conflict = await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/start",
      { strategyId: "spread-threshold", pairs: ["ETH/USDC"] },
      auth(),
    );
    expect(conflict.status).toBe(409);

    const active = await invokeApi(app, "GET", "/api/v1/discovery/sessions/active", undefined, auth());
    expect(active.status).toBe(200);
    expect((active.body as { id: string }).id).toBe("session-1");

    const session = await invokeApi(app, "GET", "/api/v1/discovery/sessions/session-1", undefined, auth());
    expect(session.status).toBe(200);
    expect((session.body as { id: string }).id).toBe("session-1");

    const candidates = await invokeApi(
      app,
      "GET",
      "/api/v1/discovery/sessions/session-1/candidates?limit=1",
      undefined,
      auth(),
    );
    expect(candidates.status).toBe(200);
    expect((candidates.body as { items: unknown[] }).items.length).toBe(1);

    const report = await invokeApi(
      app,
      "GET",
      "/api/v1/discovery/sessions/session-1/report",
      undefined,
      auth(),
    );
    expect(report.status).toBe(200);
    expect((report.body as { summary: { topPair: string } }).summary.topPair).toBe("ETH/USDC");

    const badApprove = await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/session-1/approve",
      { candidateId: "candidate-1", mode: "foo" },
      auth(),
    );
    expect(badApprove.status).toBe(400);

    const approve = await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/session-1/approve",
      {
        candidateId: "candidate-1",
        mode: "paper",
        adapterInputs: makeAdapterInputs(),
      },
      auth(),
    );
    expect(approve.status).toBe(200);
    expect((approve.body as { approved: boolean }).approved).toBe(true);
    const moduleResponse = (approve.body as {
      skillAttribution: {
        skillSources: string[];
        requiredSkillsUsed: string[];
        enrichmentSkillsUsed: string[];
        distributionSkillsUsed: string[];
      };
      moduleResponse: {
        module: string;
        marketContext?: { pair: string; sourceSkill: string };
        readinessContext?: { balanceReady: boolean; sourceSkill: string };
        enrichmentContext?: { sourceSkills: string[] };
        skillUsage: { required: string[]; enrichment: string[] };
      };
    });
    expect(moduleResponse.skillAttribution.skillSources).toEqual(
      expect.arrayContaining([
        "binance/spot",
        "binance/assets",
        "binance-web3/query-token-info",
        "binance-web3/query-token-audit",
      ]),
    );
    expect(moduleResponse.skillAttribution.requiredSkillsUsed).toEqual(
      expect.arrayContaining(["binance/spot", "binance/assets"]),
    );
    expect(moduleResponse.skillAttribution.enrichmentSkillsUsed).toEqual(
      expect.arrayContaining(["binance-web3/query-token-info", "binance-web3/query-token-audit"]),
    );
    expect(moduleResponse.skillAttribution.distributionSkillsUsed).toEqual([]);
    const adapted = moduleResponse.moduleResponse;
    expect(adapted.module).toBe("arbitrage");
    expect(adapted.marketContext?.pair).toBe("ETH/USDC");
    expect(adapted.marketContext?.sourceSkill).toBe("binance/spot");
    expect(adapted.readinessContext?.balanceReady).toBe(true);
    expect(adapted.readinessContext?.sourceSkill).toBe("binance/assets");
    expect(adapted.enrichmentContext?.sourceSkills).toEqual(
      expect.arrayContaining(["binance-web3/query-token-info", "binance-web3/query-token-audit"]),
    );
    expect(adapted.skillUsage.required).toEqual(expect.arrayContaining(["binance/spot", "binance/assets"]));
    expect(adapted.skillUsage.enrichment).toEqual(
      expect.arrayContaining(["binance-web3/query-token-info", "binance-web3/query-token-audit"]),
    );

    const stop = await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/session-1/stop",
      undefined,
      auth(),
    );
    expect(stop.status).toBe(200);
    expect((stop.body as { status: string }).status).toBe("stopped");
  });

  it("passes live approval requests through the production approval route", async () => {
    const store = setupStore();
    const engine = {
      getCurrentMode: () => "paper",
      requestMode: (mode: "paper" | "live"): EngineModeResponse => ({
        ok: true,
        requestedMode: mode,
        currentMode: mode,
        reasons: [],
      }),
    };
    const manifest: SkillManifest = {
      id: "alphaos",
      version: "0.2.0",
      description: "test",
      strategyIds: ["dex-arbitrage"],
    };
    const discovery = createDiscoveryStub();
    const app = createServer(engine as never, store, manifest, {
      discoveryEngine: discovery as never,
      apiSecret: API_SECRET,
      demoPublic: false,
    });

    await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/start",
      {
        strategyId: "spread-threshold",
        pairs: ["eth/usdc"],
      },
      auth(),
    );

    const approve = await invokeApi(
      app,
      "POST",
      "/api/v1/discovery/sessions/session-1/approve",
      {
        candidateId: "candidate-1",
        mode: "live",
        adapterInputs: makeAdapterInputs(),
      },
      auth(),
    );
    expect(approve.status).toBe(200);

    const body = approve.body as {
      mode: string;
      effectiveMode: string;
      skillAttribution: {
        requiredSkillsUsed: string[];
        enrichmentSkillsUsed: string[];
      };
      moduleResponse: {
        module: string;
        execution?: {
          requestedMode: string;
          effectiveMode: string;
          tradeStatus?: string;
        };
      };
    };
    expect(body.mode).toBe("live");
    expect(body.effectiveMode).toBe("live");
    expect(body.moduleResponse.module).toBe("arbitrage");
    expect(body.moduleResponse.execution?.requestedMode).toBe("live");
    expect(body.moduleResponse.execution?.effectiveMode).toBe("live");
    expect(body.moduleResponse.execution?.tradeStatus).toBe("confirmed");
    expect(body.skillAttribution.requiredSkillsUsed).toEqual(expect.arrayContaining(["binance/spot", "binance/assets"]));
    expect(body.skillAttribution.enrichmentSkillsUsed).toEqual(
      expect.arrayContaining(["binance-web3/query-token-info", "binance-web3/query-token-audit"]),
    );
    expect(discovery.approveCalls).toEqual([
      {
        sessionId: "session-1",
        candidateId: "candidate-1",
        mode: "live",
      },
    ]);
  });
});
