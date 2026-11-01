import type { Generated } from 'kysely';

/**
 * Kysely's DuckDB dialect cannot bind JavaScript Date objects (the DuckDB node
 * API receives them as ANY). Timestamps are therefore passed as ISO strings and
 * read back as Date objects.
 */
export type Timestamp = Date | string;
export type NullableTimestamp = Timestamp | null;

export interface DepartmentTable {
  department_code: string;
  department_name: string;
  created_at: Generated<Timestamp>;
}

export interface CostCentreTable {
  cost_centre_code: string;
  department_code: string;
  cost_centre_name: string;
  created_at: Generated<Timestamp>;
}

export interface ModelTable {
  model_id: string;
  code: string;
  name: string;
  description: string | null;
  department_code: string;
  visibility: string;
  status: string;
  owner_subject: string;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  row_version: Generated<number>;
}

export interface ModelVersionTable {
  model_version_id: string;
  model_id: string;
  version_number: number;
  status: string;
  definition: string;
  validation_report: string | null;
  cube_refresh_status: string;
  cube_refresh_requested_at: NullableTimestamp;
  cube_refresh_completed_at: NullableTimestamp;
  cube_refresh_error: string | null;
  created_by: string;
  created_at: Generated<Timestamp>;
  published_by: string | null;
  published_at: NullableTimestamp;
  superseded_by_version_id: string | null;
  row_version: Generated<number>;
}

export interface PlanTable {
  plan_id: string;
  code: string;
  name: string;
  department_code: string;
  fiscal_year: number;
  status: string;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  row_version: Generated<number>;
}

export interface PlanVersionTable {
  plan_version_id: string;
  plan_id: string;
  version_number: number;
  status: string;
  source_scenario_version_id: string;
  source_submission_id: string;
  effective_from: string;
  totals: string;
  published_by: string;
  published_at: Generated<Timestamp>;
  row_version: Generated<number>;
}

export interface ScenarioTable {
  scenario_id: string;
  code: string;
  name: string;
  description: string | null;
  scenario_type: string;
  department_code: string;
  cost_centre_code: string | null;
  status: string;
  owner_subject: string;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  row_version: Generated<number>;
}

export interface ScenarioVersionTable {
  scenario_version_id: string;
  scenario_id: string;
  version_number: number;
  model_version_id: string;
  status: string;
  review_status: string;
  base_type: string;
  base_plan_version_id: string | null;
  base_scenario_version_id: string | null;
  actuals_as_of: string | null;
  period_start: string;
  period_end: string;
  currency_code: string;
  drivers: string;
  adjustments: string;
  assumptions: string;
  validation_report: string | null;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  completed_at: NullableTimestamp;
  row_version: Generated<number>;
}

export interface RuleTable {
  rule_id: string;
  code: string;
  name: string;
  description: string | null;
  owner_department_code: string | null;
  status: string;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  row_version: Generated<number>;
}

export interface RuleVersionTable {
  rule_version_id: string;
  rule_id: string;
  version_number: number;
  status: string;
  evaluation_point: string;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  definition: string;
  validation_report: string | null;
  created_by: string;
  created_at: Generated<Timestamp>;
  published_by: string | null;
  published_at: NullableTimestamp;
  retired_at: NullableTimestamp;
  row_version: Generated<number>;
}

export interface RuleScopeTable {
  rule_scope_id: string;
  rule_version_id: string;
  scope_type: string;
  scope_id: string | null;
}

export interface JobTable {
  job_id: string;
  scenario_version_id: string;
  status: string;
  attempt: number;
  max_attempts: number;
  retry_of_job_id: string | null;
  engine_version: string;
  payload: string;
  idempotency_key: string | null;
  error_code: string | null;
  error_message: string | null;
  result_uri: string | null;
  result: string | null;
  queued_at: Generated<Timestamp>;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  created_by: string;
  created_at: Generated<Timestamp>;
  row_version: Generated<number>;
}

export interface JobRuleVersionTable {
  job_id: string;
  rule_version_id: string;
}

export interface SubmissionTable {
  submission_id: string;
  scenario_version_id: string;
  status: string;
  note: string | null;
  submitted_by: string;
  submitted_at: Generated<Timestamp>;
  decided_by: string | null;
  decided_at: NullableTimestamp;
  decision_comment: string | null;
  promotion_id: string | null;
  row_version: Generated<number>;
}

export interface SubmissionDecisionTable {
  decision_id: string;
  submission_id: string;
  decision: string;
  comment: string | null;
  actor_subject: string;
  created_at: Generated<Timestamp>;
}

export interface PromotionTable {
  promotion_id: string;
  submission_id: string;
  plan_id: string;
  plan_version_id: string | null;
  status: string;
  requested_by: string;
  requested_at: Generated<Timestamp>;
  completed_at: NullableTimestamp;
  error_code: string | null;
  error_message: string | null;
  row_version: Generated<number>;
}

export interface AuditEventTable {
  audit_event_id: string;
  occurred_at: Generated<Timestamp>;
  actor_subject: string;
  actor_department_code: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_version: number | null;
  correlation_id: string;
  request_id: string | null;
  before_state: string | null;
  after_state: string | null;
  metadata: string | null;
}

export interface IdempotencyKeyTable {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
}

export interface OutboxEventTable {
  outbox_event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  status: string;
  attempts: Generated<number>;
  available_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
  processed_at: NullableTimestamp;
  last_error: string | null;
}

export interface SchemaMigrationTable {
  version: number;
  name: string;
  applied_at: Generated<Timestamp>;
}

export interface Database {
  department: DepartmentTable;
  cost_centre: CostCentreTable;
  model: ModelTable;
  model_version: ModelVersionTable;
  plan: PlanTable;
  plan_version: PlanVersionTable;
  scenario: ScenarioTable;
  scenario_version: ScenarioVersionTable;
  rule: RuleTable;
  rule_version: RuleVersionTable;
  rule_scope: RuleScopeTable;
  job: JobTable;
  job_rule_version: JobRuleVersionTable;
  submission: SubmissionTable;
  submission_decision: SubmissionDecisionTable;
  promotion: PromotionTable;
  audit_event: AuditEventTable;
  idempotency_key: IdempotencyKeyTable;
  outbox_event: OutboxEventTable;
  schema_migration: SchemaMigrationTable;
}
