export interface PageInfo {
  next_cursor: string | null;
  has_more: boolean;
}

export interface Page<T> {
  data: T[];
  page_info: PageInfo;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  path: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  validated_at: string;
  issues: ValidationIssue[];
  resolved_rule_versions?: Array<{ rule_version_id: string; rule_code: string; version_number: number }>;
}

export interface CubeRefresh {
  status: 'not_requested' | 'pending' | 'running' | 'succeeded' | 'failed';
  requested_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export interface Me {
  subject: string;
  display_name: string;
  email: string | null;
  department_code: string | null;
  cost_centre_codes: string[];
  roles: string[];
  groups: string[];
}

export interface ModelVersionSummary {
  model_version_id: string;
  version_number: number;
  status: 'draft' | 'validated' | 'published' | 'superseded';
  cube_refresh_status: CubeRefresh['status'];
  created_at: string;
  published_at: string | null;
}

export interface Model {
  model_id: string;
  code: string;
  name: string;
  description: string | null;
  department_code: string;
  visibility: 'department' | 'global';
  status: 'active' | 'archived';
  owner_subject: string;
  latest_version: ModelVersionSummary;
  created_at: string;
  updated_at: string;
  etag: string;
}

export interface ModelDefinition {
  schema_version: string;
  source?: {
    source_id: string;
  };
  access?: {
    row_level_field: string;
  };
  dimensions: Array<{
    code: string;
    name: string;
    data_type: string;
    expression: string;
    description?: string | null;
  }>;
  measures: Array<{
    code: string;
    name: string;
    aggregation: string;
    expression: string;
    format: string;
    currency_code?: string | null;
    description?: string | null;
  }>;
  joins?: Array<Record<string, unknown>>;
}

export interface ModelSourceColumn {
  name: string;
  label: string;
  data_type: 'string' | 'integer' | 'decimal' | 'date' | 'boolean';
  nullable: boolean;
  distinct_count: number;
  null_count: number;
  sample_values: string[];
  suggested_role: 'dimension' | 'measure' | 'time' | 'access';
  suggested_aggregation: string | null;
  format: string | null;
}

export interface ModelSourceRelationship {
  name: string;
  target_source_id: string;
  target_label: string;
  source_field: string;
  target_field: string;
  relationship: 'many_to_one';
}

export interface ModelSource {
  source_id: string;
  name: string;
  description: string;
  grain: string;
  grain_key: string;
  grain_unique: boolean;
  row_count: number;
  refreshed_at: string;
  columns: ModelSourceColumn[];
  relationships: ModelSourceRelationship[];
}

export interface ModelPreviewColumn {
  code: string;
  name: string;
  kind: 'dimension' | 'measure';
  data_type: string;
  format: string | null;
  currency_code: string | null;
}

export interface ModelPreview {
  source_id: string;
  columns: ModelPreviewColumn[];
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null>;
  row_count: number;
  truncated: boolean;
  scope: {
    department_code: string | null;
    applied: boolean;
    preview_as: boolean;
  };
  generated_at: string;
}

export interface ModelVersion {
  model_version_id: string;
  model_id: string;
  version_number: number;
  status: 'draft' | 'validated' | 'published' | 'superseded';
  definition: ModelDefinition;
  validation: ValidationReport | null;
  cube_refresh: CubeRefresh;
  created_by: string;
  created_at: string;
  published_by: string | null;
  published_at: string | null;
  superseded_by_version_id: string | null;
  etag: string;
}

export interface ScenarioVersionSummary {
  scenario_version_id: string;
  version_number: number;
  status: 'draft' | 'validated' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  review_status: 'not_submitted' | 'submitted' | 'approved' | 'rejected' | 'changes_requested' | 'promoted';
  created_at: string;
  completed_at: string | null;
}

export interface Scenario {
  scenario_id: string;
  code: string;
  name: string;
  description: string | null;
  scenario_type: 'budget' | 'forecast';
  department_code: string;
  cost_centre_code: string | null;
  status: 'active' | 'archived';
  owner_subject: string;
  latest_version: ScenarioVersionSummary;
  created_at: string;
  updated_at: string;
  etag: string;
}

export interface ScenarioBase {
  base_type: 'actuals' | 'plan' | 'scenario';
  actuals_as_of?: string | null;
  plan_version_id?: string | null;
  scenario_version_id?: string | null;
}

export interface ScenarioDriver {
  driver_code: string;
  name: string;
  value: string;
  unit: 'percent' | 'currency' | 'headcount' | 'number';
  dimension_filters?: Record<string, string>;
  note?: string | null;
}

export interface ScenarioAdjustment {
  adjustment_code: string;
  name: string;
  amount: string;
  currency_code: string;
  dimension_filters?: Record<string, string>;
  note?: string | null;
}

export interface ScenarioAssumption {
  assumption_code: string;
  name: string;
  value: string;
  unit: 'percent' | 'currency' | 'headcount' | 'number';
  note?: string | null;
}

export interface JobSummary {
  job_id: string;
  scenario_version_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  queued_at: string;
  finished_at: string | null;
}

export interface AllocationSummary {
  pool_total: string;
  allocated_total: string;
  residual: string;
  tolerance: string;
  within_tolerance: boolean;
  strategy: string;
  driver_basis: string | null;
}

export interface RuleOutcome {
  rule_version_id: string;
  rule_code: string;
  evaluation_point: string;
  decision: 'allow' | 'warn' | 'reject';
  message: string | null;
}

export interface FinancialTotals {
  budget_amount: string;
  actual_amount: string;
  variance_amount: string;
  currency_code: string;
}

export interface JobResult {
  result_uri: string;
  totals: FinancialTotals;
  allocation_summary: AllocationSummary;
  rule_outcomes: RuleOutcome[];
  completed_at: string;
}

export interface Job {
  job_id: string;
  scenario_version_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  max_attempts: number;
  retry_of_job_id: string | null;
  engine_version: string;
  inputs: {
    scenario_version_id: string;
    model_version_id: string;
    rule_version_ids: string[];
    dataset_snapshot: string;
    period_start: string;
    period_end: string;
    allocation_strategy: string | null;
    engine_version: string;
  };
  result: JobResult | null;
  error: { code: string; message: string; retryable: boolean } | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_by: string;
  created_at: string;
  etag: string;
}

export interface ScenarioVersion {
  scenario_version_id: string;
  scenario_id: string;
  version_number: number;
  status: ScenarioVersionSummary['status'];
  review_status: ScenarioVersionSummary['review_status'];
  model_version_id: string;
  base: ScenarioBase;
  period_start: string;
  period_end: string;
  currency_code: string;
  drivers: ScenarioDriver[];
  adjustments: ScenarioAdjustment[];
  assumptions: ScenarioAssumption[];
  validation: ValidationReport | null;
  latest_job: JobSummary | null;
  result: JobResult | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  etag: string;
}

export interface Submission {
  submission_id: string;
  scenario_version_id: string;
  status: 'submitted' | 'approved' | 'rejected' | 'changes_requested' | 'promoted';
  note: string | null;
  submitted_by: string;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  promotion_id: string | null;
  etag: string;
}

export interface Promotion {
  promotion_id: string;
  submission_id: string;
  plan_id: string;
  plan_version_id: string | null;
  status: 'requested' | 'running' | 'succeeded' | 'failed';
  requested_at: string;
  completed_at: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  etag: string;
}

export interface PlanVersionSummary {
  plan_version_id: string;
  version_number: number;
  status: 'published' | 'superseded';
  effective_from: string;
  published_at: string;
}

export interface Plan {
  plan_id: string;
  code: string;
  name: string;
  department_code: string;
  fiscal_year: number;
  status: 'active' | 'archived';
  latest_version: PlanVersionSummary | null;
  created_at: string;
  updated_at: string;
  etag: string;
}

export interface PlanVersion {
  plan_version_id: string;
  plan_id: string;
  version_number: number;
  status: 'published' | 'superseded';
  source_scenario_version_id: string;
  source_submission_id: string;
  effective_from: string;
  totals: FinancialTotals;
  published_by: string;
  published_at: string;
  etag: string;
}

export interface RuleVersionSummary {
  rule_version_id: string;
  version_number: number;
  status: 'draft' | 'active' | 'retired';
  evaluation_point: string;
  effective_from: string;
  effective_to: string | null;
}

export interface Rule {
  rule_id: string;
  code: string;
  name: string;
  description: string | null;
  owner_department_code: string | null;
  status: 'active' | 'archived';
  latest_version: RuleVersionSummary | null;
  created_at: string;
  updated_at: string;
  etag: string;
}

export interface RuleVersion {
  rule_version_id: string;
  rule_id: string;
  version_number: number;
  status: 'draft' | 'active' | 'retired';
  evaluation_point: 'pre_submit' | 'allocation' | 'post_calculation' | 'promotion';
  priority: number;
  effective_from: string;
  effective_to: string | null;
  scopes: Array<{ scope_type: string; scope_id: string | null }>;
  definition: { schema_version: string; kind: string; parameters: Record<string, unknown>; message_template?: string | null };
  validation: ValidationReport | null;
  created_by: string;
  created_at: string;
  published_by: string | null;
  published_at: string | null;
  retired_at: string | null;
  etag: string;
}

export interface AuditEvent {
  audit_event_id: string;
  occurred_at: string;
  actor_subject: string;
  actor_department_code: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_version: number | null;
  correlation_id: string;
  request_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface Department {
  department_code: string;
  department_name: string;
}

export interface CostCentre {
  cost_centre_code: string;
  department_code: string;
  cost_centre_name: string;
}
