import { createPublicClient, http } from "viem";
import type { OnchainIntegrationStatus, OnchainProbeResult } from "../types";
import type { AlphaOsConfig } from "./config";
import type { NetworkProfile, NetworkProfileId } from "./network-profile";
import { getNetworkProfile } from "./network-profile";

export type NetworkProfileReadiness = "ready" | "degraded" | "unavailable";
export type NetworkProfileCheckStatus = "pass" | "warn" | "fail";

export interface NetworkProfileDiagnosticCheck {
  id: string;
  label: string;
  required: boolean;
  status: NetworkProfileCheckStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface NetworkProfileDiagnostics {
  profile: {
    id: NetworkProfileId;
    label: string;
    mode: NetworkProfile["mode"];
  };
  readiness: NetworkProfileReadiness;
  summary: string;
  reasons: string[];
  checkedAt: string;
  activeProbe: boolean;
  checks: NetworkProfileDiagnosticCheck[];
}

export interface NetworkProfileDiagnosticsOptions {
  config: AlphaOsConfig;
  onchainClient?: {
    getIntegrationStatus(): OnchainIntegrationStatus;
    probeConnection(input?: {
      pair?: string;
      chainIndex?: string;
      notionalUsd?: number;
      userWalletAddress?: string;
    }): Promise<OnchainProbeResult>;
    getTokenCacheEntry(symbol: string, chainIndex?: string): { updatedAt?: string } | null;
  };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface RpcProbeResult {
  ok: boolean;
  chainId?: number;
  error?: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeRpcUrl(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}

function splitPair(pair: string): { base: string; quote: string } | null {
  const [base, quote] = pair
    .split("/")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  if (!base || !quote) {
    return null;
  }
  return { base, quote };
}

function isEnvSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function parseNumericChainIndex(chainIndex: string): number | undefined {
  const parsed = Number(chainIndex);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function summarize(profile: NetworkProfile, readiness: NetworkProfileReadiness, reasons: string[]): string {
  if (reasons.length === 0) {
    return `${profile.label} is ${readiness}.`;
  }
  return `${profile.label} is ${readiness}: ${reasons.slice(0, 2).join("; ")}.`;
}

async function probeRpc(rpcUrl: string, timeoutMs: number): Promise<RpcProbeResult> {
  try {
    const client = createPublicClient({
      transport: http(rpcUrl),
    });
    const chainId = await withTimeout(client.getChainId(), timeoutMs, "RPC chainId probe");
    return {
      ok: true,
      chainId,
    };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
  }
}

function upsertCheck(checks: NetworkProfileDiagnosticCheck[], next: NetworkProfileDiagnosticCheck): void {
  const existingIndex = checks.findIndex((check) => check.id === next.id);
  if (existingIndex >= 0) {
    checks[existingIndex] = next;
    return;
  }
  checks.push(next);
}

function buildRequiredInputsCheck(
  profile: NetworkProfile,
  config: AlphaOsConfig,
  env: NodeJS.ProcessEnv,
): NetworkProfileDiagnosticCheck {
  if (profile.id === "xlayer-recommended") {
    return {
      id: "required-inputs",
      label: "Profile defaults / required inputs",
      required: true,
      status: config.commRpcUrl
        ? "pass"
        : "fail",
      summary: config.commRpcUrl
        ? "Profile defaults supply chain 196 and a recommended RPC for the X Layer path"
        : "xlayer-recommended could not resolve a COMM_RPC_URL from env or profile defaults",
      details: {
        commChainId: config.commChainId,
        onchainChainIndex: config.onchainChainIndex,
        commRpcUrl: config.commRpcUrl,
      },
    };
  }

  const hasExplicitChain = isEnvSet(env, "ONCHAINOS_CHAIN_INDEX") || isEnvSet(env, "COMM_CHAIN_ID");
  const hasExplicitRpc = isEnvSet(env, "COMM_RPC_URL");
  const missing: string[] = [];
  if (!hasExplicitChain) {
    missing.push("explicit chain selection");
  }
  if (!hasExplicitRpc) {
    missing.push("COMM_RPC_URL");
  }

  return {
    id: "required-inputs",
    label: "Profile defaults / required inputs",
    required: true,
    status: missing.length === 0 ? "pass" : "fail",
    summary:
      missing.length === 0
        ? "evm-custom received explicit chain and RPC inputs from the user"
        : `evm-custom still needs ${missing.join(" and ")}`,
    details: {
      hasExplicitChain,
      hasExplicitRpc,
      commChainId: config.commChainId,
      onchainChainIndex: config.onchainChainIndex,
      commRpcUrl: config.commRpcUrl,
    },
  };
}

function buildRpcConnectivityCheck(config: AlphaOsConfig): NetworkProfileDiagnosticCheck {
  if (!config.commRpcUrl?.trim()) {
    return {
      id: "rpc-connectivity",
      label: "RPC connectivity",
      required: true,
      status: "fail",
      summary: "COMM_RPC_URL is missing, so RPC readiness cannot be established",
    };
  }

  return {
    id: "rpc-connectivity",
    label: "RPC connectivity",
    required: true,
    status: "pass",
    summary: `RPC is configured at ${describeRpcUrl(config.commRpcUrl)}`,
    details: {
      rpcUrl: config.commRpcUrl,
    },
  };
}

function buildRpcChainCheck(config: AlphaOsConfig): NetworkProfileDiagnosticCheck {
  const targetChainId = parseNumericChainIndex(config.onchainChainIndex);
  if (targetChainId === undefined) {
    return {
      id: "rpc-chain-id",
      label: "RPC chainId consistency",
      required: true,
      status: "fail",
      summary: `ONCHAINOS_CHAIN_INDEX=${config.onchainChainIndex} is not a positive integer chain target`,
      details: {
        onchainChainIndex: config.onchainChainIndex,
        commChainId: config.commChainId,
      },
    };
  }

  if (targetChainId !== config.commChainId) {
    return {
      id: "rpc-chain-id",
      label: "RPC chainId consistency",
      required: true,
      status: "fail",
      summary: `Configured chain target ${targetChainId} does not match COMM_CHAIN_ID=${config.commChainId}`,
      details: {
        configuredChainId: config.commChainId,
        targetChainId,
      },
    };
  }

  return {
    id: "rpc-chain-id",
    label: "RPC chainId consistency",
    required: true,
    status: "pass",
    summary: `Configured chain target ${targetChainId} matches COMM_CHAIN_ID=${config.commChainId}`,
    details: {
      configuredChainId: config.commChainId,
      targetChainId,
    },
  };
}

function buildOnchainStatusCheck(
  config: AlphaOsConfig,
  onchainStatus?: OnchainIntegrationStatus,
): NetworkProfileDiagnosticCheck {
  if (!onchainStatus) {
    return {
      id: "onchain-status",
      label: "Onchain integration status",
      required: false,
      status: "warn",
      summary: "Onchain diagnostics are unavailable because the onchain client is not attached",
    };
  }

  const lastErrorIsCurrent =
    Boolean(onchainStatus.lastError) &&
    (!onchainStatus.lastV6SuccessAt ||
      (onchainStatus.lastErrorAt ?? "") >= (onchainStatus.lastV6SuccessAt ?? ""));

  if (!config.onchainOsApiBase?.trim()) {
    return {
      id: "onchain-status",
      label: "Onchain integration status",
      required: false,
      status: "warn",
      summary: "ONCHAINOS_API_BASE is not configured, so production quote retrieval and execution are unavailable",
      details: onchainStatus as unknown as Record<string, unknown>,
    };
  }

  if (lastErrorIsCurrent) {
    return {
      id: "onchain-status",
      label: "Onchain integration status",
      required: false,
      status: "warn",
      summary: onchainStatus.lastError ?? "Onchain diagnostics reported a recent error",
      details: onchainStatus as unknown as Record<string, unknown>,
    };
  }

  return {
    id: "onchain-status",
    label: "Onchain integration status",
    required: false,
    status: "pass",
    summary: onchainStatus.lastV6SuccessAt
      ? `Onchain diagnostics report a successful v6 call at ${onchainStatus.lastV6SuccessAt}`
      : `Onchain diagnostics are configured for chain ${onchainStatus.chainIndex} with ${onchainStatus.authMode} auth`,
    details: onchainStatus as unknown as Record<string, unknown>,
  };
}

function buildOnchainProbeCheck(
  config: AlphaOsConfig,
  onchainStatus?: OnchainIntegrationStatus,
): NetworkProfileDiagnosticCheck {
  if (!config.onchainOsApiBase?.trim()) {
    return {
      id: "onchain-probe",
      label: "Onchain quote / swap / simulate probe",
      required: false,
      status: "warn",
      summary: "Onchain probe is skipped because ONCHAINOS_API_BASE is not configured",
    };
  }

  if (onchainStatus?.lastV6SuccessAt) {
    return {
      id: "onchain-probe",
      label: "Onchain quote / swap / simulate probe",
      required: false,
      status: "pass",
      summary: `A recent v6 path succeeded at ${onchainStatus.lastV6SuccessAt}`,
      details: {
        lastV6SuccessAt: onchainStatus.lastV6SuccessAt,
        lastUsedPath: onchainStatus.lastUsedPath,
      },
    };
  }

  return {
    id: "onchain-probe",
    label: "Onchain quote / swap / simulate probe",
    required: false,
    status: "warn",
    summary: "Onchain probe has not succeeded yet in the current runtime",
  };
}

function buildTokenResolutionCheck(
  config: AlphaOsConfig,
  onchainClient?: NetworkProfileDiagnosticsOptions["onchainClient"],
): NetworkProfileDiagnosticCheck {
  const pair = splitPair(config.pair);
  if (!pair) {
    return {
      id: "token-resolution",
      label: "Token resolution / cache availability",
      required: false,
      status: "warn",
      summary: `PAIR=${config.pair} could not be split into base/quote symbols`,
    };
  }

  if (!onchainClient) {
    return {
      id: "token-resolution",
      label: "Token resolution / cache availability",
      required: false,
      status: "warn",
      summary: `Token cache could not be checked for ${pair.base}/${pair.quote}`,
    };
  }

  const baseToken = onchainClient.getTokenCacheEntry(pair.base, config.onchainChainIndex);
  const quoteToken = onchainClient.getTokenCacheEntry(pair.quote, config.onchainChainIndex);
  if (baseToken && quoteToken) {
    return {
      id: "token-resolution",
      label: "Token resolution / cache availability",
      required: false,
      status: "pass",
      summary: `Token cache contains ${pair.base} and ${pair.quote} on chain ${config.onchainChainIndex}`,
      details: {
        pair: config.pair,
        chainIndex: config.onchainChainIndex,
      },
    };
  }

  return {
    id: "token-resolution",
    label: "Token resolution / cache availability",
    required: false,
    status: "warn",
    summary: `Token cache is incomplete for ${pair.base}/${pair.quote} on chain ${config.onchainChainIndex}`,
    details: {
      pair: config.pair,
      chainIndex: config.onchainChainIndex,
      hasBaseToken: Boolean(baseToken),
      hasQuoteToken: Boolean(quoteToken),
    },
  };
}

function finalizeDiagnostics(
  profile: NetworkProfile,
  checks: NetworkProfileDiagnosticCheck[],
  activeProbe: boolean,
): NetworkProfileDiagnostics {
  const reasons = checks.filter((check) => check.status !== "pass").map((check) => check.summary);
  const readiness: NetworkProfileReadiness = checks.some(
    (check) => check.required && check.status === "fail",
  )
    ? "unavailable"
    : reasons.length > 0
      ? "degraded"
      : "ready";

  return {
    profile: {
      id: profile.id,
      label: profile.label,
      mode: profile.mode,
    },
    readiness,
    summary: summarize(profile, readiness, reasons),
    reasons,
    checkedAt: new Date().toISOString(),
    activeProbe,
    checks,
  };
}

function createBaseChecks(options: NetworkProfileDiagnosticsOptions): {
  profile: NetworkProfile;
  checks: NetworkProfileDiagnosticCheck[];
  onchainStatus?: OnchainIntegrationStatus;
} {
  const env = options.env ?? process.env;
  const profile = getNetworkProfile(options.config.networkProfileId);
  const checks: NetworkProfileDiagnosticCheck[] = [];
  const onchainStatus = options.onchainClient?.getIntegrationStatus();

  checks.push(buildRequiredInputsCheck(profile, options.config, env));
  checks.push(buildRpcConnectivityCheck(options.config));
  checks.push(buildRpcChainCheck(options.config));
  checks.push(buildOnchainStatusCheck(options.config, onchainStatus));
  checks.push(buildOnchainProbeCheck(options.config, onchainStatus));
  checks.push(buildTokenResolutionCheck(options.config, options.onchainClient));

  return {
    profile,
    checks,
    onchainStatus,
  };
}

export function getNetworkProfileReadinessSnapshot(
  options: NetworkProfileDiagnosticsOptions,
): NetworkProfileDiagnostics {
  const { profile, checks } = createBaseChecks(options);
  return finalizeDiagnostics(profile, checks, false);
}

export async function probeNetworkProfileReadiness(
  options: NetworkProfileDiagnosticsOptions,
): Promise<NetworkProfileDiagnostics> {
  const timeoutMs = Math.max(250, Math.floor(options.timeoutMs ?? 2500));
  const { profile, checks } = createBaseChecks(options);

  if (options.config.commRpcUrl?.trim()) {
    const rpcProbe = await probeRpc(options.config.commRpcUrl, timeoutMs);
    upsertCheck(
      checks,
      rpcProbe.ok
        ? {
            id: "rpc-connectivity",
            label: "RPC connectivity",
            required: true,
            status: "pass",
            summary: `RPC responded from ${describeRpcUrl(options.config.commRpcUrl)}`,
            details: {
              rpcUrl: options.config.commRpcUrl,
              chainId: rpcProbe.chainId,
            },
          }
        : {
            id: "rpc-connectivity",
            label: "RPC connectivity",
            required: true,
            status: "fail",
            summary: `RPC probe failed for ${describeRpcUrl(options.config.commRpcUrl)}: ${rpcProbe.error}`,
            details: {
              rpcUrl: options.config.commRpcUrl,
              error: rpcProbe.error,
            },
          },
    );

    if (rpcProbe.ok && typeof rpcProbe.chainId === "number") {
      upsertCheck(
        checks,
        rpcProbe.chainId === options.config.commChainId
          ? {
              id: "rpc-chain-id",
              label: "RPC chainId consistency",
              required: true,
              status: "pass",
              summary: `RPC reported chainId ${rpcProbe.chainId} and matched COMM_CHAIN_ID=${options.config.commChainId}`,
              details: {
                rpcChainId: rpcProbe.chainId,
                configuredChainId: options.config.commChainId,
                targetChainIndex: options.config.onchainChainIndex,
              },
            }
          : {
              id: "rpc-chain-id",
              label: "RPC chainId consistency",
              required: true,
              status: "fail",
              summary: `RPC reported chainId ${rpcProbe.chainId} but COMM_CHAIN_ID=${options.config.commChainId}`,
              details: {
                rpcChainId: rpcProbe.chainId,
                configuredChainId: options.config.commChainId,
                targetChainIndex: options.config.onchainChainIndex,
              },
            },
      );
    }
  }

  if (options.onchainClient) {
    try {
      const probe = await withTimeout(
        options.onchainClient.probeConnection({
          pair: options.config.pair,
          chainIndex: options.config.onchainChainIndex,
        }),
        timeoutMs,
        "Onchain profile probe",
      );
      upsertCheck(
        checks,
        probe.ok
          ? {
              id: "onchain-probe",
              label: "Onchain quote / swap / simulate probe",
              required: false,
              status: "pass",
              summary: probe.message,
              details: probe as unknown as Record<string, unknown>,
            }
          : {
              id: "onchain-probe",
              label: "Onchain quote / swap / simulate probe",
              required: false,
              status: "warn",
              summary: probe.configured
                ? probe.message
                : "Onchain probe is unavailable because ONCHAINOS_API_BASE is not configured",
              details: probe as unknown as Record<string, unknown>,
            },
      );
      upsertCheck(checks, buildTokenResolutionCheck(options.config, options.onchainClient));
    } catch (error) {
      upsertCheck(checks, {
        id: "onchain-probe",
        label: "Onchain quote / swap / simulate probe",
        required: false,
        status: "warn",
        summary: `Onchain probe failed: ${toErrorMessage(error)}`,
      });
    }
  }

  return finalizeDiagnostics(profile, checks, true);
}
