import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { withFixedNow, type Context } from "../src/db.js";
import { freshContext, seedFixture } from "./support.js";

function httpApp(ctx: Context): FastifyInstance {
  return buildApp(ctx);
}

async function json<T>(app: FastifyInstance, method: "POST" | "GET", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return { status: res.statusCode, body: res.json() as T };
}

test("HTTP 端到端：立案->裁定->补正暂停->冻结移交->同版签收->时点查询", async () => {
  const ctx = freshContext("2026-09-21T00:00:00Z");
  seedFixture(ctx);
  const app = httpApp(ctx);
  try {
    // 立案。
    const opened = await json<{ case_id: string; stage_id: string }>(app, "POST", "/cases", {
      case_no: "HTTP-1", subject: "跨省争议", rule_version: "v2026.1", intake_agency: "A_CN",
      opened_by: "p_cn", stage_code: "review",
      claims: [{ party_role: "consumer", party_name: "阿依", statement: "常住地管辖" }],
    });
    assert.equal(opened.status, 200);
    const caseId = opened.body.case_id;

    // 无授权人员裁定 -> 403 稳定错误码。
    const denied = await json(app, "POST", `/cases/${caseId}/rulings`, { lead_agency: "A_CN", ruled_by: "p_nogrant", basis: "x", idempotency_key: "r0" });
    assert.equal(denied.status, 403);
    assert.equal((denied.body as { error: { code: string } }).error.code, "jurisdiction_not_authorized");

    // 合法裁定。
    const ruled = await json(app, "POST", `/cases/${caseId}/rulings`, { lead_agency: "A_CN", co_agencies: ["A_XJ"], ruled_by: "p_cn", basis: "商家地", idempotency_key: "r1" });
    assert.equal(ruled.status, 200);

    // 补正暂停（用 x-now 指定事件时间）。
    const paused = await json(app, "POST", `/cases/${caseId}/clock-events`, {
      type: "supplement_request", actor: "p_cn", reason_code: "MATERIAL_INCOMPLETE", legal_basis: "办法§12", idempotency_key: "e1",
    }, { "x-now": "2026-09-22T01:00:00Z" });
    assert.equal(paused.status, 200);

    // 时钟：暂停中无 deadline。
    const clock = await json<{ status: string; deadline_at: string | null }>(app, "GET", `/cases/${caseId}/clock`);
    assert.equal(clock.body.status, "paused");
    assert.equal(clock.body.deadline_at, null);

    // 恢复。
    await json(app, "POST", `/cases/${caseId}/clock-events`, {
      type: "resume", actor: "p_cn", reason_code: "MATERIAL_COMPLETED", legal_basis: "办法§12", idempotency_key: "e2",
    }, { "x-now": "2026-09-23T01:00:00Z" });

    // 移交：发起、冻结（x-now 推进时间）。
    const proposed = await json<{ id: number }>(app, "POST", `/cases/${caseId}/transfers`, { from_agency: "A_CN", to_agency: "A_XJ", proposed_by: "p_cn", idempotency_key: "t1" }, { "x-now": "2026-09-23T02:00:00Z" });
    const transferId = proposed.body.id;
    const frozen = await json<{ transfer: { manifest_hash: string } }>(app, "POST", `/transfers/${transferId}/freeze`, { frozen_by: "p_cn" }, { "x-now": "2026-09-23T03:00:00Z" });
    assert.equal(frozen.body.transfer.manifest_hash.length, 64);

    // 错误版本签收 -> 409。
    const bad = await json(app, "POST", `/transfers/${transferId}/receive`, { received_by: "p_xj", manifest_hash: "00", idempotency_key: "rcv" }, { "x-now": "2026-09-23T04:00:00Z" });
    assert.equal(bad.status, 409);
    assert.equal((bad.body as { error: { code: string } }).error.code, "manifest_version_mismatch");

    // 正确版本签收生效。
    const received = await json(app, "POST", `/transfers/${transferId}/receive`, { received_by: "p_xj", manifest_hash: frozen.body.transfer.manifest_hash, idempotency_key: "rcv" }, { "x-now": "2026-09-23T05:00:00Z" });
    assert.equal(received.status, 200);
    assert.equal((received.body as { new_link: { agency_code: string } }).new_link.agency_code, "A_XJ");

    // 时点查询：2026-09-21 主办仍为受理机构。
    const past = await json<{ responsible_at: { agency_code: string } | null }>(app, "GET", `/cases/${caseId}/timeline?as_of=2026-09-21T12:00:00Z`);
    assert.equal(past.body.responsible_at!.agency_code, "A_CN");

    // 非法 x-now -> 400。
    const badNow = await json(app, "GET", "/scanner/status", undefined, { "x-now": "not-a-date" });
    assert.equal(badNow.status, 400);

    // 手动扫描可执行。
    const scan = await json<{ scanned_cases: number }>(app, "POST", "/scanner/run", {});
    assert.equal(scan.status, 200);
    assert.equal(scan.body.scanned_cases, 1);

    // 健康检查。
    const health = await json<{ status: string }>(app, "GET", "/health");
    assert.equal(health.body.status, "ok");
  } finally {
    await app.close();
  }
});

test("HTTP：请求体缺失返回稳定错误码", async () => {
  const ctx = freshContext("2026-09-21T00:00:00Z");
  seedFixture(ctx);
  const app = httpApp(ctx);
  try {
    const res = await app.inject({ method: "POST", url: "/cases" });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, "bad_request");
  } finally {
    await app.close();
  }
  void withFixedNow;
});
