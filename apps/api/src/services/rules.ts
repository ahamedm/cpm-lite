import type { Kysely } from 'kysely';
import type { AuthUser } from '../auth.js';
import { requireSteward } from '../auth.js';
import type {
  RuleCreateRequest,
  RuleScopeRequest,
  RuleUpdateRequest,
  RuleVersionCreateRequest,
  RuleVersionUpdateRequest,
} from '../contracts.js';
import { conflict, preconditionFailed, unprocessable } from '../errors.js';
import { pageInfo, parseLimit, parseOffsetCursor, safeJson, slugify, uuid } from '../http.js';
import type { Database } from '../schema.js';
import { toRule, toRuleVersion, toRuleVersionSummary } from '../serializers.js';
import { writeAudit } from '../audit.js';
import {
  getLatestRuleVersion,
  getRule,
  getRuleVersionWithScopes,
  type RequestContext,
} from './common.js';

type ListQuery = Record<string, string | undefined>;

function assertEffectiveWindow(effectiveFrom: string, effectiveTo: string | null | undefined): void {
  if (effectiveTo && effectiveTo <= effectiveFrom) {
    throw unprocessable('effective_to must be after effective_from');
  }
}

function validateScopes(scopes: RuleScopeRequest[]) {
  const issues: Array<{ severity: 'error'; path: string; code: string; message: string }> = [];
  for (const [index, scope] of scopes.entries()) {
    if (scope.scope_type === 'global' && scope.scope_id) {
      issues.push({ severity: 'error', path: `/scopes/${index}/scope_id`, code: 'global_scope_id', message: 'Global scopes must not have scope_id' });
    }
    if (scope.scope_type !== 'global' && !scope.scope_id) {
      issues.push({ severity: 'error', path: `/scopes/${index}/scope_id`, code: 'scope_id_required', message: 'Non-global scopes require scope_id' });
    }
  }
  return issues;
}

function validateDefinition(definition: Record<string, any>) {
  const issues: Array<{ severity: 'error'; path: string; code: string; message: string }> = [];
  if (!['allocation', 'validation', 'promotion'].includes(definition.kind)) {
    issues.push({ severity: 'error', path: '/definition/kind', code: 'invalid_kind', message: 'Rule kind must be allocation, validation or promotion' });
  }
  if (typeof definition.parameters !== 'object' || definition.parameters === null || Array.isArray(definition.parameters)) {
    issues.push({ severity: 'error', path: '/definition/parameters', code: 'invalid_parameters', message: 'parameters must be an object' });
  }
  const serialized = JSON.stringify(definition);
  for (const forbidden of ['"sql"', '"eval"', '"code"', 'dynamicImport']) {
    if (serialized.includes(forbidden)) {
      issues.push({ severity: 'error', path: '/definition', code: 'executable_content', message: `Rule definitions must not contain ${forbidden}` });
    }
  }
  return issues;
}

export async function listRules(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  let builder = db.selectFrom('rule').selectAll();
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.q) {
    const pattern = `%${query.q}%`;
    builder = builder.where((eb) => eb.or([eb('name', 'ilike', pattern), eb('code', 'ilike', pattern)]));
  }
  const rows = await builder.orderBy('created_at', 'desc').orderBy('rule_id', 'desc').limit(limit + 1).offset(offset).execute();
  const data = await Promise.all(rows.slice(0, limit).map(async (rule) => toRule(rule, await getLatestRuleVersion(db, rule.rule_id))));
  return { data, page_info: pageInfo(offset, limit, rows.length) };
}

export async function createRule(
  db: Kysely<Database>,
  user: AuthUser,
  body: RuleCreateRequest,
  context: RequestContext
) {
  requireSteward(user);
  const code = body.code ?? slugify(body.name);
  const existing = await db.selectFrom('rule').select('rule_id').where('code', '=', code).executeTakeFirst();
  if (existing) throw conflict('rule_code_exists', `Rule code ${code} already exists`);

  const ruleId = uuid();
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('rule')
      .values({
        rule_id: ruleId,
        code,
        name: body.name,
        description: body.description ?? null,
        owner_department_code: body.owner_department_code ?? user.departmentCode,
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
      action: 'rule.created',
      entityType: 'rule',
      entityId: ruleId,
      entityVersion: 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { code, name: body.name },
    });
  });

  const rule = await db.selectFrom('rule').selectAll().where('rule_id', '=', ruleId).executeTakeFirstOrThrow();
  return { payload: toRule(rule, null), rowVersion: rule.row_version };
}

export async function getRuleById(db: Kysely<Database>, ruleId: string) {
  const rule = await getRule(db, ruleId);
  return { payload: toRule(rule, await getLatestRuleVersion(db, ruleId)), rowVersion: rule.row_version };
}

export async function patchRule(
  db: Kysely<Database>,
  user: AuthUser,
  ruleId: string,
  body: RuleUpdateRequest,
  expectedVersion: number,
  context: RequestContext
) {
  requireSteward(user);
  const rule = await getRule(db, ruleId);
  const result = await db
    .updateTable('rule')
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      updated_at: new Date(),
      row_version: rule.row_version + 1,
    })
    .where('rule_id', '=', ruleId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();
  const updated = await db.selectFrom('rule').selectAll().where('rule_id', '=', ruleId).executeTakeFirstOrThrow();
  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'rule.updated',
    entityType: 'rule',
    entityId: ruleId,
    entityVersion: updated.row_version,
    correlationId: context.correlationId,
    requestId: context.requestId,
    before: { name: rule.name, description: rule.description },
    after: { name: updated.name, description: updated.description },
  });
  return { payload: toRule(updated, await getLatestRuleVersion(db, ruleId)), rowVersion: updated.row_version };
}

export async function listRuleVersions(db: Kysely<Database>, ruleId: string, query: ListQuery) {
  await getRule(db, ruleId);
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  const rows = await db
    .selectFrom('rule_version')
    .selectAll()
    .where('rule_id', '=', ruleId)
    .orderBy('version_number', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return { data: rows.slice(0, limit).map(toRuleVersionSummary), page_info: pageInfo(offset, limit, rows.length) };
}

export async function createRuleVersion(
  db: Kysely<Database>,
  user: AuthUser,
  ruleId: string,
  body: RuleVersionCreateRequest,
  context: RequestContext
) {
  requireSteward(user);
  await getRule(db, ruleId);
  const scopeIssues = validateScopes(body.scopes);
  const definitionIssues = validateDefinition(body.definition);
  if (scopeIssues.length || definitionIssues.length) {
    throw unprocessable('Rule version validation failed', [...scopeIssues, ...definitionIssues]);
  }
  assertEffectiveWindow(body.effective_from, body.effective_to ?? null);

  const draft = await db
    .selectFrom('rule_version')
    .select('rule_version_id')
    .where('rule_id', '=', ruleId)
    .where('status', '=', 'draft')
    .executeTakeFirst();
  if (draft) throw conflict('rule_draft_exists', 'A draft rule version already exists');

  const latest = await db
    .selectFrom('rule_version')
    .select('version_number')
    .where('rule_id', '=', ruleId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  const nextVersion = (latest?.version_number ?? 0) + 1;
  const ruleVersionId = uuid();
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('rule_version')
      .values({
        rule_version_id: ruleVersionId,
        rule_id: ruleId,
        version_number: nextVersion,
        status: 'draft',
        evaluation_point: body.evaluation_point,
        priority: body.priority,
        effective_from: body.effective_from,
        effective_to: body.effective_to ?? null,
        definition: JSON.stringify(body.definition),
        validation_report: null,
        created_by: user.subject,
        created_at: now,
        published_by: null,
        published_at: null,
        retired_at: null,
        row_version: 1,
      })
      .execute();
    for (const scope of body.scopes) {
      await trx
        .insertInto('rule_scope')
        .values({
          rule_scope_id: uuid(),
          rule_version_id: ruleVersionId,
          scope_type: scope.scope_type,
          scope_id: scope.scope_type === 'global' ? null : scope.scope_id ?? null,
        })
        .execute();
    }
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'rule_version.created',
      entityType: 'rule_version',
      entityId: ruleVersionId,
      entityVersion: nextVersion,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { rule_id: ruleId, version_number: nextVersion, status: 'draft' },
    });
  });

  return getRuleVersionById(db, ruleVersionId);
}

export async function getRuleVersionById(db: Kysely<Database>, ruleVersionId: string) {
  const { version, scopes } = await getRuleVersionWithScopes(db, ruleVersionId);
  return { payload: toRuleVersion(version, scopes), rowVersion: version.row_version };
}

export async function updateRuleVersion(
  db: Kysely<Database>,
  user: AuthUser,
  ruleVersionId: string,
  body: RuleVersionUpdateRequest,
  expectedVersion: number,
  context: RequestContext
) {
  requireSteward(user);
  const { version } = await getRuleVersionWithScopes(db, ruleVersionId);
  if (version.status !== 'draft') throw conflict('rule_version_immutable', 'Only draft rule versions can be edited');
  if (body.scopes) {
    const issues = validateScopes(body.scopes);
    if (issues.length) throw unprocessable('Rule scope validation failed', issues);
  }
  if (body.definition) {
    const issues = validateDefinition(body.definition);
    if (issues.length) throw unprocessable('Rule definition validation failed', issues);
  }
  const nextFrom = body.effective_from ?? version.effective_from;
  const nextTo = body.effective_to !== undefined ? body.effective_to : version.effective_to;
  assertEffectiveWindow(nextFrom, nextTo);

  await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('rule_version')
      .set({
        ...(body.evaluation_point ? { evaluation_point: body.evaluation_point } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.effective_from ? { effective_from: body.effective_from } : {}),
        ...(body.effective_to !== undefined ? { effective_to: body.effective_to } : {}),
        ...(body.definition ? { definition: JSON.stringify(body.definition) } : {}),
        validation_report: null,
        row_version: version.row_version + 1,
      })
      .where('rule_version_id', '=', ruleVersionId)
      .where('row_version', '=', expectedVersion)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

    if (body.scopes) {
      await trx.deleteFrom('rule_scope').where('rule_version_id', '=', ruleVersionId).execute();
      for (const scope of body.scopes) {
        await trx
          .insertInto('rule_scope')
          .values({
            rule_scope_id: uuid(),
            rule_version_id: ruleVersionId,
            scope_type: scope.scope_type,
            scope_id: scope.scope_type === 'global' ? null : scope.scope_id ?? null,
          })
          .execute();
      }
    }
    await writeAudit(trx, {
      actorSubject: user.subject,
      actorDepartmentCode: user.departmentCode,
      action: 'rule_version.updated',
      entityType: 'rule_version',
      entityId: ruleVersionId,
      entityVersion: version.row_version + 1,
      correlationId: context.correlationId,
      requestId: context.requestId,
      after: { status: 'draft' },
    });
  });
  return getRuleVersionById(db, ruleVersionId);
}

export async function validateRuleVersion(
  db: Kysely<Database>,
  user: AuthUser,
  ruleVersionId: string,
  context: RequestContext
) {
  requireSteward(user);
  const { version, scopes } = await getRuleVersionWithScopes(db, ruleVersionId);
  if (version.status !== 'draft') throw conflict('rule_version_immutable', 'Only draft rule versions can be validated');

  const issues = [
    ...validateScopes(scopes.map((scope) => ({ scope_type: scope.scope_type as RuleScopeRequest['scope_type'], scope_id: scope.scope_id }))),
    ...validateDefinition(safeJson(version.definition, {})),
  ];
  assertEffectiveWindow(version.effective_from, version.effective_to);
  if (new Date(`${version.effective_from}T00:00:00Z`) > new Date()) {
    issues.push({ severity: 'error', path: '/effective_from', code: 'future_effective_from', message: 'Effective date cannot be in the future' });
  }
  const report = { valid: issues.length === 0, validated_at: new Date().toISOString(), issues };

  await db
    .updateTable('rule_version')
    .set({ validation_report: JSON.stringify(report), row_version: version.row_version + 1 })
    .where('rule_version_id', '=', ruleVersionId)
    .where('row_version', '=', version.row_version)
    .execute();
  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'rule_version.validated',
    entityType: 'rule_version',
    entityId: ruleVersionId,
    entityVersion: version.row_version + 1,
    correlationId: context.correlationId,
    requestId: context.requestId,
    after: { valid: report.valid, issues: report.issues.length },
  });
  return report;
}

export async function publishRuleVersion(
  db: Kysely<Database>,
  user: AuthUser,
  ruleVersionId: string,
  expectedVersion: number,
  context: RequestContext
) {
  requireSteward(user);
  const { version } = await getRuleVersionWithScopes(db, ruleVersionId);
  if (version.status !== 'draft') throw conflict('rule_version_immutable', 'Only draft rule versions can be published');
  const report = safeJson<{ valid?: boolean }>(version.validation_report, {});
  if (!report.valid) throw unprocessable('Rule version must be validated before publishing');

  const result = await db
    .updateTable('rule_version')
    .set({
      status: 'active',
      published_by: user.subject,
      published_at: new Date(),
      row_version: version.row_version + 1,
    })
    .where('rule_version_id', '=', ruleVersionId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'rule_version.published',
    entityType: 'rule_version',
    entityId: ruleVersionId,
    entityVersion: version.row_version + 1,
    correlationId: context.correlationId,
    requestId: context.requestId,
    after: { status: 'active' },
  });
  return getRuleVersionById(db, ruleVersionId);
}

export async function retireRuleVersion(
  db: Kysely<Database>,
  user: AuthUser,
  ruleVersionId: string,
  expectedVersion: number,
  context: RequestContext
) {
  requireSteward(user);
  const { version } = await getRuleVersionWithScopes(db, ruleVersionId);
  if (version.status !== 'active') throw conflict('rule_version_not_active', 'Only active rule versions can be retired');

  const result = await db
    .updateTable('rule_version')
    .set({ status: 'retired', retired_at: new Date(), row_version: version.row_version + 1 })
    .where('rule_version_id', '=', ruleVersionId)
    .where('row_version', '=', expectedVersion)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw preconditionFailed();

  await writeAudit(db, {
    actorSubject: user.subject,
    actorDepartmentCode: user.departmentCode,
    action: 'rule_version.retired',
    entityType: 'rule_version',
    entityId: ruleVersionId,
    entityVersion: version.row_version + 1,
    correlationId: context.correlationId,
    requestId: context.requestId,
    after: { status: 'retired' },
  });
  return getRuleVersionById(db, ruleVersionId);
}
