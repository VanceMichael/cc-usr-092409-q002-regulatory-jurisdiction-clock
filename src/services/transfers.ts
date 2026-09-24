import type { Context, LinkRow, MaterialRow, ReceiptRow, TransferRow } from "../db.js";
import { ServiceError } from "../db.js";
import { getAgency, getPerson } from "./catalog.js";
import { getCase, requireActiveCase } from "./cases.js";
import { currentLink, nextLinkSeq } from "./rulings.js";
import { isoNow, sha256Canonical } from "./util.js";

export interface ManifestItem {
  id: number;
  seq: number;
  material_key: string;
  title: string;
  checksum: string;
}

export function buildManifest(ctx: Context, caseId: string): { items: ManifestItem[]; hash: string } {
  const items = (ctx.raw
    .prepare(
      `SELECT id, seq, material_key, title, checksum FROM case_materials
       WHERE case_id = ? AND status IN ('received','attributed') ORDER BY seq`,
    )
    .all(caseId) as ManifestItem[])
    .map((m) => ({ id: m.id, seq: m.seq, material_key: m.material_key, title: m.title, checksum: m.checksum }));
  return { items, hash: sha256Canonical(items) };
}

function inFlightTransfer(ctx: Context, caseId: string): TransferRow | undefined {
  return ctx.raw
    .prepare("SELECT * FROM transfers WHERE case_id = ? AND status IN ('proposed','frozen','received') ORDER BY seq DESC LIMIT 1")
    .get(caseId) as TransferRow | undefined;
}

export function getTransfer(ctx: Context, transferId: number): TransferRow {
  const row = ctx.raw.prepare("SELECT * FROM transfers WHERE id = ?").get(transferId);
  if (!row) throw new ServiceError("transfer_not_found", `移交 ${transferId} 不存在`, 404);
  return row as TransferRow;
}

/** 发起移交（proposed）：只有当前主办机构能交出，且同案只能有一条在途移交。 */
export function proposeTransfer(
  ctx: Context,
  caseId: string,
  input: { from_agency: string; to_agency: string; proposed_by: string; idempotency_key: string },
): TransferRow {
  requireActiveCase(ctx, caseId);
  const from = getAgency(ctx, input.from_agency);
  const to = getAgency(ctx, input.to_agency);
  if (from.agency_code === to.agency_code) throw new ServiceError("bad_request", "交出方与接收方不能相同");

  const replay = ctx.raw
    .prepare("SELECT * FROM transfers WHERE case_id = ? AND idempotency_key = ?")
    .get(caseId, input.idempotency_key) as TransferRow | undefined;
  if (replay) return replay;

  const link = currentLink(ctx, caseId);
  if (link.agency_code !== from.agency_code) {
    throw new ServiceError("not_responsible_agency", `当前主办为 ${link.agency_code}，${from.agency_code} 无权交出案件`, 403);
  }

  const now = isoNow(ctx);
  let transferId = 0;
  const tx = ctx.raw.transaction(() => {
    const seq = (ctx.raw.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM transfers WHERE case_id = ?").get(caseId) as { n: number }).n;
    const info = ctx.raw
      .prepare(
        `INSERT INTO transfers(case_id, seq, from_agency, to_agency, status, idempotency_key,
             proposed_by, proposed_at)
         VALUES (?,?,?,?, 'proposed', ?,?,?)`,
      )
      .run(caseId, seq, from.agency_code, to.agency_code, input.idempotency_key, input.proposed_by, now);
    transferId = Number(info.lastInsertRowid);
  });
  try {
    tx.immediate();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      if (inFlightTransfer(ctx, caseId)) throw new ServiceError("transfer_in_flight", "案件已有在途移交，并发移交只能保留一条", 409);
      const row = ctx.raw.prepare("SELECT * FROM transfers WHERE case_id = ? AND idempotency_key = ?").get(caseId, input.idempotency_key) as TransferRow;
      return row;
    }
    throw err;
  }
  return getTransfer(ctx, transferId);
}

/** 交出方冻结材料清单：此后新到材料进入待归属区，清单版本不可变。 */
export function freezeTransfer(
  ctx: Context,
  transferId: number,
  input: { frozen_by: string },
): TransferRow {
  const transfer = getTransfer(ctx, transferId);
  requireActiveCase(ctx, transfer.case_id);
  if (transfer.status !== "proposed") throw new ServiceError("transfer_not_freezable", `移交状态为 ${transfer.status}，不能冻结`, 409);

  const link = currentLink(ctx, transfer.case_id);
  if (link.agency_code !== transfer.from_agency) {
    throw new ServiceError("not_responsible_agency", "当前主办已变更，不能冻结该移交", 403);
  }

  const { items, hash } = buildManifest(ctx, transfer.case_id);
  const now = isoNow(ctx);
  const tx = ctx.raw.transaction(() => {
    const fresh = getTransfer(ctx, transferId);
    if (fresh.status !== "proposed") throw new ServiceError("transfer_not_freezable", `移交状态为 ${fresh.status}，不能冻结`, 409);
    const link = ctx.raw
      .prepare("SELECT * FROM responsibility_links WHERE case_id = ? AND effective_to IS NULL")
      .get(transfer.case_id) as LinkRow | undefined;
    if (!link || link.agency_code !== transfer.from_agency) {
      throw new ServiceError("not_responsible_agency", "当前主办已变更，不能冻结该移交", 403);
    }
    const result = ctx.raw
      .prepare("UPDATE transfers SET status='frozen', frozen_by=?, frozen_at=?, manifest_hash=?, manifest_json=? WHERE id=? AND status='proposed'")
      .run(input.frozen_by, now, hash, JSON.stringify(items), transferId);
    if (result.changes === 0) throw new ServiceError("transfer_not_freezable", "移交已被并发处理，冻结未生效", 409);
  });
  tx.immediate();
  return getTransfer(ctx, transferId);
}

export interface ReceiveResult {
  transfer: TransferRow;
  receipt: ReceiptRow;
  new_link: LinkRow;
  attributed_pending_count: number;
}

/**
 * 接收方签收：
 *  - 必须是接收机构人员；
 *  - manifest_hash 必须与冻结版本逐字节一致（同一版本），不一致拒绝；
 *  - 重复签收（同幂等键）直接返回既有签收，幂等；
 *  - 签收与责任链切换同一事务原子生效；途中材料留在待归属区由新主办认领。
 */
export function receiveTransfer(
  ctx: Context,
  transferId: number,
  input: { received_by: string; manifest_hash: string; idempotency_key: string },
): ReceiveResult {
  const transfer = getTransfer(ctx, transferId);
  requireActiveCase(ctx, transfer.case_id);
  if (transfer.status !== "frozen" && transfer.status !== "received" && transfer.status !== "effective") {
    throw new ServiceError("transfer_not_receivable", `移交状态为 ${transfer.status}，不能签收`, 409);
  }
  const person = getPerson(ctx, input.received_by);
  const toAgency = getAgency(ctx, transfer.to_agency);
  if (person.agency_code !== toAgency.agency_code) {
    throw new ServiceError("not_receiving_agency", `签收人不属于接收机构 ${toAgency.agency_code}`, 403);
  }

  const existingReceipt = ctx.raw
    .prepare("SELECT * FROM transfer_receipts WHERE transfer_id = ? AND idempotency_key = ?")
    .get(transferId, input.idempotency_key) as ReceiptRow | undefined;
  if (existingReceipt) {
    if (existingReceipt.manifest_hash !== input.manifest_hash) {
      throw new ServiceError("manifest_version_mismatch", "重复签收使用了与原签收不同的清单版本", 409);
    }
    return {
      transfer: getTransfer(ctx, transferId),
      receipt: existingReceipt,
      new_link: currentLink(ctx, transfer.case_id),
      attributed_pending_count: 0,
    };
  }

  // 签收清单必须与冻结版本逐字节一致（同一版本）；移交生效后补签同样不接受其他版本。
  if (input.manifest_hash !== transfer.manifest_hash) {
    throw new ServiceError(
      "manifest_version_mismatch",
      "签收清单版本与交出方冻结版本不一致，请核对后重新签收",
      409,
      { expected_hash: transfer.manifest_hash, received_hash: input.manifest_hash },
    );
  }

  const now = isoNow(ctx);
  let receiptId = 0;
  let newLink: LinkRow;
  let pendingCount = 0;

  const tx = ctx.raw.transaction(() => {
    // 事务内重读，防止冻结后被并发取消/再次签收。
    const fresh = getTransfer(ctx, transferId);
    if (fresh.status === "cancelled") throw new ServiceError("transfer_cancelled", "移交已被取消", 409);

    if (fresh.status === "frozen") {
      // 责任链切换前再次确认当前主办仍是交出方。
      const link = ctx.raw
        .prepare("SELECT * FROM responsibility_links WHERE case_id = ? AND effective_to IS NULL")
        .get(transfer.case_id) as LinkRow | undefined;
      if (!link || link.agency_code !== transfer.from_agency) {
        throw new ServiceError("chain_changed", "冻结后责任链已变化，本次移交不能生效", 409);
      }

      const info = ctx.raw
        .prepare(
          `INSERT INTO transfer_receipts(transfer_id, received_by, manifest_hash, received_at, idempotency_key)
           VALUES (?,?,?,?,?)`,
        )
        .run(transferId, input.received_by, input.manifest_hash, now, input.idempotency_key);
      receiptId = Number(info.lastInsertRowid);

      // 原子生效：关闭旧链、开启接收方新链、移交置为 effective。
      ctx.raw.prepare("UPDATE responsibility_links SET effective_to = ? WHERE id = ?").run(now, link.id);
      const linkSeq = nextLinkSeq(ctx, transfer.case_id);
      ctx.raw
        .prepare(
          `INSERT INTO responsibility_links(case_id, seq, agency_code, region_code, source, source_ref, effective_from, effective_to)
           VALUES (?,?,?,?,'transfer',?,?,NULL)`,
        )
        .run(transfer.case_id, linkSeq, toAgency.agency_code, toAgency.region_code, String(transferId), now);
      newLink = ctx.raw
        .prepare("SELECT * FROM responsibility_links WHERE case_id = ? AND effective_to IS NULL")
        .get(transfer.case_id) as LinkRow;

      // 途中材料脱离移交挂起标记，但保留待归属状态，由新主办签收/拒收。
      const pending = ctx.raw
        .prepare("UPDATE case_materials SET pending_transfer_id = NULL WHERE pending_transfer_id = ? AND status = 'pending_attribution'")
        .run(transferId);
      pendingCount = pending.changes;

      ctx.raw
        .prepare("UPDATE transfers SET status='effective', received_by=?, received_at=?, effective_at=? WHERE id=?")
        .run(input.received_by, now, now, transferId);
    } else {
      // effective 后用新幂等键签收：允许，登记一张收据但不再切换链路。
      const info = ctx.raw
        .prepare(
          `INSERT INTO transfer_receipts(transfer_id, received_by, manifest_hash, received_at, idempotency_key)
           VALUES (?,?,?,?,?)`,
        )
        .run(transferId, input.received_by, input.manifest_hash, now, input.idempotency_key);
      receiptId = Number(info.lastInsertRowid);
      newLink = currentLink(ctx, transfer.case_id);
    }
  });
  tx.immediate();

  const receipt = ctx.raw.prepare("SELECT * FROM transfer_receipts WHERE id = ?").get(receiptId) as ReceiptRow;
  return { transfer: getTransfer(ctx, transferId), receipt, new_link: newLink!, attributed_pending_count: pendingCount };
}

/** 交出方可在签收前取消移交；挂起的材料回到正常签收状态。 */
export function cancelTransfer(ctx: Context, transferId: number, input: { cancelled_by: string }): TransferRow {
  const transfer = getTransfer(ctx, transferId);
  if (!["proposed", "frozen"].includes(transfer.status)) {
    throw new ServiceError("transfer_not_cancellable", `移交状态为 ${transfer.status}，不能取消`, 409);
  }
  const link = currentLink(ctx, transfer.case_id);
  if (link.agency_code !== transfer.from_agency) {
    throw new ServiceError("not_responsible_agency", "只有交出方可以取消移交", 403);
  }
  const now = isoNow(ctx);
  const tx = ctx.raw.transaction(() => {
    ctx.raw
      .prepare("UPDATE transfers SET status='cancelled', cancelled_by=?, cancelled_at=? WHERE id=? AND status IN ('proposed','frozen')")
      .run(input.cancelled_by, now, transferId);
    // 冻结期间挂起的材料恢复为正常签收并补取水位号。
    const pending = ctx.raw
      .prepare("SELECT id FROM case_materials WHERE pending_transfer_id = ? AND status = 'pending_attribution' ORDER BY id")
      .all(transferId) as { id: number }[];
    for (const p of pending) {
      const next = (ctx.raw
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM case_materials WHERE case_id = ? AND seq > 0")
        .get(transfer.case_id) as { n: number }).n;
      ctx.raw
        .prepare("UPDATE case_materials SET status='received', pending_transfer_id=NULL, seq=? WHERE id=?")
        .run(next, p.id);
    }
  });
  tx.immediate();
  return getTransfer(ctx, transferId);
}

export function listTransfers(ctx: Context, caseId: string): TransferRow[] {
  getCase(ctx, caseId);
  return ctx.raw.prepare("SELECT * FROM transfers WHERE case_id = ? ORDER BY seq").all(caseId) as TransferRow[];
}

export function listReceipts(ctx: Context, transferId: number): ReceiptRow[] {
  getTransfer(ctx, transferId);
  return ctx.raw.prepare("SELECT * FROM transfer_receipts WHERE transfer_id = ? ORDER BY id").all(transferId) as ReceiptRow[];
}

/** 冻结清单视图（供接收方核对）。 */
export function manifestOf(transfer: TransferRow): ManifestItem[] {
  return JSON.parse(transfer.manifest_json || "[]") as ManifestItem[];
}

export function pendingMaterialsFor(ctx: Context, caseId: string): MaterialRow[] {
  return ctx.raw
    .prepare("SELECT * FROM case_materials WHERE case_id = ? AND status='pending_attribution' ORDER BY id")
    .all(caseId) as MaterialRow[];
}
