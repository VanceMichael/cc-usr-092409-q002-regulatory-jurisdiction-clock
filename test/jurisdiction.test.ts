import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError, createTestContext, withFixedNow, type Context } from "../src/db.js";
import { freshContext, seedFixture, openStandardCase } from "./support.js";
import * as catalog from "../src/services/catalog.js";
import * as casesSvc from "../src/services/cases.js";
import * as rulingsSvc from "../src/services/rulings.js";
import * as ledger from "../src/services/ledger.js";
import * as transfersSvc from "../src/services/transfers.js";
import * as notify from "../src/services/notifications.js";
import { caseTimeline } from "../src/services/timeline.js";

const T0 = "2026-09-21T00:00:00Z"; // 周一 08:00（北京）

function expectError(code: string, fn: () => unknown) {
  try {
    fn();
    assert.fail(`应抛出 ${code}`);
  } catch (err) {
    assert.ok(err instanceof ServiceError, `期望 ServiceError，实际 ${String(err)}`);
    assert.equal((err as ServiceError).code, code);
  }
}

function expectThrows(pattern: RegExp, fn: () => unknown) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match((err as Error).message, pattern);
    return true;
  });
}

function standardCase(ctx: Context, caseNo = "TS-2026-0001") {
  return openStandardCase(ctx, {
    case_no: caseNo,
    subject: "跨省网购争议",
    consumer_region: "XJ",
    merchant_region: "CN",
    transaction_region: "CN",
    rule_version: "v2026.1",
    intake_agency: "A_CN",
    opened_by: "p_cn",
    stage_code: "review",
    claims: [
      { party_role: "consumer", party_name: "买买提", claimed_region: "XJ", statement: "应按常住地管辖" },
      { party_role: "merchant", party_name: "某电商", claimed_agency: "A_CN", statement: "应按商家地管辖" },
    ],
  });
}

test("立案留存各方主张、适用规则版本与证据水位", () => {
  const ctx = freshContext(T0);
  seedFixture(ctx);
  const opened = standardCase(ctx);
  const c = casesSvc.getCase(ctx, opened.case_id);
  assert.equal(c.rule_version, "v2026.1");

  const claims = casesSvc.listClaims(ctx, opened.case_id);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].statement, "应按常住地管辖");

  const r1 = casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k1", title: "订单", arrived_by: "p_cn", idempotency_key: "m1" });
  const r2 = casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k2", title: "支付凭证", arrived_by: "p_cn", idempotency_key: "m2" });
  assert.deepEqual([r1.watermark, r2.watermark], [1, 2]);
  // 幂等重放不抬升水位。
  const replay = casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k1", title: "订单", arrived_by: "p_cn", idempotency_key: "m1" });
  assert.equal(replay.duplicated, true);
  assert.equal(replay.watermark, 1);
});

test("管辖裁定：无授权或有利益冲突者被拒；合法裁定原子切换责任链且幂等", () => {
  const ctx = freshContext(T0);
  const f = seedFixture(ctx);
  const opened = standardCase(ctx);

  expectError("jurisdiction_not_authorized", () =>
    rulingsSvc.ruleJurisdiction(ctx, opened.case_id, { lead_agency: "A_CN", ruled_by: f.people.unauthorized, basis: "x", idempotency_key: "r0" }),
  );

  catalog.declareConflict(ctx, { case_id: opened.case_id, person_id: f.people.conflicted, reason: "当事人近亲属", declared_by: "admin" });
  expectError("conflict_of_interest", () =>
    rulingsSvc.ruleJurisdiction(ctx, opened.case_id, { lead_agency: "A_CN", ruled_by: f.people.conflicted, basis: "x", idempotency_key: "r1" }),
  );

  const result = rulingsSvc.ruleJurisdiction(ctx, opened.case_id, {
    lead_agency: "A_CN", co_agencies: ["A_XJ"], ruled_by: f.people.cn, basis: "商家主体在境内，由内地主办、新疆协办", idempotency_key: "r2",
  });
  assert.equal(result.ruling.evidence_watermark, 0);
  assert.equal(result.ruling.rule_version, "v2026.1");
  assert.equal(result.previous_link_closed, true);

  const link = rulingsSvc.currentLink(ctx, opened.case_id);
  assert.equal(link.agency_code, "A_CN");
  assert.equal(link.source, "ruling");

  // 重放同一幂等键：不产生第二条裁定、不再次切链。
  const replay = rulingsSvc.ruleJurisdiction(ctx, opened.case_id, {
    lead_agency: "A_CN", ruled_by: f.people.cn, basis: "商家主体在境内", idempotency_key: "r2",
  });
  assert.equal(replay.ruling.id, result.ruling.id);
  assert.equal(rulingsSvc.listLinks(ctx, opened.case_id).length, 2);
});

test("期限账本：补正与等待外部裁决暂停计时、恢复续计、延长受上限约束", () => {
  const ctx = freshContext(T0);
  seedFixture(ctx);
  const opened = standardCase(ctx);
  const c1 = withFixedNow(ctx, "2026-09-22T01:00:00Z");
  ledger.appendDeadlineEvent(c1, opened.case_id, { type: "supplement_request", actor: "p_cn", reason_code: "MATERIAL_INCOMPLETE", legal_basis: "办法§12", idempotency_key: "e1" });
  // 暂停中不能再暂停。
  expectError("invalid_clock_event", () =>
    ledger.appendDeadlineEvent(c1, opened.case_id, { type: "wait_external", actor: "p_cn", reason_code: "X", legal_basis: "y", idempotency_key: "e2" }),
  );
  // 未暂停不能恢复。
  expectError("invalid_clock_event", () =>
    ledger.appendDeadlineEvent(ctx, opened.case_id, { type: "resume", actor: "p_cn", reason_code: "R", legal_basis: "y", idempotency_key: "e0" }),
  );
  const c2 = withFixedNow(ctx, "2026-09-23T01:00:00Z");
  ledger.appendDeadlineEvent(c2, opened.case_id, { type: "resume", actor: "p_cn", reason_code: "MATERIAL_COMPLETED", legal_basis: "办法§12", idempotency_key: "e3" });

  const snap = ledger.buildStageClock(ctx, opened.case_id, opened.stage_id, "2026-09-23T05:00:00Z");
  assert.equal(snap.status, "running");
  assert.equal(snap.excluded_periods.length, 1);
  assert.equal(snap.excluded_periods[0].reason_code, "MATERIAL_INCOMPLETE");
  // 周一 480 + 周二 08:00-09:00（北京）20 + 周三 09:00-13:00（北京）80。
  assert.equal(snap.used_minutes, 480 + 20 + 80);

  // 紧急延长上限 3 天（事件时间必须顺延）。
  const cExt = withFixedNow(ctx, "2026-09-23T06:00:00Z");
  expectError("extension_cap_exceeded", () =>
    ledger.appendDeadlineEvent(cExt, opened.case_id, { type: "emergency_extension", occurred_at: "2026-09-23T06:00:00Z", actor: "p_cn", reason_code: "EMERGENCY", legal_basis: "办法§15", working_days: 4, idempotency_key: "x1" }),
  );
  ledger.appendDeadlineEvent(cExt, opened.case_id, { type: "emergency_extension", occurred_at: "2026-09-23T06:00:00Z", actor: "p_cn", reason_code: "EMERGENCY", legal_basis: "办法§15", working_days: 3, idempotency_key: "x2" });
  expectError("extension_cap_exceeded", () =>
    ledger.appendDeadlineEvent(cExt, opened.case_id, { type: "emergency_extension", occurred_at: "2026-09-23T06:01:00Z", actor: "p_cn", reason_code: "EMERGENCY", legal_basis: "办法§15", working_days: 1, idempotency_key: "x3" }),
  );
  // 事件追加幂等。
  const dup = ledger.appendDeadlineEvent(cExt, opened.case_id, { type: "emergency_extension", occurred_at: "2026-09-23T06:00:00Z", actor: "p_cn", reason_code: "EMERGENCY", legal_basis: "办法§15", working_days: 3, idempotency_key: "x2" });
  assert.equal(dup.type, "emergency_extension");
  const after = ledger.buildStageClock(ctx, opened.case_id, opened.stage_id, "2026-09-23T06:00:00Z");
  assert.equal(after.budget_minutes, 8 * 480);
});

test("决定出具钉死阶段与规则版本；换版与直接改写均不能回溯", () => {
  const ctx = freshContext(T0);
  seedFixture(ctx);
  const opened = standardCase(ctx, "TS-2026-DEC");

  const issued = ledger.issueDecision(ctx, opened.case_id, { decision_no: "DEC-1", issued_by: "p_cn", payload: { outcome: "支持消费者" }, idempotency_key: "d1" });
  assert.equal(issued.decision.rule_version, "v2026.1");
  assert.equal(issued.stage.rule_version, "v2026.1");
  assert.equal(issued.stage.working_days, 5);
  assert.equal(issued.snapshot.status, "closed");

  // 决定重放幂等。
  const replay = ledger.issueDecision(ctx, opened.case_id, { decision_no: "DEC-1", issued_by: "p_cn", idempotency_key: "d1" });
  assert.equal(replay.decision.id, issued.decision.id);

  // 已决定阶段不能再追加事件。
  expectError("no_open_stage", () =>
    ledger.appendDeadlineEvent(ctx, opened.case_id, { type: "wait_external", actor: "p_cn", reason_code: "X", legal_basis: "y", idempotency_key: "late" }),
  );

  // 规则正文不可原地修改（只能换版）。
  expectThrows(/规则版本正文一经发布不可改写/, () =>
    ctx.raw.prepare("UPDATE rule_versions SET payload_json = ? WHERE version = 'v2026.1'").run(JSON.stringify({ stage_working_days: { review: 30 }, emergency_extension_max_days: 0 })),
  );
  // 账本只追加、阶段钉选字段不可变。
  expectThrows(/decisions 一经出具不可改写/, () => ctx.raw.prepare("UPDATE decisions SET rule_version='v2026.2' WHERE id=?").run(issued.decision.id));
  expectThrows(/追加账本，禁止更新/, () => ctx.raw.prepare("UPDATE deadline_events SET reason_code='hacked' WHERE id=?").run(1));
  expectThrows(/钉选的规则版本与期限预算不可改写/, () => ctx.raw.prepare("UPDATE case_stages SET working_days=99 WHERE stage_id=?").run(opened.stage_id));

  // 新案适用新版 7 天，证明换版只影响之后开启的阶段。
  const next = openStandardCase(ctx, {
    case_no: "TS-2026-NEW", subject: "新案", rule_version: "v2026.2",
    intake_agency: "A_CN", opened_by: "p_cn", stage_code: "review",
  });
  const stage2 = ledger.listStages(ctx, next.case_id)[0];
  assert.equal(stage2.rule_version, "v2026.2");
  assert.equal(stage2.working_days, 7);

  // 历史时点回看旧决定：仍引用 v1 与当时的时钟快照。
  const history = caseTimeline(ctx, opened.case_id, T0);
  assert.equal(history.stages[0].decision!.rule_version, "v2026.1");
});

test("移交：冻结清单、同版签收原子生效、幂等、并发唯一链、途中材料待归属", () => {
  const ctx = freshContext(T0);
  const f = seedFixture(ctx);
  const opened = standardCase(ctx, "TS-2026-XFER");
  casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k1", title: "订单", arrived_by: "p_cn", idempotency_key: "m1" });
  casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k2", title: "聊天记录", arrived_by: "p_cn", idempotency_key: "m2" });
  rulingsSvc.ruleJurisdiction(ctx, opened.case_id, { lead_agency: "A_CN", ruled_by: "p_cn", basis: "商家地", idempotency_key: "r1" });

  // 非当前主办不能发起移交。
  expectError("not_responsible_agency", () =>
    transfersSvc.proposeTransfer(ctx, opened.case_id, { from_agency: "A_XJ", to_agency: "A_CN", proposed_by: "p_xj", idempotency_key: "t0" }),
  );

  const proposed = transfersSvc.proposeTransfer(ctx, opened.case_id, { from_agency: "A_CN", to_agency: "A_XJ", proposed_by: "p_cn", idempotency_key: "t1" });
  // 并发移交只能保留一条。
  expectError("transfer_in_flight", () =>
    transfersSvc.proposeTransfer(ctx, opened.case_id, { from_agency: "A_CN", to_agency: "A_XJ", proposed_by: "p_cn", idempotency_key: "t2" }),
  );
  // 在途期间不能插管辖裁定。
  expectError("transfer_in_flight", () =>
    rulingsSvc.ruleJurisdiction(ctx, opened.case_id, { lead_agency: "A_CN", ruled_by: "p_cn", basis: "x", idempotency_key: "r2" }),
  );
  // 发起幂等重放返回同一条。
  assert.equal(
    transfersSvc.proposeTransfer(ctx, opened.case_id, { from_agency: "A_CN", to_agency: "A_XJ", proposed_by: "p_cn", idempotency_key: "t1" }).id,
    proposed.id,
  );

  const frozen = transfersSvc.freezeTransfer(ctx, proposed.id, { frozen_by: "p_cn" });
  assert.equal(frozen.status, "frozen");
  const manifest = transfersSvc.manifestOf(frozen);
  assert.equal(manifest.length, 2);

  // 冻结后新到材料进入待归属区，不抬升水位。
  const late = casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k3", title: "冻结后补充照片", arrived_by: "consumer", idempotency_key: "m3" });
  assert.equal(late.material.status, "pending_attribution");
  assert.equal(late.watermark, 0);
  assert.equal(late.material.arrived_during_transfer_id, proposed.id);

  // 非接收机构人员不能签收。
  expectError("not_receiving_agency", () =>
    transfersSvc.receiveTransfer(ctx, proposed.id, { received_by: "p_cn", manifest_hash: frozen.manifest_hash, idempotency_key: "rcv1" }),
  );
  // 清单版本不一致拒绝签收。
  expectError("manifest_version_mismatch", () =>
    transfersSvc.receiveTransfer(ctx, proposed.id, { received_by: "p_xj", manifest_hash: "deadbeef", idempotency_key: "rcv1" }),
  );

  // 正确版本签收：原子生效，责任链切到 A_XJ。
  const received = transfersSvc.receiveTransfer(ctx, proposed.id, { received_by: "p_xj", manifest_hash: frozen.manifest_hash, idempotency_key: "rcv1" });
  assert.equal(received.transfer.status, "effective");
  assert.equal(received.new_link.agency_code, "A_XJ");
  assert.equal(received.new_link.source, "transfer");
  assert.equal(rulingsSvc.currentLink(ctx, opened.case_id).agency_code, "A_XJ");

  // 重复签收幂等：同键同 hash 返回原收据，不新增链路。
  const again = transfersSvc.receiveTransfer(ctx, proposed.id, { received_by: "p_xj", manifest_hash: frozen.manifest_hash, idempotency_key: "rcv1" });
  assert.equal(again.receipt.id, received.receipt.id);
  assert.equal(rulingsSvc.listLinks(ctx, opened.case_id).filter((l) => l.source === "transfer").length, 1);
  // 同键不同 hash 视为版本冲突。
  expectError("manifest_version_mismatch", () =>
    transfersSvc.receiveTransfer(ctx, proposed.id, { received_by: "p_xj", manifest_hash: "other", idempotency_key: "rcv1" }),
  );

  // 待归属材料由新主办认领，补取水位 3。
  const attributed = casesSvc.attributePendingMaterial(ctx, opened.case_id, late.material.id, { attribute: true, attributed_by: "p_xj", note: "签收" });
  assert.equal(attributed.status, "attributed");
  assert.equal(attributed.seq, 3);
  void f;
});

test("取消移交：冻结后到达的材料恢复签收并补取水位", () => {
  const ctx = freshContext(T0);
  seedFixture(ctx);
  const opened = standardCase(ctx, "TS-2026-CANCEL");
  casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k1", title: "订单", arrived_by: "p_cn", idempotency_key: "m1" });
  const proposed = transfersSvc.proposeTransfer(ctx, opened.case_id, { from_agency: "A_CN", to_agency: "A_XJ", proposed_by: "p_cn", idempotency_key: "t1" });
  transfersSvc.freezeTransfer(ctx, proposed.id, { frozen_by: "p_cn" });
  const late = casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k9", title: "途中材料", arrived_by: "x", idempotency_key: "m9" });
  assert.equal(late.material.status, "pending_attribution");
  // 取消前的时点：材料在未签收区。
  assert.equal(caseTimeline(ctx, opened.case_id, T0).unsigned_materials.length, 1);

  transfersSvc.cancelTransfer(ctx, proposed.id, { cancelled_by: "p_cn" });
  const restored = casesSvc.listMaterials(ctx, opened.case_id).find((m) => m.id === late.material.id)!;
  assert.equal(restored.status, "received");
  assert.equal(restored.seq, 2);
  // 取消后的时点：材料已恢复为原主办签收，不再出现在未签收区。
  assert.equal(caseTimeline(ctx, opened.case_id, T0).unsigned_materials.length, 0);
  // 取消后可以重新发起移交。
  const second = transfersSvc.proposeTransfer(ctx, opened.case_id, { from_agency: "A_CN", to_agency: "A_XJ", proposed_by: "p_cn", idempotency_key: "t2" });
  assert.equal(second.status, "proposed");
});

test("时点回放：负责机构、剩余时限、排除段、未签收材料、催办依据", () => {
  const ctx = freshContext(T0);
  seedFixture(ctx);
  const opened = standardCase(ctx, "TS-2026-TIME");
  casesSvc.receiveMaterial(ctx, opened.case_id, { material_key: "k1", title: "订单", arrived_by: "p_cn", idempotency_key: "m1" });
  rulingsSvc.ruleJurisdiction(ctx, opened.case_id, { lead_agency: "A_CN", ruled_by: "p_cn", basis: "商家地", idempotency_key: "r1" });

  const pauseAt = withFixedNow(ctx, "2026-09-22T01:00:00Z");
  ledger.appendDeadlineEvent(pauseAt, opened.case_id, { type: "supplement_request", actor: "p_cn", reason_code: "MATERIAL_INCOMPLETE", legal_basis: "办法§12", idempotency_key: "e1" });

  // 暂停时点（移交尚未发起）：负责机构 A_CN，时钟 paused，排除段开始，无到期时刻。
  const duringPause = caseTimeline(ctx, opened.case_id, "2026-09-22T01:30:00Z");
  assert.equal(duringPause.responsible_at!.agency_code, "A_CN");
  assert.equal(duringPause.stages[0].clock.status, "paused");
  assert.equal(duringPause.stages[0].clock.pause_basis!.legal_basis, "办法§12");
  assert.equal(duringPause.stages[0].clock.deadline_at, null);

  // 移交按时间推进：发起 -> 冻结 -> 途中材料 -> 签收生效。
  const cProp = withFixedNow(ctx, "2026-09-22T02:00:00Z");
  const proposed = transfersSvc.proposeTransfer(cProp, opened.case_id, { from_agency: "A_CN", to_agency: "A_XJ", proposed_by: "p_cn", idempotency_key: "t1" });
  const cFrozen = withFixedNow(ctx, "2026-09-22T03:00:00Z");
  const frozen = transfersSvc.freezeTransfer(cFrozen, proposed.id, { frozen_by: "p_cn" });
  const cLate = withFixedNow(ctx, "2026-09-22T04:00:00Z");
  const late = casesSvc.receiveMaterial(cLate, opened.case_id, { material_key: "k8", title: "途中新材料", arrived_by: "x", idempotency_key: "m8" });
  const cRecv = withFixedNow(ctx, "2026-09-22T05:00:00Z");
  transfersSvc.receiveTransfer(cRecv, proposed.id, { received_by: "p_xj", manifest_hash: frozen.manifest_hash, idempotency_key: "rcv1" });

  // 生效后时点：负责机构 A_XJ，未签收材料可见并标注所属移交。
  const after = caseTimeline(ctx, opened.case_id, "2026-09-23T08:00:00Z");
  assert.equal(after.responsible_at!.agency_code, "A_XJ");
  assert.equal(after.unsigned_materials.length, 1);
  assert.equal(after.unsigned_materials[0].id, late.material.id);
  assert.equal(after.unsigned_materials[0].arrived_during_transfer_id, proposed.id);
  assert.equal(after.transfers[0].status, "effective");

  // 催办在生效后时点留存实际依据。
  const cReminder = withFixedNow(ctx, "2026-09-23T08:00:00Z");
  const reminder = notify.createReminder(cReminder, opened.case_id, { created_by: "p_xj", note: "首次催办", idempotency_key: "rem1" });
  const basis = JSON.parse(reminder.basis_json) as { responsible_agency: string; pending_materials: unknown[]; clock: { excluded_periods: unknown[] } };
  assert.equal(basis.responsible_agency, "A_XJ");
  assert.equal(basis.pending_materials.length, 1);
  assert.equal(basis.clock.excluded_periods.length, 1);

  // 历史时点（一切移交发生之前）：负责 A_CN、无催办、无移交记录。
  const before = caseTimeline(ctx, opened.case_id, "2026-09-21T12:00:00Z");
  assert.equal(before.responsible_at!.agency_code, "A_CN");
  assert.equal(before.notifications.length, 0);
  assert.equal(before.transfers.length, 0);
  assert.equal(before.unsigned_materials.length, 0);
});

test("到期扫描：到期/逾期通知落库去重，进程重启后继续且不重复", () => {
  const ctx = freshContext(T0);
  seedFixture(ctx);
  // 临期案：周一 14:00（北京）立案，1 个工作日预算。
  const c0 = withFixedNow(ctx, "2026-09-21T06:00:00Z");
  const soon = openStandardCase(c0, {
    case_no: "TS-SOON", subject: "临期案", rule_version: "v2026.1",
    intake_agency: "A_CN", opened_by: "p_cn", stage_code: "review", working_days: 1,
  });
  const cScan = withFixedNow(ctx, "2026-09-21T08:00:00Z");
  const r1 = notify.runDueScan(cScan);
  assert.equal(r1.due_soon, 1);
  // 再次扫描不重复通知。
  const r2 = notify.runDueScan(cScan);
  assert.equal(r2.created.length, 0);
  assert.ok(notify.lastScanAt(cScan));

  // 普通案件；时间推进到 10-15，两个案件预算均用尽并仍在计时 -> 各一条逾期。
  standardCase(ctx, "TS-OVERDUE");
  const far = withFixedNow(ctx, "2026-10-15T00:00:00Z");
  const r3 = notify.runDueScan(far);
  assert.equal(r3.overdue, 2);
  const sameDayAgain = notify.runDueScan(far);
  assert.equal(sameDayAgain.created.length, 0);

  // 模拟进程重启：同库新连接，次日再扫，每案仅新增当日逾期，due_soon 不重复。
  const restarted = createTestContext(ctx.raw.name, "2026-10-16T00:00:00Z");
  const r4 = notify.runDueScan(restarted);
  assert.equal(r4.overdue, 2);
  assert.equal(r4.due_soon, 0);

  // TS-OVERDUE 的通知：15/16 两日各一条逾期，共 2 条；依据中含负责机构与排除段。
  const allOverdue = ctx.raw
    .prepare("SELECT n.id, n.basis_json FROM notifications n JOIN cases c ON c.case_id = n.case_id WHERE c.case_no = 'TS-OVERDUE' AND n.kind='overdue' ORDER BY n.id")
    .all() as { id: number; basis_json: string }[];
  assert.equal(allOverdue.length, 2);
  const basis = JSON.parse(allOverdue[0].basis_json) as {
    excluded_periods: unknown[];
    responsible_agency: string;
  };
  assert.equal(basis.responsible_agency, "A_CN");
  assert.ok(Array.isArray(basis.excluded_periods));
});
