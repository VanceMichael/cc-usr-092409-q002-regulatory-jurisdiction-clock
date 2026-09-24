import type { Context, RulePayload } from "../db.js";
import { ServiceError } from "../db.js";
import { isoNow, newId } from "./util.js";

// ---- 地区与日历 -------------------------------------------------------------

export function createRegion(ctx: Context, input: { code: string; display_name: string; iana_timezone: string }) {
  validateTimeZone(input.iana_timezone);
  try {
    ctx.raw
      .prepare("INSERT INTO regions(code, display_name, iana_timezone, created_at) VALUES (?,?,?,?)")
      .run(input.code, input.display_name, input.iana_timezone, isoNow(ctx));
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new ServiceError("region_exists", `地区 ${input.code} 已存在`, 409);
    throw err;
  }
  return getRegion(ctx, input.code);
}

export function getRegion(ctx: Context, code: string) {
  const row = ctx.raw.prepare("SELECT * FROM regions WHERE code = ?").get(code);
  if (!row) throw new ServiceError("region_not_found", `地区 ${code} 不存在`, 404);
  return row;
}

export function validateTimeZone(tz: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new ServiceError("bad_timezone", `非法 IANA 时区: ${tz}`);
  }
}

/** 逐日覆盖工作日历（节假日 kind=nonworking，调休上班 kind=working）。 */
export function upsertCalendarDay(
  ctx: Context,
  input: { region_code: string; day: string; kind: "working" | "nonworking"; note?: string },
) {
  getRegion(ctx, input.region_code);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new ServiceError("bad_day", "日期必须为 YYYY-MM-DD");
  ctx.raw
    .prepare(
      `INSERT INTO calendar_days(region_code, day, kind, note) VALUES (?,?,?,?)
       ON CONFLICT(region_code, day) DO UPDATE SET kind = excluded.kind, note = excluded.note`,
    )
    .run(input.region_code, input.day, input.kind, input.note ?? "");
  return ctx.raw.prepare("SELECT * FROM calendar_days WHERE region_code = ? AND day = ?").get(input.region_code, input.day);
}

/** 默认周一至周五，calendar_days 逐日覆盖。 */
export function isWorkingDay(ctx: Context, regionCode: string, localDay: string): boolean {
  const override = ctx.raw
    .prepare("SELECT kind FROM calendar_days WHERE region_code = ? AND day = ?")
    .get(regionCode, localDay) as { kind: string } | undefined;
  if (override) return override.kind === "working";
  const weekday = new Date(`${localDay}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function timezoneMap(ctx: Context): Map<string, string> {
  const rows = ctx.raw.prepare("SELECT code, iana_timezone FROM regions").all() as { code: string; iana_timezone: string }[];
  return new Map(rows.map((r) => [r.code, r.iana_timezone]));
}

// ---- 机构与人员 -------------------------------------------------------------

export function createAgency(ctx: Context, input: { agency_code: string; region_code: string; display_name: string }) {
  getRegion(ctx, input.region_code);
  try {
    ctx.raw
      .prepare("INSERT INTO agencies(agency_code, region_code, display_name, created_at) VALUES (?,?,?,?)")
      .run(input.agency_code, input.region_code, input.display_name, isoNow(ctx));
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new ServiceError("agency_exists", `机构 ${input.agency_code} 已存在`, 409);
    if (/FOREIGN KEY/.test((err as Error).message ?? "")) throw new ServiceError("region_not_found", `地区 ${input.region_code} 不存在`, 404);
    throw err;
  }
  return getAgency(ctx, input.agency_code);
}

export function getAgency(ctx: Context, code: string) {
  const row = ctx.raw.prepare("SELECT * FROM agencies WHERE agency_code = ?").get(code);
  if (!row) throw new ServiceError("agency_not_found", `机构 ${code} 不存在`, 404);
  return row as { agency_code: string; region_code: string; display_name: string };
}

export function createPerson(ctx: Context, input: { person_id: string; agency_code: string; display_name: string }) {
  getAgency(ctx, input.agency_code);
  try {
    ctx.raw
      .prepare("INSERT INTO personnel(person_id, agency_code, display_name, active, created_at) VALUES (?,?,?,1,?)")
      .run(input.person_id, input.agency_code, input.display_name, isoNow(ctx));
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new ServiceError("person_exists", `人员 ${input.person_id} 已存在`, 409);
    throw err;
  }
  return getPerson(ctx, input.person_id);
}

export function getPerson(ctx: Context, personId: string) {
  const row = ctx.raw.prepare("SELECT * FROM personnel WHERE person_id = ?").get(personId);
  if (!row) throw new ServiceError("person_not_found", `人员 ${personId} 不存在`, 404);
  return row as { person_id: string; agency_code: string; display_name: string; active: number };
}

export function grantRegion(ctx: Context, input: { person_id: string; region_code: string }) {
  getPerson(ctx, input.person_id);
  getRegion(ctx, input.region_code);
  ctx.raw
    .prepare("INSERT OR IGNORE INTO personnel_region_grants(person_id, region_code, granted_at) VALUES (?,?,?)")
    .run(input.person_id, input.region_code, isoNow(ctx));
  return listGrants(ctx, input.person_id);
}

export function listGrants(ctx: Context, personId: string): string[] {
  const rows = ctx.raw
    .prepare("SELECT region_code FROM personnel_region_grants WHERE person_id = ? ORDER BY region_code")
    .all(personId) as { region_code: string }[];
  return rows.map((r) => r.region_code);
}

export function declareConflict(ctx: Context, input: { case_id: string; person_id: string; reason: string; declared_by: string }) {
  getPerson(ctx, input.person_id);
  try {
    ctx.raw
      .prepare(
        `INSERT INTO case_conflicts(case_id, person_id, reason, declared_by, declared_at) VALUES (?,?,?,?,?)`,
      )
      .run(input.case_id, input.person_id, input.reason, input.declared_by, isoNow(ctx));
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new ServiceError("conflict_declared", "该人员利益冲突已声明，无需重复", 409);
    if (err instanceof Error && /FOREIGN KEY/.test(err.message)) throw new ServiceError("case_not_found", `案件 ${input.case_id} 不存在`, 404);
    throw err;
  }
  return { case_id: input.case_id, person_id: input.person_id };
}

export function hasConflict(ctx: Context, caseId: string, personId: string): { conflict: boolean; reason: string | null } {
  const row = ctx.raw
    .prepare("SELECT reason FROM case_conflicts WHERE case_id = ? AND person_id = ?")
    .get(caseId, personId) as { reason: string } | undefined;
  return { conflict: Boolean(row), reason: row?.reason ?? null };
}

/** 管辖裁定准入：启用人员 + 对主办机构所在地区获授权 + 无利益冲突。 */
export function assertCanRule(ctx: Context, caseId: string, personId: string, leadAgency: string) {
  const person = getPerson(ctx, personId);
  if (!person.active) throw new ServiceError("person_inactive", `人员 ${personId} 已停用`, 403);
  const agency = getAgency(ctx, leadAgency);
  const grant = ctx.raw
    .prepare("SELECT 1 FROM personnel_region_grants WHERE person_id = ? AND region_code = ?")
    .get(personId, agency.region_code);
  if (!grant) {
    throw new ServiceError(
      "jurisdiction_not_authorized",
      `人员 ${personId} 未获 ${agency.region_code} 地区管辖授权，不能确认主办机构 ${leadAgency}`,
      403,
    );
  }
  const conflict = hasConflict(ctx, caseId, personId);
  if (conflict.conflict) {
    throw new ServiceError("conflict_of_interest", `人员 ${personId} 对本案存在利益冲突：${conflict.reason}`, 403);
  }
  return { person, agency };
}

// ---- 规则版本 ---------------------------------------------------------------

export function createRuleVersion(ctx: Context, input: { version: string; title: string; payload: RulePayload }) {
  validateRulePayload(input.payload);
  try {
    ctx.raw
      .prepare(
        `INSERT INTO rule_versions(version, title, status, payload_json, published_at, created_at)
         VALUES (?,?,'effective',?,?,?)`,
      )
      .run(input.version, input.title, JSON.stringify(input.payload), isoNow(ctx), isoNow(ctx));
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new ServiceError("rule_version_exists", `规则版本 ${input.version} 已存在`, 409);
    throw err;
  }
  return getRuleVersion(ctx, input.version);
}

export function validateRulePayload(payload: RulePayload) {
  if (!payload || typeof payload !== "object" || !payload.stage_working_days || typeof payload.stage_working_days !== "object") {
    throw new ServiceError("bad_rule_payload", "payload.stage_working_days 必须是阶段码到工作日的映射");
  }
  for (const [stage, days] of Object.entries(payload.stage_working_days)) {
    if (!Number.isInteger(days) || days <= 0) throw new ServiceError("bad_rule_payload", `阶段 ${stage} 的工作日必须是正整数`);
  }
  if (!Number.isInteger(payload.emergency_extension_max_days) || payload.emergency_extension_max_days < 0) {
    throw new ServiceError("bad_rule_payload", "emergency_extension_max_days 必须是非负整数");
  }
}

export function getRuleVersion(ctx: Context, version: string) {
  const row = ctx.raw.prepare("SELECT * FROM rule_versions WHERE version = ?").get(version);
  if (!row) throw new ServiceError("rule_version_not_found", `规则版本 ${version} 不存在`, 404);
  return row as {
    version: string;
    title: string;
    status: string;
    payload_json: string;
    published_at: string | null;
  };
}

export function getRulePayload(ctx: Context, version: string): RulePayload {
  const row = getRuleVersion(ctx, version);
  return JSON.parse(row.payload_json) as RulePayload;
}

export function effectiveWorkingDays(payload: RulePayload, stageCode: string): number {
  const days = payload.stage_working_days[stageCode];
  if (!Number.isInteger(days)) throw new ServiceError("stage_unknown", `规则未定义阶段 ${stageCode} 的法定期限`);
  return days;
}

export { newId };
