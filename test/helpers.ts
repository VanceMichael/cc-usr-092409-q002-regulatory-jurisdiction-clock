import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildAppOptions } from "../src/app.js";

export function freshDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "dispute-ledger-")), "test.sqlite3");
}

export function freshApp(options: BuildAppOptions = {}, databasePath?: string) {
  process.env.DATABASE_PATH = databasePath ?? freshDatabasePath();
  return buildApp({ scanIntervalMs: 0, ...options });
}

export const ALL_PERMISSIONS = [
  "jurisdiction.confirm",
  "event.append",
  "rule.update",
  "decision.issue",
  "transfer.initiate",
  "transfer.sign",
  "material.file",
];

/** 登记规则版本、两地机构与操作人员。 */
export async function seedBasics(app: ReturnType<typeof buildApp>) {
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });
  await post("/rule-sets", {
    version: "v2026.1",
    statutory_days: 10,
    max_extension_days: 5,
    reminder_threshold_days: 3,
    supplement_pause_basis: "补正期间不计入办理期限（规则v2026.1第12条）",
    external_wait_basis: "等待司法裁决期间不计入办理期限（规则v2026.1第13条）",
  });
  await post("/agencies", { agency_id: "ag-sh", display_name: "上海市监局", region: "SH" });
  await post("/agencies", { agency_id: "ag-zj", display_name: "浙江省监局", region: "ZJ" });
  await post("/staff", {
    staff_id: "st-admin",
    display_name: "综合管理员",
    agency_id: "ag-sh",
    permissions: ALL_PERMISSIONS,
    conflict_regions: [],
  });
  await post("/staff", {
    staff_id: "st-zj",
    display_name: "浙江经办",
    agency_id: "ag-zj",
    permissions: ALL_PERMISSIONS,
    conflict_regions: [],
  });
}

export async function createCase(
  app: ReturnType<typeof buildApp>,
  overrides: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: "/cases",
    payload: {
      case_id: "case-1",
      title: "跨省网购退货纠纷",
      consumer_region: "SH",
      merchant_region: "ZJ",
      transaction_region: "ZJ",
      rule_set_version: "v2026.1",
      evidence_watermark: "evt-100",
      accepted_at: "2026-09-01T02:00:00.000Z",
      claims: [
        { party_role: "consumer", content: "要求退货退款并赔偿" },
        { party_role: "merchant", content: "商品无质量问题，拒绝退货" },
      ],
      ...overrides,
    },
  });
  return response;
}

/** 受理 + 管辖确认（主办 ag-sh，协办 ag-zj）。 */
export async function createConfirmedCase(app: ReturnType<typeof buildApp>) {
  await createCase(app);
  const response = await app.inject({
    method: "POST",
    url: "/cases/case-1/jurisdiction",
    payload: {
      staff_id: "st-admin",
      lead_agency: "ag-sh",
      co_agencies: ["ag-zj"],
      decided_at: "2026-09-01T06:00:00.000Z",
    },
  });
  return response;
}
