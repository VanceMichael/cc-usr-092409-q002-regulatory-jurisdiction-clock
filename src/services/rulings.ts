import type { Context, LinkRow, RulingRow } from "../db.js";
import { ServiceError } from "../db.js";
import { assertCanRule, getAgency } from "./catalog.js";
import { currentWatermark, getCase, requireActiveCase } from "./cases.js";
import { isoNow } from "./util.js";

export interface RuleJurisdictionInput {
  lead_agency: string;
  co_agencies?: string[];
  ruled_by: string;
  basis: string;
  idempotency_key: string;
}

export interface RuleResult {
  ruling: RulingRow;
  previous_link_closed: boolean;
  effective_at: string;
}

/**
 * 管辖裁定：
 *  1) 裁定人必须启用、获主办机构所在地区授权、对本案无利益冲突；
 *  2) 留存适用规则版本与证据水位；
 *  3) 原子切换责任链：关闭旧链、开启新链，同事务内完成（唯一有效链由库保证）。
 * 裁定只追加；同一 idempotency_key 重放返回原裁定。
 */
export function ruleJurisdiction(ctx: Context, caseId: string, input: RuleJurisdictionInput): RuleResult {
  const c = requireActiveCase(ctx, caseId);

  const existing = ctx.raw
    .prepare("SELECT * FROM jurisdiction_rulings WHERE case_id = ? AND idempotency_key = ?")
    .get(caseId, input.idempotency_key) as RulingRow | undefined;
  if (existing) return { ruling: existing, previous_link_closed: false, effective_at: existing.ruled_at };

  // 移交在途时责任链即将原子切换，禁止并发插入新裁定，保证只保留一条有效链。
  const inFlight = ctx.raw
    .prepare("SELECT 1 FROM transfers WHERE case_id = ? AND status IN ('proposed','frozen','received') LIMIT 1")
    .get(caseId);
  if (inFlight) throw new ServiceError("transfer_in_flight", "案件存在在途移交，管辖裁定须在移交完成或取消后进行", 409);

  // 在事务外先做权限/冲突校验，给出 403 而非约束错误。
  const { agency } = assertCanRule(ctx, caseId, input.ruled_by, input.lead_agency);
  const coAgencies = input.co_agencies ?? [];
  for (const co of coAgencies) {
    if (co === input.lead_agency) throw new ServiceError("bad_request", "协办机构不能与主办机构重复");
    getAgency(ctx, co);
  }
  if (new Set(coAgencies).size !== coAgencies.length) throw new ServiceError("bad_request", "协办机构不可重复");

  const now = isoNow(ctx);
  const watermark = currentWatermark(ctx, caseId);
  let rulingId = 0;
  let closedPrevious = false;

  const tx = ctx.raw.transaction(() => {
    const seqRow = ctx.raw.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM jurisdiction_rulings WHERE case_id = ?").get(caseId) as { n: number };
    const info = ctx.raw
      .prepare(
        `INSERT INTO jurisdiction_rulings(case_id, seq, lead_agency, co_agencies_json, ruled_by,
             evidence_watermark, rule_version, basis, ruled_at, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        caseId, seqRow.n, input.lead_agency, JSON.stringify(coAgencies), input.ruled_by,
        watermark, c.rule_version, input.basis, now, input.idempotency_key,
      );
    rulingId = Number(info.lastInsertRowid);

    // 关闭当前有效责任链（intake 或上一裁定/移交），开启新链。
    const current = ctx.raw
      .prepare("SELECT id FROM responsibility_links WHERE case_id = ? AND effective_to IS NULL")
      .get(caseId) as { id: number } | undefined;
    if (current) {
      ctx.raw.prepare("UPDATE responsibility_links SET effective_to = ? WHERE id = ?").run(now, current.id);
      closedPrevious = true;
    }
    const linkSeq = nextLinkSeq(ctx, caseId);
    ctx.raw
      .prepare(
        `INSERT INTO responsibility_links(case_id, seq, agency_code, region_code, source, source_ref, effective_from, effective_to)
         VALUES (?,?,?,?,'ruling',?,?,NULL)`,
      )
      .run(caseId, linkSeq, agency.agency_code, agency.region_code, String(rulingId), now);
  });

  try {
    tx.immediate();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      // 并发同键裁定：重放已提交的那一条。
      const row = ctx.raw
        .prepare("SELECT * FROM jurisdiction_rulings WHERE case_id = ? AND idempotency_key = ?")
        .get(caseId, input.idempotency_key) as RulingRow | undefined;
      if (row) return { ruling: row, previous_link_closed: false, effective_at: row.ruled_at };
      throw new ServiceError("ruling_conflict", "并发管辖裁定冲突，请重试", 409);
    }
    throw err;
  }

  const ruling = ctx.raw.prepare("SELECT * FROM jurisdiction_rulings WHERE id = ?").get(rulingId) as RulingRow;
  return { ruling, previous_link_closed: closedPrevious, effective_at: now };
}

export function listRulings(ctx: Context, caseId: string): RulingRow[] {
  getCase(ctx, caseId);
  return ctx.raw.prepare("SELECT * FROM jurisdiction_rulings WHERE case_id = ? ORDER BY seq").all(caseId) as RulingRow[];
}

export function listLinks(ctx: Context, caseId: string): LinkRow[] {
  getCase(ctx, caseId);
  return ctx.raw
    .prepare("SELECT * FROM responsibility_links WHERE case_id = ? ORDER BY seq")
    .all(caseId) as LinkRow[];
}

export function currentLink(ctx: Context, caseId: string, atIso?: string): LinkRow {
  const at = atIso ?? ctx.now();
  const row = ctx.raw
    .prepare(
      `SELECT * FROM responsibility_links
       WHERE case_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(caseId, at, at) as LinkRow | undefined;
  if (!row) throw new ServiceError("no_responsible_agency", `案件在 ${at} 没有负责机构`, 409);
  return row;
}

/** 时点回放：当时负责机构（不严格要求存在，供历史查询）。 */
export function linkAt(ctx: Context, caseId: string, atIso: string): LinkRow | null {
  const row = ctx.raw
    .prepare(
      `SELECT * FROM responsibility_links
       WHERE case_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(caseId, atIso, atIso) as LinkRow | undefined;
  return row ?? null;
}

export function nextLinkSeq(ctx: Context, caseId: string): number {
  return (ctx.raw.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM responsibility_links WHERE case_id = ?").get(caseId) as { n: number }).n;
}
