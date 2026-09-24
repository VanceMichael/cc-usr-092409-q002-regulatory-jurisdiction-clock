import type { FastifyInstance } from "fastify";
import { conflict } from "../errors.js";
import { parseDay, parseInstant } from "../time.js";
import {
  asObject,
  optionalNonNegativeInt,
  optionalString,
  optionalStringArray,
  requirePositiveInt,
  requireString,
} from "../validate.js";
import type { RouteContext } from "./cases.js";

/** 基础数据登记：规则版本、机构、人员、工作日历。 */
export function registerAdminRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, writeTx } = ctx;
  app.post("/rule-sets", async (request, reply) => {
    const body = asObject(request.body);
    const version = requireString(body, "version");
    const row = {
      version,
      statutory_days: requirePositiveInt(body, "statutory_days"),
      max_extension_days: optionalNonNegativeInt(body, "max_extension_days", 0),
      reminder_threshold_days: optionalNonNegativeInt(body, "reminder_threshold_days", 5),
      supplement_pause_basis: optionalString(body, "supplement_pause_basis") ?? "",
      external_wait_basis: optionalString(body, "external_wait_basis") ?? "",
      published_at: body.published_at
        ? parseInstant(body.published_at, "published_at")
        : new Date().toISOString(),
    };
    const existing = await db
      .selectFrom("rule_sets")
      .select("version")
      .where("version", "=", version)
      .executeTakeFirst();
    if (existing) {
      throw conflict("RULE_SET_EXISTS", `规则版本 ${version} 已发布，规则版本不可变`);
    }
    await writeTx((trx) => trx.insertInto("rule_sets").values(row).execute());
    return reply.code(201).send(row);
  });

  app.post("/agencies", async (request, reply) => {
    const body = asObject(request.body);
    const row = {
      agency_id: requireString(body, "agency_id"),
      display_name: requireString(body, "display_name"),
      region: requireString(body, "region"),
    };
    const existing = await db
      .selectFrom("agencies")
      .select("agency_id")
      .where("agency_id", "=", row.agency_id)
      .executeTakeFirst();
    if (existing) throw conflict("AGENCY_EXISTS", `机构 ${row.agency_id} 已登记`);
    await writeTx((trx) => trx.insertInto("agencies").values(row).execute());
    return reply.code(201).send(row);
  });

  app.post("/staff", async (request, reply) => {
    const body = asObject(request.body);
    const agencyId = requireString(body, "agency_id");
    const agency = await db
      .selectFrom("agencies")
      .select("agency_id")
      .where("agency_id", "=", agencyId)
      .executeTakeFirst();
    if (!agency) throw conflict("AGENCY_UNKNOWN", `机构 ${agencyId} 未登记`);
    const row = {
      staff_id: requireString(body, "staff_id"),
      display_name: requireString(body, "display_name"),
      agency_id: agencyId,
      permissions: JSON.stringify(optionalStringArray(body, "permissions")),
      conflict_regions: JSON.stringify(optionalStringArray(body, "conflict_regions")),
    };
    const existing = await db
      .selectFrom("staff")
      .select("staff_id")
      .where("staff_id", "=", row.staff_id)
      .executeTakeFirst();
    if (existing) throw conflict("STAFF_EXISTS", `人员 ${row.staff_id} 已登记`);
    await writeTx((trx) => trx.insertInto("staff").values(row).execute());
    return reply.code(201).send({
      staff_id: row.staff_id,
      display_name: row.display_name,
      agency_id: row.agency_id,
      permissions: JSON.parse(row.permissions),
      conflict_regions: JSON.parse(row.conflict_regions),
    });
  });

  app.put("/calendars/:region", async (request, reply) => {
    const { region } = request.params as { region: string };
    const body = asObject(request.body);
    const overrides = body.overrides;
    if (!Array.isArray(overrides)) {
      throw conflict("VALIDATION", "overrides 必须是数组");
    }
    const rows = overrides.map((item, index) => {
      const entry = asObject(item);
      const isWorkday = entry.is_workday;
      if (typeof isWorkday !== "boolean") {
        throw conflict("VALIDATION", `overrides[${index}].is_workday 必须是布尔值`);
      }
      return {
        region,
        day: parseDay(entry.day, `overrides[${index}].day`),
        is_workday: isWorkday ? 1 : 0,
      };
    });
    await writeTx(async (trx) => {
      for (const row of rows) {
        await trx
          .insertInto("workday_calendar")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["region", "day"]).doUpdateSet({ is_workday: row.is_workday }),
          )
          .execute();
      }
    });
    return reply.send({ region, applied: rows.length });
  });
}
