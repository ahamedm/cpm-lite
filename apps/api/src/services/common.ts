import type { Kysely, Selectable } from 'kysely';
import { canReadDepartment, type AuthUser } from './../auth.js';
import { notFound } from './../errors.js';
import type {
  Database,
  JobTable,
  ModelTable,
  ModelVersionTable,
  PlanTable,
  PlanVersionTable,
  RuleTable,
  RuleVersionTable,
  ScenarioTable,
  ScenarioVersionTable,
  SubmissionTable,
} from './../schema.js';

export interface RequestContext {
  correlationId: string;
  requestId: string | null;
}

export type ModelRow = Selectable<ModelTable>;
export type ModelVersionRow = Selectable<ModelVersionTable>;
export type ScenarioRow = Selectable<ScenarioTable>;
export type ScenarioVersionRow = Selectable<ScenarioVersionTable>;
export type JobRow = Selectable<JobTable>;
export type SubmissionRow = Selectable<SubmissionTable>;
export type PlanRow = Selectable<PlanTable>;
export type PlanVersionRow = Selectable<PlanVersionTable>;
export type RuleRow = Selectable<RuleTable>;
export type RuleVersionRow = Selectable<RuleVersionTable>;

export function canReadModel(user: AuthUser, model: Pick<ModelRow, 'department_code' | 'visibility'>): boolean {
  return model.visibility === 'global' || canReadDepartment(user, model.department_code);
}

export async function getModelWithLatest(
  db: Kysely<Database>,
  modelId: string,
  user: AuthUser
): Promise<{ model: ModelRow; latest: ModelVersionRow }> {
  const model = await db.selectFrom('model').selectAll().where('model_id', '=', modelId).executeTakeFirst();
  if (!model || !canReadModel(user, model)) throw notFound('Model');

  const latest = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_id', '=', modelId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!latest) throw notFound('Model version');
  return { model, latest };
}

export async function getModelVersionWithModel(
  db: Kysely<Database>,
  modelVersionId: string,
  user: AuthUser
): Promise<{ version: ModelVersionRow; model: ModelRow }> {
  const version = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .executeTakeFirst();
  if (!version) throw notFound('Model version');

  const model = await db.selectFrom('model').selectAll().where('model_id', '=', version.model_id).executeTakeFirst();
  if (!model || !canReadModel(user, model)) throw notFound('Model version');
  return { version, model };
}

export async function getScenarioWithLatest(
  db: Kysely<Database>,
  scenarioId: string,
  user: AuthUser
): Promise<{ scenario: ScenarioRow; latest: ScenarioVersionRow }> {
  const scenario = await db.selectFrom('scenario').selectAll().where('scenario_id', '=', scenarioId).executeTakeFirst();
  if (!scenario || !canReadDepartment(user, scenario.department_code)) throw notFound('Scenario');

  const latest = await db
    .selectFrom('scenario_version')
    .selectAll()
    .where('scenario_id', '=', scenarioId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!latest) throw notFound('Scenario version');
  return { scenario, latest };
}

export async function getScenarioVersionWithScenario(
  db: Kysely<Database>,
  scenarioVersionId: string,
  user: AuthUser
): Promise<{ version: ScenarioVersionRow; scenario: ScenarioRow }> {
  const version = await db
    .selectFrom('scenario_version')
    .selectAll()
    .where('scenario_version_id', '=', scenarioVersionId)
    .executeTakeFirst();
  if (!version) throw notFound('Scenario version');

  const scenario = await db.selectFrom('scenario').selectAll().where('scenario_id', '=', version.scenario_id).executeTakeFirst();
  if (!scenario || !canReadDepartment(user, scenario.department_code)) throw notFound('Scenario version');
  return { version, scenario };
}

export async function getJobWithScope(
  db: Kysely<Database>,
  jobId: string,
  user: AuthUser
): Promise<{ job: JobRow; version: ScenarioVersionRow; scenario: ScenarioRow }> {
  const job = await db.selectFrom('job').selectAll().where('job_id', '=', jobId).executeTakeFirst();
  if (!job) throw notFound('Job');
  const { version, scenario } = await getScenarioVersionWithScenario(db, job.scenario_version_id, user);
  return { job, version, scenario };
}

export async function getSubmissionWithScenario(
  db: Kysely<Database>,
  submissionId: string,
  user: AuthUser
): Promise<{ submission: SubmissionRow; version: ScenarioVersionRow; scenario: ScenarioRow }> {
  const submission = await db.selectFrom('submission').selectAll().where('submission_id', '=', submissionId).executeTakeFirst();
  if (!submission) throw notFound('Submission');
  const { version, scenario } = await getScenarioVersionWithScenario(db, submission.scenario_version_id, user);
  return { submission, version, scenario };
}

export async function getPlan(
  db: Kysely<Database>,
  planId: string,
  user: AuthUser
): Promise<PlanRow> {
  const plan = await db.selectFrom('plan').selectAll().where('plan_id', '=', planId).executeTakeFirst();
  if (!plan || !canReadDepartment(user, plan.department_code)) throw notFound('Plan');
  return plan;
}

export async function getLatestPlanVersion(
  db: Kysely<Database>,
  planId: string
): Promise<PlanVersionRow | null> {
  return (await db
    .selectFrom('plan_version')
    .selectAll()
    .where('plan_id', '=', planId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst()) ?? null;
}

export async function getRule(db: Kysely<Database>, ruleId: string): Promise<RuleRow> {
  const rule = await db.selectFrom('rule').selectAll().where('rule_id', '=', ruleId).executeTakeFirst();
  if (!rule) throw notFound('Rule');
  return rule;
}

export async function getLatestRuleVersion(
  db: Kysely<Database>,
  ruleId: string
): Promise<RuleVersionRow | null> {
  return (await db
    .selectFrom('rule_version')
    .selectAll()
    .where('rule_id', '=', ruleId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst()) ?? null;
}

export async function getRuleVersionWithScopes(
  db: Kysely<Database>,
  ruleVersionId: string
): Promise<{ version: RuleVersionRow; scopes: Array<{ scope_type: string; scope_id: string | null }> }> {
  const version = await db
    .selectFrom('rule_version')
    .selectAll()
    .where('rule_version_id', '=', ruleVersionId)
    .executeTakeFirst();
  if (!version) throw notFound('Rule version');
  const scopes = await db
    .selectFrom('rule_scope')
    .select(['scope_type', 'scope_id'])
    .where('rule_version_id', '=', ruleVersionId)
    .orderBy('scope_type')
    .execute();
  return { version, scopes };
}
