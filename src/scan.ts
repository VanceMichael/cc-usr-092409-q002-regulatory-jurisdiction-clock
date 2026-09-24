import { randomUUID } from "node:crypto";
import { computeCaseLedger } from "./caseLedger.js";
import type { AppDatabase, WriteTx } from "./database.js";

export interface ScanResult {
  scanned: number;
  notified: number;
  notifications: {
    notification_id: string;
    case_id: string;
    kind: string;
    dedupe_key: string;
  }[];
}

/**
 * 到期扫描：对所有在办案件重算期限账本，达到催办阈值的写入持久通知。
 * dedupe_key 按 案件+阶段+主办责任段+类型 去重——进程重启后重复扫描不会产生
 * 重复催办，而移交形成新责任段或进入新阶段后会对新主办重新提醒，避免漏办。
 */
export async function runDeadlineScan(
  db: AppDatabase,
  now: Date,
  writeTx: WriteTx,
): Promise<ScanResult> {
  const at = now.toISOString();
  const openCases = await db
    .selectFrom("cases")
    .selectAll()
    .where("status", "=", "open")
    .execute();

  const created: ScanResult["notifications"] = [];
  for (const caseRow of openCases) {
    const openLead = await db
      .selectFrom("case_responsibility")
      .selectAll()
      .where("case_id", "=", caseRow.case_id)
      .where("role", "=", "lead")
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (!openLead) continue; // 管辖尚未确认，无人可催

    const view = await computeCaseLedger(db, caseRow, at);
    if (view.clock.state !== "running") continue; // 暂停期间时限不前进，不催办

    const ruleSet = await db
      .selectFrom("rule_sets")
      .selectAll()
      .where("version", "=", view.clock.ruleSetVersion)
      .executeTakeFirstOrThrow();

    const remaining = view.clock.remainingWorkdays;
    let kind: "due_soon" | "overdue" | null = null;
    if (remaining < 0) kind = "overdue";
    else if (remaining <= ruleSet.reminder_threshold_days) kind = "due_soon";
    if (!kind) continue;

    const dedupeKey = `${caseRow.case_id}:stage${view.stage}:lead${openLead.id}:${kind}`;
    const basis = {
      computed_at: at,
      stage: view.stage,
      rule_set_version: view.clock.ruleSetVersion,
      statutory_days: view.clock.statutoryDays,
      extension_days: view.clock.extensionDays,
      limit_days: view.clock.limitDays,
      consumed_workdays: view.clock.consumedWorkdays,
      remaining_workdays: view.clock.remainingWorkdays,
      projected_deadline: view.clock.projectedDeadline,
      excluded_periods: view.clock.excludedPeriods,
      calendar_region: view.responsible.leadRegion,
      lead_agency: view.responsible.leadAgency,
    };
    const notificationId = randomUUID();
    const result = await writeTx((trx) =>
      trx
        .insertInto("notifications")
        .values({
          notification_id: notificationId,
          case_id: caseRow.case_id,
          kind,
          dedupe_key: dedupeKey,
          lead_agency: view.responsible.leadAgency ?? "",
          basis: JSON.stringify(basis),
          created_at: at,
          delivered: 0,
        })
        .onConflict((oc) => oc.column("dedupe_key").doNothing())
        .executeTakeFirst(),
    );
    if (result.numInsertedOrUpdatedRows === 1n) {
      created.push({
        notification_id: notificationId,
        case_id: caseRow.case_id,
        kind,
        dedupe_key: dedupeKey,
      });
    }
  }
  return { scanned: openCases.length, notified: created.length, notifications: created };
}
