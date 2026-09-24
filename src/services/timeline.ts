import type { Context, DeadlineEventRow, DecisionRow, MaterialRow, RulingRow, StageRow, TransferRow } from "../db.js";
import { ServiceError } from "../db.js";
import { getCase, listClaims, listMaterials } from "./cases.js";
import { listLinks, listRulings, linkAt } from "./rulings.js";
import { listStages, listEvents, buildStageClockAt, listDecisions } from "./ledger.js";
import { listTransfers, listReceipts, manifestOf } from "./transfers.js";
import { listNotifications } from "./notifications.js";

/**
 * 任一时点视图：监管人员给定 asOf，可看到
 *  - 当时负责机构（责任链时点回放）；
 *  - 当时各阶段剩余时限、被排除的时间段（暂停依据）；
 *  - 截至当时未签收（待归属）材料；
 *  - 每次催办/扫描通知及其实际依据。
 * 全程只读取追加账本，不修改任何状态。
 */
export function caseTimeline(ctx: Context, caseId: string, asOf?: string) {
  const at = asOf ?? ctx.now();
  if (Number.isNaN(Date.parse(at))) throw new ServiceError("bad_timestamp", "as_of 非法时间戳");
  const c = getCase(ctx, caseId);
  if (Date.parse(c.opened_at) > Date.parse(at)) {
    throw new ServiceError("as_of_before_open", `案件尚未在 ${at} 立案`, 404);
  }

  const link = linkAt(ctx, caseId, at);
  const claims = listClaims(ctx, caseId).filter((x) => Date.parse(x.submitted_at) <= Date.parse(at));
  const allMaterials = listMaterials(ctx, caseId).filter((m) => Date.parse(m.arrived_at) <= Date.parse(at));
  const transfersAll = listTransfers(ctx, caseId);
  const atMs = Date.parse(at);

  // 截至 asOf 仍未签收（未归属）的材料：
  // 已到达且未被认领；若其在途移交已取消，则取消后已恢复为原机构签收，不再计入。
  const unsignedMaterials = allMaterials
    .filter((m) => m.attributed_at === null || Date.parse(m.attributed_at) > atMs)
    .filter((m) => {
      if (!m.arrived_during_transfer_id) return m.status === "pending_attribution";
      const t = transfersAll.find((x) => x.id === m.arrived_during_transfer_id);
      if (t?.cancelled_at && Date.parse(t.cancelled_at) <= atMs) return false; // 取消后恢复签收
      return true;
    })
    .map((m) => ({
      id: m.id,
      title: m.title,
      material_key: m.material_key,
      arrived_at: m.arrived_at,
      arrived_by: m.arrived_by,
      arrived_during_transfer_id: m.arrived_during_transfer_id,
      status_at: "pending_attribution" as const,
    }));

  const stages: Array<{
    stage: StageRow;
    events: DeadlineEventRow[];
    clock: ReturnType<typeof buildStageClockAt>;
    decision: DecisionRow | null;
  }> = [];
  for (const stage of listStages(ctx, caseId)) {
    if (Date.parse(stage.opened_at) > Date.parse(at)) continue;
    const events = listEvents(ctx, stage.stage_id).filter((e) => Date.parse(e.occurred_at) <= Date.parse(at));
    stages.push({
      stage,
      events,
      clock: buildStageClockAt(ctx, caseId, stage.stage_id, at),
      decision: decisionAt(ctx, stage, at),
    });
  }

  const rulings = listRulings(ctx, caseId).filter((r) => Date.parse(r.ruled_at) <= Date.parse(at));
  const transfers = transfersAll
    .filter((t) => Date.parse(t.proposed_at) <= Date.parse(at))
    .map((t) => transferView(ctx, t, at));

  const notifications = listNotifications(ctx, caseId)
    .filter((n) => Date.parse(n.created_at) <= Date.parse(at))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      created_by: n.created_by,
      created_at: n.created_at,
      basis: JSON.parse(n.basis_json),
    }));

  return {
    as_of: at,
    case: {
      case_id: c.case_id,
      case_no: c.case_no,
      subject: c.subject,
      rule_version: c.rule_version,
      status_at: Date.parse(c.opened_at) <= Date.parse(at) ? c.status : "pending",
    },
    responsible_at: link
      ? {
          agency_code: link.agency_code,
          region_code: link.region_code,
          source: link.source,
          source_ref: link.source_ref,
          effective_from: link.effective_from,
        }
      : null,
    party_claims: claims,
    rulings: rulings.map(rulingView),
    stages,
    unsigned_materials: unsignedMaterials,
    transfers,
    notifications,
  };
}

function decisionAt(ctx: Context, stage: StageRow, at: string): DecisionRow | null {
  if (!stage.decided_at || Date.parse(stage.decided_at) > Date.parse(at)) return null;
  // 决定不可变：即便后来规则换版，asOf 视图仍返回原样钉选版本。
  const row = ctx.raw.prepare("SELECT * FROM decisions WHERE stage_id = ?").get(stage.stage_id) as DecisionRow | undefined;
  return row ?? null;
}

function rulingView(r: RulingRow) {
  return {
    seq: r.seq,
    lead_agency: r.lead_agency,
    co_agencies: JSON.parse(r.co_agencies_json) as string[],
    ruled_by: r.ruled_by,
    evidence_watermark: r.evidence_watermark,
    rule_version: r.rule_version,
    basis: r.basis,
    ruled_at: r.ruled_at,
  };
}

function transferView(ctx: Context, t: TransferRow, at: string) {
  return {
    seq: t.seq,
    transfer_id: t.id,
    from_agency: t.from_agency,
    to_agency: t.to_agency,
    status: statusAt(t, at),
    idempotency_key: t.idempotency_key,
    proposed_by: t.proposed_by,
    proposed_at: t.proposed_at,
    frozen_by: t.frozen_at && Date.parse(t.frozen_at) <= Date.parse(at) ? t.frozen_by : null,
    frozen_at: t.frozen_at && Date.parse(t.frozen_at) <= Date.parse(at) ? t.frozen_at : null,
    manifest:
      t.frozen_at && Date.parse(t.frozen_at) <= Date.parse(at)
        ? { hash: t.manifest_hash, items: manifestOf(t), item_count: manifestOf(t).length }
        : null,
    receipts: listReceipts(ctx, t.id)
      .filter((r) => Date.parse(r.received_at) <= Date.parse(at))
      .map((r) => ({ received_by: r.received_by, manifest_hash: r.manifest_hash, received_at: r.received_at })),
    effective_at: t.effective_at && Date.parse(t.effective_at) <= Date.parse(at) ? t.effective_at : null,
  };
}

/** 移交状态的时点回放（不依赖后来的终态）。 */
function statusAt(t: TransferRow, at: string): TransferRow["status"] {
  const tms = Date.parse(at);
  if (t.cancelled_at && Date.parse(t.cancelled_at) <= tms) return "cancelled";
  if (t.effective_at && Date.parse(t.effective_at) <= tms) return "effective";
  if (t.received_at && Date.parse(t.received_at) <= tms) return "received";
  if (t.frozen_at && Date.parse(t.frozen_at) <= tms) return "frozen";
  return "proposed";
}

export function caseSnapshotNow(ctx: Context, caseId: string) {
  const c = getCase(ctx, caseId);
  return {
    case: c,
    claims: listClaims(ctx, caseId),
    materials: listMaterials(ctx, caseId),
    rulings: listRulings(ctx, caseId).map(rulingView),
    links: listLinks(ctx, caseId),
    stages: listStages(ctx, caseId).map((s) => ({
      stage: s,
      events: listEvents(ctx, s.stage_id),
      decision: listDecisions(ctx, caseId).find((d) => d.stage_id === s.stage_id) ?? null,
    })),
    transfers: listTransfers(ctx, caseId),
    notifications: listNotifications(ctx, caseId),
  };
}
