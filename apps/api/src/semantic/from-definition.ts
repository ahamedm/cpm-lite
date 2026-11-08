/**
 * Converts the legacy `ModelDefinition` document into the canonical neutral
 * model. This is the only place that knows the old JSON shape.
 */

import type { JsonObject, ModelDefinition } from '../contracts.js';
import {
  DEFAULT_SOURCE_ID,
  SEMANTIC_MODEL_FORMAT,
  SEMANTIC_SCHEMA_VERSION,
  type SemanticAggregation,
  type SemanticCardinality,
  type SemanticDataType,
  type SemanticField,
  type SemanticFormat,
  type SemanticMetric,
  type SemanticModel,
  type SemanticRelationship,
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

function relationshipFromJoin(join: JsonObject): SemanticRelationship {
  const sourceMember = text(join.source_member_code);
  const targetMember = text(join.target_member_code);
  const pinned =
    typeof join.target_model_version_id === 'string' && join.target_model_version_id.length > 0
      ? join.target_model_version_id
      : null;
  return {
    name: text(join.name, 'relationship'),
    cardinality: text(join.relationship, 'many_to_one') as SemanticCardinality,
    source_dataset: datasetNameFromSource(text(join.source_model_code)),
    source_fields: sourceMember ? [sourceMember] : [],
    target_dataset: datasetNameFromSource(text(join.target_model_code)),
    target_fields: targetMember ? [targetMember] : [],
    pinned_model_version_id: pinned,
  };
}

/**
 * Builds the canonical model from a legacy definition. Deliberately tolerant:
 * validation is a separate step so draft versions can be stored and then
 * corrected, matching the existing API behaviour.
 */
export function semanticModelFromDefinition(
  definition: LegacyModelDefinition | ModelDefinition,
  identity: SemanticIdentity
): SemanticModel {
  const dimensions = asArray(definition.dimensions);
  const measures = asArray(definition.measures);
  const joins = asArray(definition.joins);

  const declaredSource = asRecord(definition.source).source_id;
  const sourceId =
    typeof declaredSource === 'string' && declaredSource.length > 0
      ? declaredSource
      : identity.defaultSourceId ?? DEFAULT_SOURCE_ID;
  const datasetName = datasetNameFromSource(sourceId);

  const requestedAccess = text(asRecord(definition.access).row_level_field, 'department_code');
  const accessField = resolveAccessField(dimensions, requestedAccess);

  return {
    format: SEMANTIC_MODEL_FORMAT,
    schema_version: SEMANTIC_SCHEMA_VERSION,
    name: identity.code,
    label: identity.name,
    description: identity.description ?? null,
    datasets: [
      {
        name: datasetName,
        source: sourceId,
        primary_key: [],
        fields: dimensions.map(fieldFromDimension),
      },
    ],
    metrics: measures.map((measure) => metricFromMeasure(measure, datasetName)),
    relationships: joins.map(relationshipFromJoin),
    access: { row_level_field: accessField },
    extensions: { cpm: { department_code: identity.departmentCode ?? null } },
  };
}
