import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  computeCaseLedger,
  loadCaseOrThrow,
  serializeClock,
  serializeResponsible,
  serializeSnapshot,
  unsignedMaterialsAt,
} from "../caseLedger.js";
import { APPENDABLE_EVENT_TYPES, appendClockEvent, loadCaseEvents, toLedgerInputs } from "../clock.js";
import type { AppDatabase, WriteTx } from "../database.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { buildExtensions } from "../ledger.js";
import { assertNoConflictOfInterest, requireStaff } from "../staff.js";
import { parseInstant } from "../time.js";
import {
  asObject,
  optionalString,
  optionalStringArray,
  requirePositiveInt,
  requireString,
} from "../validate.js";

export interface RouteContext {
  db: AppDatabase;
  now: () => Date;
  writeTx: WriteTx;
}

const PARTY_ROLES = new Set(["consumer", "merchant", "third_party"]);

export function registerCaseRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, now, writeTx } = ctx;

  // 案件受理：保存各方主张、适用规则版本与证据水位，时钟自受理时刻起算。
  app.post("/cases", async (request, reply) => {
    const body = asObject(request.body);
    const ruleSetVersion = requireString(body, "rule_set_version");
    const ruleSet = await db
      .selectFrom("rule_sets")
      .select("version")
      .where("version", "=", ruleSetVersion)
      .executeTakeFirst();
    if (!ruleSet) throw badRequest("RULE_SET_UNKNOWN", `规则版本 ${ruleSetVersion} 未发布`);

    const claimsInput = body.claims;
    if (!Array.isArray(claimsInput) || claimsInput.length === 0) {
      throw badRequest("VALIDATION", "claims 至少包含一条当事人主张");
    }
    const claims = claimsInput.map((item, index) => {
      const entry = asObject(item);
      const partyRole = requireString(entry, "party_role");
      if (!PARTY_ROLES.has(partyRole)) {
        throw badRequest("VALIDATION", `claims[${index}].party_role 必须是 consumer/merchant/third_party`);
      }
      return {
        claim_id: randomUUID(),
        party_role: partyRole,
        content: requireString(entry, "content"),
        submitted_at: entry.submitted_at
          ? parseInstant(entry.submitted_at, `claims[${index}].submitted_at`)
          : now().toISOString(),
      };
    });

    const caseId = optionalString(body, "case_id") ?? randomUUID();
    const acceptedAt = body.accepted_at
      ? parseInstant(body.accepted_at, "accepted_at")
      : now().toISOString();
    const watermark = requireString(body, "evidence_watermark");
    const created = await writeTx(async (trx) => {
      const existing = await trx
        .selectFrom("cases")
        .select("case_id")
        .where("case_id", "=", caseId)
        .executeTakeFirst();
      if (existing) throw conflict("CASE_EXISTS", `案件 ${caseId} 已存在`);
      await trx
        .insertInto("cases")
        .values({
          case_id: caseId,
          title: requireString(body, "title"),
          consumer_region: requireString(body, "consumer_region"),
          merchant_region: requireString(body, "merchant_region"),
          transaction_region: requireString(body, "transaction_region"),
          rule_set_version: ruleSetVersion,
          evidence_watermark: watermark,
          status: "open",
          current_stage: 1,
          accepted_at: acceptedAt,
        })
        .execute();
      for (const claim of claims) {
        await trx
          .insertInto("case_claims")
          .values({ ...claim, case_id: caseId })
          .execute();
      }
      await trx
        .insertInto("clock_events")
        .values({
          event_id: randomUUID(),
          case_id: caseId,
          stage: 1,
          seq: 1,
          event_type: "accepted",
          occurred_at: acceptedAt,
          rule_set_version: ruleSetVersion,
          payload: JSON.stringify({ evidence_watermark: watermark }),
          recorded_by: null,
        })
        .execute();
      return caseId;
    });
    return reply.code(201).send({ case_id: created, accepted_at: acceptedAt, claims: claims.length });
  });

  app.get("/cases/:caseId", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const caseRow = await loadCaseOrThrow(db, caseId);
    const claims = await db
      .selectFrom("case_claims")
      .selectAll()
      .where("case_id", "=", caseId)
      .orderBy("submitted_at", "asc")
      .execute();
    const jurisdiction = await db
      .selectFrom("jurisdiction_decisions")
      .selectAll()
      .where("case_id", "=", caseId)
      .executeTakeFirst();
    const openLead = await db
      .selectFrom("case_responsibility")
      .selectAll()
      .where("case_id", "=", caseId)
      .where("role", "=", "lead")
      .where("ended_at", "is", null)
      .executeTakeFirst();
    const materials = await db
      .selectFrom("materials")
      .select(["state"])
      .where("case_id", "=", caseId)
      .execute();
    const materialCounts: Record<string, number> = {};
    for (const material of materials) {
      materialCounts[material.state] = (materialCounts[material.state] ?? 0) + 1;
    }
    return {
      ...caseRow,
      claims,
      jurisdiction: jurisdiction
        ? { ...jurisdiction, co_agencies: JSON.parse(jurisdiction.co_agencies) }
        : null,
      current_lead: openLead
        ? { agency_id: openLead.agency_id, since: openLead.started_at, seq: openLead.seq }
        : null,
      material_counts: materialCounts,
    };
  });

  // 管辖裁定：由有权限且无利益冲突的人员确认主办与协办机构。
  app.post("/cases/:caseId/jurisdiction", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const body = asObject(request.body);
    const caseRow = await loadCaseOrThrow(db, caseId);
    if (caseRow.status !== "open") throw conflict("CASE_CLOSED", "案件已办结，不能确认管辖");
    const staff = await requireStaff(db, body.staff_id, "jurisdiction.confirm");
    assertNoConflictOfInterest(staff, caseRow);

    const leadAgency = requireString(body, "lead_agency");
    const coAgencies = optionalStringArray(body, "co_agencies");
    if (coAgencies.includes(leadAgency)) {
      throw badRequest("VALIDATION", "主办机构不能同时是协办机构");
    }
    for (const agencyId of [leadAgency, ...coAgencies]) {
      const agency = await db
        .selectFrom("agencies")
        .select("agency_id")
        .where("agency_id", "=", agencyId)
        .executeTakeFirst();
      if (!agency) throw badRequest("AGENCY_UNKNOWN", `机构 ${agencyId} 未登记`);
    }
    const decidedAt = body.decided_at
      ? parseInstant(body.decided_at, "decided_at")
      : now().toISOString();
    if (decidedAt < caseRow.accepted_at) {
      throw badRequest("VALIDATION", "管辖裁定时间不能早于受理时间");
    }

    const decisionId = randomUUID();
    await writeTx(async (trx) => {
      const existing = await trx
        .selectFrom("jurisdiction_decisions")
        .select("decision_id")
        .where("case_id", "=", caseId)
        .executeTakeFirst();
      if (existing) {
        throw conflict("JURISDICTION_CONFIRMED", "管辖已确认，主办变更请通过移交完成");
      }
      await trx
        .insertInto("jurisdiction_decisions")
        .values({
          decision_id: decisionId,
          case_id: caseId,
          lead_agency: leadAgency,
          co_agencies: JSON.stringify(coAgencies),
          confirmed_by: staff.staff_id,
          rule_set_version: caseRow.rule_set_version,
          decided_at: decidedAt,
        })
        .execute();
      await trx
        .insertInto("case_responsibility")
        .values({
          case_id: caseId,
          agency_id: leadAgency,
          role: "lead",
          seq: 1,
          started_at: decidedAt,
          ended_at: null,
          transfer_id: null,
        })
        .execute();
      for (const coAgency of coAgencies) {
        await trx
          .insertInto("case_responsibility")
          .values({
            case_id: caseId,
            agency_id: coAgency,
            role: "co",
            seq: 1,
            started_at: decidedAt,
            ended_at: null,
            transfer_id: null,
          })
          .execute();
      }
    });
    return reply.code(201).send({
      decision_id: decisionId,
      case_id: caseId,
      lead_agency: leadAgency,
      co_agencies: coAgencies,
      confirmed_by: staff.staff_id,
      decided_at: decidedAt,
    });
  });

  // 期限账本事件：补正、等待外部裁决、恢复办理、紧急延长期，全部追加成事件。
  app.post("/cases/:caseId/events", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const body = asObject(request.body);
    const caseRow = await loadCaseOrThrow(db, caseId);
    if (caseRow.status !== "open") throw conflict("CASE_CLOSED", "案件已办结，不能追加事件");
    const staff = await requireStaff(db, body.staff_id, "event.append");

    const eventType = requireString(body, "event_type");
    if (!APPENDABLE_EVENT_TYPES.has(eventType)) {
      throw badRequest("VALIDATION", `不支持的事件类型 ${eventType}`);
    }
    const occurredAt = body.occurred_at
      ? parseInstant(body.occurred_at, "occurred_at")
      : now().toISOString();
    const ruleSet = await db
      .selectFrom("rule_sets")
      .selectAll()
      .where("version", "=", caseRow.rule_set_version)
      .executeTakeFirstOrThrow();

    const payload: Record<string, unknown> = {};
    if (eventType === "supplement_requested" || eventType === "external_wait_started") {
      const fallback =
        eventType === "supplement_requested"
          ? ruleSet.supplement_pause_basis || "补正期间不计入办理期限"
          : ruleSet.external_wait_basis || "等待外部裁决期间不计入办理期限";
      payload.basis = optionalString(body, "basis") ?? fallback;
    }
    if (eventType === "emergency_extension") {
      payload.days = requirePositiveInt(body, "days");
      payload.reason = requireString(body, "reason");
    }
    const note = optionalString(body, "note");
    if (note) payload.note = note;

    const event = await writeTx(async (trx) => {
      if (eventType === "emergency_extension") {
        const existingEvents = await loadCaseEvents(trx, caseId);
        const used = buildExtensions(toLedgerInputs(existingEvents)).reduce(
          (sum, item) => sum + item.days,
          0,
        );
        if (used + Number(payload.days) > ruleSet.max_extension_days) {
          throw conflict(
            "EXTENSION_LIMIT_EXCEEDED",
            `紧急延长累计 ${used + Number(payload.days)} 个工作日，超过规则版本 ${ruleSet.version} 上限 ${ruleSet.max_extension_days}`,
          );
        }
      }
      return appendClockEvent(trx, {
        caseId,
        stage: caseRow.current_stage,
        eventType,
        occurredAt,
        ruleSetVersion: caseRow.rule_set_version,
        payload,
        recordedBy: staff.staff_id,
      });
    });
    const ledger = await computeCaseLedger(db, caseRow, occurredAt);
    return reply.code(201).send({
      event: { ...event, payload: JSON.parse(event.payload) },
      ledger: {
        at: ledger.at,
        stage: ledger.stage,
        stage_locked: ledger.stageLocked,
        responsible: serializeResponsible(ledger.responsible),
        clock: serializeClock(ledger.clock),
      },
    });
  });

  // 规则换版：只影响换版之后的事件与未决定阶段；已出具决定的阶段由快照与历史事件保护。
  app.post("/cases/:caseId/rule-version", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const body = asObject(request.body);
    const caseRow = await loadCaseOrThrow(db, caseId);
    if (caseRow.status !== "open") throw conflict("CASE_CLOSED", "案件已办结，不能换版规则");
    const staff = await requireStaff(db, body.staff_id, "rule.update");
    const version = requireString(body, "version");
    const ruleSet = await db
      .selectFrom("rule_sets")
      .select("version")
      .where("version", "=", version)
      .executeTakeFirst();
    if (!ruleSet) throw badRequest("RULE_SET_UNKNOWN", `规则版本 ${version} 未发布`);
    if (version === caseRow.rule_set_version) {
      return reply.send({ case_id: caseId, rule_set_version: version, changed: false });
    }
    const occurredAt = body.occurred_at
      ? parseInstant(body.occurred_at, "occurred_at")
      : now().toISOString();
    await writeTx(async (trx) => {
      await appendClockEvent(trx, {
        caseId,
        stage: caseRow.current_stage,
        eventType: "rule_version_changed",
        occurredAt,
        ruleSetVersion: version,
        payload: { from: caseRow.rule_set_version, to: version },
        recordedBy: staff.staff_id,
      });
      await trx
        .updateTable("cases")
        .set({ rule_set_version: version })
        .where("case_id", "=", caseId)
        .execute();
    });
    return reply.send({
      case_id: caseId,
      changed: true,
      from: caseRow.rule_set_version,
      to: version,
    });
  });

  // 材料登记：移交在途时到达的新材料进入待归属区。
  app.post("/cases/:caseId/materials", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const body = asObject(request.body);
    const caseRow = await loadCaseOrThrow(db, caseId);
    if (caseRow.status !== "open") throw conflict("CASE_CLOSED", "案件已办结，不能登记材料");
    await requireStaff(db, body.staff_id, "material.file");

    const materialId = randomUUID();
    const receivedAt = body.received_at
      ? parseInstant(body.received_at, "received_at")
      : now().toISOString();
    const result = await writeTx(async (trx) => {
      const inflight = await trx
        .selectFrom("transfers")
        .select("transfer_id")
        .where("case_id", "=", caseId)
        .where("state", "=", "frozen")
        .executeTakeFirst();
      const state = inflight ? "pending_attribution" : "filed";
      await trx
        .insertInto("materials")
        .values({
          material_id: materialId,
          case_id: caseId,
          label: requireString(body, "label"),
          content_hash: requireString(body, "content_hash"),
          state,
          manifest_version: null,
          received_at: receivedAt,
          attributed_at: null,
        })
        .execute();
      return { state, heldFor: inflight?.transfer_id ?? null };
    });
    return reply.code(201).send({
      material_id: materialId,
      case_id: caseId,
      state: result.state,
      received_at: receivedAt,
      held_for_transfer: result.heldFor,
    });
  });

  // 待归属区材料由接收方归属入卷。
  app.post("/cases/:caseId/materials/:materialId/attribute", async (request, reply) => {
    const { caseId, materialId } = request.params as { caseId: string; materialId: string };
    const body = asObject(request.body);
    await loadCaseOrThrow(db, caseId);
    await requireStaff(db, body.staff_id, "material.file");
    const attributedAt = now().toISOString();
    await writeTx(async (trx) => {
      const material = await trx
        .selectFrom("materials")
        .selectAll()
        .where("material_id", "=", materialId)
        .where("case_id", "=", caseId)
        .executeTakeFirst();
      if (!material) throw notFound("MATERIAL_NOT_FOUND", `材料 ${materialId} 不存在`);
      if (material.state !== "pending_attribution") {
        throw conflict("MATERIAL_NOT_PENDING", `材料当前状态为 ${material.state}，不在待归属区`);
      }
      await trx
        .updateTable("materials")
        .set({ state: "filed", attributed_at: attributedAt })
        .where("material_id", "=", materialId)
        .execute();
    });
    return reply.send({ material_id: materialId, state: "filed", attributed_at: attributedAt });
  });

  // 阶段决定：冻结该阶段账本快照，之后规则换版不得改写本阶段。
  app.post("/cases/:caseId/stage-decisions", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const body = asObject(request.body);
    const caseRow = await loadCaseOrThrow(db, caseId);
    if (caseRow.status !== "open") throw conflict("CASE_CLOSED", "案件已办结");
    const staff = await requireStaff(db, body.staff_id, "decision.issue");
    const decision = requireString(body, "decision");
    const issuedAt = body.issued_at
      ? parseInstant(body.issued_at, "issued_at")
      : now().toISOString();
    const closesCase = body.closes_case === true;

    const view = await computeCaseLedger(db, caseRow, issuedAt);
    const snapshot = {
      at: issuedAt,
      stage: caseRow.current_stage,
      responsible: view.responsible,
      clock: view.clock,
    };
    await writeTx(async (trx) => {
      await trx
        .insertInto("stage_decisions")
        .values({
          case_id: caseId,
          stage: caseRow.current_stage,
          decision,
          issued_by: staff.staff_id,
          issued_at: issuedAt,
          rule_set_version: view.clock.ruleSetVersion,
          snapshot: JSON.stringify(snapshot),
        })
        .execute();
      await appendClockEvent(trx, {
        caseId,
        stage: caseRow.current_stage,
        eventType: "stage_decision_issued",
        occurredAt: issuedAt,
        ruleSetVersion: view.clock.ruleSetVersion,
        payload: { stage: caseRow.current_stage, decision },
        recordedBy: staff.staff_id,
      });
      await trx
        .updateTable("cases")
        .set({
          current_stage: caseRow.current_stage + 1,
          status: closesCase ? "closed" : "open",
        })
        .where("case_id", "=", caseId)
        .execute();
    });
    return reply.code(201).send({
      case_id: caseId,
      stage: caseRow.current_stage,
      decision,
      issued_at: issuedAt,
      closed: closesCase,
      snapshot: serializeSnapshot(snapshot),
    });
  });

  // 时点查询：当时负责机构、剩余时限、被排除时间段、未签收材料与每次催办依据。
  app.get("/cases/:caseId/ledger", async (request) => {
    const { caseId } = request.params as { caseId: string };
    const query = request.query as { at?: string };
    const caseRow = await loadCaseOrThrow(db, caseId);
    const at = query.at ? parseInstant(query.at, "at") : now().toISOString();
    if (at < caseRow.accepted_at) {
      throw badRequest("AT_BEFORE_ACCEPTANCE", `查询时点 ${at} 早于受理时间 ${caseRow.accepted_at}`);
    }
    const view = await computeCaseLedger(db, caseRow, at);
    const unsigned = await unsignedMaterialsAt(db, caseId, at);
    const reminders = await db
      .selectFrom("notifications")
      .selectAll()
      .where("case_id", "=", caseId)
      .where("created_at", "<=", at)
      .orderBy("created_at", "asc")
      .execute();
    return {
      case_id: caseId,
      case_status: caseRow.status,
      at,
      stage: view.stage,
      stage_locked: view.stageLocked,
      responsible: serializeResponsible(view.responsible),
      clock: serializeClock(view.clock),
      excluded_periods: view.clock.excludedPeriods,
      extensions: view.clock.extensions,
      locked_snapshot: view.lockedSnapshot ? serializeSnapshot(view.lockedSnapshot) : null,
      unsigned_materials: unsigned,
      reminders: reminders.map((reminder) => ({
        notification_id: reminder.notification_id,
        kind: reminder.kind,
        lead_agency: reminder.lead_agency,
        created_at: reminder.created_at,
        delivered: reminder.delivered === 1,
        basis: JSON.parse(reminder.basis),
      })),
    };
  });

  app.get("/cases/:caseId/notifications", async (request) => {
    const { caseId } = request.params as { caseId: string };
    await loadCaseOrThrow(db, caseId);
    const rows = await db
      .selectFrom("notifications")
      .selectAll()
      .where("case_id", "=", caseId)
      .orderBy("created_at", "asc")
      .execute();
    return {
      case_id: caseId,
      notifications: rows.map((row) => ({
        notification_id: row.notification_id,
        kind: row.kind,
        lead_agency: row.lead_agency,
        created_at: row.created_at,
        delivered: row.delivered === 1,
        basis: JSON.parse(row.basis),
      })),
    };
  });
}
