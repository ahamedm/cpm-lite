/**
 * Converts the legacy `ModelDefinition` document into the canonical neutral
 * model. This is the only place that knows the old JSON shape.
 */

import type { JsonObject, ModelDefinition } from '../contracts.js';
import {
  DEFAULT_SOURCE_ID,
  SEMANTIC_MODEL_FORMAT,
  SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_SCHEMA_VERSION_MULTI_DATASET,
  type SemanticAggregation,
  type SemanticCardinality,
  type SemanticDataType,
  type SemanticDataset,
  type SemanticField,
  type SemanticFormat,
  type SemanticMetric,
  type SemanticModel,
  type SemanticRelationship,
  type SemanticSchemaVersion,
} from './types.js';

export interface LegacyModelDefinition {
  schema_version?: string;
  source?: { source_id?: string };
  access?: { row_level_field?: string };
  dimensions?: JsonObject[];
  measures?: JsonObject[];
  joins?: JsonObject[];
  [key: string]: unknown;
}

export interface SemanticIdentity {
  /** Model code, used as the canonical model name. */
  code: string;
  /** Business label. */
  name: string;
  description?: string | null;
  departmentCode?: string | null;
  /** Source used when a legacy definition predates the source block. */
  defaultSourceId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? (value as JsonObject[]) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Derives an identifier-safe dataset name from a source or model code. */
export function datasetNameFromSource(source: string): string {
  const tail = source.split('.').pop() ?? source;
  const normalized = tail
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return 'dataset';
  return /^[a-z_]/.test(normalized) ? normalized : `d_${normalized}`;
}

/** Resolves the access member by member code first, then by source expression. */
function resolveAccessField(dimensions: JsonObject[], requested: string): string {
  const byCode = dimensions.find((dimension) => text(dimension.code) === requested);
  if (byCode) return text(byCode.code, requested);
  const byExpression = dimensions.find((dimension) => text(dimension.expression) === requested);
  if (byExpression) return text(byExpression.code, requested);
  return requested;
}

function fieldFromDimension(dimension: JsonObject): SemanticField {
  const code = text(dimension.code);
  const dataType = text(dimension.data_type, 'string') as SemanticDataType;
  return {
    name: code,
    label: text(dimension.name, code),
    datatype: dataType,
    expression: { kind: 'column', column: text(dimension.expression) },
    is_time: dataType === 'date',
    description: text(dimension.description) || null,
  };
}

function metricFromMeasure(measure: JsonObject, dataset: string): SemanticMetric {
  const code = text(measure.code);
  const aggregation = text(measure.aggregation, 'sum') as SemanticAggregation;
  const format = text(measure.format, 'number') as SemanticFormat;
  const operand = text(measure.expression);
  return {
    name: code,
    label: text(measure.name, code),
    dataset,
    aggregation,
    // Cube already ignores operand SQL for count; the neutral model says so.
    expression:
      aggregation === 'count' || operand.length === 0
        ? null
        : { kind: 'column', column: operand },
    format,
    currency_code: text(measure.currency_code) || null,
    description: text(measure.description) || null,
  };
}

function relationshipFromJoin(join: JsonObject, factDataset: string): SemanticRelationship {
  const sourceMember = text(join.source_member_code);
  const targetMember = text(join.target_member_code);
  const pinned =
    typeof join.target_model_version_id === 'string' && join.target_model_version_id.length > 0
      ? join.target_model_version_id
      : null;
  const on = asArray(join.on);
  const sourceFields = on.length
    ? on.map((pair) => text(pair.source_member)).filter(Boolean)
    : sourceMember
      ? [sourceMember]
      : [];
  const targetFields = on.length
    ? on.map((pair) => text(pair.target_member)).filter(Boolean)
    : targetMember
      ? [targetMember]
      : [];
  const targetDataset = text(join.target_dataset)
    || datasetNameFromSource(text(join.target_model_code));
  return {
    name: text(join.name, 'relationship'),
    cardinality: text(join.relationship, 'many_to_one') as SemanticCardinality,
    source_dataset: text(join.source_dataset, factDataset),
    source_fields: sourceFields,
    target_dataset: targetDataset,
    target_fields: targetFields,
    pinned_model_version_id: pinned,
  };
}

function datasetFromDefinition(dataset: JsonObject, index: number): SemanticDataset {
  const source = text(dataset.source);
  return {
    name: text(dataset.name, `reference_${index + 1}`),
    source,
    primary_key: Array.isArray(dataset.primary_key)
      ? dataset.primary_key.filter((value): value is string => typeof value === 'string')
      : [],
    fields: asArray(dataset.fields).map(fieldFromDimension),
  };
}

/**
 * Builds the canonical model from a legacy definition. Deliberately tolerant:
 * validation is a separate step so draft versions can be stored and then
 * corrected, matching the existing API behaviour.
 *
 * The principal dataset remains `source` + `dimensions` + `measures` for 1.0
 * compatibility. `datasets` adds reference datasets for 1.1; a top-level
 * dimension may name a reference dataset with `dataset` to expose a joined
 * field without repeating the reference dataset's whole field list.
 */
export function semanticModelFromDefinition(
  definition: LegacyModelDefinition | ModelDefinition,
  identity: SemanticIdentity
): SemanticModel {
  const dimensions = asArray(definition.dimensions);
  const measures = asArray(definition.measures);
  const joins = asArray(definition.joins);
  const referenceDatasets = asArray(definition.datasets);

  const declaredSource = asRecord(definition.source).source_id;
  const sourceId =
    typeof declaredSource === 'string' && declaredSource.length > 0
      ? declaredSource
      : identity.defaultSourceId ?? DEFAULT_SOURCE_ID;
  const factDataset = datasetNameFromSource(sourceId);

  const datasetFields = new Map<string, Map<string, SemanticField>>();
  const datasetOrder: string[] = [factDataset];
  const datasetSources = new Map<string, string>([[factDataset, sourceId]]);
  const datasetPrimaryKeys = new Map<string, string[]>([
    [
      factDataset,
      Array.isArray(definition.grain)
        ? definition.grain.filter((value): value is string => typeof value === 'string')
        : [],
    ],
  ]);

  datasetFields.set(factDataset, new Map());
  for (const dataset of referenceDatasets) {
    const parsed = datasetFromDefinition(dataset, datasetOrder.length - 1);
    datasetOrder.push(parsed.name);
    datasetSources.set(parsed.name, parsed.source);
    datasetPrimaryKeys.set(parsed.name, parsed.primary_key);
    datasetFields.set(parsed.name, new Map(parsed.fields.map((field) => [field.name, field])));
  }

  const factDimensions: JsonObject[] = [];
  for (const dimension of dimensions) {
    const owner = text(dimension.dataset, factDataset);
    const fields = datasetFields.get(owner);
    if (fields) {
      fields.set(text(dimension.code), fieldFromDimension(dimension));
      if (owner === factDataset) factDimensions.push(dimension);
    } else {
      // Unknown datasets stay on the principal dataset; validation reports the
      // dangling reference against the raw definition.
      factDimensions.push(dimension);
      datasetFields.get(factDataset)!.set(text(dimension.code), fieldFromDimension(dimension));
    }
  }

  const requestedAccess = text(asRecord(definition.access).row_level_field, 'department_code');
  const accessField = resolveAccessField(factDimensions, requestedAccess);

  const datasets: SemanticDataset[] = datasetOrder.map((name) => ({
    name,
    source: datasetSources.get(name) ?? '',
    primary_key: datasetPrimaryKeys.get(name) ?? [],
    fields: [...(datasetFields.get(name)?.values() ?? [])],
  }));

  const metricDataset = new Set(datasetOrder);

  return {
    format: SEMANTIC_MODEL_FORMAT,
    schema_version: (referenceDatasets.length > 0 || definition.schema_version === '1.1'
      ? SEMANTIC_SCHEMA_VERSION_MULTI_DATASET
      : SEMANTIC_SCHEMA_VERSION) as SemanticSchemaVersion,
    name: identity.code,
    label: identity.name,
    description: identity.description ?? null,
    datasets,
    metrics: measures.map((measure) => {
      const requested = text(measure.dataset, factDataset);
      return metricFromMeasure(measure, metricDataset.has(requested) ? requested : factDataset);
    }),
    relationships: joins.map((join) => relationshipFromJoin(join, factDataset)),
    access: { row_level_field: accessField },
    extensions: { cpm: { department_code: identity.departmentCode ?? null } },
  };
}
