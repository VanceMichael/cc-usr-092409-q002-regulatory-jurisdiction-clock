import type { Context } from "./db.js";
import { runDueScan } from "./services/notifications.js";

export interface ScannerHandle {
  stop(): void;
  runOnce(): ReturnType<typeof runDueScan>;
}

/**
 * 到期扫描调度：进程启动即执行一次，之后按间隔持续运行。
 * 扫描状态与通知全部持久化在 SQLite，重启后凭 dedup_key 继续而不重复通知。
 */
export function startScanner(ctx: Context, intervalMs = Number(process.env.SCANNER_INTERVAL_MS ?? 60_000)): ScannerHandle {
  let stopped = false;
  const safeRun = () => {
    if (stopped) return;
    try {
      const result = runDueScan(ctx);
      if (result.created.length > 0) {
        console.log(`[scanner] 扫描 ${result.scanned_cases} 个阶段：新增到期提醒 ${result.due_soon}，逾期 ${result.overdue}`);
      }
    } catch (err) {
      console.error("[scanner] 到期扫描失败：", err instanceof Error ? err.message : err);
    }
  };
  // 启动后立即恢复扫描，不等待首个间隔。
  setImmediate(safeRun);
  const timer = setInterval(safeRun, intervalMs);
  // 不阻止进程退出。
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runOnce: () => runDueScan(ctx),
  };
}
