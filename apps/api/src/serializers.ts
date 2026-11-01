import type { Selectable } from 'kysely';
import { etag, isoDate, safeJson } from './http.js';
import type {
  AuditEventTable,
  JobTable,
  ModelTable,
  ModelVersionTable,
  PlanTable,
  PlanVersionTable,
  PromotionTable,
  RuleTable,
  RuleVersionTable,
  ScenarioTable,
  ScenarioVersionTable,
  SubmissionTable,
} from './schema.js';

type ModelRow = Selectable<ModelTable>;
type ModelVersionRow = Selectable<ModelVersionTable>;
type ScenarioRow = Selectable<ScenarioTable>;
type ScenarioVersionRow = Selectable<ScenarioVersionTable>;
type JobRow = Selectable<JobTable>;
type SubmissionRow = Selectable<SubmissionTable>;
type PromotionRow = Selectable<PromotionTable>;
type PlanRow = Selectable<PlanTable>;
type PlanVersionRow = Selectable<PlanVersionTable>;
type RuleRow = Selectable<RuleTable>;
type RuleVersionRow = Selectable<RuleVersionTable>;
type AuditEventRow = Selectable<AuditEventTable>;

/**
 * DuckDB DATE values arrive as local-midnight Date objects. Serializing them
 * with toISOString() shifts the date in non-UTC time zones, so use the local
 * calendar components.
 */
function isoDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toModelVersionSummary(row: ModelVersionRow) {
  return {
    model_version_id: row.model_version_id,
    version_number: row.version_number,
    status: row.status,
    cube_refresh_status: row.cube_refresh_status,
    created_at: isoDate(row.created_at),
    published_at: isoDate(row.published_at),
  };
}

export function toModel(row: ModelRow, latest: ModelVersionRow) {
  return {
    model_id: row.model_id,
    code: row.code,
    name: row.name,
    description: row.description,
    department_code: row.department_code,
    visibility: row.visibility,
    status: row.status,
    owner_subject: row.owner_subject,
    latest_version: toModelVersionSummary(latest),
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
    etag: etag(row.row_version),
  };
}

export function cubeRefresh(row: ModelVersionRow) {
  return {
    status: row.cube_refresh_status,
    requested_at: isoDate(row.cube_refresh_requested_at),
    completed_at: isoDate(row.cube_refresh_completed_at),
    error: row.cube_refresh_error,
  };
}

export function toModelVersion(row: ModelVersionRow) {
  return {
    model_version_id: row.model_version_id,
    model_id: row.model_id,
    version_number: row.version_number,
    status: row.status,
    definition: safeJson(row.definition, {}),
    validation: safeJson(row.validation_report, null),
    cube_refresh: cubeRefresh(row),
    created_by: row.created_by,
    created_at: isoDate(row.created_at),
    published_by: row.published_by,
    published_at: isoDate(row.published_at),
    superseded_by_version_id: row.superseded_by_version_id,
    etag: etag(row.row_version),
  };
}

export function toScenarioVersionSummary(row: ScenarioVersionRow) {
  return {
    scenario_version_id: row.scenario_version_id,
    version_number: row.version_number,
    status: row.status,
    review_status: row.review_status,
    created_at: isoDate(row.created_at),
    completed_at: isoDate(row.completed_at),
  };
}

export function toScenario(row: ScenarioRow, latest: ScenarioVersionRow) {
  return {
    scenario_id: row.scenario_id,
    code: row.code,
    name: row.name,
    description: row.description,
    scenario_type: row.scenario_type,
    department_code: row.department_code,
    cost_centre_code: row.cost_centre_code,
    status: row.status,
    owner_subject: row.owner_subject,
    latest_version: toScenarioVersionSummary(latest),
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
    etag: etag(row.row_version),
  };
}

function scenarioBase(row: ScenarioVersionRow) {
  if (row.base_type === 'plan') {
    return { base_type: 'plan', plan_version_id: row.base_plan_version_id };
  }
  if (row.base_type === 'scenario') {
    return { base_type: 'scenario', scenario_version_id: row.base_scenario_version_id };
  }
  return { base_type: 'actuals', actuals_as_of: isoDateOnly(row.actuals_as_of) };
}

export function toScenarioVersion(
  row: ScenarioVersionRow,
  options: { latestJob?: Record<string, unknown> | null; result?: Record<string, unknown> | null } = {}
) {
  return {
    scenario_version_id: row.scenario_version_id,
    scenario_id: row.scenario_id,
    version_number: row.version_number,
    status: row.status,
    review_status: row.review_status,
    model_version_id: row.model_version_id,
    base: scenarioBase(row),
    period_start: isoDateOnly(row.period_start),
    period_end: isoDateOnly(row.period_end),
    currency_code: row.currency_code,
    drivers: safeJson(row.drivers, []),
    adjustments: safeJson(row.adjustments, []),
    assumptions: safeJson(row.assumptions, []),
    validation: safeJson(row.validation_report, null),
    latest_job: options.latestJob ?? null,
    result: options.result ?? null,
    created_by: row.created_by,
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
    completed_at: isoDate(row.completed_at),
    etag: etag(row.row_version),
  };
}

export function toJobSummary(row: JobRow) {
  return {
    job_id: row.job_id,
    scenario_version_id: row.scenario_version_id,
    status: row.status,
    attempt: row.attempt,
    queued_at: isoDate(row.queued_at),
    finished_at: isoDate(row.finished_at),
  };
}

export function toJob(row: JobRow) {
  const payload = safeJson<Record<string, unknown>>(row.payload, {});
  return {
    job_id: row.job_id,
    scenario_version_id: row.scenario_version_id,
    status: row.status,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    retry_of_job_id: row.retry_of_job_id,
    engine_version: row.engine_version,
    inputs: payload.inputs ?? {},
    result: safeJson(row.result, null),
    error: row.error_code
      ? { code: row.error_code, message: row.error_message ?? 'Job failed', retryable: false }
      : null,
    queued_at: isoDate(row.queued_at),
    started_at: isoDate(row.started_at),
    finished_at: isoDate(row.finished_at),
    created_by: row.created_by,
    created_at: isoDate(row.created_at),
    etag: etag(row.row_version),
  };
}

export function toSubmission(row: SubmissionRow) {
  return {
    submission_id: row.submission_id,
    scenario_version_id: row.scenario_version_id,
    status: row.status,
    note: row.note,
    submitted_by: row.submitted_by,
    submitted_at: isoDate(row.submitted_at),
    decided_by: row.decided_by,
    decided_at: isoDate(row.decided_at),
    decision_comment: row.decision_comment,
    promotion_id: row.promotion_id,
    etag: etag(row.row_version),
  };
}

export function toPromotion(row: PromotionRow) {
  return {
    promotion_id: row.promotion_id,
    submission_id: row.submission_id,
    plan_id: row.plan_id,
    plan_version_id: row.plan_version_id,
    status: row.status,
    requested_at: isoDate(row.requested_at),
    completed_at: isoDate(row.completed_at),
    error: row.error_code
      ? { code: row.error_code, message: row.error_message ?? 'Promotion failed', retryable: false }
      : null,
    etag: etag(row.row_version),
  };
}

export function toPlanVersionSummary(row: PlanVersionRow) {
  return {
    plan_version_id: row.plan_version_id,
    version_number: row.version_number,
    status: row.status,
    effective_from: isoDateOnly(row.effective_from),
    published_at: isoDate(row.published_at),
  };
}

export function toPlan(row: PlanRow, latest: PlanVersionRow | null) {
  return {
    plan_id: row.plan_id,
    code: row.code,
    name: row.name,
    department_code: row.department_code,
    fiscal_year: row.fiscal_year,
    status: row.status,
    latest_version: latest ? toPlanVersionSummary(latest) : null,
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
    etag: etag(row.row_version),
  };
}

export function toPlanVersion(row: PlanVersionRow) {
  return {
    plan_version_id: row.plan_version_id,
    plan_id: row.plan_id,
    version_number: row.version_number,
    status: row.status,
    source_scenario_version_id: row.source_scenario_version_id,
    source_submission_id: row.source_submission_id,
    effective_from: isoDateOnly(row.effective_from),
    totals: safeJson(row.totals, {}),
    published_by: row.published_by,
    published_at: isoDate(row.published_at),
    etag: etag(row.row_version),
  };
}

export function toRuleVersionSummary(row: RuleVersionRow) {
  return {
    rule_version_id: row.rule_version_id,
    version_number: row.version_number,
    status: row.status,
    evaluation_point: row.evaluation_point,
    effective_from: isoDateOnly(row.effective_from),
    effective_to: isoDateOnly(row.effective_to),
  };
}

export function toRule(row: RuleRow, latest: RuleVersionRow | null) {
  return {
    rule_id: row.rule_id,
    code: row.code,
    name: row.name,
    description: row.description,
    owner_department_code: row.owner_department_code,
    status: row.status,
    latest_version: latest ? toRuleVersionSummary(latest) : null,
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
    etag: etag(row.row_version),
  };
}

export function toRuleVersion(row: RuleVersionRow, scopes: Array<{ scope_type: string; scope_id: string | null }>) {
  return {
    rule_version_id: row.rule_version_id,
    rule_id: row.rule_id,
    version_number: row.version_number,
    status: row.status,
    evaluation_point: row.evaluation_point,
    priority: row.priority,
    effective_from: isoDateOnly(row.effective_from),
    effective_to: isoDateOnly(row.effective_to),
    scopes,
    definition: safeJson(row.definition, {}),
    validation: safeJson(row.validation_report, null),
    created_by: row.created_by,
    created_at: isoDate(row.created_at),
    published_by: row.published_by,
    published_at: isoDate(row.published_at),
    retired_at: isoDate(row.retired_at),
    etag: etag(row.row_version),
  };
}

export function toAuditEvent(row: AuditEventRow) {
  return {
    audit_event_id: row.audit_event_id,
    occurred_at: isoDate(row.occurred_at),
    actor_subject: row.actor_subject,
    actor_department_code: row.actor_department_code,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_version: row.entity_version,
    correlation_id: row.correlation_id,
    request_id: row.request_id,
    before_state: safeJson(row.before_state, null),
    after_state: safeJson(row.after_state, null),
    metadata: safeJson(row.metadata, null),
  };
}
