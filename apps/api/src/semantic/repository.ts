/**
 * Persistence for the canonical semantic model (ADR 0008).
 *
 * Normalized child rows are keyed by immutable `model_version_id`. The legacy
 * `model_version.definition` document is written alongside them for the public
 * API contract, but compilers read this representation first.
 */

import type { Kysely, Transaction } from 'kysely';
import { safeJson } from '../http.js';
import type { Database } from '../schema.js';
import { semanticModelHash } from './canonical.js';
import { semanticModelFromDefinition } from './from-definition.js';
import {
  SEMANTIC_MODEL_FORMAT,
  SEMANTIC_SCHEMA_VERSION,
  type SemanticAggregation,
  type SemanticCardinality,
  type SemanticDataType,
  type SemanticExpression,
  type SemanticFormat,
  type SemanticModel,
} from './types.js';

export type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function parseExpression(value: string | null): SemanticExpression | null {
  if (!value) return null;
  const parsed = safeJson<{ kind?: string; column?: string } | null>(value, null);
  if (!parsed || parsed.kind !== 'column' || typeof parsed.column !== 'string') return null;
  return { kind: 'column', column: parsed.column };
}

/**
 * Replaces the normalized rows for a version. Callers own the transaction and
 * the `model_version` metadata update. Returns the canonical hash.
 */
export async function writeSemanticModel(
  executor: DatabaseExecutor,
  modelVersionId: string,
  model: SemanticModel
): Promise<string> {
  await executor.deleteFrom('semantic_access_policy').where('model_version_id', '=', modelVersionId).execute();
  await executor.deleteFrom('semantic_relationship').where('model_version_id', '=', modelVersionId).execute();
  await executor.deleteFrom('semantic_metric').where('model_version_id', '=', modelVersionId).execute();
  await executor.deleteFrom('semantic_field').where('model_version_id', '=', modelVersionId).execute();
  await executor.deleteFrom('semantic_dataset').where('model_version_id', '=', modelVersionId).execute();

  if (model.datasets.length > 0) {
    await executor
      .insertInto('semantic_dataset')
      .values(
        model.datasets.map((dataset, index) => ({
          model_version_id: modelVersionId,
          dataset_code: dataset.name,
          source_id: dataset.source,
          primary_key: JSON.stringify(dataset.primary_key),
          ordinal: index,
        }))
      )
      .execute();
  }

  const fields = model.datasets.flatMap((dataset) =>
    dataset.fields.map((field, index) => ({
      model_version_id: modelVersionId,
      dataset_code: dataset.name,
      field_code: field.name,
      label: field.label,
      datatype: field.datatype,
      expression: JSON.stringify(field.expression),
      is_time: field.is_time,
      description: field.description,
      ordinal: index,
    }))
  );
  if (fields.length > 0) {
    await executor.insertInto('semantic_field').values(fields).execute();
  }

  if (model.metrics.length > 0) {
    await executor
      .insertInto('semantic_metric')
      .values(
        model.metrics.map((metric, index) => ({
          model_version_id: modelVersionId,
          metric_code: metric.name,
          label: metric.label,
          dataset_code: metric.dataset,
          aggregation: metric.aggregation,
          expression: metric.expression ? JSON.stringify(metric.expression) : null,
          format: metric.format,
          currency_code: metric.currency_code,
          description: metric.description,
          ordinal: index,
        }))
      )
      .execute();
  }

  if (model.relationships.length > 0) {
    await executor
      .insertInto('semantic_relationship')
      .values(
        model.relationships.map((relationship, index) => ({
          model_version_id: modelVersionId,
          relationship_code: relationship.name,
          cardinality: relationship.cardinality,
          source_dataset: relationship.source_dataset,
          source_fields: JSON.stringify(relationship.source_fields),
          target_dataset: relationship.target_dataset,
          target_fields: JSON.stringify(relationship.target_fields),
          pinned_model_version_id: relationship.pinned_model_version_id,
          description: null,
          ordinal: index,
        }))
      )
      .execute();
  }

  await executor
    .insertInto('semantic_access_policy')
    .values({
      model_version_id: modelVersionId,
      policy_code: 'default',
      row_level_field: model.access.row_level_field,
    })
    .execute();

  return semanticModelHash(model);
}

/** Rebuilds the canonical model from normalized rows, or null when not migrated. */
export async function loadSemanticModel(
  db: Kysely<Database>,
  modelVersionId: string
): Promise<SemanticModel | null> {
  const version = await db
    .selectFrom('model_version as mv')
    .innerJoin('model as m', 'm.model_id', 'mv.model_id')
    .select([
      'mv.semantic_schema_version',
      'm.code',
      'm.name',
      'm.description',
      'm.department_code',
    ])
    .where('mv.model_version_id', '=', modelVersionId)
    .executeTakeFirst();
  if (!version) return null;

  const datasetRows = await db
    .selectFrom('semantic_dataset')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .orderBy('ordinal', 'asc')
    .execute();
  if (datasetRows.length === 0) return null;

  const fieldRows = await db
    .selectFrom('semantic_field')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .orderBy('ordinal', 'asc')
    .execute();
  const metricRows = await db
    .selectFrom('semantic_metric')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .orderBy('ordinal', 'asc')
    .execute();
  const relationshipRows = await db
    .selectFrom('semantic_relationship')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .orderBy('ordinal', 'asc')
    .execute();
  const accessRow = await db
    .selectFrom('semantic_access_policy')
    .selectAll()
    .where('model_version_id', '=', modelVersionId)
    .orderBy('policy_code', 'asc')
    .executeTakeFirst();

  const fieldsByDataset = new Map<string, typeof fieldRows>();
  for (const field of fieldRows) {
    const bucket = fieldsByDataset.get(field.dataset_code) ?? [];
    bucket.push(field);
    fieldsByDataset.set(field.dataset_code, bucket);
  }

  return {
    format: SEMANTIC_MODEL_FORMAT,
    schema_version: SEMANTIC_SCHEMA_VERSION,
    name: version.code,
    label: version.name,
    description: version.description,
    datasets: datasetRows.map((dataset) => ({
      name: dataset.dataset_code,
      source: dataset.source_id,
      primary_key: safeJson<string[]>(dataset.primary_key, []),
      fields: (fieldsByDataset.get(dataset.dataset_code) ?? []).map((field) => ({
        name: field.field_code,
        label: field.label,
        datatype: field.datatype as SemanticDataType,
        expression: parseExpression(field.expression) ?? { kind: 'column', column: '' },
        is_time: field.is_time,
        description: field.description,
      })),
    })),
    metrics: metricRows.map((metric) => ({
      name: metric.metric_code,
      label: metric.label,
      dataset: metric.dataset_code,
      aggregation: metric.aggregation as SemanticAggregation,
      expression: parseExpression(metric.expression),
      format: metric.format as SemanticFormat,
      currency_code: metric.currency_code,
      description: metric.description,
    })),
    relationships: relationshipRows.map((relationship) => ({
      name: relationship.relationship_code,
      cardinality: relationship.cardinality as SemanticCardinality,
      source_dataset: relationship.source_dataset,
      source_fields: safeJson<string[]>(relationship.source_fields, []),
      target_dataset: relationship.target_dataset,
      target_fields: safeJson<string[]>(relationship.target_fields, []),
      pinned_model_version_id: relationship.pinned_model_version_id,
    })),
    access: {
      row_level_field: accessRow?.row_level_field ?? 'department_code',
    },
    extensions: { cpm: { department_code: version.department_code } },
  };
}

export interface BackfillResult {
  scanned: number;
  written: number;
  skipped: number;
  invalid: number;
}

/**
 * Migrates legacy `definition` JSON into normalized rows. Idempotent: versions
 * that already have dataset rows are skipped. Invalid JSON is reported, not
 * overwritten.
 */
export async function backfillSemanticModels(
  db: Kysely<Database>,
  options: { dryRun?: boolean } = {}
): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, written: 0, skipped: 0, invalid: 0 };

  const rows = await db
    .selectFrom('model_version as mv')
    .innerJoin('model as m', 'm.model_id', 'mv.model_id')
    .select([
      'mv.model_version_id',
      'mv.definition',
      'm.code',
      'm.name',
      'm.description',
      'm.department_code',
    ])
    .execute();
  const migrated = new Set(
    (
      await db.selectFrom('semantic_dataset').select('model_version_id').execute()
    ).map((row) => row.model_version_id)
  );

  for (const row of rows) {
    result.scanned += 1;
    if (migrated.has(row.model_version_id)) {
      result.skipped += 1;
      continue;
    }

    let definition: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.definition) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      definition = parsed as Record<string, unknown>;
    } catch {
      result.invalid += 1;
      continue;
    }

    const semantic = semanticModelFromDefinition(definition, {
      code: row.code,
      name: row.name,
      description: row.description,
      departmentCode: row.department_code,
    });

    if (!options.dryRun) {
      await db.transaction().execute(async (trx) => {
        const hash = await writeSemanticModel(trx, row.model_version_id, semantic);
        await trx
          .updateTable('model_version')
          .set({ semantic_schema_version: SEMANTIC_SCHEMA_VERSION, semantic_hash: hash })
          .where('model_version_id', '=', row.model_version_id)
          .execute();
      });
    }
    result.written += 1;
  }

  return result;
}
