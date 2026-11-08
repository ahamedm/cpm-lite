/**
 * Experimental export of the canonical model to the Apache Ossie subset.
 *
 * This is deliberately not a claim of full conformance: Ossie 0.2 is still
 * draft and has no access-control construct. Governance and CPM-specific
 * measure metadata ride in `custom_extensions`, as recorded in ADR 0008.
 */

import type { SemanticMetric, SemanticModel } from './types.js';

export interface OssieField {
  name: string;
  description: string;
  datatype: string;
  dimension: { is_time: boolean };
  expression: { dialects: Array<{ dialect: string; expression: string }> };
}

export interface OssieDataset {
  name: string;
  source: string;
  primary_key: string[];
  fields: OssieField[];
}

export interface OssieMetric {
  name: string;
  description: string;
  dataset: string;
  expression: { dialects: Array<{ dialect: string; expression: string }> };
}

export interface OssieRelationship {
  name: string;
  from: { dataset: string; columns: string[] };
  to: { dataset: string; columns: string[] };
  cardinality: string;
}

export interface OssieDocument {
  version: string;
  name: string;
  description?: string;
  datasets: OssieDataset[];
  metrics: OssieMetric[];
  relationships: OssieRelationship[];
  custom_extensions: Array<Record<string, unknown>>;
}

function aggregateExpression(metric: SemanticMetric): string {
  const column = metric.expression?.column;
  switch (metric.aggregation) {
    case 'count':
      return 'COUNT(*)';
    case 'count_distinct':
      return column ? `COUNT(DISTINCT ${column})` : 'COUNT(*)';
    case 'sum':
      return column ? `SUM(${column})` : 'SUM(*)';
    case 'avg':
      return column ? `AVG(${column})` : 'AVG(*)';
    case 'min':
      return column ? `MIN(${column})` : 'MIN(*)';
    case 'max':
      return column ? `MAX(${column})` : 'MAX(*)';
  }
}

export function toOssieDocument(model: SemanticModel): OssieDocument {
  return {
    version: '0.1.1',
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    datasets: model.datasets.map((dataset) => ({
      name: dataset.name,
      source: dataset.source,
      primary_key: dataset.primary_key,
      fields: dataset.fields.map((field) => ({
        name: field.name,
        description: field.label,
        datatype: field.datatype,
        dimension: { is_time: field.is_time },
        expression: {
          dialects: [{ dialect: 'ANSI_SQL', expression: field.expression.column }],
        },
      })),
    })),
    metrics: model.metrics.map((metric) => ({
      name: metric.name,
      description: metric.label,
      dataset: metric.dataset,
      expression: {
        dialects: [{ dialect: 'ANSI_SQL', expression: aggregateExpression(metric) }],
      },
    })),
    relationships: model.relationships.map((relationship) => ({
      name: relationship.name,
      from: {
        dataset: relationship.source_dataset,
        columns: relationship.source_fields,
      },
      to: {
        dataset: relationship.target_dataset,
        columns: relationship.target_fields,
      },
      cardinality: relationship.cardinality,
    })),
    custom_extensions: [
      {
        vendor_name: 'cpm-lite',
        name: 'governance',
        data: {
          access: model.access,
          department_code: model.extensions?.cpm?.department_code ?? null,
          metrics: model.metrics.map((metric) => ({
            name: metric.name,
            aggregation: metric.aggregation,
            format: metric.format,
            currency_code: metric.currency_code,
          })),
        },
      },
    ],
  };
}
