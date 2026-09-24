import type { Context, NotificationRow, StageRow } from "../db.js";
import { ServiceError } from "../db.js";
import type { ClockSnapshot } from "../domain/clock.js";
import { getCase, listPendingMaterials, requireActiveCase } from "./cases.js";
import { currentLink } from "./rulings.js";
import { buildStageClock, openStageRow } from "./ledger.js";
import { isoNow } from "./util.js";

export const DUE_SOON_WORKING_MINUTES = 2 * 480; // 剩余不足 2 个工作日提醒

function insertNotification(
  ctx: Context,
  input: {
    case_id: string;
    stage_id: string | null;
    kind: "due_soon" | "overdue" | "reminder";
    dedup_key: string | null;
    basis: unknown;
    created_by: string;
  },
): NotificationRow | null {
  try {
    const info = ctx.raw
      .prepare(
        `INSERT INTO notifications(case_id, stage_id, kind, dedup_key, basis_json, created_by, created_at, delivered_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.case_id, input.stage_id, input.kind, input.dedup_key,
        JSON.stringify(input.basis), input.created_by, isoNow(ctx), isoNow(ctx),
      );
    return ctx.raw.prepare("SELECT * FROM notifications WHERE id = ?").get(info.lastInsertRowid) as NotificationRow;
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) return null; // 已通知，去重
    throw err;
  }
}

export interface ScanResult {
  scanned_cases: number;
  due_soon: number;
  overdue: number;
  created: NotificationRow[];
  ran_at: string;
}

/**
 * 到期扫描：对所有进行中阶段重算时钟。
 *  - 剩余工时 <= 阈值：每阶段一条 due_soon（持久 dedup）；
 *  - 预算用尽且仍在计时：每个当地自然日一条 overdue；
 *  - 暂停中不计期、不报警；待归属材料随 basis 暴露。
 * 通知落库，进程重启后凭 dedup_key 继续扫描而不重复打扰。
 */
export function runDueScan(ctx: Context): ScanResult {
  const ranAt = isoNow(ctx);
  const created: NotificationRow[] = [];
  let dueSoon = 0;
  let overdue = 0;

  const stages = ctx.raw
    .prepare(
      `SELECT s.* FROM case_stages s JOIN cases c ON c.case_id = s.case_id
       WHERE c.status = 'active' AND s.decided_at IS NULL ORDER BY s.case_id, s.seq`,
    )
    .all() as StageRow[];

  for (const stage of stages) {
    const snapshot = buildStageClock(ctx, stage.case_id, stage.stage_id, ranAt);
    const link = currentLink(ctx, stage.case_id, ranAt);
    const pending = listPendingMaterials(ctx, stage.case_id).length;

    if (snapshot.status === "running") {
      if (snapshot.remaining_minutes === 0) {
        // 预算已用尽仍在计时：逾期（此时 deadline_at 已落在过去，不再外推）。
        const dayKey = ranAt.slice(0, 10);
        const n = insertNotification(ctx, {
          case_id: stage.case_id,
          stage_id: stage.stage_id,
          kind: "overdue",
          dedup_key: `overdue:${stage.stage_id}:${dayKey}`,
          created_by: "system",
          basis: scanBasis(stage, link, snapshot, pending),
        });
        if (n) {
          created.push(n);
          overdue++;
        }
      } else if (snapshot.deadline_at && snapshot.remaining_minutes <= DUE_SOON_WORKING_MINUTES) {
        const n = insertNotification(ctx, {
          case_id: stage.case_id,
          stage_id: stage.stage_id,
          kind: "due_soon",
          dedup_key: `due_soon:${stage.stage_id}`,
          created_by: "system",
          basis: scanBasis(stage, link, snapshot, pending),
        });
        if (n) {
          created.push(n);
          dueSoon++;
        }
      }
    }
  }

  ctx.raw
    .prepare("INSERT INTO service_state(key, value, updated_at) VALUES ('deadline_scanner.last_run_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(ranAt, ranAt);

  return { scanned_cases: stages.length, due_soon: dueSoon, overdue, created, ran_at: ranAt };
}

function scanBasis(
  stage: StageRow,
  link: { agency_code: string; region_code: string },
  snapshot: ClockSnapshot,
  pendingCount: number,
) {
  return {
    stage_id: stage.stage_id,
    stage_code: stage.stage_code,
    responsible_agency: link.agency_code,
    responsible_region: link.region_code,
    rule_version: stage.rule_version,
    budget_minutes: snapshot.budget_minutes,
    used_minutes: snapshot.used_minutes,
    remaining_minutes: snapshot.remaining_minutes,
    deadline_at: snapshot.deadline_at,
    excluded_periods: snapshot.excluded_periods,
    pending_material_count: pendingCount,
  };
}

/** 人工催办：留存本次催办的实际依据（时钟快照 + 负责机构 + 待归属材料）。 */
export function createReminder(
  ctx: Context,
  caseId: string,
  input: { created_by: string; note: string; idempotency_key: string },
): NotificationRow {
  requireActiveCase(ctx, caseId);
  const stage = openStageRow(ctx, caseId);
  if (!stage) throw new ServiceError("no_open_stage", "案件没有进行中的阶段，无法催办", 409);
  const snapshot = buildStageClock(ctx, caseId, stage.stage_id);
  const link = currentLink(ctx, caseId);
  const basis = {
    note: input.note,
    stage_id: stage.stage_id,
    stage_code: stage.stage_code,
    responsible_agency: link.agency_code,
    responsible_region: link.region_code,
    clock: {
      status: snapshot.status,
      budget_minutes: snapshot.budget_minutes,
      used_minutes: snapshot.used_minutes,
      remaining_minutes: snapshot.remaining_minutes,
      deadline_at: snapshot.deadline_at,
      paused_since: snapshot.paused_since,
      pause_basis: snapshot.pause_basis,
      excluded_periods: snapshot.excluded_periods,
    },
    pending_materials: listPendingMaterials(ctx, caseId).map((m) => ({
      id: m.id,
      title: m.title,
      arrived_at: m.arrived_at,
      transfer_id: m.arrived_during_transfer_id,
    })),
  };
  const row = insertNotification(ctx, {
    case_id: caseId,
    stage_id: stage.stage_id,
    kind: "reminder",
    dedup_key: `reminder:${caseId}:${input.idempotency_key}`,
    basis,
    created_by: input.created_by,
  });
  if (!row) {
    return ctx.raw
      .prepare("SELECT * FROM notifications WHERE dedup_key = ?")
      .get(`reminder:${caseId}:${input.idempotency_key}`) as NotificationRow;
  }
  return row;
}

export function listNotifications(ctx: Context, caseId: string): NotificationRow[] {
  getCase(ctx, caseId);
  return ctx.raw
    .prepare("SELECT * FROM notifications WHERE case_id = ? ORDER BY created_at, id")
    .all(caseId) as NotificationRow[];
}

export function lastScanAt(ctx: Context): string | null {
  const row = ctx.raw.prepare("SELECT value FROM service_state WHERE key = 'deadline_scanner.last_run_at'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
