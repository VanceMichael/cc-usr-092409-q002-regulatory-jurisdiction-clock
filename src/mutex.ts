/**
 * 单连接 SQLite 的写串行化：better-sqlite3 全库只有一个连接，
 * 异步交错会在同一连接上嵌套 BEGIN，所有写事务必须排队执行。
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
