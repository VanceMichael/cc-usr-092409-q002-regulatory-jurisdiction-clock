import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestContext, type Context } from "../src/db.js";
import * as catalog from "../src/services/catalog.js";

let counter = 0;

export function freshContext(fixedNow = "2026-09-21T00:00:00Z"): Context {
  const dir = mkdtempSync(join(tmpdir(), "juris-ledger-"));
  return createTestContext(join(dir, `test-${++counter}.sqlite3`), fixedNow);
}

export interface Fixture {
  ctx: Context;
  regions: { cn: string; xj: string };
  agencies: { cn: string; xj: string };
  people: { cn: string; xj: string; unauthorized: string; conflicted: string };
  rules: { v1: string; v2: string };
}

/**
 * 标准环境：
 *  - CN（Asia/Shanghai）2026-09-24 周四休、2026-09-26 周六上班；
 *  - XJ（Asia/Urumqi）另一机构；
 *  - 人员：p_cn 授权 CN、p_xj 授权 XJ、p_nogrant 无授权、p_conflict 有授权但可登记冲突；
 *  - 规则：v1 审查 5 个工作日、紧急延长上限 3 天；v2 为换版（7 天）。
 */
export function seedFixture(ctx: Context): Fixture {
  catalog.createRegion(ctx, { code: "CN", display_name: "内地", iana_timezone: "Asia/Shanghai" });
  catalog.createRegion(ctx, { code: "XJ", display_name: "新疆", iana_timezone: "Asia/Urumqi" });
  catalog.upsertCalendarDay(ctx, { region_code: "CN", day: "2026-09-24", kind: "nonworking", note: "中秋假" });
  catalog.upsertCalendarDay(ctx, { region_code: "CN", day: "2026-09-26", kind: "working", note: "调休上班" });

  catalog.createAgency(ctx, { agency_code: "A_CN", region_code: "CN", display_name: "内地受理局" });
  catalog.createAgency(ctx, { agency_code: "A_XJ", region_code: "XJ", display_name: "新疆协办局" });

  catalog.createPerson(ctx, { person_id: "p_cn", agency_code: "A_CN", display_name: "张三" });
  catalog.createPerson(ctx, { person_id: "p_xj", agency_code: "A_XJ", display_name: "古丽" });
  catalog.createPerson(ctx, { person_id: "p_nogrant", agency_code: "A_CN", display_name: "无授权员" });
  catalog.createPerson(ctx, { person_id: "p_conflict", agency_code: "A_CN", display_name: "有冲突员" });
  catalog.grantRegion(ctx, { person_id: "p_cn", region_code: "CN" });
  catalog.grantRegion(ctx, { person_id: "p_xj", region_code: "XJ" });
  catalog.grantRegion(ctx, { person_id: "p_conflict", region_code: "CN" });

  catalog.createRuleVersion(ctx, {
    version: "v2026.1",
    title: "消费投诉处理办法（旧版）",
    payload: { stage_working_days: { review: 5 }, emergency_extension_max_days: 3 },
  });
  catalog.createRuleVersion(ctx, {
    version: "v2026.2",
    title: "消费投诉处理办法（新版）",
    payload: { stage_working_days: { review: 7 }, emergency_extension_max_days: 5 },
  });

  return {
    ctx,
    regions: { cn: "CN", xj: "XJ" },
    agencies: { cn: "A_CN", xj: "A_XJ" },
    people: { cn: "p_cn", xj: "p_xj", unauthorized: "p_nogrant", conflicted: "p_conflict" },
    rules: { v1: "v2026.1", v2: "v2026.2" },
  };
}

export { openCase as openStandardCase } from "../src/services/cases.js";
