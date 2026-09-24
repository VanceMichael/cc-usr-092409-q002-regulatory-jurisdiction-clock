import type { DbExecutor } from "./database.js";
import { forbidden } from "./errors.js";

export type StaffRow = {
  staff_id: string;
  display_name: string;
  agency_id: string;
  permissions: string;
  conflict_regions: string;
};

export function staffPermissions(staff: StaffRow): string[] {
  return JSON.parse(staff.permissions) as string[];
}

export function staffConflictRegions(staff: StaffRow): string[] {
  return JSON.parse(staff.conflict_regions) as string[];
}

/** 校验人员已登记且持有指定权限，否则 403。 */
export async function requireStaff(
  db: DbExecutor,
  staffId: unknown,
  permission: string,
): Promise<StaffRow> {
  if (typeof staffId !== "string" || staffId === "") {
    throw forbidden("STAFF_UNKNOWN", "请求必须携带 staff_id");
  }
  const staff = await db
    .selectFrom("staff")
    .selectAll()
    .where("staff_id", "=", staffId)
    .executeTakeFirst();
  if (!staff) throw forbidden("STAFF_UNKNOWN", `人员 ${staffId} 未登记`);
  if (!staffPermissions(staff).includes(permission)) {
    throw forbidden("STAFF_FORBIDDEN", `人员 ${staffId} 缺少权限 ${permission}`);
  }
  return staff;
}

/** 利益冲突：人员登记的利益冲突地区与案件任一方地区重叠时禁止确认管辖。 */
export function assertNoConflictOfInterest(
  staff: StaffRow,
  caseRow: { consumer_region: string; merchant_region: string; transaction_region: string },
): void {
  const conflicts = staffConflictRegions(staff);
  const hit = [
    caseRow.consumer_region,
    caseRow.merchant_region,
    caseRow.transaction_region,
  ].filter((region) => conflicts.includes(region));
  if (hit.length > 0) {
    throw forbidden(
      "STAFF_CONFLICT_OF_INTEREST",
      `人员 ${staff.staff_id} 与案件地区存在利益冲突：${[...new Set(hit)].join("、")}`,
    );
  }
}
