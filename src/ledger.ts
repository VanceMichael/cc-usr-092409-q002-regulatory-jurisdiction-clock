import type { WorkdayRule } from "./calendar.js";
import { addDays, dayOf } from "./time.js";

/**
 * 期限账本纯计算：由时钟事件流重建计时段与暂停段，
 * 按负责机构当地工作日历逐日计数。
 *
 * 计时口径（与路由层写入的事件一致）：
 * - 受理当日不计入，次日起每个工作日计 1；
 * - 暂停段 [from, to) 按整日排除：暂停开始当日不计，恢复当日计；
 * - 暂停未结束时剩余时限冻结，不再消耗；
 * - 负责机构以每日 00:00Z 所在责任段为准，换主办后按新机构地区日历计数。
 */

export interface LedgerEventInput {
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ResponsibilitySpan {
  agencyId: string;
  region: string;
  startedAt: string;
  endedAt: string | null;
}

export interface PausePeriod {
  from: string;
  to: string | null;
  reason: "supplement" | "external_wait";
  basis: string;
}

export interface ExtensionRecord {
  days: number;
  reason: string;
  at: string;
}

export interface LedgerComputation {
  state: "running" | "paused";
  ruleSetVersion: string;
  statutoryDays: number;
  extensionDays: number;
  limitDays: number;
  consumedWorkdays: number;
  remainingWorkdays: number;
  overdue: boolean;
  projectedDeadline: string | null;
  excludedPeriods: PausePeriod[];
  extensions: ExtensionRecord[];
}

export interface LedgerInput {
  acceptedAt: string;
  /** 截至查询时点已发生的时钟事件（含 accepted），按 (occurred_at, seq) 升序。 */
  events: LedgerEventInput[];
  ruleSetVersion: string;
  statutoryDays: number;
  /** 主办责任段（升序）；为空时全程使用 fallbackRegion。 */
  responsibility: ResponsibilitySpan[];
  fallbackRegion: string;
  isWorkday: WorkdayRule;
  at: string;
}

const PAUSE_START: Record<string, PausePeriod["reason"]> = {
  supplement_requested: "supplement",
  external_wait_started: "external_wait",
};
const PAUSE_END = new Set(["supplement_received", "external_wait_ended", "resumed"]);

/** 防止病态日历（长期无工作日）导致投影死循环。 */
const MAX_PROJECTION_DAYS = 3660;

export function buildPausePeriods(events: LedgerEventInput[]): PausePeriod[] {
  const periods: PausePeriod[] = [];
  let open: PausePeriod | null = null;
  for (const event of events) {
    const startReason = PAUSE_START[event.eventType];
    if (startReason && !open) {
      open = {
        from: event.occurredAt,
        to: null,
        reason: startReason,
        basis: typeof event.payload.basis === "string" ? event.payload.basis : "",
      };
    } else if (PAUSE_END.has(event.eventType) && open) {
      open.to = event.occurredAt;
      periods.push(open);
      open = null;
    }
  }
  if (open) periods.push(open);
  return periods;
}

export function buildExtensions(events: LedgerEventInput[]): ExtensionRecord[] {
  return events
    .filter((event) => event.eventType === "emergency_extension")
    .map((event) => ({
      days: Number(event.payload.days ?? 0),
      reason: String(event.payload.reason ?? ""),
      at: event.occurredAt,
    }));
}

function pauseCoveringDay(periods: PausePeriod[], day: string): PausePeriod | undefined {
  return periods.find(
    (period) => dayOf(period.from) <= day && (period.to === null || day < dayOf(period.to)),
  );
}

export function computeLedger(input: LedgerInput): LedgerComputation {
  const pauses = buildPausePeriods(input.events);
  const extensions = buildExtensions(input.events);
  const extensionDays = extensions.reduce((sum, item) => sum + item.days, 0);
  const limitDays = input.statutoryDays + extensionDays;
  const paused = pauses.length > 0 && pauses[pauses.length - 1].to === null;

  const regionOfDay = (day: string): string => {
    if (input.responsibility.length === 0) return input.fallbackRegion;
    const instant = `${day}T00:00:00.000Z`;
    let region = input.responsibility[0].region;
    for (const span of input.responsibility) {
      if (span.startedAt <= instant && (span.endedAt === null || span.endedAt > instant)) {
        region = span.region;
      }
    }
    return region;
  };

  // 从受理次日起逐日前进；遇暂停段整体跳过，开放暂停直接停止消耗。
  const walkCountableDays = function* (): Generator<string> {
    let day = addDays(dayOf(input.acceptedAt), 1);
    for (let i = 0; i < MAX_PROJECTION_DAYS; i++) {
      const pause = pauseCoveringDay(pauses, day);
      if (pause) {
        if (pause.to === null) return;
        day = dayOf(pause.to);
        continue;
      }
      yield day;
      day = addDays(day, 1);
    }
  };

  const endDay = dayOf(input.at);
  let consumed = 0;
  for (const day of walkCountableDays()) {
    if (day > endDay) break;
    if (input.isWorkday(regionOfDay(day), day)) consumed += 1;
  }

  let projectedDeadline: string | null = null;
  if (!paused) {
    let count = 0;
    for (const day of walkCountableDays()) {
      if (input.isWorkday(regionOfDay(day), day)) {
        count += 1;
        if (count >= limitDays) {
          projectedDeadline = day;
          break;
        }
      }
    }
  }

  const remaining = limitDays - consumed;
  return {
    state: paused ? "paused" : "running",
    ruleSetVersion: input.ruleSetVersion,
    statutoryDays: input.statutoryDays,
    extensionDays,
    limitDays,
    consumedWorkdays: consumed,
    remainingWorkdays: remaining,
    overdue: remaining < 0,
    projectedDeadline,
    excludedPeriods: pauses,
    extensions,
  };
}
