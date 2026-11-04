import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DynamicSchemaRepository,
  ValkeySchemaRepository,
  createDynamicSchemaRepository,
} = require('../model/dynamic-repository.cjs');

const STATIC_CUBE = 'cubes:\n  - name: "static_cube"\n    sql_table: "gold.fact_financials"\n';
const GENERATED_CUBE = 'cubes:\n  - name: "generated_model"\n    sql_table: "gold.fact_financials"\n';

function staticSchemaDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-static-'));
  writeFileSync(path.join(dir, 'static.yml'), STATIC_CUBE);
  return dir;
}

function manifest(schemaVersion, fileName = 'generated_model.yml') {
  return {
    schema_version: schemaVersion,
    format: 'cpm-cube-schema/1',
    generated_at: '2026-11-04T00:00:00.000Z',
    models: [
      {
        model_id: 'model-1',
        model_code: 'generated_model',
        model_version_id: 'version-1',
        version_number: 1,
        cube_name: 'generated_model',
        file_name: fileName,
        measures: ['budget_amount'],
      },
    ],
  };
}

class FakeValkey {
  constructor() {
    this.values = new Map();
    this.failing = false;
  }

  ensure() {
    if (this.failing) throw new Error('Valkey connection refused');
  }

  async get(key) {
    this.ensure();
    return this.values.get(key) ?? null;
  }

  async mget(...keys) {
    this.ensure();
    return keys.map((key) => this.values.get(key) ?? null);
  }

  setPointer(schemaVersion, fileName = 'generated_model.yml') {
    this.values.set('cpm:cube-schema:current', JSON.stringify(manifest(schemaVersion, fileName)));
  }

  setFile(schemaVersion, content, fileName = 'generated_model.yml') {
    this.values.set(`cpm:cube-schema:versions:${schemaVersion}:${fileName}`, content);
  }
}

function repoPath(dir) {
  // FileRepository joins this with process.cwd(), so it must stay relative.
  return path.relative(process.cwd(), dir);
}

function valkeyRepository(client, staticDir) {
  return new ValkeySchemaRepository(repoPath(staticDir), { client, keyPrefix: 'cpm:cube-schema' });
}

test('file repository merges static and generated cubes', async () => {
  const staticDir = staticSchemaDir();
  const schemaDir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-generated-'));
  mkdirSync(path.join(schemaDir, 'versions', 'hash-1'), { recursive: true });
  writeFileSync(path.join(schemaDir, 'current.json'), JSON.stringify(manifest('hash-1')));
  writeFileSync(path.join(schemaDir, 'versions', 'hash-1', 'generated_model.yml'), GENERATED_CUBE);

  try {
    const repository = new DynamicSchemaRepository(repoPath(staticDir), schemaDir);
    const files = await repository.dataSchemaFiles();
    assert.equal(files.length, 2);
    assert.ok(files.some((file) => file.content === STATIC_CUBE));
    assert.ok(files.some((file) => file.content === GENERATED_CUBE));
    assert.equal(repository.schemaVersion(), 'dynamic:hash-1');
  } finally {
    rmSync(staticDir, { recursive: true, force: true });
    rmSync(schemaDir, { recursive: true, force: true });
  }
});

test('valkey repository loads the snapshot and follows the pointer', async () => {
  const staticDir = staticSchemaDir();
  const client = new FakeValkey();
  client.setPointer('hash-1');
  client.setFile('hash-1', GENERATED_CUBE);

  try {
    const first = valkeyRepository(client, staticDir);
    const files = await first.dataSchemaFiles();
    assert.equal(files.length, 2);
    assert.ok(files.some((file) => file.content === GENERATED_CUBE));
    assert.equal(await first.schemaVersion(), 'valkey:hash-1');

    // A new snapshot must be picked up by a fresh repository (a replica or a
    // restart); the per-instance pointer cache is intentionally short.
    client.setPointer('hash-2');
    client.setFile('hash-2', GENERATED_CUBE.replace('generated_model', 'generated_model_v2'));
    const second = valkeyRepository(client, staticDir);
    assert.equal(await second.schemaVersion(), 'valkey:hash-2');
    const reloaded = await second.dataSchemaFiles();
    assert.ok(reloaded.some((file) => file.content.includes('generated_model_v2')));
  } finally {
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test('valkey repository serves static-only when no snapshot exists', async () => {
  const staticDir = staticSchemaDir();
  const repository = valkeyRepository(new FakeValkey(), staticDir);
  try {
    const files = await repository.dataSchemaFiles();
    assert.equal(files.length, 1);
    assert.ok(files[0].content === STATIC_CUBE);
    assert.equal(await repository.schemaVersion(), 'static');
  } finally {
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test('valkey repository keeps the last known schema through an outage', async () => {
  const staticDir = staticSchemaDir();
  const client = new FakeValkey();
  client.setPointer('hash-1');
  client.setFile('hash-1', GENERATED_CUBE);

  try {
    const repository = valkeyRepository(client, staticDir);
    assert.equal(await repository.schemaVersion(), 'valkey:hash-1');
    assert.equal((await repository.dataSchemaFiles()).length, 2);

    client.failing = true;
    // Expire the pointer cache so the next read hits the failing client.
    repository.pointer = { at: 0, raw: null };
    const files = await repository.dataSchemaFiles();
    assert.equal(files.length, 2, 'falls back to the last known generated schema');
    assert.equal(await repository.schemaVersion(), 'valkey:hash-1');
  } finally {
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test('valkey repository invalidates its pointer cache on a published event', async () => {
  const staticDir = staticSchemaDir();
  const client = new FakeValkey();
  const handlers = new Map();
  const subscriber = {
    subscribe: async () => 1,
    on: (event, handler) => handlers.set(event, handler),
  };
  client.setPointer('hash-1');
  client.setFile('hash-1', GENERATED_CUBE);

  try {
    const repository = new ValkeySchemaRepository(repoPath(staticDir), {
      client,
      subscriber,
      keyPrefix: 'cpm:cube-schema',
    });
    assert.equal(await repository.schemaVersion(), 'valkey:hash-1');

    // Within the one-second pointer cache, the old hash would be returned...
    client.setPointer('hash-2');
    client.setFile('hash-2', GENERATED_CUBE);
    assert.equal(await repository.schemaVersion(), 'valkey:hash-1');

    // ...until Cube receives the commit event, which invalidates the cache.
    handlers.get('message')('cpm:cube-schema:events', '{"type":"cube_schema_committed"}');
    assert.equal(await repository.schemaVersion(), 'valkey:hash-2');
  } finally {
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test('factory selects the configured store', () => {
  const staticDir = staticSchemaDir();
  try {
    const fileRepository = createDynamicSchemaRepository({ staticSchemaPath: repoPath(staticDir), store: 'file' });
    assert.ok(fileRepository instanceof DynamicSchemaRepository);

    const valkeyRepositoryInstance = createDynamicSchemaRepository({
      staticSchemaPath: repoPath(staticDir),
      store: 'valkey',
      valkey: { client: new FakeValkey(), keyPrefix: 'cpm:cube-schema' },
    });
    assert.ok(valkeyRepositoryInstance instanceof ValkeySchemaRepository);

    assert.throws(
      () => createDynamicSchemaRepository({ staticSchemaPath: repoPath(staticDir), store: 'redis' }),
      /must be "file" or "valkey"/
    );
  } finally {
    rmSync(staticDir, { recursive: true, force: true });
  }
});
