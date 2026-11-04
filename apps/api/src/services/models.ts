import type { Kysely } from 'kysely';
import type { AuthUser } from '../auth.js';
import { assertDepartmentWrite, canReadDepartment } from '../auth.js';
import type {
  ModelCreateRequest,
  ModelUpdateRequest,
  ModelVersionCreateRequest,
  ModelVersionUpdateRequest,
} from '../contracts.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../errors.js';
import { pageInfo, parseLimit, parseOffsetCursor, slugify, uuid } from '../http.js';
import type { Database } from '../schema.js';
import { toModel, toModelVersion, toModelVersionSummary } from '../serializers.js';
import { writeAudit, writeOutbox } from '../audit.js';
import {
  getModelWithLatest,
  getModelVersionWithModel,
  type RequestContext,
} from './common.js';

type ListQuery = Record<string, string | undefined>;

function sortColumn(sort: string | undefined) {
  const value = sort ?? '-updated_at';
  const descending = value.startsWith('-');
  const column = (descending ? value.slice(1) : value) as 'name' | 'created_at' | 'updated_at';
  return { column, direction: descending ? ('desc' as const) : ('asc' as const) };
}

export async function listModels(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  const { column, direction } = sortColumn(query.sort);

  let builder = db.selectFrom('model').selectAll();
  if (!user.isSteward) {
    builder = builder.where((eb) =>
      eb.or([
        eb('department_code', '=', user.departmentCode ?? ''),
        eb('visibility', '=', 'global'),
      ])
    );
  }
  if (query.department_code) {
    if (!canReadDepartment(user, query.department_code)) {
      return { data: [], page_info: { has_more: false, next_cursor: null } };
    }
    builder = builder.where('department_code', '=', query.department_code);
  }
  if (query.visibility) builder = builder.where('visibility', '=', query.visibility);
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.q) {
    const pattern = `%${query.q}%`;
    builder = builder.where((eb) => eb.or([eb('name', 'ilike', pattern), eb('code', 'ilike', pattern)]));
  }

  const rows = await builder
    .orderBy(column, direction)
    .orderBy('model_id', direction)
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const pageRows = rows.slice(0, limit);
  const data = await Promise.all(
    pageRows.map(async (row) => {
      const latest = await db
        .selectFrom('model_version')
        .selectAll()
        .where('model_id', '=', row.model_id)
        .orderBy('version_number', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      return toModel(row, latest);
    })
  );

  return { data, page_info: pageInfo(offset, limit, rows.length) };
}

export async function createModel(
  db: Kysely<Database>,
  user: AuthUser,
  body: ModelCreateRequest,
  context: RequestContext
) {
  const departmentCode = user.isSteward
    ? (body.department_code ?? user.departmentCode)
    : user.departmentCode;
  if (!departmentCode) throw forbidden('department scope is required');
  assertDepartmentWrite(user, departmentCode);

  if (body.visibility === 'global' && !(user.isSteward || user.roles.includes('data_engineer'))) {
    throw forbidden('only stewards or data engineers can create global models');
  }

  const code = body.code ?? slugify(body.name);
  const existing = await db.selectFrom('model').select('model_id').where('code', '=', code).executeTakeFirst();
  if (existing) throw conflict('model_code_exists', `Model code ${code} already exists`);

  const now = new Date();
  const modelId = uuid();
  const versionId = uuid();

  const result = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('model')
      .values({
        model_id: modelId,
        code,
        name: body.name,
        description: body.description ?? null,
        department_code: departmentCode,
        visibility: body.visibility,
        status: 'active',
        owner_subject: user.subject,
        created_by: user.subject,
        created_at: now,
        updated_at: now,
        row_version: 1,
      })
      .execute();

    await trx
      .insertInto('model_version')
      .values({
        model_version_id: versionId,
        model_id: modelId,
        version_number: 1,
        status: 'draft',
        definition: JSON.stringify(body.definition),
        validation_report: null,
        cube_refresh_status: 'not_requested',
        cube_refresh_requested_at: null,
        cube_refresh_completed_at: null,
        cube_refresh_error: null,
        created_by: user.subject,
        created_at: now,
        published_by: null,
        published_at: null,
        superseded_by_version_id: null,
        row_version: 1,
      })
      .execute();

    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'model.created',
      entityType: 'model',
      entityId: modelId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { code, name: body.name, department_code: departmentCode, visibility: body.visibility },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'model_version.created',
      entityType: 'model_version',
      entityId: versionId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { model_id: modelId, version_number: 1, status: 'draft' },
    });

    const model = await trx.selectFrom('model').selectAll().where('model_id', '=', modelId).executeTakeFirstOrThrow();
    const version = await trx
      .selectFrom('model_version')
      .selectAll()
      .where('model_version_id', '=', versionId)
      .executeTakeFirstOrThrow();
    return { model, version };
  });

  return { payload: toModel(result.model, result.version), rowVersion: result.model.row_version };
}

export async function getModel(db: Kysely<Database>, user: AuthUser, modelId: string) {
  const { model, latest } = await getModelWithLatest(db, modelId, user);
  return { payload: toModel(model, latest), rowVersion: model.row_version };
}

export async function patchModel(
  db: Kysely<Database>,
  user: AuthUser,
  modelId: string,
  body: ModelUpdateRequest,
  expectedVersion: number,
  context: RequestContext
) {
  const { model } = await getModelWithLatest(db, modelId, user);
  assertDepartmentWrite(user, model.department_code);
  if (body.visibility === 'global' && !(user.isSteward || user.roles.includes('data_engineer'))) {
    throw forbidden('only stewards or data engineers can make a model global');
  }

  const before = { name: model.name, description: model.description, visibility: model.visibility };
  const result = await db
    .updateTable('model')
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      updated_at: new Date(),
      row_version: model.row_version + 1,
    })
    .where('model_id', '=', modelId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

  const updated = await db.selectFrom('model').selectAll().where('model_id', '=', modelId).executeTakeFirstOrThrow();
  const latest = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_id', '=', modelId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();

  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'model.updated',
    entityType: 'model',
    entityId: modelId,
    entityVersion: updated.row_version,
    correlationId: context.correlationId,
    requestId: context.requestId,
    before,
    after: { name: updated.name, description: updated.description, visibility: updated.visibility },
  });

  return { payload: toModel(updated, latest), rowVersion: updated.row_version };
}

export async function archiveModel(
  db: Kysely<Database>,
  user: AuthUser,
  modelId: string,
  expectedVersion: number,
  context: RequestContext
) {
  const { model, latest } = await getModelWithLatest(db, modelId, user);
  assertDepartmentWrite(user, model.department_code);

  const updated = await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('model')
      .set({ status: 'archived', updated_at: new Date(), row_version: model.row_version + 1 })
      .where('model_id', '=', modelId)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

    const row = await trx.selectFrom('model').selectAll().where('model_id', '=', modelId).executeTakeFirstOrThrow();
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'model.archived',
      entityType: 'model',
      entityId: modelId,
      entityVersion: row.row_version,
      correlationId: context.correlationId,
      requestId: context.requestId,
      before: { status: model.status },
      after: { status: 'archived' },
    });

    // An archived model must leave the semantic layer, so ask the refresh
    // worker to regenerate the published-model snapshot.
    await writeOutbox(trx, {
      eventType: 'model_version.cube_refresh_requested',
      aggregateType: 'model_version',
      aggregateId: latest.model_version_id,
      payload: { model_id: modelId, model_version_id: latest.model_version_id, reason: 'model_archived' },
    });

    return row;
  });
  return { payload: toModel(updated, latest), rowVersion: updated.row_version };
}

export async function listModelVersions(
  db: Kysely<Database>,
  user: AuthUser,
  modelId: string,
  query: ListQuery
) {
  await getModelWithLatest(db, modelId, user);
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);

  let builder = db.selectFrom('model_version').selectAll().where('model_id', '=', modelId);
  if (query.status) builder = builder.where('status', '=', query.status);

  const rows = await builder
    .orderBy('version_number', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  const pageRows = rows.slice(0, limit);
  return { data: pageRows.map(toModelVersionSummary), page_info: pageInfo(offset, limit, rows.length) };
}

export async function createModelVersion(
  db: Kysely<Database>,
  user: AuthUser,
  modelId: string,
  body: ModelVersionCreateRequest,
  context: RequestContext
) {
  const { model } = await getModelWithLatest(db, modelId, user);
  assertDepartmentWrite(user, model.department_code);

  if (body.from_version_id) {
    const source = await db
      .selectFrom('model_version')
      .select(['model_version_id'])
      .where('model_version_id', '=', body.from_version_id)
      .where('model_id', '=', modelId)
      .executeTakeFirst();
    if (!source) throw notFound('Source model version');
  }

  const draft = await db
    .selectFrom('model_version')
    .select('model_version_id')
    .where('model_id', '=', modelId)
    .where('status', '=', 'draft')
    .executeTakeFirst();
  if (draft) throw conflict('draft_exists', 'A draft version already exists for this model');

  const latest = await db
    .selectFrom('model_version')
    .select('version_number')
    .where('model_id', '=', modelId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  const nextVersion = (latest?.version_number ?? 0) + 1;
  const versionId = uuid();
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('model_version')
      .values({
        model_version_id: versionId,
        model_id: modelId,
        version_number: nextVersion,
        status: 'draft',
        definition: JSON.stringify(body.definition),
        validation_report: null,
        cube_refresh_status: 'not_requested',
        cube_refresh_requested_at: null,
        cube_refresh_completed_at: null,
        cube_refresh_error: null,
        created_by: user.subject,
        created_at: now,
        published_by: null,
        published_at: null,
        superseded_by_version_id: null,
        row_version: 1,
      })
      .execute();
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'model_version.created',
      entityType: 'model_version',
      entityId: versionId,
      entityVersion: nextVersion,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { model_id: modelId, version_number: nextVersion, status: 'draft' },
    });
  });

  const version = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_version_id', '=', versionId)
    .executeTakeFirstOrThrow();
  return { payload: toModelVersion(version), rowVersion: version.row_version };
}

export async function getModelVersion(db: Kysely<Database>, user: AuthUser, modelVersionId: string) {
  const { version } = await getModelVersionWithModel(db, modelVersionId, user);
  return { payload: toModelVersion(version), rowVersion: version.row_version };
}

export async function updateModelVersion(
  db: Kysely<Database>,
  user: AuthUser,
  modelVersionId: string,
  body: ModelVersionUpdateRequest,
  expectedVersion: number,
  context: RequestContext
) {
  const { version, model } = await getModelVersionWithModel(db, modelVersionId, user);
  assertDepartmentWrite(user, model.department_code);
  if (version.status !== 'draft') {
    throw conflict('version_immutable', 'Only draft versions can be edited');
  }

  const result = await db
    .updateTable('model_version')
    .set({
      definition: JSON.stringify(body.definition),
      status: 'draft',
      validation_report: null,
      row_version: version.row_version + 1,
    })
    .where('model_version_id', '=', modelVersionId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

  const updated = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .executeTakeFirstOrThrow();
  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'model_version.updated',
    entityType: 'model_version',
    entityId: modelVersionId,
    entityVersion: updated.row_version,
    correlationId: context.correlationId,
    requestId: context.requestId,
    before: { status: version.status },
    after: { status: 'draft' },
  });
  return { payload: toModelVersion(updated), rowVersion: updated.row_version };
}

function validateModelDefinition(definition: Record<string, any>) {
  const issues: Array<{ severity: 'error'; path: string; code: string; message: string }> = [];
  const dimensions = Array.isArray(definition.dimensions) ? definition.dimensions : [];
  const measures = Array.isArray(definition.measures) ? definition.measures : [];
  const joins = Array.isArray(definition.joins) ? definition.joins : [];

  if (dimensions.length === 0) {
    issues.push({ severity: 'error', path: '/dimensions', code: 'dimension_required', message: 'At least one dimension is required' });
  }
  if (measures.length === 0) {
    issues.push({ severity: 'error', path: '/measures', code: 'measure_required', message: 'At least one measure is required' });
  }

  const dimensionCodes = new Set<string>();
  for (const [index, dimension] of dimensions.entries()) {
    const code = dimension?.code;
    if (typeof code === 'string') {
      if (dimensionCodes.has(code)) {
        issues.push({ severity: 'error', path: `/dimensions/${index}/code`, code: 'duplicate_dimension', message: `Duplicate dimension code ${code}` });
      }
      dimensionCodes.add(code);
    }
  }

  const measureCodes = new Set<string>();
  for (const [index, measure] of measures.entries()) {
    const code = measure?.code;
    if (typeof code === 'string') {
      if (measureCodes.has(code)) {
        issues.push({ severity: 'error', path: `/measures/${index}/code`, code: 'duplicate_measure', message: `Duplicate measure code ${code}` });
      }
      measureCodes.add(code);
    }
  }

  for (const [index, join] of joins.entries()) {
    if (!dimensionCodes.has(join?.source_member_code) || !dimensionCodes.has(join?.target_member_code)) {
      issues.push({
        severity: 'error',
        path: `/joins/${index}`,
        code: 'join_member_unknown',
        message: 'Join source/target members must exist as dimensions in this model',
      });
    }
  }

  return {
    valid: issues.length === 0,
    validated_at: new Date().toISOString(),
    issues,
  };
}

export async function validateModelVersion(
  db: Kysely<Database>,
  user: AuthUser,
  modelVersionId: string,
  context: RequestContext
) {
  const { version, model } = await getModelVersionWithModel(db, modelVersionId, user);
  assertDepartmentWrite(user, model.department_code);
  if (version.status === 'published' || version.status === 'superseded') {
    throw conflict('version_immutable', 'Published versions cannot be revalidated');
  }

  const definition = JSON.parse(version.definition) as Record<string, any>;
  const report = validateModelDefinition(definition);
  const nextStatus = report.valid ? 'validated' : 'draft';

  await db
    .updateTable('model_version')
    .set({
      status: nextStatus,
      validation_report: JSON.stringify(report),
      row_version: version.row_version + 1,
    })
    .where('model_version_id', '=', modelVersionId)
    .where('row_version', '=', version.row_version)
    .execute();

  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'model_version.validated',
    entityType: 'model_version',
    entityId: modelVersionId,
    entityVersion: version.row_version + 1,
    correlationId: context.correlationId,
    requestId: context.requestId,
    after: { valid: report.valid, issues: report.issues.length },
  });
  return report;
}

export async function publishModelVersion(
  db: Kysely<Database>,
  user: AuthUser,
  modelVersionId: string,
  expectedVersion: number,
  context: RequestContext
) {
  const { version, model } = await getModelVersionWithModel(db, modelVersionId, user);
  assertDepartmentWrite(user, model.department_code);
  if (version.status === 'published') {
    return {
      payload: { model_version: toModelVersion(version), cube_refresh: toModelVersion(version).cube_refresh },
      rowVersion: version.row_version,
      alreadyPublished: true,
    };
  }
  if (version.status !== 'validated') {
    throw unprocessable('Model version must be validated before publishing');
  }

  const now = new Date();
  const result = await db.transaction().execute(async (trx) => {
    const previous = await trx
      .selectFrom('model_version')
      .selectAll()
      .where('model_id', '=', model.model_id)
      .where('status', '=', 'published')
      .orderBy('version_number', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (previous) {
      await trx
        .updateTable('model_version')
        .set({
          status: 'superseded',
          superseded_by_version_id: modelVersionId,
          ...(previous.cube_refresh_status === 'pending' || previous.cube_refresh_status === 'running'
            ? {
                cube_refresh_status: 'failed',
                cube_refresh_error: `Superseded by version ${version.version_number} before the Cube refresh completed`,
              }
            : {}),
          row_version: previous.row_version + 1,
        })
        .where('model_version_id', '=', previous.model_version_id)
        .execute();
    }

    const update = await trx
      .updateTable('model_version')
      .set({
        status: 'published',
        published_by: user.subject,
        published_at: now,
        cube_refresh_status: 'pending',
        cube_refresh_requested_at: now,
        row_version: version.row_version + 1,
      })
      .where('model_version_id', '=', modelVersionId)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    if (Number(update.numUpdatedRows) === 0) throw preconditionFailed();

    await writeOutbox(trx, {
      eventType: 'model_version.cube_refresh_requested',
      aggregateType: 'model_version',
      aggregateId: modelVersionId,
      payload: { model_version_id: modelVersionId, model_id: model.model_id },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'model_version.published',
      entityType: 'model_version',
      entityId: modelVersionId,
      entityVersion: version.row_version + 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      before: { status: version.status },
      after: { status: 'published', cube_refresh_status: 'pending' },
    });

    return trx
      .selectFrom('model_version')
      .selectAll()
      .where('model_version_id', '=', modelVersionId)
      .executeTakeFirstOrThrow();
  });

  const payload = toModelVersion(result);
  return {
    payload: { model_version: payload, cube_refresh: payload.cube_refresh },
    rowVersion: result.row_version,
    alreadyPublished: false,
  };
}

/**
 * Queues another Cube refresh for an already published version. Publishing is
 * not the only recovery path: a failed refresh must be retryable without
 * forking a new version. A pending refresh is coalesced.
 */
export async function refreshModelVersionCube(
  db: Kysely<Database>,
  user: AuthUser,
  modelVersionId: string,
  context: RequestContext
) {
  const { version, model } = await getModelVersionWithModel(db, modelVersionId, user);
  assertDepartmentWrite(user, model.department_code);
  if (version.status !== 'published') {
    throw conflict('version_not_published', 'Only a published model version can be refreshed in Cube');
  }

  const queued = await db
    .selectFrom('outbox_event')
    .select('outbox_event_id')
    .where('event_type', '=', 'model_version.cube_refresh_requested')
    .where('aggregate_id', '=', modelVersionId)
    .where('status', 'in', ['pending', 'processing'])
    .executeTakeFirst();
  if (queued) {
    return { payload: toModelVersion(version), rowVersion: version.row_version, alreadyQueued: true };
  }

  const now = new Date();
  const updated = await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('model_version')
      .set({
        cube_refresh_status: 'pending',
        cube_refresh_requested_at: now,
        cube_refresh_error: null,
        row_version: version.row_version + 1,
      })
      .where('model_version_id', '=', modelVersionId)
      .where('row_version', '=', version.row_version)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

    await writeOutbox(trx, {
      eventType: 'model_version.cube_refresh_requested',
      aggregateType: 'model_version',
      aggregateId: modelVersionId,
      payload: {
        model_id: model.model_id,
        model_version_id: modelVersionId,
        reason: 'manual_refresh',
      },
    });
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'model_version.cube_refresh_requested',
      entityType: 'model_version',
      entityId: modelVersionId,
      entityVersion: version.row_version + 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      before: { cube_refresh_status: version.cube_refresh_status },
      after: { cube_refresh_status: 'pending' },
    });

    return trx
      .selectFrom('model_version')
      .selectAll()
      .where('model_version_id', '=', modelVersionId)
      .executeTakeFirstOrThrow();
  });

  return { payload: toModelVersion(updated), rowVersion: updated.row_version, alreadyQueued: false };
}
