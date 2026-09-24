// 期限时钟引擎：纯函数，不访问数据库。
// 计时规则：
//  - 仅工作日计期，默认周一至周五；calendar_days 可逐日覆盖（节假日/调休）。
//  - 一个工作日按 480 分钟计；日内按比例积分（elapsed * 480/1440），因此开始当日从开始时刻计。
//  - 补正、等待外部裁决为暂停区间，区间内完全排除；恢复后续计。
//  - 紧急延长以工作日追加预算，不改变已发生的计时。
//  - 责任链切换地区时，按切换瞬间切分，各段适用接收地区日历。
//  - 阶段关闭（决定出具）后时钟停止，预算是否用尽都不再计期。

export const WORKING_MINUTES_PER_DAY = 480;

export type TimerEventType =
  | "open"
  | "supplement_request"
  | "wait_external"
  | "resume"
  | "emergency_extension"
  | "close";

export interface TimerEvent {
  seq: number;
  type: TimerEventType;
  occurred_at: string;
  actor: string;
  reason_code: string;
  legal_basis: string;
  payload: { working_days?: number };
}

export interface ResponsibilitySegment {
  agency_code: string;
  region_code: string;
  source: "intake" | "ruling" | "transfer";
  effective_from: string; // UTC ISO
  effective_to: string | null;
}

export interface CalendarPort {
  isWorkingDay(regionCode: string, localDay: string): boolean;
}

export interface TimerInterval {
  state: "running" | "paused";
  from: string;
  to: string | null;
  pause_type?: "supplement_request" | "wait_external";
  reason_code: string;
  legal_basis: string;
  actor: string;
  event_seq: number;
}

export interface ExcludedPeriod {
  from: string;
  to: string | null;
  reason_code: string;
  legal_basis: string;
  actor: string;
}

export interface RegionSlice {
  from: string;
  to: string | null;
  agency_code: string;
  region_code: string;
}

export interface DayCredit {
  region_code: string;
  local_day: string;
  working: boolean;
  credited_minutes: number;
}

export interface ClockSnapshot {
  status: "running" | "paused" | "closed";
  budget_minutes: number;
  used_minutes: number;
  remaining_minutes: number;
  ticking: boolean;
  deadline_at: string | null;
  paused_since: string | null;
  pause_basis: { reason_code: string; legal_basis: string } | null;
  closed_at: string | null;
  intervals: TimerInterval[];
  excluded_periods: ExcludedPeriod[];
  region_slices: RegionSlice[];
  day_credits: DayCredit[];
  non_working_days: { region_code: string; local_day: string }[];
  emergency_added_minutes: number;
}

export class ClockRuleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClockRuleError";
    this.code = code;
  }
}

// ---- 时间与时区工具 --------------------------------------------------------

function utcMs(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new ClockRuleError("bad_timestamp", `非法时间戳: ${iso}`);
  return t;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

const dayKey = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** 取 UTC 瞬间在指定 IANA 时区的本地墙钟分量。 */
function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

function localDayKey(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return dayKey(p.year, p.month, p.day);
}

/** 当地某日 00:00 对应的 UTC 毫秒（用两个瞬间插值固定偏移）。 */
function localMidnightUtc(day: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const local = zonedParts(noonUtc, timeZone);
  const offsetMs =
    Date.UTC(local.year, local.month, local.day, local.hour, local.minute, local.second) - noonUtc;
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
}

// ---- 事件 -> 计时区间 -------------------------------------------------------

export function buildIntervals(events: TimerEvent[]): TimerInterval[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const intervals: TimerInterval[] = [];
  let state: "running" | "paused" | "closed" = "closed";
  for (const e of ordered) {
    switch (e.type) {
      case "open":
        if (state !== "closed") throw new ClockRuleError("invalid_event", "阶段已开启，不能重复 open");
        intervals.push({ state: "running", from: e.occurred_at, to: null, reason_code: e.reason_code, legal_basis: e.legal_basis, actor: e.actor, event_seq: e.seq });
        state = "running";
        break;
      case "supplement_request":
      case "wait_external":
        if (state !== "running") throw new ClockRuleError("invalid_event", `当前非计时状态，不能追加 ${e.type}`);
        intervals[intervals.length - 1].to = e.occurred_at;
        intervals.push({ state: "paused", from: e.occurred_at, to: null, pause_type: e.type, reason_code: e.reason_code, legal_basis: e.legal_basis, actor: e.actor, event_seq: e.seq });
        state = "paused";
        break;
      case "resume":
        if (state !== "paused") throw new ClockRuleError("invalid_event", "未处于暂停状态，不能 resume");
        intervals[intervals.length - 1].to = e.occurred_at;
        intervals.push({ state: "running", from: e.occurred_at, to: null, reason_code: e.reason_code, legal_basis: e.legal_basis, actor: e.actor, event_seq: e.seq });
        state = "running";
        break;
      case "emergency_extension":
        if (state === "closed") throw new ClockRuleError("invalid_event", "阶段已关闭，不能延长");
        break;
      case "close":
        if (state === "closed") throw new ClockRuleError("invalid_event", "阶段已关闭，不能重复 close");
        intervals[intervals.length - 1].to = e.occurred_at;
        state = "closed";
        break;
    }
  }
  return intervals;
}

/** 校验相邻事件时间不倒置；open 必须最先且唯一。 */
export function validateEventOrder(events: TimerEvent[]) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0 || ordered[0].type !== "open") {
    throw new ClockRuleError("invalid_event", "期限账本必须以 open 事件开始");
  }
  for (let i = 1; i < ordered.length; i++) {
    if (utcMs(ordered[i].occurred_at) < utcMs(ordered[i - 1].occurred_at)) {
      throw new ClockRuleError("event_time_regression", "期限事件时间不可早于前一事件");
    }
  }
  buildIntervals(ordered);
}

export function budgetMinutes(events: TimerEvent[], baseWorkingDays: number): number {
  let budget = baseWorkingDays * WORKING_MINUTES_PER_DAY;
  for (const e of events) {
    if (e.type === "emergency_extension") {
      const add = Number(e.payload.working_days ?? 0);
      if (!Number.isInteger(add) || add <= 0) {
        throw new ClockRuleError("invalid_extension", "紧急延长必须给出正整数工作日");
      }
      budget += add * WORKING_MINUTES_PER_DAY;
    }
  }
  return budget;
}

// ---- 切片：计时区间 × 责任地区 ---------------------------------------------

function overlap(aFrom: number, aTo: number | null, bFrom: number, bTo: number | null) {
  const to = aTo === null ? bTo : bTo === null ? aTo : Math.min(aTo, bTo);
  const from = Math.max(aFrom, bFrom);
  if (to !== null && to <= from) return null;
  return { from, to };
}

function buildRegionSlices(intervals: TimerInterval[], links: ResponsibilitySegment[]): RegionSlice[] {
  const running = intervals.filter((i) => i.state === "running");
  const slices: RegionSlice[] = [];
  for (const link of [...links].sort((a, b) => utcMs(a.effective_from) - utcMs(b.effective_from))) {
    for (const r of running) {
      const hit = overlap(utcMs(r.from), r.to === null ? null : utcMs(r.to), utcMs(link.effective_from), link.effective_to === null ? null : utcMs(link.effective_to));
      if (hit) {
        slices.push({ from: toIso(hit.from), to: hit.to === null ? null : toIso(hit.to), agency_code: link.agency_code, region_code: link.region_code });
      }
    }
  }
  return slices.sort((a, b) => utcMs(a.from) - utcMs(b.from));
}

/** 单个地区切片内按当地日累加工作日分钟，返回逐日明细。 */
function creditSlice(slice: RegionSlice, tzByRegion: Map<string, string>, calendar: CalendarPort, until: number | null): DayCredit[] {
  const tz = tzByRegion.get(slice.region_code);
  if (!tz) throw new ClockRuleError("missing_timezone", `地区 ${slice.region_code} 缺少时区配置`);
  const start = utcMs(slice.from);
  const end = slice.to === null ? (until ?? null) : utcMs(slice.to);
  if (end === null) throw new ClockRuleError("open_slice_without_bound", "开放计时切片需要计算边界");
  if (end <= start) return [];
  const credits: DayCredit[] = [];
  let cursorDay = localDayKey(start, tz);
  const guard = 4000;
  for (let i = 0; i < guard; i++) {
    const dayStart = localMidnightUtc(cursorDay, tz);
    const dayEnd = dayStart + 24 * 3600_000;
    const s = Math.max(start, dayStart);
    const e = Math.min(end, dayEnd);
    if (e > s) {
      const working = calendar.isWorkingDay(slice.region_code, cursorDay);
      credits.push({
        region_code: slice.region_code,
        local_day: cursorDay,
        working,
        credited_minutes: working ? Math.round(((e - s) / 60000) * (WORKING_MINUTES_PER_DAY / 1440)) : 0,
      });
    }
    if (dayEnd >= end) break;
    cursorDay = localDayKey(dayEnd + 1000, tz);
  }
  return credits;
}

// ---- 对外主计算 -------------------------------------------------------------

export interface ComputeInput {
  events: TimerEvent[];
  links: ResponsibilitySegment[];
  baseWorkingDays: number;
  tzByRegion: Map<string, string>;
  calendar: CalendarPort;
  asOf: string;
}

export function computeClock(input: ComputeInput): ClockSnapshot {
  const { events, links, tzByRegion, calendar, asOf } = input;
  const intervals = buildIntervals(events);
  const nowMs = utcMs(asOf);
  const budget = budgetMinutes(events, input.baseWorkingDays);
  const emergencyAdded = budget - input.baseWorkingDays * WORKING_MINUTES_PER_DAY;

  const closeEvent = events.find((e) => e.type === "close");
  const closedAt = closeEvent ? closeEvent.occurred_at : null;
  const lastInterval = intervals[intervals.length - 1];
  const status: ClockSnapshot["status"] = closedAt ? "closed" : lastInterval?.state === "paused" ? "paused" : "running";

  // 截止到 asOf 已用工时（closed 后截止到 close）。
  const horizonMs = closedAt ? Math.min(utcMs(closedAt), nowMs) : nowMs;
  const pastLinks: ResponsibilitySegment[] = links.map((l) => ({
    ...l,
    effective_to: l.effective_to === null || utcMs(l.effective_to) > horizonMs ? toIso(horizonMs) : l.effective_to,
  }));
  const pastIntervals: TimerInterval[] = intervals.map((i) =>
    i.to === null || utcMs(i.to) > horizonMs ? { ...i, to: toIso(horizonMs) } : i,
  );
  const pastSlices = buildRegionSlices(pastIntervals, pastLinks);
  const dayCredits: DayCredit[] = [];
  for (const slice of pastSlices) dayCredits.push(...creditSlice(slice, tzByRegion, calendar, horizonMs));
  const usedMinutes = Math.min(budget, dayCredits.reduce((sum, d) => sum + d.credited_minutes, 0));
  const nonWorkingDays = dayCredits.filter((d) => !d.working).map((d) => ({ region_code: d.region_code, local_day: d.local_day }));

  // 预计到期时刻：仅在“正在计时”时外推（暂停中未来不确定，不出具到期时刻）。
  // asOf 时点的负责地区未知时（如责任链尚未覆盖该瞬间）不出具。
  let deadlineAt: string | null = null;
  if (status === "running") {
    const currentLink = [...links]
      .sort((a, b) => utcMs(a.effective_from) - utcMs(b.effective_from))
      .find((l) => utcMs(l.effective_from) <= nowMs && (l.effective_to === null || utcMs(l.effective_to) > nowMs));
    if (currentLink) {
      const tz = tzByRegion.get(currentLink.region_code);
      if (!tz) throw new ClockRuleError("missing_timezone", `地区 ${currentLink.region_code} 缺少时区配置`);
      let remaining = budget - usedMinutes;
      let cursorDay = localDayKey(nowMs, tz);
      for (let guard = 0; guard < 100000 && remaining > 0; guard++) {
        const dayStart = localMidnightUtc(cursorDay, tz);
        const dayEnd = dayStart + 24 * 3600_000;
        const s = Math.max(dayStart, nowMs);
        const e = dayEnd;
        if (e > s && calendar.isWorkingDay(currentLink.region_code, cursorDay)) {
          const available = Math.round(((e - s) / 60000) * (WORKING_MINUTES_PER_DAY / 1440));
          if (available >= remaining) {
            deadlineAt = toIso(s + (remaining * 1440 * 60000) / WORKING_MINUTES_PER_DAY);
            remaining = 0;
            break;
          }
          remaining -= available;
        }
        cursorDay = localDayKey(dayEnd + 1000, tz);
      }
    }
  }

  const excluded: ExcludedPeriod[] = intervals
    .filter((i) => i.state === "paused")
    .map((i) => ({
      from: i.from,
      to: i.to,
      reason_code: i.reason_code,
      legal_basis: i.legal_basis,
      actor: i.actor,
    }));

  return {
    status,
    budget_minutes: budget,
    used_minutes: usedMinutes,
    remaining_minutes: Math.max(0, budget - usedMinutes),
    ticking: status === "running",
    deadline_at: deadlineAt,
    paused_since: status === "paused" && lastInterval ? lastInterval.from : null,
    pause_basis: status === "paused" && lastInterval ? { reason_code: lastInterval.reason_code, legal_basis: lastInterval.legal_basis } : null,
    closed_at: closedAt,
    intervals,
    excluded_periods: excluded,
    region_slices: buildRegionSlices(intervals, links),
    day_credits: dayCredits,
    non_working_days: nonWorkingDays,
    emergency_added_minutes: emergencyAdded,
  };
}
