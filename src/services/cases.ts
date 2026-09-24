import type { Context, CaseRow, MaterialRow, PartyClaimRow } from "../db.js";
import { ServiceError } from "../db.js";
import { getAgency } from "./catalog.js";
import { isoNow, newId } from "./util.js";

// ---- 立案 -------------------------------------------------------------------

export interface OpenCaseInput {
  case_no: string;
  subject: string;
  consumer_region?: string;
  merchant_region?: string;
  transaction_region?: string;
  rule_version: string;
  intake_agency: string;
  opened_by: string;
  claims?: {
    party_role: "consumer" | "merchant" | "other";
    party_name: string;
    claimed_agency?: string;
    claimed_region?: string;
    statement: string;
  }[];
  stage_code: string; // 立案同时开启首个法定期限阶段
  working_days?: number; // 缺省取规则版本中该阶段配置
}

export function openCase(ctx: Context, input: OpenCaseInput) {
  const now = isoNow(ctx);
  const agency = getAgency(ctx, input.intake_agency);
  // 规则版本必须存在（payload 合法性由 createRuleVersion 保证）。
  const rule = ctx.raw.prepare("SELECT 1 FROM rule_versions WHERE version = ?").get(input.rule_version);
  if (!rule) throw new ServiceError("rule_version_not_found", `规则版本 ${input.rule_version} 不存在`, 404);

  let workingDays = input.working_days;
  if (workingDays === undefined) {
    const payloadRow = ctx.raw.prepare("SELECT payload_json FROM rule_versions WHERE version = ?").get(input.rule_version) as { payload_json: string };
    const payload = JSON.parse(payloadRow.payload_json) as { stage_working_days: Record<string, number> };
    workingDays = payload.stage_working_days[input.stage_code];
    if (!Number.isInteger(workingDays)) throw new ServiceError("stage_unknown", `规则 ${input.rule_version} 未定义阶段 ${input.stage_code}`);
  } else if (!Number.isInteger(workingDays) || workingDays <= 0) {
    throw new ServiceError("bad_working_days", "working_days 必须为正整数");
  }

  const caseId = newId();
  const stageId = newId();

  const tx = ctx.raw.transaction(() => {
    try {
      ctx.raw
        .prepare(
          `INSERT INTO cases(case_id, case_no, subject, consumer_region, merchant_region, transaction_region,
                              rule_version, status, opened_by, opened_at)
           VALUES (?,?,?,?,?,?,?, 'active', ?,?)`,
        )
        .run(
          caseId, input.case_no, input.subject, input.consumer_region ?? null, input.merchant_region ?? null,
          input.transaction_region ?? null, input.rule_version, input.opened_by, now,
        );
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) throw new ServiceError("case_no_exists", `案号 ${input.case_no} 已存在`, 409);
      throw err;
    }

    // 受理时的临时责任链：在首条管辖裁定生效前承担主办责任。
    ctx.raw
      .prepare(
        `INSERT INTO responsibility_links(id, case_id, seq, agency_code, region_code, source, source_ref, effective_from, effective_to)
         VALUES (NULL, ?, 0, ?, ?, 'intake', 'intake', ?, NULL)`,
      )
      .run(caseId, agency.agency_code, agency.region_code, now);

    ctx.raw
      .prepare(
        `INSERT INTO case_stages(stage_id, case_id, seq, stage_code, rule_version, working_days, opened_at)
         VALUES (?,?,0,?,?,?,?)`,
      )
      .run(stageId, caseId, input.stage_code, input.rule_version, workingDays, now);

    ctx.raw
      .prepare(
        `INSERT INTO deadline_events(id, case_id, stage_id, seq, type, occurred_at, actor, reason_code, legal_basis, payload_json)
         VALUES (NULL, ?, ?, 0, 'open', ?, ?, 'STAGE_OPEN', '立案受理', '{}')`,
      )
      .run(caseId, stageId, now, input.opened_by);

    if (input.claims) {
      for (const c of input.claims) {
        addClaim(ctx, caseId, { ...c, submitted_by: input.opened_by }, now);
      }
    }
  });
  tx.immediate();

  return { case_id: caseId, stage_id: stageId, opened_at: now, evidence_watermark: 0 };
}

export function addClaim(
  ctx: Context,
  caseId: string,
  claim: {
    party_role: "consumer" | "merchant" | "other";
    party_name: string;
    claimed_agency?: string;
    claimed_region?: string;
    statement: string;
    submitted_by: string;
  },
  at: string = isoNow(ctx),
): PartyClaimRow {
  requireActiveCase(ctx, caseId);
  const info = ctx.raw
    .prepare(
      `INSERT INTO party_claims(case_id, party_role, party_name, claimed_agency, claimed_region, statement, submitted_by, submitted_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      caseId, claim.party_role, claim.party_name, claim.claimed_agency ?? null,
      claim.claimed_region ?? null, claim.statement, claim.submitted_by, at,
    );
  return ctx.raw.prepare("SELECT * FROM party_claims WHERE id = ?").get(info.lastInsertRowid) as PartyClaimRow;
}

export function getCase(ctx: Context, caseId: string): CaseRow {
  const row = ctx.raw.prepare("SELECT * FROM cases WHERE case_id = ?").get(caseId);
  if (!row) throw new ServiceError("case_not_found", `案件 ${caseId} 不存在`, 404);
  return row as CaseRow;
}

export function requireActiveCase(ctx: Context, caseId: string): CaseRow {
  const c = getCase(ctx, caseId);
  if (c.status !== "active") throw new ServiceError("case_closed", `案件 ${caseId} 已关闭`, 409);
  return c;
}

export function listClaims(ctx: Context, caseId: string): PartyClaimRow[] {
  return ctx.raw.prepare("SELECT * FROM party_claims WHERE case_id = ? ORDER BY id").all(caseId) as PartyClaimRow[];
}

// ---- 证据仓 -----------------------------------------------------------------

export interface MaterialInput {
  material_key: string;
  title: string;
  kind?: string;
  payload?: unknown;
  checksum?: string;
  arrived_by: string;
  idempotency_key: string;
}

export interface MaterialResult {
  material: MaterialRow;
  duplicated: boolean;
  watermark: number;
}

/**
 * 材料到达：
 *  - 幂等：同案同 idempotency_key 直接返回已存行。
 *  - 若案件存在在途移交（frozen/received），材料进入待归属区，归属该移交；
 *    否则正常签收，水位 +1。
 */
export function receiveMaterial(ctx: Context, caseId: string, input: MaterialInput): MaterialResult {
  requireActiveCase(ctx, caseId);
  const existing = ctx.raw
    .prepare("SELECT * FROM case_materials WHERE case_id = ? AND idempotency_key = ?")
    .get(caseId, input.idempotency_key) as MaterialRow | undefined;
  if (existing) return { material: existing, duplicated: true, watermark: existing.seq };

  const now = isoNow(ctx);
  let materialId = 0;
  const tx = ctx.raw.transaction(() => {
    const pendingTransfer = ctx.raw
      .prepare("SELECT id FROM transfers WHERE case_id = ? AND status IN ('frozen','received') ORDER BY seq DESC LIMIT 1")
      .get(caseId) as { id: number } | undefined;

    let seq = 0;
    if (!pendingTransfer) {
      seq = (ctx.raw
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM case_materials WHERE case_id = ? AND seq > 0")
        .get(caseId) as { n: number }).n;
    }
    const info = ctx.raw
      .prepare(
        `INSERT INTO case_materials(case_id, seq, kind, material_key, title, payload_json, checksum, status,
                                     arrived_at, arrived_by, pending_transfer_id, arrived_during_transfer_id, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        caseId, seq, input.kind ?? "document", input.material_key, input.title,
        JSON.stringify(input.payload ?? {}), input.checksum ?? "",
        pendingTransfer ? "pending_attribution" : "received",
        now, input.arrived_by, pendingTransfer?.id ?? null, pendingTransfer?.id ?? null, input.idempotency_key,
      );
    materialId = Number(info.lastInsertRowid);
  });
  try {
    tx.immediate();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      const row = ctx.raw
        .prepare("SELECT * FROM case_materials WHERE case_id = ? AND idempotency_key = ?")
        .get(caseId, input.idempotency_key) as MaterialRow;
      return { material: row, duplicated: true, watermark: row.seq };
    }
    throw err;
  }
  const material = ctx.raw.prepare("SELECT * FROM case_materials WHERE id = ?").get(materialId) as MaterialRow;
  return { material, duplicated: false, watermark: material.seq };
}

export function currentWatermark(ctx: Context, caseId: string): number {
  return (ctx.raw
    .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM case_materials WHERE case_id = ? AND seq > 0")
    .get(caseId) as { n: number }).n;
}

export function listMaterials(ctx: Context, caseId: string): MaterialRow[] {
  return ctx.raw.prepare("SELECT * FROM case_materials WHERE case_id = ? ORDER BY id").all(caseId) as MaterialRow[];
}

/** 待归属材料：默认归给当前主办；也可拒绝。 */
export function attributePendingMaterial(
  ctx: Context,
  caseId: string,
  materialId: number,
  input: { attribute: boolean; attributed_by: string; note?: string },
): MaterialRow {
  requireActiveCase(ctx, caseId);
  const row = ctx.raw.prepare("SELECT * FROM case_materials WHERE id = ? AND case_id = ?").get(materialId, caseId) as MaterialRow | undefined;
  if (!row) throw new ServiceError("material_not_found", `材料 ${materialId} 不存在`, 404);
  if (row.status !== "pending_attribution") throw new ServiceError("material_not_pending", "该材料不在待归属区", 409);

  const now = isoNow(ctx);
  const tx = ctx.raw.transaction(() => {
    if (input.attribute) {
      const next = (ctx.raw
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM case_materials WHERE case_id = ? AND seq > 0")
        .get(caseId) as { n: number }).n;
      ctx.raw
        .prepare(
          `UPDATE case_materials SET status = 'attributed', seq = ?, attributed_at = ?, attributed_by = ?,
             attribution_note = ?, pending_transfer_id = NULL WHERE id = ?`,
        )
        .run(next, now, input.attributed_by, input.note ?? "", materialId);
    } else {
      ctx.raw
        .prepare(
          `UPDATE case_materials SET status = 'rejected', attributed_at = ?, attributed_by = ?,
             attribution_note = ? WHERE id = ?`,
        )
        .run(now, input.attributed_by, input.note ?? "拒收", materialId);
    }
  });
  tx.immediate();
  return ctx.raw.prepare("SELECT * FROM case_materials WHERE id = ?").get(materialId) as MaterialRow;
}

export function listPendingMaterials(ctx: Context, caseId: string): MaterialRow[] {
  return ctx.raw
    .prepare("SELECT * FROM case_materials WHERE case_id = ? AND status = 'pending_attribution' ORDER BY id")
    .all(caseId) as MaterialRow[];
}
