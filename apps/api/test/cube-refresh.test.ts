import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AnalyticsHandle } from '../src/analytics.js';
import { loadConfig } from '../src/config.js';
import { buildCube, CubeSchemaError } from '../src/cube/schema.js';
import { applyPromotions, loadPromotedManifest, promoteCubeSchema } from '../src/cube/promoted.js';
import { createDatabase } from '../src/db.js';
import { writeOutbox } from '../src/audit.js';
import { applyMigrations, applySeeds } from '../src/migrate.js';
import { processCubeRefreshOnce } from '../src/services/cube-refresh.js';
import { refreshModelVersionCube } from '../src/services/models.js';
import type { AuthUser } from '../src/auth.js';
import {
  ValkeyCubeSchemaStore,
  type ValkeyClientLike,
  type ValkeyPipelineLike,
} from '../src/cube/valkey-store.js';
import { FileCubeSchemaStore } from '../src/cube/store.js';

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
  ].map((name) => ({ name })),
};

const model = {
  model_id: 'model-1',
  code: 'fy2026_department_budget',
  name: 'FY2026 Department Budget',
  description: 'Published budget model',
  department_code: 'finance',
  status: 'active',
};

const version = {
  model_version_id: 'version-2',
  version_number: 2,
  status: 'published',
  definition: DEFINITION,
};

function analyticsStub(): Pick<AnalyticsHandle, 'getSource'> {
  return {
    getSource: async () => SOURCE,
  } as unknown as Pick<AnalyticsHandle, 'getSource'>;
}

function tempConfig(schemaDir: string, overrides: Record<string, unknown> = {}) {
  return loadConfig({
    jwtSecret: 'test-secret',
    dbPath: path.join(schemaDir, 'unused.duckdb'),
    analyticsDbPath: path.join(schemaDir, 'unused-analytics.duckdb'),
    cubeSchemaDir: schemaDir,
    cubeSchemaStore: 'file',
    valkeyUrl: null,
    cubeRefreshEnabled: false,
    cubeUrl: null,
    cubeApiSecret: null,
    ...overrides,
  });
}

async function seedPublishedModel(dbPath: string) {
  const handle = await createDatabase(dbPath);
  const now = new Date();
  await handle.db
    .insertInto('model')
    .values({
      model_id: model.model_id,
      code: model.code,
      name: model.name,
      description: model.description,
      department_code: model.department_code,
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
      model_version_id: version.model_version_id,
      model_id: model.model_id,
      version_number: version.version_number,
      status: 'published',
      definition: JSON.stringify(DEFINITION),
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
  await writeOutbox(handle.db, {
    eventType: 'model_version.cube_refresh_requested',
    aggregateType: 'model_version',
    aggregateId: version.model_version_id,
    payload: { model_id: model.model_id, model_version_id: version.model_version_id },
  });
  return handle;
}

async function readVersion(handle: Awaited<ReturnType<typeof createDatabase>>, id: string) {
  return handle.db
    .selectFrom('model_version')
    .selectAll()
    .where('model_version_id', '=', id)
    .executeTakeFirstOrThrow();
}

function timestampMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'micros' in value) {
    return Number((value as { micros: bigint }).micros) / 1_000;
  }
  return Number.NaN;
}

test('buildCube renders a governed Cube document', () => {
  const cube = buildCube({ model, version, source: { source_id: SOURCE.source_id, columns: SOURCE.columns.map((c) => c.name) } });

  assert.equal(cube.cube_name, 'fy2026_department_budget');
  assert.equal(cube.file_name, 'fy2026_department_budget.yml');
  assert.match(cube.content, /^cubes:\n {2}- name: "fy2026_department_budget"/);
  assert.match(cube.content, /sql_table: "gold\.fact_financials"/);
  assert.match(cube.content, /- name: "transaction_date"\n {8}title: "Transaction date"\n {8}sql: "transaction_date"\n {8}type: "time"/);
  assert.match(cube.content, /- name: "budget_amount"[\s\S]*?type: "sum"\n {8}format: "currency"\n {8}currency: "USD"/);
  assert.match(cube.content, /- name: "transaction_count"[\s\S]*?type: "count"\n {8}format: "number"/);
  assert.match(
    cube.content,
    /accessPolicy:\n {6}- group: "steward"\n {8}rowLevel:\n {10}allowAll: true\n {6}- group: "business_user"[\s\S]*?member: "department_code"[\s\S]*?\{SECURITY_CONTEXT\.department_code\}/
  );
  assert.deepEqual(cube.measures, ['budget_amount', 'actual_amount', 'transaction_count']);
});

test('buildCube rejects unsafe definitions', () => {
  const source = { source_id: SOURCE.source_id, columns: SOURCE.columns.map((c) => c.name) };

  assert.throws(
    () => buildCube({ model, version: { ...version, definition: { ...DEFINITION, measures: [{ code: 'x', aggregation: 'sum', expression: 'budget_amount); DROP TABLE gold.fact_financials; --', format: 'number' }] } }, source }),
    CubeSchemaError
  );
  assert.throws(
    () => buildCube({ model: { ...model, code: 'financials' }, version, source }),
    /collides with a built-in Cube member/
  );
  assert.throws(
    () => buildCube({ model, version: { ...version, definition: { ...DEFINITION, access: { row_level_field: 'cost_centre_code' } } }, source }),
    /must be a dimension/
  );
  assert.throws(
    () => buildCube({ model, version: { ...version, definition: { ...DEFINITION, dimensions: DEFINITION.dimensions.filter((d) => d.code !== 'department_code') } }, source }),
    /must be a dimension/
  );
});

test('buildCube applies the legacy source and access defaults', () => {
  // Definitions created before Model Studio have no source/access block and
  // expose the department column under the member code `department`.
  const legacy = {
    schema_version: '1.0',
    dimensions: [
      { code: 'department', name: 'Department', data_type: 'string', expression: 'department_code' },
      { code: 'category', name: 'Category', data_type: 'string', expression: 'category_code' },
    ],
    measures: [
      { code: 'budget_amount', name: 'Budget', aggregation: 'sum', expression: 'budget_amount', format: 'currency', currency_code: 'USD' },
    ],
  };
  const cube = buildCube({
    model: { ...model, code: 'finance_budget_model' },
    version: { ...version, definition: legacy },
    source: { source_id: SOURCE.source_id, columns: SOURCE.columns.map((c) => c.name) },
  });

  assert.match(cube.content, /sql_table: "gold\.fact_financials"/);
  assert.match(cube.content, /member: "department"\n {14}operator: "equals"/);
  assert.doesNotMatch(cube.content, /row_level_field|undefined/);
});

test('refresh commits a verified snapshot and marks the model version succeeded', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-refresh-'));
  const dbPath = path.join(dir, 'oltp.duckdb');
  const schemaDir = path.join(dir, 'cube-schema');
  await applyMigrations(dbPath);
  await applySeeds(dbPath);
  const handle = await seedPublishedModel(dbPath);
  const verified: string[][] = [];

  try {
    const result = await processCubeRefreshOnce({
      db: handle.db,
      analytics: analyticsStub(),
      config: tempConfig(schemaDir),
      verify: async (cubes) => {
        verified.push(cubes.map((cube) => cube.cube_name));
      },
    });

    assert.equal(result.processed, true);
    assert.equal(typeof result.schemaVersion, 'string');
    assert.equal(result.error, undefined);
    assert.deepEqual(verified, [['fy2026_department_budget']]);
    const schemaVersion = result.schemaVersion as string;

    const pointer = JSON.parse(readFileSync(path.join(schemaDir, 'current.json'), 'utf8'));
    assert.equal(pointer.schema_version, schemaVersion);
    assert.equal(pointer.models.length, 1);
    assert.equal(pointer.models[0].cube_name, 'fy2026_department_budget');
    assert.equal(pointer.models[0].version_number, 2);

    const generatedFile = path.join(schemaDir, 'versions', schemaVersion, 'fy2026_department_budget.yml');
    assert.ok(existsSync(generatedFile), 'generated cube file exists');
    assert.match(readFileSync(generatedFile, 'utf8'), /sql_table: "gold\.fact_financials"/);

    const row = await readVersion(handle, version.model_version_id);
    assert.equal(row.cube_refresh_status, 'succeeded');
    assert.ok(row.cube_refresh_completed_at);
    assert.equal(row.cube_refresh_error, null);
    assert.equal(row.row_version, 3, 'running + succeeded each bump row_version');

    const event = await handle.db.selectFrom('outbox_event').selectAll().executeTakeFirstOrThrow();
    assert.equal(event.status, 'succeeded');
    assert.ok(event.processed_at);

    const audit = await handle.db
      .selectFrom('audit_event')
      .selectAll()
      .where('action', '=', 'model_version.cube_refresh_succeeded')
      .executeTakeFirstOrThrow();
    assert.equal(audit.entity_id, version.model_version_id);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed published refresh can be requeued and retried', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-refresh-'));
  const dbPath = path.join(dir, 'oltp.duckdb');
  const schemaDir = path.join(dir, 'cube-schema');
  await applyMigrations(dbPath);
  await applySeeds(dbPath);
  const handle = await seedPublishedModel(dbPath);

  const financeUser: AuthUser = {
    subject: 'finance-user',
    displayName: 'Finance User',
    departmentCode: 'finance',
    costCentreCodes: ['cc_finance'],
    roles: ['business_user'],
    groups: ['business_user'],
    isSteward: false,
  };
  const hrUser: AuthUser = { ...financeUser, subject: 'hr-user', departmentCode: 'hr', costCentreCodes: ['cc_hr'] };
  const context = { correlationId: 'test-correlation', requestId: 'test-request' };

  try {
    await handle.db
      .updateTable('model_version')
      .set({ cube_refresh_status: 'failed', cube_refresh_error: 'Cube meta returned 503' })
      .where('model_version_id', '=', version.model_version_id)
      .execute();
    await handle.db
      .updateTable('outbox_event')
      .set({ status: 'failed', attempts: 5, last_error: 'Cube meta returned 503' })
      .execute();

    await assert.rejects(
      refreshModelVersionCube(handle.db, hrUser, version.model_version_id, context),
      (error: unknown) => (error as { status?: number }).status === 404
    );

    const queued = await refreshModelVersionCube(handle.db, financeUser, version.model_version_id, context);
    assert.equal(queued.alreadyQueued, false);
    assert.equal(queued.payload.cube_refresh.status, 'pending');
    assert.equal(queued.payload.cube_refresh.error, null);

    const again = await refreshModelVersionCube(handle.db, financeUser, version.model_version_id, context);
    assert.equal(again.alreadyQueued, true);
    const pending = await handle.db
      .selectFrom('outbox_event')
      .selectAll()
      .where('status', '=', 'pending')
      .execute();
    assert.equal(pending.length, 1, 'a second request coalesces onto the pending event');

    const audit = await handle.db
      .selectFrom('audit_event')
      .selectAll()
      .where('action', '=', 'model_version.cube_refresh_requested')
      .executeTakeFirstOrThrow();
    assert.equal(audit.actor_subject, 'finance-user');

    const result = await processCubeRefreshOnce({
      db: handle.db,
      analytics: analyticsStub(),
      config: tempConfig(schemaDir),
      verify: async () => undefined,
    });
    assert.equal(result.processed, true);
    const row = await readVersion(handle, version.model_version_id);
    assert.equal(row.cube_refresh_status, 'succeeded');
    assert.equal(row.cube_refresh_error, null);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed verification rolls back and retries before failing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-refresh-'));
  const dbPath = path.join(dir, 'oltp.duckdb');
  const schemaDir = path.join(dir, 'cube-schema');
  await applyMigrations(dbPath);
  await applySeeds(dbPath);
  const handle = await seedPublishedModel(dbPath);

  try {
    const deps = {
      db: handle.db,
      analytics: analyticsStub(),
      config: tempConfig(schemaDir, { cubeRefreshMaxAttempts: 2 }),
      verify: async () => {
        throw new Error('Cube meta returned 503: unavailable');
      },
    };

    const base = Date.now() + 60_000;
    const at = (offsetMs: number) => new Date(base + offsetMs);

    const first = await processCubeRefreshOnce({ ...deps, now: () => at(0) });
    assert.equal(first.processed, true);
    assert.match(first.error ?? '', /503/);
    assert.equal(existsSync(path.join(schemaDir, 'current.json')), false, 'pointer rolled back');

    let row = await readVersion(handle, version.model_version_id);
    assert.equal(row.cube_refresh_status, 'pending');
    assert.match(row.cube_refresh_error ?? '', /503/);

    let event = await handle.db.selectFrom('outbox_event').selectAll().executeTakeFirstOrThrow();
    assert.equal(event.status, 'pending');
    assert.equal(event.attempts, 1);
    assert.ok(timestampMs(event.available_at) > base);

    const notDue = await processCubeRefreshOnce({ ...deps, now: () => at(0) });
    assert.equal(notDue.processed, false, 'backoff prevents an immediate retry');

    const second = await processCubeRefreshOnce({ ...deps, now: () => at(5_000) });
    assert.equal(second.processed, true);

    row = await readVersion(handle, version.model_version_id);
    assert.equal(row.cube_refresh_status, 'failed');
    assert.equal(row.cube_refresh_completed_at, null);
    assert.match(row.cube_refresh_error ?? '', /503/);

    event = await handle.db.selectFrom('outbox_event').selectAll().executeTakeFirstOrThrow();
    assert.equal(event.status, 'failed');
    assert.match(event.last_error ?? '', /503/);

    const audit = await handle.db
      .selectFrom('audit_event')
      .selectAll()
      .where('action', '=', 'model_version.cube_refresh_failed')
      .executeTakeFirstOrThrow();
    assert.equal(audit.entity_id, version.model_version_id);
    assert.equal(existsSync(path.join(schemaDir, 'current.json')), false);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file store reads back the committed snapshot', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-file-store-'));
  const store = new FileCubeSchemaStore(path.join(dir, 'cube-schema'));
  const cube = buildCube({
    model,
    version,
    source: { source_id: SOURCE.source_id, columns: SOURCE.columns.map((column) => column.name) },
  });

  try {
    const commit = await store.commit([cube], new Date('2026-11-04T12:00:00Z'));
    const snapshot = await store.readSnapshot();
    assert.equal(snapshot?.schema_version, commit.schema_version);
    assert.equal(snapshot?.cubes.length, 1);
    assert.equal(snapshot?.cubes[0]?.content, cube.content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeValkeyClient implements ValkeyClientLike {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.values.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<unknown> {
    return keys.reduce((count, key) => count + (this.values.delete(key) ? 1 : 0), 0);
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.values.get(key) ?? null);
  }

  async sadd(key: string, member: string): Promise<unknown> {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(member);
    this.sets.set(key, set);
    return 1;
  }

  async srem(key: string, member: string): Promise<unknown> {
    const set = this.sets.get(key);
    return set?.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async scan(_cursor: string, ...args: Array<string | number>): Promise<[string, string[]]> {
    const matchIndex = args.indexOf('MATCH');
    const pattern = matchIndex >= 0 ? String(args[matchIndex + 1]) : '*';
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return ['0', [...this.values.keys()].filter((key) => key.startsWith(prefix))];
  }

  readonly published: Array<{ channel: string; message: string }> = [];

  async publish(channel: string, message: string): Promise<unknown> {
    this.published.push({ channel, message });
    return 0;
  }

  pipeline(): ValkeyPipelineLike {
    const operations: Array<() => void> = [];
    const chain: ValkeyPipelineLike = {
      set: (key, value) => {
        operations.push(() => this.values.set(key, value));
        return chain;
      },
      expire: () => chain,
      del: (...keys) => {
        operations.push(() => {
          for (const key of keys) this.values.delete(key);
        });
        return chain;
      },
      sadd: (key, member) => {
        operations.push(() => {
          const set = this.sets.get(key) ?? new Set<string>();
          set.add(member);
          this.sets.set(key, set);
        });
        return chain;
      },
      exec: async () => {
        for (const operation of operations) operation();
        return [];
      },
    };
    return chain;
  }

  async quit(): Promise<unknown> {
    return 'OK';
  }
}

function cubeWithVariance() {
  return buildCube({
    model,
    version: {
      ...version,
      definition: {
        ...DEFINITION,
        measures: [
          ...DEFINITION.measures,
          {
            code: 'variance_amount',
            name: 'Variance',
            aggregation: 'sum',
            expression: 'variance_amount',
            format: 'currency',
            currency_code: 'USD',
          },
        ],
      },
    },
    source: { source_id: SOURCE.source_id, columns: SOURCE.columns.map((column) => column.name) },
  });
}

test('valkey store commits, rolls back and prunes content-addressed keys', async () => {
  const client = new FakeValkeyClient();
  const store = new ValkeyCubeSchemaStore(client, 'test:cube-schema', 0);
  const base = buildCube({
    model,
    version,
    source: { source_id: SOURCE.source_id, columns: SOURCE.columns.map((column) => column.name) },
  });
  const extended = cubeWithVariance();

  const first = await store.commit([base], new Date('2026-11-04T10:00:00Z'));
  assert.equal(first.changed, true);
  assert.equal(await client.get('test:cube-schema:current'), JSON.stringify(first.manifest));
  assert.ok(
    await client.get(`test:cube-schema:versions:${first.schema_version}:fy2026_department_budget.yml`)
  );
  assert.deepEqual(await client.smembers('test:cube-schema:versions'), [first.schema_version]);
  assert.equal(client.published.at(-1)?.channel, 'test:cube-schema:events');
  assert.equal(JSON.parse(client.published.at(-1)?.message ?? '{}').type, 'cube_schema_committed');

  const stored = await store.readSnapshot();
  assert.equal(stored?.schema_version, first.schema_version);
  assert.equal(stored?.cubes.length, 1);
  assert.match(stored?.cubes[0]?.content ?? '', /name: "fy2026_department_budget"/);

  const second = await store.commit([extended], new Date('2026-11-04T10:01:00Z'));
  assert.notEqual(second.schema_version, first.schema_version);
  assert.equal(second.previous, JSON.stringify(first.manifest));

  await store.rollback(second);
  assert.equal(await client.get('test:cube-schema:current'), JSON.stringify(first.manifest));
  assert.equal(
    await client.get(`test:cube-schema:versions:${second.schema_version}:fy2026_department_budget.yml`),
    null
  );
  assert.deepEqual(await client.smembers('test:cube-schema:versions'), [first.schema_version]);
  assert.equal(JSON.parse(client.published.at(-1)?.message ?? '{}').type, 'cube_schema_rolled_back');

  const third = await store.commit([extended], new Date('2026-11-04T10:02:00Z'));
  await store.prune([third.schema_version]);
  assert.equal(
    await client.get(`test:cube-schema:versions:${first.schema_version}:fy2026_department_budget.yml`),
    null
  );
  assert.deepEqual(await client.smembers('test:cube-schema:versions'), [third.schema_version]);
});

test('the refresh worker writes to the configured valkey store', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-refresh-'));
  const dbPath = path.join(dir, 'oltp.duckdb');
  const schemaDir = path.join(dir, 'unused-file-store');
  await applyMigrations(dbPath);
  await applySeeds(dbPath);
  const handle = await seedPublishedModel(dbPath);
  const client = new FakeValkeyClient();
  const store = new ValkeyCubeSchemaStore(client, 'test:cube', 0);

  try {
    const result = await processCubeRefreshOnce({
      db: handle.db,
      analytics: analyticsStub(),
      config: tempConfig(schemaDir, { cubeSchemaStore: 'valkey', valkeyUrl: 'redis://test' }),
      store,
      verify: async () => undefined,
    });

    assert.equal(result.processed, true);
    assert.equal(result.error, undefined);
    const pointer = JSON.parse((await client.get('test:cube:current')) ?? '{}');
    assert.equal(pointer.schema_version, result.schemaVersion);
    assert.ok(
      await client.get(`test:cube:versions:${pointer.schema_version}:fy2026_department_budget.yml`)
    );
    assert.equal(existsSync(path.join(schemaDir, 'current.json')), false, 'file store is not used');

    const row = await readVersion(handle, version.model_version_id);
    assert.equal(row.cube_refresh_status, 'succeeded');
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('promoted models leave the dynamic snapshot and stale versions fail loudly', () => {
  const manifest = {
    format: 'cpm-promoted-models/1' as const,
    models: [
      {
        model_code: 'fy2026_department_budget',
        cube_name: 'fy2026_department_budget',
        model_version_id: 'version-2',
        version_number: 2,
        promoted_at: '2026-11-05T00:00:00.000Z',
        file: 'cubes/promoted/fy2026_department_budget.yml',
      },
    ],
  };
  const row = {
    code: 'fy2026_department_budget',
    model_version_id: 'version-2',
    version_number: 2,
    cube_refresh_status: 'pending',
    row_version: 1,
    department_code: 'finance',
  };

  const result = applyPromotions([row], manifest);
  assert.equal(result.rows.length, 0);
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0]?.entry.file, 'cubes/promoted/fy2026_department_budget.yml');

  assert.throws(
    () => applyPromotions([{ ...row, model_version_id: 'version-3', version_number: 3 }], manifest),
    /promoted to static YAML/
  );
});

test('promotion writes reviewed static YAML and trims the dynamic snapshot', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-promote-'));
  const client = new FakeValkeyClient();
  const store = new ValkeyCubeSchemaStore(client, 'test:cube', 0);
  const source = { source_id: SOURCE.source_id, columns: SOURCE.columns.map((column) => column.name) };
  const cubes = [
    buildCube({ model, version, source }),
    buildCube({
      model: {
        ...model,
        model_id: 'model-2',
        code: 'finance_budget_model',
        name: 'Finance Budget Model',
      },
      version: { ...version, model_version_id: 'version-1b', version_number: 1 },
      source,
    }),
  ];
  const cubeModelDir = path.join(dir, 'cube-model');
  const manifestPath = path.join(cubeModelDir, 'promoted-models.json');

  try {
    await store.commit(cubes, new Date('2026-11-04T12:00:00Z'));
    const result = await promoteCubeSchema({
      store,
      cubeModelDir,
      manifestPath,
      modelCodes: ['fy2026_department_budget'],
      now: new Date('2026-11-05T00:00:00Z'),
    });

    assert.equal(result.promoted.length, 1);
    assert.equal(result.remaining, 1);
    const staticFile = path.join(cubeModelDir, 'cubes', 'promoted', 'fy2026_department_budget.yml');
    assert.ok(existsSync(staticFile), 'static YAML is written');
    const staticYaml = readFileSync(staticFile, 'utf8');
    assert.match(staticYaml, /^# Promoted from the CPM Lite model registry/);
    assert.match(staticYaml, /name: "fy2026_department_budget"/);

    const manifest = loadPromotedManifest(manifestPath);
    assert.equal(manifest.models.length, 1);
    assert.equal(manifest.models[0]?.model_version_id, 'version-2');

    const snapshot = await store.readSnapshot();
    assert.deepEqual(snapshot?.cubes.map((cube) => cube.model_code), ['finance_budget_model']);
    assert.equal(JSON.parse(client.published.at(-1)?.message ?? '{}').type, 'cube_schema_committed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the refresh worker marks a promoted version as succeeded without a dynamic cube', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-promote-'));
  const dbPath = path.join(dir, 'oltp.duckdb');
  const schemaDir = path.join(dir, 'cube-schema');
  const manifestPath = path.join(dir, 'promoted-models.json');
  await applyMigrations(dbPath);
  await applySeeds(dbPath);
  const handle = await seedPublishedModel(dbPath);
  const client = new FakeValkeyClient();
  const store = new ValkeyCubeSchemaStore(client, 'test:cube', 0);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      format: 'cpm-promoted-models/1',
      models: [
        {
          model_code: model.code,
          cube_name: model.code,
          model_version_id: version.model_version_id,
          version_number: version.version_number,
          promoted_at: '2026-11-05T00:00:00.000Z',
          file: `cubes/promoted/${model.code}.yml`,
        },
      ],
    })}\n`
  );

  try {
    const verified: string[] = [];
    const result = await processCubeRefreshOnce({
      db: handle.db,
      analytics: analyticsStub(),
      config: tempConfig(schemaDir, { cubePromotedManifestPath: manifestPath }),
      store,
      verify: async (cubes) => {
        verified.push(...cubes.map((cube) => cube.cube_name));
      },
    });

    assert.equal(result.processed, true);
    assert.deepEqual(verified, [], 'promoted cubes are not generated dynamically');
    const snapshot = await store.readSnapshot();
    assert.equal(snapshot?.cubes.length, 0);

    const row = await readVersion(handle, version.model_version_id);
    assert.equal(row.cube_refresh_status, 'succeeded');
    assert.equal(row.cube_refresh_error, null);

    const audit = await handle.db
      .selectFrom('audit_event')
      .selectAll()
      .where('action', '=', 'model_version.cube_refresh_succeeded')
      .executeTakeFirstOrThrow();
    assert.match(String(audit.after_state), /"mode":"static_yaml"/);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
