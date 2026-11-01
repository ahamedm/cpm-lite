-- CPM Lite Thin Orchestrator OLTP schema.
--
-- Interim store: DuckDB 2.0. This file is deliberately Postgres-compatible in
-- shape (VARCHAR UUIDs, TIMESTAMPTZ, DECIMAL, JSON) so the move to PostgreSQL
-- is a type/driver translation rather than a redesign.
--
-- DuckDB constraints and limitations that shape this schema:
--   * FKs are kept only for immutable reference data (department, cost centre,
--     plan on promotion). Mutable aggregate relationships are app-enforced:
--     DuckDB can reject an UPDATE on a row that is still referenced by a FK.
--   * ALTER TABLE ADD CONSTRAINT is not supported, so table order matters.
--   * Partial indexes are not supported; "one draft version" is enforced by
--     the API inside a transaction.
--   * Cross-aggregate references are plain VARCHARs and checked by the service.
--   * Run the API with a single writer replica. DuckDB is single-writer; use
--     row_version for optimistic concurrency and keep transactions short.

CREATE SCHEMA IF NOT EXISTS orchestrator;

CREATE TABLE IF NOT EXISTS orchestrator.schema_migration (
  version INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orchestrator.department (
  department_code VARCHAR PRIMARY KEY,
  department_name VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orchestrator.cost_centre (
  cost_centre_code VARCHAR PRIMARY KEY,
  department_code VARCHAR NOT NULL REFERENCES orchestrator.department(department_code),
  cost_centre_name VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orchestrator.model (
  model_id VARCHAR PRIMARY KEY,
  code VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  description TEXT,
  department_code VARCHAR NOT NULL REFERENCES orchestrator.department(department_code),
  visibility VARCHAR NOT NULL CHECK (visibility IN ('department', 'global')),
  status VARCHAR NOT NULL CHECK (status IN ('active', 'archived')),
  owner_subject VARCHAR NOT NULL,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS orchestrator.model_version (
  model_version_id VARCHAR PRIMARY KEY,
  model_id VARCHAR NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status VARCHAR NOT NULL CHECK (status IN ('draft', 'validated', 'published', 'superseded')),
  definition JSON NOT NULL,
  validation_report JSON,
  cube_refresh_status VARCHAR NOT NULL DEFAULT 'not_requested'
    CHECK (cube_refresh_status IN ('not_requested', 'pending', 'running', 'succeeded', 'failed')),
  cube_refresh_requested_at TIMESTAMPTZ,
  cube_refresh_completed_at TIMESTAMPTZ,
  cube_refresh_error TEXT,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by VARCHAR,
  published_at TIMESTAMPTZ,
  superseded_by_version_id VARCHAR,
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (model_id, version_number),
  CHECK (status NOT IN ('published', 'superseded') OR published_at IS NOT NULL),
  CHECK (status <> 'superseded' OR superseded_by_version_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS orchestrator.plan (
  plan_id VARCHAR PRIMARY KEY,
  code VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  department_code VARCHAR NOT NULL REFERENCES orchestrator.department(department_code),
  fiscal_year INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2200),
  status VARCHAR NOT NULL CHECK (status IN ('active', 'archived')),
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (department_code, fiscal_year, code)
);

-- source_scenario_version_id and source_submission_id are intentionally not
-- FKs: those tables are created after this one and DuckDB cannot add FKs later.
CREATE TABLE IF NOT EXISTS orchestrator.plan_version (
  plan_version_id VARCHAR PRIMARY KEY,
  plan_id VARCHAR NOT NULL REFERENCES orchestrator.plan(plan_id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status VARCHAR NOT NULL CHECK (status IN ('published', 'superseded')),
  source_scenario_version_id VARCHAR NOT NULL,
  source_submission_id VARCHAR NOT NULL,
  effective_from DATE NOT NULL,
  totals JSON NOT NULL,
  published_by VARCHAR NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (plan_id, version_number)
);

CREATE TABLE IF NOT EXISTS orchestrator.scenario (
  scenario_id VARCHAR PRIMARY KEY,
  code VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  description TEXT,
  scenario_type VARCHAR NOT NULL CHECK (scenario_type IN ('budget', 'forecast')),
  department_code VARCHAR NOT NULL REFERENCES orchestrator.department(department_code),
  cost_centre_code VARCHAR REFERENCES orchestrator.cost_centre(cost_centre_code),
  status VARCHAR NOT NULL CHECK (status IN ('active', 'archived')),
  owner_subject VARCHAR NOT NULL,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (department_code, code)
);

CREATE TABLE IF NOT EXISTS orchestrator.scenario_version (
  scenario_version_id VARCHAR PRIMARY KEY,
  scenario_id VARCHAR NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  model_version_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL
    CHECK (status IN ('draft', 'validated', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  review_status VARCHAR NOT NULL DEFAULT 'not_submitted'
    CHECK (review_status IN ('not_submitted', 'submitted', 'approved', 'rejected', 'changes_requested', 'promoted')),
  base_type VARCHAR NOT NULL CHECK (base_type IN ('actuals', 'plan', 'scenario')),
  base_plan_version_id VARCHAR,
  base_scenario_version_id VARCHAR,
  actuals_as_of DATE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  currency_code VARCHAR NOT NULL CHECK (length(currency_code) = 3),
  drivers JSON NOT NULL,
  adjustments JSON NOT NULL,
  assumptions JSON NOT NULL,
  validation_report JSON,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (scenario_id, version_number),
  CHECK (period_start <= period_end),
  CHECK (
    (base_type = 'actuals')
    OR (base_type = 'plan' AND base_plan_version_id IS NOT NULL AND base_scenario_version_id IS NULL)
    OR (base_type = 'scenario' AND base_scenario_version_id IS NOT NULL AND base_plan_version_id IS NULL)
  ),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (review_status NOT IN ('approved', 'promoted') OR status = 'completed')
);

CREATE TABLE IF NOT EXISTS orchestrator.rule (
  rule_id VARCHAR PRIMARY KEY,
  code VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  description TEXT,
  owner_department_code VARCHAR REFERENCES orchestrator.department(department_code),
  status VARCHAR NOT NULL CHECK (status IN ('active', 'archived')),
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS orchestrator.rule_version (
  rule_version_id VARCHAR PRIMARY KEY,
  rule_id VARCHAR NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status VARCHAR NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  evaluation_point VARCHAR NOT NULL
    CHECK (evaluation_point IN ('pre_submit', 'allocation', 'post_calculation', 'promotion')),
  priority INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  definition JSON NOT NULL,
  validation_report JSON,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by VARCHAR,
  published_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (rule_id, version_number),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (status NOT IN ('active', 'retired') OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS orchestrator.rule_scope (
  rule_scope_id VARCHAR PRIMARY KEY,
  rule_version_id VARCHAR NOT NULL,
  scope_type VARCHAR NOT NULL CHECK (scope_type IN ('global', 'department', 'cost_centre', 'scenario_type')),
  scope_id VARCHAR,
  CHECK (
    (scope_type = 'global' AND scope_id IS NULL)
    OR (scope_type <> 'global' AND scope_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS orchestrator.job (
  job_id VARCHAR PRIMARY KEY,
  scenario_version_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  retry_of_job_id VARCHAR,
  engine_version VARCHAR NOT NULL,
  payload JSON NOT NULL,
  idempotency_key VARCHAR,
  error_code VARCHAR,
  error_message TEXT,
  result_uri VARCHAR,
  result JSON,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_by VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  CHECK (status NOT IN ('completed', 'failed', 'cancelled') OR finished_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS orchestrator.job_rule_version (
  job_id VARCHAR NOT NULL,
  rule_version_id VARCHAR NOT NULL,
  PRIMARY KEY (job_id, rule_version_id)
);

CREATE TABLE IF NOT EXISTS orchestrator.submission (
  submission_id VARCHAR PRIMARY KEY,
  scenario_version_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL
    CHECK (status IN ('submitted', 'approved', 'rejected', 'changes_requested', 'promoted')),
  note TEXT,
  submitted_by VARCHAR NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by VARCHAR,
  decided_at TIMESTAMPTZ,
  decision_comment TEXT,
  promotion_id VARCHAR,
  row_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (scenario_version_id)
);

CREATE TABLE IF NOT EXISTS orchestrator.submission_decision (
  decision_id VARCHAR PRIMARY KEY,
  submission_id VARCHAR NOT NULL,
  decision VARCHAR NOT NULL CHECK (decision IN ('approve', 'reject', 'request_changes')),
  comment TEXT,
  actor_subject VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (decision = 'approve' OR comment IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS orchestrator.promotion (
  promotion_id VARCHAR PRIMARY KEY,
  submission_id VARCHAR NOT NULL,
  plan_id VARCHAR NOT NULL REFERENCES orchestrator.plan(plan_id),
  plan_version_id VARCHAR,
  status VARCHAR NOT NULL CHECK (status IN ('requested', 'running', 'succeeded', 'failed')),
  requested_by VARCHAR NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_code VARCHAR,
  error_message TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  CHECK (status <> 'succeeded' OR plan_version_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS orchestrator.audit_event (
  audit_event_id VARCHAR PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_subject VARCHAR NOT NULL,
  actor_department_code VARCHAR,
  action VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL
    CHECK (entity_type IN ('model', 'model_version', 'scenario', 'scenario_version', 'job', 'rule', 'rule_version', 'submission', 'promotion', 'plan', 'plan_version')),
  entity_id VARCHAR NOT NULL,
  entity_version INTEGER,
  correlation_id VARCHAR NOT NULL,
  request_id VARCHAR,
  before_state JSON,
  after_state JSON,
  metadata JSON
);

CREATE TABLE IF NOT EXISTS orchestrator.idempotency_key (
  scope VARCHAR NOT NULL,
  idempotency_key VARCHAR NOT NULL,
  request_hash VARCHAR NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSON NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, idempotency_key),
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS orchestrator.outbox_event (
  outbox_event_id VARCHAR PRIMARY KEY,
  event_type VARCHAR NOT NULL,
  aggregate_type VARCHAR NOT NULL,
  aggregate_id VARCHAR NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS ix_model_department ON orchestrator.model(department_code, status);
CREATE INDEX IF NOT EXISTS ix_model_version_model ON orchestrator.model_version(model_id, status);
CREATE INDEX IF NOT EXISTS ix_scenario_department ON orchestrator.scenario(department_code, status);
CREATE INDEX IF NOT EXISTS ix_scenario_version_scenario ON orchestrator.scenario_version(scenario_id, status);
CREATE INDEX IF NOT EXISTS ix_scenario_version_model ON orchestrator.scenario_version(model_version_id);
CREATE INDEX IF NOT EXISTS ix_plan_department ON orchestrator.plan(department_code, fiscal_year);
CREATE INDEX IF NOT EXISTS ix_plan_version_plan ON orchestrator.plan_version(plan_id, status);
CREATE INDEX IF NOT EXISTS ix_rule_version_rule ON orchestrator.rule_version(rule_id, status);
CREATE INDEX IF NOT EXISTS ix_rule_scope_lookup ON orchestrator.rule_scope(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS ix_job_scenario_version ON orchestrator.job(scenario_version_id, created_at);
CREATE INDEX IF NOT EXISTS ix_job_status_queue ON orchestrator.job(status, queued_at);
CREATE INDEX IF NOT EXISTS ix_submission_status ON orchestrator.submission(status, submitted_at);
CREATE INDEX IF NOT EXISTS ix_submission_scenario_version ON orchestrator.submission(scenario_version_id);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON orchestrator.audit_event(entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_audit_occurred ON orchestrator.audit_event(occurred_at);
CREATE INDEX IF NOT EXISTS ix_outbox_ready ON orchestrator.outbox_event(status, available_at);
CREATE INDEX IF NOT EXISTS ix_idempotency_expiry ON orchestrator.idempotency_key(expires_at);

INSERT INTO orchestrator.schema_migration (version, name)
VALUES (1, '0001_orchestrator')
ON CONFLICT (version) DO NOTHING;
