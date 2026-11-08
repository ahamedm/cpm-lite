/**
 * Canonical, vendor-neutral semantic model.
 *
 * This is the representation the registry owns. Cube YAML, DuckDB SQL and an
 * Ossie document are compilations of it, never the source of truth.
 *
 * The vocabulary deliberately borrows from Apache Ossie (datasets, fields,
 * metrics, relationships, typed expressions) without adopting its draft
 * schema. CPM governance lives in `access` and `extensions.cpm` because Ossie
 * has no row-level access model yet. See ADR 0008.
 */

export const SEMANTIC_MODEL_FORMAT = 'cpm-semantic-model/1';
export const SEMANTIC_SCHEMA_VERSION = '1.0';
export const DEFAULT_SOURCE_ID = 'gold.fact_financials';

export type SemanticDataType = 'string' | 'integer' | 'decimal' | 'date' | 'boolean';
export type SemanticAggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';
export type SemanticFormat = 'currency' | 'percent' | 'number';
export type SemanticCardinality = 'many_to_one' | 'one_to_many' | 'one_to_one';

/**
 * v1 only represents a governed source column. ADR 0007 extends this union
 * with arithmetic/conditional nodes; every target lowers the same tree.
 */
export interface SemanticColumnExpression {
  kind: 'column';
  column: string;
}

export type SemanticExpression = SemanticColumnExpression;

export interface SemanticField {
  /** Member code exposed by the model. */
  name: string;
  /** Business label. */
  label: string;
  datatype: SemanticDataType;
  expression: SemanticExpression;
  is_time: boolean;
  description: string | null;
}

export interface SemanticDataset {
  name: string;
  /** Schema-qualified governed source, e.g. `gold.fact_financials`. */
  source: string;
  primary_key: string[];
  fields: SemanticField[];
}

export interface SemanticMetric {
  name: string;
  label: string;
  /** Dataset that owns the metric's expression. */
  dataset: string;
  aggregation: SemanticAggregation;
  expression: SemanticExpression | null;
  format: SemanticFormat;
  currency_code: string | null;
  description: string | null;
}

export interface SemanticRelationship {
  name: string;
  cardinality: SemanticCardinality;
  source_dataset: string;
  source_fields: string[];
  target_dataset: string;
  target_fields: string[];
  pinned_model_version_id: string | null;
}

export interface SemanticAccessPolicy {
  /** Field code whose expression must read the governed `department_code` column. */
  row_level_field: string;
}

export interface SemanticExtensions {
  cpm?: {
    department_code?: string | null;
  };
}

export interface SemanticModel {
  format: typeof SEMANTIC_MODEL_FORMAT;
  schema_version: typeof SEMANTIC_SCHEMA_VERSION;
  /** Model code; the stable business identifier. */
  name: string;
  label: string;
  description: string | null;
  datasets: SemanticDataset[];
  metrics: SemanticMetric[];
  relationships: SemanticRelationship[];
  access: SemanticAccessPolicy;
  extensions?: SemanticExtensions;
}
