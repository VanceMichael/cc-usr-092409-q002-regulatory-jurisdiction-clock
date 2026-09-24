import { buildApp } from "./app.js";
import { getContext } from "./db.js";
import { startScanner, type ScannerHandle } from "./scanner.js";

const ctx = getContext();
const app = buildApp(ctx);

// 进程恢复后继续到期扫描（通知已持久化，去重由 dedup_key 保证）。
const scanner: ScannerHandle = startScanner(ctx);

const shutdown = async () => {
  scanner.stop();
  await app.close();
  await ctx.db.destroy();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? "8000"),
});
