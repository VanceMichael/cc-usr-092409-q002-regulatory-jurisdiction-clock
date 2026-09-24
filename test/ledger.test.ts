import assert from "node:assert/strict";
import test from "node:test";

import { workdayRuleFromOverrides } from "../src/calendar.js";
import { computeLedger, type LedgerEventInput, type ResponsibilitySpan } from "../src/ledger.js";

const NO_OVERRIDES = workdayRuleFromOverrides(new Map());

function ledgerOf(
  events: LedgerEventInput[],
  at: string,
  options: {
    statutoryDays?: number;
    responsibility?: ResponsibilitySpan[];
    isWorkday?: typeof NO_OVERRIDES;
  } = {},
) {
  return computeLedger({
    acceptedAt: "2026-09-01T02:00:00.000Z",
    events: [{ eventType: "accepted", occurredAt: "2026-09-01T02:00:00.000Z", payload: {} }, ...events],
    ruleSetVersion: "v2026.1",
    statutoryDays: options.statutoryDays ?? 10,
    responsibility: options.responsibility ?? [],
    fallbackRegion: "SH",
    isWorkday: options.isWorkday ?? NO_OVERRIDES,
    at,
  });
}

test("无暂停时按工作日计数并给出预计到期日", () => {
  // 2026-09-01 为周二；受理次日起 10 个工作日 → 09-15（周二）。
  const ledger = ledgerOf([], "2026-09-08T12:00:00.000Z");
  assert.equal(ledger.state, "running");
  assert.equal(ledger.consumedWorkdays, 5); // 2,3,4,7,8
  assert.equal(ledger.remainingWorkdays, 5);
  assert.equal(ledger.projectedDeadline, "2026-09-15");
  assert.equal(ledger.overdue, false);
});

test("补正暂停段按整日排除并说明依据", () => {
  const ledger = ledgerOf(
    [
      {
        eventType: "supplement_requested",
        occurredAt: "2026-09-03T10:00:00.000Z",
        payload: { basis: "补正期间不计入办理期限（规则v2026.1第12条）" },
      },
      {
        eventType: "supplement_received",
        occurredAt: "2026-09-08T09:00:00.000Z",
        payload: {},
      },
    ],
    "2026-09-10T23:00:00.000Z",
  );
  // 排除 09-03..09-07；计数 2,8,9,10 = 4。
  assert.equal(ledger.consumedWorkdays, 4);
  assert.equal(ledger.remainingWorkdays, 6);
  assert.equal(ledger.excludedPeriods.length, 1);
  assert.equal(ledger.excludedPeriods[0].reason, "supplement");
  assert.equal(ledger.excludedPeriods[0].to, "2026-09-08T09:00:00.000Z");
  assert.match(ledger.excludedPeriods[0].basis, /补正期间不计入办理期限/);
  // 到期日相应顺延：10 个工作日 → 09-18（周五）。
  assert.equal(ledger.projectedDeadline, "2026-09-18");
});

test("暂停未结束时剩余时限冻结且不再给出预计到期日", () => {
  const ledger = ledgerOf(
    [
      {
        eventType: "external_wait_started",
        occurredAt: "2026-09-04T10:00:00.000Z",
        payload: { basis: "等待司法裁决期间不计入办理期限" },
      },
    ],
    "2026-09-20T00:00:00.000Z",
  );
  assert.equal(ledger.state, "paused");
  assert.equal(ledger.consumedWorkdays, 2); // 仅 09-02、09-03
  assert.equal(ledger.remainingWorkdays, 8);
  assert.equal(ledger.projectedDeadline, null);
  assert.equal(ledger.excludedPeriods[0].to, null);
});

test("紧急延长期增加时限上限", () => {
  const ledger = ledgerOf(
    [
      {
        eventType: "emergency_extension",
        occurredAt: "2026-09-05T10:00:00.000Z",
        payload: { days: 5, reason: "突发公共事件" },
      },
    ],
    "2026-09-08T12:00:00.000Z",
  );
  assert.equal(ledger.extensionDays, 5);
  assert.equal(ledger.limitDays, 15);
  assert.equal(ledger.remainingWorkdays, 10);
  assert.equal(ledger.projectedDeadline, "2026-09-22"); // 15 个工作日
});

test("节假日覆盖按负责机构当地日历生效", () => {
  const isWorkday = workdayRuleFromOverrides(new Map([["SH:2026-09-02", false]]));
  const ledger = ledgerOf([], "2026-09-04T23:00:00.000Z", { isWorkday });
  assert.equal(ledger.consumedWorkdays, 2); // 09-02 节假日，计 3、4 日
});

test("移交后按新主办机构地区日历计数", () => {
  const responsibility: ResponsibilitySpan[] = [
    { agencyId: "ag-sh", region: "SH", startedAt: "2026-09-01T06:00:00.000Z", endedAt: "2026-09-05T00:00:00.000Z" },
    { agencyId: "ag-zj", region: "ZJ", startedAt: "2026-09-05T00:00:00.000Z", endedAt: null },
  ];
  const isWorkday = workdayRuleFromOverrides(
    new Map([
      ["SH:2026-09-03", false], // 上海 09-03 节假日
      ["ZJ:2026-09-08", false], // 浙江 09-08 节假日
    ]),
  );
  const ledger = ledgerOf([], "2026-09-09T23:00:00.000Z", { responsibility, isWorkday });
  // 计数：09-02(SH)、09-04(SH)、09-07(ZJ)、09-09(ZJ) = 4；09-03、09-08 为各自当地节假日。
  assert.equal(ledger.consumedWorkdays, 4);
});

test("超过时限后剩余为负并标记逾期", () => {
  const ledger = ledgerOf([], "2026-09-20T00:00:00.000Z");
  assert.equal(ledger.consumedWorkdays, 13);
  assert.equal(ledger.remainingWorkdays, -3);
  assert.equal(ledger.overdue, true);
});
