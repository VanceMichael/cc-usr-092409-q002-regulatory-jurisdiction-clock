import { badRequest } from "./errors.js";

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 校验并归一化为 UTC ISO 字符串（毫秒精度）。 */
export function parseInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_PATTERN.test(value)) {
    throw badRequest("VALIDATION", `${field} 必须是带时区的 ISO 8601 时间戳`);
  }
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    throw badRequest("VALIDATION", `${field} 不是有效时间`);
  }
  return time.toISOString();
}

export function parseDay(value: unknown, field: string): string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) {
    throw badRequest("VALIDATION", `${field} 必须是 YYYY-MM-DD 格式的日期`);
  }
  const time = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(time.getTime()) || dayOf(time.toISOString()) !== value) {
    throw badRequest("VALIDATION", `${field} 不是有效日期`);
  }
  return value;
}

/** 取时间戳的 UTC 日历日（YYYY-MM-DD）。计时以 UTC 日为粒度。 */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const time = new Date(`${day}T00:00:00.000Z`);
  time.setUTCDate(time.getUTCDate() + days);
  return time.toISOString().slice(0, 10);
}

/** 枚举 [fromDay, toDay] 之间的每一天（含两端），调用方需保证范围有界。 */
export function* eachDay(fromDay: string, toDay: string): Generator<string> {
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    yield day;
  }
}
