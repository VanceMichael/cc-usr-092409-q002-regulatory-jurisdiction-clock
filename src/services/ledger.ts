import type { Context, DeadlineEventRow, DecisionRow, StageRow } from "../db.js";
import { ServiceError } from "../db.js";
import {
  computeClock,
  type ClockSnapshot,
  type TimerEvent,
  validateEventOrder,
  type ResponsibilitySegment,
} from "../domain/clock.js";
import { getRulePayload, effectiveWorkingDays } from "./catalog.js";
import { getCase, requireActiveCase } from "./cases.js";
import { listLinks } from "./rulings.js";
import { isoNow, newId } from "./util.js";

type AppendType = "supplement_request" | "wait_external" | "resume" | "emergency_extension";

export interface AppendInput {
  type: AppendType;
  actor: string;
  reason_code: string;
  legal_basis: string;
  occurred_at?: string;
  working_days?: number;
  idempotency_key: string;
}

export function openStage(
  ctx: Context,
  caseId: string,
  input: { stage_code: string; opened_by: string; idempotency_key: string; working_days?: number },
): StageRow {
  const c = requireActiveCase(ctx, caseId);

  // 幂等重放：同键的阶段开启直接返回既有阶段。
  const prior = ctx.raw
    .prepare("SELECT stage_id FROM deadline_events WHERE case_id = ? AND idempotency_key = ? AND type = 'open'")
    .get(caseId, input.idempotency_key) as { stage_id: string } | undefined;
  if (prior) return getStage(ctx, prior.stage_id);

  const open = openStageRow(ctx, caseId);
  if (open) throw new ServiceError("stage_already_open", "案件已有未决阶段，不能开启新阶段", 409);

  const payload = getRulePayload(ctx, c.rule_version);
  const workingDays = input.working_days ?? effectiveWorkingDays(payload, input.stage_code);
  if (!Number.isInteger(workingDays) || workingDays <= 0) throw new ServiceError("bad_working_days", "阶段工作日必须为正整数");

  const now = isoNow(ctx);
  const stageId = newId();
  const tx = ctx.raw.transaction(() => {
    const seq = (ctx.raw.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM case_stages WHERE case_id = ?").get(caseId) as { n: number }).n;
    ctx.raw
      .prepare(
        `INSERT INTO case_stages(stage_id, case_id, seq, stage_code, rule_version, working_days, opened_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(stageId, caseId, seq, input.stage_code, c.rule_version, workingDays, now);
    ctx.raw
      .prepare(
        `INSERT INTO deadline_events(case_id, stage_id, seq, type, occurred_at, actor, reason_code, legal_basis, payload_json, idempotency_key)
         VALUES (?,?,0,'open',?,?,'STAGE_OPEN','立案/进入新阶段','{}',?)`,
      )
      .run(caseId, stageId, now, input.opened_by, input.idempotency_key);
  });
  try {
    tx.immediate();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      throw new ServiceError("stage_open_idempotent_replay", "相同幂等键的阶段开启已处理", 409);
    }
    throw err;
  }
  return ctx.raw.prepare("SELECT * FROM case_stages WHERE stage_id = ?").get(stageId) as StageRow;
}

export function listStages(ctx: Context, caseId: string): StageRow[] {
  getCase(ctx, caseId);
  return ctx.raw.prepare("SELECT * FROM case_stages WHERE case_id = ? ORDER BY seq").all(caseId) as StageRow[];
}

export function openStageRow(ctx: Context, caseId: string): StageRow | undefined {
  return ctx.raw
    .prepare("SELECT * FROM case_stages WHERE case_id = ? AND decided_at IS NULL ORDER BY seq DESC LIMIT 1")
    .get(caseId) as StageRow | undefined;
}

export function getStage(ctx: Context, stageId: string): StageRow {
  const row = ctx.raw.prepare("SELECT * FROM case_stages WHERE stage_id = ?").get(stageId);
  if (!row) throw new ServiceError("stage_not_found", `阶段 ${stageId} 不存在`, 404);
  return row as StageRow;
}

export function listEvents(ctx: Context, stageId: string): DeadlineEventRow[] {
  return ctx.raw
    .prepare("SELECT * FROM deadline_events WHERE stage_id = ? ORDER BY seq")
    .all(stageId) as DeadlineEventRow[];
}

function toTimerEvents(rows: DeadlineEventRow[]): TimerEvent[] {
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    occurred_at: r.occurred_at,
    actor: r.actor,
    reason_code: r.reason_code,
    legal_basis: r.legal_basis,
    payload: JSON.parse(r.payload_json) as { working_days?: number },
  }));
}

/**
 * 追加期限事件。暂停（补正/等待外部裁决）、恢复、紧急延长均为账本事件，
 * 系统先在完整事件流上校验状态机，再落库，保证“每一段计时”可解释。
 */
export function appendDeadlineEvent(ctx: Context, caseId: string, input: AppendInput): DeadlineEventRow {
  requireActiveCase(ctx, caseId);
  const stage = openStageRow(ctx, caseId);
  if (!stage) throw new ServiceError("no_open_stage", "案件没有进行中的阶段", 409);

  const replay = ctx.raw
    .prepare("SELECT * FROM deadline_events WHERE stage_id = ? AND idempotency_key = ?")
    .get(stage.stage_id, input.idempotency_key) as DeadlineEventRow | undefined;
  if (replay) return replay;

  const occurredAt = input.occurred_at ?? isoNow(ctx);
  if (Number.isNaN(Date.parse(occurredAt))) throw new ServiceError("bad_timestamp", "occurred_at 非法时间戳");
  if (Date.parse(occurredAt) > Date.parse(isoNow(ctx)) + 60_000) {
    throw new ServiceError("future_event", "期限事件时间不能晚于当前时间");
  }

  const payload: Record<string, number> = {};
  if (input.type === "emergency_extension") {
    if (!Number.isInteger(input.working_days) || (input.working_days ?? 0) <= 0) {
      throw new ServiceError("bad_extension", "紧急延长必须给出正整数 working_days");
    }
    const rulePayload = getRulePayload(ctx, stage.rule_version);
    const used = listEvents(ctx, stage.stage_id)
      .filter((e) => e.type === "emergency_extension")
      .reduce((s, e) => s + Number((JSON.parse(e.payload_json) as { working_days?: number }).working_days ?? 0), 0);
    if (used + input.working_days! > rulePayload.emergency_extension_max_days) {
      throw new ServiceError(
        "extension_cap_exceeded",
        `紧急延长累计 ${used + input.working_days!} 个工作日，超过规则上限 ${rulePayload.emergency_extension_max_days}`,
        422,
      );
    }
    payload.working_days = input.working_days!;
  }

  const existing = toTimerEvents(listEvents(ctx, stage.stage_id));
  const candidate: TimerEvent = {
    seq: existing.length,
    type: input.type,
    occurred_at: occurredAt,
    actor: input.actor,
    reason_code: input.reason_code,
    legal_basis: input.legal_basis,
    payload,
  };
  try {
    validateEventOrder([...existing, candidate]);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError("invalid_clock_event", (err as Error).message, 422);
  }

  try {
    ctx.raw
      .prepare(
        `INSERT INTO deadline_events(case_id, stage_id, seq, type, occurred_at, actor, reason_code, legal_basis, payload_json, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        caseId, stage.stage_id, existing.length, input.type, occurredAt, input.actor,
        input.reason_code, input.legal_basis, JSON.stringify(payload), input.idempotency_key,
      );
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      const row = ctx.raw
        .prepare("SELECT * FROM deadline_events WHERE stage_id = ? AND idempotency_key = ?")
        .get(stage.stage_id, input.idempotency_key) as DeadlineEventRow;
      return row;
    }
    throw err;
  }
  return ctx.raw
    .prepare("SELECT * FROM deadline_events WHERE stage_id = ? AND seq = ?")
    .get(stage.stage_id, existing.length) as DeadlineEventRow;
}

// ---- 决定：出具后阶段钉死，规则换版不回溯 -----------------------------------

export function issueDecision(
  ctx: Context,
  caseId: string,
  input: { decision_no: string; issued_by: string; payload?: unknown; idempotency_key: string },
): { decision: DecisionRow; stage: StageRow; snapshot: ClockSnapshot } {
  // 决定号幂等重放优先（此时阶段可能已决定）。
  const prior = ctx.raw.prepare("SELECT * FROM decisions WHERE decision_no = ?").get(input.decision_no) as DecisionRow | undefined;
  if (prior) {
    return { decision: prior, stage: getStage(ctx, prior.stage_id), snapshot: JSON.parse(prior.clock_snapshot_json) as ClockSnapshot };
  }
  requireActiveCase(ctx, caseId);
  const stage = openStageRow(ctx, caseId);
  if (!stage) throw new ServiceError("no_open_stage", "案件没有可出具决定的进行中阶段", 409);

  const now = isoNow(ctx);
  const before = buildStageClock(ctx, caseId, stage.stage_id, now);
  if (before.status === "paused") {
    throw new ServiceError("clock_paused", "期限处于暂停状态，应先恢复办理再出具决定", 422);
  }

  let decisionId = 0;
  const tx = ctx.raw.transaction(() => {
    // 先追加 close 事件，再据此重算并钉选时钟快照，最后插入不可变决定。
    const seq = (ctx.raw.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM deadline_events WHERE stage_id = ?").get(stage.stage_id) as { n: number }).n;
    ctx.raw
      .prepare(
        `INSERT INTO deadline_events(case_id, stage_id, seq, type, occurred_at, actor, reason_code, legal_basis, payload_json, idempotency_key)
         VALUES (?,?,?,'close',?,?,'DECISION_ISSUED','决定出具，期限停止','{}',?)`,
      )
      .run(caseId, stage.stage_id, seq, now, input.issued_by, input.idempotency_key);
    const snapshot = buildStageClock(ctx, caseId, stage.stage_id, now);
    const info = ctx.raw
      .prepare(
        `INSERT INTO decisions(case_id, stage_id, decision_no, rule_version, issued_by, issued_at, payload_json, clock_snapshot_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        caseId, stage.stage_id, input.decision_no, stage.rule_version, input.issued_by, now,
        JSON.stringify(input.payload ?? {}), JSON.stringify(snapshot),
      );
    decisionId = Number(info.lastInsertRowid);
    ctx.raw
      .prepare("UPDATE case_stages SET decided_at = ?, decision_id = ? WHERE stage_id = ?")
      .run(now, decisionId, stage.stage_id);
  });
  try {
    tx.immediate();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      const row = ctx.raw.prepare("SELECT * FROM decisions WHERE decision_no = ?").get(input.decision_no) as DecisionRow;
      return { decision: row, stage: getStage(ctx, row.stage_id), snapshot: JSON.parse(row.clock_snapshot_json) as ClockSnapshot };
    }
    throw err;
  }
  const decision = ctx.raw.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as DecisionRow;
  return { decision, stage: getStage(ctx, stage.stage_id), snapshot: JSON.parse(decision.clock_snapshot_json) as ClockSnapshot };
}

export function listDecisions(ctx: Context, caseId: string): DecisionRow[] {
  getCase(ctx, caseId);
  return ctx.raw.prepare("SELECT * FROM decisions WHERE case_id = ? ORDER BY id").all(caseId) as DecisionRow[];
}

// ---- 时钟视图 ---------------------------------------------------------------

function dbCalendar(ctx: Context) {
  return {
    isWorkingDay: (regionCode: string, localDay: string) => {
      const override = ctx.raw
        .prepare("SELECT kind FROM calendar_days WHERE region_code = ? AND day = ?")
        .get(regionCode, localDay) as { kind: string } | undefined;
      if (override) return override.kind === "working";
      const weekday = new Date(`${localDay}T00:00:00Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    },
  };
}

function tzMap(ctx: Context): Map<string, string> {
  const rows = ctx.raw.prepare("SELECT code, iana_timezone FROM regions").all() as { code: string; iana_timezone: string }[];
  return new Map(rows.map((r) => [r.code, r.iana_timezone]));
}

export function buildStageClock(ctx: Context, caseId: string, stageId: string, asOf?: string): ClockSnapshot {
  const stage = getStage(ctx, stageId);
  if (stage.case_id !== caseId) throw new ServiceError("stage_case_mismatch", "阶段不属于该案件", 400);
  const events = toTimerEvents(listEvents(ctx, stageId));
  const links = listLinks(ctx, caseId).map(
    (l): ResponsibilitySegment => ({
      agency_code: l.agency_code,
      region_code: l.region_code,
      source: l.source,
      effective_from: l.effective_from,
      effective_to: l.effective_to,
    }),
  );
  return computeClock({
    events,
    links,
    baseWorkingDays: stage.working_days,
    tzByRegion: tzMap(ctx),
    calendar: dbCalendar(ctx),
    asOf: asOf ?? ctx.now(),
  });
}

/** 时点回放：仅包含 asOf 之前（含）的事件与责任链，重算当时时钟。 */
export function buildStageClockAt(ctx: Context, caseId: string, stageId: string, asOf: string): ClockSnapshot {
  const stage = getStage(ctx, stageId);
  if (stage.case_id !== caseId) throw new ServiceError("stage_case_mismatch", "阶段不属于该案件", 400);
  const events = toTimerEvents(listEvents(ctx, stageId)).filter((e) => Date.parse(e.occurred_at) <= Date.parse(asOf));
  const links = listLinks(ctx, caseId)
    .filter((l) => Date.parse(l.effective_from) <= Date.parse(asOf))
    .map(
      (l): ResponsibilitySegment => ({
        agency_code: l.agency_code,
        region_code: l.region_code,
        source: l.source,
        effective_from: l.effective_from,
        effective_to: l.effective_to,
      }),
    );
  return computeClock({
    events,
    links,
    baseWorkingDays: stage.working_days,
    tzByRegion: tzMap(ctx),
    calendar: dbCalendar(ctx),
    asOf,
  });
}

export { toTimerEvents };
