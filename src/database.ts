import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, type Generated, type Transaction } from "kysely";
import { applyMigrations } from "./migrations.js";

export interface DatabaseSchema {
  service_state: {
    key: string;
    value: string;
    updated_at: Generated<string>;
  };
  source_registry: {
    source_key: string;
    display_name: string;
    created_at: Generated<string>;
  };
  rule_sets: {
    version: string;
    statutory_days: number;
    max_extension_days: number;
    reminder_threshold_days: number;
    supplement_pause_basis: string;
    external_wait_basis: string;
    published_at: string;
    created_at: Generated<string>;
  };
  agencies: {
    agency_id: string;
    display_name: string;
    region: string;
    created_at: Generated<string>;
  };
  staff: {
    staff_id: string;
    display_name: string;
    agency_id: string;
    permissions: string;
    conflict_regions: string;
    created_at: Generated<string>;
  };
  cases: {
    case_id: string;
    title: string;
    consumer_region: string;
    merchant_region: string;
    transaction_region: string;
    rule_set_version: string;
    evidence_watermark: string;
    status: string;
    current_stage: number;
    accepted_at: string;
    created_at: Generated<string>;
  };
  case_claims: {
    claim_id: string;
    case_id: string;
    party_role: string;
    content: string;
    submitted_at: string;
  };
  jurisdiction_decisions: {
    decision_id: string;
    case_id: string;
    lead_agency: string;
    co_agencies: string;
    confirmed_by: string;
    rule_set_version: string;
    decided_at: string;
  };
  case_responsibility: {
    id: Generated<number>;
    case_id: string;
    agency_id: string;
    role: string;
    seq: number;
    started_at: string;
    ended_at: string | null;
    transfer_id: string | null;
  };
  clock_events: {
    event_id: string;
    case_id: string;
    stage: number;
    seq: number;
    event_type: string;
    occurred_at: string;
    rule_set_version: string;
    payload: string;
    recorded_by: string | null;
    recorded_at: Generated<string>;
  };
  stage_decisions: {
    case_id: string;
    stage: number;
    decision: string;
    issued_by: string;
    issued_at: string;
    rule_set_version: string;
    snapshot: string;
  };
  materials: {
    material_id: string;
    case_id: string;
    label: string;
    content_hash: string;
    state: string;
    manifest_version: number | null;
    received_at: string;
    attributed_at: string | null;
  };
  transfers: {
    transfer_id: string;
    case_id: string;
    from_agency: string;
    to_agency: string;
    reason: string;
    manifest_version: number;
    manifest: string;
    manifest_hash: string;
    state: string;
    idempotency_key: string;
    initiated_by: string;
    frozen_at: string;
    signed_by: string | null;
    signed_at: string | null;
    effective_at: string | null;
    cancelled_at: string | null;
  };
  workday_calendar: {
    region: string;
    day: string;
    is_workday: number;
  };
  notifications: {
    notification_id: string;
    case_id: string;
    kind: string;
    dedupe_key: string;
    lead_agency: string;
    basis: string;
    created_at: string;
    delivered: number;
  };
}

export type AppDatabase = Kysely<DatabaseSchema>;

/** 可在事务内外复用的执行器类型。 */
export type DbExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

/** 串行化写事务入口：所有写操作经此排队后在单事务内执行。 */
export type WriteTx = <T>(fn: (trx: Transaction<DatabaseSchema>) => Promise<T>) => Promise<T>;

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? "data/consumer_disputes.sqlite3";
}

export function openRawDatabase(): Database.Database {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  return database;
}

export function openDatabase(): AppDatabase {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: openRawDatabase() }),
  });
}

/** 打开数据库并确保所有迁移已应用；服务启动与进程恢复都走这里。 */
export function openMigratedDatabase(): AppDatabase {
  const raw = openRawDatabase();
  applyMigrations(raw);
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: raw }),
  });
}
