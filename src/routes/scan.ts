import type { FastifyInstance } from "fastify";
import { notFound } from "../errors.js";
import { runDeadlineScan } from "../scan.js";
import type { RouteContext } from "./cases.js";

/** 到期扫描与持久通知查询。 */
export function registerScanRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, now, writeTx } = ctx;

  // 手动触发一次到期扫描（自动扫描由服务启动时的定时器执行）。
  app.post("/internal/scan", async () => {
    return runDeadlineScan(db, now(), writeTx);
  });

  app.get("/notifications/pending", async (request) => {
    const query = request.query as { agency_id?: string };
    let statement = db
      .selectFrom("notifications")
      .selectAll()
      .where("delivered", "=", 0)
      .orderBy("created_at", "asc");
    if (query.agency_id) {
      statement = statement.where("lead_agency", "=", query.agency_id);
    }
    const rows = await statement.execute();
    return {
      notifications: rows.map((row) => ({
        notification_id: row.notification_id,
        case_id: row.case_id,
        kind: row.kind,
        lead_agency: row.lead_agency,
        created_at: row.created_at,
        basis: JSON.parse(row.basis),
      })),
    };
  });

  app.post("/notifications/:notificationId/delivered", async (request, reply) => {
    const { notificationId } = request.params as { notificationId: string };
    const result = await writeTx((trx) =>
      trx
        .updateTable("notifications")
        .set({ delivered: 1 })
        .where("notification_id", "=", notificationId)
        .executeTakeFirst(),
    );
    if (result.numUpdatedRows === 0n) {
      throw notFound("NOTIFICATION_NOT_FOUND", `通知 ${notificationId} 不存在`);
    }
    return reply.send({ notification_id: notificationId, delivered: true });
  });
}
