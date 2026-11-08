import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCube } from '../src/cube/schema.js';
import { createDatabase } from '../src/db.js';
import { applyMigrations, applySeeds } from '../src/migrate.js';
import { semanticModelHash, stableStringify } from '../src/semantic/canonical.js';
import { semanticModelFromDefinition } from '../src/semantic/from-definition.js';
import { toOssieDocument } from '../src/semantic/ossie.js';
import {
  backfillSemanticModels,
  loadSemanticModel,
  writeSemanticModel,
} from '../src/semantic/repository.js';
import { validateSemanticModel } from '../src/semantic/validate.js';

const DEFINITION = {
  schema_version: '1.0',
  source: { source_id: 'gold.fact_financials' },
  access: { row_level_field: 'department_code' },
  dimensions: [
    { code: 'transaction_date', name: 'Transaction date', data_type: 'date', expression: 'transaction_date' },
    { code: 'department_code', name: 'Department', data_type: 'string', expression: 'department_code' },
    { code: 'category_code', name: 'Category', data_type: 'string', expression: 'category_code' },
  ],
  measures: [
    { code: 'budget_amount', name: 'Budget', aggregation: 'sum', expression: 'budget_amount', format: 'currency', currency_code: 'USD' },
    { code: 'actual_amount', name: 'Actual', aggregation: 'sum', expression: 'actual_amount', format: 'currency', currency_code: 'USD' },
    { code: 'transaction_count', name: 'Transactions', aggregation: 'count', format: 'number' },
  ],
};

const SOURCE = {
  source_id: 'gold.fact_financials',
  columns: [
    'financial_id',
    'transaction_id',
    'transaction_date',
    'department_code',
    'category_code',
    'region_code',
    'payment_method',
    'budget_amount',
    'actual_amount',
    'variance_amount',
    'currency_code',
  ],
};

const MODEL = {
  model_id: 'model-neutral-1',
  code: 'fy2026_department_budget',
  name: 'FY2026 Department Budget',
  description: 'Published budget model',
  department_code: 'finance',
  status: 'active',
};

const VERSION_ID = 'version-neutral-1';

function identity(overrides: Record<string, unknown> = {}) {
  return {
    code: MODEL.code,
    name: MODEL.name,
    description: MODEL.description,
    departmentCode: MODEL.department_code,
    ...overrides,
  };
}

async function tempDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-semantic-test-'));
  const dbPath = path.join(dir, 'oltp.duckdb');
  await applyMigrations(dbPath);
  await applySeeds(dbPath);
  const handle = await createDatabase(dbPath);
  return { dir, handle };
}

async function insertModelVersion(
  handle: Awaited<ReturnType<typeof createDatabase>>,
  definition: string
) {
  const now = new Date();
  await handle.db
    .insertInto('model')
    .values({
      model_id: MODEL.model_id,
      code: MODEL.code,
      name: MODEL.name,
      description: MODEL.description,
      department_code: MODEL.department_code,
      visibility: 'department',
      status: 'active',
      owner_subject: 'finance-user',
      created_by: 'finance-user',
      created_at: now,
      updated_at: now,
      row_version: 1,
    })
    .execute();
  await handle.db
    .insertInto('model_version')
    .values({
      model_version_id: VERSION_ID,
      model_id: MODEL.model_id,
      version_number: 1,
      status: 'published',
      definition,
      validation_report: null,
      cube_refresh_status: 'pending',
      cube_refresh_requested_at: now,
      cube_refresh_completed_at: null,
      cube_refresh_error: null,
      created_by: 'finance-user',
      created_at: now,
      published_by: 'finance-user',
      published_at: now,
      superseded_by_version_id: null,
      row_version: 1,
    })
    .execute();
}

test('legacy definition converts to a neutral model', () => {
  const model = semanticModelFromDefinition(DEFINITION, identity());

  assert.equal(model.format, 'cpm-semantic-model/1');
  assert.equal(model.schema_version, '1.0');
  assert.equal(model.name, MODEL.code);
  assert.equal(model.datasets[0]?.name, 'fact_financials');
  assert.equal(model.datasets[0]?.source, 'gold.fact_financials');
  assert.deepEqual(
    model.datasets[0]?.fields.map((field) => field.name),
    ['transaction_date', 'department_code', 'category_code']
  );
  assert.deepEqual(
    model.metrics.map((metric) => metric.name),
    ['budget_amount', 'actual_amount', 'transaction_count']
  );
  assert.equal(model.metrics[2]?.expression, null, 'count metrics have no operand');
  assert.equal(model.access.row_level_field, 'department_code');
  assert.equal(model.extensions?.cpm?.department_code, 'finance');
});

test('legacy models resolve the access member by source expression', () => {
  const model = semanticModelFromDefinition(
    {
      schema_version: '1.0',
      dimensions: [
        { code: 'department', name: 'Department', data_type: 'string', expression: 'department_code' },
        { code: 'category', name: 'Category', data_type: 'string', expression: 'category_code' },
      ],
      measures: [
        { code: 'budget', name: 'Budget', aggregation: 'sum', expression: 'budget_amount', format: 'currency', currency_code: 'USD' },
      ],
    },
    identity()
  );

  assert.equal(model.datasets[0]?.source, 'gold.fact_financials');
  assert.equal(model.access.row_level_field, 'department');
});

test('target-independent validation reports the expected issues', () => {
  const base = semanticModelFromDefinition(DEFINITION, identity());
  assert.equal(validateSemanticModel(base).valid, true);

  const duplicate = structuredClone(base);
  duplicate.datasets[0]!.fields.push({ ...duplicate.datasets[0]!.fields[0]!, name: 'department_code' });
  const duplicateReport = validateSemanticModel(duplicate);
  assert.equal(duplicateReport.valid, false);
  assert.ok(duplicateReport.issues.some((issue) => issue.code === 'duplicate_dimension'));

  const badAccess = structuredClone(base);
  badAccess.access.row_level_field = 'cost_centre_code';
  assert.ok(
    validateSemanticModel(badAccess).issues.some((issue) => issue.code === 'access_field_unknown')
  );

  const unsafe = structuredClone(base);
  unsafe.datasets[0]!.fields[0]!.expression.column = 'transaction_date); DROP TABLE gold.fact_financials; --';
  assert.ok(
    validateSemanticModel(unsafe).issues.some((issue) => issue.code === 'unsafe_expression')
  );

  const noCurrency = structuredClone(base);
  noCurrency.metrics[0]!.currency_code = null;
  assert.ok(
    validateSemanticModel(noCurrency).issues.some((issue) => issue.code === 'currency_required')
  );
});

test('canonical hashing is deterministic and order-sensitive', () => {
  const model = semanticModelFromDefinition(DEFINITION, identity());
  const clone = structuredClone(model);

  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(semanticModelHash(model), semanticModelHash(clone));

  const relabeled = { ...model, label: 'Renamed model', description: 'Presentation only' };
  assert.equal(
    semanticModelHash(model),
    semanticModelHash(relabeled),
    'labels and descriptions are presentation, not semantic content'
  );

  clone.datasets[0]!.fields.reverse();
  assert.notEqual(semanticModelHash(model), semanticModelHash(clone));
});

test('Ossie export carries datasets, aggregate metrics and CPM governance', () => {
  const document = toOssieDocument(semanticModelFromDefinition(DEFINITION, identity()));

  assert.equal(document.version, '0.1.1');
  assert.equal(document.datasets[0]?.source, 'gold.fact_financials');
  assert.equal(
    document.datasets[0]?.fields[0]?.expression.dialects[0]?.expression,
    'transaction_date'
  );
  assert.equal(
    document.metrics.find((metric) => metric.name === 'budget_amount')?.expression.dialects[0]
      ?.expression,
    'SUM(budget_amount)'
  );
  assert.equal(
    document.metrics.find((metric) => metric.name === 'transaction_count')?.expression.dialects[0]
      ?.expression,
    'COUNT(*)'
  );
  const governance = document.custom_extensions[0]?.data as {
    access: { row_level_field: string };
  };
  assert.equal(governance.access.row_level_field, 'department_code');
});

test('Cube compiler produces the same document from legacy and neutral inputs', () => {
  const semantic = semanticModelFromDefinition(DEFINITION, identity());
  const legacyCube = buildCube({ model: MODEL, version: { model_version_id: VERSION_ID, version_number: 1, status: 'published', definition: DEFINITION }, source: SOURCE });
  const neutralCube = buildCube({
    model: MODEL,
    version: { model_version_id: VERSION_ID, version_number: 1, status: 'published', definition: {} },
    source: SOURCE,
    semantic,
  });

  assert.equal(neutralCube.content, legacyCube.content);
  assert.match(neutralCube.content, /sql_table: "gold\.fact_financials"/);
  assert.match(neutralCube.content, /member: "department_code"/);
  assert.deepEqual(neutralCube.measures, ['budget_amount', 'actual_amount', 'transaction_count']);
});

test('normalized rows round-trip the canonical model', async () => {
  const { dir, handle } = await tempDatabase();
  try {
    await insertModelVersion(handle, '{}');
    const semantic = semanticModelFromDefinition(DEFINITION, identity());
    const hash = await handle.db
      .transaction()
      .execute((trx) => writeSemanticModel(trx, VERSION_ID, semantic));
    await handle.db
      .updateTable('model_version')
      .set({ semantic_schema_version: '1.0', semantic_hash: hash })
      .where('model_version_id', '=', VERSION_ID)
      .execute();

    const loaded = await loadSemanticModel(handle.db, VERSION_ID);
    assert.ok(loaded);
    assert.deepEqual(loaded, semantic);
    assert.equal(semanticModelHash(loaded), hash);

    const cube = buildCube({
      model: MODEL,
      version: { model_version_id: VERSION_ID, version_number: 1, status: 'published', definition: {} },
      source: SOURCE,
      semantic: loaded,
    });
    assert.match(cube.content, /member: "department_code"/);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('draft duplicates persist so validation can report them', async () => {
  const { dir, handle } = await tempDatabase();
  try {
    await insertModelVersion(handle, '{}');
    const semantic = semanticModelFromDefinition(DEFINITION, identity());
    semantic.datasets[0]!.fields.push(structuredClone(semantic.datasets[0]!.fields[1]!));
    semantic.metrics.push(structuredClone(semantic.metrics[0]!));

    await handle.db
      .transaction()
      .execute((trx) => writeSemanticModel(trx, VERSION_ID, semantic));

    const loaded = await loadSemanticModel(handle.db, VERSION_ID);
    assert.ok(loaded);
    assert.equal(loaded.datasets[0]?.fields.length, 4);
    assert.equal(loaded.metrics.length, 4);

    const report = validateSemanticModel(loaded);
    assert.ok(report.issues.some((issue) => issue.code === 'duplicate_dimension'));
    assert.ok(report.issues.some((issue) => issue.code === 'duplicate_measure'));
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill migrates legacy rows once and is idempotent', async () => {
  const { dir, handle } = await tempDatabase();
  try {
    await insertModelVersion(handle, JSON.stringify(DEFINITION));

    const first = await backfillSemanticModels(handle.db);
    assert.deepEqual(first, { scanned: 1, written: 1, skipped: 0, invalid: 0 });

    const second = await backfillSemanticModels(handle.db);
    assert.deepEqual(second, { scanned: 1, written: 0, skipped: 1, invalid: 0 });

    const loaded = await loadSemanticModel(handle.db, VERSION_ID);
    assert.ok(loaded);
    const row = await handle.db
      .selectFrom('model_version')
      .selectAll()
      .where('model_version_id', '=', VERSION_ID)
      .executeTakeFirstOrThrow();
    assert.equal(row.semantic_schema_version, '1.0');
    assert.equal(row.semantic_hash, semanticModelHash(loaded));
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
