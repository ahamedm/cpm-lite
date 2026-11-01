import type { Kysely } from 'kysely';
import type { AuthUser } from '../auth.js';
import { assertDepartmentWrite, canReadDepartment } from '../auth.js';
import type { AppConfig } from '../config.js';
import type { InternalJobStatusRequest } from '../contracts.js';
import { conflict, notFound, preconditionFailed, unprocessable } from '../errors.js';
import { pageInfo, parseLimit, parseOffsetCursor, safeJson, uuid } from '../http.js';
import type { Database } from '../schema.js';
import { toJob, toJobSummary } from '../serializers.js';
import { writeAudit, writeOutbox } from '../audit.js';
import { evaluateValidationRules } from '../rules-engine.js';
import {
  getJobWithScope,
  getScenarioVersionWithScenario,
  type JobRow,
  type RequestContext,
  type ScenarioRow,
  type ScenarioVersionRow,
} from './common.js';

type ListQuery = Record<string, string | undefined>;

function dateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isTerminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

export async function submitScenarioJob(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioVersionId: string,
  expectedVersion: number,
  config: AppConfig,
  context: RequestContext
) {
  const { version, scenario } = await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  assertDepartmentWrite(user, scenario.department_code);
  if (expectedVersion !== version.row_version) throw preconditionFailed();
  if (['queued', 'running', 'completed'].includes(version.status)) {
    throw conflict('job_already_active', `Scenario version is already ${version.status}`);
  }

  const drivers = safeJson<Array<{ driver_code?: string }>>(version.drivers, []);
  const evaluation = await evaluateValidationRules(db, {
    departmentCode: scenario.department_code,
    costCentreCode: scenario.cost_centre_code,
    scenarioType: scenario.scenario_type,
    periodStart: version.period_start,
    periodEnd: version.period_end,
    drivers,
  });

  const report = {
    valid: evaluation.valid,
    validated_at: new Date().toISOString(),
    issues: evaluation.issues,
    resolved_rule_versions: evaluation.resolved_rules,
  };

  if (!evaluation.valid) {
    await db
      .updateTable('scenario_version')
      .set({
        validation_report: JSON.stringify(report),
        status: 'draft',
        updated_at: new Date(),
        row_version: version.row_version + 1,
      })
      .where('scenario_version_id', '=', scenarioVersionId)
      .where('row_version', '=', version.row_version)
      .execute();
    throw unprocessable('Pre-submit validation failed', report.issues);
  }

  const jobId = uuid();
  const now = new Date();
  const ruleVersionIds = evaluation.resolved_rules.map((rule) => rule.rule_version_id);
  const inputs = {
    scenario_version_id: scenarioVersionId,
    model_version_id: version.model_version_id,
    rule_version_ids: ruleVersionIds,
    dataset_snapshot: config.datasetSnapshot,
    period_start: dateOnly(version.period_start),
    period_end: dateOnly(version.period_end),
    allocation_strategy: null,
    engine_version: config.engineVersion,
  };
  const payload = {
    inputs,
    scenario: {
      base_type: version.base_type,
      base_plan_version_id: version.base_plan_version_id,
      base_scenario_version_id: version.base_scenario_version_id,
      actuals_as_of: version.actuals_as_of,
      currency_code: version.currency_code,
      drivers: safeJson(version.drivers, []),
      adjustments: safeJson(version.adjustments, []),
      assumptions: safeJson(version.assumptions, []),
    },
  };

  const job = await db.transaction().execute(async (trx) => {
    const update = await trx
      .updateTable('scenario_version')
      .set({
        status: 'queued',
        validation_report: JSON.stringify(report),
        updated_at: now,
        row_version: version.row_version + 1,
      })
      .where('scenario_version_id', '=', scenarioVersionId)
      .where('row_version', '=', version.row_version)
      .executeTakeFirst();
    if (Number(update.numUpdatedRows) === 0) throw preconditionFailed();

    await trx
      .insertInto('job')
      .values({
        job_id: jobId,
        scenario_version_id: scenarioVersionId,
        status: 'queued',
        attempt: 1,
        max_attempts: config.maxJobAttempts,
        retry_of_job_id: null,
        engine_version: config.engineVersion,
        payload: JSON.stringify(payload),
        idempotency_key: null,
        error_code: null,
        error_message: null,
        result_uri: null,
        result: null,
        queued_at: now,
        started_at: null,
        finished_at: null,
        created_by: user.subject,
        created_at: now,
        row_version: 1,
      })
      .execute();

    for (const ruleVersionId of ruleVersionIds) {
      await trx
        .insertInto('job_rule_version')
        .values({ job_id: jobId, rule_version_id: ruleVersionId })
        .execute();
    }

    await writeOutbox(trx, {
      eventType: 'job.dispatch_requested',
      aggregateType: 'job',
      aggregateId: jobId,
      payload: { job_id: jobId, scenario_version_id: scenarioVersionId },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'job.submitted',
      entityType: 'job',
      entityId: jobId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { scenario_version_id: scenarioVersionId, status: 'queued', attempt: 1 },
    });

    return trx.selectFrom('job').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
  });

  return { payload: toJob(job), rowVersion: job.row_version };
}

export async function listJobs(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);

  let builder = db
    .selectFrom('job')
    .innerJoin('scenario_version', 'scenario_version.scenario_version_id', 'job.scenario_version_id')
    .innerJoin('scenario', 'scenario.scenario_id', 'scenario_version.scenario_id')
    .selectAll('job');

  if (!user.isSteward) builder = builder.where('scenario.department_code', '=', user.departmentCode ?? '');
  if (query.department_code) {
    if (!canReadDepartment(user, query.department_code)) {
      return { data: [], page_info: { has_more: false, next_cursor: null } };
    }
    builder = builder.where('scenario.department_code', '=', query.department_code);
  }
  if (query.status) builder = builder.where('job.status', '=', query.status);
  if (query.scenario_version_id) builder = builder.where('job.scenario_version_id', '=', query.scenario_version_id);
  if (query.created_from) builder = builder.where('job.created_at', '>=', new Date(query.created_from));
  if (query.created_to) builder = builder.where('job.created_at', '<=', new Date(query.created_to));

  const rows = await builder
    .orderBy('job.created_at', 'desc')
    .orderBy('job.job_id', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();

  return { data: rows.slice(0, limit).map(toJobSummary), page_info: pageInfo(offset, limit, rows.length) };
}

export async function listScenarioVersionJobs(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioVersionId: string,
  query: ListQuery
) {
  await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  let builder = db.selectFrom('job').selectAll().where('scenario_version_id', '=', scenarioVersionId);
  if (query.status) builder = builder.where('status', '=', query.status);

  const rows = await builder
    .orderBy('created_at', 'desc')
    .orderBy('job_id', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return { data: rows.slice(0, limit).map(toJobSummary), page_info: pageInfo(offset, limit, rows.length) };
}

export async function getJob(db: Kysely<Database>, user: AuthUser, jobId: string) {
  const { job } = await getJobWithScope(db, jobId, user);
  return { payload: toJob(job), rowVersion: job.row_version };
}

export async function cancelJob(
  db: Kysely<Database>,
  user: AuthUser,
  jobId: string,
  context: RequestContext
) {
  const { job, version, scenario } = await getJobWithScope(db, jobId, user);
  assertDepartmentWrite(user, scenario.department_code);
  if (isTerminal(job.status)) {
    return { payload: toJob(job), rowVersion: job.row_version, alreadyTerminal: true };
  }

  const now = new Date();
  const updated = await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('job')
      .set({ status: 'cancelled', finished_at: now, row_version: job.row_version + 1 })
      .where('job_id', '=', jobId)
      .where('row_version', '=', job.row_version)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

    await trx
      .updateTable('scenario_version')
      .set({ status: 'cancelled', updated_at: now, row_version: version.row_version + 1 })
      .where('scenario_version_id', '=', version.scenario_version_id)
      .execute();

    await writeOutbox(trx, {
      eventType: 'job.cancel_requested',
      aggregateType: 'job',
      aggregateId: jobId,
      payload: { job_id: jobId },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'job.cancelled',
      entityType: 'job',
      entityId: jobId,
      entityVersion: job.row_version + 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      before: { status: job.status },
      after: { status: 'cancelled' },
    });
    return trx.selectFrom('job').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
  });

  return { payload: toJob(updated), rowVersion: updated.row_version, alreadyTerminal: false };
}

export async function retryJob(
  db: Kysely<Database>,
  user: AuthUser,
  jobId: string,
  config: AppConfig,
  context: RequestContext
) {
  const { job, version } = await getJobWithScope(db, jobId, user);
  const scenario = await db.selectFrom('scenario').selectAll().where('scenario_id', '=', version.scenario_id).executeTakeFirstOrThrow();
  assertDepartmentWrite(user, scenario.department_code);
  if (!['failed', 'cancelled'].includes(job.status)) {
    throw conflict('job_not_retryable', 'Only failed or cancelled jobs can be retried');
  }
  if (job.attempt >= job.max_attempts) {
    throw conflict('retry_limit_reached', `Job reached max_attempts (${job.max_attempts})`);
  }

  const newJobId = uuid();
  const now = new Date();
  const newJob = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('job')
      .values({
        job_id: newJobId,
        scenario_version_id: job.scenario_version_id,
        status: 'queued',
        attempt: job.attempt + 1,
        max_attempts: job.max_attempts,
        retry_of_job_id: job.job_id,
        engine_version: job.engine_version,
        payload: job.payload,
        idempotency_key: null,
        error_code: null,
        error_message: null,
        result_uri: null,
        result: null,
        queued_at: now,
        started_at: null,
        finished_at: null,
        created_by: user.subject,
        created_at: now,
        row_version: 1,
      })
      .execute();

    const rules = await trx
      .selectFrom('job_rule_version')
      .select('rule_version_id')
      .where('job_id', '=', job.job_id)
      .execute();
    for (const rule of rules) {
      await trx
        .insertInto('job_rule_version')
        .values({ job_id: newJobId, rule_version_id: rule.rule_version_id })
        .execute();
    }

    await trx
      .updateTable('scenario_version')
      .set({ status: 'queued', completed_at: null, updated_at: now, row_version: version.row_version + 1 })
      .where('scenario_version_id', '=', version.scenario_version_id)
      .execute();

    await writeOutbox(trx, {
      eventType: 'job.dispatch_requested',
      aggregateType: 'job',
      aggregateId: newJobId,
      payload: { job_id: newJobId, scenario_version_id: job.scenario_version_id, retry_of_job_id: job.job_id },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'job.retried',
      entityType: 'job',
      entityId: newJobId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { retry_of_job_id: job.job_id, attempt: job.attempt + 1 },
    });
    return trx.selectFrom('job').selectAll().where('job_id', '=', newJobId).executeTakeFirstOrThrow();
  });

  return { payload: toJob(newJob), rowVersion: newJob.row_version };
}

export async function internalUpdateJob(
  db: Kysely<Database>,
  jobId: string,
  body: InternalJobStatusRequest,
  context: RequestContext
) {
  const job = await db.selectFrom('job').selectAll().where('job_id', '=', jobId).executeTakeFirst();
  if (!job) throw notFound('Job');
  if (!['running', 'completed', 'failed', 'cancelled'].includes(body.status)) {
    throw unprocessable('Worker status must be running, completed, failed or cancelled');
  }
  if (isTerminal(job.status) && job.status === body.status) {
    return { payload: toJob(job), rowVersion: job.row_version };
  }
  if (isTerminal(job.status)) {
    throw conflict('job_terminal', `Job is already ${job.status}`);
  }
  if (body.status === 'running' && !['queued', 'running'].includes(job.status)) {
    throw conflict('invalid_transition', `Cannot move job from ${job.status} to running`);
  }

  const version = await db
    .selectFrom('scenario_version')
    .selectAll()
    .where('scenario_version_id', '=', job.scenario_version_id)
    .executeTakeFirstOrThrow();
  const now = new Date();
  let resultUri: string | null = null;
  let resultJson: string | null = null;
  let statusCode: string | null = null;
  let statusMessage: string | null = null;

  if (body.status === 'completed') {
    if (!body.result || typeof body.result.result_uri !== 'string') {
      throw unprocessable('Completed job callback requires result.result_uri');
    }
    resultUri = body.result.result_uri as string;
    resultJson = JSON.stringify(body.result);
  }
  if (body.status === 'failed') {
    statusCode = body.error?.code ?? 'job_failed';
    statusMessage = body.error?.message ?? 'Job failed';
  }

  const updated = await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('job')
      .set({
        status: body.status,
        ...(body.status === 'running' ? { started_at: now } : {}),
        ...(isTerminal(body.status) ? { finished_at: now } : {}),
        ...(resultUri ? { result_uri: resultUri } : {}),
        ...(resultJson ? { result: resultJson } : {}),
        ...(statusCode ? { error_code: statusCode, error_message: statusMessage } : {}),
        row_version: job.row_version + 1,
      })
      .where('job_id', '=', jobId)
      .where('row_version', '=', job.row_version)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

    if (body.status === 'running') {
      await trx
        .updateTable('scenario_version')
        .set({ status: 'running', updated_at: now, row_version: version.row_version + 1 })
        .where('scenario_version_id', '=', version.scenario_version_id)
        .execute();
    } else if (body.status === 'completed') {
      await trx
        .updateTable('scenario_version')
        .set({
          status: 'completed',
          completed_at: now,
          review_status: 'not_submitted',
          updated_at: now,
          row_version: version.row_version + 1,
        })
        .where('scenario_version_id', '=', version.scenario_version_id)
        .execute();
    } else {
      await trx
        .updateTable('scenario_version')
        .set({ status: body.status, updated_at: now, row_version: version.row_version + 1 })
        .where('scenario_version_id', '=', version.scenario_version_id)
        .execute();
    }

    await writeAudit(trx, {
      actorSubject: 'system:worker',
      actorDepartmentCode: null,
      action: `job.${body.status}`,
      entityType: 'job',
      entityId: jobId,
      entityVersion: job.row_version + 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      before: { status: job.status },
      after: { status: body.status, ...(statusCode ? { error_code: statusCode } : {}) },
    });
    return trx.selectFrom('job').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
  });

  return { payload: toJob(updated), rowVersion: updated.row_version };
}
