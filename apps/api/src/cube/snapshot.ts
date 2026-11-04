/**
 * Immutable, content-addressed Cube schema snapshots.
 *
 * Layout under the shared directory:
 *
 *   current.json                     pointer + manifest (written atomically)
 *   versions/<schema_version>/*.yml  generated cube documents
 *
 * The API commits a snapshot and then verifies it against Cube. If Cube rejects
 * the schema (or cannot be reached), the previous pointer is restored, so a
 * failed refresh never leaves a broken semantic layer in place.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { GeneratedCube } from './schema.js';

export const CUBE_SCHEMA_FORMAT = 'cpm-cube-schema/1';

export interface CubeSchemaManifestEntry {
  model_id: string;
  model_code: string;
  model_name: string;
  department_code: string;
  model_version_id: string;
  version_number: number;
  cube_name: string;
  file_name: string;
  measures: string[];
}

export interface CubeSchemaManifest {
  schema_version: string;
  format: string;
  generated_at: string;
  models: CubeSchemaManifestEntry[];
}

export interface CubeSchemaSnapshot {
  manifest: CubeSchemaManifest;
  previous: string | null;
  version_directory: string;
  schema_version: string;
  changed: boolean;
}

export function schemaVersionFor(cubes: GeneratedCube[]): string {
  const hash = createHash('sha256');
  hash.update(`${CUBE_SCHEMA_FORMAT}\n`);
  for (const cube of [...cubes].sort((a, b) => a.file_name.localeCompare(b.file_name))) {
    hash.update(`${cube.file_name}\n`);
    hash.update(cube.content);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function manifestFor(cubes: GeneratedCube[], schemaVersion: string, generatedAt: Date): CubeSchemaManifest {
  return {
    schema_version: schemaVersion,
    format: CUBE_SCHEMA_FORMAT,
    generated_at: generatedAt.toISOString(),
    models: cubes
      .map((cube) => ({
        model_id: cube.model_id,
        model_code: cube.model_code,
        model_name: cube.model_name,
        department_code: cube.department_code,
        model_version_id: cube.model_version_id,
        version_number: cube.version_number,
        cube_name: cube.cube_name,
        file_name: cube.file_name,
        measures: cube.measures,
      }))
      .sort((a, b) => a.model_code.localeCompare(b.model_code)),
  };
}

function currentPath(schemaDir: string): string {
  return path.join(schemaDir, 'current.json');
}

function writeAtomic(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, target);
}

/**
 * Writes the generated cubes as a new content-addressed version and points
 * `current.json` at it. Returns the previous pointer text so a failed
 * verification can roll back.
 */
export function commitCubeSchemaSnapshot(
  schemaDir: string,
  cubes: GeneratedCube[],
  generatedAt: Date
): CubeSchemaSnapshot {
  const schemaVersion = schemaVersionFor(cubes);
  const versionDirectory = path.join(schemaDir, 'versions', schemaVersion);
  mkdirSync(versionDirectory, { recursive: true });
  for (const cube of cubes) {
    writeFileSync(path.join(versionDirectory, cube.file_name), cube.content, 'utf8');
  }

  const pointer = currentPath(schemaDir);
  const previous = existsSync(pointer) ? readFileSync(pointer, 'utf8') : null;
  const manifest = manifestFor(cubes, schemaVersion, generatedAt);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const changed = previous === null || previous !== serialized;
  writeAtomic(pointer, serialized);

  return { manifest, previous, version_directory: versionDirectory, schema_version: schemaVersion, changed };
}

/** Reads the committed snapshot back into Cube documents (used by promotion). */
export function readCubeSchemaSnapshot(
  schemaDir: string
): { schema_version: string; cubes: GeneratedCube[] } | null {
  const pointer = currentPath(schemaDir);
  if (!existsSync(pointer)) return null;

  let manifest: CubeSchemaManifest;
  try {
    manifest = JSON.parse(readFileSync(pointer, 'utf8')) as CubeSchemaManifest;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest.schema_version !== 'string' || !Array.isArray(manifest.models)) {
    return null;
  }

  const cubes: GeneratedCube[] = [];
  for (const entry of manifest.models) {
    const fileName = path.basename(entry.file_name);
    const filePath = path.join(schemaDir, 'versions', manifest.schema_version, fileName);
    if (!existsSync(filePath)) continue;
    cubes.push({
      model_id: entry.model_id,
      model_code: entry.model_code,
      model_name: entry.model_name ?? entry.model_code,
      department_code: entry.department_code ?? '',
      model_version_id: entry.model_version_id,
      version_number: entry.version_number,
      cube_name: entry.cube_name,
      file_name: entry.file_name,
      content: readFileSync(filePath, 'utf8'),
      measures: Array.isArray(entry.measures) ? entry.measures : [],
    });
  }

  return { schema_version: manifest.schema_version, cubes };
}

/** Restores the pointer observed before the last commit (or removes it). */
export function rollbackCubeSchemaSnapshot(schemaDir: string, previous: string | null): void {
  const pointer = currentPath(schemaDir);
  if (previous === null) {
    rmSync(pointer, { force: true });
    return;
  }
  writeAtomic(pointer, previous);
}

/** Removes the directory written by a commit that was rolled back. */
export function discardCubeSchemaVersion(versionDirectory: string): void {
  rmSync(versionDirectory, { recursive: true, force: true });
}

/** Reads the schema version out of a serialized `current.json` pointer. */
export function schemaVersionFromPointer(pointer: string | null): string | null {
  if (!pointer) return null;
  try {
    const parsed = JSON.parse(pointer) as { schema_version?: unknown };
    return typeof parsed.schema_version === 'string' ? parsed.schema_version : null;
  } catch {
    return null;
  }
}

/** Keeps only the given schema versions; older directories are removed. */
export function pruneCubeSchemaVersions(schemaDir: string, keep: string[]): void {
  const versionsDir = path.join(schemaDir, 'versions');
  if (!existsSync(versionsDir)) return;
  const keepSet = new Set(keep);
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keepSet.has(entry.name)) continue;
    rmSync(path.join(versionsDir, entry.name), { recursive: true, force: true });
  }
}
