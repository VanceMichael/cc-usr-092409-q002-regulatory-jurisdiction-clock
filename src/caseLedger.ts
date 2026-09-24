import { workdayRuleFromOverrides, type WorkdayRule } from "./calendar.js";
import type { DbExecutor } from "./database.js";
import { notFound } from "./errors.js";
import { computeLedger, type LedgerComputation, type ResponsibilitySpan } from "./ledger.js";

export type CaseRow = Awaited<ReturnType<typeof loadCaseOrThrow>>;

export async function loadCaseOrThrow(db: DbExecutor, caseId: string) {
  const row = await db
    .selectFrom("cases")
    .selectAll()
    .where("case_id", "=", caseId)
    .executeTakeFirst();
  if (!row) throw notFound("CASE_NOT_FOUND", `案件 ${caseId} 不存在`);
  return row;
}

/** 时钟事件按 (occurred_at, seq) 升序；传入 at 时只取该时点前已发生的事件。 */
export async function loadEvents(db: DbExecutor, caseId: string, at?: string) {
  let query = db
    .selectFrom("clock_events")
    .selectAll()
    .where("case_id", "=", caseId)
    .orderBy("occurred_at", "asc")
    .orderBy("seq", "asc");
  if (at) query = query.where("occurred_at", "<=", at);
  return query.execute();
}

/** 主办责任段（含机构地区），按开始时间升序。 */
export async function loadLeadSpans(db: DbExecutor, caseId: string): Promise<ResponsibilitySpan[]> {
  const rows = await db
    .selectFrom("case_responsibility")
    .innerJoin("agencies", "agencies.agency_id", "case_responsibility.agency_id")
    .select([
      "case_responsibility.agency_id as agencyId",
      "agencies.region as region",
      "case_responsibility.started_at as startedAt",
      "case_responsibility.ended_at as endedAt",
    ])
    .where("case_responsibility.case_id", "=", caseId)
    .where("case_responsibility.role", "=", "lead")
    .orderBy("case_responsibility.started_at", "asc")
    .orderBy("case_responsibility.seq", "asc")
    .execute();
  return rows;
}

export async function loadWorkdayRule(db: DbExecutor, regions: string[]): Promise<WorkdayRule> {
  if (regions.length === 0) return workdayRuleFromOverrides(new Map());
  const rows = await db
    .selectFrom("workday_calendar")
    .selectAll()
    .where("region", "in", regions)
    .execute();
  const overrides = new Map<string, boolean>(
    rows.map((row) => [`${row.region}:${row.day}`, row.is_workday === 1]),
  );
  return workdayRuleFromOverrides(overrides);
}

export interface StageSnapshot {
  at: string;
  stage: number;
  responsible: {
    leadAgency: string | null;
    leadRegion: string | null;
    leadSince: string | null;
    coAgencies: string[];
  };
  clock: LedgerComputation;
}

/** API 响应统一 snake_case；内部计算结构经此序列化后再返回。 */
export function serializeClock(clock: LedgerComputation) {
  return {
    state: clock.state,
    rule_set_version: clock.ruleSetVersion,
    statutory_days: clock.statutoryDays,
    extension_days: clock.extensionDays,
    limit_days: clock.limitDays,
    consumed_workdays: clock.consumedWorkdays,
    remaining_workdays: clock.remainingWorkdays,
    overdue: clock.overdue,
    projected_deadline: clock.projectedDeadline,
    excluded_periods: clock.excludedPeriods,
    extensions: clock.extensions,
  };
}

export function serializeResponsible(responsible: StageSnapshot["responsible"]) {
  return {
    lead_agency: responsible.leadAgency,
    lead_region: responsible.leadRegion,
    lead_since: responsible.leadSince,
    co_agencies: responsible.coAgencies,
  };
}

export function serializeSnapshot(snapshot: StageSnapshot) {
  return {
    at: snapshot.at,
    stage: snapshot.stage,
    responsible: serializeResponsible(snapshot.responsible),
    clock: serializeClock(snapshot.clock),
  };
}

export interface CaseLedgerView {
  at: string;
  stage: number;
  stageLocked: boolean;
  lockedSnapshot: StageSnapshot | null;
  responsible: {
    leadAgency: string | null;
    leadRegion: string | null;
    leadSince: string | null;
    coAgencies: string[];
  };
  clock: LedgerComputation;
}

/** 计算案件在指定时点的期限账本视图；历史时点只取当时已发生的事件与当时生效的规则版本。 */
export async function computeCaseLedger(
  db: DbExecutor,
  caseRow: {
    case_id: string;
    accepted_at: string;
    transaction_region: string;
    current_stage: number;
  },
  at: string,
): Promise<CaseLedgerView> {
  const events = await loadEvents(db, caseRow.case_id, at);
  const versionInForce =
    events.length > 0 ? events[events.length - 1].rule_set_version : null;
  if (!versionInForce) {
    throw notFound("CASE_NOT_FOUND", `案件 ${caseRow.case_id} 在 ${at} 尚无时钟事件`);
  }
  const ruleSet = await db
    .selectFrom("rule_sets")
    .selectAll()
    .where("version", "=", versionInForce)
    .executeTakeFirstOrThrow();

  const spans = await loadLeadSpans(db, caseRow.case_id);
  const regions = [...new Set([...spans.map((span) => span.region), caseRow.transaction_region])];
  const isWorkday = await loadWorkdayRule(db, regions);

  const clock = computeLedger({
    acceptedAt: caseRow.accepted_at,
    events: events.map((event) => ({
      eventType: event.event_type,
      occurredAt: event.occurred_at,
      payload: JSON.parse(event.payload) as Record<string, unknown>,
    })),
    ruleSetVersion: ruleSet.version,
    statutoryDays: ruleSet.statutory_days,
    responsibility: spans,
    fallbackRegion: caseRow.transaction_region,
    isWorkday,
    at,
  });

  const decisions = await db
    .selectFrom("stage_decisions")
    .selectAll()
    .where("case_id", "=", caseRow.case_id)
    .orderBy("stage", "asc")
    .execute();
  const stage = 1 + decisions.filter((decision) => decision.issued_at <= at).length;
  const locked = decisions.find((decision) => decision.stage === stage);

  const leadAt = spans.find(
    (span) => span.startedAt <= at && (span.endedAt === null || span.endedAt > at),
  );
  const jurisdiction = await db
    .selectFrom("jurisdiction_decisions")
    .selectAll()
    .where("case_id", "=", caseRow.case_id)
    .executeTakeFirst();

  return {
    at,
    stage,
    stageLocked: locked !== undefined,
    lockedSnapshot: locked ? (JSON.parse(locked.snapshot) as StageSnapshot) : null,
    responsible: {
      leadAgency: leadAt?.agencyId ?? null,
      leadRegion: leadAt?.region ?? null,
      leadSince: leadAt?.startedAt ?? null,
      coAgencies: jurisdiction ? (JSON.parse(jurisdiction.co_agencies) as string[]) : [],
    },
    clock,
  };
}

export interface UnsignedMaterialView {
  material_id: string;
  label: string;
  content_hash: string;
  received_at: string;
  state: "in_transit" | "pending_attribution";
  transfer_id: string | null;
  manifest_version: number | null;
}

/**
 * 指定时点仍未签收的材料：在途移交清单内尚未被接收方签收的，
 * 以及移交途中到达、仍待在归属区的材料。
 */
export async function unsignedMaterialsAt(
  db: DbExecutor,
  caseId: string,
  at: string,
): Promise<UnsignedMaterialView[]> {
  const materials = await db
    .selectFrom("materials")
    .selectAll()
    .where("case_id", "=", caseId)
    .where("received_at", "<=", at)
    .orderBy("received_at", "asc")
    .execute();
  const transfers = await db
    .selectFrom("transfers")
    .selectAll()
    .where("case_id", "=", caseId)
    .where("frozen_at", "<=", at)
    .orderBy("manifest_version", "asc")
    .execute();

  const result: UnsignedMaterialView[] = [];
  for (const material of materials) {
    if (material.state === "pending_attribution") {
      if (material.attributed_at === null || material.attributed_at > at) {
        result.push({
          material_id: material.material_id,
          label: material.label,
          content_hash: material.content_hash,
          received_at: material.received_at,
          state: "pending_attribution",
          transfer_id: null,
          manifest_version: null,
        });
      }
      continue;
    }
    // 该材料在时点前进入过的最近一份冻结清单决定其签收状态。
    const covering = transfers
      .filter((transfer) =>
        (JSON.parse(transfer.manifest) as { material_id: string }[]).some(
          (item) => item.material_id === material.material_id,
        ),
      )
      .at(-1);
    if (!covering) continue; // 一直在卷，已签收
    const signedAt =
      covering.state === "effective" && covering.effective_at !== null && covering.effective_at <= at
        ? covering.effective_at
        : null;
    const backToFiled =
      covering.state === "cancelled" && covering.cancelled_at !== null && covering.cancelled_at <= at;
    if (!signedAt && !backToFiled) {
      result.push({
        material_id: material.material_id,
        label: material.label,
        content_hash: material.content_hash,
        received_at: material.received_at,
        state: "in_transit",
        transfer_id: covering.transfer_id,
        manifest_version: covering.manifest_version,
      });
    }
  }
  return result;
}
