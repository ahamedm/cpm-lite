import type { Kysely } from 'kysely';
import type { AuthUser } from '../auth.js';
import { assertDepartmentWrite, canReadDepartment, requireSteward } from '../auth.js';
import type { DecisionRequest, PlanCreateRequest, PromotionRequest, SubmissionCreateRequest } from '../contracts.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../errors.js';
import { pageInfo, parseLimit, parseOffsetCursor, safeJson, slugify, uuid } from '../http.js';
import type { Database } from '../schema.js';
import {
  toPlan,
  toPlanVersion,
  toPlanVersionSummary,
  toPromotion,
  toSubmission,
} from '../serializers.js';
import { writeAudit } from '../audit.js';
import { evaluatePromotionRules } from '../rules-engine.js';
import {
  getPlan,
  getScenarioVersionWithScenario,
  getSubmissionWithScenario,
  getLatestPlanVersion,
  type RequestContext,
} from './common.js';

type ListQuery = Record<string, string | undefined>;

async function latestCompletedResult(db: Kysely<Database>, scenarioVersionId: string) {
  const job = await db
    .selectFrom('job')
    .selectAll()
    .where('scenario_version_id', '=', scenarioVersionId)
    .where('status', '=', 'completed')
    .orderBy('finished_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!job?.result) return null;
  return safeJson<Record<string, any> | null>(job.result, null);
}

export async function submitScenarioVersion(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioVersionId: string,
  body: SubmissionCreateRequest,
  context: RequestContext
) {
  const { version, scenario } = await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  assertDepartmentWrite(user, scenario.department_code);
  if (version.status !== 'completed') throw conflict('scenario_not_completed', 'Only completed scenario versions can be submitted');
  if (version.review_status !== 'not_submitted') {
    throw conflict('already_submitted', `Scenario version is already ${version.review_status}`);
  }

  const existing = await db
    .selectFrom('submission')
    .select('submission_id')
    .where('scenario_version_id', '=', scenarioVersionId)
    .executeTakeFirst();
  if (existing) throw conflict('already_submitted', 'A submission already exists for this scenario version');

  const submissionId = uuid();
  const now = new Date();
  const submission = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('submission')
      .values({
        submission_id: submissionId,
        scenario_version_id: scenarioVersionId,
        status: 'submitted',
        note: body.note ?? null,
        submitted_by: user.subject,
        submitted_at: now,
        decided_by: null,
        decided_at: null,
        decision_comment: null,
        promotion_id: null,
        row_version: 1,
      })
      .execute();
    await trx
      .updateTable('scenario_version')
      .set({ review_status: 'submitted', updated_at: now, row_version: version.row_version + 1 })
      .where('scenario_version_id', '=', scenarioVersionId)
      .execute();
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'scenario_version.submitted',
      entityType: 'submission',
      entityId: submissionId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { scenario_version_id: scenarioVersionId, status: 'submitted' },
    });
    return trx.selectFrom('submission').selectAll().where('submission_id', '=', submissionId).executeTakeFirstOrThrow();
  });

  return { payload: toSubmission(submission), rowVersion: submission.row_version };
}

export async function listSubmissions(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);

  let builder = db
    .selectFrom('submission')
    .innerJoin('scenario_version', 'scenario_version.scenario_version_id', 'submission.scenario_version_id')
    .innerJoin('scenario', 'scenario.scenario_id', 'scenario_version.scenario_id')
    .selectAll('submission');
  if (!user.isSteward) builder = builder.where('scenario.department_code', '=', user.departmentCode ?? '');
  if (query.status) builder = builder.where('submission.status', '=', query.status);
  if (query.scenario_version_id) builder = builder.where('submission.scenario_version_id', '=', query.scenario_version_id);
  if (query.department_code) {
    if (!canReadDepartment(user, query.department_code)) {
      return { data: [], page_info: { has_more: false, next_cursor: null } };
    }
    builder = builder.where('scenario.department_code', '=', query.department_code);
  }

  const rows = await builder
    .orderBy('submission.submitted_at', 'desc')
    .orderBy('submission.submission_id', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return { data: rows.slice(0, limit).map(toSubmission), page_info: pageInfo(offset, limit, rows.length) };
}

export async function getSubmission(db: Kysely<Database>, user: AuthUser, submissionId: string) {
  const { submission } = await getSubmissionWithScenario(db, submissionId, user);
  return { payload: toSubmission(submission), rowVersion: submission.row_version };
}

export async function decideSubmission(
  db: Kysely<Database>,
  user: AuthUser,
  submissionId: string,
  body: DecisionRequest,
  expectedVersion: number,
  context: RequestContext
) {
  requireSteward(user);
  const { submission, version } = await getSubmissionWithScenario(db, submissionId, user);
  if (submission.status !== 'submitted') {
    throw conflict('submission_not_pending', `Submission is ${submission.status}`);
  }
  if ((body.decision === 'reject' || body.decision === 'request_changes') && !body.comment) {
    throw unprocessable('A comment is required for reject or request_changes');
  }

  const nextStatus = body.decision === 'approve'
    ? 'approved'
    : body.decision === 'reject'
      ? 'rejected'
      : 'changes_requested';
  const reviewStatus = nextStatus;

  const updated = await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('submission')
      .set({
        status: nextStatus,
        decided_by: user.subject,
        decided_at: new Date(),
        decision_comment: body.comment ?? null,
        row_version: submission.row_version + 1,
      })
      .where('submission_id', '=', submissionId)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

    await trx
      .insertInto('submission_decision')
      .values({
        decision_id: uuid(),
        submission_id: submissionId,
        decision: body.decision,
        comment: body.comment ?? null,
        actor_subject: user.subject,
        created_at: new Date(),
      })
      .execute();

    await trx
      .updateTable('scenario_version')
      .set({ review_status: reviewStatus, updated_at: new Date(), row_version: version.row_version + 1 })
      .where('scenario_version_id', '=', submission.scenario_version_id)
      .execute();

    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: `submission.${nextStatus}`,
      entityType: 'submission',
      entityId: submissionId,
      entityVersion: submission.row_version + 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      before: { status: submission.status },
      after: { status: nextStatus, decision: body.decision },
    });
    return trx.selectFrom('submission').selectAll().where('submission_id', '=', submissionId).executeTakeFirstOrThrow();
  });

  return { payload: toSubmission(updated), rowVersion: updated.row_version };
}

export async function promoteSubmission(
  db: Kysely<Database>,
  user: AuthUser,
  submissionId: string,
  body: PromotionRequest,
  expectedVersion: number,
  context: RequestContext
) {
  requireSteward(user);
  const { submission, version, scenario } = await getSubmissionWithScenario(db, submissionId, user);
  if (submission.status !== 'approved') {
    throw conflict('submission_not_approved', 'Only an approved submission can be promoted');
  }
  const plan = await getPlan(db, body.plan_id, user);
  if (plan.department_code !== scenario.department_code) {
    throw forbidden('Plan and scenario must belong to the same department');
  }

  const rules = await evaluatePromotionRules(db, {
    departmentCode: scenario.department_code,
    costCentreCode: scenario.cost_centre_code,
    scenarioType: scenario.scenario_type,
  });
  if (!rules.valid) throw unprocessable('Promotion rules rejected this submission', rules.issues);

  const result = await latestCompletedResult(db, version.scenario_version_id);
  if (!result) throw conflict('results_not_ready', 'Scenario has no completed result to promote');
  const totals = result.totals ?? {
    budget_amount: '0.00',
    actual_amount: '0.00',
    variance_amount: '0.00',
    currency_code: version.currency_code,
  };

  const promotionId = uuid();
  const planVersionId = uuid();
  const now = new Date();
  const promotion = await db.transaction().execute(async (trx) => {
    const latest = await trx
      .selectFrom('plan_version')
      .select('version_number')
      .where('plan_id', '=', plan.plan_id)
      .orderBy('version_number', 'desc')
      .limit(1)
      .executeTakeFirst();
    const nextVersion = (latest?.version_number ?? 0) + 1;

    await trx
      .updateTable('plan_version')
      .set({ status: 'superseded' })
      .where('plan_id', '=', plan.plan_id)
      .where('status', '=', 'published')
      .execute();

    await trx
      .insertInto('plan_version')
      .values({
        plan_version_id: planVersionId,
        plan_id: plan.plan_id,
        version_number: nextVersion,
        status: 'published',
        source_scenario_version_id: version.scenario_version_id,
        source_submission_id: submissionId,
        effective_from: body.effective_from,
        totals: JSON.stringify(totals),
        published_by: user.subject,
        published_at: now,
        row_version: 1,
      })
      .execute();

    await trx
      .insertInto('promotion')
      .values({
        promotion_id: promotionId,
        submission_id: submissionId,
        plan_id: plan.plan_id,
        plan_version_id: planVersionId,
        status: 'succeeded',
        requested_by: user.subject,
        requested_at: now,
        completed_at: now,
        error_code: null,
        error_message: null,
        row_version: 1,
      })
      .execute();

    const submissionUpdate = await trx
      .updateTable('submission')
      .set({ status: 'promoted', promotion_id: promotionId, row_version: submission.row_version + 1 })
      .where('submission_id', '=', submissionId)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    if (Number(submissionUpdate.numUpdatedRows) === 0) throw preconditionFailed();

    await trx
      .updateTable('scenario_version')
      .set({ review_status: 'promoted', updated_at: now, row_version: version.row_version + 1 })
      .where('scenario_version_id', '=', version.scenario_version_id)
      .execute();

    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'plan_version.published',
      entityType: 'plan_version',
      entityId: planVersionId,
      entityVersion: nextVersion,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { plan_id: plan.plan_id, submission_id: submissionId, version_number: nextVersion },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'submission.promoted',
      entityType: 'submission',
      entityId: submissionId,
      entityVersion: submission.row_version + 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { promotion_id: promotionId, plan_version_id: planVersionId },
    });

    return trx.selectFrom('promotion').selectAll().where('promotion_id', '=', promotionId).executeTakeFirstOrThrow();
  });

  return { payload: toPromotion(promotion), rowVersion: promotion.row_version };
}

export async function getPromotion(db: Kysely<Database>, user: AuthUser, promotionId: string) {
  const promotion = await db.selectFrom('promotion').selectAll().where('promotion_id', '=', promotionId).executeTakeFirst();
  if (!promotion) throw notFound('Promotion');
  const { submission } = await getSubmissionWithScenario(db, promotion.submission_id, user);
  void submission;
  return { payload: toPromotion(promotion), rowVersion: promotion.row_version };
}

export async function createPlan(
  db: Kysely<Database>,
  user: AuthUser,
  body: PlanCreateRequest,
  context: RequestContext
) {
  requireSteward(user);
  const departmentCode = body.department_code ?? user.departmentCode;
  if (!departmentCode) throw forbidden('department scope is required');
  assertDepartmentWrite(user, departmentCode);
  const code = body.code ?? slugify(body.name);
  const existing = await db
    .selectFrom('plan')
    .select('plan_id')
    .where('department_code', '=', departmentCode)
    .where('fiscal_year', '=', body.fiscal_year)
    .where('code', '=', code)
    .executeTakeFirst();
  if (existing) throw conflict('plan_code_exists', 'A plan with this code and fiscal year already exists');

  const planId = uuid();
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('plan')
      .values({
        plan_id: planId,
        code,
        name: body.name,
        department_code: departmentCode,
        fiscal_year: body.fiscal_year,
        status: 'active',
        created_by: user.subject,
        created_at: now,
        updated_at: now,
        row_version: 1,
      })
      .execute();
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'plan.created',
      entityType: 'plan',
      entityId: planId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { code, name: body.name, department_code: departmentCode, fiscal_year: body.fiscal_year },
    });
  });

  const plan = await db.selectFrom('plan').selectAll().where('plan_id', '=', planId).executeTakeFirstOrThrow();
  return { payload: toPlan(plan, null), rowVersion: plan.row_version };
}

export async function listPlans(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  let builder = db.selectFrom('plan').selectAll();
  if (!user.isSteward) builder = builder.where('department_code', '=', user.departmentCode ?? '');
  if (query.department_code) {
    if (!canReadDepartment(user, query.department_code)) {
      return { data: [], page_info: { has_more: false, next_cursor: null } };
    }
    builder = builder.where('department_code', '=', query.department_code);
  }
  if (query.fiscal_year) builder = builder.where('fiscal_year', '=', Number.parseInt(query.fiscal_year, 10));
  if (query.status) builder = builder.where('status', '=', query.status);

  const rows = await builder
    .orderBy('created_at', 'desc')
    .orderBy('plan_id', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const data = await Promise.all(
    rows.slice(0, limit).map(async (plan) => toPlan(plan, await getLatestPlanVersion(db, plan.plan_id)))
  );
  return { data, page_info: pageInfo(offset, limit, rows.length) };
}

export async function getPlanById(db: Kysely<Database>, user: AuthUser, planId: string) {
  const plan = await getPlan(db, planId, user);
  const latest = await getLatestPlanVersion(db, planId);
  return { payload: toPlan(plan, latest), rowVersion: plan.row_version };
}

export async function listPlanVersions(db: Kysely<Database>, user: AuthUser, planId: string, query: ListQuery) {
  await getPlan(db, planId, user);
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  const rows = await db
    .selectFrom('plan_version')
    .selectAll()
    .where('plan_id', '=', planId)
    .orderBy('version_number', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return { data: rows.slice(0, limit).map(toPlanVersionSummary), page_info: pageInfo(offset, limit, rows.length) };
}

export async function getPlanVersionById(db: Kysely<Database>, user: AuthUser, planVersionId: string) {
  const version = await db.selectFrom('plan_version').selectAll().where('plan_version_id', '=', planVersionId).executeTakeFirst();
  if (!version) throw notFound('Plan version');
  await getPlan(db, version.plan_id, user);
  return { payload: toPlanVersion(version), rowVersion: version.row_version };
}
