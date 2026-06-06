import crypto from "node:crypto";
import type {
  ExecutionPlan,
  OnchainIntegrationStatus,
  OnchainProbeResult,
  OnchainV6BroadcastResponse,
  OnchainV6QuoteRequest,
  OnchainV6QuoteResponse,
  OnchainV6SimulateResponse,
  OnchainV6SwapRequest,
  OnchainV6SwapResponse,
  Quote,
  TokenResolution,
  TradeResult,
} from "../types";
import { StateStore } from "./state-store";
import { calculateCostBreakdown, calculateGrossEdgeBps } from "./cost-model";

type AuthMode = "bearer" | "api-key" | "hmac";
type SubmitChannel = "public" | "private-rpc" | "private-relay";
type BroadcastBundleTx = {
  txData?: string;
  to?: string;
  value?: string;
};

type QuoteWire = {
  fromTokenAmount?: string;
  toTokenAmount?: string;
  estimateGasFee?: string;
  tradeFee?: string;
  dexRouterList?: Array<{
    dexName?: string;
    fromTokenAmount?: string;
    toTokenAmount?: string;
  }>;
};

const DEFAULT_QUOTE_STALE_MS = 1000;
const DUMMY_USER_WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

export interface OnchainOsClientOptions {
  apiBase?: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  projectId?: string;
  authMode: AuthMode;
  apiKeyHeader: string;
  gasUsdDefault: number;
  chainIndex: string;
  requireSimulate: boolean;
  enableCompatFallback: boolean;
  allowSerialDualLeg?: boolean;
  userWalletAddress?: string;
  tokenCacheTtlSeconds: number;
  tokenProfilePath: string;
  privateRpcUrl?: string;
  relayUrl?: string;
  usePrivateSubmit?: boolean;
  quoteStaleMs?: number;
  store?: StateStore;
  takerFeeBps?: number;
  mevPenaltyBps?: number;
  slippageBps?: number;
  liquidityUsdDefault?: number;
  volatilityDefault?: number;
  avgLatencyMsDefault?: number;
}

class OnchainApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly path?: string,
  ) {
    super(message);
  }

  get isRestricted(): boolean {
    if (this.status === 401 || this.status === 403) {
      return true;
    }
    const text = `${this.code ?? ""} ${this.message}`.toLowerCase();
    return text.includes("whitelist") || text.includes("permission") || text.includes("unauthorized");
  }
}

function toNumber(input: unknown, fallback = 0): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function toPositiveIntegerString(input: unknown): string | null {
  if (typeof input === "string") {
    const value = input.trim();
    if (/^\d+$/.test(value) && BigInt(value) > 0n) {
      return value;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return String(Math.floor(numeric));
    }
    return null;
  }
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return String(Math.floor(input));
  }
  return null;
}

function toTokenUnits(input: unknown, decimals: number, fallback = 0): number {
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value / 10 ** Math.max(0, decimals);
}

function asFiniteNumber(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) ? input : null;
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function toSnakeCase(value: string): string {
  return value.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function prefixedHistoryKeys(leg: "buy" | "sell", keys: string[]): string[] {
  const prefixes = leg === "buy" ? ["buy", "buyLeg"] : ["sell", "sellLeg"];
  return prefixes.flatMap((prefix) =>
    keys.flatMap((key) => [`${prefix}${capitalize(key)}`, `${prefix}_${toSnakeCase(key)}`]),
  );
}

function normalizeUserWalletAddress(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const value = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return null;
  }
  const lowered = value.toLowerCase();
  if (lowered === DUMMY_USER_WALLET_ADDRESS || /^0x0{40}$/.test(lowered)) {
    return null;
  }
  return value;
}

function splitPair(pair: string): { base: string; quote: string } {
  const [baseRaw, quoteRaw] = pair.toUpperCase().split("/");
  return {
    base: (baseRaw ?? "ETH").trim(),
    quote: (quoteRaw ?? "USDC").trim(),
  };
}

const V6_PATHS = {
  quote: ["/api/v6/dex/aggregator/quote"],
  swap: ["/api/v6/dex/aggregator/swap"],
  history: ["/api/v6/dex/aggregator/history"],
  simulate: ["/api/v6/dex/pre-transaction/simulate"],
  broadcast: ["/api/v6/dex/pre-transaction/broadcast-transaction"],
};

const LEGACY_PATHS = {
  quote: ["/market/quote", "/api/v1/market/quote", "/dex/quote"],
  swap: ["/trade/arbitrage", "/api/v1/trade/arbitrage", "/swap/arbitrage"],
  history: ["/api/v1/trade/history"],
  simulate: ["/api/v1/trade/simulate"],
  broadcast: ["/api/v1/trade/broadcast"],
};

export class OnchainOsClient {
  private diagnostics: OnchainIntegrationStatus;
  private readonly quoteStaleMs: number;

  constructor(private readonly options: OnchainOsClientOptions) {
    this.quoteStaleMs = Math.max(1, Math.floor(options.quoteStaleMs ?? DEFAULT_QUOTE_STALE_MS));
    this.diagnostics = {
      authMode: options.authMode,
      v6Preferred: true,
      compatFallbackEnabled: options.enableCompatFallback,
      requireSimulate: options.requireSimulate,
      tokenProfilePath: options.tokenProfilePath,
      chainIndex: options.chainIndex,
      allowSerialDualLeg: options.allowSerialDualLeg === true,
      userWalletConfigured: Boolean(normalizeUserWalletAddress(options.userWalletAddress)),
    };
  }

  getIntegrationStatus(): OnchainIntegrationStatus {
    return { ...this.diagnostics };
  }

  getTokenCacheEntry(symbol: string, chainIndex = this.options.chainIndex) {
    if (!this.options.store) {
      return null;
    }
    return this.options.store.getTokenCache(symbol.toUpperCase(), chainIndex);
  }

  async probeConnection(input?: {
    pair?: string;
    chainIndex?: string;
    notionalUsd?: number;
    userWalletAddress?: string;
  }): Promise<OnchainProbeResult> {
    const checkedAt = new Date().toISOString();
    const pair = (input?.pair ?? "ETH/USDC").toUpperCase();
    const chainIndex = input?.chainIndex ?? this.options.chainIndex;
    const notionalUsdRaw = toNumber(input?.notionalUsd, 25);
    const notionalUsd = Math.max(1, Number(notionalUsdRaw.toFixed(4)));

    if (!this.options.apiBase) {
      return {
        ok: false,
        configured: false,
        mode: "unavailable",
        pair,
        chainIndex,
        notionalUsd,
        simulateRequired: this.options.requireSimulate,
        message: "ONCHAINOS_API_BASE is required for production execution",
        checkedAt,
      };
    }

    let userWalletAddress: string;
    try {
      userWalletAddress = this.pickUserWalletAddress({
        opportunityId: "probe",
        strategyId: "probe",
        pair,
        buyDex: "",
        sellDex: "",
        buyPrice: 0,
        sellPrice: 0,
        notionalUsd,
        metadata: input?.userWalletAddress ? { userWalletAddress: input.userWalletAddress } : {},
      });
    } catch (error) {
      this.recordError(error);
      return {
        ok: false,
        configured: true,
        mode: "v6",
        pair,
        chainIndex,
        notionalUsd,
        simulateRequired: this.options.requireSimulate,
        failureStep: "swap",
        message: String(error),
        checkedAt,
      };
    }

    let quotePath: string | undefined;
    let swapPath: string | undefined;
    let simulatePath: string | undefined;

    try {
      const quoteToken = await this.resolveToken(pair, "quote", chainIndex);
      const baseToken = await this.resolveToken(pair, "base", chainIndex);
      const amount = String(Math.max(1, Math.floor(notionalUsd * 10 ** Math.min(quoteToken.decimals, 6))));

      await this.getQuoteV6({
        chainIndex,
        fromTokenAddress: quoteToken.address,
        toTokenAddress: baseToken.address,
        amount,
      });
      quotePath = this.diagnostics.lastUsedPath;

      const swap = await this.buildSwapV6({
        chainIndex,
        fromTokenAddress: quoteToken.address,
        toTokenAddress: baseToken.address,
        amount,
        userWalletAddress,
        slippage: this.resolveSwapSlippage(),
      });
      swapPath = this.diagnostics.lastUsedPath;

      if (this.options.requireSimulate) {
        const simulate = await this.simulateV6({
          chainIndex,
          txData: swap.txData,
          to: swap.to,
          value: swap.value,
          userWalletAddress,
        });
        simulatePath = this.diagnostics.lastUsedPath;
        if (!simulate.success) {
          return {
            ok: false,
            configured: true,
            mode: "v6",
            pair,
            chainIndex,
            notionalUsd,
            quotePath,
            swapPath,
            simulatePath,
            simulateRequired: this.options.requireSimulate,
            failureStep: "simulate",
            message: simulate.message ?? "simulate returned failed",
            checkedAt,
          };
        }
      }

      return {
        ok: true,
        configured: true,
        mode: "v6",
        pair,
        chainIndex,
        notionalUsd,
        quotePath,
        swapPath,
        simulatePath,
        simulateRequired: this.options.requireSimulate,
        message: "v6 probe passed",
        checkedAt,
      };
    } catch (error) {
      this.recordError(error);
      return {
        ok: false,
        configured: true,
        mode: "v6",
        pair,
        chainIndex,
        notionalUsd,
        quotePath,
        swapPath,
        simulatePath,
        simulateRequired: this.options.requireSimulate,
        failureStep: this.getProbeFailureStep(error),
        message: String(error),
        checkedAt,
      };
    }
  }

  async resolveToken(
    pair: string,
    side: "base" | "quote",
    chainIndex = this.options.chainIndex,
  ): Promise<TokenResolution> {
    const { base, quote } = splitPair(pair);
    const symbol = side === "base" ? base : quote;

    const cached = this.options.store?.getTokenCache(symbol, chainIndex);
    if (cached && new Date(cached.expiresAt).getTime() > Date.now()) {
      return {
        symbol,
        chainIndex,
        address: cached.address,
        decimals: cached.decimals,
        source: "cache",
        updatedAt: cached.updatedAt,
      };
    }

    const remote = await this.fetchTokenProfile(symbol, chainIndex);
    const expiresAt = new Date(Date.now() + this.options.tokenCacheTtlSeconds * 1000).toISOString();
    this.options.store?.upsertTokenCache({
      symbol,
      chainIndex,
      address: remote.address,
      decimals: remote.decimals,
      expiresAt,
    });
    return {
      symbol,
      chainIndex,
      address: remote.address,
      decimals: remote.decimals,
      source: "remote",
      updatedAt: new Date().toISOString(),
    };
  }

  async getQuotes(pair: string, dexes: string[]): Promise<Quote[]> {
    if (!this.options.apiBase) {
      throw new OnchainApiError("getQuotes: ONCHAINOS_API_BASE is required for production quote retrieval", 400, "API_BASE_REQUIRED");
    }

    const quoteToken = await this.resolveToken(pair, "quote", this.options.chainIndex);
    const baseToken = await this.resolveToken(pair, "base", this.options.chainIndex);
    const amount = String(Math.max(1, Math.floor(100 * 10 ** Math.min(quoteToken.decimals, 6))));

    const quoteJobs = dexes.map(async (dex): Promise<Quote | null> => {
      const startedAt = Date.now();
      try {
        const buyQuote = await this.getQuoteV6({
          chainIndex: this.options.chainIndex,
          fromTokenAddress: quoteToken.address,
          toTokenAddress: baseToken.address,
          amount,
          dexIds: dex,
        });
        const sellAmount = toPositiveIntegerString(buyQuote.toTokenAmount);
        if (!sellAmount) {
          return null;
        }
        const sellQuote = await this.getQuoteV6({
          chainIndex: this.options.chainIndex,
          fromTokenAddress: baseToken.address,
          toTokenAddress: quoteToken.address,
          amount: sellAmount,
          dexIds: dex,
        });
        const receivedAt = Date.now();
        if (receivedAt - startedAt > this.quoteStaleMs) {
          return null;
        }

        const buySpendQuote = toTokenUnits(buyQuote.fromTokenAmount, quoteToken.decimals);
        const buyReceiveBase = toTokenUnits(buyQuote.toTokenAmount, baseToken.decimals);
        const sellSpendBase = toTokenUnits(sellQuote.fromTokenAmount, baseToken.decimals);
        const sellReceiveQuote = toTokenUnits(sellQuote.toTokenAmount, quoteToken.decimals);
        if (buySpendQuote <= 0 || buyReceiveBase <= 0 || sellSpendBase <= 0 || sellReceiveQuote <= 0) {
          return null;
        }
        const ask = buySpendQuote / buyReceiveBase;
        const bid = sellReceiveQuote / sellSpendBase;
        return {
          pair,
          dex,
          bid: Number(bid.toFixed(6)),
          ask: Number(ask.toFixed(6)),
          gasUsd: Math.max(
            0.5,
            toNumber(buyQuote.estimateGasFee, this.options.gasUsdDefault),
            toNumber(sellQuote.estimateGasFee, this.options.gasUsdDefault),
          ),
          ts: new Date(receivedAt).toISOString(),
        };
      } catch (error) {
        this.recordError(error);
        return null;
      }
    });
    const quotes = (await Promise.all(quoteJobs)).filter((quote): quote is Quote => quote !== null);

    if (quotes.length === 0) {
      throw new OnchainApiError(`getQuotes: all production quote requests failed for pair=${pair} dexes=[${dexes.join(",")}]`, 502, "QUOTE_UNAVAILABLE");
    }
    return quotes;
  }

  async executePlan(plan: ExecutionPlan): Promise<TradeResult> {
    if (!this.options.apiBase) {
      return {
        success: false,
        txHash: "",
        status: "failed",
        grossUsd: 0,
        feeUsd: 0,
        netUsd: 0,
        error: "executePlan: ONCHAINOS_API_BASE is required for production execution",
        errorType: "config_error",
      };
    }

    try {
      return await this.executeAtomicDualLeg(plan);
    } catch (error) {
      this.recordError(error);
      const apiError = error as OnchainApiError;
      if (apiError instanceof OnchainApiError && apiError.isRestricted) {
        return {
          success: false,
          txHash: "",
          status: "failed",
          grossUsd: 0,
          feeUsd: 0,
          netUsd: 0,
          error: apiError.message,
          errorType: apiError.message.toLowerCase().includes("whitelist")
            ? "whitelist_restricted"
            : "permission_denied",
        };
      }
      const knownValidationCode =
        apiError instanceof OnchainApiError &&
        ["ROUTE_MISMATCH", "SIMULATE_FAILED", "SELL_AMOUNT_INVALID", "DUAL_LEG_PARTIAL", "ATOMIC_BUNDLE_ACK_REQUIRED"].includes(
          apiError.code ?? "",
        );
      const errorType =
        apiError instanceof OnchainApiError && apiError.code === "USER_WALLET_REQUIRED"
          ? "config_error"
          : this.resolveExecutionErrorType(apiError, knownValidationCode);
      return {
        success: false,
        txHash: "",
        status: "failed",
        grossUsd: 0,
        feeUsd: 0,
        netUsd: 0,
        error:
          apiError instanceof OnchainApiError && apiError.code
            ? `${apiError.code}: ${apiError.message}`
            : String(error),
        errorType,
      };
    }
  }

  async executeAtomicDualLeg(plan: ExecutionPlan): Promise<TradeResult> {
    const startedAt = Date.now();
    const userWalletAddress = this.pickUserWalletAddress(plan);
    const quoteToken = await this.resolveToken(plan.pair, "quote", this.options.chainIndex);
    const baseToken = await this.resolveToken(plan.pair, "base", this.options.chainIndex);
    const buyAmountRaw = Math.max(1, Math.floor(plan.notionalUsd * 10 ** Math.min(quoteToken.decimals, 6)));

    const buyQuote = await this.getQuoteV6({
      chainIndex: this.options.chainIndex,
      fromTokenAddress: quoteToken.address,
      toTokenAddress: baseToken.address,
      amount: String(buyAmountRaw),
      dexIds: plan.buyDex,
    });
    this.assertRouteConstraint(buyQuote, plan.buyDex, "buy");
    const buySwap = await this.buildSwapV6({
      chainIndex: this.options.chainIndex,
      fromTokenAddress: quoteToken.address,
      toTokenAddress: baseToken.address,
      amount: String(buyAmountRaw),
      dexIds: plan.buyDex,
      userWalletAddress,
      slippage: this.resolveSwapSlippage(),
    });

    const sellAmount = Math.max(1, Math.floor(toNumber(buyQuote.toTokenAmount, 0)));
    if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
      throw new OnchainApiError("buy leg returned invalid toTokenAmount", 422, "SELL_AMOUNT_INVALID");
    }

    const sellQuote = await this.getQuoteV6({
      chainIndex: this.options.chainIndex,
      fromTokenAddress: baseToken.address,
      toTokenAddress: quoteToken.address,
      amount: String(sellAmount),
      dexIds: plan.sellDex,
    });
    this.assertRouteConstraint(sellQuote, plan.sellDex, "sell");
    const sellSwap = await this.buildSwapV6({
      chainIndex: this.options.chainIndex,
      fromTokenAddress: baseToken.address,
      toTokenAddress: quoteToken.address,
      amount: String(sellAmount),
      dexIds: plan.sellDex,
      userWalletAddress,
      slippage: this.resolveSwapSlippage(),
    });

    if (this.options.requireSimulate) {
      const [buySimulate, sellSimulate] = await Promise.all([
        this.simulateV6({
          chainIndex: this.options.chainIndex,
          txData: buySwap.txData,
          to: buySwap.to,
          value: buySwap.value,
          userWalletAddress,
        }),
        this.simulateV6({
          chainIndex: this.options.chainIndex,
          txData: sellSwap.txData,
          to: sellSwap.to,
          value: sellSwap.value,
          userWalletAddress,
        }),
      ]);
      if (!buySimulate.success || !sellSimulate.success) {
        throw new OnchainApiError(
          buySimulate.message ?? sellSimulate.message ?? "atomic dual-leg simulate failed",
          400,
          "SIMULATE_FAILED",
        );
      }
    }

    try {
      const atomicBroadcast = await this.broadcastV6({
        chainIndex: this.options.chainIndex,
        userWalletAddress,
        bundleTxs: [
          { txData: buySwap.txData, to: buySwap.to, value: buySwap.value },
          { txData: sellSwap.txData, to: sellSwap.to, value: sellSwap.value },
        ],
      });
      const bundleHistory = await this.getHistoryV6(atomicBroadcast.txHash);
      const settledBuyQuote = this.reconcileSettledQuote(buyQuote, bundleHistory, "buy", false);
      const settledSellQuote = this.reconcileSettledQuote(sellQuote, bundleHistory, "sell", false);

      const executionPnl = this.estimateConservativeExecutionPnl({
        plan,
        quoteTokenDecimals: quoteToken.decimals,
        baseTokenDecimals: baseToken.decimals,
        buyQuote: settledBuyQuote,
        sellQuote: settledSellQuote,
        startedAt,
      });
      return {
        success: true,
        txHash: atomicBroadcast.txHash,
        status: "confirmed",
        grossUsd: executionPnl.grossUsd,
        feeUsd: executionPnl.feeUsd,
        netUsd: executionPnl.netUsd,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (!this.shouldFallbackToSerialDualLeg(error)) {
        throw error;
      }
      this.options.store?.insertAlert("warn", "atomic_dual_leg_fallback", `atomic fallback to serial: ${String(error)}`);
      return this.executeDualLeg(plan, startedAt);
    }
  }

  async executeDualLeg(plan: ExecutionPlan, startedAt = Date.now()): Promise<TradeResult> {
    const userWalletAddress = this.pickUserWalletAddress(plan);
    const quoteToken = await this.resolveToken(plan.pair, "quote", this.options.chainIndex);
    const baseToken = await this.resolveToken(plan.pair, "base", this.options.chainIndex);
    const buyAmountRaw = Math.max(1, Math.floor(plan.notionalUsd * 10 ** Math.min(quoteToken.decimals, 6)));

    const buyLeg = await this.executeLeg({
      chainIndex: this.options.chainIndex,
      fromTokenAddress: quoteToken.address,
      toTokenAddress: baseToken.address,
      amount: String(buyAmountRaw),
      dexId: plan.buyDex,
      userWalletAddress,
      leg: "buy",
    });

    const sellAmount = Math.max(1, Math.floor(toNumber(buyLeg.settledQuote.toTokenAmount, 0)));
    if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
      throw new OnchainApiError("buy leg returned invalid toTokenAmount", 422, "SELL_AMOUNT_INVALID");
    }

    let sellLeg: {
      quote: OnchainV6QuoteResponse;
      settledQuote: OnchainV6QuoteResponse;
      broadcast: OnchainV6BroadcastResponse;
    };
    try {
      sellLeg = await this.executeLeg({
        chainIndex: this.options.chainIndex,
        fromTokenAddress: baseToken.address,
        toTokenAddress: quoteToken.address,
        amount: String(sellAmount),
        dexId: plan.sellDex,
        userWalletAddress,
        leg: "sell",
      });
    } catch (error) {
      const hedge = await this.tryHedgeAfterPartialFill({
        chainIndex: this.options.chainIndex,
        fromTokenAddress: baseToken.address,
        toTokenAddress: quoteToken.address,
        amount: String(sellAmount),
        dexIds: [plan.sellDex, plan.buyDex],
        userWalletAddress,
      });
      const partialMessage =
        `buy leg ok tx=${buyLeg.broadcast.txHash}; sell leg failed on ${plan.sellDex}; ` +
        `hedge=${hedge.leg ? `submitted:${hedge.leg.broadcast.txHash};dex=${hedge.leg.dexId}` : `failed:${hedge.error}`}`;
      this.options.store?.insertAlert("error", "dual_leg_partial_fill", partialMessage);
      if (hedge.leg) {
        const executionPnl = this.estimateConservativeExecutionPnl({
          plan,
          quoteTokenDecimals: quoteToken.decimals,
          baseTokenDecimals: baseToken.decimals,
          buyQuote: buyLeg.settledQuote,
          sellQuote: hedge.leg.settledQuote,
          startedAt,
        });
        return {
          success: false,
          txHash: `${buyLeg.broadcast.txHash},${hedge.leg.broadcast.txHash}`,
          status: "failed",
          grossUsd: executionPnl.grossUsd,
          feeUsd: executionPnl.feeUsd,
          netUsd: executionPnl.netUsd,
          error: `${partialMessage}; err=${String(error)}`,
          errorType: "validation",
          latencyMs: Date.now() - startedAt,
        };
      }

      const buySpendUsd = toTokenUnits(buyLeg.settledQuote.fromTokenAmount, quoteToken.decimals);
      const buyFeeUsd =
        Math.max(0, toNumber(buyLeg.settledQuote.estimateGasFee, this.options.gasUsdDefault)) +
        Math.max(0, toNumber(buyLeg.settledQuote.tradeFee, plan.notionalUsd * 0.0006));
      return {
        success: false,
        txHash: buyLeg.broadcast.txHash,
        status: "failed",
        grossUsd: -buySpendUsd,
        feeUsd: buyFeeUsd,
        netUsd: -buySpendUsd - buyFeeUsd,
        error: `${partialMessage}; err=${String(error)}`,
        errorType: "validation",
        latencyMs: Date.now() - startedAt,
      };
    }

    const executionPnl = this.estimateConservativeExecutionPnl({
      plan,
      quoteTokenDecimals: quoteToken.decimals,
      baseTokenDecimals: baseToken.decimals,
      buyQuote: buyLeg.settledQuote,
      sellQuote: sellLeg.settledQuote,
      startedAt,
    });

    return {
      success: true,
      txHash: `${buyLeg.broadcast.txHash},${sellLeg.broadcast.txHash}`,
      status: "confirmed",
      grossUsd: executionPnl.grossUsd,
      feeUsd: executionPnl.feeUsd,
      netUsd: executionPnl.netUsd,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async executeLeg(input: {
    chainIndex: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    dexId: string;
    userWalletAddress: string;
    leg: "buy" | "sell" | "hedge";
  }): Promise<{
    quote: OnchainV6QuoteResponse;
    settledQuote: OnchainV6QuoteResponse;
    broadcast: OnchainV6BroadcastResponse;
  }> {
    const quote = await this.getQuoteV6({
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      dexIds: input.dexId,
    });
    this.assertRouteConstraint(quote, input.dexId, input.leg);

    const swap = await this.buildSwapV6({
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      dexIds: input.dexId,
      userWalletAddress: input.userWalletAddress,
      slippage: this.resolveSwapSlippage(),
    });

    if (this.options.requireSimulate) {
      const simulate = await this.simulateV6({
        chainIndex: input.chainIndex,
        txData: swap.txData,
        to: swap.to,
        value: swap.value,
        userWalletAddress: input.userWalletAddress,
      });
      if (!simulate.success) {
        throw new OnchainApiError(simulate.message ?? `${input.leg} leg simulate failed`, 400, "SIMULATE_FAILED");
      }
    }

    const broadcast = await this.broadcastV6({
      chainIndex: input.chainIndex,
      txData: swap.txData,
      to: swap.to,
      value: swap.value,
      userWalletAddress: input.userWalletAddress,
    });
    const history = await this.getHistoryV6(broadcast.txHash);
    const settledQuote = this.reconcileSettledQuote(quote, history);
    return { quote, settledQuote, broadcast };
  }

  private async tryHedgeAfterPartialFill(input: {
    chainIndex: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    dexIds: string[];
    userWalletAddress: string;
  }): Promise<
    | {
        leg: {
          dexId: string;
          quote: OnchainV6QuoteResponse;
          settledQuote: OnchainV6QuoteResponse;
          broadcast: OnchainV6BroadcastResponse;
        };
      }
    | { leg: null; error: string }
  > {
    const dedupedDexes = Array.from(new Set(input.dexIds.filter(Boolean)));
    let lastError: unknown;
    for (const dexId of dedupedDexes) {
      try {
        const hedgeLeg = await this.executeLeg({
          chainIndex: input.chainIndex,
          fromTokenAddress: input.fromTokenAddress,
          toTokenAddress: input.toTokenAddress,
          amount: input.amount,
          dexId,
          userWalletAddress: input.userWalletAddress,
          leg: "hedge",
        });
        return {
          leg: {
            dexId,
            quote: hedgeLeg.quote,
            settledQuote: hedgeLeg.settledQuote,
            broadcast: hedgeLeg.broadcast,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }
    return { leg: null, error: String(lastError) };
  }

  private pickUserWalletAddress(plan: ExecutionPlan): string {
    const fromPlan = normalizeUserWalletAddress(plan.metadata?.userWalletAddress);
    const fromConfig = normalizeUserWalletAddress(this.options.userWalletAddress);
    const address = fromPlan ?? fromConfig;
    if (!address) {
      throw new OnchainApiError(
        "live userWalletAddress is required; set ONCHAINOS_USER_WALLET_ADDRESS or plan metadata.userWalletAddress",
        400,
        "USER_WALLET_REQUIRED",
      );
    }
    return address;
  }

  private shouldFallbackToSerialDualLeg(error: unknown): boolean {
    if (this.options.allowSerialDualLeg !== true) {
      return false;
    }
    const apiError = error as OnchainApiError;
    const status = apiError instanceof OnchainApiError ? apiError.status : undefined;
    if (status !== undefined && [404, 405, 501].includes(status)) {
      return true;
    }
    const text = String(error).toLowerCase();
    return text.includes("bundle") && (text.includes("unsupported") || text.includes("not found"));
  }

  private assertRouteConstraint(quote: OnchainV6QuoteResponse, expectedDex: string, leg: "buy" | "sell" | "hedge") {
    const routers = quote.dexRouterList ?? [];
    if (routers.length === 0) {
      return;
    }
    const target = expectedDex.toLowerCase();
    const matched = routers.some((router) => (router.dexName ?? "").toLowerCase().includes(target));
    if (!matched) {
      throw new OnchainApiError(
        `${leg} leg route mismatch: expected dex ${expectedDex}`,
        422,
        "ROUTE_MISMATCH",
      );
    }
  }

  async getQuoteV6(input: OnchainV6QuoteRequest): Promise<OnchainV6QuoteResponse> {
    const query = {
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      ...(input.dexIds ? { dexIds: input.dexIds } : {}),
    };

    const payload = await this.requestWithFallback<QuoteWire>({
      primary: V6_PATHS.quote,
      fallback: LEGACY_PATHS.quote,
      method: "GET",
      query,
    });

    return {
      fromTokenAmount: payload.fromTokenAmount ?? "0",
      toTokenAmount: payload.toTokenAmount ?? "0",
      estimateGasFee: payload.estimateGasFee,
      tradeFee: payload.tradeFee,
      dexRouterList: payload.dexRouterList,
      raw: payload,
    };
  }

  async buildSwapV6(input: OnchainV6SwapRequest): Promise<OnchainV6SwapResponse> {
    const query = {
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      userWalletAddress: input.userWalletAddress,
      ...(input.slippage ? { slippage: input.slippage } : {}),
      ...(input.dexIds ? { dexIds: input.dexIds } : {}),
    };

    const payload = await this.requestWithFallback<Record<string, unknown>>({
      primary: V6_PATHS.swap,
      fallback: LEGACY_PATHS.swap,
      method: "GET",
      query,
    });

    const txData = this.pickString(payload, ["txData", "data", "tx_data"]);
    const to = this.pickString(payload, ["to", "toAddress", "router"]);
    const value = this.pickString(payload, ["value", "txValue", "amountOut"]);
    const gasLimit = this.pickString(payload, ["gasLimit", "gas", "estimateGas"]);
    if (!txData) {
      throw new OnchainApiError("swap payload missing txData", 422, "SWAP_PAYLOAD_INVALID");
    }

    return {
      txData,
      to,
      value,
      gasLimit,
      raw: payload,
    };
  }

  async simulateV6(input: {
    chainIndex: string;
    txData?: string;
    to?: string;
    value?: string;
    userWalletAddress: string;
  }): Promise<OnchainV6SimulateResponse> {
    const payload = await this.requestWithFallback<Record<string, unknown>>({
      primary: V6_PATHS.simulate,
      fallback: LEGACY_PATHS.simulate,
      method: "POST",
      body: {
        chainIndex: input.chainIndex,
        txData: input.txData,
        to: input.to,
        value: input.value,
        userWalletAddress: input.userWalletAddress,
      },
    });

    const successFlag = this.pickBool(payload, ["success", "simulateResult", "ok"], false);
    const message = this.pickString(payload, ["message", "msg", "errorMessage"]);
    return { success: successFlag, message, raw: payload };
  }

  async broadcastV6(input: {
    chainIndex: string;
    txData?: string;
    to?: string;
    value?: string;
    userWalletAddress: string;
    bundleTxs?: BroadcastBundleTx[];
  }): Promise<OnchainV6BroadcastResponse> {
    const body = this.buildBroadcastBody(input);
    const privateChannel = this.pickPrivateChannel();
    if (privateChannel) {
      try {
        const privatePayload = await this.requestDirect<Record<string, unknown>>({
          endpoint: privateChannel.endpoint,
          method: "POST",
          body,
        });
        return this.toBroadcastResponse(
          privatePayload,
          privateChannel.channel,
          Array.isArray(input.bundleTxs) && input.bundleTxs.length > 0,
        );
      } catch (error) {
        this.recordError(error);
        this.options.store?.insertAlert("warn", "private_submit_failed", String(error));
      }
    }

    const publicPayload = await this.requestWithFallback<Record<string, unknown>>({
      primary: V6_PATHS.broadcast,
      fallback: LEGACY_PATHS.broadcast,
      method: "POST",
      body,
    });
    return this.toBroadcastResponse(
      publicPayload,
      "public",
      Array.isArray(input.bundleTxs) && input.bundleTxs.length > 0,
    );
  }

  async getHistoryV6(txHash: string): Promise<Record<string, unknown> | null> {
    if (!txHash) {
      return null;
    }

    try {
      return await this.requestWithFallback<Record<string, unknown>>({
        primary: V6_PATHS.history,
        fallback: LEGACY_PATHS.history,
        method: "GET",
        query: { txHash },
      });
    } catch (error) {
      this.recordError(error);
      return null;
    }
  }

  private buildBroadcastBody(input: {
    chainIndex: string;
    txData?: string;
    to?: string;
    value?: string;
    userWalletAddress: string;
    bundleTxs?: BroadcastBundleTx[];
  }): Record<string, unknown> {
    const bundleTxs = Array.isArray(input.bundleTxs) ? input.bundleTxs : [];
    const hasBundle = bundleTxs.length > 0;
    return {
      chainIndex: input.chainIndex,
      txData: input.txData,
      to: input.to,
      value: input.value,
      userWalletAddress: input.userWalletAddress,
      ...(hasBundle
        ? {
            bundleTxs,
            transactions: bundleTxs,
            txDataList: bundleTxs.map((tx) => tx.txData).filter((tx): tx is string => Boolean(tx)),
            atomic: true,
          }
        : {}),
    };
  }

  private pickPrivateChannel():
    | {
        channel: SubmitChannel;
        endpoint: string;
      }
    | undefined {
    if (!this.options.usePrivateSubmit) {
      return undefined;
    }
    if (this.options.relayUrl) {
      return {
        channel: "private-relay",
        endpoint: this.options.relayUrl,
      };
    }
    if (this.options.privateRpcUrl) {
      return {
        channel: "private-rpc",
        endpoint: this.options.privateRpcUrl,
      };
    }
    return undefined;
  }

  private toBroadcastResponse(
    payload: Record<string, unknown>,
    channel: SubmitChannel,
    requiresAtomicAck = false,
  ): OnchainV6BroadcastResponse {
    const txHash = this.pickString(payload, ["txHash", "hash", "transactionHash"]);
    if (!txHash) {
      throw new OnchainApiError("broadcast response missing txHash", 422, "BROADCAST_PAYLOAD_INVALID");
    }
    if (requiresAtomicAck) {
      this.assertAtomicBundleAcknowledged(payload);
    }
    this.recordSubmitChannel(channel);
    return {
      txHash,
      status: this.pickString(payload, ["status", "txStatus"]),
      raw: payload,
    };
  }

  private recordSubmitChannel(channel: SubmitChannel): void {
    this.diagnostics.lastSubmitChannel = channel;
    this.options.store?.insertAlert("info", "submit_channel", `submit channel=${channel}`);
  }

  private assertAtomicBundleAcknowledged(payload: Record<string, unknown>): void {
    const accepted = this.pickBool(
      payload,
      ["atomic", "atomicAccepted", "atomicBundle", "bundleAtomic", "allOrNothing"],
      false,
    );
    if (accepted) {
      return;
    }

    const status = this.pickString(payload, ["bundleStatus", "atomicStatus", "bundleMode"]);
    if (status && ["atomic", "accepted", "all_or_nothing", "all-or-nothing"].includes(status.toLowerCase())) {
      return;
    }

    throw new OnchainApiError(
      "bundle broadcast response missing explicit atomic acknowledgement",
      422,
      "ATOMIC_BUNDLE_ACK_REQUIRED",
    );
  }

  private resolveSwapSlippage(): string {
    const configuredBps = this.options.slippageBps;
    if (configuredBps === undefined || !Number.isFinite(configuredBps)) {
      return "0.5";
    }
    return String(Math.max(0, configuredBps) / 100);
  }

  private async fetchTokenProfile(symbol: string, chainIndex: string): Promise<{ address: string; decimals: number }> {
    if (!this.options.apiBase) {
      throw new OnchainApiError("token profile requires apiBase", 400, "API_BASE_REQUIRED");
    }

    const payload = await this.requestWithFallback<Record<string, unknown>>({
      primary: [this.options.tokenProfilePath],
      fallback: [],
      method: "GET",
      query: { chainIndex, tokenSymbol: symbol },
      forceDisableFallback: true,
    });

    const address = this.pickString(payload, [
      "tokenContractAddress",
      "tokenAddress",
      "address",
      "contractAddress",
      "token",
    ]);
    const decimals = toNumber(
      this.pickString(payload, ["tokenDecimal", "decimals", "decimal", "tokenDecimals"]),
      18,
    );

    if (!address) {
      throw new OnchainApiError(`token profile missing address for ${symbol}`, 422, "TOKEN_PROFILE_INVALID");
    }

    return {
      address,
      decimals,
    };
  }

  private estimateGrossFromQuotes(
    quoteTokenDecimals: number,
    buyQuote: OnchainV6QuoteResponse,
    sellQuote: OnchainV6QuoteResponse,
  ): number {
    const buySpendRaw = toNumber(buyQuote.fromTokenAmount);
    const sellReceiveRaw = toNumber(sellQuote.toTokenAmount);
    if (buySpendRaw > 0 && sellReceiveRaw > 0) {
      const divisor = 10 ** Math.min(Math.max(0, quoteTokenDecimals), 12);
      return (sellReceiveRaw - buySpendRaw) / divisor;
    }
    return 0;
  }

  private estimateFeeFromQuotes(
    notionalUsd: number,
    buyQuote: OnchainV6QuoteResponse,
    sellQuote: OnchainV6QuoteResponse,
  ): number {
    const buyGas = toNumber(buyQuote.estimateGasFee, this.options.gasUsdDefault);
    const sellGas = toNumber(sellQuote.estimateGasFee, this.options.gasUsdDefault);
    const buyTradeFee = toNumber(buyQuote.tradeFee, notionalUsd * 0.0006);
    const sellTradeFee = toNumber(sellQuote.tradeFee, notionalUsd * 0.0006);
    return buyGas + sellGas + buyTradeFee + sellTradeFee;
  }

  private reconcileSettledQuote(
    quote: OnchainV6QuoteResponse,
    history: Record<string, unknown> | null,
    leg?: "buy" | "sell",
    allowGeneric = true,
  ): OnchainV6QuoteResponse {
    if (!history) {
      return quote;
    }
    const fromKeys = [
      "actualFromTokenAmount",
      "filledFromTokenAmount",
      "executedFromTokenAmount",
      "fromTokenAmount",
      "fromAmount",
      "amountIn",
      "inputAmount",
    ];
    const toKeys = [
      "actualToTokenAmount",
      "filledToTokenAmount",
      "executedToTokenAmount",
      "toTokenAmount",
      "toAmount",
      "amountOut",
      "outputAmount",
    ];
    const gasKeys = [
      "actualGasFee",
      "gasFee",
      "txFee",
      "networkFee",
      "totalGasFee",
      "estimateGasFee",
    ];
    const tradeFeeKeys = ["actualTradeFee", "tradeFee", "protocolFee", "swapFee", "dexFee"];
    return {
      fromTokenAmount:
        this.pickHistoryValue(history, leg, allowGeneric, fromKeys) ?? quote.fromTokenAmount,
      toTokenAmount:
        this.pickHistoryValue(history, leg, allowGeneric, toKeys) ?? quote.toTokenAmount,
      estimateGasFee:
        this.pickHistoryValue(history, leg, allowGeneric, gasKeys) ?? quote.estimateGasFee,
      tradeFee:
        this.pickHistoryValue(history, leg, allowGeneric, tradeFeeKeys) ?? quote.tradeFee,
      dexRouterList: quote.dexRouterList,
      raw: history,
    };
  }

  private pickHistoryValue(
    payload: Record<string, unknown>,
    leg: "buy" | "sell" | undefined,
    allowGeneric: boolean,
    keys: string[],
  ): string | undefined {
    const candidates = [
      ...(leg ? prefixedHistoryKeys(leg, keys) : []),
      ...(allowGeneric ? keys : []),
    ];
    return this.pickString(payload, candidates);
  }

  private estimateConservativeExecutionPnl(input: {
    plan: ExecutionPlan;
    quoteTokenDecimals: number;
    baseTokenDecimals: number;
    buyQuote: OnchainV6QuoteResponse;
    sellQuote: OnchainV6QuoteResponse;
    startedAt: number;
  }): { grossUsd: number; feeUsd: number; netUsd: number } {
    const grossUsd = this.estimateGrossFromQuotes(
      input.quoteTokenDecimals,
      input.buyQuote,
      input.sellQuote,
    );
    const quoteFeeUsd = this.estimateFeeFromQuotes(
      input.plan.notionalUsd,
      input.buyQuote,
      input.sellQuote,
    );
    const costModelConfigured =
      this.options.takerFeeBps !== undefined ||
      this.options.mevPenaltyBps !== undefined ||
      this.options.slippageBps !== undefined;
    if (!costModelConfigured) {
      return {
        grossUsd,
        feeUsd: quoteFeeUsd,
        netUsd: grossUsd - quoteFeeUsd,
      };
    }
    const metadata = input.plan.metadata ?? {};
    const buyPrice = this.estimatePriceFromBuyQuote(
      input.buyQuote,
      input.quoteTokenDecimals,
      input.baseTokenDecimals,
    );
    const sellPrice = this.estimatePriceFromSellQuote(
      input.sellQuote,
      input.quoteTokenDecimals,
      input.baseTokenDecimals,
    );
    const grossEdgeBps = calculateGrossEdgeBps(buyPrice, sellPrice) ?? 0;
    const safeSlippageBps = Math.max(0, this.options.slippageBps ?? 0);
    const fallbackLiquidity =
      this.options.liquidityUsdDefault ??
      Math.max(1000, (input.plan.notionalUsd * 10_000) / Math.max(1, safeSlippageBps || 12));
    const avgLatencyMs = Math.max(
      0,
      Date.now() - input.startedAt,
      asFiniteNumber(metadata.avgLatencyMs) ?? this.options.avgLatencyMsDefault ?? 0,
    );
    const modeledCostUsd = calculateCostBreakdown({
      grossEdgeBps,
      notionalUsd: input.plan.notionalUsd,
      takerFeeBps: Math.max(0, this.options.takerFeeBps ?? 0),
      mevPenaltyBps: Math.max(0, this.options.mevPenaltyBps ?? 0),
      slippageBps: safeSlippageBps,
      liquidityUsd: asFiniteNumber(metadata.liquidityUsd) ?? fallbackLiquidity,
      volatility: asFiniteNumber(metadata.volatility) ?? this.options.volatilityDefault ?? 0,
      avgLatencyMs,
      gasBuyUsd: Math.max(
        0,
        toNumber(input.buyQuote.estimateGasFee, asFiniteNumber(metadata.gasBuyUsd) ?? this.options.gasUsdDefault),
      ),
      gasSellUsd: Math.max(
        0,
        toNumber(input.sellQuote.estimateGasFee, asFiniteNumber(metadata.gasSellUsd) ?? this.options.gasUsdDefault),
      ),
    }).totalCostUsd;
    const feeUsd = Math.max(quoteFeeUsd, modeledCostUsd);
    return {
      grossUsd,
      feeUsd,
      netUsd: grossUsd - feeUsd,
    };
  }

  private estimatePriceFromBuyQuote(
    quote: OnchainV6QuoteResponse,
    quoteTokenDecimals: number,
    baseTokenDecimals: number,
  ): number {
    const spendQuote = toTokenUnits(quote.fromTokenAmount, quoteTokenDecimals);
    const receiveBase = toTokenUnits(quote.toTokenAmount, baseTokenDecimals);
    return spendQuote > 0 && receiveBase > 0 ? spendQuote / receiveBase : 0;
  }

  private estimatePriceFromSellQuote(
    quote: OnchainV6QuoteResponse,
    quoteTokenDecimals: number,
    baseTokenDecimals: number,
  ): number {
    const spendBase = toTokenUnits(quote.fromTokenAmount, baseTokenDecimals);
    const receiveQuote = toTokenUnits(quote.toTokenAmount, quoteTokenDecimals);
    return spendBase > 0 && receiveQuote > 0 ? receiveQuote / spendBase : 0;
  }

  private pickPayload(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const data = obj.data;
      if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object") {
        return data[0] as Record<string, unknown>;
      }
      if (data && typeof data === "object") {
        return data as Record<string, unknown>;
      }
      return obj;
    }
    return {};
  }

  private pickString(payload: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
    return undefined;
  }

  private pickBool(payload: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        return value !== 0;
      }
      if (typeof value === "string") {
        const lowered = value.toLowerCase();
        if (["true", "ok", "success", "1", "pass"].includes(lowered)) {
          return true;
        }
        if (["false", "fail", "failed", "0", "error"].includes(lowered)) {
          return false;
        }
      }
    }
    return fallback;
  }

  private buildAuthHeaders(url: URL, method: string, body?: string): Record<string, string> {
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      return {};
    }

    const headers = this.buildModeAuthHeaders(apiKey, url, method, body);

    if (this.options.projectId) {
      headers["OK-ACCESS-PROJECT"] = this.options.projectId;
    }

    return headers;
  }

  private buildModeAuthHeaders(
    apiKey: string,
    url: URL,
    method: string,
    body?: string,
  ): Record<string, string> {
    switch (this.options.authMode) {
      case "bearer":
        return this.buildBearerAuthHeaders(apiKey);
      case "api-key":
        return this.buildApiKeyHeaders(apiKey);
      case "hmac":
        return this.buildHmacAuthHeaders(apiKey, url, method, body);
      default:
        return {};
    }
  }

  private buildBearerAuthHeaders(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  }

  private buildApiKeyHeaders(apiKey: string): Record<string, string> {
    return { [this.options.apiKeyHeader]: apiKey };
  }

  private buildHmacAuthHeaders(
    apiKey: string,
    url: URL,
    method: string,
    body?: string,
  ): Record<string, string> {
    const apiSecret = this.options.apiSecret;
    if (!apiSecret) {
      return {};
    }

    const timestamp = new Date().toISOString();
    const path = url.pathname;
    const queryString = url.search;
    const signingBody = body ?? "";
    const message = `${timestamp}${method.toUpperCase()}${path}${queryString}${signingBody}`;
    const signature = crypto.createHmac("sha256", apiSecret).update(message).digest("base64");

    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
    };
    if (this.options.passphrase) {
      headers["OK-ACCESS-PASSPHRASE"] = this.options.passphrase;
    }
    return headers;
  }

  private buildUrl(path: string, query?: Record<string, string>): URL {
    const url = new URL(path, this.options.apiBase);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    return url;
  }

  private async requestDirect<T>(params: {
    endpoint: string;
    method: "GET" | "POST";
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }): Promise<T> {
    const url = new URL(params.endpoint);
    if (params.query) {
      for (const [k, v] of Object.entries(params.query)) {
        url.searchParams.set(k, v);
      }
    }
    const bodyText = params.body ? JSON.stringify(params.body) : undefined;
    const headers: Record<string, string> = {
      ...(bodyText ? { "Content-Type": "application/json" } : {}),
      ...this.buildAuthHeaders(url, params.method, bodyText),
    };
    const response = await fetch(url, {
      method: params.method,
      headers,
      ...(bodyText ? { body: bodyText } : {}),
    });
    if (!response.ok) {
      throw await this.parseApiErrorResponse(response, url.pathname);
    }
    return this.parseApiResponse<T>(response);
  }

  private async requestWithFallback<T>(params: {
    primary: string[];
    fallback: string[];
    method: "GET" | "POST";
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    forceDisableFallback?: boolean;
  }): Promise<T> {
    const bodyText = params.body ? JSON.stringify(params.body) : undefined;

    const primaryResult = await this.tryPaths<T>(params.primary, params.method, params.query, bodyText, "v6");
    if (primaryResult.ok) {
      return primaryResult.data;
    }

    if (!primaryResult.fallbackEligible || params.forceDisableFallback || !this.options.enableCompatFallback) {
      throw primaryResult.error ?? new OnchainApiError("primary request failed");
    }

    if (params.fallback.length === 0) {
      throw primaryResult.error ?? new OnchainApiError("fallback unavailable");
    }

    const fallbackResult = await this.tryPaths<T>(
      params.fallback,
      params.method,
      params.query,
      bodyText,
      "fallback",
    );
    if (fallbackResult.ok) {
      this.diagnostics.lastFallbackAt = new Date().toISOString();
      return fallbackResult.data;
    }

    throw fallbackResult.error ?? primaryResult.error ?? new OnchainApiError("request failed with fallback");
  }

  private async tryPaths<T>(
    paths: string[],
    method: "GET" | "POST",
    query: Record<string, string> | undefined,
    bodyText: string | undefined,
    mode: "v6" | "fallback",
  ): Promise<{ ok: true; data: T } | { ok: false; fallbackEligible: boolean; error?: OnchainApiError }> {
    let fallbackEligible = true;
    let lastError: OnchainApiError | undefined;

    for (const path of paths) {
      try {
        const url = this.buildUrl(path, query);
        const headers: Record<string, string> = {
          ...(bodyText ? { "Content-Type": "application/json" } : {}),
          ...this.buildAuthHeaders(url, method, bodyText),
        };

        const response = await fetch(url, {
          method,
          headers,
          ...(bodyText ? { body: bodyText } : {}),
        });

        if (response.ok) {
          const payload = await this.parseApiResponse<T>(response);
          this.diagnostics.lastUsedPath = path;
          this.diagnostics.lastV6SuccessAt = mode === "v6" ? new Date().toISOString() : this.diagnostics.lastV6SuccessAt;
          return { ok: true, data: payload };
        }

        const error = await this.parseApiErrorResponse(response, path);
        if (![404, 405].includes(response.status)) {
          fallbackEligible = false;
        }
        if (error.isRestricted) {
          fallbackEligible = false;
        }
        lastError = error;
      } catch (error) {
        fallbackEligible = false;
        lastError = error instanceof OnchainApiError ? error : new OnchainApiError(String(error));
      }
    }

    return { ok: false, fallbackEligible, error: lastError };
  }

  private async parseApiResponse<T>(response: Response): Promise<T> {
    const raw = (await response.json()) as unknown;
    return this.pickPayload(raw) as T;
  }

  private async parseApiErrorResponse(response: Response, path: string): Promise<OnchainApiError> {
    const responseText = await response.text();
    return new OnchainApiError(
      `request failed ${response.status} ${path}: ${responseText.slice(0, 280)}`,
      response.status,
      this.extractErrorCode(responseText),
      path,
    );
  }

  private extractErrorCode(text: string): string | undefined {
    if (!text) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(text) as { code?: string; msg?: string };
      return parsed.code ?? parsed.msg;
    } catch {
      return undefined;
    }
  }

  private recordError(error: unknown): void {
    this.diagnostics.lastError = String(error);
    this.diagnostics.lastErrorAt = new Date().toISOString();
  }

  private resolveExecutionErrorType(
    error: unknown,
    knownValidationCode: boolean,
  ): "validation" | "network" | "unknown" {
    if (knownValidationCode) {
      return "validation";
    }
    if (error instanceof OnchainApiError) {
      return "network";
    }
    return "unknown";
  }

  private getProbeFailureStep(error: unknown): "token" | "quote" | "swap" | "simulate" {
    const text = String(error).toLowerCase();
    if (text.includes("token")) {
      return "token";
    }
    if (text.includes("quote")) {
      return "quote";
    }
    if (text.includes("swap")) {
      return "swap";
    }
    return "simulate";
  }
}
