import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import type {
  BacktestSnapshotRow,
  DiscoveryCandidate,
  DiscoveryCandidateStatus,
  DiscoveryPipelineItem,
  DiscoveryReport,
  DiscoverySample,
  DiscoverySession,
  DiscoverySessionConfig,
  DiscoverySessionStatus,
  DiscoverySessionSummary,
  DiscoveryStrategyId,
  ExecutionMode,
  GrowthMoment,
  Opportunity,
  ShareCard,
  StrategyProfile,
  StrategyStatus,
  TokenCacheEntry,
  TodayMetrics,
  TradeResult,
} from "../types";
import {
  agentArtifactStatusSchema,
  agentConnectionEventSchema,
  agentContactSchema,
  agentLocalIdentitySchema,
  agentMessageSchema,
  agentSignedArtifactSchema,
  agentTransportEndpointSchema,
  encryptedEnvelopeV2PaymentSchema,
  agentPeerCapabilitySchema,
  agentPeerSchema,
  jsonObjectSchema,
} from "./agent-comm/types";
import type {
  AgentArtifactRevocationStatus,
  AgentArtifactStatus,
  AgentCommandType,
  AgentConnectionEvent,
  AgentConnectionEventStatus,
  AgentConnectionEventType,
  AgentContact,
  AgentContactStatus,
  AgentLocalIdentity,
  AgentLocalIdentityMode,
  AgentLocalIdentityRole,
  AgentMessage,
  AgentMessageDirection,
  AgentMessageStatus,
  AgentPeer,
  AgentPeerCapability,
  AgentPeerStatus,
  AgentSignedArtifact,
  AgentSignedArtifactType,
  AgentSignedArtifactVerificationStatus,
  AgentTransportEndpoint,
  AgentTransportEndpointStatus,
  EncryptedEnvelopeV2Payment,
  ListenerCursor,
} from "./agent-comm/types";
import { utcDay } from "./time";

export interface HookOutboxRow {
  id: string;
  endpoint: string;
  payload: string;
  retryCount: number;
  nextRetryAt: string;
  status: "pending" | "sent" | "dead";
}

interface SimulationRecord {
  opportunityId: string;
  mode: ExecutionMode;
  inputJson: string;
  resultJson: string;
  createdAt: string;
}

interface AgentPeerRow {
  peerId: string;
  name: string | null;
  walletAddress: string;
  pubkey: string;
  status: AgentPeerStatus;
  capabilitiesJson: string;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentMessageRow {
  id: string;
  direction: AgentMessageDirection;
  peerId: string;
  txHash: string | null;
  nonce: string;
  commandType: AgentCommandType;
  envelopeVersion: number | null;
  msgId: string | null;
  contactId: string | null;
  identityWallet: string | null;
  transportAddress: string | null;
  trustOutcome: string | null;
  paymentJson: string | null;
  decryptedCommandType: AgentCommandType | null;
  ciphertext: string;
  status: AgentMessageStatus;
  error: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  executedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListenerCursorRow {
  address: string;
  chainId: string;
  cursor: string;
  updatedAt: string;
}

interface AgentLocalIdentityRow {
  role: AgentLocalIdentityRole;
  walletAlias: string;
  walletAddress: string;
  identityWallet: string;
  chainId: number;
  mode: AgentLocalIdentityMode;
  activeBindingDigest: string | null;
  transportKeyId: string | null;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentSignedArtifactRow {
  id: string;
  artifactType: AgentSignedArtifactType;
  digest: string;
  signer: string;
  identityWallet: string;
  chainId: number;
  issuedAt: number;
  expiresAt: number;
  payloadJson: string;
  proofJson: string;
  verificationStatus: AgentSignedArtifactVerificationStatus;
  verificationError: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentContactRow {
  contactId: string;
  identityWallet: string;
  legacyPeerId: string | null;
  displayName: string | null;
  handle: string | null;
  status: AgentContactStatus;
  supportedProtocolsJson: string;
  capabilityProfile: string | null;
  capabilitiesJson: string;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentTransportEndpointRow {
  id: string;
  contactId: string;
  identityWallet: string;
  chainId: number;
  receiveAddress: string;
  pubkey: string;
  keyId: string;
  bindingDigest: string | null;
  endpointStatus: AgentTransportEndpointStatus;
  source: string;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentConnectionEventRow {
  id: string;
  contactId: string;
  identityWallet: string;
  direction: AgentMessageDirection;
  eventType: AgentConnectionEventType;
  eventStatus: AgentConnectionEventStatus;
  messageId: string | null;
  txHash: string | null;
  reason: string | null;
  metadataJson: string | null;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentArtifactStatusRow {
  artifactDigest: string;
  artifactType: AgentSignedArtifactType;
  identityWallet: string;
  status: AgentArtifactRevocationStatus;
  revokedByDigest: string | null;
  revokedAt: number | null;
  reason: string | null;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentLegacyPeerBackfillResult {
  processedPeers: number;
  createdContacts: number;
  updatedContacts: number;
  createdTransportEndpoints: number;
  updatedTransportEndpoints: number;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower] ?? null;
  }
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? 0;
  const weight = position - lower;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function formatSignedUsd(value: number): string {
  return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function createDb(filePath: string): Database.Database {
  return new Database(filePath);
}

function formatAgentCommRowContext(entity: string, field: string, primaryKey: string): string {
  return `invalid agent-comm ${entity}.${field} for ${primaryKey}`;
}

const agentPeerSelectSql = `SELECT peer_id AS peerId,
                                   name,
                                   wallet_address AS walletAddress,
                                   pubkey,
                                   status,
                                   capabilities_json AS capabilitiesJson,
                                   metadata_json AS metadataJson,
                                   created_at AS createdAt,
                                   updated_at AS updatedAt
                            FROM agent_peers`;

const agentMessageSelectSql = `SELECT id,
                                      direction,
                                      peer_id AS peerId,
                                      tx_hash AS txHash,
                                      nonce,
                                      command_type AS commandType,
                                      envelope_version AS envelopeVersion,
                                      msg_id AS msgId,
                                      contact_id AS contactId,
                                      identity_wallet AS identityWallet,
                                      transport_address AS transportAddress,
                                      trust_outcome AS trustOutcome,
                                      payment_json AS paymentJson,
                                      decrypted_command_type AS decryptedCommandType,
                                      ciphertext,
                                      status,
                                      error,
                                      sent_at AS sentAt,
                                      received_at AS receivedAt,
                                      executed_at AS executedAt,
                                      created_at AS createdAt,
                                      updated_at AS updatedAt
                               FROM agent_messages`;

const listenerCursorSelectSql = `SELECT address,
                                        chain_id AS chainId,
                                        cursor,
                                        updated_at AS updatedAt
                                 FROM listener_cursors`;

const agentLocalIdentitySelectSql = `SELECT role,
                                            wallet_alias AS walletAlias,
                                            wallet_address AS walletAddress,
                                            identity_wallet AS identityWallet,
                                            chain_id AS chainId,
                                            mode,
                                            active_binding_digest AS activeBindingDigest,
                                            transport_key_id AS transportKeyId,
                                            metadata_json AS metadataJson,
                                            created_at AS createdAt,
                                            updated_at AS updatedAt
                                     FROM agent_local_identities`;

const agentSignedArtifactSelectSql = `SELECT id,
                                             artifact_type AS artifactType,
                                             digest,
                                             signer,
                                             identity_wallet AS identityWallet,
                                             chain_id AS chainId,
                                             issued_at AS issuedAt,
                                             expires_at AS expiresAt,
                                             payload_json AS payloadJson,
                                             proof_json AS proofJson,
                                             verification_status AS verificationStatus,
                                             verification_error AS verificationError,
                                             source,
                                             created_at AS createdAt,
                                             updated_at AS updatedAt
                                      FROM agent_signed_artifacts`;

const agentContactSelectSql = `SELECT contact_id AS contactId,
                                      identity_wallet AS identityWallet,
                                      legacy_peer_id AS legacyPeerId,
                                      display_name AS displayName,
                                      handle,
                                      status,
                                      supported_protocols_json AS supportedProtocolsJson,
                                      capability_profile AS capabilityProfile,
                                      capabilities_json AS capabilitiesJson,
                                      metadata_json AS metadataJson,
                                      created_at AS createdAt,
                                      updated_at AS updatedAt
                               FROM agent_contacts`;

const agentTransportEndpointSelectSql = `SELECT id,
                                                contact_id AS contactId,
                                                identity_wallet AS identityWallet,
                                                chain_id AS chainId,
                                                receive_address AS receiveAddress,
                                                pubkey,
                                                key_id AS keyId,
                                                binding_digest AS bindingDigest,
                                                endpoint_status AS endpointStatus,
                                                source,
                                                metadata_json AS metadataJson,
                                                created_at AS createdAt,
                                                updated_at AS updatedAt
                                         FROM agent_transport_endpoints`;

const agentConnectionEventSelectSql = `SELECT id,
                                              contact_id AS contactId,
                                              identity_wallet AS identityWallet,
                                              direction,
                                              event_type AS eventType,
                                              event_status AS eventStatus,
                                              message_id AS messageId,
                                              tx_hash AS txHash,
                                              reason,
                                              metadata_json AS metadataJson,
                                              occurred_at AS occurredAt,
                                              created_at AS createdAt,
                                              updated_at AS updatedAt
                                       FROM agent_connection_events`;

const agentArtifactStatusSelectSql = `SELECT artifact_digest AS artifactDigest,
                                             artifact_type AS artifactType,
                                             identity_wallet AS identityWallet,
                                             status,
                                             revoked_by_digest AS revokedByDigest,
                                             revoked_at AS revokedAt,
                                             reason,
                                             metadata_json AS metadataJson,
                                             created_at AS createdAt,
                                             updated_at AS updatedAt
                                      FROM agent_artifact_status`;

function normalizeAgentCommLimit(limit: number): number {
  return Math.max(1, Math.min(1000, Math.floor(limit)));
}

function normalizeChainId(value?: number): number {
  if (value === undefined) {
    return 0;
  }
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function toLegacyBackfillContactStatus(status: AgentPeerStatus): AgentContactStatus {
  switch (status) {
    case "trusted":
      return "trusted";
    case "blocked":
      return "blocked";
    case "revoked":
      return "revoked";
    case "pending":
    default:
      return "imported";
  }
}

function toLegacyBackfillEndpointStatus(status: AgentPeerStatus): AgentTransportEndpointStatus {
  switch (status) {
    case "blocked":
      return "inactive";
    case "revoked":
      return "revoked";
    case "trusted":
    case "pending":
    default:
      return "active";
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export class StateStore {
  private alphaDb: Database.Database;
  private vaultDb: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.alphaDb = createDb(path.join(dataDir, "alpha.db"));
    this.vaultDb = createDb(path.join(dataDir, "vault.db"));
    this.alphaDb.pragma("journal_mode = WAL");
    this.vaultDb.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.alphaDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id TEXT PRIMARY KEY,
        pair TEXT NOT NULL,
        dex TEXT NOT NULL,
        bid REAL NOT NULL,
        ask REAL NOT NULL,
        ts TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        pair TEXT NOT NULL,
        buy_dex TEXT NOT NULL,
        sell_dex TEXT NOT NULL,
        gross_edge_bps REAL NOT NULL,
        est_cost_usd REAL NOT NULL,
        est_net_usd REAL NOT NULL,
        status TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS simulations (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        gross_usd REAL NOT NULL,
        fee_usd REAL NOT NULL,
        net_usd REAL NOT NULL,
        error_type TEXT,
        latency_ms REAL,
        slippage_deviation_bps REAL,
        created_at TEXT NOT NULL,
        settled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pnl_daily (
        day TEXT NOT NULL,
        mode TEXT NOT NULL,
        gross_usd REAL NOT NULL,
        fee_usd REAL NOT NULL,
        net_usd REAL NOT NULL,
        trades_count INTEGER NOT NULL,
        PRIMARY KEY(day, mode)
      );

      CREATE TABLE IF NOT EXISTS quote_quality_daily (
        day TEXT PRIMARY KEY,
        total_quotes INTEGER NOT NULL,
        stale_quotes INTEGER NOT NULL,
        latency_sum_ms REAL NOT NULL,
        latency_samples INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hook_outbox (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        next_retry_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_profiles (
        strategy_id TEXT PRIMARY KEY,
        variant TEXT NOT NULL,
        params_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS token_cache (
        symbol TEXT NOT NULL,
        chain_index TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_decimals INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(symbol, chain_index)
      );

      CREATE TABLE IF NOT EXISTS mode_balances (
        mode TEXT PRIMARY KEY,
        baseline_usd REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_sessions (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        status TEXT NOT NULL,
        pairs_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        planned_end_at TEXT NOT NULL,
        ended_at TEXT,
        config_json TEXT NOT NULL,
        summary_json TEXT
      );

      CREATE TABLE IF NOT EXISTS discovery_samples (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        pair TEXT NOT NULL,
        ts TEXT NOT NULL,
        dex_a_mid REAL NOT NULL,
        dex_b_mid REAL NOT NULL,
        spread_bps REAL NOT NULL,
        volatility REAL,
        z_score REAL,
        features_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_candidates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        pair TEXT NOT NULL,
        buy_dex TEXT NOT NULL,
        sell_dex TEXT NOT NULL,
        signal_ts TEXT NOT NULL,
        score REAL NOT NULL,
        expected_net_bps REAL NOT NULL,
        expected_net_usd REAL NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_at TEXT,
        executed_trade_id TEXT
      );

      CREATE TABLE IF NOT EXISTS discovery_reports (
        session_id TEXT PRIMARY KEY,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_peers (
        peer_id TEXT PRIMARY KEY,
        name TEXT,
        wallet_address TEXT NOT NULL UNIQUE,
        pubkey TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        tx_hash TEXT,
        nonce TEXT NOT NULL,
        command_type TEXT NOT NULL,
        envelope_version INTEGER,
        msg_id TEXT,
        contact_id TEXT,
        identity_wallet TEXT,
        transport_address TEXT,
        trust_outcome TEXT,
        payment_json TEXT,
        decrypted_command_type TEXT,
        ciphertext TEXT NOT NULL,
        status TEXT NOT NULL,
        sent_at TEXT,
        received_at TEXT,
        executed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(peer_id, direction, nonce)
      );

      CREATE TABLE IF NOT EXISTS listener_cursors (
        address TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(address, chain_id)
      );

      CREATE TABLE IF NOT EXISTS agent_local_identities (
        role TEXT PRIMARY KEY,
        wallet_alias TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        identity_wallet TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        mode TEXT NOT NULL,
        active_binding_digest TEXT,
        transport_key_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_signed_artifacts (
        id TEXT PRIMARY KEY,
        artifact_type TEXT NOT NULL,
        digest TEXT NOT NULL UNIQUE,
        signer TEXT NOT NULL,
        identity_wallet TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        proof_json TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        verification_error TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_contacts (
        contact_id TEXT PRIMARY KEY,
        identity_wallet TEXT NOT NULL UNIQUE,
        legacy_peer_id TEXT UNIQUE,
        display_name TEXT,
        handle TEXT,
        status TEXT NOT NULL,
        supported_protocols_json TEXT NOT NULL,
        capability_profile TEXT,
        capabilities_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_transport_endpoints (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        identity_wallet TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        receive_address TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        key_id TEXT NOT NULL,
        binding_digest TEXT,
        endpoint_status TEXT NOT NULL,
        source TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(contact_id, receive_address, key_id)
      );

      CREATE TABLE IF NOT EXISTS agent_connection_events (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        identity_wallet TEXT NOT NULL,
        direction TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_status TEXT NOT NULL,
        message_id TEXT,
        tx_hash TEXT,
        reason TEXT,
        metadata_json TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(contact_id, direction, event_type, message_id)
      );

      CREATE TABLE IF NOT EXISTS agent_artifact_status (
        artifact_digest TEXT PRIMARY KEY,
        artifact_type TEXT NOT NULL,
        identity_wallet TEXT NOT NULL,
        status TEXT NOT NULL,
        revoked_by_digest TEXT,
        revoked_at INTEGER,
        reason TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_opportunities_status_detected_at
      ON opportunities(status, detected_at DESC);

      CREATE INDEX IF NOT EXISTS idx_trades_mode_created_at
      ON trades(mode, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pnl_daily_day
      ON pnl_daily(day);

      CREATE INDEX IF NOT EXISTS idx_hook_outbox_status_next_retry
      ON hook_outbox(status, next_retry_at);

      CREATE INDEX IF NOT EXISTS idx_token_cache_expires
      ON token_cache(expires_at);

      CREATE INDEX IF NOT EXISTS idx_discovery_sessions_status_started_at
      ON discovery_sessions(status, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_discovery_samples_session_pair_ts
      ON discovery_samples(session_id, pair, ts DESC);

      CREATE INDEX IF NOT EXISTS idx_discovery_candidates_session_score
      ON discovery_candidates(session_id, score DESC);

      CREATE INDEX IF NOT EXISTS idx_discovery_candidates_status
      ON discovery_candidates(status, signal_ts DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_peers_status_updated_at
      ON agent_peers(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_messages_peer_status_created_at
      ON agent_messages(peer_id, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_messages_tx_hash
      ON agent_messages(tx_hash);

      CREATE INDEX IF NOT EXISTS idx_agent_local_identities_wallet_address
      ON agent_local_identities(wallet_address);

      CREATE INDEX IF NOT EXISTS idx_agent_local_identities_identity_wallet
      ON agent_local_identities(identity_wallet);

      CREATE INDEX IF NOT EXISTS idx_agent_signed_artifacts_type_updated_at
      ON agent_signed_artifacts(artifact_type, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_signed_artifacts_identity_wallet
      ON agent_signed_artifacts(identity_wallet, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_signed_artifacts_signer
      ON agent_signed_artifacts(signer, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_contacts_identity_wallet
      ON agent_contacts(identity_wallet);

      CREATE INDEX IF NOT EXISTS idx_agent_contacts_legacy_peer_id
      ON agent_contacts(legacy_peer_id);

      CREATE INDEX IF NOT EXISTS idx_agent_contacts_status_updated_at
      ON agent_contacts(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_transport_endpoints_identity_wallet
      ON agent_transport_endpoints(identity_wallet, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_transport_endpoints_contact_status
      ON agent_transport_endpoints(contact_id, endpoint_status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_transport_endpoints_receive_active
      ON agent_transport_endpoints(receive_address, updated_at DESC)
      WHERE endpoint_status = 'active';

      CREATE INDEX IF NOT EXISTS idx_agent_connection_events_contact_status
      ON agent_connection_events(contact_id, event_status, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_connection_events_pending_state
      ON agent_connection_events(event_status, event_type, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_connection_events_message_id
      ON agent_connection_events(message_id);

      CREATE INDEX IF NOT EXISTS idx_agent_connection_events_tx_hash
      ON agent_connection_events(tx_hash);

      CREATE INDEX IF NOT EXISTS idx_agent_artifact_status_identity_wallet
      ON agent_artifact_status(identity_wallet, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_artifact_status_status
      ON agent_artifact_status(status, updated_at DESC);
    `);

    this.dropObsoletePhase2AgentCommTables(this.alphaDb);
    this.ensureAgentMessagesUniqueNonce(this.alphaDb);

    this.ensureColumn(this.alphaDb, "opportunities", "metadata_json", "TEXT");
    this.ensureColumn(this.alphaDb, "trades", "error_type", "TEXT");
    this.ensureColumn(this.alphaDb, "trades", "latency_ms", "REAL");
    this.ensureColumn(this.alphaDb, "trades", "slippage_deviation_bps", "REAL");
    this.ensureColumn(this.alphaDb, "agent_messages", "envelope_version", "INTEGER");
    this.ensureColumn(this.alphaDb, "agent_messages", "msg_id", "TEXT");
    this.ensureColumn(this.alphaDb, "agent_messages", "contact_id", "TEXT");
    this.ensureColumn(this.alphaDb, "agent_messages", "identity_wallet", "TEXT");
    this.ensureColumn(this.alphaDb, "agent_messages", "transport_address", "TEXT");
    this.ensureColumn(this.alphaDb, "agent_messages", "trust_outcome", "TEXT");
    this.ensureColumn(this.alphaDb, "agent_messages", "payment_json", "TEXT");
    this.ensureColumn(this.alphaDb, "agent_messages", "decrypted_command_type", "TEXT");
    this.alphaDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_messages_identity_wallet_updated_at
      ON agent_messages(identity_wallet, updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_direction_msg_id
      ON agent_messages(direction, msg_id)
      WHERE msg_id IS NOT NULL;
    `);

    this.vaultDb.exec(`
      CREATE TABLE IF NOT EXISTS vault_items (
        id TEXT PRIMARY KEY,
        key_alias TEXT UNIQUE NOT NULL,
        cipher_text TEXT NOT NULL,
        nonce TEXT NOT NULL,
        salt TEXT NOT NULL,
        kdf_iter INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        rotated_at TEXT
      );
    `);
  }

  private ensureColumn(db: Database.Database, table: string, column: string, def: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const exists = columns.some((c) => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  }

  private dropObsoletePhase2AgentCommTables(db: Database.Database): void {
    db.exec(`
      DROP TABLE IF EXISTS agent_message_receipts;
      DROP TABLE IF EXISTS agent_sessions;
      DROP TABLE IF EXISTS x402_receipts;
    `);
  }

  private ensureAgentMessagesUniqueNonce(db: Database.Database): void {
    const row = db
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table' AND name = 'agent_messages'`,
      )
      .get() as { sql: string | null } | undefined;

    const normalizedSql = row?.sql?.replace(/\s+/g, "").toUpperCase() ?? "";
    if (normalizedSql.includes("UNIQUE(PEER_ID,DIRECTION,NONCE)")) {
      return;
    }

    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_peer_direction_nonce
        ON agent_messages(peer_id, direction, nonce);
      `);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to enforce agent_messages uniqueness on (peer_id, direction, nonce): ${reason}`,
      );
    }
  }

  private runPreparedStatement(db: Database.Database, sql: string, ...params: unknown[]): void {
    db.prepare(sql).run(...params);
  }

  private toDiscoverySession(row: {
    id: string;
    strategyId: DiscoveryStrategyId;
    status: DiscoverySessionStatus;
    pairsJson: string;
    startedAt: string;
    plannedEndAt: string;
    endedAt: string | null;
    configJson: string;
    summaryJson: string | null;
  }): DiscoverySession {
    return {
      id: row.id,
      strategyId: row.strategyId,
      status: row.status,
      pairs: JSON.parse(row.pairsJson) as string[],
      startedAt: row.startedAt,
      plannedEndAt: row.plannedEndAt,
      endedAt: row.endedAt ?? undefined,
      config: JSON.parse(row.configJson) as DiscoverySessionConfig,
      summary: row.summaryJson ? (JSON.parse(row.summaryJson) as DiscoverySessionSummary) : undefined,
    };
  }

  private toDiscoveryCandidate(row: {
    id: string;
    sessionId: string;
    strategyId: DiscoveryStrategyId;
    pair: string;
    buyDex: string;
    sellDex: string;
    signalTs: string;
    score: number;
    expectedNetBps: number;
    expectedNetUsd: number;
    confidence: number;
    reason: string;
    inputJson: string;
    status: DiscoveryCandidateStatus;
    approvedAt: string | null;
    executedTradeId: string | null;
  }): DiscoveryCandidate {
    return {
      id: row.id,
      sessionId: row.sessionId,
      strategyId: row.strategyId,
      pair: row.pair,
      buyDex: row.buyDex,
      sellDex: row.sellDex,
      signalTs: row.signalTs,
      score: row.score,
      expectedNetBps: row.expectedNetBps,
      expectedNetUsd: row.expectedNetUsd,
      confidence: row.confidence,
      reason: row.reason,
      input: JSON.parse(row.inputJson) as Record<string, unknown>,
      status: row.status,
      approvedAt: row.approvedAt ?? undefined,
      executedTradeId: row.executedTradeId ?? undefined,
    };
  }

  private toAgentPeer(row: AgentPeerRow): AgentPeer {
    const primaryKey = `peerId=${row.peerId}`;
    return this.parseAgentCommEntity(agentPeerSchema, "agent peer", primaryKey, {
      peerId: row.peerId,
      name: row.name ?? undefined,
      walletAddress: row.walletAddress,
      pubkey: row.pubkey,
      status: row.status,
      capabilities: this.parseAgentCommJsonField(
        agentPeerCapabilitySchema.array(),
        "agent peer",
        "capabilitiesJson",
        primaryKey,
        row.capabilitiesJson,
      ),
      metadata: row.metadataJson
        ? this.parseAgentCommJsonField(
            jsonObjectSchema,
            "agent peer",
            "metadataJson",
            primaryKey,
            row.metadataJson,
          )
        : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toAgentMessage(row: AgentMessageRow): AgentMessage {
    const primaryKey = `id=${row.id}`;
    return this.parseAgentCommEntity(agentMessageSchema, "agent message", primaryKey, {
      id: row.id,
      direction: row.direction,
      peerId: row.peerId,
      txHash: row.txHash ?? undefined,
      nonce: row.nonce,
      commandType: row.commandType,
      envelopeVersion: row.envelopeVersion ?? undefined,
      msgId: row.msgId ?? undefined,
      contactId: row.contactId ?? undefined,
      identityWallet: row.identityWallet ?? undefined,
      transportAddress: row.transportAddress ?? undefined,
      trustOutcome: row.trustOutcome ?? undefined,
      payment: row.paymentJson
        ? this.parseAgentCommJsonField(
            encryptedEnvelopeV2PaymentSchema,
            "agent message",
            "paymentJson",
            primaryKey,
            row.paymentJson,
          )
        : undefined,
      decryptedCommandType: row.decryptedCommandType ?? undefined,
      ciphertext: row.ciphertext,
      status: row.status,
      error: row.error ?? undefined,
      sentAt: row.sentAt ?? undefined,
      receivedAt: row.receivedAt ?? undefined,
      executedAt: row.executedAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toListenerCursor(row: ListenerCursorRow): ListenerCursor {
    return {
      address: row.address,
      chainId: row.chainId,
      cursor: row.cursor,
      updatedAt: row.updatedAt,
    };
  }

  private toAgentLocalIdentity(row: AgentLocalIdentityRow): AgentLocalIdentity {
    const primaryKey = `role=${row.role}`;
    return this.parseAgentCommEntity(agentLocalIdentitySchema, "agent local identity", primaryKey, {
      role: row.role,
      walletAlias: row.walletAlias,
      walletAddress: row.walletAddress,
      identityWallet: row.identityWallet,
      chainId: row.chainId,
      mode: row.mode,
      activeBindingDigest: row.activeBindingDigest ?? undefined,
      transportKeyId: row.transportKeyId ?? undefined,
      metadata: row.metadataJson
        ? this.parseAgentCommJsonField(
            jsonObjectSchema,
            "agent local identity",
            "metadataJson",
            primaryKey,
            row.metadataJson,
          )
        : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toAgentSignedArtifact(row: AgentSignedArtifactRow): AgentSignedArtifact {
    const primaryKey = `digest=${row.digest}`;
    return this.parseAgentCommEntity(agentSignedArtifactSchema, "agent signed artifact", primaryKey, {
      id: row.id,
      artifactType: row.artifactType,
      digest: row.digest,
      signer: row.signer,
      identityWallet: row.identityWallet,
      chainId: row.chainId,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      payload: this.parseAgentCommJsonField(
        jsonObjectSchema,
        "agent signed artifact",
        "payloadJson",
        primaryKey,
        row.payloadJson,
      ),
      proof: this.parseAgentCommJsonField(
        jsonObjectSchema,
        "agent signed artifact",
        "proofJson",
        primaryKey,
        row.proofJson,
      ),
      verificationStatus: row.verificationStatus,
      verificationError: row.verificationError ?? undefined,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toAgentContact(row: AgentContactRow): AgentContact {
    const primaryKey = `contactId=${row.contactId}`;
    return this.parseAgentCommEntity(agentContactSchema, "agent contact", primaryKey, {
      contactId: row.contactId,
      identityWallet: row.identityWallet,
      legacyPeerId: row.legacyPeerId ?? undefined,
      displayName: row.displayName ?? undefined,
      handle: row.handle ?? undefined,
      status: row.status,
      supportedProtocols: this.parseAgentCommJsonField(
        z.array(z.string().min(1)),
        "agent contact",
        "supportedProtocolsJson",
        primaryKey,
        row.supportedProtocolsJson,
      ),
      capabilityProfile: row.capabilityProfile ?? undefined,
      capabilities: this.parseAgentCommJsonField(
        z.array(z.string().min(1)),
        "agent contact",
        "capabilitiesJson",
        primaryKey,
        row.capabilitiesJson,
      ),
      metadata: row.metadataJson
        ? this.parseAgentCommJsonField(
            jsonObjectSchema,
            "agent contact",
            "metadataJson",
            primaryKey,
            row.metadataJson,
          )
        : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toAgentTransportEndpoint(row: AgentTransportEndpointRow): AgentTransportEndpoint {
    const primaryKey = `id=${row.id}`;
    return this.parseAgentCommEntity(
      agentTransportEndpointSchema,
      "agent transport endpoint",
      primaryKey,
      {
        id: row.id,
        contactId: row.contactId,
        identityWallet: row.identityWallet,
        chainId: row.chainId,
        receiveAddress: row.receiveAddress,
        pubkey: row.pubkey,
        keyId: row.keyId,
        bindingDigest: row.bindingDigest ?? undefined,
        endpointStatus: row.endpointStatus,
        source: row.source,
        metadata: row.metadataJson
          ? this.parseAgentCommJsonField(
              jsonObjectSchema,
              "agent transport endpoint",
              "metadataJson",
              primaryKey,
              row.metadataJson,
            )
          : undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    );
  }

  private toAgentConnectionEvent(row: AgentConnectionEventRow): AgentConnectionEvent {
    const primaryKey = `id=${row.id}`;
    return this.parseAgentCommEntity(
      agentConnectionEventSchema,
      "agent connection event",
      primaryKey,
      {
        id: row.id,
        contactId: row.contactId,
        identityWallet: row.identityWallet,
        direction: row.direction,
        eventType: row.eventType,
        eventStatus: row.eventStatus,
        messageId: row.messageId ?? undefined,
        txHash: row.txHash ?? undefined,
        reason: row.reason ?? undefined,
        metadata: row.metadataJson
          ? this.parseAgentCommJsonField(
              jsonObjectSchema,
              "agent connection event",
              "metadataJson",
              primaryKey,
              row.metadataJson,
            )
          : undefined,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    );
  }

  private toAgentArtifactStatus(row: AgentArtifactStatusRow): AgentArtifactStatus {
    const primaryKey = `artifactDigest=${row.artifactDigest}`;
    return this.parseAgentCommEntity(agentArtifactStatusSchema, "agent artifact status", primaryKey, {
      artifactDigest: row.artifactDigest,
      artifactType: row.artifactType,
      identityWallet: row.identityWallet,
      status: row.status,
      revokedByDigest: row.revokedByDigest ?? undefined,
      revokedAt: row.revokedAt ?? undefined,
      reason: row.reason ?? undefined,
      metadata: row.metadataJson
        ? this.parseAgentCommJsonField(
            jsonObjectSchema,
            "agent artifact status",
            "metadataJson",
            primaryKey,
            row.metadataJson,
          )
        : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private parseAgentCommEntity<T>(
    schema: z.ZodType<T>,
    entity: string,
    primaryKey: string,
    value: unknown,
  ): T {
    try {
      return schema.parse(value);
    } catch (error) {
      throw this.wrapAgentCommRowError(entity, "row", primaryKey, error);
    }
  }

  private parseAgentCommJsonField<T>(
    schema: z.ZodType<T>,
    entity: string,
    field: string,
    primaryKey: string,
    raw: string,
  ): T {
    try {
      return schema.parse(JSON.parse(raw));
    } catch (error) {
      throw this.wrapAgentCommRowError(entity, field, primaryKey, error);
    }
  }

  private wrapAgentCommRowError(
    entity: string,
    field: string,
    primaryKey: string,
    error: unknown,
  ): Error {
    const context = formatAgentCommRowContext(entity, field, primaryKey);
    if (error instanceof z.ZodError) {
      return new Error(`${context}: ${error.issues.map((issue) => issue.message).join("; ")}`);
    }
    if (error instanceof Error) {
      return new Error(`${context}: ${error.message}`);
    }
    return new Error(`${context}: ${String(error)}`);
  }

  upsertStrategy(pluginId: string, config: unknown): string {
    const existing = this.alphaDb
      .prepare("SELECT id FROM strategies WHERE plugin_id = ?")
      .get(pluginId) as { id: string } | undefined;

    const now = new Date().toISOString();
    if (existing) {
      this.runPreparedStatement(
        this.alphaDb,
        "UPDATE strategies SET enabled = 1, config_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(config),
        now,
        existing.id,
      );
      return existing.id;
    }

    const id = crypto.randomUUID();
    this.runPreparedStatement(
      this.alphaDb,
      "INSERT INTO strategies (id, plugin_id, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      pluginId,
      1,
      JSON.stringify(config),
      now,
      now,
    );
    return id;
  }

  upsertStrategyProfile(strategyId: string, variant: "A" | "B", params: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO strategy_profiles (strategy_id, variant, params_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(strategy_id) DO UPDATE SET
         variant = excluded.variant,
         params_json = excluded.params_json,
         updated_at = excluded.updated_at`,
      strategyId,
      variant,
      JSON.stringify(params),
      now,
    );
  }

  getStrategyProfile(strategyId: string): StrategyProfile | null {
    const row = this.alphaDb
      .prepare(
        `SELECT strategy_id AS strategyId, variant, params_json AS paramsJson, updated_at AS updatedAt
         FROM strategy_profiles
         WHERE strategy_id = ?`,
      )
      .get(strategyId) as
      | {
          strategyId: string;
          variant: "A" | "B";
          paramsJson: string;
          updatedAt: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      strategyId: row.strategyId,
      variant: row.variant,
      params: JSON.parse(row.paramsJson) as Record<string, unknown>,
      updatedAt: row.updatedAt,
    };
  }

  listStrategyProfiles(): StrategyProfile[] {
    const rows = this.alphaDb
      .prepare(
        `SELECT strategy_id AS strategyId, variant, params_json AS paramsJson, updated_at AS updatedAt
         FROM strategy_profiles
         ORDER BY strategy_id`,
      )
      .all() as Array<{
      strategyId: string;
      variant: "A" | "B";
      paramsJson: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      strategyId: row.strategyId,
      variant: row.variant,
      params: JSON.parse(row.paramsJson) as Record<string, unknown>,
      updatedAt: row.updatedAt,
    }));
  }

  getTokenCache(symbol: string, chainIndex: string): TokenCacheEntry | null {
    const row = this.alphaDb
      .prepare(
        `SELECT symbol,
                chain_index AS chainIndex,
                token_address AS address,
                token_decimals AS decimals,
                expires_at AS expiresAt,
                updated_at AS updatedAt
         FROM token_cache
         WHERE symbol = ? AND chain_index = ?`,
      )
      .get(symbol.toUpperCase(), chainIndex) as TokenCacheEntry | undefined;
    if (!row) {
      return null;
    }
    return row;
  }

  upsertTokenCache(entry: {
    symbol: string;
    chainIndex: string;
    address: string;
    decimals: number;
    expiresAt: string;
  }): void {
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO token_cache (symbol, chain_index, token_address, token_decimals, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, chain_index) DO UPDATE SET
         token_address = excluded.token_address,
         token_decimals = excluded.token_decimals,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      entry.symbol.toUpperCase(),
      entry.chainIndex,
      entry.address,
      entry.decimals,
      entry.expiresAt,
      now,
    );
  }

  listTokenCache(limit = 200, symbol?: string, chainIndex?: string): TokenCacheEntry[] {
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    const symbolNorm = symbol?.trim().toUpperCase();
    const chain = chainIndex?.trim();

    if (symbolNorm && chain) {
      const row = this.getTokenCache(symbolNorm, chain);
      return row ? [row] : [];
    }

    if (symbolNorm) {
      return this.alphaDb
        .prepare(
          `SELECT symbol,
                  chain_index AS chainIndex,
                  token_address AS address,
                  token_decimals AS decimals,
                  expires_at AS expiresAt,
                  updated_at AS updatedAt
           FROM token_cache
           WHERE symbol = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(symbolNorm, safeLimit) as TokenCacheEntry[];
    }

    if (chain) {
      return this.alphaDb
        .prepare(
          `SELECT symbol,
                  chain_index AS chainIndex,
                  token_address AS address,
                  token_decimals AS decimals,
                  expires_at AS expiresAt,
                  updated_at AS updatedAt
           FROM token_cache
           WHERE chain_index = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(chain, safeLimit) as TokenCacheEntry[];
    }

    return this.alphaDb
      .prepare(
        `SELECT symbol,
                chain_index AS chainIndex,
                token_address AS address,
                token_decimals AS decimals,
                expires_at AS expiresAt,
                updated_at AS updatedAt
         FROM token_cache
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(safeLimit) as TokenCacheEntry[];
  }

  upsertAgentPeer(input: {
    peerId: string;
    walletAddress: string;
    pubkey: string;
    name?: string;
    status?: AgentPeerStatus;
    capabilities?: AgentPeerCapability[];
    metadata?: Record<string, unknown>;
  }): AgentPeer {
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_peers (
        peer_id, name, wallet_address, pubkey, status, capabilities_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        name = excluded.name,
        wallet_address = excluded.wallet_address,
        pubkey = excluded.pubkey,
        status = excluded.status,
        capabilities_json = excluded.capabilities_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      input.peerId,
      input.name ?? null,
      input.walletAddress,
      input.pubkey,
      input.status ?? "pending",
      JSON.stringify(input.capabilities ?? []),
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    );

    return this.getRequiredAgentPeer(
      input.peerId,
      `agent peer not found after upsert: ${input.peerId}`,
    );
  }

  getAgentPeer(peerId: string): AgentPeer | null {
    return this.getSingleAgentPeer("WHERE peer_id = ?", peerId);
  }

  getAgentPeerByWalletAddress(walletAddress: string): AgentPeer | null {
    return this.getSingleAgentPeer("WHERE wallet_address = ?", walletAddress);
  }

  private getSingleAgentPeer(whereClause: string, ...params: unknown[]): AgentPeer | null {
    const row = this.alphaDb
      .prepare(`${agentPeerSelectSql} ${whereClause} LIMIT 1`)
      .get(...params) as AgentPeerRow | undefined;
    return row ? this.toAgentPeer(row) : null;
  }

  private getRequiredAgentPeer(peerId: string, errorMessage: string): AgentPeer {
    const peer = this.getAgentPeer(peerId);
    if (!peer) {
      throw new Error(errorMessage);
    }
    return peer;
  }

  listAgentPeers(limit = 100, status?: AgentPeerStatus): AgentPeer[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const query = status
      ? `${agentPeerSelectSql} WHERE status = ? ORDER BY updated_at DESC LIMIT ?`
      : `${agentPeerSelectSql} ORDER BY updated_at DESC LIMIT ?`;
    const rows = (status
      ? this.alphaDb.prepare(query).all(status, safeLimit)
      : this.alphaDb.prepare(query).all(safeLimit)) as AgentPeerRow[];
    return rows.map((row) => this.toAgentPeer(row));
  }

  insertAgentMessage(input: {
    id?: string;
    direction: AgentMessageDirection;
    peerId: string;
    txHash?: string;
    nonce: string;
    commandType: AgentCommandType;
    envelopeVersion?: number;
    msgId?: string;
    contactId?: string;
    identityWallet?: string;
    transportAddress?: string;
    trustOutcome?: string;
    payment?: EncryptedEnvelopeV2Payment;
    decryptedCommandType?: AgentCommandType;
    ciphertext: string;
    status?: AgentMessageStatus;
    sentAt?: string;
    receivedAt?: string;
    executedAt?: string;
    error?: string;
  }): AgentMessage {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_messages (
        id, direction, peer_id, tx_hash, nonce, command_type, envelope_version, msg_id,
        contact_id, identity_wallet, transport_address, trust_outcome, payment_json,
        decrypted_command_type, ciphertext, status, sent_at, received_at, executed_at, error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.direction,
      input.peerId,
      input.txHash ?? null,
      input.nonce,
      input.commandType,
      input.envelopeVersion ?? null,
      input.msgId ?? null,
      input.contactId ?? null,
      input.identityWallet ?? null,
      input.transportAddress ?? null,
      input.trustOutcome ?? null,
      input.payment ? JSON.stringify(input.payment) : null,
      input.decryptedCommandType ?? null,
      input.ciphertext,
      input.status ?? "pending",
      input.sentAt ?? null,
      input.receivedAt ?? null,
      input.executedAt ?? null,
      input.error ?? null,
      now,
      now,
    );

    return this.getRequiredAgentMessage(id, `agent message not found after insert: ${id}`);
  }

  getAgentMessage(id: string): AgentMessage | null {
    return this.getSingleAgentMessage("WHERE id = ?", id);
  }

  findAgentMessage(
    peerId: string,
    direction: AgentMessageDirection,
    nonce: string,
  ): AgentMessage | null {
    return this.getSingleAgentMessage(
      "WHERE peer_id = ? AND direction = ? AND nonce = ?",
      peerId,
      direction,
      nonce,
    );
  }

  findAgentMessageByMsgId(
    direction: AgentMessageDirection,
    msgId: string,
  ): AgentMessage | null {
    return this.getSingleAgentMessage("WHERE direction = ? AND msg_id = ?", direction, msgId);
  }

  private getSingleAgentMessage(whereClause: string, ...params: unknown[]): AgentMessage | null {
    const row = this.alphaDb
      .prepare(`${agentMessageSelectSql} ${whereClause} LIMIT 1`)
      .get(...params) as AgentMessageRow | undefined;
    return row ? this.toAgentMessage(row) : null;
  }

  private getRequiredAgentMessage(id: string, errorMessage: string): AgentMessage {
    const message = this.getAgentMessage(id);
    if (!message) {
      throw new Error(errorMessage);
    }
    return message;
  }

  listAgentMessages(
    limit = 50,
    filters?: {
      peerId?: string;
      contactId?: string;
      identityWallet?: string;
      direction?: AgentMessageDirection;
      status?: AgentMessageStatus;
    },
  ): AgentMessage[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.peerId) {
      clauses.push("peer_id = ?");
      params.push(filters.peerId);
    }
    if (filters?.contactId) {
      clauses.push("contact_id = ?");
      params.push(filters.contactId);
    }
    if (filters?.identityWallet) {
      clauses.push("identity_wallet = ?");
      params.push(filters.identityWallet);
    }
    if (filters?.direction) {
      clauses.push("direction = ?");
      params.push(filters.direction);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.alphaDb
      .prepare(`${agentMessageSelectSql} ${whereClause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, safeLimit) as AgentMessageRow[];
    return rows.map((row) => this.toAgentMessage(row));
  }

  countAgentMessagesByStatus(status: AgentMessageStatus): number {
    const row = this.alphaDb
      .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE status = ?")
      .get(status) as { count: number | null } | undefined;
    return row?.count ?? 0;
  }

  updateAgentMessageStatus(
    id: string,
    status: AgentMessageStatus,
    patch?: {
      txHash?: string;
      envelopeVersion?: number;
      msgId?: string;
      contactId?: string;
      identityWallet?: string;
      transportAddress?: string;
      trustOutcome?: string;
      payment?: EncryptedEnvelopeV2Payment;
      decryptedCommandType?: AgentCommandType;
      sentAt?: string;
      receivedAt?: string;
      executedAt?: string;
      error?: string;
    },
  ): AgentMessage {
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `UPDATE agent_messages
       SET status = ?,
           tx_hash = COALESCE(?, tx_hash),
           envelope_version = COALESCE(?, envelope_version),
           msg_id = COALESCE(?, msg_id),
           contact_id = COALESCE(?, contact_id),
           identity_wallet = COALESCE(?, identity_wallet),
           transport_address = COALESCE(?, transport_address),
           trust_outcome = COALESCE(?, trust_outcome),
           payment_json = COALESCE(?, payment_json),
           decrypted_command_type = COALESCE(?, decrypted_command_type),
           sent_at = COALESCE(?, sent_at),
           received_at = COALESCE(?, received_at),
           executed_at = COALESCE(?, executed_at),
           error = COALESCE(?, error),
           updated_at = ?
       WHERE id = ?`,
      status,
      patch?.txHash ?? null,
      patch?.envelopeVersion ?? null,
      patch?.msgId ?? null,
      patch?.contactId ?? null,
      patch?.identityWallet ?? null,
      patch?.transportAddress ?? null,
      patch?.trustOutcome ?? null,
      patch?.payment ? JSON.stringify(patch.payment) : null,
      patch?.decryptedCommandType ?? null,
      patch?.sentAt ?? null,
      patch?.receivedAt ?? null,
      patch?.executedAt ?? null,
      patch?.error ?? null,
      now,
      id,
    );

    return this.getRequiredAgentMessage(id, `agent message not found: ${id}`);
  }

  upsertListenerCursor(input: {
    address: string;
    chainId: string | number;
    cursor: string;
  }): ListenerCursor {
    const normalizedChainId = String(input.chainId);
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO listener_cursors (address, chain_id, cursor, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(address, chain_id) DO UPDATE SET
         cursor = excluded.cursor,
         updated_at = excluded.updated_at`,
      input.address,
      normalizedChainId,
      input.cursor,
      now,
    );

    return this.getRequiredListenerCursor(
      input.address,
      normalizedChainId,
      `listener cursor not found after upsert: ${input.address}:${normalizedChainId}`,
    );
  }

  getListenerCursor(address: string, chainId: string | number): ListenerCursor | null {
    const row = this.alphaDb
      .prepare(`${listenerCursorSelectSql} WHERE address = ? AND chain_id = ?`)
      .get(address, String(chainId)) as ListenerCursorRow | undefined;
    return row ? this.toListenerCursor(row) : null;
  }

  private getRequiredListenerCursor(
    address: string,
    chainId: string,
    errorMessage: string,
  ): ListenerCursor {
    const cursor = this.getListenerCursor(address, chainId);
    if (!cursor) {
      throw new Error(errorMessage);
    }
    return cursor;
  }

  upsertAgentLocalIdentity(input: {
    role: AgentLocalIdentityRole;
    walletAlias: string;
    walletAddress: string;
    identityWallet: string;
    chainId: number;
    mode: AgentLocalIdentityMode;
    activeBindingDigest?: string;
    transportKeyId?: string;
    metadata?: Record<string, unknown>;
  }): AgentLocalIdentity {
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_local_identities (
        role, wallet_alias, wallet_address, identity_wallet, chain_id, mode,
        active_binding_digest, transport_key_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        wallet_alias = excluded.wallet_alias,
        wallet_address = excluded.wallet_address,
        identity_wallet = excluded.identity_wallet,
        chain_id = excluded.chain_id,
        mode = excluded.mode,
        active_binding_digest = excluded.active_binding_digest,
        transport_key_id = excluded.transport_key_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      input.role,
      input.walletAlias,
      input.walletAddress,
      input.identityWallet,
      input.chainId,
      input.mode,
      input.activeBindingDigest ?? null,
      input.transportKeyId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    );

    return this.getRequiredAgentLocalIdentity(
      input.role,
      `agent local identity not found after upsert: ${input.role}`,
    );
  }

  getAgentLocalIdentity(role: AgentLocalIdentityRole): AgentLocalIdentity | null {
    const row = this.alphaDb
      .prepare(`${agentLocalIdentitySelectSql} WHERE role = ? LIMIT 1`)
      .get(role) as AgentLocalIdentityRow | undefined;
    return row ? this.toAgentLocalIdentity(row) : null;
  }

  private getRequiredAgentLocalIdentity(
    role: AgentLocalIdentityRole,
    errorMessage: string,
  ): AgentLocalIdentity {
    const identity = this.getAgentLocalIdentity(role);
    if (!identity) {
      throw new Error(errorMessage);
    }
    return identity;
  }

  listAgentLocalIdentities(limit = 10): AgentLocalIdentity[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const rows = this.alphaDb
      .prepare(`${agentLocalIdentitySelectSql} ORDER BY updated_at DESC LIMIT ?`)
      .all(safeLimit) as AgentLocalIdentityRow[];
    return rows.map((row) => this.toAgentLocalIdentity(row));
  }

  upsertAgentSignedArtifact(input: {
    id?: string;
    artifactType: AgentSignedArtifactType;
    digest: string;
    signer: string;
    identityWallet: string;
    chainId: number;
    issuedAt: number;
    expiresAt: number;
    payload: Record<string, unknown>;
    proof: Record<string, unknown>;
    verificationStatus: AgentSignedArtifactVerificationStatus;
    verificationError?: string;
    source: string;
  }): AgentSignedArtifact {
    const now = new Date().toISOString();
    const existing = this.alphaDb
      .prepare("SELECT id FROM agent_signed_artifacts WHERE digest = ?")
      .get(input.digest) as { id: string } | undefined;
    const id = existing?.id ?? input.id ?? crypto.randomUUID();

    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_signed_artifacts (
        id, artifact_type, digest, signer, identity_wallet, chain_id, issued_at, expires_at,
        payload_json, proof_json, verification_status, verification_error, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(digest) DO UPDATE SET
        artifact_type = excluded.artifact_type,
        signer = excluded.signer,
        identity_wallet = excluded.identity_wallet,
        chain_id = excluded.chain_id,
        issued_at = excluded.issued_at,
        expires_at = excluded.expires_at,
        payload_json = excluded.payload_json,
        proof_json = excluded.proof_json,
        verification_status = excluded.verification_status,
        verification_error = excluded.verification_error,
        source = excluded.source,
        updated_at = excluded.updated_at`,
      id,
      input.artifactType,
      input.digest,
      input.signer,
      input.identityWallet,
      input.chainId,
      input.issuedAt,
      input.expiresAt,
      JSON.stringify(input.payload),
      JSON.stringify(input.proof),
      input.verificationStatus,
      input.verificationError ?? null,
      input.source,
      now,
      now,
    );

    return this.getRequiredAgentSignedArtifact(
      input.digest,
      `agent signed artifact not found after upsert: ${input.digest}`,
    );
  }

  getAgentSignedArtifact(digest: string): AgentSignedArtifact | null {
    const row = this.alphaDb
      .prepare(`${agentSignedArtifactSelectSql} WHERE digest = ? LIMIT 1`)
      .get(digest) as AgentSignedArtifactRow | undefined;
    return row ? this.toAgentSignedArtifact(row) : null;
  }

  private getRequiredAgentSignedArtifact(digest: string, errorMessage: string): AgentSignedArtifact {
    const artifact = this.getAgentSignedArtifact(digest);
    if (!artifact) {
      throw new Error(errorMessage);
    }
    return artifact;
  }

  listAgentSignedArtifacts(
    limit = 100,
    filters?: {
      artifactType?: AgentSignedArtifactType;
      identityWallet?: string;
      signer?: string;
    },
  ): AgentSignedArtifact[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.artifactType) {
      clauses.push("artifact_type = ?");
      params.push(filters.artifactType);
    }
    if (filters?.identityWallet) {
      clauses.push("identity_wallet = ?");
      params.push(filters.identityWallet);
    }
    if (filters?.signer) {
      clauses.push("signer = ?");
      params.push(filters.signer);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.alphaDb
      .prepare(`${agentSignedArtifactSelectSql} ${whereClause} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, safeLimit) as AgentSignedArtifactRow[];
    return rows.map((row) => this.toAgentSignedArtifact(row));
  }

  upsertAgentContact(input: {
    contactId?: string;
    identityWallet: string;
    legacyPeerId?: string;
    displayName?: string;
    handle?: string;
    status?: AgentContactStatus;
    supportedProtocols?: string[];
    capabilityProfile?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  }): AgentContact {
    const existingByContactId = input.contactId ? this.getAgentContact(input.contactId) : null;
    const existingByIdentityWallet = this.getAgentContactByIdentityWallet(input.identityWallet);
    const existingByLegacyPeerId = input.legacyPeerId
      ? this.getAgentContactByLegacyPeerId(input.legacyPeerId)
      : null;

    const existingCandidates = [existingByContactId, existingByIdentityWallet, existingByLegacyPeerId].filter(
      (value): value is AgentContact => Boolean(value),
    );
    const distinctContactIds = [...new Set(existingCandidates.map((value) => value.contactId))];
    if (distinctContactIds.length > 1) {
      throw new Error(
        `conflicting agent contacts for identityWallet=${input.identityWallet} legacyPeerId=${
          input.legacyPeerId ?? "(none)"
        }`,
      );
    }

    const existing = existingCandidates[0];
    const contactId = existing?.contactId ?? input.contactId ?? `ct_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const metadata = input.metadata ?? existing?.metadata;

    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_contacts (
        contact_id, identity_wallet, legacy_peer_id, display_name, handle, status,
        supported_protocols_json, capability_profile, capabilities_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        identity_wallet = excluded.identity_wallet,
        legacy_peer_id = excluded.legacy_peer_id,
        display_name = excluded.display_name,
        handle = excluded.handle,
        status = excluded.status,
        supported_protocols_json = excluded.supported_protocols_json,
        capability_profile = excluded.capability_profile,
        capabilities_json = excluded.capabilities_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      contactId,
      input.identityWallet,
      input.legacyPeerId ?? existing?.legacyPeerId ?? null,
      input.displayName ?? existing?.displayName ?? null,
      input.handle ?? existing?.handle ?? null,
      input.status ?? existing?.status ?? "imported",
      JSON.stringify(
        dedupeStrings(input.supportedProtocols ?? existing?.supportedProtocols ?? []),
      ),
      input.capabilityProfile ?? existing?.capabilityProfile ?? null,
      JSON.stringify(dedupeStrings(input.capabilities ?? existing?.capabilities ?? [])),
      metadata ? JSON.stringify(metadata) : null,
      existing?.createdAt ?? now,
      now,
    );

    return this.getRequiredAgentContact(contactId, `agent contact not found after upsert: ${contactId}`);
  }

  getAgentContact(contactId: string): AgentContact | null {
    return this.getSingleAgentContact("WHERE contact_id = ?", contactId);
  }

  getAgentContactByIdentityWallet(identityWallet: string): AgentContact | null {
    return this.getSingleAgentContact("WHERE identity_wallet = ?", identityWallet);
  }

  getAgentContactByLegacyPeerId(legacyPeerId: string): AgentContact | null {
    return this.getSingleAgentContact("WHERE legacy_peer_id = ?", legacyPeerId);
  }

  getAgentContactByActiveReceiveAddress(receiveAddress: string): AgentContact | null {
    const row = this.alphaDb
      .prepare(
        `SELECT c.contact_id AS contactId,
                c.identity_wallet AS identityWallet,
                c.legacy_peer_id AS legacyPeerId,
                c.display_name AS displayName,
                c.handle,
                c.status,
                c.supported_protocols_json AS supportedProtocolsJson,
                c.capability_profile AS capabilityProfile,
                c.capabilities_json AS capabilitiesJson,
                c.metadata_json AS metadataJson,
                c.created_at AS createdAt,
                c.updated_at AS updatedAt
         FROM agent_contacts c
         INNER JOIN agent_transport_endpoints e
           ON e.contact_id = c.contact_id
         WHERE e.receive_address = ?
           AND e.endpoint_status = 'active'
         ORDER BY e.updated_at DESC
         LIMIT 1`,
      )
      .get(receiveAddress) as AgentContactRow | undefined;
    return row ? this.toAgentContact(row) : null;
  }

  private getSingleAgentContact(whereClause: string, ...params: unknown[]): AgentContact | null {
    const row = this.alphaDb
      .prepare(`${agentContactSelectSql} ${whereClause} LIMIT 1`)
      .get(...params) as AgentContactRow | undefined;
    return row ? this.toAgentContact(row) : null;
  }

  private getRequiredAgentContact(contactId: string, errorMessage: string): AgentContact {
    const contact = this.getAgentContact(contactId);
    if (!contact) {
      throw new Error(errorMessage);
    }
    return contact;
  }

  listAgentContacts(
    limit = 100,
    filters?: {
      status?: AgentContactStatus;
      identityWallet?: string;
      legacyPeerId?: string;
    },
  ): AgentContact[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.identityWallet) {
      clauses.push("identity_wallet = ?");
      params.push(filters.identityWallet);
    }
    if (filters?.legacyPeerId) {
      clauses.push("legacy_peer_id = ?");
      params.push(filters.legacyPeerId);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.alphaDb
      .prepare(`${agentContactSelectSql} ${whereClause} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, safeLimit) as AgentContactRow[];
    return rows.map((row) => this.toAgentContact(row));
  }

  upsertAgentTransportEndpoint(input: {
    id?: string;
    contactId: string;
    identityWallet: string;
    chainId: number;
    receiveAddress: string;
    pubkey: string;
    keyId: string;
    bindingDigest?: string;
    endpointStatus?: AgentTransportEndpointStatus;
    source: string;
    metadata?: Record<string, unknown>;
  }): AgentTransportEndpoint {
    const contact = this.getRequiredAgentContact(
      input.contactId,
      `agent contact not found for endpoint upsert: ${input.contactId}`,
    );
    if (contact.identityWallet !== input.identityWallet) {
      throw new Error(
        `agent endpoint identityWallet mismatch for contact ${input.contactId}: expected ${contact.identityWallet}, got ${input.identityWallet}`,
      );
    }

    const existing = this.getAgentTransportEndpointByContactAddressKey(
      input.contactId,
      input.receiveAddress,
      input.keyId,
    );
    const id = existing?.id ?? input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = input.metadata ?? existing?.metadata;

    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_transport_endpoints (
        id, contact_id, identity_wallet, chain_id, receive_address, pubkey, key_id,
        binding_digest, endpoint_status, source, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, receive_address, key_id) DO UPDATE SET
        identity_wallet = excluded.identity_wallet,
        chain_id = excluded.chain_id,
        pubkey = excluded.pubkey,
        binding_digest = excluded.binding_digest,
        endpoint_status = excluded.endpoint_status,
        source = excluded.source,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      id,
      input.contactId,
      input.identityWallet,
      normalizeChainId(input.chainId),
      input.receiveAddress,
      input.pubkey,
      input.keyId,
      input.bindingDigest ?? null,
      input.endpointStatus ?? "active",
      input.source,
      metadata ? JSON.stringify(metadata) : null,
      existing?.createdAt ?? now,
      now,
    );

    return this.getRequiredAgentTransportEndpoint(
      id,
      `agent transport endpoint not found after upsert: ${id}`,
    );
  }

  getAgentTransportEndpoint(id: string): AgentTransportEndpoint | null {
    return this.getSingleAgentTransportEndpoint("WHERE id = ?", id);
  }

  private getAgentTransportEndpointByContactAddressKey(
    contactId: string,
    receiveAddress: string,
    keyId: string,
  ): AgentTransportEndpoint | null {
    return this.getSingleAgentTransportEndpoint(
      "WHERE contact_id = ? AND receive_address = ? AND key_id = ?",
      contactId,
      receiveAddress,
      keyId,
    );
  }

  private getSingleAgentTransportEndpoint(
    whereClause: string,
    ...params: unknown[]
  ): AgentTransportEndpoint | null {
    const row = this.alphaDb
      .prepare(`${agentTransportEndpointSelectSql} ${whereClause} LIMIT 1`)
      .get(...params) as AgentTransportEndpointRow | undefined;
    return row ? this.toAgentTransportEndpoint(row) : null;
  }

  private getRequiredAgentTransportEndpoint(
    id: string,
    errorMessage: string,
  ): AgentTransportEndpoint {
    const endpoint = this.getAgentTransportEndpoint(id);
    if (!endpoint) {
      throw new Error(errorMessage);
    }
    return endpoint;
  }

  listAgentTransportEndpoints(
    limit = 100,
    filters?: {
      contactId?: string;
      identityWallet?: string;
      receiveAddress?: string;
      endpointStatus?: AgentTransportEndpointStatus;
    },
  ): AgentTransportEndpoint[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.contactId) {
      clauses.push("contact_id = ?");
      params.push(filters.contactId);
    }
    if (filters?.identityWallet) {
      clauses.push("identity_wallet = ?");
      params.push(filters.identityWallet);
    }
    if (filters?.receiveAddress) {
      clauses.push("receive_address = ?");
      params.push(filters.receiveAddress);
    }
    if (filters?.endpointStatus) {
      clauses.push("endpoint_status = ?");
      params.push(filters.endpointStatus);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.alphaDb
      .prepare(`${agentTransportEndpointSelectSql} ${whereClause} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, safeLimit) as AgentTransportEndpointRow[];
    return rows.map((row) => this.toAgentTransportEndpoint(row));
  }

  listAgentTransportEndpointsByBindingDigest(bindingDigest: string): AgentTransportEndpoint[] {
    const rows = this.alphaDb
      .prepare(
        `${agentTransportEndpointSelectSql}
         WHERE binding_digest = ?
         ORDER BY updated_at DESC`,
      )
      .all(bindingDigest) as AgentTransportEndpointRow[];
    return rows.map((row) => this.toAgentTransportEndpoint(row));
  }

  upsertAgentConnectionEvent(input: {
    id?: string;
    contactId: string;
    identityWallet: string;
    direction: AgentMessageDirection;
    eventType: AgentConnectionEventType;
    eventStatus?: AgentConnectionEventStatus;
    messageId?: string;
    txHash?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
  }): AgentConnectionEvent {
    const contact = this.getRequiredAgentContact(
      input.contactId,
      `agent contact not found for connection event upsert: ${input.contactId}`,
    );
    if (contact.identityWallet !== input.identityWallet) {
      throw new Error(
        `agent connection event identityWallet mismatch for contact ${input.contactId}: expected ${contact.identityWallet}, got ${input.identityWallet}`,
      );
    }

    const existing = input.messageId
      ? this.getSingleAgentConnectionEvent(
          "WHERE contact_id = ? AND direction = ? AND event_type = ? AND message_id = ?",
          input.contactId,
          input.direction,
          input.eventType,
          input.messageId,
        )
      : null;
    const id = existing?.id ?? input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = input.metadata ?? existing?.metadata;

    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_connection_events (
        id, contact_id, identity_wallet, direction, event_type, event_status, message_id, tx_hash,
        reason, metadata_json, occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, direction, event_type, message_id) DO UPDATE SET
        identity_wallet = excluded.identity_wallet,
        event_status = excluded.event_status,
        tx_hash = excluded.tx_hash,
        reason = excluded.reason,
        metadata_json = excluded.metadata_json,
        occurred_at = excluded.occurred_at,
        updated_at = excluded.updated_at`,
      id,
      input.contactId,
      input.identityWallet,
      input.direction,
      input.eventType,
      input.eventStatus ?? "pending",
      input.messageId ?? null,
      input.txHash ?? null,
      input.reason ?? null,
      metadata ? JSON.stringify(metadata) : null,
      input.occurredAt ?? now,
      existing?.createdAt ?? now,
      now,
    );

    return this.getRequiredAgentConnectionEvent(
      id,
      `agent connection event not found after upsert: ${id}`,
    );
  }

  getAgentConnectionEvent(id: string): AgentConnectionEvent | null {
    return this.getSingleAgentConnectionEvent("WHERE id = ?", id);
  }

  private getSingleAgentConnectionEvent(
    whereClause: string,
    ...params: unknown[]
  ): AgentConnectionEvent | null {
    const row = this.alphaDb
      .prepare(`${agentConnectionEventSelectSql} ${whereClause} LIMIT 1`)
      .get(...params) as AgentConnectionEventRow | undefined;
    return row ? this.toAgentConnectionEvent(row) : null;
  }

  private getRequiredAgentConnectionEvent(
    id: string,
    errorMessage: string,
  ): AgentConnectionEvent {
    const event = this.getAgentConnectionEvent(id);
    if (!event) {
      throw new Error(errorMessage);
    }
    return event;
  }

  listAgentConnectionEvents(
    limit = 100,
    filters?: {
      contactId?: string;
      identityWallet?: string;
      direction?: AgentMessageDirection;
      eventType?: AgentConnectionEventType;
      eventStatus?: AgentConnectionEventStatus;
    },
  ): AgentConnectionEvent[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.contactId) {
      clauses.push("contact_id = ?");
      params.push(filters.contactId);
    }
    if (filters?.identityWallet) {
      clauses.push("identity_wallet = ?");
      params.push(filters.identityWallet);
    }
    if (filters?.direction) {
      clauses.push("direction = ?");
      params.push(filters.direction);
    }
    if (filters?.eventType) {
      clauses.push("event_type = ?");
      params.push(filters.eventType);
    }
    if (filters?.eventStatus) {
      clauses.push("event_status = ?");
      params.push(filters.eventStatus);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.alphaDb
      .prepare(`${agentConnectionEventSelectSql} ${whereClause} ORDER BY occurred_at DESC LIMIT ?`)
      .all(...params, safeLimit) as AgentConnectionEventRow[];
    return rows.map((row) => this.toAgentConnectionEvent(row));
  }

  upsertAgentArtifactStatus(input: {
    artifactDigest: string;
    artifactType: AgentSignedArtifactType;
    identityWallet: string;
    status: AgentArtifactRevocationStatus;
    revokedByDigest?: string;
    revokedAt?: number;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): AgentArtifactStatus {
    const now = new Date().toISOString();
    const existing = this.getAgentArtifactStatus(input.artifactDigest);
    const metadata = input.metadata ?? existing?.metadata;

    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO agent_artifact_status (
        artifact_digest, artifact_type, identity_wallet, status, revoked_by_digest, revoked_at,
        reason, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_digest) DO UPDATE SET
        artifact_type = excluded.artifact_type,
        identity_wallet = excluded.identity_wallet,
        status = excluded.status,
        revoked_by_digest = excluded.revoked_by_digest,
        revoked_at = excluded.revoked_at,
        reason = excluded.reason,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      input.artifactDigest,
      input.artifactType,
      input.identityWallet,
      input.status,
      input.revokedByDigest ?? null,
      input.revokedAt ?? null,
      input.reason ?? null,
      metadata ? JSON.stringify(metadata) : null,
      existing?.createdAt ?? now,
      now,
    );

    return this.getRequiredAgentArtifactStatus(
      input.artifactDigest,
      `agent artifact status not found after upsert: ${input.artifactDigest}`,
    );
  }

  getAgentArtifactStatus(artifactDigest: string): AgentArtifactStatus | null {
    const row = this.alphaDb
      .prepare(`${agentArtifactStatusSelectSql} WHERE artifact_digest = ? LIMIT 1`)
      .get(artifactDigest) as AgentArtifactStatusRow | undefined;
    return row ? this.toAgentArtifactStatus(row) : null;
  }

  private getRequiredAgentArtifactStatus(
    artifactDigest: string,
    errorMessage: string,
  ): AgentArtifactStatus {
    const status = this.getAgentArtifactStatus(artifactDigest);
    if (!status) {
      throw new Error(errorMessage);
    }
    return status;
  }

  listAgentArtifactStatuses(
    limit = 100,
    filters?: {
      identityWallet?: string;
      status?: AgentArtifactRevocationStatus;
      artifactType?: AgentSignedArtifactType;
    },
  ): AgentArtifactStatus[] {
    const safeLimit = normalizeAgentCommLimit(limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.identityWallet) {
      clauses.push("identity_wallet = ?");
      params.push(filters.identityWallet);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.artifactType) {
      clauses.push("artifact_type = ?");
      params.push(filters.artifactType);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.alphaDb
      .prepare(`${agentArtifactStatusSelectSql} ${whereClause} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, safeLimit) as AgentArtifactStatusRow[];
    return rows.map((row) => this.toAgentArtifactStatus(row));
  }

  backfillAgentContactFromLegacyPeer(
    peerId: string,
    options: { chainId?: number } = {},
  ): AgentLegacyPeerBackfillResult {
    const peer = this.getRequiredAgentPeer(peerId, `legacy agent peer not found: ${peerId}`);
    return this.backfillLegacyPeers([peer], options);
  }

  backfillAgentContactsFromLegacyPeers(
    options: { chainId?: number } = {},
  ): AgentLegacyPeerBackfillResult {
    const rows = this.alphaDb
      .prepare(`${agentPeerSelectSql} ORDER BY updated_at DESC`)
      .all() as AgentPeerRow[];
    const peers = rows.map((row) => this.toAgentPeer(row));
    return this.backfillLegacyPeers(peers, options);
  }

  private backfillLegacyPeers(
    peers: AgentPeer[],
    options: { chainId?: number },
  ): AgentLegacyPeerBackfillResult {
    const chainId = normalizeChainId(options.chainId);
    const result: AgentLegacyPeerBackfillResult = {
      processedPeers: 0,
      createdContacts: 0,
      updatedContacts: 0,
      createdTransportEndpoints: 0,
      updatedTransportEndpoints: 0,
    };

    for (const peer of peers) {
      const now = new Date().toISOString();
      const existingByLegacy = this.getAgentContactByLegacyPeerId(peer.peerId);
      const existingByIdentity = this.getAgentContactByIdentityWallet(peer.walletAddress);
      if (
        existingByLegacy &&
        existingByIdentity &&
        existingByLegacy.contactId !== existingByIdentity.contactId
      ) {
        throw new Error(
          `cannot backfill legacy peer ${peer.peerId}: identity wallet ${peer.walletAddress} maps to multiple contacts`,
        );
      }

      const existingContact = existingByLegacy ?? existingByIdentity;
      const contact = this.upsertAgentContact({
        contactId: existingContact?.contactId,
        identityWallet: peer.walletAddress,
        legacyPeerId: peer.peerId,
        displayName: existingContact?.displayName ?? peer.name,
        status: toLegacyBackfillContactStatus(peer.status),
        supportedProtocols: dedupeStrings([
          ...(existingContact?.supportedProtocols ?? []),
          "agent-comm/1",
        ]),
        capabilityProfile: existingContact?.capabilityProfile ?? "legacy-manual",
        capabilities: dedupeStrings([...(peer.capabilities ?? []), ...(existingContact?.capabilities ?? [])]),
        metadata: {
          ...(existingContact?.metadata ?? {}),
          legacyBackfill: {
            source: "agent_peers",
            peerId: peer.peerId,
            peerStatus: peer.status,
            syncedAt: now,
          },
          ...(peer.metadata ? { legacyPeerMetadata: peer.metadata } : {}),
        },
      });

      const keyId = `legacy-peer:${peer.peerId}`;
      const existingEndpoint = this.getAgentTransportEndpointByContactAddressKey(
        contact.contactId,
        peer.walletAddress,
        keyId,
      );
      this.upsertAgentTransportEndpoint({
        id: existingEndpoint?.id,
        contactId: contact.contactId,
        identityWallet: contact.identityWallet,
        chainId,
        receiveAddress: peer.walletAddress,
        pubkey: peer.pubkey,
        keyId,
        endpointStatus: toLegacyBackfillEndpointStatus(peer.status),
        source: "legacy_peer_backfill",
        metadata: {
          ...(existingEndpoint?.metadata ?? {}),
          legacyPeerId: peer.peerId,
          legacyPeerStatus: peer.status,
        },
      });

      result.processedPeers += 1;
      if (existingContact) {
        result.updatedContacts += 1;
      } else {
        result.createdContacts += 1;
      }
      if (existingEndpoint) {
        result.updatedTransportEndpoints += 1;
      } else {
        result.createdTransportEndpoints += 1;
      }
    }

    return result;
  }

  insertDiscoverySession(input: {
    strategyId: DiscoveryStrategyId;
    pairs: string[];
    startedAt: string;
    plannedEndAt: string;
    config: DiscoverySessionConfig;
  }): DiscoverySession {
    const id = crypto.randomUUID();
    const status: DiscoverySessionStatus = "active";
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO discovery_sessions (
        id, strategy_id, status, pairs_json, started_at, planned_end_at, ended_at, config_json, summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      id,
      input.strategyId,
      status,
      JSON.stringify(input.pairs),
      input.startedAt,
      input.plannedEndAt,
      JSON.stringify(input.config),
    );
    const session = this.getDiscoverySession(id);
    if (!session) {
      throw new Error("failed to read inserted discovery session");
    }
    return session;
  }

  getActiveDiscoverySession(): DiscoverySession | null {
    const row = this.alphaDb
      .prepare(
        `SELECT id,
                strategy_id AS strategyId,
                status,
                pairs_json AS pairsJson,
                started_at AS startedAt,
                planned_end_at AS plannedEndAt,
                ended_at AS endedAt,
                config_json AS configJson,
                summary_json AS summaryJson
         FROM discovery_sessions
         WHERE status = 'active'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get() as
      | {
          id: string;
          strategyId: DiscoveryStrategyId;
          status: DiscoverySessionStatus;
          pairsJson: string;
          startedAt: string;
          plannedEndAt: string;
          endedAt: string | null;
          configJson: string;
          summaryJson: string | null;
        }
      | undefined;
    return row ? this.toDiscoverySession(row) : null;
  }

  getDiscoverySession(id: string): DiscoverySession | null {
    const row = this.alphaDb
      .prepare(
        `SELECT id,
                strategy_id AS strategyId,
                status,
                pairs_json AS pairsJson,
                started_at AS startedAt,
                planned_end_at AS plannedEndAt,
                ended_at AS endedAt,
                config_json AS configJson,
                summary_json AS summaryJson
         FROM discovery_sessions
         WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          strategyId: DiscoveryStrategyId;
          status: DiscoverySessionStatus;
          pairsJson: string;
          startedAt: string;
          plannedEndAt: string;
          endedAt: string | null;
          configJson: string;
          summaryJson: string | null;
        }
      | undefined;
    return row ? this.toDiscoverySession(row) : null;
  }

  updateDiscoverySessionStatus(
    id: string,
    status: DiscoverySessionStatus,
    endedAt?: string,
  ): DiscoverySession {
    const finalEndedAt = endedAt ?? (status === "active" ? null : new Date().toISOString());
    this.runPreparedStatement(
      this.alphaDb,
      "UPDATE discovery_sessions SET status = ?, ended_at = ? WHERE id = ?",
      status,
      finalEndedAt,
      id,
    );
    const session = this.getDiscoverySession(id);
    if (!session) {
      throw new Error(`discovery session not found: ${id}`);
    }
    return session;
  }

  updateDiscoverySessionSummary(id: string, summary: DiscoverySessionSummary): void {
    this.runPreparedStatement(
      this.alphaDb,
      "UPDATE discovery_sessions SET summary_json = ? WHERE id = ?",
      JSON.stringify(summary),
      id,
    );
  }

  insertDiscoverySample(input: {
    sessionId: string;
    pair: string;
    ts: string;
    dexAMid: number;
    dexBMid: number;
    spreadBps: number;
    volatility: number | null;
    zScore: number | null;
    features: Record<string, unknown>;
  }): string {
    const id = crypto.randomUUID();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO discovery_samples (
        id, session_id, pair, ts, dex_a_mid, dex_b_mid, spread_bps, volatility, z_score, features_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.sessionId,
      input.pair,
      input.ts,
      input.dexAMid,
      input.dexBMid,
      input.spreadBps,
      input.volatility,
      input.zScore,
      JSON.stringify(input.features),
    );
    return id;
  }

  listDiscoverySamples(sessionId: string, limit = 2000): DiscoverySample[] {
    const safeLimit = Math.max(1, Math.min(20_000, Math.floor(limit)));
    const rows = this.alphaDb
      .prepare(
        `SELECT id,
                session_id AS sessionId,
                pair,
                ts,
                dex_a_mid AS dexAMid,
                dex_b_mid AS dexBMid,
                spread_bps AS spreadBps,
                volatility,
                z_score AS zScore,
                features_json AS featuresJson
         FROM discovery_samples
         WHERE session_id = ?
         ORDER BY ts ASC
         LIMIT ?`,
      )
      .all(sessionId, safeLimit) as Array<{
      id: string;
      sessionId: string;
      pair: string;
      ts: string;
      dexAMid: number;
      dexBMid: number;
      spreadBps: number;
      volatility: number | null;
      zScore: number | null;
      featuresJson: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      pair: row.pair,
      ts: row.ts,
      dexAMid: row.dexAMid,
      dexBMid: row.dexBMid,
      spreadBps: row.spreadBps,
      volatility: row.volatility,
      zScore: row.zScore,
      features: JSON.parse(row.featuresJson) as Record<string, unknown>,
    }));
  }

  listRecentDiscoverySamples(sessionId: string, pair: string, limit: number): DiscoverySample[] {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const rows = this.alphaDb
      .prepare(
        `SELECT id,
                session_id AS sessionId,
                pair,
                ts,
                dex_a_mid AS dexAMid,
                dex_b_mid AS dexBMid,
                spread_bps AS spreadBps,
                volatility,
                z_score AS zScore,
                features_json AS featuresJson
         FROM discovery_samples
         WHERE session_id = ? AND pair = ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(sessionId, pair, safeLimit) as Array<{
      id: string;
      sessionId: string;
      pair: string;
      ts: string;
      dexAMid: number;
      dexBMid: number;
      spreadBps: number;
      volatility: number | null;
      zScore: number | null;
      featuresJson: string;
    }>;
    return rows
      .reverse()
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        pair: row.pair,
        ts: row.ts,
        dexAMid: row.dexAMid,
        dexBMid: row.dexBMid,
        spreadBps: row.spreadBps,
        volatility: row.volatility,
        zScore: row.zScore,
        features: JSON.parse(row.featuresJson) as Record<string, unknown>,
      }));
  }

  getLatestDiscoverySampleTs(sessionId: string): string | null {
    const row = this.alphaDb
      .prepare(
        `SELECT ts
         FROM discovery_samples
         WHERE session_id = ?
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .get(sessionId) as { ts: string } | undefined;
    return row?.ts ?? null;
  }

  insertDiscoveryCandidate(input: Omit<DiscoveryCandidate, "id" | "status">): string {
    const id = crypto.randomUUID();
    const status: DiscoveryCandidateStatus = "pending";
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO discovery_candidates (
        id, session_id, strategy_id, pair, buy_dex, sell_dex, signal_ts, score, expected_net_bps,
        expected_net_usd, confidence, reason, input_json, status, approved_at, executed_trade_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      id,
      input.sessionId,
      input.strategyId,
      input.pair,
      input.buyDex,
      input.sellDex,
      input.signalTs,
      input.score,
      input.expectedNetBps,
      input.expectedNetUsd,
      input.confidence,
      input.reason,
      JSON.stringify(input.input),
      status,
    );
    return id;
  }

  listDiscoveryCandidates(sessionId: string, limit = 50): DiscoveryCandidate[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.alphaDb
      .prepare(
        `SELECT id,
                session_id AS sessionId,
                strategy_id AS strategyId,
                pair,
                buy_dex AS buyDex,
                sell_dex AS sellDex,
                signal_ts AS signalTs,
                score,
                expected_net_bps AS expectedNetBps,
                expected_net_usd AS expectedNetUsd,
                confidence,
                reason,
                input_json AS inputJson,
                status,
                approved_at AS approvedAt,
                executed_trade_id AS executedTradeId
         FROM discovery_candidates
         WHERE session_id = ?
         ORDER BY score DESC, signal_ts DESC
         LIMIT ?`,
      )
      .all(sessionId, safeLimit) as Array<{
      id: string;
      sessionId: string;
      strategyId: DiscoveryStrategyId;
      pair: string;
      buyDex: string;
      sellDex: string;
      signalTs: string;
      score: number;
      expectedNetBps: number;
      expectedNetUsd: number;
      confidence: number;
      reason: string;
      inputJson: string;
      status: DiscoveryCandidateStatus;
      approvedAt: string | null;
      executedTradeId: string | null;
    }>;
    return rows.map((row) => this.toDiscoveryCandidate(row));
  }

  getDiscoveryCandidate(sessionId: string, candidateId: string): DiscoveryCandidate | null {
    const row = this.alphaDb
      .prepare(
        `SELECT id,
                session_id AS sessionId,
                strategy_id AS strategyId,
                pair,
                buy_dex AS buyDex,
                sell_dex AS sellDex,
                signal_ts AS signalTs,
                score,
                expected_net_bps AS expectedNetBps,
                expected_net_usd AS expectedNetUsd,
                confidence,
                reason,
                input_json AS inputJson,
                status,
                approved_at AS approvedAt,
                executed_trade_id AS executedTradeId
         FROM discovery_candidates
         WHERE session_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(sessionId, candidateId) as
      | {
          id: string;
          sessionId: string;
          strategyId: DiscoveryStrategyId;
          pair: string;
          buyDex: string;
          sellDex: string;
          signalTs: string;
          score: number;
          expectedNetBps: number;
          expectedNetUsd: number;
          confidence: number;
          reason: string;
          inputJson: string;
          status: DiscoveryCandidateStatus;
          approvedAt: string | null;
          executedTradeId: string | null;
        }
      | undefined;
    return row ? this.toDiscoveryCandidate(row) : null;
  }

  updateDiscoveryCandidateStatus(
    candidateId: string,
    status: DiscoveryCandidateStatus,
    approvedAt?: string,
  ): void {
    this.runPreparedStatement(
      this.alphaDb,
      "UPDATE discovery_candidates SET status = ?, approved_at = COALESCE(?, approved_at) WHERE id = ?",
      status,
      approvedAt ?? null,
      candidateId,
    );
  }

  updateDiscoveryCandidateExecution(
    candidateId: string,
    status: "executed" | "failed",
    executedTradeId?: string,
  ): void {
    this.runPreparedStatement(
      this.alphaDb,
      "UPDATE discovery_candidates SET status = ?, executed_trade_id = ? WHERE id = ?",
      status,
      executedTradeId ?? null,
      candidateId,
    );
  }

  upsertDiscoveryReport(sessionId: string, report: DiscoveryReport, createdAt: string): void {
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO discovery_reports (session_id, report_json, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         report_json = excluded.report_json,
         created_at = excluded.created_at`,
      sessionId,
      JSON.stringify(report),
      createdAt,
    );
  }

  getDiscoveryReport(sessionId: string): DiscoveryReport | null {
    const row = this.alphaDb
      .prepare(
        `SELECT report_json AS reportJson
         FROM discovery_reports
         WHERE session_id = ?`,
      )
      .get(sessionId) as { reportJson: string } | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.reportJson) as DiscoveryReport;
  }

  listDiscoverySessions(limit = 20): DiscoverySession[] {
    const rows = this.alphaDb
      .prepare(
        `SELECT id,
                strategy_id AS strategyId,
                status,
                pairs_json AS pairsJson,
                started_at AS startedAt,
                planned_end_at AS plannedEndAt,
                ended_at AS endedAt,
                config_json AS configJson,
                summary_json AS summaryJson
         FROM discovery_sessions
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
        id: string;
        strategyId: DiscoveryStrategyId;
        status: DiscoverySessionStatus;
        pairsJson: string;
        startedAt: string;
        plannedEndAt: string;
        endedAt: string | null;
        configJson: string;
        summaryJson: string | null;
      }>;
    return rows.map((row) => this.toDiscoverySession(row));
  }

  getDiscoveryPipeline(sessionId: string): DiscoveryPipelineItem[] {
    const rows = this.alphaDb
      .prepare(
        `SELECT c.id, c.session_id AS sessionId, c.strategy_id AS strategyId,
                c.pair, c.buy_dex AS buyDex, c.sell_dex AS sellDex,
                c.signal_ts AS signalTs, c.score, c.expected_net_bps AS expectedNetBps,
                c.expected_net_usd AS expectedNetUsd, c.confidence, c.reason,
                c.input_json AS inputJson, c.status, c.approved_at AS approvedAt,
                c.executed_trade_id AS executedTradeId,
                t.tx_hash AS tradeTxHash, t.gross_usd AS tradeGrossUsd,
                t.fee_usd AS tradeFeeUsd, t.net_usd AS tradeNetUsd,
                t.status AS tradeStatus
         FROM discovery_candidates c
         LEFT JOIN trades t ON t.id = c.executed_trade_id
         WHERE c.session_id = ?
         ORDER BY c.score DESC`,
      )
      .all(sessionId) as Array<{
        id: string;
        sessionId: string;
        strategyId: DiscoveryStrategyId;
        pair: string;
        buyDex: string;
        sellDex: string;
        signalTs: string;
        score: number;
        expectedNetBps: number;
        expectedNetUsd: number;
        confidence: number;
        reason: string;
        inputJson: string;
        status: DiscoveryCandidateStatus;
        approvedAt: string | null;
        executedTradeId: string | null;
        tradeTxHash: string | null;
        tradeGrossUsd: number | null;
        tradeFeeUsd: number | null;
        tradeNetUsd: number | null;
        tradeStatus: string | null;
      }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      strategyId: row.strategyId,
      pair: row.pair,
      buyDex: row.buyDex,
      sellDex: row.sellDex,
      signalTs: row.signalTs,
      score: row.score,
      expectedNetBps: row.expectedNetBps,
      expectedNetUsd: row.expectedNetUsd,
      confidence: row.confidence,
      reason: row.reason,
      input: row.inputJson ? JSON.parse(row.inputJson) : {},
      status: row.status,
      ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
      ...(row.executedTradeId ? { executedTradeId: row.executedTradeId } : {}),
      ...(row.tradeTxHash ? { tradeTxHash: row.tradeTxHash } : {}),
      ...(row.tradeGrossUsd !== null ? { tradeGrossUsd: row.tradeGrossUsd } : {}),
      ...(row.tradeFeeUsd !== null ? { tradeFeeUsd: row.tradeFeeUsd } : {}),
      ...(row.tradeNetUsd !== null ? { tradeNetUsd: row.tradeNetUsd } : {}),
      ...(row.tradeStatus ? { tradeStatus: row.tradeStatus } : {}),
    }));
  }

  insertMarketSnapshot(input: { pair: string; dex: string; bid: number; ask: number; ts: string }): void {
    this.runPreparedStatement(
      this.alphaDb,
      "INSERT INTO market_snapshots (id, pair, dex, bid, ask, ts) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      input.pair,
      input.dex,
      input.bid,
      input.ask,
      input.ts,
    );
  }

  recordQuoteQuality(input: { stale: boolean; latencyMs: number | null; ts?: string }): void {
    const day = input.ts ? utcDay(new Date(input.ts)) : utcDay();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO quote_quality_daily (
        day, total_quotes, stale_quotes, latency_sum_ms, latency_samples
      )
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        total_quotes = quote_quality_daily.total_quotes + 1,
        stale_quotes = quote_quality_daily.stale_quotes + excluded.stale_quotes,
        latency_sum_ms = quote_quality_daily.latency_sum_ms + excluded.latency_sum_ms,
        latency_samples = quote_quality_daily.latency_samples + excluded.latency_samples`,
      day,
      input.stale ? 1 : 0,
      input.latencyMs ?? 0,
      input.latencyMs === null ? 0 : 1,
    );
  }

  insertOpportunity(input: Opportunity, estCostUsd: number, estNetUsd: number, status = "detected"): void {
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO opportunities (
        id, strategy_id, pair, buy_dex, sell_dex, gross_edge_bps, est_cost_usd, est_net_usd, status, detected_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.strategyId,
      input.pair,
      input.buyDex,
      input.sellDex,
      input.grossEdgeBps,
      estCostUsd,
      estNetUsd,
      status,
      input.detectedAt,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  }

  updateOpportunityStatus(id: string, status: string): void {
    this.runPreparedStatement(this.alphaDb, "UPDATE opportunities SET status = ? WHERE id = ?", status, id);
  }

  updateOpportunityEstimate(id: string, estCostUsd: number, estNetUsd: number, status: string): void {
    this.runPreparedStatement(
      this.alphaDb,
      "UPDATE opportunities SET est_cost_usd = ?, est_net_usd = ?, status = ? WHERE id = ?",
      estCostUsd,
      estNetUsd,
      status,
      id,
    );
  }

  insertSimulation(sim: SimulationRecord): void {
    this.runPreparedStatement(
      this.alphaDb,
      "INSERT INTO simulations (id, opportunity_id, mode, input_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      sim.opportunityId,
      sim.mode,
      sim.inputJson,
      sim.resultJson,
      sim.createdAt,
    );
  }

  insertTrade(opportunityId: string, mode: ExecutionMode, trade: TradeResult, createdAt: string): string {
    const day = utcDay(new Date(createdAt));
    const tradeId = crypto.randomUUID();
    const transaction = this.alphaDb.transaction(() => {
      this.runPreparedStatement(
        this.alphaDb,
        `INSERT INTO trades (
          id, opportunity_id, mode, tx_hash, status, gross_usd, fee_usd, net_usd,
          error_type, latency_ms, slippage_deviation_bps, created_at, settled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tradeId,
        opportunityId,
        mode,
        trade.txHash,
        trade.status,
        trade.grossUsd,
        trade.feeUsd,
        trade.netUsd,
        trade.errorType ?? null,
        trade.latencyMs ?? null,
        trade.slippageDeviationBps ?? null,
        createdAt,
        createdAt,
      );

      this.runPreparedStatement(
        this.alphaDb,
        `INSERT INTO pnl_daily (day, mode, gross_usd, fee_usd, net_usd, trades_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(day, mode) DO UPDATE SET
           gross_usd = pnl_daily.gross_usd + excluded.gross_usd,
           fee_usd = pnl_daily.fee_usd + excluded.fee_usd,
           net_usd = pnl_daily.net_usd + excluded.net_usd,
           trades_count = pnl_daily.trades_count + 1`,
        day,
        mode,
        trade.grossUsd,
        trade.feeUsd,
        trade.netUsd,
      );
    });
    transaction();
    return tradeId;
  }

  insertAlert(level: string, eventType: string, message: string): void {
    this.runPreparedStatement(
      this.alphaDb,
      "INSERT INTO alerts (id, level, event_type, message, created_at) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      level,
      eventType,
      message,
      new Date().toISOString(),
    );
  }

  getTodayMetrics(): TodayMetrics {
    const day = utcDay();
    const oppRow = this.alphaDb
      .prepare("SELECT COUNT(1) AS count FROM opportunities WHERE substr(detected_at, 1, 10) = ?")
      .get(day) as { count: number };

    const tradeRow = this.alphaDb
      .prepare("SELECT COUNT(1) AS count FROM trades WHERE substr(created_at, 1, 10) = ?")
      .get(day) as { count: number };

    const pnlRows = this.alphaDb
      .prepare("SELECT COALESCE(SUM(gross_usd), 0) AS gross, COALESCE(SUM(fee_usd), 0) AS fee, COALESCE(SUM(net_usd), 0) AS net FROM pnl_daily WHERE day = ?")
      .get(day) as { gross: number; fee: number; net: number };

    const curveRows = this.alphaDb
      .prepare(
        `SELECT created_at AS ts, net_usd AS netUsd
         FROM trades
         WHERE substr(created_at, 1, 10) = ?
         ORDER BY created_at DESC
         LIMIT 10`,
      )
      .all(day) as Array<{ ts: string; netUsd: number }>;

    const quoteQualityRow = this.alphaDb
      .prepare(
        `SELECT stale_quotes AS staleQuotes,
                latency_sum_ms AS latencySumMs,
                latency_samples AS latencySamples
         FROM quote_quality_daily
         WHERE day = ?`,
      )
      .get(day) as { staleQuotes: number; latencySumMs: number; latencySamples: number } | undefined;

    return {
      day,
      opportunities: oppRow.count,
      trades: tradeRow.count,
      netUsd: pnlRows.net,
      grossUsd: pnlRows.gross,
      feeUsd: pnlRows.fee,
      staleQuotes: quoteQualityRow?.staleQuotes ?? 0,
      avgQuoteLatencyMs:
        quoteQualityRow && quoteQualityRow.latencySamples > 0
          ? quoteQualityRow.latencySumMs / quoteQualityRow.latencySamples
          : 0,
      curve: curveRows.reverse(),
    };
  }

  listOpportunities(limit: number): unknown[] {
    const rows = this.alphaDb
      .prepare(
        `SELECT id, strategy_id, pair, buy_dex, sell_dex, gross_edge_bps, est_cost_usd, est_net_usd, status, detected_at, metadata_json
         FROM opportunities
         ORDER BY detected_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      strategy_id: string;
      pair: string;
      buy_dex: string;
      sell_dex: string;
      gross_edge_bps: number;
      est_cost_usd: number;
      est_net_usd: number;
      status: string;
      detected_at: string;
      metadata_json: string | null;
    }>;

    return rows.map((row) => ({
      ...row,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    }));
  }

  getReplayDataset(hours: number, strategyId?: string): Array<{
    id: string;
    strategyId: string;
    pair: string;
    grossEdgeBps: number;
    estCostUsd: number;
    estNetUsd: number;
    status: string;
    detectedAt: string;
  }> {
    const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
    const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
    const baseQuery = `SELECT id,
                              strategy_id AS strategyId,
                              pair,
                              gross_edge_bps AS grossEdgeBps,
                              est_cost_usd AS estCostUsd,
                              est_net_usd AS estNetUsd,
                              status,
                              detected_at AS detectedAt
                       FROM opportunities
                       WHERE detected_at >= ?`;
    const query = strategyId ? `${baseQuery} AND strategy_id = ? ORDER BY detected_at ASC` : `${baseQuery} ORDER BY detected_at ASC`;
    return (strategyId
      ? this.alphaDb.prepare(query).all(since, strategyId)
      : this.alphaDb.prepare(query).all(since)) as Array<{
      id: string;
      strategyId: string;
      pair: string;
      grossEdgeBps: number;
      estCostUsd: number;
      estNetUsd: number;
      status: string;
      detectedAt: string;
    }>;
  }

  listTrades(limit: number): unknown[] {
    return this.alphaDb
      .prepare(
        `SELECT t.id, t.opportunity_id, o.strategy_id, t.mode, t.tx_hash, t.status, t.gross_usd, t.fee_usd, t.net_usd, t.created_at, t.settled_at, o.pair
         FROM trades t
         LEFT JOIN opportunities o ON o.id = t.opportunity_id
         ORDER BY t.created_at DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  listAlerts(limit: number): Array<{ level: string; eventType: string; message: string; createdAt: string }> {
    return this.alphaDb
      .prepare(
        `SELECT level, event_type AS eventType, message, created_at AS createdAt
         FROM alerts
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ level: string; eventType: string; message: string; createdAt: string }>;
  }

  listStrategyStatusToday(): StrategyStatus[] {
    const day = utcDay();
    return this.alphaDb
      .prepare(
        `SELECT o.strategy_id AS strategyId,
                COUNT(DISTINCT o.id) AS opportunities,
                COUNT(t.id) AS trades,
                COALESCE(SUM(t.net_usd), 0) AS netUsd
         FROM opportunities o
         LEFT JOIN trades t
           ON t.opportunity_id = o.id
          AND substr(t.created_at, 1, 10) = ?
         WHERE substr(o.detected_at, 1, 10) = ?
         GROUP BY o.strategy_id
         ORDER BY netUsd DESC`,
      )
      .all(day, day) as StrategyStatus[];
  }

  getLatestShareCard(): ShareCard | null {
    const row = this.alphaDb
      .prepare(
        `SELECT t.tx_hash AS txHash,
                t.mode AS mode,
                t.net_usd AS netUsd,
                t.created_at AS timestamp,
                o.pair AS pair,
                o.strategy_id AS strategyId
         FROM trades t
         JOIN opportunities o ON o.id = t.opportunity_id
         WHERE t.status != 'failed'
         ORDER BY t.created_at DESC
         LIMIT 1`,
      )
      .get() as
      | {
          txHash: string;
          mode: ExecutionMode;
          netUsd: number;
          timestamp: string;
          pair: string;
          strategyId: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const signed = formatSignedUsd(row.netUsd);
    return {
      ...row,
      title: `AlphaOS 战报 ${row.pair} ${signed} USD`,
      text: `【AlphaOS 战报】${row.strategyId} 在 ${row.mode} 模式完成 ${row.pair}，单笔 ${signed} USD。可信凭证 tx=${row.txHash} #DEXArbitrage`,
    };
  }

  listGrowthMoments(limit = 5): GrowthMoment[] {
    const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
    const day = utcDay();
    const nowIso = new Date().toISOString();
    const moments: GrowthMoment[] = [];
    const metrics = this.getTodayMetrics();
    const todaySigned = formatSignedUsd(metrics.netUsd);

    moments.push({
      id: `summary-${day}`,
      category: "summary",
      title: `AlphaOS 日报 ${todaySigned} USD`,
      text: `今日机会 ${metrics.opportunities} 笔，成交 ${metrics.trades} 笔，净收益 ${todaySigned} USD，可通过回放与快照复盘。`,
      timestamp: nowIso,
      valueUsd: metrics.netUsd,
      tags: ["日报", "可复盘", "透明"],
    });

    const latest = this.alphaDb
      .prepare(
        `SELECT t.tx_hash AS txHash,
                t.mode AS mode,
                t.net_usd AS netUsd,
                t.created_at AS timestamp,
                o.pair AS pair,
                o.strategy_id AS strategyId
         FROM trades t
         JOIN opportunities o ON o.id = t.opportunity_id
         WHERE t.status != 'failed'
         ORDER BY t.created_at DESC
         LIMIT 1`,
      )
      .get() as
      | {
          txHash: string;
          mode: ExecutionMode;
          netUsd: number;
          timestamp: string;
          pair: string;
          strategyId: string;
        }
      | undefined;

    if (latest) {
      const signed = formatSignedUsd(latest.netUsd);
      moments.push({
        id: `latest-${latest.txHash}`,
        category: "trade",
        title: `最新成交 ${signed} USD`,
        text: `最新成交：${latest.strategyId} ${latest.pair} ${latest.mode} 模式实现 ${signed} USD，tx=${latest.txHash}。`,
        timestamp: latest.timestamp,
        valueUsd: latest.netUsd,
        tags: ["最新", "成交", latest.mode],
      });
    }

    const bestToday = this.alphaDb
      .prepare(
        `SELECT t.tx_hash AS txHash,
                t.mode AS mode,
                t.net_usd AS netUsd,
                t.created_at AS timestamp,
                o.pair AS pair,
                o.strategy_id AS strategyId
         FROM trades t
         JOIN opportunities o ON o.id = t.opportunity_id
         WHERE substr(t.created_at, 1, 10) = ?
           AND t.status != 'failed'
         ORDER BY t.net_usd DESC, t.created_at DESC
         LIMIT 1`,
      )
      .get(day) as
      | {
          txHash: string;
          mode: ExecutionMode;
          netUsd: number;
          timestamp: string;
          pair: string;
          strategyId: string;
        }
      | undefined;

    if (bestToday && bestToday.txHash !== latest?.txHash) {
      const signed = formatSignedUsd(bestToday.netUsd);
      moments.push({
        id: `best-${bestToday.txHash}`,
        category: "trade",
        title: `今日最佳单 ${signed} USD`,
        text: `今日最佳：${bestToday.strategyId} ${bestToday.pair} ${bestToday.mode} 模式单笔 ${signed} USD，tx=${bestToday.txHash}。`,
        timestamp: bestToday.timestamp,
        valueUsd: bestToday.netUsd,
        tags: ["最佳单", "今日", bestToday.mode],
      });
    }

    const streakRows = this.alphaDb
      .prepare(
        `SELECT t.status AS status,
                t.net_usd AS netUsd
         FROM trades t
         WHERE substr(t.created_at, 1, 10) = ?
         ORDER BY t.created_at DESC
         LIMIT 20`,
      )
      .all(day) as Array<{ status: string; netUsd: number }>;
    let streakCount = 0;
    let streakNetUsd = 0;
    for (const row of streakRows) {
      if (row.status === "failed" || row.netUsd <= 0) {
        break;
      }
      streakCount += 1;
      streakNetUsd += row.netUsd;
    }
    if (streakCount >= 2) {
      const signed = formatSignedUsd(streakNetUsd);
      moments.push({
        id: `streak-${day}`,
        category: "streak",
        title: `连胜 ${streakCount} 单`,
        text: `当前连胜 ${streakCount} 单，累计 ${signed} USD。`,
        timestamp: nowIso,
        valueUsd: streakNetUsd,
        tags: ["连胜", "动量", "传播点"],
      });
    }

    const safetyAlerts = this.alphaDb
      .prepare(
        `SELECT event_type AS eventType, created_at AS createdAt
         FROM alerts
         WHERE substr(created_at, 1, 10) = ?
           AND event_type IN ('live_permission_degraded', 'circuit_breaker')
         ORDER BY created_at DESC
         LIMIT 5`,
      )
      .all(day) as Array<{ eventType: string; createdAt: string }>;

    if (safetyAlerts.length === 0) {
      moments.push({
        id: `safety-ok-${day}`,
        category: "safety",
        title: "风控守护正常",
        text: "今日未触发熔断/权限降级告警，系统运行在风险阈值内。",
        timestamp: nowIso,
        tags: ["风控", "稳定", "可信"],
      });
    } else {
      const latestSafety = safetyAlerts[0];
      moments.push({
        id: `safety-alert-${day}`,
        category: "safety",
        title: `风控事件 ${safetyAlerts.length} 次`,
        text: `今日触发 ${safetyAlerts.length} 次风控保护，最近事件=${latestSafety?.eventType ?? "unknown"}。`,
        timestamp: latestSafety?.createdAt ?? nowIso,
        tags: ["风控", "保护触发", "降级"],
      });
    }

    moments.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return moments.slice(0, safeLimit);
  }

  getBacktestSnapshot(hours: number): BacktestSnapshotRow[] {
    const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
    const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
    const rows = this.alphaDb
      .prepare(
        `SELECT o.strategy_id AS strategyId,
                COUNT(1) AS opportunities,
                SUM(CASE WHEN o.status = 'planned' OR o.status = 'executed' THEN 1 ELSE 0 END) AS planned,
                SUM(CASE WHEN o.status = 'executed' THEN 1 ELSE 0 END) AS executed,
                SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN o.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                COALESCE(AVG(o.est_net_usd), 0) AS avgEstimatedNetUsd,
                COALESCE(SUM(t.net_usd), 0) AS realizedNetUsd,
                COALESCE(AVG(CASE WHEN t.status = 'failed' THEN 0 ELSE 1 END), 0) AS tradeWinRate
         FROM opportunities o
         LEFT JOIN trades t ON t.opportunity_id = o.id
         WHERE o.detected_at >= ?
         GROUP BY o.strategy_id
         ORDER BY realizedNetUsd DESC`,
      )
      .all(since) as Array<{
      strategyId: string;
      opportunities: number;
      planned: number | null;
      executed: number | null;
      failed: number | null;
      rejected: number | null;
      avgEstimatedNetUsd: number;
      realizedNetUsd: number;
      tradeWinRate: number;
    }>;

    return rows.map((row) => ({
      strategyId: row.strategyId,
      opportunities: row.opportunities,
      planned: row.planned ?? 0,
      executed: row.executed ?? 0,
      failed: row.failed ?? 0,
      rejected: row.rejected ?? 0,
      avgEstimatedNetUsd: row.avgEstimatedNetUsd,
      realizedNetUsd: row.realizedNetUsd,
      tradeWinRate: row.tradeWinRate,
    }));
  }

  getSimulationStats(hours: number): { netUsd: number; winRate: number } {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = this.alphaDb
      .prepare("SELECT result_json FROM simulations WHERE created_at >= ?")
      .all(since) as Array<{ result_json: string }>;

    if (rows.length === 0) {
      return { netUsd: 0, winRate: 0 };
    }

    let wins = 0;
    let net = 0;
    for (const row of rows) {
      const parsed = JSON.parse(row.result_json) as { netUsd: number; pass: boolean };
      net += parsed.netUsd;
      if (parsed.pass) {
        wins += 1;
      }
    }

    return {
      netUsd: net,
      winRate: wins / rows.length,
    };
  }

  getRecentConsecutiveFailures(limit: number): number {
    const rows = this.alphaDb
      .prepare("SELECT status FROM trades ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ status: string }>;

    let failures = 0;
    for (const row of rows) {
      if (row.status !== "failed") {
        break;
      }
      failures += 1;
    }
    return failures;
  }

  getTodayNetUsd(mode: ExecutionMode): number {
    const row = this.alphaDb
      .prepare("SELECT net_usd FROM pnl_daily WHERE day = ? AND mode = ?")
      .get(utcDay(), mode) as { net_usd: number } | undefined;
    return row?.net_usd ?? 0;
  }

  ensureBalanceBaseline(mode: ExecutionMode, baselineUsd: number): void {
    const now = new Date().toISOString();
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO mode_balances (mode, baseline_usd, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(mode) DO NOTHING`,
      mode,
      baselineUsd,
      now,
    );
  }

  getCurrentBalance(mode: ExecutionMode): number {
    const baselineRow = this.alphaDb
      .prepare("SELECT baseline_usd AS baselineUsd FROM mode_balances WHERE mode = ?")
      .get(mode) as { baselineUsd: number } | undefined;
    const pnlRow = this.alphaDb
      .prepare("SELECT COALESCE(SUM(net_usd), 0) AS cumulativeNetUsd FROM pnl_daily WHERE mode = ?")
      .get(mode) as { cumulativeNetUsd: number };
    const baseline = baselineRow?.baselineUsd ?? 0;
    return baseline + pnlRow.cumulativeNetUsd;
  }

  getExecutionQualityStats(hours: number): {
    permissionFailures: number;
    rejectRate: number;
    avgLatencyMs: number;
    avgSlippageDeviationBps: number;
  } {
    const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
    const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();

    const permissionTradeRow = this.alphaDb
      .prepare(
        `SELECT COUNT(1) AS count
         FROM trades
         WHERE created_at >= ?
           AND error_type IN ('permission_denied', 'whitelist_restricted')`,
      )
      .get(since) as { count: number };
    const permissionAlertRow = this.alphaDb
      .prepare(
        `SELECT COUNT(1) AS count
         FROM alerts
         WHERE created_at >= ?
           AND event_type = 'live_permission_degraded'`,
      )
      .get(since) as { count: number };

    const opportunityRow = this.alphaDb
      .prepare(
        `SELECT COUNT(1) AS total,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM opportunities
         WHERE detected_at >= ?`,
      )
      .get(since) as { total: number; rejected: number | null };

    const tradeQualityRow = this.alphaDb
      .prepare(
        `SELECT COALESCE(AVG(latency_ms), 0) AS avgLatencyMs,
                COALESCE(AVG(ABS(slippage_deviation_bps)), 0) AS avgSlippageDeviationBps
         FROM trades
         WHERE created_at >= ?`,
      )
      .get(since) as { avgLatencyMs: number; avgSlippageDeviationBps: number };

    return {
      permissionFailures: permissionTradeRow.count + permissionAlertRow.count,
      rejectRate:
        opportunityRow.total > 0 ? (opportunityRow.rejected ?? 0) / opportunityRow.total : 0,
      avgLatencyMs: tradeQualityRow.avgLatencyMs,
      avgSlippageDeviationBps: tradeQualityRow.avgSlippageDeviationBps,
    };
  }

  getMarketStateStats(hours: number): {
    volatility24h: number | null;
    gasP90Usd24h: number | null;
    liquidityMedianUsd24h: number | null;
    samples: number;
  } {
    const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
    const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
    const rows = this.alphaDb
      .prepare(
        `SELECT metadata_json AS metadataJson
         FROM opportunities
         WHERE detected_at >= ?
           AND metadata_json IS NOT NULL`,
      )
      .all(since) as Array<{ metadataJson: string }>;

    const volatilities: number[] = [];
    const gasValues: number[] = [];
    const liquidities: number[] = [];

    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
        const volatility = metadata.volatility;
        if (typeof volatility === "number" && Number.isFinite(volatility) && volatility >= 0) {
          volatilities.push(volatility);
        }

        const liquidityUsd = metadata.liquidityUsd;
        if (typeof liquidityUsd === "number" && Number.isFinite(liquidityUsd) && liquidityUsd > 0) {
          liquidities.push(liquidityUsd);
        }

        const gasBuyUsd = metadata.gasBuyUsd;
        const gasSellUsd = metadata.gasSellUsd;
        if (typeof gasBuyUsd === "number" && Number.isFinite(gasBuyUsd) && gasBuyUsd >= 0) {
          gasValues.push(gasBuyUsd);
        }
        if (typeof gasSellUsd === "number" && Number.isFinite(gasSellUsd) && gasSellUsd >= 0) {
          gasValues.push(gasSellUsd);
        }
      } catch {
        continue;
      }
    }

    const avgVolatility =
      volatilities.length > 0 ? volatilities.reduce((sum, value) => sum + value, 0) / volatilities.length : null;
    return {
      volatility24h: avgVolatility,
      gasP90Usd24h: quantile(gasValues, 0.9),
      liquidityMedianUsd24h: quantile(liquidities, 0.5),
      samples: rows.length,
    };
  }

  enqueueOutbox(endpoint: string, payload: string, nextRetryAt: string, status: "pending" | "dead" = "pending", retryCount = 0, lastError: string | null = null): void {
    this.runPreparedStatement(
      this.alphaDb,
      `INSERT INTO hook_outbox (id, endpoint, payload, status, retry_count, next_retry_at, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      endpoint,
      payload,
      status,
      retryCount,
      nextRetryAt,
      lastError,
      new Date().toISOString(),
    );
  }

  getDueOutbox(nowIso: string, limit = 50): HookOutboxRow[] {
    return this.alphaDb
      .prepare(
        `SELECT id, endpoint, payload, retry_count AS retryCount, next_retry_at AS nextRetryAt, status
         FROM hook_outbox
         WHERE status = 'pending' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as HookOutboxRow[];
  }

  markOutboxSent(id: string): void {
    this.runPreparedStatement(this.alphaDb, "UPDATE hook_outbox SET status = 'sent' WHERE id = ?", id);
  }

  markOutboxRetry(id: string, retryCount: number, nextRetryAt: string, lastError: string): void {
    const status = retryCount >= 5 ? "dead" : "pending";
    this.runPreparedStatement(
      this.alphaDb,
      "UPDATE hook_outbox SET status = ?, retry_count = ?, next_retry_at = ?, last_error = ? WHERE id = ?",
      status,
      retryCount,
      nextRetryAt,
      lastError.slice(0, 512),
      id,
    );
  }

  upsertVaultItem(params: {
    keyAlias: string;
    cipherText: string;
    nonce: string;
    salt: string;
    kdfIter: number;
  }): void {
    const existing = this.vaultDb
      .prepare("SELECT id, created_at FROM vault_items WHERE key_alias = ?")
      .get(params.keyAlias) as { id: string; created_at: string } | undefined;
    const now = new Date().toISOString();

    if (!existing) {
      this.runPreparedStatement(
        this.vaultDb,
        `INSERT INTO vault_items
         (id, key_alias, cipher_text, nonce, salt, kdf_iter, created_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        crypto.randomUUID(),
        params.keyAlias,
        params.cipherText,
        params.nonce,
        params.salt,
        params.kdfIter,
        now,
      );
      return;
    }

    this.runPreparedStatement(
      this.vaultDb,
      `UPDATE vault_items
       SET cipher_text = ?, nonce = ?, salt = ?, kdf_iter = ?, rotated_at = ?
       WHERE id = ?`,
      params.cipherText,
      params.nonce,
      params.salt,
      params.kdfIter,
      now,
      existing.id,
    );
  }

  getVaultItem(keyAlias: string):
    | {
        keyAlias: string;
        cipherText: string;
        nonce: string;
        salt: string;
        kdfIter: number;
      }
    | null {
    const row = this.vaultDb
      .prepare(
        "SELECT key_alias AS keyAlias, cipher_text AS cipherText, nonce, salt, kdf_iter AS kdfIter FROM vault_items WHERE key_alias = ?",
      )
      .get(keyAlias) as
      | {
          keyAlias: string;
          cipherText: string;
          nonce: string;
          salt: string;
          kdfIter: number;
        }
      | undefined;

    return row ?? null;
  }

  close(): void {
    this.alphaDb.close();
    this.vaultDb.close();
  }
}
