import type { z } from "zod";
import { commListenerModeSchema } from "./agent-comm/types";

export const networkProfileIds = ["xlayer-recommended", "evm-custom"] as const;

export type NetworkProfileId = (typeof networkProfileIds)[number];
export type OnchainAuthMode = "bearer" | "api-key" | "hmac";
export type CommListenerMode = z.infer<typeof commListenerModeSchema>;

export const defaultNetworkProfileId: NetworkProfileId = "xlayer-recommended";
export const xlayerRecommendedRpcUrls = [
  "https://rpc.xlayer.tech",
  "https://xlayerrpc.okx.com",
] as const;

type NetworkProfileMode = "recommended" | "custom";
type NetworkProfileProbeId =
  | "rpc-connectivity"
  | "rpc-chain-id"
  | "onchain-status"
  | "onchain-probe"
  | "token-resolution";

export interface NetworkProfileDefaults {
  pair?: string;
  onchainChainIndex?: string;
  commChainId?: number;
  commRpcUrls?: readonly string[];
  commListenerMode?: CommListenerMode;
  onchainAuthMode?: OnchainAuthMode;
  onchainRequireSimulate?: boolean;
  onchainEnableCompatFallback?: boolean;
}

export interface NetworkProfileProbe {
  id: NetworkProfileProbeId;
  label: string;
  readiness: "required" | "recommended";
}

export interface NetworkProfileInputDescriptor {
  key: string;
  label: string;
  source: "env" | "runtime";
  note?: string;
}

export interface NetworkProfileCapabilityFlags {
  recommendedPath: boolean;
  evmCompatible: boolean;
  chainDefaults: boolean;
  onchainDiagnostics: boolean;
  tokenMetadata: boolean;
  chainMetadata: boolean;
  relayOverride: boolean;
  privateSubmitOverride: boolean;
  wsListenerImplemented: boolean;
  paymasterImplemented: boolean;
  aaImplemented: boolean;
  x402Implemented: boolean;
}

export interface NetworkProfile {
  id: NetworkProfileId;
  label: string;
  mode: NetworkProfileMode;
  defaults: NetworkProfileDefaults;
  probes: readonly NetworkProfileProbe[];
  requiredUserInputs: readonly NetworkProfileInputDescriptor[];
  capabilityFlags: NetworkProfileCapabilityFlags;
}

const defaultableConfigInputs = [
  {
    key: "PAIR",
    label: "Starter pair",
    source: "env",
    note: "Profile may prefill a recommended pair such as ETH/USDC.",
  },
  {
    key: "ONCHAINOS_CHAIN_INDEX",
    label: "Onchain chain index",
    source: "env",
    note: "Recommended profiles can pin this to a known target chain.",
  },
  {
    key: "COMM_CHAIN_ID",
    label: "Agent-comm chain id",
    source: "env",
    note: "Defaults can stay aligned with the selected chain index.",
  },
  {
    key: "COMM_RPC_URL",
    label: "Agent-comm RPC URL",
    source: "env",
    note: "Profiles may provide a preferred primary RPC and reserve backups for later probes.",
  },
  {
    key: "COMM_LISTENER_MODE",
    label: "Agent-comm listener mode",
    source: "env",
    note: "Current recommended path uses poll rather than ws.",
  },
  {
    key: "ONCHAINOS_AUTH_MODE",
    label: "Execution backend auth mode",
    source: "env",
    note: "Profiles can recommend the expected auth handshake without forcing credentials.",
  },
  {
    key: "ONCHAINOS_REQUIRE_SIMULATE",
    label: "Simulate-before-broadcast gate",
    source: "env",
  },
  {
    key: "ONCHAINOS_ENABLE_COMPAT_FALLBACK",
    label: "Compat fallback behavior",
    source: "env",
    note: "Production default is false; enable only for a known legacy backend migration.",
  },
] as const satisfies readonly NetworkProfileInputDescriptor[];

const autoDetectableConfigInputs = [
  {
    key: "rpc-connectivity",
    label: "RPC connectivity",
    source: "runtime",
    note: "Probe whether the chosen RPC is reachable.",
  },
  {
    key: "rpc-chain-id",
    label: "RPC chainId consistency",
    source: "runtime",
    note: "Compare the RPC-reported chainId against the configured target chain.",
  },
  {
    key: "token-metadata",
    label: "Token metadata / decimals / address",
    source: "runtime",
  },
  {
    key: "supported-chain-metadata",
    label: "Supported chain / approve address metadata",
    source: "runtime",
  },
  {
    key: "swap-path-availability",
    label: "Simulate / broadcast path availability",
    source: "runtime",
  },
  {
    key: "integration-diagnostics",
    label: "Onchain integration status / diagnostics",
    source: "runtime",
  },
] as const satisfies readonly NetworkProfileInputDescriptor[];

const xlayerRequiredUserInputs = [
  {
    key: "ONCHAINOS_API_BASE",
    label: "Execution backend API base",
    source: "env",
    note: "Required for production quote retrieval and execution.",
  },
  {
    key: "ONCHAINOS_API_KEY",
    label: "Execution backend API key",
    source: "env",
  },
  {
    key: "ONCHAINOS_API_SECRET",
    label: "Execution backend API secret",
    source: "env",
  },
  {
    key: "ONCHAINOS_PASSPHRASE",
    label: "Execution backend passphrase",
    source: "env",
  },
  {
    key: "ONCHAINOS_PROJECT_ID",
    label: "Execution backend project id",
    source: "env",
  },
  {
    key: "VAULT_MASTER_PASSWORD",
    label: "Vault master password",
    source: "env",
  },
  {
    key: "trusted-peer",
    label: "Trusted peer identity",
    source: "runtime",
    note: "Peer wallet/pubkey data must still be registered by the user.",
  },
  {
    key: "live-wallet-address",
    label: "Live wallet address",
    source: "runtime",
    note: "Needed before live execution or user-specific simulation.",
  },
] as const satisfies readonly NetworkProfileInputDescriptor[];

const evmCustomRequiredUserInputs = [
  {
    key: "ONCHAINOS_CHAIN_INDEX",
    label: "Chain / chainIndex",
    source: "env",
    note: "Custom EVM mode expects the user to choose the target chain explicitly.",
  },
  {
    key: "COMM_RPC_URL",
    label: "RPC URL",
    source: "env",
    note: "Provide a reachable RPC for the chosen EVM network.",
  },
  {
    key: "COMM_LISTENER_MODE",
    label: "Listener mode",
    source: "env",
    note: "Custom mode should choose its own listener strategy within current v0.1 limits.",
  },
  {
    key: "ONCHAINOS_AUTH_MODE",
    label: "Auth mode",
    source: "env",
    note: "Custom mode keeps auth choice as an explicit user decision.",
  },
  ...xlayerRequiredUserInputs,
] as const satisfies readonly NetworkProfileInputDescriptor[];

const sharedProfileProbes = [
  {
    id: "rpc-connectivity",
    label: "RPC connectivity",
    readiness: "required",
  },
  {
    id: "rpc-chain-id",
    label: "RPC chainId consistency",
    readiness: "required",
  },
  {
    id: "onchain-status",
    label: "Onchain integration status",
    readiness: "recommended",
  },
  {
    id: "onchain-probe",
    label: "Onchain quote / swap / simulate probe",
    readiness: "recommended",
  },
  {
    id: "token-resolution",
    label: "Token resolution / cache availability",
    readiness: "recommended",
  },
] as const satisfies readonly NetworkProfileProbe[];

export const networkProfileConfigBoundary = {
  defaultable: defaultableConfigInputs,
  autoDetectable: autoDetectableConfigInputs,
  requiredUserInputs: xlayerRequiredUserInputs,
} as const;

export const networkProfiles: Record<NetworkProfileId, NetworkProfile> = {
  "xlayer-recommended": {
    id: "xlayer-recommended",
    label: "X Layer recommended",
    mode: "recommended",
    defaults: {
      pair: "ETH/USDC",
      onchainChainIndex: "196",
      commChainId: 196,
      commRpcUrls: xlayerRecommendedRpcUrls,
      commListenerMode: "poll",
      onchainAuthMode: "hmac",
      onchainRequireSimulate: true,
      onchainEnableCompatFallback: false,
    },
    probes: sharedProfileProbes,
    requiredUserInputs: xlayerRequiredUserInputs,
    capabilityFlags: {
      recommendedPath: true,
      evmCompatible: true,
      chainDefaults: true,
      onchainDiagnostics: true,
      tokenMetadata: true,
      chainMetadata: true,
      relayOverride: true,
      privateSubmitOverride: true,
      wsListenerImplemented: false,
      paymasterImplemented: false,
      aaImplemented: false,
      x402Implemented: false,
    },
  },
  "evm-custom": {
    id: "evm-custom",
    label: "EVM custom",
    mode: "custom",
    defaults: {},
    probes: sharedProfileProbes,
    requiredUserInputs: evmCustomRequiredUserInputs,
    capabilityFlags: {
      recommendedPath: false,
      evmCompatible: true,
      chainDefaults: false,
      onchainDiagnostics: true,
      tokenMetadata: true,
      chainMetadata: true,
      relayOverride: true,
      privateSubmitOverride: true,
      wsListenerImplemented: false,
      paymasterImplemented: false,
      aaImplemented: false,
      x402Implemented: false,
    },
  },
};

export function readNetworkProfileId(raw: string | undefined): NetworkProfileId {
  if (!raw) {
    return defaultNetworkProfileId;
  }
  if (raw === "xlayer-recommended" || raw === "evm-custom") {
    return raw;
  }
  throw new Error(`Unsupported NETWORK_PROFILE=${raw}`);
}

export function getNetworkProfile(id: NetworkProfileId): NetworkProfile {
  return networkProfiles[id];
}

export function getPreferredCommRpcUrl(profile: NetworkProfile): string | undefined {
  return profile.defaults.commRpcUrls?.[0];
}
