import express from "express";
import type { RequestHandler } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { AlphaEngine } from "../engine/alpha-engine";
import type { AlphaOsConfig } from "../runtime/config";
import { OnchainOsClient } from "../runtime/onchainos-client";
import {
  defaultContactPolicyConfig,
  type AttentionLevel,
  type ContactPolicyConfig,
  type UserContext,
} from "../living-assistant/contact-policy";
import { DigestBatchScheduler } from "../living-assistant/digest-batching";
import { runLivingAssistantLoop } from "../living-assistant/loop";
import { normalizeSignal, type NormalizedSignal } from "../living-assistant/signal-radar";
import {
  getNetworkProfileReadinessSnapshot,
  probeNetworkProfileReadiness,
} from "../runtime/network-profile-probe";
import { StateStore } from "../runtime/state-store";
import { SandboxReplayService } from "../runtime/sandbox-replay";
import { DiscoveryEngine } from "../runtime/discovery/discovery-engine";
import type { BacktestSnapshotRow, RiskPolicy, SkillManifest } from "../types";
import { adaptArbitrageModuleResponse } from "../module/response-adapter";
import type { FirstBatchArbitrageAdapterInputs } from "../module/adapters";
import type { ArbitrageModuleResponse } from "../module/types";
import {
  exportIdentityArtifactBundle,
  importRevocationNotice,
  importIdentityArtifactBundle,
  LEGACY_MANUAL_PEER_TRUST_WARNING,
  registerTrustedPeerEntry,
  revokeIdentityArtifact,
  rotateCommWallet,
  sendCommConnectionAccept,
  sendCommConnectionInvite,
  sendCommConnectionReject,
  sendCommPing,
  sendCommProbeExecution,
  sendCommProbeOnchainOs,
  sendCommRequestModeChange,
  sendCommStartDiscovery,
  type AgentCommEntrypointDependencies,
} from "../runtime/agent-comm/entrypoints";
import {
  checkExpiringArtifacts,
  listAgentContactSurfaceItems,
  listAgentInviteSurfaceItems,
} from "../runtime/agent-comm/contact-surfaces";
import type { AgentCommRuntimeHandle } from "../runtime/agent-comm/runtime";
import {
  agentCommandTypes,
  agentConnectionEventStatuses,
  agentContactStatuses,
  agentMessageDirections,
  agentMessageStatuses,
  agentPeerStatuses,
  type AgentConnectionEventStatus,
  type AgentContactStatus,
  type AgentMessageDirection,
  type AgentMessageStatus,
  type AgentPeerCapability,
  type AgentPeerStatus,
} from "../runtime/agent-comm/types";

function toLimit(input: unknown, fallback: number): number {
  const parsed = Number(input ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function toHours(input: unknown, fallback: number): number {
  const parsed = Number(input ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(24 * 30, Math.floor(parsed)));
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows: BacktestSnapshotRow[]): string {
  const headers = [
    "strategyId",
    "opportunities",
    "planned",
    "executed",
    "failed",
    "rejected",
    "avgEstimatedNetUsd",
    "realizedNetUsd",
    "tradeWinRate",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.strategyId,
        row.opportunities,
        row.planned,
        row.executed,
        row.failed,
        row.rejected,
        row.avgEstimatedNetUsd.toFixed(6),
        row.realizedNetUsd.toFixed(6),
        row.tradeWinRate.toFixed(6),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input !== "string") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(input.toLowerCase());
}

function isAllowedValue<T extends string>(value: string, allowed: readonly T[]): value is T {
  return allowed.includes(value as T);
}

function readTrimmedString(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function readOptionalTrimmedString(input: unknown): string | undefined {
  const value = readTrimmedString(input);
  return value || undefined;
}

function parseOptionalAllowedValue<T extends string>(
  input: unknown,
  allowed: readonly T[],
): { raw: string; value?: T } {
  const raw = readTrimmedString(input);
  if (!raw) {
    return { raw };
  }
  return {
    raw,
    value: isAllowedValue(raw, allowed) ? raw : undefined,
  };
}

const legacyUsageThresholds = {
  legacyOnlyContactsWatchAbove: 0,
  legacyOnlyContactsDiscourageAbove: 3,
  manualPeerRecordsDiscourageAbove: 1,
  legacyFallbackMessagesDiscourageAbove: 5,
} as const;

function summarizeLegacyUsage(
  contacts: ReturnType<typeof listAgentContactSurfaceItems>,
  recentMessages: ReturnType<StateStore["listAgentMessages"]>,
) {
  const legacyOnlyContactCount = contacts.filter((contact) => contact.legacyProtocolOnly).length;
  const manualPeerRecordCount = contacts.filter((contact) => contact.legacyManualPeerRecord).length;
  const legacyFallbackMessageCount = recentMessages.filter(
    (message) => message.trustOutcome === "legacy_fallback_v1",
  ).length;
  const unknownBusinessRejectCount = recentMessages.filter(
    (message) => message.trustOutcome === "unknown_business_rejected",
  ).length;

  return {
    legacyOnlyContactCount,
    manualPeerRecordCount,
    legacyFallbackMessageCount,
    unknownBusinessRejectCount,
    thresholds: legacyUsageThresholds,
    shouldDiscourageNewLegacyOnboarding:
      legacyOnlyContactCount > legacyUsageThresholds.legacyOnlyContactsDiscourageAbove
      || manualPeerRecordCount >= legacyUsageThresholds.manualPeerRecordsDiscourageAbove
      || legacyFallbackMessageCount >= legacyUsageThresholds.legacyFallbackMessagesDiscourageAbove,
  };
}

function createAgentCommStatusResponse(
  store: StateStore,
  runtime: AgentCommRuntimeHandle,
  config?: Pick<AlphaOsConfig, "commAutoAcceptInvites" | "commArtifactExpiryWarningDays">,
) {
  const snapshot = runtime.getSnapshot();
  const contacts = listAgentContactSurfaceItems(store, 1000);
  const trustedPeers = store.listAgentPeers(1000, "trusted");
  const recentMessages = store.listAgentMessages(1000);
  const paidPendingMessageCount = store.countAgentMessagesByStatus("paid_pending");
  const autoAcceptInvites = config?.commAutoAcceptInvites ?? false;
  const expiryWarnings = checkExpiringArtifacts(store, {
    warningThresholdDays: config?.commArtifactExpiryWarningDays,
  });
  const legacyUsage = summarizeLegacyUsage(contacts, recentMessages);
  const contactStatusCounts = Object.fromEntries(
    agentContactStatuses.map((status) => [status, 0]),
  ) as Record<AgentContactStatus, number>;
  let pendingInboundInviteCount = 0;
  let pendingOutboundInviteCount = 0;

  for (const contact of contacts) {
    contactStatusCounts[contact.status] += 1;
    pendingInboundInviteCount += contact.pendingInvites.inbound;
    pendingOutboundInviteCount += contact.pendingInvites.outbound;
  }

  return {
    snapshot,
    autoAcceptInvites,
    trustedPeerCount: trustedPeers.length,
    recentMessageCount: recentMessages.length,
    paidPendingMessageCount,
    contactCount: contacts.length,
    expiryWarnings,
    contactStatusCounts,
    pendingInviteCounts: {
      inbound: pendingInboundInviteCount,
      outbound: pendingOutboundInviteCount,
      total: pendingInboundInviteCount + pendingOutboundInviteCount,
    },
    legacyUsage,
  };
}

function parseAgentMessageListQuery(
  query: express.Request["query"],
):
  | {
      ok: true;
      limit: number;
      filters: {
        peerId?: string;
        contactId?: string;
        identityWallet?: string;
        direction?: AgentMessageDirection;
        status?: AgentMessageStatus;
      };
    }
  | { ok: false; error: string } {
  const direction = parseOptionalAllowedValue(query.direction, agentMessageDirections);
  if (direction.raw && !direction.value) {
    return { ok: false, error: "invalid direction" };
  }

  const status = parseOptionalAllowedValue(query.status, agentMessageStatuses);
  if (status.raw && !status.value) {
    return { ok: false, error: "invalid status" };
  }

  return {
    ok: true,
    limit: toLimit(query.limit, 50),
    filters: {
      peerId: readOptionalTrimmedString(query.peerId),
      contactId: readOptionalTrimmedString(query.contactId),
      identityWallet: readOptionalTrimmedString(query.identityWallet),
      direction: direction.value,
      status: status.value,
    },
  };
}

function parseAgentPeerListQuery(
  query: express.Request["query"],
): { ok: true; limit: number; status?: AgentPeerStatus } | { ok: false; error: string } {
  const status = parseOptionalAllowedValue(query.status, agentPeerStatuses);
  if (status.raw && !status.value) {
    return { ok: false, error: "invalid peer status" };
  }

  return {
    ok: true,
    limit: toLimit(query.limit, 100),
    status: status.value,
  };
}

function parseAgentContactListQuery(
  query: express.Request["query"],
):
  | {
      ok: true;
      limit: number;
      filters: {
        status?: AgentContactStatus;
        identityWallet?: string;
        legacyPeerId?: string;
      };
    }
  | { ok: false; error: string } {
  const status = parseOptionalAllowedValue(query.status, agentContactStatuses);
  if (status.raw && !status.value) {
    return { ok: false, error: "invalid contact status" };
  }

  return {
    ok: true,
    limit: toLimit(query.limit, 100),
    filters: {
      status: status.value,
      identityWallet: readOptionalTrimmedString(query.identityWallet),
      legacyPeerId: readOptionalTrimmedString(query.legacyPeerId),
    },
  };
}

function parseAgentInviteListQuery(
  query: express.Request["query"],
):
  | {
      ok: true;
      limit: number;
      filters: {
        contactId?: string;
        identityWallet?: string;
        direction?: AgentMessageDirection;
        eventStatus?: AgentConnectionEventStatus;
      };
    }
  | { ok: false; error: string } {
  const direction = parseOptionalAllowedValue(query.direction, agentMessageDirections);
  if (direction.raw && !direction.value) {
    return { ok: false, error: "invalid direction" };
  }

  const status = parseOptionalAllowedValue(query.status, agentConnectionEventStatuses);
  if (status.raw && !status.value) {
    return { ok: false, error: "invalid invite status" };
  }

  return {
    ok: true,
    limit: toLimit(query.limit, 100),
    filters: {
      contactId: readOptionalTrimmedString(query.contactId),
      identityWallet: readOptionalTrimmedString(query.identityWallet),
      direction: direction.value,
      eventStatus: status.value,
    },
  };
}

function parseAgentPeerCapabilities(input: unknown): AgentPeerCapability[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => String(item ?? "").trim())
    .filter(
      (item): item is AgentPeerCapability => item.length > 0 && isAllowedValue(item, agentCommandTypes),
    );
}

function parseTrustedPeerUpsertBody(
  body: unknown,
):
  | { ok: true; input: Parameters<StateStore["upsertAgentPeer"]>[0] }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const peerId = readTrimmedString(payload.peerId);
  const walletAddress = readTrimmedString(payload.walletAddress);
  const pubkey = readTrimmedString(payload.pubkey);

  if (!peerId || !walletAddress || !pubkey) {
    return {
      ok: false,
      error: "peerId, walletAddress, pubkey are required",
    };
  }

  return {
    ok: true,
    input: {
      peerId,
      walletAddress,
      pubkey,
      name: readOptionalTrimmedString(payload.name),
      status: "trusted",
      capabilities: parseAgentPeerCapabilities(payload.capabilities),
      metadata:
        payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
          ? (payload.metadata as Record<string, unknown>)
          : undefined,
    },
  };
}

function isDiscoveryStrategyId(input: string): input is "spread-threshold" | "mean-reversion" | "volatility-breakout" {
  return input === "spread-threshold" || input === "mean-reversion" || input === "volatility-breakout";
}

function isExecutionMode(input: string): input is "paper" | "live" {
  return input === "paper" || input === "live";
}

function normalizeDiscoveryPairs(input: unknown): string[] | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const pairs = input
    .map((pair) => String(pair ?? "").trim().toUpperCase())
    .filter((pair) => pair.length > 0);
  return pairs.length > 0 ? pairs : null;
}

function parseOptionalPositiveNumber(input: unknown): { ok: true; value?: number } | { ok: false } {
  if (input === undefined) {
    return { ok: true };
  }
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function parseFirstBatchAdapterInputs(input: unknown): FirstBatchArbitrageAdapterInputs | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as FirstBatchArbitrageAdapterInputs;
}

function dedupeSkillIds(items: string[]): string[] {
  const normalized = items
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(normalized));
}

function buildModuleSkillAttributionView(moduleResponse: ArbitrageModuleResponse) {
  const requiredSkillsUsed = dedupeSkillIds(moduleResponse.skillUsage.required);
  const enrichmentSkillsUsed = dedupeSkillIds(moduleResponse.skillUsage.enrichment);
  const distributionSkillsUsed = dedupeSkillIds(moduleResponse.skillUsage.distribution);
  const skillSources = dedupeSkillIds([
    ...(moduleResponse.candidate?.skillSources ?? []),
    ...requiredSkillsUsed,
    ...enrichmentSkillsUsed,
    ...distributionSkillsUsed,
  ]);

  return {
    skillSources,
    requiredSkillsUsed,
    enrichmentSkillsUsed,
    distributionSkillsUsed,
    metadata: moduleResponse.skillUsage.metadata ?? null,
  };
}

function parseOptionalPositiveInteger(input: unknown): { ok: true; value?: number } | { ok: false } {
  if (input === undefined) {
    return { ok: true };
  }
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function parseOptionalNonNegativeInteger(input: unknown): { ok: true; value?: number } | { ok: false } {
  if (input === undefined) {
    return { ok: true };
  }
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function parseOptionalStringField(
  payload: Record<string, unknown>,
  key: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  const input = payload[key];
  if (input === undefined) {
    return { ok: true };
  }
  if (typeof input !== "string") {
    return { ok: false, error: `${key} must be a string` };
  }
  const value = input.trim();
  return { ok: true, value: value || undefined };
}

function parseOptionalStringArrayField(
  payload: Record<string, unknown>,
  key: string,
): { ok: true; value?: string[] } | { ok: false; error: string } {
  const input = payload[key];
  if (input === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: `${key} must be a string array` };
  }

  const values: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      return { ok: false, error: `${key} must be a string array` };
    }
    const value = item.trim();
    if (!value) {
      return { ok: false, error: `${key} must be a string array` };
    }
    values.push(value);
  }

  return {
    ok: true,
    value: values.length > 0 ? [...new Set(values)] : undefined,
  };
}

function parseOptionalBooleanField(
  payload: Record<string, unknown>,
  key: string,
): { ok: true; value?: boolean } | { ok: false; error: string } {
  const input = payload[key];
  if (input === undefined) {
    return { ok: true };
  }
  if (typeof input === "boolean") {
    return { ok: true, value: input };
  }
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return { ok: true, value: true };
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return { ok: true, value: false };
    }
  }
  return { ok: false, error: `${key} must be a boolean` };
}

function parseOptionalPairsField(
  payload: Record<string, unknown>,
): { ok: true; value?: string[] } | { ok: false; error: string } {
  if (payload.pairs === undefined) {
    return { ok: true };
  }
  const pairs = normalizeDiscoveryPairs(payload.pairs);
  if (!pairs) {
    return { ok: false, error: "pairs must be a non-empty string array" };
  }
  return { ok: true, value: pairs };
}

function parsePingSendBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        peerId: string;
        senderPeerId?: string;
        echo?: string;
        note?: string;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const peerId = readTrimmedString(payload.peerId);
  if (!peerId) {
    return { ok: false, error: "peerId is required" };
  }

  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const echo = parseOptionalStringField(payload, "echo");
  if (!echo.ok) {
    return echo;
  }
  const note = parseOptionalStringField(payload, "note");
  if (!note.ok) {
    return note;
  }

  return {
    ok: true,
    input: {
      peerId,
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(echo.value ? { echo: echo.value } : {}),
      ...(note.value ? { note: note.value } : {}),
    },
  };
}

function parseProbeOnchainOsSendBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        peerId: string;
        senderPeerId?: string;
        pair?: string;
        chainIndex?: string;
        notionalUsd?: number;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const peerId = readTrimmedString(payload.peerId);
  if (!peerId) {
    return { ok: false, error: "peerId is required" };
  }

  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const pair = parseOptionalStringField(payload, "pair");
  if (!pair.ok) {
    return pair;
  }
  const chainIndex = parseOptionalStringField(payload, "chainIndex");
  if (!chainIndex.ok) {
    return chainIndex;
  }
  const notionalUsd = parseOptionalPositiveNumber(payload.notionalUsd);
  if (!notionalUsd.ok) {
    return { ok: false, error: "notionalUsd must be a positive number" };
  }

  return {
    ok: true,
    input: {
      peerId,
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(pair.value ? { pair: pair.value.toUpperCase() } : {}),
      ...(chainIndex.value ? { chainIndex: chainIndex.value } : {}),
      ...(notionalUsd.value !== undefined ? { notionalUsd: notionalUsd.value } : {}),
    },
  };
}

function parseStartDiscoverySendBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        peerId: string;
        senderPeerId?: string;
        strategyId: "spread-threshold" | "mean-reversion" | "volatility-breakout";
        pairs?: string[];
        durationMinutes?: number;
        sampleIntervalSec?: number;
        topN?: number;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const peerId = readTrimmedString(payload.peerId);
  if (!peerId) {
    return { ok: false, error: "peerId is required" };
  }

  const strategyId = readTrimmedString(payload.strategyId);
  if (!isDiscoveryStrategyId(strategyId)) {
    return {
      ok: false,
      error: "strategyId must be spread-threshold | mean-reversion | volatility-breakout",
    };
  }

  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const pairs = parseOptionalPairsField(payload);
  if (!pairs.ok) {
    return pairs;
  }

  const durationMinutes = parseOptionalPositiveInteger(payload.durationMinutes);
  if (!durationMinutes.ok) {
    return { ok: false, error: "durationMinutes must be a positive integer" };
  }

  const sampleIntervalSec = parseOptionalPositiveInteger(payload.sampleIntervalSec);
  if (!sampleIntervalSec.ok) {
    return { ok: false, error: "sampleIntervalSec must be a positive integer" };
  }

  const topN = parseOptionalPositiveInteger(payload.topN);
  if (!topN.ok) {
    return { ok: false, error: "topN must be a positive integer" };
  }

  return {
    ok: true,
    input: {
      peerId,
      strategyId,
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(pairs.value ? { pairs: pairs.value } : {}),
      ...(durationMinutes.value ? { durationMinutes: durationMinutes.value } : {}),
      ...(sampleIntervalSec.value ? { sampleIntervalSec: sampleIntervalSec.value } : {}),
      ...(topN.value ? { topN: topN.value } : {}),
    },
  };
}

function parseRequestModeChangeSendBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        peerId: string;
        senderPeerId?: string;
        requestedMode: "paper" | "live";
        reason?: string;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const peerId = readTrimmedString(payload.peerId);
  if (!peerId) {
    return { ok: false, error: "peerId is required" };
  }

  const requestedMode = readTrimmedString(payload.requestedMode);
  if (!isExecutionMode(requestedMode)) {
    return { ok: false, error: "requestedMode must be paper or live" };
  }

  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const reason = parseOptionalStringField(payload, "reason");
  if (!reason.ok) {
    return reason;
  }

  return {
    ok: true,
    input: {
      peerId,
      requestedMode,
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(reason.value ? { reason: reason.value } : {}),
    },
  };
}

function parseCardImportBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        bundle: unknown;
        source?: string;
        expectedChainId?: number;
        nowUnixSeconds?: number;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!("bundle" in payload)) {
    return { ok: false, error: "bundle is required" };
  }

  const source = parseOptionalStringField(payload, "source");
  if (!source.ok) {
    return source;
  }

  const expectedChainId = parseOptionalPositiveInteger(payload.expectedChainId);
  if (!expectedChainId.ok) {
    return { ok: false, error: "expectedChainId must be a positive integer" };
  }

  const nowUnixSeconds = parseOptionalNonNegativeInteger(payload.nowUnixSeconds);
  if (!nowUnixSeconds.ok) {
    return { ok: false, error: "nowUnixSeconds must be a non-negative integer" };
  }

  return {
    ok: true,
    input: {
      bundle: payload.bundle,
      ...(source.value ? { source: source.value } : {}),
      ...(expectedChainId.value !== undefined ? { expectedChainId: expectedChainId.value } : {}),
      ...(nowUnixSeconds.value !== undefined ? { nowUnixSeconds: nowUnixSeconds.value } : {}),
    },
  };
}

function parseArtifactRevokeBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        artifactDigest: string;
        artifactType: "ContactCard" | "TransportBinding";
        replacementDigest?: string;
        reason?: string;
        revokedAt?: number;
        source?: string;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const artifactDigest = readTrimmedString(payload.artifactDigest);
  if (!artifactDigest) {
    return { ok: false, error: "artifactDigest is required" };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(artifactDigest)) {
    return { ok: false, error: "artifactDigest must be a bytes32 hex string" };
  }

  const artifactType = readTrimmedString(payload.artifactType);
  if (artifactType !== "ContactCard" && artifactType !== "TransportBinding") {
    return { ok: false, error: "artifactType must be ContactCard or TransportBinding" };
  }

  const replacementDigest = parseOptionalStringField(payload, "replacementDigest");
  if (!replacementDigest.ok) {
    return replacementDigest;
  }
  if (replacementDigest.value && !/^0x[0-9a-fA-F]{64}$/.test(replacementDigest.value)) {
    return { ok: false, error: "replacementDigest must be a bytes32 hex string" };
  }

  const reason = parseOptionalStringField(payload, "reason");
  if (!reason.ok) {
    return reason;
  }
  const source = parseOptionalStringField(payload, "source");
  if (!source.ok) {
    return source;
  }
  const revokedAt = parseOptionalNonNegativeInteger(payload.revokedAt);
  if (!revokedAt.ok) {
    return { ok: false, error: "revokedAt must be a non-negative integer" };
  }

  return {
    ok: true,
    input: {
      artifactDigest,
      artifactType,
      ...(replacementDigest.value ? { replacementDigest: replacementDigest.value } : {}),
      ...(reason.value ? { reason: reason.value } : {}),
      ...(source.value ? { source: source.value } : {}),
      ...(revokedAt.value !== undefined ? { revokedAt: revokedAt.value } : {}),
    },
  };
}

function parseRevocationImportBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        notice: unknown;
        source?: string;
        expectedChainId?: number;
        nowUnixSeconds?: number;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!("notice" in payload)) {
    return { ok: false, error: "notice is required" };
  }

  const source = parseOptionalStringField(payload, "source");
  if (!source.ok) {
    return source;
  }
  const expectedChainId = parseOptionalPositiveInteger(payload.expectedChainId);
  if (!expectedChainId.ok) {
    return { ok: false, error: "expectedChainId must be a positive integer" };
  }
  const nowUnixSeconds = parseOptionalNonNegativeInteger(payload.nowUnixSeconds);
  if (!nowUnixSeconds.ok) {
    return { ok: false, error: "nowUnixSeconds must be a non-negative integer" };
  }

  return {
    ok: true,
    input: {
      notice: payload.notice,
      ...(source.value ? { source: source.value } : {}),
      ...(expectedChainId.value !== undefined ? { expectedChainId: expectedChainId.value } : {}),
      ...(nowUnixSeconds.value !== undefined ? { nowUnixSeconds: nowUnixSeconds.value } : {}),
    },
  };
}

function parseCardExportBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        displayName?: string;
        handle?: string;
        capabilityProfile?: string;
        capabilities?: string[];
        expiresInDays?: number;
        keyId?: string;
        legacyPeerId?: string;
        nowUnixSeconds?: number;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const displayName = parseOptionalStringField(payload, "displayName");
  if (!displayName.ok) {
    return displayName;
  }
  const handle = parseOptionalStringField(payload, "handle");
  if (!handle.ok) {
    return handle;
  }
  const capabilityProfile = parseOptionalStringField(payload, "capabilityProfile");
  if (!capabilityProfile.ok) {
    return capabilityProfile;
  }
  const capabilities = parseOptionalStringArrayField(payload, "capabilities");
  if (!capabilities.ok) {
    return capabilities;
  }
  const keyId = parseOptionalStringField(payload, "keyId");
  if (!keyId.ok) {
    return keyId;
  }
  const legacyPeerId = parseOptionalStringField(payload, "legacyPeerId");
  if (!legacyPeerId.ok) {
    return legacyPeerId;
  }

  const expiresInDays = parseOptionalPositiveInteger(payload.expiresInDays);
  if (!expiresInDays.ok) {
    return { ok: false, error: "expiresInDays must be a positive integer" };
  }

  const nowUnixSeconds = parseOptionalNonNegativeInteger(payload.nowUnixSeconds);
  if (!nowUnixSeconds.ok) {
    return { ok: false, error: "nowUnixSeconds must be a non-negative integer" };
  }

  return {
    ok: true,
    input: {
      ...(displayName.value ? { displayName: displayName.value } : {}),
      ...(handle.value ? { handle: handle.value } : {}),
      ...(capabilityProfile.value ? { capabilityProfile: capabilityProfile.value } : {}),
      ...(capabilities.value ? { capabilities: capabilities.value } : {}),
      ...(expiresInDays.value !== undefined ? { expiresInDays: expiresInDays.value } : {}),
      ...(keyId.value ? { keyId: keyId.value } : {}),
      ...(legacyPeerId.value ? { legacyPeerId: legacyPeerId.value } : {}),
      ...(nowUnixSeconds.value !== undefined ? { nowUnixSeconds: nowUnixSeconds.value } : {}),
    },
  };
}

function parseConnectionInviteBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        contactId: string;
        senderPeerId?: string;
        requestedProfile?: string;
        requestedCapabilities?: string[];
        note?: string;
        attachInlineCard?: boolean;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const contactId = readTrimmedString(payload.contactId);
  if (!contactId) {
    return { ok: false, error: "contactId is required" };
  }

  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const requestedProfile = parseOptionalStringField(payload, "requestedProfile");
  if (!requestedProfile.ok) {
    return requestedProfile;
  }
  const requestedCapabilities = parseOptionalStringArrayField(payload, "requestedCapabilities");
  if (!requestedCapabilities.ok) {
    return requestedCapabilities;
  }
  const note = parseOptionalStringField(payload, "note");
  if (!note.ok) {
    return note;
  }
  const attachInlineCard = parseOptionalBooleanField(payload, "attachInlineCard");
  if (!attachInlineCard.ok) {
    return attachInlineCard;
  }

  return {
    ok: true,
    input: {
      contactId,
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(requestedProfile.value ? { requestedProfile: requestedProfile.value } : {}),
      ...(requestedCapabilities.value ? { requestedCapabilities: requestedCapabilities.value } : {}),
      ...(note.value ? { note: note.value } : {}),
      ...(attachInlineCard.value !== undefined
        ? { attachInlineCard: attachInlineCard.value }
        : {}),
    },
  };
}

function parseConnectionAcceptBody(
  contactIdInput: unknown,
  body: unknown,
):
  | {
      ok: true;
      input: {
        contactId: string;
        senderPeerId?: string;
        capabilityProfile?: string;
        capabilities?: string[];
        note?: string;
        attachInlineCard?: boolean;
      };
    }
  | { ok: false; error: string } {
  const contactId = readTrimmedString(contactIdInput);
  if (!contactId) {
    return { ok: false, error: "contactId is required" };
  }

  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const capabilityProfile = parseOptionalStringField(payload, "capabilityProfile");
  if (!capabilityProfile.ok) {
    return capabilityProfile;
  }
  const capabilities = parseOptionalStringArrayField(payload, "capabilities");
  if (!capabilities.ok) {
    return capabilities;
  }
  const note = parseOptionalStringField(payload, "note");
  if (!note.ok) {
    return note;
  }
  const attachInlineCard = parseOptionalBooleanField(payload, "attachInlineCard");
  if (!attachInlineCard.ok) {
    return attachInlineCard;
  }

  return {
    ok: true,
    input: {
      contactId,
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(capabilityProfile.value ? { capabilityProfile: capabilityProfile.value } : {}),
      ...(capabilities.value ? { capabilities: capabilities.value } : {}),
      ...(note.value ? { note: note.value } : {}),
      ...(attachInlineCard.value !== undefined
        ? { attachInlineCard: attachInlineCard.value }
        : {}),
    },
  };
}

function parseConnectionRejectBody(
  contactIdInput: unknown,
  body: unknown,
):
  | {
      ok: true;
      input: {
        contactId: string;
        senderPeerId?: string;
        reason?: string;
        note?: string;
      };
    }
  | { ok: false; error: string } {
  const contactId = readTrimmedString(contactIdInput);
  if (!contactId) {
    return { ok: false, error: "contactId is required" };
  }

  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const reason = parseOptionalStringField(payload, "reason");
  if (!reason.ok) {
    return reason;
  }
  const note = parseOptionalStringField(payload, "note");
  if (!note.ok) {
    return note;
  }

  return {
    ok: true,
    input: {
      contactId,
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(reason.value ? { reason: reason.value } : {}),
      ...(note.value ? { note: note.value } : {}),
    },
  };
}

function parseRotateWalletBody(
  body: unknown,
):
  | {
      ok: true;
      input: {
        gracePeriodHours?: number;
        privateKey?: string;
        senderPeerId?: string;
        displayName?: string;
        handle?: string;
        capabilityProfile?: string;
        capabilities?: string[];
        expiresInDays?: number;
        keyId?: string;
        legacyPeerId?: string;
        nowUnixSeconds?: number;
      };
    }
  | { ok: false; error: string } {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const senderPeerId = parseOptionalStringField(payload, "senderPeerId");
  if (!senderPeerId.ok) {
    return senderPeerId;
  }
  const displayName = parseOptionalStringField(payload, "displayName");
  if (!displayName.ok) {
    return displayName;
  }
  const handle = parseOptionalStringField(payload, "handle");
  if (!handle.ok) {
    return handle;
  }
  const capabilityProfile = parseOptionalStringField(payload, "capabilityProfile");
  if (!capabilityProfile.ok) {
    return capabilityProfile;
  }
  const capabilities = parseOptionalStringArrayField(payload, "capabilities");
  if (!capabilities.ok) {
    return capabilities;
  }
  const keyId = parseOptionalStringField(payload, "keyId");
  if (!keyId.ok) {
    return keyId;
  }
  const legacyPeerId = parseOptionalStringField(payload, "legacyPeerId");
  if (!legacyPeerId.ok) {
    return legacyPeerId;
  }
  const privateKey = parseOptionalStringField(payload, "privateKey");
  if (!privateKey.ok) {
    return privateKey;
  }
  const gracePeriodHours = parseOptionalPositiveInteger(payload.gracePeriodHours);
  if (!gracePeriodHours.ok) {
    return { ok: false, error: "gracePeriodHours must be a positive integer" };
  }
  const expiresInDays = parseOptionalPositiveInteger(payload.expiresInDays);
  if (!expiresInDays.ok) {
    return { ok: false, error: "expiresInDays must be a positive integer" };
  }
  const nowUnixSeconds = parseOptionalNonNegativeInteger(payload.nowUnixSeconds);
  if (!nowUnixSeconds.ok) {
    return { ok: false, error: "nowUnixSeconds must be a non-negative integer" };
  }

  return {
    ok: true,
    input: {
      ...(gracePeriodHours.value !== undefined ? { gracePeriodHours: gracePeriodHours.value } : {}),
      ...(privateKey.value ? { privateKey: privateKey.value } : {}),
      ...(senderPeerId.value ? { senderPeerId: senderPeerId.value } : {}),
      ...(displayName.value ? { displayName: displayName.value } : {}),
      ...(handle.value ? { handle: handle.value } : {}),
      ...(capabilityProfile.value ? { capabilityProfile: capabilityProfile.value } : {}),
      ...(capabilities.value ? { capabilities: capabilities.value } : {}),
      ...(expiresInDays.value !== undefined ? { expiresInDays: expiresInDays.value } : {}),
      ...(keyId.value ? { keyId: keyId.value } : {}),
      ...(legacyPeerId.value ? { legacyPeerId: legacyPeerId.value } : {}),
      ...(nowUnixSeconds.value !== undefined ? { nowUnixSeconds: nowUnixSeconds.value } : {}),
    },
  };
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(authorization: string | undefined, secret: string): boolean {
  if (!secret || !authorization) {
    return false;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  return secureEquals(match[1], secret);
}

function demoHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vigil Live Demo</title>
  <style>
    :root {
      --bg: radial-gradient(circle at 10% 20%, #0f172a 0%, #111827 38%, #041022 100%);
      --card: rgba(255, 255, 255, 0.08);
      --line: rgba(255, 255, 255, 0.22);
      --text: #f8fafc;
      --muted: #94a3b8;
      --ok: #34d399;
      --warn: #fb923c;
      --bad: #f87171;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      padding: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--card);
      backdrop-filter: blur(4px);
      padding: 14px;
    }
    h1 { margin: 0 0 14px; font-size: 24px; }
    h2 { margin: 0 0 8px; font-size: 15px; color: var(--muted); }
    .kpi { font-size: 28px; font-weight: 700; color: var(--ok); }
    pre {
      margin: 0;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      color: #dbeafe;
    }
    .feed { max-height: 280px; overflow: auto; }
    .chip { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; margin:0 4px 4px 0; font-size:12px; }
    .warn { color: var(--warn); }
    .status.available { color: var(--ok); }
    .status.restricted { color: var(--warn); }
    .status.degraded { color: var(--bad); }
    .meta { margin-top: 8px; font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <h1>Vigil Execution Console</h1>
  <div class="grid">
    <div class="card"><h2>Today Net PnL</h2><div id="net" class="kpi">0.00</div></div>
    <div class="card"><h2>Trades</h2><div id="trades" class="kpi">0</div></div>
    <div class="card"><h2>Opportunities</h2><div id="opps" class="kpi">0</div></div>
    <div class="card"><h2>Mode</h2><div id="mode" class="kpi warn">paper</div></div>
    <div class="card">
      <h2>Official Link</h2>
      <div id="official-status" class="kpi status degraded">降级</div>
      <div id="official-hint" class="meta">Probe pending...</div>
    </div>
  </div>

  <div class="grid" style="margin-top:14px;">
    <div class="card">
      <h2>Strategy Leaderboard</h2>
      <div id="strategies"></div>
    </div>
    <div class="card">
      <h2>Latest Share Card</h2>
      <pre id="share">No successful trade yet</pre>
    </div>
    <div class="card">
      <h2>Growth Moments</h2>
      <pre id="moments">No growth moments yet</pre>
    </div>
    <div class="card">
      <h2>Execution Backend Probe</h2>
      <pre id="probe">Probe pending...</pre>
    </div>
    <div class="card feed">
      <h2>Live Stream Feed</h2>
      <pre id="feed"></pre>
    </div>
  </div>

  <script>
    const el = {
      net: document.getElementById("net"),
      trades: document.getElementById("trades"),
      opps: document.getElementById("opps"),
      mode: document.getElementById("mode"),
      officialStatus: document.getElementById("official-status"),
      officialHint: document.getElementById("official-hint"),
      strategies: document.getElementById("strategies"),
      share: document.getElementById("share"),
      moments: document.getElementById("moments"),
      probe: document.getElementById("probe"),
      feed: document.getElementById("feed"),
    };

    const OFFICIAL_LABEL = {
      available: "可用",
      restricted: "受限",
      degraded: "降级",
    };

    function isV6Path(path) {
      return typeof path === "string" && path.startsWith("/api/v6/");
    }

    function includesRestrictedHint(text) {
      const value = String(text || "").toLowerCase();
      return (
        value.includes("whitelist") ||
        value.includes("permission") ||
        value.includes("unauthorized") ||
        value.includes("forbidden") ||
        value.includes("restricted") ||
        value.includes("403") ||
        value.includes("401")
      );
    }

    function classifyOfficialStatus(probe, integration, statusCode) {
      const message = probe && typeof probe === "object" ? probe.message : "";
      const restricted = includesRestrictedHint(message) || includesRestrictedHint(integration && integration.lastError);

      const probePaths = [
        probe && probe.quotePath,
        probe && probe.swapPath,
        probe && probe.simulatePath,
      ].filter((path) => typeof path === "string" && path.length > 0);
      const fallbackByProbe = probePaths.some((path) => !isV6Path(path));
      const fallbackByStatus = integration && typeof integration.lastUsedPath === "string" && !isV6Path(integration.lastUsedPath);

      if (probe && probe.ok === true && !fallbackByProbe && !fallbackByStatus) {
        return "available";
      }
      if (restricted || statusCode === 401 || statusCode === 403) {
        return "restricted";
      }
      return "degraded";
    }

    function renderOfficialStatus(level) {
      el.officialStatus.textContent = OFFICIAL_LABEL[level];
      el.officialStatus.className = "kpi status " + level;
      el.officialHint.textContent =
        level === "available"
          ? "官方 v6 链路可用"
          : level === "restricted"
            ? "权限受限，建议核验白名单与 API 权限"
            : "官方链路受阻，按降级路径运行";
    }

    async function refreshProbe() {
      const requestedAt = new Date().toISOString();
      try {
        const [integrationResp, probeResp] = await Promise.all([
          fetch("/api/v1/integration/execution/status"),
          fetch("/api/v1/integration/execution/probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pair: "ETH/USDC", chainIndex: "196", notionalUsd: 25 }),
          }),
        ]);
        const integration = integrationResp.ok ? await integrationResp.json() : null;
        const probe = await probeResp.json();
        const level = classifyOfficialStatus(probe, integration, probeResp.status);
        renderOfficialStatus(level);
        el.probe.textContent = JSON.stringify(
          {
            officialStatus: level,
            checkedAt: probe.checkedAt || requestedAt,
            integration,
            probe,
          },
          null,
          2,
        );
      } catch (error) {
        renderOfficialStatus("degraded");
        el.probe.textContent = JSON.stringify(
          {
            officialStatus: "degraded",
            checkedAt: requestedAt,
            error: String(error),
          },
          null,
          2,
        );
      }
    }

    refreshProbe();
    setInterval(refreshProbe, 30000);

    const stream = new EventSource("/api/v1/stream/metrics");
    stream.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      el.net.textContent = Number(data.metrics.netUsd || 0).toFixed(2);
      el.trades.textContent = String(data.metrics.trades || 0);
      el.opps.textContent = String(data.metrics.opportunities || 0);
      el.mode.textContent = data.mode;
      el.mode.className = "kpi " + (data.mode === "live" ? "" : "warn");

      const strategies = Array.isArray(data.strategies) ? data.strategies : [];
      el.strategies.replaceChildren();
      if (strategies.length === 0) {
        const empty = document.createElement("span");
        empty.className = "warn";
        empty.textContent = "No strategy stats yet";
        el.strategies.appendChild(empty);
      } else {
        for (const s of strategies) {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = String(s.strategyId || "unknown") + ": " + Number(s.netUsd || 0).toFixed(2);
          el.strategies.appendChild(chip);
        }
      }

      if (data.share) {
        el.share.textContent = data.share.text;
      }
      if (Array.isArray(data.moments) && data.moments.length > 0) {
        const lines = data.moments.map((m) => "- " + String(m.title || "moment") + "\\n  " + String(m.text || ""));
        el.moments.textContent = lines.join("\\n");
      }

      const line = "[" + new Date().toISOString() + "] net=" + Number(data.metrics.netUsd || 0).toFixed(2) + " trades=" + data.metrics.trades + " mode=" + data.mode;
      el.feed.textContent = (line + "\n" + el.feed.textContent).slice(0, 6000);
    };
  </script>
</body>
</html>`;
}

const livingAssistantAttentionLevels = [
  "log",
  "notify",
  "call",
] as const satisfies readonly AttentionLevel[];

const defaultLivingAssistantRiskTolerance: UserContext["riskTolerance"] = "moderate";

interface LivingAssistantDemoScenario {
  name: string;
  description: string;
  signal: NormalizedSignal;
  userContext: UserContext;
  policyConfig?: Partial<ContactPolicyConfig>;
  expectedAttentionLevel: AttentionLevel;
  expectedBrief: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBoundedInteger(input: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(input ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function toOptionalBoundedInteger(input: unknown, min: number, max: number): number | undefined {
  if (input === undefined || input === null || input === "") {
    return undefined;
  }
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function toStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function toRiskTolerance(input: unknown): UserContext["riskTolerance"] {
  const value = readTrimmedString(input).toLowerCase();
  if (value === "conservative" || value === "aggressive" || value === "moderate") {
    return value;
  }
  return defaultLivingAssistantRiskTolerance;
}

function toAttentionLevel(input: unknown): AttentionLevel | undefined {
  const value = readTrimmedString(input);
  if (!value) {
    return undefined;
  }
  if (isAllowedValue(value, livingAssistantAttentionLevels)) {
    return value;
  }
  return undefined;
}

function toLivingAssistantUserContext(input: unknown): UserContext {
  const payload = isRecord(input) ? input : {};
  const quietHoursStart = toOptionalBoundedInteger(payload.quietHoursStart, 0, 23);
  const quietHoursEnd = toOptionalBoundedInteger(payload.quietHoursEnd, 0, 23);
  const maxDailyContacts = toOptionalBoundedInteger(payload.maxDailyContacts, 1, 10_000);

  return {
    localHour: toBoundedInteger(payload.localHour, new Date().getHours(), 0, 23),
    recentContactCount: toBoundedInteger(payload.recentContactCount, 0, 0, 10_000),
    activeStrategies: toStringArray(payload.activeStrategies),
    watchlist: toStringArray(payload.watchlist),
    riskTolerance: toRiskTolerance(payload.riskTolerance),
    ...(quietHoursStart !== undefined ? { quietHoursStart } : {}),
    ...(quietHoursEnd !== undefined ? { quietHoursEnd } : {}),
    ...(maxDailyContacts !== undefined ? { maxDailyContacts } : {}),
  };
}

function mergeLivingAssistantPolicyConfig(input: unknown): ContactPolicyConfig {
  const payload = isRecord(input) ? input : {};

  return {
    ...defaultContactPolicyConfig,
    quietHoursStart: toBoundedInteger(payload.quietHoursStart, defaultContactPolicyConfig.quietHoursStart, 0, 23),
    quietHoursEnd: toBoundedInteger(payload.quietHoursEnd, defaultContactPolicyConfig.quietHoursEnd, 0, 23),
    maxContactsPerHour: toBoundedInteger(
      payload.maxContactsPerHour,
      defaultContactPolicyConfig.maxContactsPerHour,
      1,
      10_000,
    ),
    maxContactsPerDay: toBoundedInteger(
      payload.maxContactsPerDay,
      defaultContactPolicyConfig.maxContactsPerDay,
      1,
      10_000,
    ),
    allowCallEscalation:
      typeof payload.allowCallEscalation === "boolean"
        ? payload.allowCallEscalation
        : defaultContactPolicyConfig.allowCallEscalation,
    digestWindowMinutes: toBoundedInteger(
      payload.digestWindowMinutes,
      defaultContactPolicyConfig.digestWindowMinutes,
      1,
      1440,
    ),
  };
}

function listLivingAssistantCapsules(
  fixtureDir = path.resolve(process.cwd(), "fixtures", "signal-capsules"),
): string[] {
  if (!fs.existsSync(fixtureDir)) {
    return [];
  }
  return fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function loadLivingAssistantDemoScenario(
  scenarioName: string,
  fixtureDir = path.resolve(process.cwd(), "fixtures", "demo-scenarios"),
): LivingAssistantDemoScenario {
  const normalizedName = scenarioName.trim();
  if (!/^[a-z0-9-]+$/i.test(normalizedName)) {
    throw new Error("invalid scenario name");
  }

  const scenarioPath = path.resolve(fixtureDir, `${normalizedName}.json`);
  const scenarioRoot = path.resolve(fixtureDir);
  const expectedPrefix = `${scenarioRoot}${path.sep}`;
  if (scenarioPath !== scenarioRoot && !scenarioPath.startsWith(expectedPrefix)) {
    throw new Error("invalid scenario path");
  }

  const raw = fs.readFileSync(scenarioPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("invalid scenario payload");
  }

  const expectedAttentionLevel = toAttentionLevel(parsed.expectedAttentionLevel);
  if (!expectedAttentionLevel) {
    throw new Error("invalid expectedAttentionLevel");
  }
  if (typeof parsed.expectedBrief !== "boolean") {
    throw new Error("invalid expectedBrief");
  }

  return {
    name: readTrimmedString(parsed.name) || normalizedName,
    description: readTrimmedString(parsed.description),
    signal: normalizeSignal(parsed.signal as never),
    userContext: toLivingAssistantUserContext(parsed.userContext),
    policyConfig: isRecord(parsed.policyConfig) ? parsed.policyConfig as Partial<ContactPolicyConfig> : undefined,
    expectedAttentionLevel,
    expectedBrief: parsed.expectedBrief,
  };
}

export function createServer(
  engine: AlphaEngine,
  store: StateStore,
  manifest: SkillManifest,
  options?: {
    config?: AlphaOsConfig;
    defaultRiskPolicy?: RiskPolicy;
    onchainClient?: OnchainOsClient;
    discoveryEngine?: DiscoveryEngine;
    apiSecret?: string;
    demoPublic?: boolean;
    agentCommRuntime?: AgentCommRuntimeHandle;
    agentCommSendDeps?: Pick<AgentCommEntrypointDependencies, "config" | "vault">;
  },
) {
  const app = express();
  app.use(express.json({ limit: "512kb" }));
  const apiSecret = options?.apiSecret ?? process.env.API_SECRET ?? "";
  const demoPublic = options?.demoPublic ?? parseBoolean(process.env.DEMO_PUBLIC, false);
  const livingAssistantDigestScheduler = new DigestBatchScheduler();

  if (options?.config) {
    store.backfillAgentContactsFromLegacyPeers({
      chainId: options.config.commChainId,
    });
  }

  const requireApiAuth: express.RequestHandler = (req, res, next) => {
    if (isAuthorized(req.header("authorization"), apiSecret)) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "unauthorized" });
  };

  const requireDemoAuthIfPrivate: express.RequestHandler = (req, res, next) => {
    if (demoPublic) {
      next();
      return;
    }
    requireApiAuth(req, res, next);
  };

  const replay = new SandboxReplayService(store, options?.defaultRiskPolicy ?? {
    minNetEdgeBpsPaper: 45,
    minNetEdgeBpsLive: 60,
    maxTradePctBalance: 0.03,
    maxDailyLossPct: 0.015,
    maxConsecutiveFailures: 3,
  });

  const getProfileSnapshot = () => {
    if (!options?.config) {
      return undefined;
    }
    return getNetworkProfileReadinessSnapshot({
      config: options.config,
      onchainClient: options.onchainClient,
    });
  };

  app.get("/health", (_req, res) => {
    const networkProfile = getProfileSnapshot();
    res.json({
      ok: true,
      mode: engine.getCurrentMode(),
      service: "alphaos",
      strategies: manifest.strategyIds,
      ...(networkProfile
        ? {
            networkProfile: {
              id: networkProfile.profile.id,
              readiness: networkProfile.readiness,
              summary: networkProfile.summary,
              reasons: networkProfile.reasons,
            },
          }
        : {}),
    });
  });

  app.get("/demo", requireDemoAuthIfPrivate, (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(demoHtml());
  });

  app.get("/api/v1/manifest", requireApiAuth, (_req, res) => {
    res.json(manifest);
  });

  app.get("/api/v1/status", requireApiAuth, async (_req, res) => {
    if (!options?.config) {
      res.status(503).json({ error: "runtime config unavailable" });
      return;
    }

    try {
      const networkProfile = await probeNetworkProfileReadiness({
        config: options.config,
        onchainClient: options.onchainClient,
      });

      res.json({
        ok: true,
        service: "alphaos",
        mode: engine.getCurrentMode(),
        strategies: manifest.strategyIds,
        networkProfile,
        ...(options.onchainClient
          ? {
              onchain: options.onchainClient.getIntegrationStatus(),
            }
          : {}),
      });
    } catch (error) {
      res.status(500).json({
        error: "status_probe_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const handleIntegrationStatus: RequestHandler = (_req, res) => {
    if (!options?.onchainClient) {
      res.status(503).json({ error: "onchain client unavailable" });
      return;
    }
    const networkProfile = getProfileSnapshot();
    res.json({
      ...options.onchainClient.getIntegrationStatus(),
      ...(networkProfile ? { networkProfile } : {}),
    });
  };

  app.get("/api/v1/integration/onchainos/status", requireApiAuth, handleIntegrationStatus);
  app.get("/api/v1/integration/execution/status", requireApiAuth, handleIntegrationStatus);

  const handleIntegrationProbe: RequestHandler = async (req, res) => {
    if (!options?.onchainClient) {
      res.status(503).json({ error: "onchain client unavailable" });
      return;
    }

    const pair = typeof req.body?.pair === "string" ? req.body.pair.trim().toUpperCase() : undefined;
    const chainIndex = typeof req.body?.chainIndex === "string" ? req.body.chainIndex.trim() : undefined;
    const userWalletAddress =
      typeof req.body?.userWalletAddress === "string" ? req.body.userWalletAddress.trim() : undefined;
    const notionalRaw = Number(req.body?.notionalUsd);
    const notionalUsd = Number.isFinite(notionalRaw) ? notionalRaw : undefined;

    const result = await options.onchainClient.probeConnection({
      pair,
      chainIndex,
      userWalletAddress,
      notionalUsd,
    });
    res.status(result.ok ? 200 : 503).json(result);
  };

  app.post("/api/v1/integration/onchainos/probe", requireApiAuth, handleIntegrationProbe);
  app.post("/api/v1/integration/execution/probe", requireApiAuth, handleIntegrationProbe);

  const handleTokenCache: RequestHandler = (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : undefined;
    const chainIndex = typeof req.query.chainIndex === "string" ? req.query.chainIndex.trim() : undefined;
    const limit = toLimit(req.query.limit, 100);
    res.json({
      items: store.listTokenCache(limit, symbol, chainIndex),
    });
  };

  app.get("/api/v1/integration/onchainos/token-cache", requireApiAuth, handleTokenCache);
  app.get("/api/v1/integration/execution/token-cache", requireApiAuth, handleTokenCache);

  app.get("/api/v1/stream/metrics", requireDemoAuthIfPrivate, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = () => {
      const payload = {
        mode: engine.getCurrentMode(),
        metrics: store.getTodayMetrics(),
        strategies: store.listStrategyStatusToday(),
        share: store.getLatestShareCard(),
        moments: store.listGrowthMoments(3),
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send();
    const timer = setInterval(send, 1000);
    req.on("close", () => {
      clearInterval(timer);
      res.end();
    });
  });

  app.use("/api/v1", requireApiAuth);

  app.post("/api/v1/living-assistant/evaluate", async (req, res) => {
    const payload = isRecord(req.body) ? req.body : {};
    if (!("signal" in payload)) {
      res.status(400).json({ error: "signal is required" });
      return;
    }

    let signal: NormalizedSignal;
    try {
      signal = normalizeSignal(payload.signal as never);
    } catch (error) {
      res.status(400).json({
        error: "invalid signal payload",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const userContext = toLivingAssistantUserContext(payload.userContext);
    const policyConfig = mergeLivingAssistantPolicyConfig(payload.policyConfig);
    const demoMode = typeof payload.demoMode === "boolean" ? payload.demoMode : true;

    res.json(
      await runLivingAssistantLoop({
        signal,
        userContext,
        policyConfig,
        digestScheduler: livingAssistantDigestScheduler,
        demoMode,
      }),
    );
  });

  app.get("/api/v1/living-assistant/demo/:scenarioName", async (req, res) => {
    const scenarioName = String(req.params.scenarioName ?? "").trim();
    if (!scenarioName) {
      res.status(400).json({ error: "scenarioName is required" });
      return;
    }

    try {
      const scenario = loadLivingAssistantDemoScenario(scenarioName);
      const policyConfig = mergeLivingAssistantPolicyConfig(scenario.policyConfig);
      res.json(
        await runLivingAssistantLoop({
          signal: scenario.signal,
          userContext: scenario.userContext,
          policyConfig,
          digestScheduler: livingAssistantDigestScheduler,
          demoMode: true,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        res.status(404).json({ error: "scenario not found" });
        return;
      }
      res.status(400).json({ error: "invalid scenario", detail: message });
    }
  });

  app.get("/api/v1/living-assistant/capsules", (_req, res) => {
    res.json({ items: listLivingAssistantCapsules() });
  });

  app.get("/api/v1/living-assistant/digest/status", (_req, res) => {
    res.json({
      queue: livingAssistantDigestScheduler.getSnapshot(),
    });
  });

  app.post("/api/v1/living-assistant/digest/flush", (req, res) => {
    const payload = isRecord(req.body) ? req.body : {};
    const force = typeof payload.force === "boolean" ? payload.force : true;
    const digest = force ? livingAssistantDigestScheduler.flushNow() : livingAssistantDigestScheduler.flushDue();
    res.json({
      force,
      flushed: Boolean(digest),
      digest: digest ?? null,
      queue: livingAssistantDigestScheduler.getSnapshot(),
    });
  });

  const respondDiscoveryUnavailable = (res: express.Response) => {
    res.status(503).json({ error: "discovery engine unavailable" });
  };

  const ensureDiscoveryEngine = (res: express.Response): DiscoveryEngine | null => {
    const discovery = options?.discoveryEngine;
    if (!discovery) {
      respondDiscoveryUnavailable(res);
      return null;
    }
    return discovery;
  };

  const loadDiscoverySession = (res: express.Response, sessionIdParam: unknown) => {
    const discovery = ensureDiscoveryEngine(res);
    if (!discovery) {
      return null;
    }
    const sessionId = String(sessionIdParam ?? "").trim();
    const session = discovery.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return null;
    }
    return { discovery, sessionId, session };
  };

  const handleDiscoveryError = (res: express.Response, error: unknown) => {
    const code = DiscoveryEngine.errorCode(error);
    if (code === "invalid_strategy" || code === "invalid_pairs") {
      res.status(400).json({ error: String(error), code });
      return;
    }
    if (code === "session_conflict" || code === "session_active" || code === "candidate_not_pending") {
      res.status(409).json({ error: String(error), code });
      return;
    }
    if (code === "not_found" || code === "candidate_not_found") {
      res.status(404).json({ error: String(error), code });
      return;
    }
    res.status(500).json({ error: "discovery_internal_error", detail: String(error), code });
  };

  const ensureAgentCommSendDeps = (
    res: express.Response,
  ): AgentCommEntrypointDependencies | null => {
    const sendDeps = options?.agentCommSendDeps;
    if (!sendDeps) {
      res.status(503).json({ error: "agent-comm send unavailable" });
      return null;
    }
    return {
      config: sendDeps.config,
      store,
      vault: sendDeps.vault,
    };
  };

  const handleAgentCommApiError = (res: express.Response, error: unknown) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: error.issues.map((issue) => issue.message).join("; ") || "invalid request",
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("contact not found:")) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.startsWith("cannot send ")) {
      res.status(409).json({ error: message });
      return;
    }
    if (
      message.startsWith("Trusted peer not found:") ||
      message.startsWith("Peer is not trusted:") ||
      message.startsWith("active transport endpoint not found") ||
      message.startsWith("Invalid ")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    if (
      message.includes("VAULT_MASTER_PASSWORD is required") ||
      message.includes("COMM_RPC_URL is required")
    ) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: "agent_comm_send_failed", detail: message });
  };

  app.post("/api/v1/engine/mode", (req, res) => {
    const mode = req.body?.mode;
    if (typeof mode !== "string" || !isExecutionMode(mode)) {
      res.status(400).json({ error: "mode must be paper or live" });
      return;
    }
    const result = engine.requestMode(mode);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/api/v1/discovery/sessions/start", async (req, res) => {
    const discovery = ensureDiscoveryEngine(res);
    if (!discovery) {
      return;
    }

    const strategyId = String(req.body?.strategyId ?? "").trim();
    if (!isDiscoveryStrategyId(strategyId)) {
      res.status(400).json({ error: "strategyId must be spread-threshold | mean-reversion | volatility-breakout" });
      return;
    }

    const pairs = normalizeDiscoveryPairs(req.body?.pairs);
    if (!pairs) {
      res.status(400).json({ error: "pairs must be a non-empty string array" });
      return;
    }
    const duration = parseOptionalPositiveNumber(req.body?.durationMinutes);
    if (!duration.ok) {
      res.status(400).json({ error: "durationMinutes must be a positive number" });
      return;
    }
    const sampleInterval = parseOptionalPositiveNumber(req.body?.sampleIntervalSec);
    if (!sampleInterval.ok) {
      res.status(400).json({ error: "sampleIntervalSec must be a positive number" });
      return;
    }
    const topN = parseOptionalPositiveNumber(req.body?.topN);
    if (!topN.ok) {
      res.status(400).json({ error: "topN must be a positive number" });
      return;
    }

    try {
      const session = await discovery.startSession({
        strategyId,
        pairs,
        durationMinutes: duration.value,
        sampleIntervalSec: sampleInterval.value,
        topN: topN.value,
      });
      res.json({
        sessionId: session.id,
        status: session.status,
        startedAt: session.startedAt,
        plannedEndAt: session.plannedEndAt,
      });
    } catch (error) {
      handleDiscoveryError(res, error);
    }
  });

  app.get("/api/v1/discovery/sessions/active", (_req, res) => {
    const discovery = ensureDiscoveryEngine(res);
    if (!discovery) {
      return;
    }
    res.json(discovery.getActiveSession());
  });

  app.get("/api/v1/discovery/sessions/:sessionId", (req, res) => {
    const context = loadDiscoverySession(res, req.params.sessionId);
    if (!context) {
      return;
    }
    res.json(context.session);
  });

  app.get("/api/v1/discovery/sessions/:sessionId/candidates", (req, res) => {
    const context = loadDiscoverySession(res, req.params.sessionId);
    if (!context) {
      return;
    }
    const limit = toLimit(req.query.limit, 50);
    res.json({ items: context.discovery.listCandidates(context.sessionId, limit) });
  });

  app.get("/api/v1/discovery/sessions/:sessionId/report", (req, res) => {
    const context = loadDiscoverySession(res, req.params.sessionId);
    if (!context) {
      return;
    }
    const report = context.discovery.getReport(context.sessionId);
    if (!report) {
      res.status(404).json({ error: "report not ready" });
      return;
    }
    res.json(report);
  });

  app.post("/api/v1/discovery/sessions/:sessionId/stop", async (req, res) => {
    const discovery = ensureDiscoveryEngine(res);
    if (!discovery) {
      return;
    }
    const sessionId = String(req.params.sessionId ?? "").trim();
    try {
      const session = await discovery.stopSession(sessionId);
      res.json(session);
    } catch (error) {
      handleDiscoveryError(res, error);
    }
  });

  app.post("/api/v1/discovery/sessions/:sessionId/approve", async (req, res) => {
    const discovery = ensureDiscoveryEngine(res);
    if (!discovery) {
      return;
    }
    const sessionId = String(req.params.sessionId ?? "").trim();
    const candidateId = String(req.body?.candidateId ?? "").trim();
    if (!candidateId) {
      res.status(400).json({ error: "candidateId is required" });
      return;
    }
    const mode = req.body?.mode === "live" ? "live" : "paper";
    if (req.body?.mode !== undefined && req.body?.mode !== "paper" && req.body?.mode !== "live") {
      res.status(400).json({ error: "mode must be paper or live" });
      return;
    }
    try {
      const discoveryCandidate = store.getDiscoveryCandidate(sessionId, candidateId) ?? undefined;
      const result = await discovery.approveCandidate(sessionId, candidateId, mode);
      const updatedCandidate = store.getDiscoveryCandidate(sessionId, candidateId) ?? discoveryCandidate;
      const compatibilityAdapters = parseFirstBatchAdapterInputs(req.body?.adapterInputs);
      const moduleResponse = adaptArbitrageModuleResponse({
        requestId: `discovery:${sessionId}:${candidateId}`,
        mode,
        requestedMode: mode,
        effectiveMode: result.effectiveMode,
        discoveryCandidate: updatedCandidate ?? undefined,
        approveResult: result,
        compatibilityAdapters,
      });
      const skillAttribution = buildModuleSkillAttributionView(moduleResponse);
      res.json({
        ...result,
        moduleResponse,
        skillAttribution,
      });
    } catch (error) {
      handleDiscoveryError(res, error);
    }
  });

  app.get("/api/v1/metrics/today", (_req, res) => {
    res.json(store.getTodayMetrics());
  });

  app.get("/api/v1/strategies/status", (_req, res) => {
    res.json({ items: store.listStrategyStatusToday() });
  });

  app.get("/api/v1/strategies/profiles", (_req, res) => {
    res.json({ items: store.listStrategyProfiles() });
  });

  app.post("/api/v1/strategies/profile", (req, res) => {
    const strategyId = String(req.body?.strategyId ?? "").trim();
    const variant = req.body?.variant === "B" ? "B" : "A";
    const params = req.body?.params;

    if (!strategyId) {
      res.status(400).json({ error: "strategyId is required" });
      return;
    }

    if (!params || typeof params !== "object" || Array.isArray(params)) {
      res.status(400).json({ error: "params must be an object" });
      return;
    }

    store.upsertStrategyProfile(strategyId, variant, params as Record<string, unknown>);
    res.status(200).json({ ok: true, strategyId, variant });
  });

  app.get("/api/v1/opportunities", (req, res) => {
    const limit = toLimit(req.query.limit, 50);
    res.json({ items: store.listOpportunities(limit) });
  });

  app.get("/api/v1/trades", (req, res) => {
    const limit = toLimit(req.query.limit, 50);
    res.json({ items: store.listTrades(limit) });
  });

  app.get("/api/v1/growth/share/latest", (_req, res) => {
    const card = store.getLatestShareCard();
    if (!card) {
      res.status(404).json({ error: "no successful trade yet" });
      return;
    }
    res.json(card);
  });

  app.get("/api/v1/growth/moments", (req, res) => {
    const limit = toLimit(req.query.limit, 5);
    res.json({ items: store.listGrowthMoments(limit) });
  });

  app.get("/api/v1/backtest/snapshot", (req, res) => {
    const hours = toHours(req.query.hours, 24);
    const format = String(req.query.format ?? "json");
    const rows = store.getBacktestSnapshot(hours);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="alphaos-backtest-${hours}h.csv"`);
      res.send(toCsv(rows));
      return;
    }

    res.json({ hours, generatedAt: new Date().toISOString(), rows });
  });

  app.get("/api/v1/agent-comm/status", (_req, res) => {
    const runtime = options?.agentCommRuntime;
    if (!runtime) {
      res.status(503).json({ error: "agent-comm runtime unavailable" });
      return;
    }

    res.json(createAgentCommStatusResponse(store, runtime, options?.config));
  });

  app.get("/api/v1/agent-comm/messages", (req, res) => {
    const parsed = parseAgentMessageListQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    res.json({
      items: store.listAgentMessages(parsed.limit, parsed.filters),
    });
  });

  app.get("/api/v1/agent-comm/peers", (req, res) => {
    const parsed = parseAgentPeerListQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    res.json({ items: store.listAgentPeers(parsed.limit, parsed.status) });
  });

  app.post("/api/v1/agent-comm/peers/trusted", (req, res) => {
    const parsed = parseTrustedPeerUpsertBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const peer = registerTrustedPeerEntry(
      {
        store,
      },
      parsed.input,
    );
    const contact = store.getAgentContactByLegacyPeerId(peer.peerId);
    res.json({
      ...peer,
      contactId: contact?.contactId,
      legacyManualRecord: true,
      legacyMarkers: ["manual_peer_record"],
      warnings: [LEGACY_MANUAL_PEER_TRUST_WARNING],
    });
  });

  app.get("/api/v1/agent-comm/contacts", (req, res) => {
    const parsed = parseAgentContactListQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    res.json({
      items: listAgentContactSurfaceItems(store, parsed.limit, parsed.filters),
    });
  });

  app.post("/api/v1/agent-comm/cards/import", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseCardImportBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(
        await importIdentityArtifactBundle(
          {
            config: deps.config,
            store,
          },
          parsed.input,
        ),
      );
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/cards/export", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseCardExportBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await exportIdentityArtifactBundle(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/artifacts/revoke", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseArtifactRevokeBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await revokeIdentityArtifact(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/artifacts/revocations/import", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseRevocationImportBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(
        await importRevocationNotice(
          {
            config: deps.config,
            store,
          },
          parsed.input,
        ),
      );
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.get("/api/v1/agent-comm/invites", (req, res) => {
    const parsed = parseAgentInviteListQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    res.json({
      items: listAgentInviteSurfaceItems(store, parsed.limit, parsed.filters),
    });
  });

  app.post("/api/v1/agent-comm/connections/invite", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseConnectionInviteBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommConnectionInvite(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/connections/:contactId/accept", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseConnectionAcceptBody(req.params.contactId, req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommConnectionAccept(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/connections/:contactId/reject", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseConnectionRejectBody(req.params.contactId, req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommConnectionReject(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/wallets/rotate", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseRotateWalletBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await rotateCommWallet(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/send/ping", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parsePingSendBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommPing(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  const handleLegacyProbeOnchainOsSend: RequestHandler = async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseProbeOnchainOsSendBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommProbeOnchainOs(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  };

  const handleProbeExecutionSend: RequestHandler = async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseProbeOnchainOsSendBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommProbeExecution(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  };

  app.post("/api/v1/agent-comm/send/probe-onchainos", handleLegacyProbeOnchainOsSend);
  app.post("/api/v1/agent-comm/send/probe-execution", handleProbeExecutionSend);

  app.post("/api/v1/agent-comm/send/start-discovery", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseStartDiscoverySendBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommStartDiscovery(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/agent-comm/send/request-mode-change", async (req, res) => {
    const deps = ensureAgentCommSendDeps(res);
    if (!deps) {
      return;
    }

    const parsed = parseRequestModeChangeSendBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      res.json(await sendCommRequestModeChange(deps, parsed.input));
    } catch (error) {
      handleAgentCommApiError(res, error);
    }
  });

  app.post("/api/v1/replay/sandbox", (req, res) => {
    const seed = String(req.body?.seed ?? `seed-${Date.now()}`);
    const mode = req.body?.mode === "live" ? "live" : "paper";
    const hours = toHours(req.body?.hours, 24);
    const strategyIdRaw = req.body?.strategyId;
    const strategyId = typeof strategyIdRaw === "string" && strategyIdRaw.trim() ? strategyIdRaw.trim() : undefined;
    const minEdgeRaw = req.body?.minEdgeBpsOverride;
    const minEdgeBpsOverride = Number.isFinite(Number(minEdgeRaw)) ? Number(minEdgeRaw) : undefined;

    const result = replay.run({
      seed,
      mode,
      hours,
      strategyId,
      minEdgeBpsOverride,
    });
    res.json(result);
  });

  return app;
}
