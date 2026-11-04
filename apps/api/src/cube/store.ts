/**
 * Snapshot stores for the dynamic Cube schema.
 *
 * Two interchangeable transports sit behind the same interface:
 * - `file`   — the local, default content-addressed directory (single host).
 * - `valkey` — versioned keys plus an atomic pointer, for multi-pod deployments.
 *
 * The generator, verification, rollback and status machine do not care which
 * store is configured.
 */

import type { AppConfig } from '../config.js';
import type { GeneratedCube } from './schema.js';
import {
  commitCubeSchemaSnapshot,
  discardCubeSchemaVersion,
  pruneCubeSchemaVersions,
  readCubeSchemaSnapshot,
  rollbackCubeSchemaSnapshot,
  schemaVersionFromPointer,
  type CubeSchemaManifest,
} from './snapshot.js';

export interface CubeSchemaCommit {
  manifest: CubeSchemaManifest;
  schema_version: string;
  /** Serialized pointer observed before the commit, for rollback. */
  previous: string | null;
  changed: boolean;
  /** File store only: the generated version directory. */
  version_directory?: string;
}

export interface CubeSchemaStore {
  readonly kind: 'file' | 'valkey';
  commit(cubes: GeneratedCube[], generatedAt: Date): Promise<CubeSchemaCommit>;
  rollback(commit: CubeSchemaCommit): Promise<void>;
  prune(keep: string[]): Promise<void>;
  /** Current committed snapshot; used by promotion and diagnostics. */
  readSnapshot(): Promise<{ schema_version: string; cubes: GeneratedCube[] } | null>;
  close(): Promise<void>;
}

export class FileCubeSchemaStore implements CubeSchemaStore {
  readonly kind = 'file' as const;

  constructor(private readonly schemaDir: string) {}

  async commit(cubes: GeneratedCube[], generatedAt: Date): Promise<CubeSchemaCommit> {
    const snapshot = commitCubeSchemaSnapshot(this.schemaDir, cubes, generatedAt);
    return {
      manifest: snapshot.manifest,
      schema_version: snapshot.schema_version,
      previous: snapshot.previous,
      changed: snapshot.changed,
      version_directory: snapshot.version_directory,
    };
  }

  async rollback(commit: CubeSchemaCommit): Promise<void> {
    rollbackCubeSchemaSnapshot(this.schemaDir, commit.previous);
    const previousVersion = schemaVersionFromPointer(commit.previous);
    if (previousVersion !== commit.schema_version && commit.version_directory) {
      discardCubeSchemaVersion(commit.version_directory);
    }
  }

  async prune(keep: string[]): Promise<void> {
    pruneCubeSchemaVersions(this.schemaDir, keep);
  }

  async readSnapshot(): Promise<{ schema_version: string; cubes: GeneratedCube[] } | null> {
    return readCubeSchemaSnapshot(this.schemaDir);
  }

  async close(): Promise<void> {
    // Nothing to release for the file store.
  }
}

/**
 * Builds the configured store. Kept async because the Valkey client is loaded
 * lazily: file-only deployments never load `ioredis`.
 */
export async function createCubeSchemaStore(
  config: Pick<
    AppConfig,
    'cubeSchemaStore' | 'cubeSchemaDir' | 'valkeyUrl' | 'valkeyKeyPrefix' | 'valkeySchemaTtlSeconds'
  >,
  onError?: (message: string) => void
): Promise<CubeSchemaStore> {
  if (config.cubeSchemaStore === 'valkey') {
    if (!config.valkeyUrl) {
      throw new Error('CPM_VALKEY_URL is required when CPM_CUBE_SCHEMA_STORE=valkey');
    }
    const { createValkeyCubeSchemaStore } = await import('./valkey-store.js');
    return createValkeyCubeSchemaStore({
      url: config.valkeyUrl,
      keyPrefix: config.valkeyKeyPrefix,
      ttlSeconds: config.valkeySchemaTtlSeconds,
      onError,
    });
  }
  return new FileCubeSchemaStore(config.cubeSchemaDir);
}
