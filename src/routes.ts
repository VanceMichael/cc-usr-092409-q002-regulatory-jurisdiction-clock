import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "./db.js";
import { ServiceError } from "./db.js";
import { ClockRuleError } from "./domain/clock.js";
import * as catalog from "./services/catalog.js";
import * as casesSvc from "./services/cases.js";
import * as rulingsSvc from "./services/rulings.js";
import * as ledger from "./services/ledger.js";
import * as transfersSvc from "./services/transfers.js";
import * as notify from "./services/notifications.js";
import { caseTimeline, caseSnapshotNow } from "./services/timeline.js";

interface RequestContext {
  ctx: Context;
}

export function registerRoutes(app: FastifyInstance, baseCtx: Context) {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const header = req.headers["x-now"];
    if (typeof header === "string" && header !== "") {
      if (Number.isNaN(Date.parse(header))) {
        throw new ServiceError("bad_timestamp", "x-now 必须是 ISO-8601 时间戳");
      }
      (req as unknown as RequestContext).ctx = {
        raw: baseCtx.raw,
        db: baseCtx.db,
        fixedNow: header,
        now: () => header,
      };
    } else {
      (req as unknown as RequestContext).ctx = baseCtx;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
      return;
    }
    if (error instanceof ClockRuleError) {
      reply.status(422).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof Error && (error as { code?: string }).code === "FST_ERR_VALIDATION") {
      reply.status(400).send({ error: { code: "bad_request", message: error.message } });
      return;
    }
    app.log.error(error);
    reply.status(500).send({ error: { code: "internal_error", message: "服务内部错误" } });
  });

  const ctxOf = (req: FastifyRequest): Context => (req as unknown as RequestContext).ctx;
  const bodyOf = <T>(req: FastifyRequest): T => {
    if (!req.body || typeof req.body !== "object") throw new ServiceError("bad_request", "请求体必须是 JSON 对象");
    return req.body as T;
  };
  const paramsOf = (req: FastifyRequest) => req.params as { id: string; transferId: string; materialId: string };

  // ---- 基础数据 -------------------------------------------------------------

  app.post("/admin/regions", async (req) =>
    catalog.createRegion(ctxOf(req), bodyOf(req)),
  );
  app.post("/admin/calendar-days", async (req) =>
    catalog.upsertCalendarDay(ctxOf(req), bodyOf(req)),
  );
  app.post("/admin/agencies", async (req) =>
    catalog.createAgency(ctxOf(req), bodyOf(req)),
  );
  app.post("/admin/personnel", async (req) =>
    catalog.createPerson(ctxOf(req), bodyOf(req)),
  );
  app.post("/admin/personnel/grants", async (req) => ({
    grants: catalog.grantRegion(ctxOf(req), bodyOf(req)),
  }));
  app.post("/admin/conflicts", async (req) =>
    catalog.declareConflict(ctxOf(req), bodyOf(req)),
  );
  app.post("/admin/rule-versions", async (req) =>
    catalog.createRuleVersion(ctxOf(req), bodyOf(req)),
  );

  // ---- 案件与证据 -----------------------------------------------------------

  app.post("/cases", async (req) =>
    casesSvc.openCase(ctxOf(req), bodyOf(req)),
  );
  app.get("/cases/:id", async (req) =>
    caseSnapshotNow(ctxOf(req), paramsOf(req).id),
  );
  app.get("/cases/:id/timeline", async (req) =>
    caseTimeline(ctxOf(req), paramsOf(req).id, (req.query as { as_of?: string }).as_of),
  );
  app.post("/cases/:id/claims", async (req) =>
    casesSvc.addClaim(ctxOf(req), paramsOf(req).id, bodyOf(req)),
  );
  app.post("/cases/:id/materials", async (req) => {
    const b = bodyOf<casesSvc.MaterialInput>(req);
    if (!b.idempotency_key) throw new ServiceError("bad_request", "字段 idempotency_key 必填");
    return casesSvc.receiveMaterial(ctxOf(req), paramsOf(req).id, b);
  });
  app.post("/cases/:id/materials/:materialId/attribute", async (req) =>
    casesSvc.attributePendingMaterial(ctxOf(req), paramsOf(req).id, Number(paramsOf(req).materialId), bodyOf(req)),
  );

  // ---- 管辖裁定 -------------------------------------------------------------

  app.post("/cases/:id/rulings", async (req) =>
    rulingsSvc.ruleJurisdiction(ctxOf(req), paramsOf(req).id, bodyOf(req)),
  );
  app.get("/cases/:id/rulings", async (req) => ({
    rulings: rulingsSvc.listRulings(ctxOf(req), paramsOf(req).id),
    links: rulingsSvc.listLinks(ctxOf(req), paramsOf(req).id),
  }));

  // ---- 期限账本 -------------------------------------------------------------

  app.post("/cases/:id/stages", async (req) =>
    ledger.openStage(ctxOf(req), paramsOf(req).id, bodyOf(req)),
  );
  app.post("/cases/:id/clock-events", async (req) =>
    ledger.appendDeadlineEvent(ctxOf(req), paramsOf(req).id, bodyOf(req)),
  );
  app.get("/cases/:id/clock", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = ctxOf(req);
    const q = req.query as { stage_id?: string; as_of?: string };
    const stageId = q.stage_id ?? ledger.openStageRow(ctx, paramsOf(req).id)?.stage_id;
    if (!stageId) throw new ServiceError("no_open_stage", "案件没有可计算时钟的阶段", 409);
    void reply;
    return q.as_of
      ? ledger.buildStageClockAt(ctx, paramsOf(req).id, stageId, q.as_of)
      : ledger.buildStageClock(ctx, paramsOf(req).id, stageId);
  });
  app.post("/cases/:id/decisions", async (req) =>
    ledger.issueDecision(ctxOf(req), paramsOf(req).id, bodyOf(req)),
  );

  // ---- 移交 -----------------------------------------------------------------

  app.post("/cases/:id/transfers", async (req) =>
    transfersSvc.proposeTransfer(ctxOf(req), paramsOf(req).id, bodyOf(req)),
  );
  app.post("/transfers/:transferId/freeze", async (req) => {
    const transfer = transfersSvc.freezeTransfer(ctxOf(req), Number(paramsOf(req).transferId), bodyOf(req));
    return { transfer, manifest: transfersSvc.manifestOf(transfer) };
  });
  app.post("/transfers/:transferId/receive", async (req) =>
    transfersSvc.receiveTransfer(ctxOf(req), Number(paramsOf(req).transferId), bodyOf(req)),
  );
  app.post("/transfers/:transferId/cancel", async (req) =>
    transfersSvc.cancelTransfer(ctxOf(req), Number(paramsOf(req).transferId), bodyOf(req)),
  );
  app.get("/transfers/:transferId", async (req) => {
    const id = Number(paramsOf(req).transferId);
    const transfer = transfersSvc.getTransfer(ctxOf(req), id);
    return {
      transfer,
      manifest: transfersSvc.manifestOf(transfer),
      receipts: transfersSvc.listReceipts(ctxOf(req), id),
      pending_materials: transfersSvc.pendingMaterialsFor(ctxOf(req), transfer.case_id),
    };
  });

  // ---- 催办与扫描 -----------------------------------------------------------

  app.post("/cases/:id/reminders", async (req) =>
    notify.createReminder(ctxOf(req), paramsOf(req).id, bodyOf(req)),
  );
  app.get("/cases/:id/notifications", async (req) => ({
    notifications: notify.listNotifications(ctxOf(req), paramsOf(req).id),
  }));
  app.post("/scanner/run", async (req) => notify.runDueScan(ctxOf(req)));
  app.get("/scanner/status", async (req) => ({ last_run_at: notify.lastScanAt(ctxOf(req)) }));
}
