-- 管辖裁定与期限账本：规则版本、人员、机构、案件、责任链、时钟事件、
-- 阶段决定快照、材料、移交、工作日历与持久通知。

CREATE TABLE IF NOT EXISTS rule_sets (
  version TEXT PRIMARY KEY,
  statutory_days INTEGER NOT NULL CHECK (statutory_days > 0),
  max_extension_days INTEGER NOT NULL DEFAULT 0 CHECK (max_extension_days >= 0),
  reminder_threshold_days INTEGER NOT NULL DEFAULT 5 CHECK (reminder_threshold_days >= 0),
  supplement_pause_basis TEXT NOT NULL DEFAULT '',
  external_wait_basis TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agencies (
  agency_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  region TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff (
  staff_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  agency_id TEXT NOT NULL REFERENCES agencies(agency_id),
  permissions TEXT NOT NULL DEFAULT '[]',
  conflict_regions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  consumer_region TEXT NOT NULL,
  merchant_region TEXT NOT NULL,
  transaction_region TEXT NOT NULL,
  rule_set_version TEXT NOT NULL REFERENCES rule_sets(version),
  evidence_watermark TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  current_stage INTEGER NOT NULL DEFAULT 1,
  accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS case_claims (
  claim_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  party_role TEXT NOT NULL CHECK (party_role IN ('consumer', 'merchant', 'third_party')),
  content TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_claims_case ON case_claims(case_id);

CREATE TABLE IF NOT EXISTS jurisdiction_decisions (
  decision_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  lead_agency TEXT NOT NULL REFERENCES agencies(agency_id),
  co_agencies TEXT NOT NULL DEFAULT '[]',
  confirmed_by TEXT NOT NULL REFERENCES staff(staff_id),
  rule_set_version TEXT NOT NULL REFERENCES rule_sets(version),
  decided_at TEXT NOT NULL
);
-- 每个案件只有一份生效的管辖裁定，后续主办变更通过移交完成。
CREATE UNIQUE INDEX IF NOT EXISTS one_jurisdiction_per_case ON jurisdiction_decisions(case_id);

CREATE TABLE IF NOT EXISTS case_responsibility (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  agency_id TEXT NOT NULL REFERENCES agencies(agency_id),
  role TEXT NOT NULL CHECK (role IN ('lead', 'co')),
  seq INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  transfer_id TEXT
);
-- 并发移交也只能保留一条有效责任链：同一案件同一时刻最多一个未结束的主办段。
CREATE UNIQUE INDEX IF NOT EXISTS one_open_lead_segment
  ON case_responsibility(case_id) WHERE role = 'lead' AND ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_responsibility_case ON case_responsibility(case_id, role, started_at);

CREATE TABLE IF NOT EXISTS clock_events (
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  stage INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'accepted',
    'supplement_requested',
    'supplement_received',
    'external_wait_started',
    'external_wait_ended',
    'resumed',
    'emergency_extension',
    'transferred',
    'rule_version_changed',
    'stage_decision_issued'
  )),
  occurred_at TEXT NOT NULL,
  rule_set_version TEXT NOT NULL REFERENCES rule_sets(version),
  payload TEXT NOT NULL DEFAULT '{}',
  recorded_by TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (case_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_clock_events_case ON clock_events(case_id, occurred_at);

CREATE TABLE IF NOT EXISTS stage_decisions (
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  stage INTEGER NOT NULL,
  decision TEXT NOT NULL,
  issued_by TEXT NOT NULL REFERENCES staff(staff_id),
  issued_at TEXT NOT NULL,
  rule_set_version TEXT NOT NULL REFERENCES rule_sets(version),
  snapshot TEXT NOT NULL,
  PRIMARY KEY (case_id, stage)
);

CREATE TABLE IF NOT EXISTS materials (
  material_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  label TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('filed', 'frozen', 'transferred', 'pending_attribution')),
  manifest_version INTEGER,
  received_at TEXT NOT NULL,
  attributed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_materials_case ON materials(case_id, state);

CREATE TABLE IF NOT EXISTS transfers (
  transfer_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  from_agency TEXT NOT NULL REFERENCES agencies(agency_id),
  to_agency TEXT NOT NULL REFERENCES agencies(agency_id),
  reason TEXT NOT NULL DEFAULT '',
  manifest_version INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('frozen', 'effective', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  initiated_by TEXT NOT NULL REFERENCES staff(staff_id),
  frozen_at TEXT NOT NULL,
  signed_by TEXT REFERENCES staff(staff_id),
  signed_at TEXT,
  effective_at TEXT,
  cancelled_at TEXT
);
-- 同一案件同一时刻最多一条在途移交。
CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_transfer
  ON transfers(case_id) WHERE state = 'frozen';

CREATE TABLE IF NOT EXISTS workday_calendar (
  region TEXT NOT NULL,
  day TEXT NOT NULL,
  is_workday INTEGER NOT NULL CHECK (is_workday IN (0, 1)),
  PRIMARY KEY (region, day)
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  kind TEXT NOT NULL CHECK (kind IN ('due_soon', 'overdue')),
  dedupe_key TEXT NOT NULL UNIQUE,
  lead_agency TEXT NOT NULL,
  basis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_notifications_case ON notifications(case_id, created_at);
