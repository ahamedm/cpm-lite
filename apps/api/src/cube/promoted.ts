/**
 * Promotion of generated (dynamic) Cube models to reviewed static YAML.
 *
 * Dynamic schema is the fast path; a data engineer periodically promotes stable
 * models into `cube/model/cubes/promoted/` and records them in
 * `cube/model/promoted-models.json`. The generator then stops emitting those
 * models dynamically, and the static YAML becomes the source of truth in Cube.
 *
 * Publishing a newer version of a promoted model fails the refresh with an
 * actionable message instead of silently leaving Cube on the old definition.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CubeSchemaError, type GeneratedCube } from './schema.js';
import type { CubeSchemaStore } from './store.js';

export const PROMOTED_MANIFEST_FORMAT = 'cpm-promoted-models/1';

export interface PromotedModel {
  model_code: string;
  cube_name: string;
  model_version_id: string;
  version_number: number;
  promoted_at: string;
  /** Path relative to `cube/model`, e.g. `cubes/promoted/budget.yml`. */
  file: string;
}

export interface PromotedManifest {
  format: string;
  models: PromotedModel[];
}

export interface PromotableVersion {
  code: string;
  model_version_id: string;
  version_number: number;
  cube_refresh_status: string;
  row_version: number;
  department_code: string;
}

export function emptyPromotedManifest(): PromotedManifest {
  return { format: PROMOTED_MANIFEST_FORMAT, models: [] };
}

export function loadPromotedManifest(filePath: string): PromotedManifest {
  if (!existsSync(filePath)) return emptyPromotedManifest();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Promoted-model manifest ${filePath} is not valid JSON: ${(error as Error).message}`);
  }
  const manifest = parsed as Partial<PromotedManifest>;
  if (!manifest || manifest.format !== PROMOTED_MANIFEST_FORMAT || !Array.isArray(manifest.models)) {
    throw new Error(`Promoted-model manifest ${filePath} must use format ${PROMOTED_MANIFEST_FORMAT}`);
  }
  const models = manifest.models.filter(
    (entry): entry is PromotedModel =>
      Boolean(entry) &&
      typeof entry.model_code === 'string' &&
      typeof entry.cube_name === 'string' &&
      typeof entry.model_version_id === 'string' &&
      typeof entry.version_number === 'number' &&
      typeof entry.promoted_at === 'string' &&
      typeof entry.file === 'string'
  );
  return { format: PROMOTED_MANIFEST_FORMAT, models };
}

export function savePromotedManifest(filePath: string, manifest: PromotedManifest): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
}

export function promotedModelMap(manifest: PromotedManifest): Map<string, PromotedModel> {
  return new Map(manifest.models.map((entry) => [entry.model_code, entry]));
}

/**
 * Removes models whose exact published version is represented by static YAML.
 * A promoted model with a newer published version cannot be served dynamically
 * (the cube name would collide with the static file), so it fails loudly.
 */
export function applyPromotions<T extends PromotableVersion>(
  rows: T[],
  manifest: PromotedManifest
): { rows: T[]; promoted: Array<{ row: T; entry: PromotedModel }> } {
  const promotedByCode = promotedModelMap(manifest);
  const remaining: T[] = [];
  const promoted: Array<{ row: T; entry: PromotedModel }> = [];

  for (const row of rows) {
    const entry = promotedByCode.get(row.code);
    if (!entry) {
      remaining.push(row);
      continue;
    }
    if (entry.model_version_id === row.model_version_id) {
      promoted.push({ row, entry });
      continue;
    }
    throw new CubeSchemaError(
      `Model ${row.code} is promoted to static YAML (version ${entry.version_number}, ${entry.file}); ` +
        `update that file and cube/model/promoted-models.json before publishing version ${row.version_number}`
    );
  }

  return { rows: remaining, promoted };
}

function staticCubeHeader(cube: GeneratedCube, promotedAt: string): string {
  return [
    '# Promoted from the CPM Lite model registry (dynamic schema -> static YAML).',
    `# Model: ${cube.model_code} version ${cube.version_number} (${cube.model_version_id})`,
    `# Promoted at: ${promotedAt}`,
    '# Review and commit this file together with cube/model/promoted-models.json.',
    '# Re-promote after a model change with `make promote-cube-schema`.',
    '',
  ].join('\n');
}

export interface PromoteOptions {
  store: CubeSchemaStore;
  /** Absolute path to `cube/model`. */
  cubeModelDir: string;
  /** Absolute path to `cube/model/promoted-models.json`. */
  manifestPath: string;
  /** Model codes to promote; omit to promote every generated cube. */
  modelCodes?: string[];
  now?: Date;
}

export interface PromoteResult {
  schema_version: string;
  promoted: PromotedModel[];
  remaining: number;
}

/**
 * Writes the selected generated cubes as static YAML, updates the promoted
 * manifest, and commits a dynamic snapshot without them. Run it during a
 * maintenance window (the API worker is single-writer while DuckDB is OLTP).
 */
export async function promoteCubeSchema(options: PromoteOptions): Promise<PromoteResult> {
  const snapshot = await options.store.readSnapshot();
  if (!snapshot) {
    throw new Error('No dynamic schema snapshot is committed; publish or refresh a model first');
  }

  const selected = options.modelCodes?.length
    ? snapshot.cubes.filter((cube) => options.modelCodes?.includes(cube.model_code))
    : snapshot.cubes;
  if (selected.length === 0) {
    throw new Error('No generated cubes matched the promotion selection');
  }
  const missing = (options.modelCodes ?? []).filter(
    (code) => !selected.some((cube) => cube.model_code === code)
  );
  if (missing.length > 0) {
    throw new Error(`No generated cube found for: ${missing.join(', ')}`);
  }

  const manifest = loadPromotedManifest(options.manifestPath);
  const promotedAt = (options.now ?? new Date()).toISOString();
  const promoted: PromotedModel[] = [];

  for (const cube of selected) {
    const relative = path.posix.join('cubes', 'promoted', `${cube.cube_name}.yml`);
    const target = path.join(options.cubeModelDir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, staticCubeHeader(cube, promotedAt) + cube.content, 'utf8');

    const entry: PromotedModel = {
      model_code: cube.model_code,
      cube_name: cube.cube_name,
      model_version_id: cube.model_version_id,
      version_number: cube.version_number,
      promoted_at: promotedAt,
      file: relative,
    };
    const existing = manifest.models.findIndex((model) => model.model_code === entry.model_code);
    if (existing >= 0) manifest.models[existing] = entry;
    else manifest.models.push(entry);
    promoted.push(entry);
  }

  manifest.models.sort((a, b) => a.model_code.localeCompare(b.model_code));
  savePromotedManifest(options.manifestPath, manifest);

  const promotedCodes = new Set(manifest.models.map((entry) => entry.model_code));
  const remaining = snapshot.cubes.filter((cube) => !promotedCodes.has(cube.model_code));
  const commit = await options.store.commit(remaining, options.now ?? new Date());

  return {
    schema_version: commit.schema_version,
    promoted,
    remaining: remaining.length,
  };
}
