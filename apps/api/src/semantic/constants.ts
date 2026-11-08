import type {
  SemanticAggregation,
  SemanticDataType,
  SemanticFormat,
} from './types.js';

export const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
export const SOURCE_ID = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

export const SEMANTIC_DATATYPES: ReadonlySet<string> = new Set([
  'string',
  'integer',
  'decimal',
  'date',
  'boolean',
] satisfies SemanticDataType[]);

export const SEMANTIC_AGGREGATIONS: ReadonlySet<string> = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_distinct',
] satisfies SemanticAggregation[]);

export const SEMANTIC_FORMATS: ReadonlySet<string> = new Set([
  'currency',
  'percent',
  'number',
] satisfies SemanticFormat[]);

export const SEMANTIC_CARDINALITIES: ReadonlySet<string> = new Set([
  'many_to_one',
  'one_to_many',
  'one_to_one',
]);

export function isSemanticDataType(value: string): value is SemanticDataType {
  return SEMANTIC_DATATYPES.has(value);
}

export function isSemanticAggregation(value: string): value is SemanticAggregation {
  return SEMANTIC_AGGREGATIONS.has(value);
}

export function isSemanticFormat(value: string): value is SemanticFormat {
  return SEMANTIC_FORMATS.has(value);
}
