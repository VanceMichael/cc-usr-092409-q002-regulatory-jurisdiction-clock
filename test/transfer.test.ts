import assert from "node:assert/strict";
import test from "node:test";

import { createConfirmedCase, freshApp, seedBasics } from "./helpers.js";

/** 业务时间线固定在过去，应用时钟也要可控，否则冻结/生效时间落在查询时点之后。 */
function timedApp(start: string) {
  let current = new Date(start);
  const app = freshApp({ now: () => current });
  return {
    app,
    setTime: (iso: string) => {
      current = new Date(iso);
    },
  };
}

async function addMaterial(
  app: ReturnType<typeof freshApp>,
  label: string,
  receivedAt = "2026-09-02T01:00:00.000Z",
) {
  const response = await app.inject({
    method: "POST",
    url: "/cases/case-1/materials",
    payload: { staff_id: "st-admin", label, content_hash: `hash-${label}`, received_at: receivedAt },
  });
  return response;
}

async function initiateTransfer(app: ReturnType<typeof freshApp>, key = "idem-1") {
  return app.inject({
    method: "POST",
    url: "/cases/case-1/transfers",
    payload: {
      staff_id: "st-admin",
      to_agency: "ag-zj",
      reason: "商家主体地位于浙江",
      idempotency_key: key,
    },
  });
}

test("移交冻结清单、签收原子生效，途中材料进入待归属区", async () => {
  const { app, setTime } = timedApp("2026-09-04T10:00:00.000Z");
  await seedBasics(app);
  await createConfirmedCase(app);
  await addMaterial(app, "m1");
  await addMaterial(app, "m2");

  const initiated = await initiateTransfer(app);
  assert.equal(initiated.statusCode, 201);
  const transfer = initiated.json();
  assert.equal(transfer.state, "frozen");
  assert.equal(transfer.manifest_version, 1);
  assert.equal(transfer.manifest.length, 2);
  assert.equal(transfer.frozen_materials, 2);

  // 冻结后到达的新材料不进清单，进入待归属区。
  const late = await addMaterial(app, "m3", "2026-09-05T01:00:00.000Z");
  assert.equal(late.json().state, "pending_attribution");
  assert.equal(late.json().held_for_transfer, transfer.transfer_id);

  // 在途期间查询：m1/m2 在途未签收，m3 待归属。
  const during = await app.inject({
    method: "GET",
    url: "/cases/case-1/ledger?at=2026-09-06T00:00:00.000Z",
  });
  const unsigned = during.json().unsigned_materials;
  assert.equal(unsigned.length, 3);
  assert.deepEqual(
    unsigned.map((m: { state: string }) => m.state).sort(),
    ["in_transit", "in_transit", "pending_attribution"],
  );

  // 同一幂等键重复发起返回首次结果。
  const replay = await initiateTransfer(app);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replay, true);
  assert.equal(replay.json().transfer_id, transfer.transfer_id);

  // 在途时不得再发起新的移交。
  const second = await initiateTransfer(app, "idem-2");
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, "TRANSFER_IN_FLIGHT");

  // 签收方必须是接收机构人员，且清单版本必须一致。
  const wrongAgency = await app.inject({
    method: "POST",
    url: `/transfers/${transfer.transfer_id}/sign`,
    payload: { staff_id: "st-admin", manifest_version: 1 },
  });
  assert.equal(wrongAgency.statusCode, 403);
  assert.equal(wrongAgency.json().error.code, "STAFF_FORBIDDEN");

  const wrongVersion = await app.inject({
    method: "POST",
    url: `/transfers/${transfer.transfer_id}/sign`,
    payload: { staff_id: "st-zj", manifest_version: 99 },
  });
  assert.equal(wrongVersion.statusCode, 409);
  assert.equal(wrongVersion.json().error.code, "MANIFEST_MISMATCH");

  setTime("2026-09-07T10:00:00.000Z");
  const signed = await app.inject({
    method: "POST",
    url: `/transfers/${transfer.transfer_id}/sign`,
    payload: { staff_id: "st-zj", manifest_version: 1 },
  });
  assert.equal(signed.statusCode, 200);
  assert.equal(signed.json().state, "effective");
  assert.equal(signed.json().replay, false);
  const effectiveAt = signed.json().effective_at;

  // 重复签收幂等：返回首次生效结果，不重复推进责任链。
  const resigned = await app.inject({
    method: "POST",
    url: `/transfers/${transfer.transfer_id}/sign`,
    payload: { staff_id: "st-zj", manifest_version: 1 },
  });
  assert.equal(resigned.statusCode, 200);
  assert.equal(resigned.json().replay, true);
  assert.equal(resigned.json().effective_at, effectiveAt);

  // 责任链：生效前主办为上海，生效后为浙江，全程只有一条有效责任段。
  const before = await app.inject({
    method: "GET",
    url: `/cases/case-1/ledger?at=${encodeURIComponent("2026-09-06T00:00:00.000Z")}`,
  });
  assert.equal(before.json().responsible.lead_agency, "ag-sh");
  const after = await app.inject({
    method: "GET",
    url: `/cases/case-1/ledger?at=${encodeURIComponent("2026-12-31T00:00:00.000Z")}`,
  });
  assert.equal(after.json().responsible.lead_agency, "ag-zj");
  assert.equal(after.json().responsible.lead_region, "ZJ");

  const detail = await app.inject({ method: "GET", url: "/cases/case-1" });
  assert.equal(detail.json().current_lead.agency_id, "ag-zj");
  assert.equal(detail.json().current_lead.seq, 2);
  assert.equal(detail.json().material_counts.transferred, 2);
  assert.equal(detail.json().material_counts.pending_attribution, 1);

  // 生效后待归属材料由接收方归属入卷。
  const materialId = late.json().material_id;
  const attributed = await app.inject({
    method: "POST",
    url: `/cases/case-1/materials/${materialId}/attribute`,
    payload: { staff_id: "st-zj" },
  });
  assert.equal(attributed.statusCode, 200);
  assert.equal(attributed.json().state, "filed");

  // 签收完成后不再存在未签收材料。
  const settled = await app.inject({
    method: "GET",
    url: `/cases/case-1/ledger?at=${encodeURIComponent("2026-12-31T00:00:00.000Z")}`,
  });
  assert.deepEqual(settled.json().unsigned_materials, []);
  await app.close();
});

test("取消在途移交后材料回卷，已取消移交不能签收", async () => {
  const { app } = timedApp("2026-09-04T10:00:00.000Z");
  await seedBasics(app);
  await createConfirmedCase(app);
  await addMaterial(app, "m1");

  const initiated = await initiateTransfer(app);
  const transferId = initiated.json().transfer_id;

  const cancelled = await app.inject({
    method: "POST",
    url: `/transfers/${transferId}/cancel`,
    payload: { staff_id: "st-admin" },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().state, "cancelled");

  const detail = await app.inject({ method: "GET", url: "/cases/case-1" });
  assert.equal(detail.json().material_counts.filed, 1);

  const sign = await app.inject({
    method: "POST",
    url: `/transfers/${transferId}/sign`,
    payload: { staff_id: "st-zj", manifest_version: 1 },
  });
  assert.equal(sign.statusCode, 409);
  assert.equal(sign.json().error.code, "TRANSFER_CANCELLED");

  // 取消后可以再次发起移交。
  const again = await initiateTransfer(app, "idem-3");
  assert.equal(again.statusCode, 201);
  await app.close();
});

test("并发发起与并发签收都只保留一条有效责任链", async () => {
  const { app } = timedApp("2026-09-04T10:00:00.000Z");
  await seedBasics(app);
  await createConfirmedCase(app);
  await addMaterial(app, "m1");

  // 并发发起：一个成功，其余被在途唯一约束拒绝。
  const [a, b] = await Promise.all([initiateTransfer(app, "race-1"), initiateTransfer(app, "race-2")]);
  const statuses = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(statuses, [201, 409]);
  const winner = a.statusCode === 201 ? a.json() : b.json();

  // 并发签收：幂等保证都拿到同一生效结果，责任链只推进一次。
  const [s1, s2] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/transfers/${winner.transfer_id}/sign`,
      payload: { staff_id: "st-zj", manifest_version: 1 },
    }),
    app.inject({
      method: "POST",
      url: `/transfers/${winner.transfer_id}/sign`,
      payload: { staff_id: "st-zj", manifest_version: 1 },
    }),
  ]);
  assert.equal(s1.statusCode, 200);
  assert.equal(s2.statusCode, 200);
  assert.equal(s1.json().effective_at, s2.json().effective_at);

  const detail = await app.inject({ method: "GET", url: "/cases/case-1" });
  assert.equal(detail.json().current_lead.agency_id, "ag-zj");
  assert.equal(detail.json().current_lead.seq, 2);
  await app.close();
});
