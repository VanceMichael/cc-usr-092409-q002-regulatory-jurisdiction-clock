import Fastify from "fastify";
import { sql } from "kysely";
import { openMigratedDatabase, type AppDatabase, type WriteTx } from "./database.js";
import { HttpError } from "./errors.js";
import { AsyncMutex } from "./mutex.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerCaseRoutes } from "./routes/cases.js";
import { registerScanRoutes } from "./routes/scan.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import { runDeadlineScan } from "./scan.js";

export interface BuildAppOptions {
  db?: AppDatabase;
  now?: () => Date;
  /** 到期扫描间隔毫秒；0 表示关闭自动扫描（测试用）。 */
  scanIntervalMs?: number;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  const db = options.db ?? openMigratedDatabase();
  const now = options.now ?? (() => new Date());
  const scanIntervalMs =
    options.scanIntervalMs ?? Number(process.env.SCAN_INTERVAL_MS ?? "60000");
  // 单连接 SQLite：所有写事务经互斥锁排队，避免异步交错嵌套 BEGIN。
  const writeMutex = new AsyncMutex();
  const writeTx: WriteTx = (fn) => writeMutex.run(() => db.transaction().execute(fn));

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof statusCode === "number" && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: "BAD_REQUEST", message } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "内部错误" } });
  });

  app.get("/health", async () => {
    await sql`SELECT 1`.execute(db);
    return { status: "ok" };
  });

  const ctx = { db, now, writeTx };
  registerAdminRoutes(app, ctx);
  registerCaseRoutes(app, ctx);
  registerTransferRoutes(app, ctx);
  registerScanRoutes(app, ctx);

  // 进程恢复：启动就绪后立即补扫一次，之后按间隔持续扫描。
  // 通知按 案件+阶段+责任段+类型 持久去重，重启不会重复催办。
  let timer: NodeJS.Timeout | null = null;
  if (scanIntervalMs > 0) {
    const scan = () =>
      runDeadlineScan(db, now(), writeTx).catch((error: unknown) => {
        app.log.error(error);
      });
    app.addHook("onReady", async () => {
      await scan();
      timer = setInterval(scan, scanIntervalMs);
      timer.unref();
    });
  }
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await db.destroy();
  });
  return app;
}
