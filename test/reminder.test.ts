import assert from "node:assert/strict";
import test from "node:test";

import { createCase, createConfirmedCase, freshApp, freshDatabasePath, seedBasics } from "./helpers.js";
import { buildApp } from "../src/app.js";

const AT_DUE_SOON = "2026-09-11T01:00:00.000Z"; // 已消耗 8 个工作日，剩余 2 ≤ 阈值 3

test("到期扫描生成持久通知并记录催办依据，重复扫描与进程重启不重复催办", async () => {
  const databasePath = freshDatabasePath();
  process.env.DATABASE_PATH = databasePath;
  const app = buildApp({ scanIntervalMs: 0, now: () => new Date(AT_DUE_SOON) });
  await seedBasics(app);
  await createConfirmedCase(app);

  const first = await app.inject({ method: "POST", url: "/internal/scan" });
  assert.equal(first.json().notified, 1);
  const again = await app.inject({ method: "POST", url: "/internal/scan" });
  assert.equal(again.json().notified, 0);

  const list = await app.inject({ method: "GET", url: "/cases/case-1/notifications" });
  const notifications = list.json().notifications;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "due_soon");
  assert.equal(notifications[0].lead_agency, "ag-sh");
  // 催办依据：当时规则版本、消耗/剩余、排除段与日历地区全部留痕。
  assert.equal(notifications[0].basis.rule_set_version, "v2026.1");
  assert.equal(notifications[0].basis.consumed_workdays, 8);
  assert.equal(notifications[0].basis.remaining_workdays, 2);
  assert.equal(notifications[0].basis.calendar_region, "SH");
  assert.equal(notifications[0].basis.projected_deadline, "2026-09-15");
  await app.close();

  // 进程恢复：同一数据文件重启后再扫描，持久去重保证不重复催办。
  process.env.DATABASE_PATH = databasePath;
  const restarted = buildApp({ scanIntervalMs: 0, now: () => new Date(AT_DUE_SOON) });
  const rescan = await restarted.inject({ method: "POST", url: "/internal/scan" });
  assert.equal(rescan.json().notified, 0);
  await restarted.close();
});

test("逾期升级与移交后对新主办重新提醒", async () => {
  const app = freshApp({ now: () => new Date("2026-09-17T01:00:00.000Z") });
  await seedBasics(app);
  await createConfirmedCase(app);

  // 剩余已为负 → overdue。
  const scan = await app.inject({ method: "POST", url: "/internal/scan" });
  assert.equal(scan.json().notified, 1);
  let list = await app.inject({ method: "GET", url: "/cases/case-1/notifications" });
  assert.equal(list.json().notifications[0].kind, "overdue");
  assert.equal(list.json().notifications[0].basis.remaining_workdays, -2);

  // 移交浙江生效后，新责任段触发对新主办的提醒，而不是重复催原主办。
  const transfer = await app.inject({
    method: "POST",
    url: "/cases/case-1/transfers",
    payload: { staff_id: "st-admin", to_agency: "ag-zj", idempotency_key: "mv-1" },
  });
  await app.inject({
    method: "POST",
    url: `/transfers/${transfer.json().transfer_id}/sign`,
    payload: { staff_id: "st-zj", manifest_version: 1 },
  });
  const rescan = await app.inject({ method: "POST", url: "/internal/scan" });
  assert.equal(rescan.json().notified, 1);
  list = await app.inject({ method: "GET", url: "/cases/case-1/notifications" });
  assert.equal(list.json().notifications.length, 2);
  assert.equal(list.json().notifications[1].lead_agency, "ag-zj");
  assert.equal(list.json().notifications[1].basis.calendar_region, "ZJ");

  // 通知可标记送达并从待办中消失。
  const pending = await app.inject({
    method: "GET",
    url: "/notifications/pending?agency_id=ag-zj",
  });
  assert.equal(pending.json().notifications.length, 1);
  const notificationId = pending.json().notifications[0].notification_id;
  await app.inject({ method: "POST", url: `/notifications/${notificationId}/delivered` });
  const afterDeliver = await app.inject({
    method: "GET",
    url: "/notifications/pending?agency_id=ag-zj",
  });
  assert.equal(afterDeliver.json().notifications.length, 0);
  await app.close();
});

test("暂停期间不催办", async () => {
  const app = freshApp({ now: () => new Date(AT_DUE_SOON) });
  await seedBasics(app);
  await createConfirmedCase(app);
  await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "external_wait_started",
      occurred_at: "2026-09-04T10:00:00.000Z",
    },
  });
  const scan = await app.inject({ method: "POST", url: "/internal/scan" });
  assert.equal(scan.json().notified, 0);
  await app.close();
});

test("已出具决定的阶段不被规则换版改写，且拒绝回填事件", async () => {
  const app = freshApp();
  await seedBasics(app);
  await createConfirmedCase(app);
  await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "supplement_requested",
      occurred_at: "2026-09-03T10:00:00.000Z",
    },
  });
  await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "supplement_received",
      occurred_at: "2026-09-05T09:00:00.000Z",
    },
  });

  // 第一阶段决定：冻结快照（v2026.1，法定 10 个工作日）。
  const decision = await app.inject({
    method: "POST",
    url: "/cases/case-1/stage-decisions",
    payload: {
      staff_id: "st-admin",
      decision: "第一阶段调解不成，转入行政处理",
      issued_at: "2026-09-10T08:00:00.000Z",
    },
  });
  assert.equal(decision.statusCode, 201);
  assert.equal(decision.json().snapshot.clock.statutory_days, 10);
  assert.equal(decision.json().snapshot.clock.consumed_workdays, 5);

  // 规则换版：新版本法定 30 个工作日。
  await app.inject({
    method: "POST",
    url: "/rule-sets",
    payload: { version: "v2026.2", statutory_days: 30, max_extension_days: 5 },
  });
  const upgraded = await app.inject({
    method: "POST",
    url: "/cases/case-1/rule-version",
    payload: { staff_id: "st-admin", version: "v2026.2", occurred_at: "2026-09-11T01:00:00.000Z" },
  });
  assert.equal(upgraded.json().changed, true);

  // 查询已决定阶段内的历史时点：仍是 v2026.1 的口径，快照可对照。
  const historical = await app.inject({
    method: "GET",
    url: "/cases/case-1/ledger?at=2026-09-09T00:00:00.000Z",
  });
  const past = historical.json();
  assert.equal(past.stage, 1);
  assert.equal(past.stage_locked, true);
  assert.equal(past.clock.rule_set_version, "v2026.1");
  assert.equal(past.clock.statutory_days, 10);
  assert.equal(past.locked_snapshot.clock.consumed_workdays, 5);

  // 查询换版后的时点：新阶段适用 v2026.2。
  const current = await app.inject({
    method: "GET",
    url: "/cases/case-1/ledger?at=2026-09-12T00:00:00.000Z",
  });
  assert.equal(current.json().stage, 2);
  assert.equal(current.json().clock.rule_set_version, "v2026.2");
  assert.equal(current.json().clock.statutory_days, 30);

  // 已决定阶段拒绝回填事件。
  const backfill = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "emergency_extension",
      occurred_at: "2026-09-09T10:00:00.000Z",
      days: 2,
      reason: "试图回填",
    },
  });
  assert.equal(backfill.statusCode, 409);
  assert.equal(backfill.json().error.code, "EVENT_OUT_OF_ORDER");
  await app.close();
});

test("结案后拒绝追加事件与移交", async () => {
  const app = freshApp();
  await seedBasics(app);
  await createConfirmedCase(app);
  const decision = await app.inject({
    method: "POST",
    url: "/cases/case-1/stage-decisions",
    payload: {
      staff_id: "st-admin",
      decision: "调解成功，结案",
      issued_at: "2026-09-10T08:00:00.000Z",
      closes_case: true,
    },
  });
  assert.equal(decision.json().closed, true);

  const event = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "emergency_extension",
      occurred_at: "2026-09-11T01:00:00.000Z",
      days: 1,
      reason: "结案后申请",
    },
  });
  assert.equal(event.statusCode, 409);
  assert.equal(event.json().error.code, "CASE_CLOSED");

  const transfer = await app.inject({
    method: "POST",
    url: "/cases/case-1/transfers",
    payload: { staff_id: "st-admin", to_agency: "ag-zj", idempotency_key: "closed-1" },
  });
  assert.equal(transfer.statusCode, 409);
  assert.equal(transfer.json().error.code, "CASE_CLOSED");

  // 结案案件不再参与到期扫描。
  const scan = await app.inject({ method: "POST", url: "/internal/scan" });
  assert.equal(scan.json().scanned, 0);
  await app.close();
});
