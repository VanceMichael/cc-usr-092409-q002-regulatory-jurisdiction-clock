import { randomUUID } from "node:crypto";
import type { DbExecutor } from "./database.js";
import { conflict } from "./errors.js";
import { buildPausePeriods, type LedgerEventInput } from "./ledger.js";

/** 允许通过接口追加的事件类型（其余类型由系统内部产生）。 */
export const APPENDABLE_EVENT_TYPES = new Set([
  "supplement_requested",
  "supplement_received",
  "external_wait_started",
  "external_wait_ended",
  "resumed",
  "emergency_extension",
]);

export interface ClockEventRow {
  event_id: string;
  case_id: string;
  stage: number;
  seq: number;
  event_type: string;
  occurred_at: string;
  rule_set_version: string;
  payload: string;
  recorded_by: string | null;
  recorded_at: string;
}

export async function loadCaseEvents(db: DbExecutor, caseId: string): Promise<ClockEventRow[]> {
  return db
    .selectFrom("clock_events")
    .selectAll()
    .where("case_id", "=", caseId)
    .orderBy("occurred_at", "asc")
    .orderBy("seq", "asc")
    .execute() as Promise<ClockEventRow[]>;
}

export function toLedgerInputs(events: ClockEventRow[]): LedgerEventInput[] {
  return events.map((event) => ({
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    payload: JSON.parse(event.payload) as Record<string, unknown>,
  }));
}

/** 当前是否有未结束的暂停段。 */
export function openPauseReason(events: ClockEventRow[]): "supplement" | "external_wait" | null {
  const periods = buildPausePeriods(toLedgerInputs(events));
  const last = periods.at(-1);
  return last && last.to === null ? last.reason : null;
}

/**
 * 追加时钟事件：校验事件序列单调、不回填已出具决定的阶段，
 * 并按暂停状态机校验事件类型是否合法。
 */
export async function appendClockEvent(
  db: DbExecutor,
  opts: {
    caseId: string;
    stage: number;
    eventType: string;
    occurredAt: string;
    ruleSetVersion: string;
    payload: Record<string, unknown>;
    recordedBy: string | null;
  },
): Promise<ClockEventRow> {
  const events = await loadCaseEvents(db, opts.caseId);
  const last = events.at(-1);
  if (last && opts.occurredAt < last.occurred_at) {
    throw conflict(
      "EVENT_OUT_OF_ORDER",
      `事件时间 ${opts.occurredAt} 早于已有事件 ${last.occurred_at}，时钟事件不可回填乱序`,
    );
  }
  const lastDecision = await db
    .selectFrom("stage_decisions")
    .select("issued_at")
    .where("case_id", "=", opts.caseId)
    .orderBy("issued_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (lastDecision && opts.occurredAt < lastDecision.issued_at) {
    throw conflict(
      "STAGE_LOCKED",
      `阶段已出具决定（${lastDecision.issued_at}），不允许向该阶段回填事件`,
    );
  }

  const pause = openPauseReason(events);
  switch (opts.eventType) {
    case "supplement_requested":
    case "external_wait_started":
      if (pause) {
        throw conflict("PAUSE_ALREADY_OPEN", `当前处于${pause === "supplement" ? "补正" : "等待外部裁决"}暂停中，请先恢复办理`);
      }
      break;
    case "supplement_received":
      if (pause !== "supplement") {
        throw conflict("NO_MATCHING_PAUSE", "当前没有进行中的补正暂停");
      }
      break;
    case "external_wait_ended":
      if (pause !== "external_wait") {
        throw conflict("NO_MATCHING_PAUSE", "当前没有进行中的等待外部裁决暂停");
      }
      break;
    case "resumed":
      if (!pause) {
        throw conflict("NO_MATCHING_PAUSE", "当前没有进行中的暂停，无需恢复办理");
      }
      break;
    default:
      break;
  }

  const seq = (last?.seq ?? 0) + 1;
  const row: ClockEventRow = {
    event_id: randomUUID(),
    case_id: opts.caseId,
    stage: opts.stage,
    seq,
    event_type: opts.eventType,
    occurred_at: opts.occurredAt,
    rule_set_version: opts.ruleSetVersion,
    payload: JSON.stringify(opts.payload),
    recorded_by: opts.recordedBy,
    recorded_at: new Date().toISOString(),
  };
  await db.insertInto("clock_events").values(row).execute();
  return row;
}
