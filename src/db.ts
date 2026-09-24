import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { openRawDatabase, databasePath } from "./database.js";

// ---- 行类型 -----------------------------------------------------------------

export interface RegionRow {
  code: string;
  display_name: string;
  iana_timezone: string;
  created_at: string;
}
export interface AgencyRow {
  agency_code: string;
  region_code: string;
  display_name: string;
  created_at: string;
}
export interface PersonRow {
  person_id: string;
  agency_code: string;
  display_name: string;
  active: number;
  created_at: string;
}
export interface RuleVersionRow {
  version: string;
  title: string;
  status: "draft" | "effective" | "retired";
  payload_json: string;
  published_at: string | null;
  created_at: string;
}
export interface CaseRow {
  case_id: string;
  case_no: string;
  subject: string;
  consumer_region: string | null;
  merchant_region: string | null;
  transaction_region: string | null;
  rule_version: string;
  status: "active" | "closed";
  opened_by: string;
  opened_at: string;
}
export interface PartyClaimRow {
  id: number;
  case_id: string;
  party_role: "consumer" | "merchant" | "other";
  party_name: string;
  claimed_agency: string | null;
  claimed_region: string | null;
  statement: string;
  submitted_by: string;
  submitted_at: string;
}
export interface MaterialRow {
  id: number;
  case_id: string;
  seq: number;
  kind: string;
  material_key: string;
  title: string;
  payload_json: string;
  checksum: string;
  status: "received" | "pending_attribution" | "attributed" | "rejected";
  arrived_at: string;
  arrived_by: string;
  pending_transfer_id: number | null;
  arrived_during_transfer_id: number | null;
  attributed_at: string | null;
  attributed_by: string | null;
  attribution_note: string;
  idempotency_key: string;
}
export interface RulingRow {
  id: number;
  case_id: string;
  seq: number;
  lead_agency: string;
  co_agencies_json: string;
  ruled_by: string;
  evidence_watermark: number;
  rule_version: string;
  basis: string;
  ruled_at: string;
}
export interface LinkRow {
  id: number;
  case_id: string;
  seq: number;
  agency_code: string;
  region_code: string;
  source: "intake" | "ruling" | "transfer";
  source_ref: string;
  effective_from: string;
  effective_to: string | null;
}
export interface StageRow {
  stage_id: string;
  case_id: string;
  seq: number;
  stage_code: string;
  rule_version: string;
  working_days: number;
  opened_at: string;
  decided_at: string | null;
  decision_id: number | null;
}
export interface DeadlineEventRow {
  id: number;
  case_id: string;
  stage_id: string;
  seq: number;
  type: "open" | "supplement_request" | "wait_external" | "resume" | "emergency_extension" | "close";
  occurred_at: string;
  actor: string;
  reason_code: string;
  legal_basis: string;
  payload_json: string;
  idempotency_key: string | null;
}
export interface DecisionRow {
  id: number;
  case_id: string;
  stage_id: string;
  decision_no: string;
  rule_version: string;
  issued_by: string;
  issued_at: string;
  payload_json: string;
  clock_snapshot_json: string;
}
export interface TransferRow {
  id: number;
  case_id: string;
  seq: number;
  from_agency: string;
  to_agency: string;
  status: "proposed" | "frozen" | "received" | "effective" | "cancelled";
  idempotency_key: string;
  proposed_by: string;
  proposed_at: string;
  frozen_by: string | null;
  frozen_at: string | null;
  manifest_hash: string;
  manifest_json: string;
  received_by: string | null;
  received_at: string | null;
  effective_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
}
export interface ReceiptRow {
  id: number;
  transfer_id: number;
  received_by: string;
  manifest_hash: string;
  received_at: string;
  idempotency_key: string;
}
export interface NotificationRow {
  id: number;
  case_id: string;
  stage_id: string | null;
  kind: "due_soon" | "overdue" | "reminder";
  dedup_key: string | null;
  basis_json: string;
  created_by: string;
  created_at: string;
  delivered_at: string | null;
}

// ---- 上下文 -----------------------------------------------------------------

export interface RulePayload {
  stage_working_days: Record<string, number>;
  emergency_extension_max_days: number;
}

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface Context {
  raw: BetterSqlite3.Database;
  db: Kysely<Record<string, never>>;
  now(): string;
  fixedNow: string | null;
}

export function currentIso(): string {
  return new Date().toISOString();
}

let singleton: Context | null = null;

/** 进程内单例：迁移、扫描器与 HTTP 共享同一连接（WAL + busy_timeout）。 */
export function getContext(): Context {
  if (singleton) return singleton;
  const raw = openRawDatabase();
  raw.pragma("busy_timeout = 5000");
  migrateWith(raw);
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: raw }) });
  singleton = { raw, db, now: () => singleton?.fixedNow ?? currentIso(), fixedNow: null };
  return singleton;
}

/** 测试用：在指定 SQLite 文件上构建隔离上下文，可固定时钟。 */
export function createTestContext(path: string, fixedNow: string | null = null): Context {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma("foreign_keys = ON");
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");
  migrateWith(raw);
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: raw }) });
  return { raw, db, fixedNow, now: () => fixedNow ?? currentIso() };
}

/** 返回共享同一数据库连接、但时钟固定到指定瞬间的上下文视图（测试用）。 */
export function withFixedNow(ctx: Context, iso: string): Context {
  return { raw: ctx.raw, db: ctx.db, fixedNow: iso, now: () => iso };
}

export function migrateWith(raw: BetterSqlite3.Database) {
  raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const dir = join(process.cwd(), "migrations");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const done = raw.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(file);
    if (done) continue;
    const tx = raw.transaction(() => {
      raw.exec(readFileSync(join(dir, file), "utf8"));
      raw.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(file);
    });
    tx.immediate();
  }
}

export { databasePath };
