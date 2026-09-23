import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "../src/app.js";

test("健康检查访问配置的 SQLite", async () => {
  try {
    process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "dispute-evidence-")), "service.sqlite3");
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
    await app.close();
  } finally {
    delete process.env.DATABASE_PATH;
  }
});
