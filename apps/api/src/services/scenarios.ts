import type { Kysely } from 'kysely';
import type { AuthUser } from '../auth.js';
import { assertCostCentre, assertDepartmentWrite, canReadDepartment } from '../auth.js';
import type {
  ScenarioCreateRequest,
  ScenarioUpdateRequest,
  ScenarioVersionCreateRequest,
  ScenarioVersionUpdateRequest,
} from '../contracts.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable, ApiError } from '../errors.js';
import { pageInfo, parseLimit, parseOffsetCursor, safeJson, slugify, uuid } from '../http.js';
import type { Database } from '../schema.js';
import { toJobSummary, toScenario, toScenarioVersion, toScenarioVersionSummary } from '../serializers.js';
import { writeAudit } from '../audit.js';
import { evaluateValidationRules } from '../rules-engine.js';
import {
  calculationPlanReport,
  failedCalculationPlanReport,
  prepareCalculationPlan,
  prepareCalculationSource,
  type CalculationPlanValidationReport,
  type PreparedCalculationPlan,
  type PreparedCalculationSource,
} from './calculation-plan.js';
import {
  getScenarioVersionWithScenario,
  getScenarioWithLatest,
  canReadModel,
  type RequestContext,
  type ScenarioRow,
  type ScenarioVersionRow,
} from './common.js';

type ListQuery = Record<string, string | undefined>;

function assertPeriod(periodStart: string, periodEnd: string): void {
  if (periodStart > periodEnd) {
    throw unprocessable('period_start must be on or before period_end');
  }
}

interface AlgorithmColumns {
  calculation_plan: string | null;
  calculation_plan_hash: string | null;
  calculation_compiler_version: string | null;
  calculation_source: string | null;
  calculation_source_hash: string | null;
  calculation_authoring_version: string | null;
}

function emptyAlgorithmColumns(): AlgorithmColumns {
  return {
    calculation_plan: null,
    calculation_plan_hash: null,
    calculation_compiler_version: null,
    calculation_source: null,
    calculation_source_hash: null,
    calculation_authoring_version: null,
  };
}

function algorithmFromPlan(
  prepared: PreparedCalculationPlan | null
): AlgorithmColumns {
  if (!prepared) return emptyAlgorithmColumns();
  return {
    calculation_plan: JSON.stringify(prepared.plan),
    calculation_plan_hash: prepared.plan_hash,
    calculation_compiler_version: prepared.compiler_version,
    calculation_source: null,
    calculation_source_hash: null,
    calculation_authoring_version: null,
  };
}

function algorithmFromSource(
  prepared: PreparedCalculationSource | null
): AlgorithmColumns {
  if (!prepared) return emptyAlgorithmColumns();
  return {
    calculation_plan: JSON.stringify(prepared.plan),
    calculation_plan_hash: prepared.plan_hash,
    calculation_compiler_version: prepared.compiler_version,
    calculation_source: JSON.stringify(prepared.source),
    calculation_source_hash: prepared.source_hash,
    calculation_authoring_version: prepared.authoring_version,
  };
}

function assertSingleAlgorithmInput(body: {
  calculation_plan?: unknown;
  calculation_source?: unknown;
}): void {
  if (body.calculation_plan !== undefined && body.calculation_source !== undefined) {
    throw unprocessable('Provide either calculation_plan or calculation_source, not both');
  }
}

function sortColumn(sort: string | undefined) {
  const value = sort ?? '-updated_at';
  const descending = value.startsWith('-');
  const column = (descending ? value.slice(1) : value) as 'name' | 'created_at' | 'updated_at';
  return { column, direction: descending ? ('desc' as const) : ('asc' as const) };
}

async function assertPublishedModelVersion(
  db: Kysely<Database>,
  modelVersionId: string,
  user: AuthUser
): Promise<void> {
  const version = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .executeTakeFirst();
  if (!version || version.status !== 'published') throw notFound('Published model version');

  const model = await db.selectFrom('model').selectAll().where('model_id', '=', version.model_id).executeTakeFirst();
  if (!model || !canReadModel(user, model)) throw notFound('Published model version');
}

async function resolveBase(
  db: Kysely<Database>,
  base: ScenarioCreateRequest['base'],
  user: AuthUser
): Promise<{
  base_type: string;
  base_plan_version_id: string | null;
  base_scenario_version_id: string | null;
  actuals_as_of: string | null;
}> {
  if (base.base_type === 'plan') {
    const planVersion = await db
      .selectFrom('plan_version')
      .selectAll()
      .where('plan_version_id', '=', base.plan_version_id)
      .executeTakeFirst();
    if (!planVersion) throw notFound('Plan version');
    const plan = await db.selectFrom('plan').selectAll().where('plan_id', '=', planVersion.plan_id).executeTakeFirst();
    if (!plan || !canReadDepartment(user, plan.department_code)) throw notFound('Plan version');
    return {
      base_type: 'plan',
      base_plan_version_id: base.plan_version_id,
      base_scenario_version_id: null,
      actuals_as_of: null,
    };
  }
  if (base.base_type === 'scenario') {
    const source = await db
      .selectFrom('scenario_version')
      .selectAll()
      .where('scenario_version_id', '=', base.scenario_version_id)
      .executeTakeFirst();
    if (!source) throw notFound('Scenario version');
    const scenario = await db.selectFrom('scenario').selectAll().where('scenario_id', '=', source.scenario_id).executeTakeFirst();
    if (!scenario || !canReadDepartment(user, scenario.department_code)) throw notFound('Scenario version');
    return {
      base_type: 'scenario',
      base_plan_version_id: null,
      base_scenario_version_id: base.scenario_version_id,
      actuals_as_of: null,
    };
  }
  return {
    base_type: 'actuals',
    base_plan_version_id: null,
    base_scenario_version_id: null,
    actuals_as_of: base.actuals_as_of ?? null,
  };
}

async function latestJobForVersion(db: Kysely<Database>, scenarioVersionId: string) {
  return (await db
    .selectFrom('job')
    .selectAll()
    .where('scenario_version_id', '=', scenarioVersionId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()) ?? null;
}

function completedResult(job: Awaited<ReturnType<typeof latestJobForVersion>>) {
  if (!job || job.status !== 'completed' || !job.result) return null;
  return safeJson<Record<string, unknown> | null>(job.result, null);
}

export async function listScenarios(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  const { column, direction } = sortColumn(query.sort);

  let builder = db.selectFrom('scenario').selectAll();
  if (!user.isSteward) builder = builder.where('department_code', '=', user.departmentCode ?? '');
  if (query.department_code) {
    if (!canReadDepartment(user, query.department_code)) {
      return { data: [], page_info: { has_more: false, next_cursor: null } };
    }
    builder = builder.where('department_code', '=', query.department_code);
  }
  if (query.scenario_type) builder = builder.where('scenario_type', '=', query.scenario_type);
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.q) {
    const pattern = `%${query.q}%`;
    builder = builder.where((eb) => eb.or([eb('name', 'ilike', pattern), eb('code', 'ilike', pattern)]));
  }

  const rows = await builder
    .orderBy(column, direction)
    .orderBy('scenario_id', direction)
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const data = await Promise.all(
    rows.slice(0, limit).map(async (row) => {
      const latest = await db
        .selectFrom('scenario_version')
        .selectAll()
        .where('scenario_id', '=', row.scenario_id)
        .orderBy('version_number', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      return toScenario(row, latest);
    })
  );

  return { data, page_info: pageInfo(offset, limit, rows.length) };
}

export async function createScenario(
  db: Kysely<Database>,
  user: AuthUser,
  body: ScenarioCreateRequest,
  context: RequestContext
) {
  const departmentCode = user.isSteward ? (body.department_code ?? user.departmentCode) : user.departmentCode;
  if (!departmentCode) throw forbidden('department scope is required');
  assertDepartmentWrite(user, departmentCode);
  assertCostCentre(user, body.cost_centre_code ?? null);
  assertPeriod(body.period_start, body.period_end);
  await assertPublishedModelVersion(db, body.model_version_id, user);
  const base = await resolveBase(db, body.base, user);
  assertSingleAlgorithmInput(body);
  const algorithm =
    body.calculation_source !== undefined
      ? algorithmFromSource(prepareCalculationSource(body.calculation_source, body.model_version_id))
      : algorithmFromPlan(prepareCalculationPlan(body.calculation_plan, body.model_version_id));

  const code = body.code ?? slugify(body.name);
  const existing = await db
    .selectFrom('scenario')
    .select('scenario_id')
    .where('department_code', '=', departmentCode)
    .where('code', '=', code)
    .executeTakeFirst();
  if (existing) throw conflict('scenario_code_exists', `Scenario code ${code} already exists in this department`);

  const scenarioId = uuid();
  const versionId = uuid();
  const now = new Date();
  const result = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('scenario')
      .values({
        scenario_id: scenarioId,
        code,
        name: body.name,
        description: body.description ?? null,
        scenario_type: body.scenario_type,
        department_code: departmentCode,
        cost_centre_code: body.cost_centre_code ?? null,
        status: 'active',
        owner_subject: user.subject,
        created_by: user.subject,
        created_at: now,
        updated_at: now,
        row_version: 1,
      })
      .execute();

    await trx
      .insertInto('scenario_version')
      .values({
        scenario_version_id: versionId,
        scenario_id: scenarioId,
        version_number: 1,
        model_version_id: body.model_version_id,
        status: 'draft',
        review_status: 'not_submitted',
        base_type: base.base_type,
        base_plan_version_id: base.base_plan_version_id,
        base_scenario_version_id: base.base_scenario_version_id,
        actuals_as_of: base.actuals_as_of,
        period_start: body.period_start,
        period_end: body.period_end,
        currency_code: body.currency_code ?? 'USD',
        drivers: JSON.stringify(body.drivers ?? []),
        adjustments: JSON.stringify(body.adjustments ?? []),
        assumptions: JSON.stringify(body.assumptions ?? []),
        ...algorithm,
        validation_report: null,
        created_by: user.subject,
        created_at: now,
        updated_at: now,
        completed_at: null,
        row_version: 1,
      })
      .execute();

    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'scenario.created',
      entityType: 'scenario',
      entityId: scenarioId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { code, name: body.name, department_code: departmentCode, scenario_type: body.scenario_type },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'scenario_version.created',
      entityType: 'scenario_version',
      entityId: versionId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { scenario_id: scenarioId, version_number: 1, status: 'draft' },
    });

    const scenario = await trx.selectFrom('scenario').selectAll().where('scenario_id', '=', scenarioId).executeTakeFirstOrThrow();
    const version = await trx
      .selectFrom('scenario_version')
      .selectAll()
      .where('scenario_version_id', '=', versionId)
      .executeTakeFirstOrThrow();
    return { scenario, version };
  });

  return { payload: toScenario(result.scenario, result.version), rowVersion: result.scenario.row_version };
}

export async function getScenario(db: Kysely<Database>, user: AuthUser, scenarioId: string) {
  const { scenario, latest } = await getScenarioWithLatest(db, scenarioId, user);
  const job = await latestJobForVersion(db, latest.scenario_version_id);
  return {
    payload: toScenario(scenario, latest),
    rowVersion: scenario.row_version,
    version: toScenarioVersion(latest, {
      latestJob: job ? toJobSummary(job) : null,
      result: completedResult(job),
    }),
  };
}

export async function patchScenario(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioId: string,
  body: ScenarioUpdateRequest,
  expectedVersion: number,
  context: RequestContext
) {
  const { scenario } = await getScenarioWithLatest(db, scenarioId, user);
  assertDepartmentWrite(user, scenario.department_code);
  assertCostCentre(user, body.cost_centre_code ?? scenario.cost_centre_code);

  const result = await db
    .updateTable('scenario')
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.cost_centre_code !== undefined ? { cost_centre_code: body.cost_centre_code } : {}),
      updated_at: new Date(),
      row_version: scenario.row_version + 1,
    })
    .where('scenario_id', '=', scenarioId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

  const updated = await db.selectFrom('scenario').selectAll().where('scenario_id', '=', scenarioId).executeTakeFirstOrThrow();
  const latest = await db
    .selectFrom('scenario_version')
    .selectAll()
    .where('scenario_id', '=', scenarioId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'scenario.updated',
    entityType: 'scenario',
    entityId: scenarioId,
    entityVersion: updated.row_version,
    correlationId: context.correlationId,
    requestId: context.requestId,
    before: { name: scenario.name, description: scenario.description, cost_centre_code: scenario.cost_centre_code },
    after: { name: updated.name, description: updated.description, cost_centre_code: updated.cost_centre_code },
  });
  return { payload: toScenario(updated, latest), rowVersion: updated.row_version };
}

export async function archiveScenario(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioId: string,
  expectedVersion: number,
  context: RequestContext
) {
  const { scenario, latest } = await getScenarioWithLatest(db, scenarioId, user);
  assertDepartmentWrite(user, scenario.department_code);
  const result = await db
    .updateTable('scenario')
    .set({ status: 'archived', updated_at: new Date(), row_version: scenario.row_version + 1 })
    .where('scenario_id', '=', scenarioId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

  const updated = await db.selectFrom('scenario').selectAll().where('scenario_id', '=', scenarioId).executeTakeFirstOrThrow();
  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'scenario.archived',
    entityType: 'scenario',
    entityId: scenarioId,
    entityVersion: updated.row_version,
    correlationId: context.correlationId,
    requestId: context.requestId,
    before: { status: scenario.status },
    after: { status: 'archived' },
  });
  return { payload: toScenario(updated, latest), rowVersion: updated.row_version };
}

export async function listScenarioVersions(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioId: string,
  query: ListQuery
) {
  await getScenarioWithLatest(db, scenarioId, user);
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  let builder = db.selectFrom('scenario_version').selectAll().where('scenario_id', '=', scenarioId);
  if (query.status) builder = builder.where('status', '=', query.status);

  const rows = await builder
    .orderBy('version_number', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return { data: rows.slice(0, limit).map(toScenarioVersionSummary), page_info: pageInfo(offset, limit, rows.length) };
}

export async function createScenarioVersion(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioId: string,
  body: ScenarioVersionCreateRequest,
  context: RequestContext
) {
  const { scenario } = await getScenarioWithLatest(db, scenarioId, user);
  assertDepartmentWrite(user, scenario.department_code);
  assertPeriod(body.period_start, body.period_end);
  await assertPublishedModelVersion(db, body.model_version_id, user);
  const base = await resolveBase(db, body.base, user);
  assertSingleAlgorithmInput(body);
  const algorithm =
    body.calculation_source !== undefined
      ? algorithmFromSource(prepareCalculationSource(body.calculation_source, body.model_version_id))
      : algorithmFromPlan(prepareCalculationPlan(body.calculation_plan, body.model_version_id));

  if (body.from_version_id) {
    const source = await db
      .selectFrom('scenario_version')
      .select('scenario_version_id')
      .where('scenario_version_id', '=', body.from_version_id)
      .where('scenario_id', '=', scenarioId)
      .executeTakeFirst();
    if (!source) throw notFound('Source scenario version');
  }

  const draft = await db
    .selectFrom('scenario_version')
    .select('scenario_version_id')
    .where('scenario_id', '=', scenarioId)
    .where('status', '=', 'draft')
    .executeTakeFirst();
  if (draft) throw conflict('draft_exists', 'A draft version already exists for this scenario');

  const latest = await db
    .selectFrom('scenario_version')
    .select('version_number')
    .where('scenario_id', '=', scenarioId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  const nextVersion = (latest?.version_number ?? 0) + 1;
  const versionId = uuid();
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('scenario_version')
      .values({
        scenario_version_id: versionId,
        scenario_id: scenarioId,
        version_number: nextVersion,
        model_version_id: body.model_version_id,
        status: 'draft',
        review_status: 'not_submitted',
        base_type: base.base_type,
        base_plan_version_id: base.base_plan_version_id,
        base_scenario_version_id: base.base_scenario_version_id,
        actuals_as_of: base.actuals_as_of,
        period_start: body.period_start,
        period_end: body.period_end,
        currency_code: body.currency_code ?? 'USD',
        drivers: JSON.stringify(body.drivers ?? []),
        adjustments: JSON.stringify(body.adjustments ?? []),
        assumptions: JSON.stringify(body.assumptions ?? []),
        ...algorithm,
        validation_report: null,
        created_by: user.subject,
        created_at: now,
        updated_at: now,
        completed_at: null,
        row_version: 1,
      })
      .execute();
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'scenario_version.created',
      entityType: 'scenario_version',
      entityId: versionId,
      entityVersion: nextVersion,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { scenario_id: scenarioId, version_number: nextVersion, status: 'draft' },
    });
  });

  const version = await db
    .selectFrom('scenario_version')
    .selectAll()
    .where('scenario_version_id', '=', versionId)
    .executeTakeFirstOrThrow();
  return { payload: toScenarioVersion(version), rowVersion: version.row_version };
}

export async function getScenarioVersion(db: Kysely<Database>, user: AuthUser, scenarioVersionId: string) {
  const { version } = await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  const job = await latestJobForVersion(db, scenarioVersionId);
  return {
    payload: toScenarioVersion(version, {
      latestJob: job ? toJobSummary(job) : null,
      result: completedResult(job),
    }),
    rowVersion: version.row_version,
  };
}

export async function updateScenarioVersion(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioVersionId: string,
  body: ScenarioVersionUpdateRequest,
  expectedVersion: number,
  context: RequestContext
) {
  const { version, scenario } = await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  assertDepartmentWrite(user, scenario.department_code);
  if (version.status !== 'draft') throw conflict('version_immutable', 'Only draft versions can be edited');

  const nextStart = body.period_start ?? version.period_start;
  const nextEnd = body.period_end ?? version.period_end;
  assertPeriod(nextStart, nextEnd);

  if (body.model_version_id) await assertPublishedModelVersion(db, body.model_version_id, user);
  const base = body.base ? await resolveBase(db, body.base, user) : null;

  const nextModelVersionId = body.model_version_id ?? version.model_version_id;
  const modelVersionChanged = nextModelVersionId !== version.model_version_id;
  assertSingleAlgorithmInput(body);

  const existingSource = safeJson<Record<string, unknown> | null>(version.calculation_source, null);
  const existingPlan = safeJson<Record<string, unknown> | null>(version.calculation_plan, null);
  let algorithm: AlgorithmColumns | undefined;
  if (body.calculation_source !== undefined) {
    algorithm = algorithmFromSource(prepareCalculationSource(body.calculation_source, nextModelVersionId));
  } else if (body.calculation_plan !== undefined) {
    algorithm = algorithmFromPlan(prepareCalculationPlan(body.calculation_plan, nextModelVersionId));
  } else if (modelVersionChanged && existingSource) {
    // The stored source is pinned to the previous model version; recompile it
    // against the new one so a model change cannot silently reinterpret it.
    algorithm = algorithmFromSource(prepareCalculationSource(existingSource, nextModelVersionId));
  } else if (modelVersionChanged && existingPlan) {
    // The stored plan is pinned to the previous model version; revalidate it
    // against the new one so a model change cannot silently reinterpret it.
    algorithm = algorithmFromPlan(prepareCalculationPlan(existingPlan, nextModelVersionId));
  }

  const result = await db
    .updateTable('scenario_version')
    .set({
      ...(body.model_version_id ? { model_version_id: body.model_version_id } : {}),
      ...(base
        ? {
            base_type: base.base_type,
            base_plan_version_id: base.base_plan_version_id,
            base_scenario_version_id: base.base_scenario_version_id,
            actuals_as_of: base.actuals_as_of,
          }
        : {}),
      ...(body.period_start ? { period_start: body.period_start } : {}),
      ...(body.period_end ? { period_end: body.period_end } : {}),
      ...(body.currency_code ? { currency_code: body.currency_code } : {}),
      ...(body.drivers ? { drivers: JSON.stringify(body.drivers) } : {}),
      ...(body.adjustments ? { adjustments: JSON.stringify(body.adjustments) } : {}),
      ...(body.assumptions ? { assumptions: JSON.stringify(body.assumptions) } : {}),
      ...(algorithm !== undefined ? algorithm : {}),
      status: 'draft',
      validation_report: null,
      updated_at: new Date(),
      row_version: version.row_version + 1,
    })
    .where('scenario_version_id', '=', scenarioVersionId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

  const updated = await db
    .selectFrom('scenario_version')
    .selectAll()
    .where('scenario_version_id', '=', scenarioVersionId)
    .executeTakeFirstOrThrow();
  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'scenario_version.updated',
    entityType: 'scenario_version',
    entityId: scenarioVersionId,
    entityVersion: updated.row_version,
    correlationId: context.correlationId,
    requestId: context.requestId,
    after: { status: 'draft', calculation_plan_hash: updated.calculation_plan_hash },
  });
  return { payload: toScenarioVersion(updated), rowVersion: updated.row_version };
}

export async function compileScenarioCalculationSource(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioVersionId: string,
  body: { calculation_source: unknown }
) {
  const { version, scenario } = await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  assertDepartmentWrite(user, scenario.department_code);
  if (version.status !== 'draft') {
    throw conflict('version_immutable', 'Only draft versions can be edited');
  }
  const prepared = prepareCalculationSource(body.calculation_source, version.model_version_id);
  if (!prepared) throw unprocessable('calculation_source is required');
  return {
    calculation_plan: prepared.plan,
    calculation_plan_hash: prepared.plan_hash,
    calculation_compiler_version: prepared.compiler_version,
    calculation_source: prepared.source,
    calculation_source_hash: prepared.source_hash,
    calculation_authoring_version: prepared.authoring_version,
  };
}

export async function validateScenarioVersion(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioVersionId: string,
  context: RequestContext
) {
  const { version, scenario } = await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  assertDepartmentWrite(user, scenario.department_code);
  if (version.status !== 'draft' && version.status !== 'validated') {
    throw conflict('version_immutable', 'Only draft or validated versions can be validated');
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
    calculation_plan: null as CalculationPlanValidationReport | null,
  };

  const rawPlan = safeJson<Record<string, unknown> | null>(version.calculation_plan, null);
  let preparedPlan: PreparedCalculationPlan | null = null;
  if (rawPlan) {
    try {
      const prepared = prepareCalculationPlan(rawPlan, version.model_version_id);
      if (!prepared) throw new Error('Calculation plan unexpectedly empty');
      preparedPlan = prepared;
      report.calculation_plan = calculationPlanReport(prepared);
    } catch (error) {
      if (error instanceof ApiError) {
        report.valid = false;
        report.issues.push(...(error.issues ?? []));
        report.calculation_plan = failedCalculationPlanReport();
      } else {
        throw error;
      }
    }
  }

  await db
    .updateTable('scenario_version')
    .set({
      status: report.valid ? 'validated' : 'draft',
      validation_report: JSON.stringify(report),
      calculation_plan_hash: preparedPlan?.plan_hash ?? version.calculation_plan_hash,
      calculation_compiler_version:
        preparedPlan?.compiler_version ?? version.calculation_compiler_version,
      updated_at: new Date(),
      row_version: version.row_version + 1,
    })
    .where('scenario_version_id', '=', scenarioVersionId)
    .where('row_version', '=', version.row_version)
    .execute();

  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'scenario_version.validated',
    entityType: 'scenario_version',
    entityId: scenarioVersionId,
    entityVersion: version.row_version + 1,
    correlationId: context.correlationId,
    requestId: context.requestId,
    after: {
      valid: report.valid,
      issues: report.issues.length,
      rules: evaluation.resolved_rules.length,
      calculation_plan_hash: preparedPlan?.plan_hash ?? version.calculation_plan_hash,
    },
  });

  return { model_version_id: version.model_version_id, report };
}

export async function getScenarioVersionResults(
  db: Kysely<Database>,
  user: AuthUser,
  scenarioVersionId: string
) {
  const { version } = await getScenarioVersionWithScenario(db, scenarioVersionId, user);
  const job = await latestJobForVersion(db, scenarioVersionId);
  const result = completedResult(job);
  if (!result || version.status !== 'completed') {
    throw conflict('results_not_ready', 'No completed result is available for this scenario version');
  }
  return result;
}
