import {
  IDENTIFIER,
  SEMANTIC_AGGREGATIONS,
  SEMANTIC_DATATYPES,
  SEMANTIC_FORMATS,
  SOURCE_ID,
} from './constants.js';
import type { SemanticDataset, SemanticField, SemanticModel } from './types.js';

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
const LOOKUP_CARDINALITIES = new Set(['many_to_one', 'one_to_one']);

type IssueWriter = (path: string, code: string, message: string) => void;

function validateDatasetFields(
  dataset: SemanticDataset,
  datasetIndex: number,
  principal: boolean,
  error: IssueWriter
): Map<string, SemanticField> {
  const fieldsByCode = new Map<string, SemanticField>();
  const base = principal ? '/dimensions' : `/datasets/${datasetIndex}/fields`;
  if (dataset.fields.length === 0) {
    error(
      principal ? '/dimensions' : `/datasets/${datasetIndex}/fields`,
      'dimension_required',
      principal
        ? 'At least one dimension is required'
        : `Dataset ${dataset.name} must expose at least one field`
    );
  }
  dataset.fields.forEach((field, index) => {
    if (fieldsByCode.has(field.name)) {
      error(
        `${base}/${index}/code`,
        'duplicate_dimension',
        `Duplicate member code ${field.name} in dataset ${dataset.name}`
      );
    }
    fieldsByCode.set(field.name, field);

    if (!IDENTIFIER.test(field.name)) {
      error(
        `${base}/${index}/code`,
        'invalid_identifier',
        `Member code ${JSON.stringify(field.name)} is not an identifier`
      );
    }
    if (!SEMANTIC_DATATYPES.has(field.datatype)) {
      error(
        `${base}/${index}/data_type`,
        'unsupported_data_type',
        `Member ${field.name} has unsupported data_type ${JSON.stringify(field.datatype)}`
      );
    }
    if (!IDENTIFIER.test(field.expression.column)) {
      error(
        `${base}/${index}/expression`,
        'unsafe_expression',
        `Member ${field.name} must reference a plain source column`
      );
    }
  });
  return fieldsByCode;
}

/**
 * Target-independent validation. Cube-only rules (reserved cube names,
 * availability of a source column) remain in the Cube compiler.
 *
 * Issue paths stay in the legacy `/dimensions`, `/measures`, `/joins` vocabulary
 * for the principal dataset so the existing Model Studio can render them
 * without a contract change; reference datasets use `/datasets/<n>/fields`.
 */
export function validateSemanticModel(
  model: SemanticModel,
  now: Date = new Date()
): SemanticValidationReport {
  const issues: SemanticValidationIssue[] = [];
  const error: IssueWriter = (path, code, message) => {
    issues.push({ severity: 'error', path, code, message });
  };

  if (model.datasets.length === 0) {
    error('/datasets', 'dataset_required', 'A model must expose at least one dataset');
  }
  if (model.datasets.length > 1 && model.schema_version !== '1.1') {
    error(
      '/schema_version',
      'schema_version_multi_dataset',
      'A multi-dataset model must use semantic schema version 1.1'
    );
  }

  const principal = model.datasets[0];
  const datasetsByName = new Map<string, SemanticDataset>();
  const fieldsByDataset = new Map<string, Map<string, SemanticField>>();
  const sources = new Set<string>();

  model.datasets.forEach((dataset, index) => {
    if (!IDENTIFIER.test(dataset.name)) {
      error(
        `/datasets/${index}/name`,
        'invalid_identifier',
        `Dataset code ${JSON.stringify(dataset.name)} is not an identifier`
      );
    }
    if (datasetsByName.has(dataset.name)) {
      error(
        `/datasets/${index}/name`,
        'duplicate_dataset',
        `Duplicate dataset code ${dataset.name}`
      );
    }
    datasetsByName.set(dataset.name, dataset);

    if (!SOURCE_ID.test(dataset.source)) {
      error(
        index === 0 ? '/source/source_id' : `/datasets/${index}/source`,
        'source_not_qualified',
        `Source ${JSON.stringify(dataset.source)} must be a schema-qualified table`
      );
    }
    if (sources.has(dataset.source)) {
      error(
        index === 0 ? '/source/source_id' : `/datasets/${index}/source`,
        'duplicate_dataset_source',
        `Source ${JSON.stringify(dataset.source)} is declared by more than one dataset`
      );
    }
    sources.add(dataset.source);

    const fieldsByCode = validateDatasetFields(dataset, index, index === 0, error);
    fieldsByDataset.set(dataset.name, fieldsByCode);

    dataset.primary_key.forEach((key, keyIndex) => {
      if (!fieldsByCode.has(key)) {
        error(
          index === 0 ? `/grain/${keyIndex}` : `/datasets/${index}/primary_key/${keyIndex}`,
          'primary_key_unknown',
          `Primary key ${JSON.stringify(key)} is not a field of dataset ${dataset.name}`
        );
      }
    });
  });

  const metrics = model.metrics;
  if (metrics.length === 0) {
    error('/measures', 'measure_required', 'At least one measure is required');
  }

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
    if (!datasetsByName.has(metric.dataset)) {
      error(
        `/measures/${index}/dataset`,
        'metric_dataset_unknown',
        `Measure ${metric.name} references unknown dataset ${metric.dataset}`
      );
    } else if (principal && metric.dataset !== principal.name) {
      error(
        `/measures/${index}/dataset`,
        'metric_dataset_not_principal',
        `Measure ${metric.name} must belong to the principal dataset ${principal.name}`
      );
    }
  });

  const principalFields = principal ? fieldsByDataset.get(principal.name) ?? new Map() : new Map();
  const accessField = principalFields.get(model.access.row_level_field);
  if (!accessField) {
    error(
      '/access/row_level_field',
      'access_field_unknown',
      `Access field ${JSON.stringify(model.access.row_level_field)} must be a dimension of the principal dataset`
    );
  } else if (accessField.expression.column !== GOVERNED_ACCESS_COLUMN) {
    error(
      '/access/row_level_field',
      'access_field_ungoverned',
      `Access dimension ${JSON.stringify(accessField.name)} must read the governed ${GOVERNED_ACCESS_COLUMN} column`
    );
  }

  const relationshipNames = new Set<string>();
  model.relationships.forEach((relationship, index) => {
    if (relationshipNames.has(relationship.name)) {
      error(
        `/joins/${index}/name`,
        'duplicate_relationship',
        `Duplicate relationship name ${relationship.name}`
      );
    }
    relationshipNames.add(relationship.name);

    const source = datasetsByName.get(relationship.source_dataset);
    const target = datasetsByName.get(relationship.target_dataset);
    if (!source || !target) {
      error(
        `/joins/${index}`,
        'join_dataset_unknown',
        `Join ${relationship.name} must reference datasets declared by this model`
      );
      return;
    }
    if (source.name === target.name) {
      error(
        `/joins/${index}`,
        'join_self_reference',
        `Join ${relationship.name} cannot reference the same dataset on both sides`
      );
      return;
    }
    if (principal && source.name !== principal.name && target.name !== principal.name) {
      error(
        `/joins/${index}`,
        'join_hop_not_supported',
        `Join ${relationship.name} must start or end at the principal dataset ${principal.name}`
      );
    }
    if (!LOOKUP_CARDINALITIES.has(relationship.cardinality)) {
      error(
        `/joins/${index}/relationship`,
        'join_cardinality_unsupported',
        `Join ${relationship.name} must be many_to_one or one_to_one in this slice`
      );
    }
    if (relationship.pinned_model_version_id) {
      error(
        `/joins/${index}/target_model_version_id`,
        'join_pinned_version_not_supported',
        `Join ${relationship.name} pins a reference model version; cross-version joins are not in this slice`
      );
    }
    if (
      relationship.source_fields.length === 0 ||
      relationship.source_fields.length !== relationship.target_fields.length
    ) {
      error(
        `/joins/${index}/on`,
        'join_key_count',
        `Join ${relationship.name} needs the same non-zero number of source and target keys`
      );
      return;
    }
    const sourceFields = fieldsByDataset.get(source.name) ?? new Map();
    const targetFields = fieldsByDataset.get(target.name) ?? new Map();
    const missing = [
      ...relationship.source_fields.filter((member) => !sourceFields.has(member)),
      ...relationship.target_fields.filter((member) => !targetFields.has(member)),
    ];
    if (missing.length > 0) {
      error(
        `/joins/${index}`,
        'join_member_unknown',
        `Join ${relationship.name} members must exist in their datasets: ${missing.join(', ')}`
      );
    }
  });

  return {
    valid: issues.length === 0,
    validated_at: now.toISOString(),
    issues,
  };
}
