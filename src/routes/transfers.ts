import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadCaseOrThrow } from "../caseLedger.js";
import { appendClockEvent } from "../clock.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { requireStaff } from "../staff.js";
import { asObject, optionalString, requireString } from "../validate.js";
import type { RouteContext } from "./cases.js";

interface ManifestItem {
  material_id: string;
  label: string;
  content_hash: string;
}

function manifestHash(items: ManifestItem[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

/**
 * 部分唯一索引违例时 SQLite 报错引用的是列名（如 UNIQUE constraint failed: transfers.case_id），
 * 以此区分在途移交冲突、幂等键冲突与责任链冲突。
 */
function isUniqueViolation(error: unknown, columnRef: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    String((error as { message?: string }).message).includes(columnRef)
  );
}

type TransferRow = {
  transfer_id: string;
  case_id: string;
  from_agency: string;
  to_agency: string;
  reason: string;
  manifest_version: number;
  manifest: string;
  manifest_hash: string;
  state: string;
  idempotency_key: string;
  initiated_by: string;
  frozen_at: string;
  signed_by: string | null;
  signed_at: string | null;
  effective_at: string | null;
  cancelled_at: string | null;
};

function presentTransfer(transfer: TransferRow, replay: boolean) {
  return { ...transfer, manifest: JSON.parse(transfer.manifest), replay };
}

/** 移交：交出方冻结材料清单，接收方签收同一版本后在单事务内原子生效。 */
export function registerTransferRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, now, writeTx } = ctx;

  // 发起移交：冻结当前在卷材料清单；同一案件同一时刻只允许一条在途移交。
  app.post("/cases/:caseId/transfers", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const body = asObject(request.body);
    const caseRow = await loadCaseOrThrow(db, caseId);
    if (caseRow.status !== "open") throw conflict("CASE_CLOSED", "案件已办结，不能移交");
    const staff = await requireStaff(db, body.staff_id, "transfer.initiate");
    const toAgency = requireString(body, "to_agency");
    const idempotencyKey = requireString(body, "idempotency_key");
    const reason = optionalString(body, "reason") ?? "";

    const openLead = await db
      .selectFrom("case_responsibility")
      .selectAll()
      .where("case_id", "=", caseId)
      .where("role", "=", "lead")
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (!openLead) throw conflict("JURISDICTION_NOT_CONFIRMED", "管辖尚未确认，不能发起移交");
    if (toAgency === openLead.agency_id) {
      throw badRequest("TRANSFER_TARGET_INVALID", "接收方不能是当前主办机构");
    }
    const agency = await db
      .selectFrom("agencies")
      .select("agency_id")
      .where("agency_id", "=", toAgency)
      .executeTakeFirst();
    if (!agency) throw badRequest("AGENCY_UNKNOWN", `机构 ${toAgency} 未登记`);

    // 幂等：同一 idempotency_key 重复发起返回首次结果。
    const existing = await db
      .selectFrom("transfers")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.case_id === caseId && existing.to_agency === toAgency) {
        return reply.code(200).send(presentTransfer(existing, true));
      }
      throw conflict("IDEMPOTENCY_CONFLICT", `幂等键 ${idempotencyKey} 已用于其他移交`);
    }

    const transferId = randomUUID();
    try {
      await writeTx(async (trx) => {
        const materials = await trx
          .selectFrom("materials")
          .selectAll()
          .where("case_id", "=", caseId)
          .where("state", "in", ["filed", "transferred"])
          .orderBy("material_id", "asc")
          .execute();
        const manifest: ManifestItem[] = materials.map((material) => ({
          material_id: material.material_id,
          label: material.label,
          content_hash: material.content_hash,
        }));
        const versionRow = await trx
          .selectFrom("transfers")
          .select(({ fn }) => fn.max("manifest_version").as("max_version"))
          .where("case_id", "=", caseId)
          .executeTakeFirst();
        const manifestVersion = Number(versionRow?.max_version ?? 0) + 1;
        const frozenAt = now().toISOString();

        await trx
          .updateTable("materials")
          .set({ state: "frozen", manifest_version: manifestVersion })
          .where("case_id", "=", caseId)
          .where("state", "in", ["filed", "transferred"])
          .execute();
        await trx
          .insertInto("transfers")
          .values({
            transfer_id: transferId,
            case_id: caseId,
            from_agency: openLead.agency_id,
            to_agency: toAgency,
            reason,
            manifest_version: manifestVersion,
            manifest: JSON.stringify(manifest),
            manifest_hash: manifestHash(manifest),
            state: "frozen",
            idempotency_key: idempotencyKey,
            initiated_by: staff.staff_id,
            frozen_at: frozenAt,
            signed_by: null,
            signed_at: null,
            effective_at: null,
            cancelled_at: null,
          })
          .execute();
      });
    } catch (error) {
      if (isUniqueViolation(error, "transfers.case_id")) {
        throw conflict("TRANSFER_IN_FLIGHT", "已有一条在途移交，并发移交只保留一条责任链");
      }
      if (isUniqueViolation(error, "transfers.idempotency_key")) {
        // 并发下同键重试：返回先到的移交，保持幂等。
        const winner = await db
          .selectFrom("transfers")
          .selectAll()
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (winner && winner.case_id === caseId && winner.to_agency === toAgency) {
          return reply.code(200).send(presentTransfer(winner, true));
        }
        throw conflict("IDEMPOTENCY_CONFLICT", `幂等键 ${idempotencyKey} 已用于其他移交`);
      }
      throw error;
    }
    const transfer = await db
      .selectFrom("transfers")
      .selectAll()
      .where("transfer_id", "=", transferId)
      .executeTakeFirstOrThrow();
    return reply.code(201).send({
      ...presentTransfer(transfer, false),
      frozen_materials: (JSON.parse(transfer.manifest) as ManifestItem[]).length,
    });
  });

  app.get("/transfers/:transferId", async (request) => {
    const { transferId } = request.params as { transferId: string };
    const transfer = await db
      .selectFrom("transfers")
      .selectAll()
      .where("transfer_id", "=", transferId)
      .executeTakeFirst();
    if (!transfer) throw notFound("TRANSFER_NOT_FOUND", `移交 ${transferId} 不存在`);
    return presentTransfer(transfer, false);
  });

  // 签收：接收方确认同一清单版本后，关闭旧责任段、开启新责任段、
  // 材料转为已签收、追加 transferred 事件——全部在一个事务内生效；重复签收幂等。
  app.post("/transfers/:transferId/sign", async (request, reply) => {
    const { transferId } = request.params as { transferId: string };
    const body = asObject(request.body);
    const staff = await requireStaff(db, body.staff_id, "transfer.sign");
    const manifestVersion = body.manifest_version;
    if (typeof manifestVersion !== "number" || !Number.isInteger(manifestVersion)) {
      throw badRequest("VALIDATION", "manifest_version 必须是整数");
    }
    const transfer = await db
      .selectFrom("transfers")
      .selectAll()
      .where("transfer_id", "=", transferId)
      .executeTakeFirst();
    if (!transfer) throw notFound("TRANSFER_NOT_FOUND", `移交 ${transferId} 不存在`);
    if (staff.agency_id !== transfer.to_agency) {
      throw forbidden("STAFF_FORBIDDEN", "只有接收方机构人员才能签收移交");
    }

    try {
      const outcome = await writeTx(async (trx) => {
        const current = await trx
          .selectFrom("transfers")
          .selectAll()
          .where("transfer_id", "=", transferId)
          .executeTakeFirstOrThrow();
        if (current.state === "effective") {
          // 重复签收幂等：同一清单版本直接返回首次生效结果。
          if (manifestVersion === current.manifest_version) {
            return { transfer: current, replay: true };
          }
          throw conflict("MANIFEST_MISMATCH", "签收清单版本与冻结版本不一致");
        }
        if (current.state === "cancelled") {
          throw conflict("TRANSFER_CANCELLED", "移交已取消，不能签收");
        }
        if (manifestVersion !== current.manifest_version) {
          throw conflict(
            "MANIFEST_MISMATCH",
            `签收清单版本 ${manifestVersion} 与冻结版本 ${current.manifest_version} 不一致`,
          );
        }

        const effectiveAt = now().toISOString();
        await trx
          .updateTable("transfers")
          .set({
            state: "effective",
            signed_by: staff.staff_id,
            signed_at: effectiveAt,
            effective_at: effectiveAt,
          })
          .where("transfer_id", "=", transferId)
          .execute();
        const openLead = await trx
          .selectFrom("case_responsibility")
          .selectAll()
          .where("case_id", "=", current.case_id)
          .where("role", "=", "lead")
          .where("ended_at", "is", null)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable("case_responsibility")
          .set({ ended_at: effectiveAt })
          .where("id", "=", openLead.id)
          .execute();
        await trx
          .insertInto("case_responsibility")
          .values({
            case_id: current.case_id,
            agency_id: current.to_agency,
            role: "lead",
            seq: openLead.seq + 1,
            started_at: effectiveAt,
            ended_at: null,
            transfer_id: current.transfer_id,
          })
          .execute();
        await trx
          .updateTable("materials")
          .set({ state: "transferred" })
          .where("case_id", "=", current.case_id)
          .where("manifest_version", "=", current.manifest_version)
          .where("state", "=", "frozen")
          .execute();
        const caseRow = await trx
          .selectFrom("cases")
          .selectAll()
          .where("case_id", "=", current.case_id)
          .executeTakeFirstOrThrow();
        await appendClockEvent(trx, {
          caseId: current.case_id,
          stage: caseRow.current_stage,
          eventType: "transferred",
          occurredAt: effectiveAt,
          ruleSetVersion: caseRow.rule_set_version,
          payload: {
            transfer_id: current.transfer_id,
            from_agency: current.from_agency,
            to_agency: current.to_agency,
            manifest_version: current.manifest_version,
          },
          recordedBy: staff.staff_id,
        });
        const updated = await trx
          .selectFrom("transfers")
          .selectAll()
          .where("transfer_id", "=", transferId)
          .executeTakeFirstOrThrow();
        return { transfer: updated, replay: false };
      });
      return reply.send(presentTransfer(outcome.transfer, outcome.replay));
    } catch (error) {
      if (isUniqueViolation(error, "case_responsibility.case_id")) {
        throw conflict(
          "RESPONSIBILITY_CONFLICT",
          "案件已存在有效主办责任段，并发移交只保留一条责任链",
        );
      }
      throw error;
    }
  });

  // 取消在途移交：解冻材料回卷；已生效的移交不可取消。
  app.post("/transfers/:transferId/cancel", async (request, reply) => {
    const { transferId } = request.params as { transferId: string };
    const body = asObject(request.body);
    await requireStaff(db, body.staff_id, "transfer.initiate");
    const transfer = await db
      .selectFrom("transfers")
      .selectAll()
      .where("transfer_id", "=", transferId)
      .executeTakeFirst();
    if (!transfer) throw notFound("TRANSFER_NOT_FOUND", `移交 ${transferId} 不存在`);

    const outcome = await writeTx(async (trx) => {
      const current = await trx
        .selectFrom("transfers")
        .selectAll()
        .where("transfer_id", "=", transferId)
        .executeTakeFirstOrThrow();
      if (current.state === "effective") {
        throw conflict("TRANSFER_ALREADY_EFFECTIVE", "移交已生效，不能取消");
      }
      if (current.state === "cancelled") {
        return { state: "cancelled" as const, replay: true };
      }
      const cancelledAt = now().toISOString();
      await trx
        .updateTable("transfers")
        .set({ state: "cancelled", cancelled_at: cancelledAt })
        .where("transfer_id", "=", transferId)
        .execute();
      await trx
        .updateTable("materials")
        .set({ state: "filed", manifest_version: null })
        .where("case_id", "=", current.case_id)
        .where("manifest_version", "=", current.manifest_version)
        .where("state", "=", "frozen")
        .execute();
      return { state: "cancelled" as const, replay: false, cancelledAt };
    });
    if (outcome.replay) {
      return reply.send(presentTransfer({ ...transfer, state: "cancelled" }, true));
    }
    return reply.send({
      transfer_id: transferId,
      state: "cancelled",
      cancelled_at: outcome.cancelledAt,
    });
  });
}
