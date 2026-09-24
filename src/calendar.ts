/** 工作日历：默认周一至周五为工作日，workday_calendar 表按 地区+日期 覆盖。 */
export type WorkdayRule = (region: string, day: string) => boolean;

export function defaultWorkday(region: string, day: string): boolean {
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function workdayRuleFromOverrides(overrides: Map<string, boolean>): WorkdayRule {
  return (region, day) => overrides.get(`${region}:${day}`) ?? defaultWorkday(region, day);
}
