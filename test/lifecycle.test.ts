import assert from "node:assert/strict";
import test from "node:test";

import { createCase, createConfirmedCase, freshApp, seedBasics } from "./helpers.js";

test("受理保存主张、规则版本与证据水位", async () => {
  const app = freshApp();
  await seedBasics(app);
  const created = await createCase(app);
  assert.equal(created.statusCode, 201);

  const detail = await app.inject({ method: "GET", url: "/cases/case-1" });
  const body = detail.json();
  assert.equal(body.rule_set_version, "v2026.1");
  assert.equal(body.evidence_watermark, "evt-100");
  assert.equal(body.claims.length, 2);
  assert.equal(body.claims[0].party_role, "consumer");
  await app.close();
});

test("受理时规则版本必须已发布", async () => {
  const app = freshApp();
  await seedBasics(app);
  const response = await createCase(app, { rule_set_version: "v9999.0" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "RULE_SET_UNKNOWN");
  await app.close();
});

test("管辖确认要求权限且无利益冲突", async () => {
  const app = freshApp();
  await seedBasics(app);
  await app.inject({
    method: "POST",
    url: "/staff",
    payload: {
      staff_id: "st-conflicted",
      display_name: "利益相关人员",
      agency_id: "ag-sh",
      permissions: ["jurisdiction.confirm"],
      conflict_regions: ["ZJ"],
    },
  });
  await app.inject({
    method: "POST",
    url: "/staff",
    payload: {
      staff_id: "st-noperm",
      display_name: "无权限人员",
      agency_id: "ag-sh",
      permissions: [],
      conflict_regions: [],
    },
  });
  await createCase(app);

  const unknown = await app.inject({
    method: "POST",
    url: "/cases/case-1/jurisdiction",
    payload: { staff_id: "st-ghost", lead_agency: "ag-sh" },
  });
  assert.equal(unknown.statusCode, 403);
  assert.equal(unknown.json().error.code, "STAFF_UNKNOWN");

  const noPerm = await app.inject({
    method: "POST",
    url: "/cases/case-1/jurisdiction",
    payload: { staff_id: "st-noperm", lead_agency: "ag-sh" },
  });
  assert.equal(noPerm.statusCode, 403);
  assert.equal(noPerm.json().error.code, "STAFF_FORBIDDEN");

  // 商家主体地 ZJ 与该人员冲突地区重叠。
  const conflicted = await app.inject({
    method: "POST",
    url: "/cases/case-1/jurisdiction",
    payload: { staff_id: "st-conflicted", lead_agency: "ag-sh" },
  });
  assert.equal(conflicted.statusCode, 403);
  assert.equal(conflicted.json().error.code, "STAFF_CONFLICT_OF_INTEREST");

  const confirmed = await app.inject({
    method: "POST",
    url: "/cases/case-1/jurisdiction",
    payload: {
      staff_id: "st-admin",
      lead_agency: "ag-sh",
      co_agencies: ["ag-zj"],
      decided_at: "2026-09-01T06:00:00.000Z",
    },
  });
  assert.equal(confirmed.statusCode, 201);
  assert.equal(confirmed.json().lead_agency, "ag-sh");

  const again = await app.inject({
    method: "POST",
    url: "/cases/case-1/jurisdiction",
    payload: { staff_id: "st-admin", lead_agency: "ag-zj" },
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, "JURISDICTION_CONFIRMED");
  await app.close();
});

test("补正、等待裁决、恢复办理按状态机追加并解释暂停依据", async () => {
  const app = freshApp();
  await seedBasics(app);
  await createConfirmedCase(app);

  const badResume = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: { staff_id: "st-admin", event_type: "resumed", occurred_at: "2026-09-02T01:00:00.000Z" },
  });
  assert.equal(badResume.statusCode, 409);
  assert.equal(badResume.json().error.code, "NO_MATCHING_PAUSE");

  const pause = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "supplement_requested",
      occurred_at: "2026-09-03T10:00:00.000Z",
    },
  });
  assert.equal(pause.statusCode, 201);
  assert.equal(pause.json().ledger.clock.state, "paused");
  assert.match(pause.json().event.payload.basis, /补正期间不计入办理期限/);

  const doublePause = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "external_wait_started",
      occurred_at: "2026-09-04T10:00:00.000Z",
    },
  });
  assert.equal(doublePause.statusCode, 409);
  assert.equal(doublePause.json().error.code, "PAUSE_ALREADY_OPEN");

  const wrongClose = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "external_wait_ended",
      occurred_at: "2026-09-05T10:00:00.000Z",
    },
  });
  assert.equal(wrongClose.statusCode, 409);
  assert.equal(wrongClose.json().error.code, "NO_MATCHING_PAUSE");

  const resume = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "supplement_received",
      occurred_at: "2026-09-08T09:00:00.000Z",
    },
  });
  assert.equal(resume.statusCode, 201);
  assert.equal(resume.json().ledger.clock.state, "running");

  const outOfOrder = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "resumed",
      occurred_at: "2026-09-01T00:00:00.000Z",
    },
  });
  assert.equal(outOfOrder.statusCode, 409);
  assert.equal(outOfOrder.json().error.code, "EVENT_OUT_OF_ORDER");
  await app.close();
});

test("紧急延长期受规则版本上限约束", async () => {
  const app = freshApp();
  await seedBasics(app);
  await createConfirmedCase(app);

  const first = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "emergency_extension",
      occurred_at: "2026-09-05T10:00:00.000Z",
      days: 3,
      reason: "台风导致物流中断",
    },
  });
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().ledger.clock.limit_days, 13);

  const second = await app.inject({
    method: "POST",
    url: "/cases/case-1/events",
    payload: {
      staff_id: "st-admin",
      event_type: "emergency_extension",
      occurred_at: "2026-09-06T10:00:00.000Z",
      days: 3,
      reason: "再次申请",
    },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, "EXTENSION_LIMIT_EXCEEDED");
  await app.close();
});

test("管辖未确认时仍可查询账本，负责机构为空", async () => {
  const app = freshApp();
  await seedBasics(app);
  await createCase(app);
  const response = await app.inject({
    method: "GET",
    url: "/cases/case-1/ledger?at=2026-09-08T00:00:00.000Z",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.responsible.lead_agency, null);
  assert.equal(body.clock.consumed_workdays, 5); // 暂按交易发生地日历计数
  await app.close();
});

test("时点查询返回负责机构、剩余时限、排除时间段与未签收材料", async () => {
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
      occurred_at: "2026-09-08T09:00:00.000Z",
    },
  });

  const early = await app.inject({
    method: "GET",
    url: "/cases/case-1/ledger?at=2026-08-31T00:00:00.000Z",
  });
  assert.equal(early.statusCode, 400);
  assert.equal(early.json().error.code, "AT_BEFORE_ACCEPTANCE");

  const response = await app.inject({
    method: "GET",
    url: "/cases/case-1/ledger?at=2026-09-10T23:00:00.000Z",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.responsible.lead_agency, "ag-sh");
  assert.deepEqual(body.responsible.co_agencies, ["ag-zj"]);
  assert.equal(body.clock.consumed_workdays, 4);
  assert.equal(body.clock.remaining_workdays, 6);
  assert.equal(body.clock.projected_deadline, "2026-09-18");
  assert.equal(body.excluded_periods.length, 1);
  assert.equal(body.excluded_periods[0].reason, "supplement");
  assert.match(body.excluded_periods[0].basis, /补正期间不计入办理期限/);
  assert.deepEqual(body.unsigned_materials, []);
  assert.deepEqual(body.reminders, []);
  await app.close();
});
