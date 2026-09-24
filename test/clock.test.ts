import assert from "node:assert/strict";
import test from "node:test";
import {
  computeClock,
  buildIntervals,
  validateEventOrder,
  type TimerEvent,
  type ResponsibilitySegment,
  type CalendarPort,
} from "../src/domain/clock.js";

// CN: 2026-09-24（周四）休、2026-09-26（周六）上班；XJ 默认周一至周五。
const calendar: CalendarPort = {
  isWorkingDay(region, day) {
    if (region === "CN" && day === "2026-09-24") return false;
    if (region === "CN" && day === "2026-09-26") return true;
    const w = new Date(`${day}T00:00:00Z`).getUTCDay();
    return w !== 0 && w !== 6;
  },
};
const tz = new Map([
  ["CN", "Asia/Shanghai"],
  ["XJ", "Asia/Urumqi"],
]);

const open = (at: string): TimerEvent => ({ seq: 0, type: "open", occurred_at: at, actor: "a", reason_code: "STAGE_OPEN", legal_basis: "受理", payload: {} });
const ev = (seq: number, type: TimerEvent["type"], at: string, extra: Partial<TimerEvent> = {}): TimerEvent => ({
  seq, type, occurred_at: at, actor: "a", reason_code: extra.reason_code ?? "R", legal_basis: extra.legal_basis ?? "依据§1", payload: extra.payload ?? {},
});

test("工作日按分钟计期：同一工作日 4 小时计 80 分钟", () => {
  const links: ResponsibilitySegment[] = [{ agency_code: "A", region_code: "CN", source: "intake", effective_from: "2026-09-21T02:00:00Z", effective_to: null }];
  const snap = computeClock({ events: [open("2026-09-21T02:00:00Z")], links, baseWorkingDays: 5, tzByRegion: tz, calendar, asOf: "2026-09-21T06:00:00Z" });
  assert.equal(snap.status, "running");
  assert.equal(snap.used_minutes, 80);
  assert.equal(snap.remaining_minutes, 2320);
  assert.equal(snap.day_credits[0].local_day, "2026-09-21");
});

test("补正暂停区间完全排除，并给出暂停依据", () => {
  const links: ResponsibilitySegment[] = [{ agency_code: "A", region_code: "CN", source: "intake", effective_from: "2026-09-21T02:00:00Z", effective_to: null }];
  const events = [
    open("2026-09-21T02:00:00Z"),
    ev(1, "supplement_request", "2026-09-21T06:00:00Z", { reason_code: "MATERIAL_INCOMPLETE", legal_basis: "办法§12" }),
    ev(2, "resume", "2026-09-22T08:00:00Z", { reason_code: "MATERIAL_COMPLETED" }),
  ];
  const snap = computeClock({ events, links, baseWorkingDays: 5, tzByRegion: tz, calendar, asOf: "2026-09-22T12:00:00Z" });
  assert.equal(snap.status, "running");
  assert.equal(snap.used_minutes, 160); // 周一 4h + 周二 4h，26 小时暂停不计
  assert.equal(snap.excluded_periods.length, 1);
  assert.deepEqual(snap.excluded_periods[0], {
    from: "2026-09-21T06:00:00Z",
    to: "2026-09-22T08:00:00Z",
    reason_code: "MATERIAL_INCOMPLETE",
    legal_basis: "办法§12",
    actor: "a",
  });
});

test("等待外部裁决期间不出具预计到期时刻", () => {
  const links: ResponsibilitySegment[] = [{ agency_code: "A", region_code: "CN", source: "intake", effective_from: "2026-09-21T02:00:00Z", effective_to: null }];
  const events = [open("2026-09-21T02:00:00Z"), ev(1, "wait_external", "2026-09-22T00:00:00Z")];
  const snap = computeClock({ events, links, baseWorkingDays: 5, tzByRegion: tz, calendar, asOf: "2026-09-25T00:00:00Z" });
  assert.equal(snap.status, "paused");
  assert.equal(snap.ticking, false);
  assert.equal(snap.deadline_at, null);
  assert.equal(snap.paused_since, "2026-09-22T00:00:00Z");
});

test("节假日与调休逐日覆盖：09-24 不计、09-26 计", () => {
  const links: ResponsibilitySegment[] = [{ agency_code: "A", region_code: "CN", source: "intake", effective_from: "2026-09-21T00:00:00Z", effective_to: null }];
  const snap = computeClock({ events: [open("2026-09-21T00:00:00Z")], links, baseWorkingDays: 10, tzByRegion: tz, calendar, asOf: "2026-09-27T00:00:00Z" });
  const days = new Map(snap.day_credits.map((d) => [d.local_day, d.credited_minutes]));
  assert.equal(days.get("2026-09-24"), 0);
  assert.equal(days.get("2026-09-26"), 480);
  assert.ok(snap.non_working_days.some((d) => d.local_day === "2026-09-24"));
  assert.ok(!snap.non_working_days.some((d) => d.local_day === "2026-09-26"));
});

test("责任链跨地区时按切换瞬间分段，各段适用当地日历", () => {
  const links: ResponsibilitySegment[] = [
    { agency_code: "A", region_code: "CN", source: "ruling", effective_from: "2026-09-21T02:00:00Z", effective_to: "2026-09-23T00:00:00Z" },
    { agency_code: "B", region_code: "XJ", source: "transfer", effective_from: "2026-09-23T00:00:00Z", effective_to: null },
  ];
  const events = [open("2026-09-21T02:00:00Z")];
  const snap = computeClock({ events, links, baseWorkingDays: 10, tzByRegion: tz, calendar, asOf: "2026-09-23T06:00:00Z" });
  const regions = new Set(snap.day_credits.map((d) => `${d.region_code}:${d.local_day}`));
  assert.ok(regions.has("CN:2026-09-21"));
  assert.ok(regions.has("CN:2026-09-22"));
  assert.ok(regions.has("XJ:2026-09-23"));
  assert.deepEqual(snap.region_slices.map((s) => s.region_code), ["CN", "XJ"]);
});

test("紧急延长追加预算，不改变已用计时", () => {
  const links: ResponsibilitySegment[] = [{ agency_code: "A", region_code: "CN", source: "intake", effective_from: "2026-09-21T02:00:00Z", effective_to: null }];
  const events = [
    open("2026-09-21T02:00:00Z"),
    ev(1, "emergency_extension", "2026-09-22T00:00:00Z", { payload: { working_days: 3 } }),
  ];
  const snap = computeClock({ events, links, baseWorkingDays: 5, tzByRegion: tz, calendar, asOf: "2026-09-22T00:00:00Z" });
  assert.equal(snap.budget_minutes, 8 * 480);
  assert.equal(snap.emergency_added_minutes, 3 * 480);
});

test("决定出具（close）后时钟停止，之后时间不再计期", () => {
  const links: ResponsibilitySegment[] = [{ agency_code: "A", region_code: "CN", source: "intake", effective_from: "2026-09-21T02:00:00Z", effective_to: null }];
  const events = [
    open("2026-09-21T02:00:00Z"),
    ev(1, "close", "2026-09-22T02:00:00Z", { reason_code: "DECISION_ISSUED" }),
  ];
  const atClose = computeClock({ events, links, baseWorkingDays: 5, tzByRegion: tz, calendar, asOf: "2026-09-22T02:00:00Z" });
  const weeksLater = computeClock({ events, links, baseWorkingDays: 5, tzByRegion: tz, calendar, asOf: "2026-10-02T02:00:00Z" });
  assert.equal(atClose.status, "closed");
  assert.equal(weeksLater.status, "closed");
  assert.equal(weeksLater.used_minutes, atClose.used_minutes);
  assert.equal(weeksLater.deadline_at, null);
});

test("预计到期时刻：1 个工作日预算从周一 08:00（北京）到次日 08:00", () => {
  const links: ResponsibilitySegment[] = [{ agency_code: "A", region_code: "CN", source: "intake", effective_from: "2026-09-21T00:00:00Z", effective_to: null }];
  const snap = computeClock({ events: [open("2026-09-21T00:00:00Z")], links, baseWorkingDays: 1, tzByRegion: tz, calendar, asOf: "2026-09-21T00:00:00Z" });
  assert.equal(snap.deadline_at, "2026-09-22T00:00:00.000Z");
});

test("状态机：未暂停不能恢复、重复开启非法、时间不倒置", () => {
  assert.throws(() => buildIntervals([open("2026-09-21T02:00:00Z"), open("2026-09-21T03:00:00Z")]), /不能重复 open/);
  assert.throws(
    () => validateEventOrder([open("2026-09-21T02:00:00Z"), ev(1, "resume", "2026-09-21T05:00:00Z")]),
    /未处于暂停状态/,
  );
  assert.throws(
    () => validateEventOrder([open("2026-09-21T05:00:00Z"), ev(1, "supplement_request", "2026-09-21T04:00:00Z")]),
    /时间不可早于前一事件/,
  );
});
