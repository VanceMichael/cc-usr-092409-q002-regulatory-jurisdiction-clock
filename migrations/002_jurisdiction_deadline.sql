-- 管辖裁定与期限账本：所有时间戳均为 UTC ISO-8601 文本，日期为当地 YYYY-MM-DD。
-- 账本类表（裁定、期限事件、决定）只追加，触发器阻止 UPDATE/DELETE。

-- 地区与当地工作日历 ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS regions (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  iana_timezone TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_days (
  region_code TEXT NOT NULL REFERENCES regions(code),
  day TEXT NOT NULL,                 -- 当地日期 YYYY-MM-DD
  kind TEXT NOT NULL CHECK (kind IN ('working', 'nonworking')),
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (region_code, day)
);

-- 机构与人员 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agencies (
  agency_code TEXT PRIMARY KEY,
  region_code TEXT NOT NULL REFERENCES regions(code),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personnel (
  person_id TEXT PRIMARY KEY,
  agency_code TEXT NOT NULL REFERENCES agencies(agency_code),
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 人员可被授权管辖的地区（管辖裁定的“有权限”依据）
CREATE TABLE IF NOT EXISTS personnel_region_grants (
  person_id TEXT NOT NULL REFERENCES personnel(person_id),
  region_code TEXT NOT NULL REFERENCES regions(code),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (person_id, region_code)
);

-- 利益冲突声明（管辖裁定的“无利益冲突”依据）
CREATE TABLE IF NOT EXISTS case_conflicts (
  case_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES personnel(person_id),
  reason TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  PRIMARY KEY (case_id, person_id)
);

-- 规则版本：案件阶段在开启时钉选版本，换版不回溯
CREATE TABLE IF NOT EXISTS rule_versions (
  version TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'effective', 'retired')),
  payload_json TEXT NOT NULL,       -- {"stage_working_days": {...}, "emergency_extension_max_days": n}
  published_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_rule_payload_no_update
BEFORE UPDATE OF payload_json ON rule_versions
WHEN NEW.payload_json != OLD.payload_json
BEGIN
  SELECT RAISE(ABORT, '规则版本正文一经发布不可改写，请换版而非修改');
END;

-- 案件 -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  case_no TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  consumer_region TEXT,             -- 消费者常住地
  merchant_region TEXT,             -- 商家主体所在地
  transaction_region TEXT,          -- 交易发生地
  rule_version TEXT NOT NULL REFERENCES rule_versions(version),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL
);

-- 各方主张（裁定前留存）
CREATE TABLE IF NOT EXISTS party_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  party_role TEXT NOT NULL CHECK (party_role IN ('consumer', 'merchant', 'other')),
  party_name TEXT NOT NULL,
  claimed_agency TEXT,
  claimed_region TEXT,
  statement TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_party_claims_case ON party_claims(case_id);

-- 证据仓：案件内单调递增水位序号；移交冻结后到达的新材料先进入待归属区
CREATE TABLE IF NOT EXISTS case_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'document',
  material_key TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (
    'received', 'pending_attribution', 'attributed', 'rejected'
  )),
  arrived_at TEXT NOT NULL,
  arrived_by TEXT NOT NULL,
  pending_transfer_id INTEGER,
  arrived_during_transfer_id INTEGER,
  attributed_at TEXT,
  attributed_by TEXT,
  attribution_note TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  UNIQUE (case_id, idempotency_key)
);
-- 水位序号仅对已归属材料（seq>0）要求连续唯一；待归属/拒收材料 seq=0 占位。
CREATE UNIQUE INDEX IF NOT EXISTS ux_materials_watermark
  ON case_materials(case_id, seq) WHERE seq > 0;
CREATE INDEX IF NOT EXISTS idx_materials_case ON case_materials(case_id);
CREATE INDEX IF NOT EXISTS idx_materials_pending ON case_materials(case_id)
  WHERE status = 'pending_attribution';

-- 管辖裁定（只追加，新裁定使旧裁定在时序上失效）
CREATE TABLE IF NOT EXISTS jurisdiction_rulings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  seq INTEGER NOT NULL,
  lead_agency TEXT NOT NULL REFERENCES agencies(agency_code),
  co_agencies_json TEXT NOT NULL DEFAULT '[]',
  ruled_by TEXT NOT NULL REFERENCES personnel(person_id),
  evidence_watermark INTEGER NOT NULL,
  rule_version TEXT NOT NULL REFERENCES rule_versions(version),
  basis TEXT NOT NULL,
  ruled_at TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE (case_id, seq),
  UNIQUE (case_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_rulings_case ON jurisdiction_rulings(case_id);

CREATE TRIGGER IF NOT EXISTS trg_rulings_no_update
BEFORE UPDATE ON jurisdiction_rulings
BEGIN
  SELECT RAISE(ABORT, 'jurisdiction_rulings 只追加，禁止更新');
END;
CREATE TRIGGER IF NOT EXISTS trg_rulings_no_delete
BEFORE DELETE ON jurisdiction_rulings
BEGIN
  SELECT RAISE(ABORT, 'jurisdiction_rulings 只追加，禁止删除');
END;

-- 责任链：任一时刻每个案件只有一条有效链路（effective_to IS NULL）
CREATE TABLE IF NOT EXISTS responsibility_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  seq INTEGER NOT NULL,
  agency_code TEXT NOT NULL REFERENCES agencies(agency_code),
  region_code TEXT NOT NULL REFERENCES regions(code),
  source TEXT NOT NULL CHECK (source IN ('intake', 'ruling', 'transfer')),
  source_ref TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  UNIQUE (case_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_links_case ON responsibility_links(case_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_links_current
  ON responsibility_links(case_id) WHERE effective_to IS NULL;

-- 案件阶段：开启时钉选规则版本与工作日预算
CREATE TABLE IF NOT EXISTS case_stages (
  stage_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  seq INTEGER NOT NULL,
  stage_code TEXT NOT NULL,
  rule_version TEXT NOT NULL REFERENCES rule_versions(version),
  working_days INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  decided_at TEXT,
  decision_id INTEGER,
  UNIQUE (case_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_stages_case ON case_stages(case_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_stage_open
  ON case_stages(case_id) WHERE decided_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_stage_pinned_fields
BEFORE UPDATE OF rule_version, working_days ON case_stages
WHEN NEW.rule_version != OLD.rule_version
  OR NEW.working_days != OLD.working_days
BEGIN
  SELECT RAISE(ABORT, '阶段钉选的规则版本与期限预算不可改写');
END;

-- 期限账本事件（只追加）
CREATE TABLE IF NOT EXISTS deadline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  stage_id TEXT NOT NULL REFERENCES case_stages(stage_id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'open', 'supplement_request', 'wait_external', 'resume',
    'emergency_extension', 'close'
  )),
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  legal_basis TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  UNIQUE (stage_id, seq),
  UNIQUE (stage_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_events_case ON deadline_events(case_id);
CREATE INDEX IF NOT EXISTS idx_events_stage ON deadline_events(stage_id, seq);

CREATE TRIGGER IF NOT EXISTS trg_events_no_update
BEFORE UPDATE ON deadline_events
BEGIN
  SELECT RAISE(ABORT, 'deadline_events 为追加账本，禁止更新');
END;
CREATE TRIGGER IF NOT EXISTS trg_events_no_delete
BEFORE DELETE ON deadline_events
BEGIN
  SELECT RAISE(ABORT, 'deadline_events 为追加账本，禁止删除');
END;

-- 决定（只追加）：钉选规则版本与签发时的期限快照
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  stage_id TEXT NOT NULL UNIQUE REFERENCES case_stages(stage_id),
  decision_no TEXT NOT NULL UNIQUE,
  rule_version TEXT NOT NULL REFERENCES rule_versions(version),
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  clock_snapshot_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_case ON decisions(case_id);

CREATE TRIGGER IF NOT EXISTS trg_decisions_no_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions 一经出具不可改写');
END;
CREATE TRIGGER IF NOT EXISTS trg_decisions_no_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions 一经出具不可删除');
END;

-- 移交：冻结清单 -> 接收方签收同一版本 -> 原子生效
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  seq INTEGER NOT NULL,
  from_agency TEXT NOT NULL REFERENCES agencies(agency_code),
  to_agency TEXT NOT NULL REFERENCES agencies(agency_code),
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'frozen', 'received', 'effective', 'cancelled'
  )),
  idempotency_key TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  frozen_by TEXT,
  frozen_at TEXT,
  manifest_hash TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL DEFAULT '[]',
  received_by TEXT,
  received_at TEXT,
  effective_at TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  UNIQUE (case_id, seq),
  UNIQUE (case_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_transfers_case ON transfers(case_id);
-- 并发移交：同一案件同时只能有一条在途移交
CREATE UNIQUE INDEX IF NOT EXISTS ux_transfer_open
  ON transfers(case_id) WHERE status IN ('proposed', 'frozen', 'received');

CREATE TABLE IF NOT EXISTS transfer_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL REFERENCES transfers(id),
  received_by TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (transfer_id, idempotency_key)
);

-- 持久通知（到期扫描与人工催办均落库；dedup_key 去重）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  stage_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('due_soon', 'overdue', 'reminder')),
  dedup_key TEXT UNIQUE,
  basis_json TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  delivered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_case ON notifications(case_id);
CREATE INDEX IF NOT EXISTS idx_notifications_undelivered
  ON notifications(created_at) WHERE delivered_at IS NULL;
