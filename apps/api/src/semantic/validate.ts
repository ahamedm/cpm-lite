import {
  IDENTIFIER,
  SEMANTIC_AGGREGATIONS,
  SEMANTIC_DATATYPES,
  SEMANTIC_FORMATS,
  SOURCE_ID,
} from './constants.js';
import type { SemanticModel } from './types.js';

export interface SemanticValidationIssue {
  severity: 'error';
  path: string;
  code: string;
  message: string;
}

export interface SemanticValidationReport {
  valid: boolean;
  validated_at: string;
  issues: SemanticValidationIssue[];
}

const GOVERNED_ACCESS_COLUMN = 'department_code';

/**
 * Target-independent validation. Cube-only rules (reserved cube names,
 * availability of a source column) remain in the Cube compiler.
 *
 * Issue paths stay in the legacy `/dimensions`, `/measures`, `/joins` vocabulary
 * so the existing Model Studio can render them without a contract change.
 */
export function validateSemanticModel(
  model: SemanticModel,
  now: Date = new Date()
): SemanticValidationReport {
  const issues: SemanticValidationIssue[] = [];
  const error = (path: string, code: string, message: string) => {
    issues.push({ severity: 'error', path, code, message });
  };

  if (model.datasets.length !== 1) {
    error(
      '/datasets',
      'dataset_count',
      'A model must expose exactly one dataset in this phase'
    );
  }
  const dataset = model.datasets[0];

  if (dataset && !SOURCE_ID.test(dataset.source)) {
    error(
      '/source/source_id',
      'source_not_qualified',
      `Source ${JSON.stringify(dataset.source)} must be a schema-qualified table`
    );
  }

  const fields = dataset?.fields ?? [];
  const metrics = model.metrics;

  if (fields.length === 0) {
    error('/dimensions', 'dimension_required', 'At least one dimension is required');
  }
  if (metrics.length === 0) {
    error('/measures', 'measure_required', 'At least one measure is required');
  }

  const fieldNames = new Set<string>();
  fields.forEach((field, index) => {
    if (fieldNames.has(field.name)) {
      error(
        `/dimensions/${index}/code`,
        'duplicate_dimension',
        `Duplicate dimension code ${field.name}`
      );
    }
    fieldNames.add(field.name);

    if (!IDENTIFIER.test(field.name)) {
      error(
        `/dimensions/${index}/code`,
        'invalid_identifier',
        `Dimension code ${JSON.stringify(field.name)} is not an identifier`
      );
    }
    if (!SEMANTIC_DATATYPES.has(field.datatype)) {
      error(
        `/dimensions/${index}/data_type`,
        'unsupported_data_type',
        `Dimension ${field.name} has unsupported data_type ${JSON.stringify(field.datatype)}`
      );
    }
    if (!IDENTIFIER.test(field.expression.column)) {
      error(
        `/dimensions/${index}/expression`,
        'unsafe_expression',
        `Dimension ${field.name} must reference a plain source column`
      );
    }
  });

  const metricNames = new Set<string>();
  metrics.forEach((metric, index) => {
    if (metricNames.has(metric.name)) {
      error(
        `/measures/${index}/code`,
        'duplicate_measure',
        `Duplicate measure code ${metric.name}`
      );
    }
    metricNames.add(metric.name);

    if (!IDENTIFIER.test(metric.name)) {
      error(
        `/measures/${index}/code`,
        'invalid_identifier',
        `Measure code ${JSON.stringify(metric.name)} is not an identifier`
      );
    }
    if (!SEMANTIC_AGGREGATIONS.has(metric.aggregation)) {
      error(
        `/measures/${index}/aggregation`,
        'unsupported_aggregation',
        `Measure ${metric.name} has unsupported aggregation ${JSON.stringify(metric.aggregation)}`
      );
    }
    if (!SEMANTIC_FORMATS.has(metric.format)) {
      error(
        `/measures/${index}/format`,
        'unsupported_format',
        `Measure ${metric.name} has unsupported format ${JSON.stringify(metric.format)}`
      );
    }
    if (
      metric.aggregation !== 'count' &&
      (!metric.expression || !IDENTIFIER.test(metric.expression.column))
    ) {
      error(
        `/measures/${index}/expression`,
        'unsafe_expression',
        `Measure ${metric.name} must reference a plain source column`
      );
    }
    if (metric.format === 'currency' && !/^[A-Z]{3}$/.test(metric.currency_code ?? '')) {
      error(
        `/measures/${index}/currency_code`,
        'currency_required',
        `Measure ${metric.name} needs an ISO 4217 currency code`
      );
    }
  });

  const accessField = fields.find((field) => field.name === model.access.row_level_field);
  if (!accessField) {
    error(
      '/access/row_level_field',
      'access_field_unknown',
      `Access field ${JSON.stringify(model.access.row_level_field)} must be a dimension of the model`
    );
  } else if (accessField.expression.column !== GOVERNED_ACCESS_COLUMN) {
    error(
      '/access/row_level_field',
      'access_field_ungoverned',
      `Access dimension ${JSON.stringify(accessField.name)} must read the governed ${GOVERNED_ACCESS_COLUMN} column`
    );
  }

  model.relationships.forEach((relationship, index) => {
    if (
      !relationship.source_fields.length ||
      !relationship.target_fields.length ||
      relationship.source_dataset.length === 0 ||
      relationship.target_dataset.length === 0
    ) {
      error(
        `/joins/${index}`,
        'join_incomplete',
        'Join source/target dataset and member must be present'
      );
      return;
    }
    const missing = [...relationship.source_fields, ...relationship.target_fields].filter(
      (member) => !fieldNames.has(member)
    );
    if (missing.length > 0) {
      error(
        `/joins/${index}`,
        'join_member_unknown',
        'Join source/target members must exist as dimensions in this model'
      );
    }
  });

  return {
    valid: issues.length === 0,
    validated_at: now.toISOString(),
    issues,
  };
}
