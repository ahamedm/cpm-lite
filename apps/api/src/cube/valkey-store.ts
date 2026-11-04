/**
 * Valkey-backed snapshot store.
 *
 * Key layout (prefix defaults to `cpm:cube-schema`):
 *
 *   <prefix>:current                       manifest JSON (atomic pointer)
 *   <prefix>:versions                      set of committed schema versions
 *   <prefix>:versions:<hash>:<model>.yml   generated cube YAML
 *
 * Files are written first and the pointer last, so a reader never sees a
 * half-published schema. `rollback` restores the previous pointer and drops the
 * version keys; `prune` keeps only the versions referenced by the current and
 * previous snapshots.
 *
 * Cube reads the same layout through `cube/model/dynamic-repository.cjs`.
 */

import { Redis } from 'ioredis';
import type { GeneratedCube } from './schema.js';
import {
  manifestFor,
  schemaVersionFor,
  schemaVersionFromPointer,
  type CubeSchemaManifest,
} from './snapshot.js';
import type { CubeSchemaCommit, CubeSchemaStore } from './store.js';

export interface ValkeyPipelineLike {
  set(key: string, value: string, ...args: Array<string | number>): ValkeyPipelineLike;
  expire(key: string, seconds: number): ValkeyPipelineLike;
  del(...keys: string[]): ValkeyPipelineLike;
  sadd(key: string, member: string): ValkeyPipelineLike;
  exec(): Promise<unknown>;
}

/** The subset of the client the store needs; injectable for tests. */
export interface ValkeyClientLike {
  /** ioredis connection state, used to avoid connecting just to close. */
  readonly status?: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
  publish(channel: string, message: string): Promise<unknown>;
  pipeline(): ValkeyPipelineLike;
  quit(): Promise<unknown>;
  disconnect?(): void;
}

export class ValkeyCubeSchemaStore implements CubeSchemaStore {
  readonly kind = 'valkey' as const;

  constructor(
    private readonly client: ValkeyClientLike,
    private readonly keyPrefix: string,
    private readonly ttlSeconds: number,
    private readonly eventChannel: string = `${keyPrefix}:events`,
    private readonly onError?: (message: string) => void
  ) {}

  private pointerKey(): string {
    return `${this.keyPrefix}:current`;
  }

  private indexKey(): string {
    return `${this.keyPrefix}:versions`;
  }

  private fileKey(schemaVersion: string, fileName: string): string {
    return `${this.keyPrefix}:versions:${schemaVersion}:${fileName}`;
  }

  /**
   * Notifies Cube replicas that the pointer changed. Pub/Sub is fire-and-forget;
   * a missed message is repaired by Cube's short pointer poll.
   */
  private async publishEvent(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.client.publish(this.eventChannel, JSON.stringify(payload));
    } catch (error) {
      this.onError?.(`Valkey schema event publish failed: ${(error as Error).message}`);
    }
  }

  async commit(cubes: GeneratedCube[], generatedAt: Date): Promise<CubeSchemaCommit> {
    const schemaVersion = schemaVersionFor(cubes);
    const pipeline = this.client.pipeline();
    for (const cube of cubes) {
      const key = this.fileKey(schemaVersion, cube.file_name);
      pipeline.set(key, cube.content);
      if (this.ttlSeconds > 0) pipeline.expire(key, this.ttlSeconds);
    }
    pipeline.sadd(this.indexKey(), schemaVersion);
    await pipeline.exec();

    const previous = await this.client.get(this.pointerKey());
    const manifest = manifestFor(cubes, schemaVersion, generatedAt);
    const serialized = JSON.stringify(manifest);
    const changed = previous !== serialized;
    await this.client.set(this.pointerKey(), serialized);
    await this.publishEvent({
      type: 'cube_schema_committed',
      schema_version: schemaVersion,
      generated_at: manifest.generated_at,
    });

    return { manifest, schema_version: schemaVersion, previous, changed };
  }

  async rollback(commit: CubeSchemaCommit): Promise<void> {
    if (commit.previous === null) {
      await this.client.del(this.pointerKey());
    } else {
      await this.client.set(this.pointerKey(), commit.previous);
    }
    const previousVersion = schemaVersionFromPointer(commit.previous);
    if (previousVersion !== commit.schema_version) {
      await this.deleteVersion(commit.schema_version);
    }
    await this.publishEvent({
      type: 'cube_schema_rolled_back',
      schema_version: previousVersion,
    });
  }

  async readSnapshot(): Promise<{ schema_version: string; cubes: GeneratedCube[] } | null> {
    const raw = await this.client.get(this.pointerKey());
    if (!raw) return null;

    let manifest: CubeSchemaManifest;
    try {
      manifest = JSON.parse(raw) as CubeSchemaManifest;
    } catch {
      return null;
    }
    if (!manifest || typeof manifest.schema_version !== 'string' || !Array.isArray(manifest.models)) {
      return null;
    }

    const entries = manifest.models.filter(
      (entry) => entry && typeof entry.file_name === 'string' && typeof entry.cube_name === 'string'
    );
    const keys = entries.map(
      (entry) => this.fileKey(manifest.schema_version, entry.file_name)
    );
    const values = keys.length > 0 ? await this.client.mget(...keys) : [];

    const cubes: GeneratedCube[] = [];
    entries.forEach((entry, index) => {
      const content = values[index];
      if (typeof content !== 'string') return;
      cubes.push({
        model_id: entry.model_id,
        model_code: entry.model_code,
        model_name: entry.model_name ?? entry.model_code,
        department_code: entry.department_code ?? '',
        model_version_id: entry.model_version_id,
        version_number: entry.version_number,
        cube_name: entry.cube_name,
        file_name: entry.file_name,
        content,
        measures: Array.isArray(entry.measures) ? entry.measures : [],
      });
    });

    return { schema_version: manifest.schema_version, cubes };
  }

  async prune(keep: string[]): Promise<void> {
    const versions = await this.client.smembers(this.indexKey());
    for (const version of versions) {
      if (!keep.includes(version)) await this.deleteVersion(version);
    }
  }

  private async deleteVersion(schemaVersion: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        'MATCH',
        this.fileKey(schemaVersion, '*'),
        'COUNT',
        200
      );
      cursor = next;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
    await this.client.srem(this.indexKey(), schemaVersion);
  }

  async close(): Promise<void> {
    // A lazy client that never connected must not connect just to disconnect.
    if (this.client.status && this.client.status !== 'ready') {
      this.client.disconnect?.();
      return;
    }
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect?.();
    }
  }
}

export function createValkeyCubeSchemaStore(options: {
  url: string;
  keyPrefix: string;
  ttlSeconds: number;
  client?: ValkeyClientLike;
  onError?: (message: string) => void;
}): ValkeyCubeSchemaStore {
  let client = options.client;
  if (!client) {
    const redis = new Redis(options.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 2_000,
      commandTimeout: 2_500,
      enableReadyCheck: true,
    });
    attachErrorHandler(redis, options.onError);
    client = redis as unknown as ValkeyClientLike;
  }
  return new ValkeyCubeSchemaStore(
    client,
    options.keyPrefix,
    options.ttlSeconds,
    `${options.keyPrefix}:events`,
    options.onError
  );
}

function attachErrorHandler(redis: Redis, onError?: (message: string) => void): void {
  let lastReportedAt = 0;
  redis.on('error', (error: Error) => {
    const now = Date.now();
    if (now - lastReportedAt < 10_000) return;
    lastReportedAt = now;
    onError?.(`Valkey connection error: ${error.message}`);
  });
}
