/**
 * Cube Core target compiler for the canonical semantic model (ADR 0008).
 *
 * The generated document is a lowering of the neutral model, not the registry.
 * It is written as immutable YAML into the dynamic schema snapshot (see
 * `snapshot.ts`) and loaded by `cube/model/dynamic-repository.cjs`.
 *
 * Safety rules:
 * - cube names and member names are identifiers (no SQL, no YAML tricks);
 * - expressions must be plain columns of the governed source;
 * - every generated cube carries the department row-level access policy.
 *
 * Invariant I5: no thresholds, approvers or allocation values are emitted here.
 */

import { createHash } from 'node:crypto';
import {
  SEMANTIC_AGGREGATIONS,
  SEMANTIC_FORMATS,
  SOURCE_ID,
  IDENTIFIER,
} from '../semantic/constants.js';
import { semanticModelFromDefinition } from '../semantic/from-definition.js';
import type { SemanticDataset, SemanticModel } from '../semantic/types.js';

export interface GeneratedCube {
  model_id: string;
  model_code: string;
  model_name: string;
  department_code: string;
  model_version_id: string;
  version_number: number;
  cube_name: string;
  /** Every Cube name rendered by this model, including internal reference cubes. */
  cube_names: string[];
  file_name: string;
  content: string;
  measures: string[];
}

export interface CubeGenerationSource {
  source_id: string;
  columns: string[];
}

export interface CubeGenerationInput {
  model: {
    model_id: string;
    code: string;
    name: string;
    description: string | null;
    department_code: string;
    status: string;
  };
  version: {
    model_version_id: string;
    version_number: number;
    status: string;
    definition: Record<string, unknown>;
  };
  source: CubeGenerationSource;
  /** All dataset sources; defaults to `[source]` for single-dataset models. */
  sources?: CubeGenerationSource[];
  /** Canonical model; omitted callers are converted from the legacy document. */
  semantic?: SemanticModel;
}

/** Cube names already taken by the hand-written semantic layer. */
export const RESERVED_CUBE_NAMES = new Set([
  'financials',
  'departments',
  'categories',
  'regions',
  'budget_vs_actual',
]);

const CUBE_NAME = /^[a-z_][a-z0-9_]{0,63}$/;

const DIMENSION_TYPES: Record<string, string> = {
  string: 'string',
  date: 'time',
  integer: 'number',
  decimal: 'number',
  boolean: 'boolean',
};

const AGGREGATION_TYPES: Record<string, string> = {
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  count: 'count',
  count_distinct: 'countDistinct',
};

export class CubeSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeSchemaError';
  }
}

/**
 * The department scope is always the governed `department_code` column; the
 * model may expose it under a different member code (legacy models call it
 * `department`). The row-level policy must filter that member.
 */
const DEPARTMENT_SCOPE_COLUMN = 'department_code';

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CubeSchemaError(`${path} must be a non-empty string`);
  }
  return value;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function requiredColumn(value: unknown, path: string, available: Set<string>): string {
  const expression = requiredString(value, path);
  if (!IDENTIFIER.test(expression)) {
    throw new CubeSchemaError(`${path} must be a plain source column identifier`);
  }
  if (!available.has(expression)) {
    throw new CubeSchemaError(
      `${path} references ${JSON.stringify(expression)}, which is not a governed source column`
    );
  }
  return expression;
}

/**
 * Renders one published model version as a Cube YAML document.
 *
 * Kept as the compatibility entry point used by existing callers and tests.
 */
export function buildCube(input: CubeGenerationInput): GeneratedCube {
  const semantic =
    input.semantic ??
    semanticModelFromDefinition(input.version.definition, {
      code: input.model.code,
      name: input.model.name,
      description: input.model.description,
      departmentCode: input.model.department_code,
      defaultSourceId: input.source.source_id,
    });
  return compileCube({ ...input, semantic });
}

function cubeSafeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = /^[a-z_]/.test(normalized) ? normalized : `c_${normalized}`;
  if (safe.length <= 64) return safe;
  const hash = createHash('sha256').update(safe).digest('hex').slice(0, 8);
  return `${safe.slice(0, 55)}_${hash}`;
}

function referenceCubeName(modelCode: string, dataset: SemanticDataset): string {
  return cubeSafeName(`${modelCode}__${dataset.name}`);
}

function referenceFieldName(dataset: SemanticDataset, fieldName: string): string {
  return cubeSafeName(`${dataset.name}__${fieldName}`);
}

function cubeIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Renders the canonical neutral model as a Cube YAML document. */
export function compileCube(input: CubeGenerationInput & { semantic: SemanticModel }): GeneratedCube {
  const { model, version, semantic } = input;
  const principal = semantic.datasets[0];
  if (!principal) {
    throw new CubeSchemaError(`Model ${model.code} has no dataset`);
  }
  if (principal.source !== input.source.source_id) {
    throw new CubeSchemaError(
      `Model ${model.code} reads ${principal.source}, which is not the governed source ${input.source.source_id}`
    );
  }
  if (!SOURCE_ID.test(principal.source)) {
    throw new CubeSchemaError(`Source ${principal.source} is not a schema-qualified table`);
  }
  if (!CUBE_NAME.test(model.code)) {
    throw new CubeSchemaError(
      `Model code ${JSON.stringify(model.code)} is not a valid Cube name (lowercase letters, digits and underscores)`
    );
  }
  if (RESERVED_CUBE_NAMES.has(model.code)) {
    throw new CubeSchemaError(
      `Model code ${JSON.stringify(model.code)} collides with a built-in Cube member`
    );
  }

  const sources = input.sources && input.sources.length > 0 ? input.sources : [input.source];
  const sourceColumns = new Map(sources.map((source) => [source.source_id, new Set(source.columns)]));
  const availableFor = (dataset: SemanticDataset): Set<string> => {
    const available = sourceColumns.get(dataset.source);
    if (!available) {
      throw new CubeSchemaError(
        `Source ${dataset.source} of dataset ${dataset.name} is not available to the Cube compiler`
      );
    }
    return available;
  };

  const referenceDatasets = semantic.datasets.slice(1);
  const referenceCubeByName = new Map<string, string>();
  for (const dataset of referenceDatasets) {
    if (!SOURCE_ID.test(dataset.source)) {
      throw new CubeSchemaError(
        `Source ${dataset.source} of dataset ${dataset.name} is not a schema-qualified table`
      );
    }
    const name = referenceCubeName(model.code, dataset);
    if (name === model.code || referenceCubeByName.has(dataset.name)) {
      throw new CubeSchemaError(`Dataset ${dataset.name} maps to a duplicate Cube name`);
    }
    referenceCubeByName.set(dataset.name, name);
    availableFor(dataset);
  }

  const fields = principal.fields;
  const metrics = semantic.metrics;
  if (fields.length === 0) throw new CubeSchemaError(`Model ${model.code} has no dimensions`);
  if (metrics.length === 0) throw new CubeSchemaError(`Model ${model.code} has no measures`);

  const memberNames = new Set<string>();
  for (const field of fields) {
    const code = requiredString(field.name, 'dimensions[].code');
    if (!IDENTIFIER.test(code)) {
      throw new CubeSchemaError(`Dimension code ${JSON.stringify(code)} is not an identifier`);
    }
    if (memberNames.has(code)) {
      throw new CubeSchemaError(`Duplicate member code ${JSON.stringify(code)}`);
    }
    memberNames.add(code);
  }
  for (const metric of metrics) {
    if (metric.dataset !== principal.name) {
      throw new CubeSchemaError(
        `Measure ${metric.name} must belong to the principal dataset ${principal.name}`
      );
    }
    const code = requiredString(metric.name, 'measures[].code');
    if (!IDENTIFIER.test(code)) {
      throw new CubeSchemaError(`Measure code ${JSON.stringify(code)} is not an identifier`);
    }
    if (memberNames.has(code)) {
      throw new CubeSchemaError(`Duplicate member code ${JSON.stringify(code)}`);
    }
    memberNames.add(code);
  }

  const accessField = fields.find((field) => field.name === semantic.access.row_level_field);
  if (!accessField) {
    throw new CubeSchemaError(
      `Access field ${JSON.stringify(semantic.access.row_level_field)} must be a dimension of model ${model.code}`
    );
  }
  if (accessField.expression.column !== DEPARTMENT_SCOPE_COLUMN) {
    throw new CubeSchemaError(
      `Access dimension ${JSON.stringify(accessField.name)} of model ${model.code} must read the governed ${DEPARTMENT_SCOPE_COLUMN} column`
    );
  }

  const datasetByName = new Map(semantic.datasets.map((dataset) => [dataset.name, dataset]));
  for (const relationship of semantic.relationships) {
    const sourceDataset = datasetByName.get(relationship.source_dataset);
    const targetDataset = datasetByName.get(relationship.target_dataset);
    if (!sourceDataset || !targetDataset) {
      throw new CubeSchemaError(
        `Join ${relationship.name} references an unknown dataset`
      );
    }
    if (sourceDataset.name !== principal.name) {
      throw new CubeSchemaError(
        `Join ${relationship.name} must start at the principal dataset ${principal.name}`
      );
    }
    if (targetDataset.name === principal.name) {
      throw new CubeSchemaError(`Join ${relationship.name} must target a reference dataset`);
    }
    if (!referenceCubeByName.has(targetDataset.name)) {
      throw new CubeSchemaError(
        `Join ${relationship.name} targets ${targetDataset.name}, which is not a reference dataset`
      );
    }
    if (relationship.cardinality !== 'many_to_one' && relationship.cardinality !== 'one_to_one') {
      throw new CubeSchemaError(
        `Join ${relationship.name} must be many_to_one or one_to_one`
      );
    }
    if (relationship.pinned_model_version_id) {
      throw new CubeSchemaError(
        `Join ${relationship.name} pins a reference model version; cross-version joins are not in this slice`
      );
    }
    if (
      relationship.source_fields.length === 0 ||
      relationship.source_fields.length !== relationship.target_fields.length
    ) {
      throw new CubeSchemaError(
        `Join ${relationship.name} needs the same non-zero number of source and target keys`
      );
    }
  }

  const lines: string[] = ['cubes:', `  - name: ${quote(model.code)}`];
  const description = model.description?.trim()
    ? `${model.name}. ${model.description.trim()}`
    : model.name;
  lines.push(`    description: ${quote(description)}`);
  lines.push(`    sql_table: ${quote(principal.source)}`);

  const principalFieldsByName = new Map(fields.map((field) => [field.name, field]));
  if (semantic.relationships.length > 0) {
    lines.push('    joins:');
    for (const relationship of semantic.relationships) {
      const targetDataset = datasetByName.get(relationship.target_dataset)!;
      const targetCube = referenceCubeByName.get(targetDataset.name)!;
      const pairs = relationship.source_fields.map((sourceField, index) => {
        const targetField = relationship.target_fields[index]!;
        if (!targetDataset.fields.some((field) => field.name === targetField)) {
          throw new CubeSchemaError(
            `Join ${relationship.name} target member ${targetField} is not a field of dataset ${targetDataset.name}`
          );
        }
        const sourceExpression = principalFieldsByName.get(sourceField)?.expression.column ?? sourceField;
        const checkedSource = requiredColumn(
          sourceExpression,
          `joins.${relationship.name}.${sourceField}`,
          availableFor(principal)
        );
        return `{CUBE}.${cubeIdentifier(checkedSource)} = {${targetCube}}.${cubeIdentifier(referenceFieldName(targetDataset, targetField))}`;
      });
      lines.push(`      - name: ${quote(relationship.name)}`);
      lines.push(`        relationship: ${quote(relationship.cardinality)}`);
      lines.push(`        sql: ${quote(pairs.join(' AND '))}`);
    }
  }

  lines.push('    dimensions:');
  for (const field of fields) {
    const code = field.name;
    const expression = requiredColumn(
      field.expression.column,
      `dimensions.${code}.expression`,
      availableFor(principal)
    );
    const type = DIMENSION_TYPES[field.datatype];
    if (!type) {
      throw new CubeSchemaError(
        `Dimension ${code} has unsupported data_type ${JSON.stringify(field.datatype)}`
      );
    }
    lines.push(`      - name: ${quote(code)}`);
    if (field.label.length > 0) {
      lines.push(`        title: ${quote(field.label)}`);
    }
    lines.push(`        sql: ${quote(expression)}`);
    lines.push(`        type: ${quote(type)}`);
  }

  lines.push('    measures:');
  for (const metric of metrics) {
    const code = metric.name;
    const aggregation = metric.aggregation;
    const type = AGGREGATION_TYPES[aggregation];
    if (!SEMANTIC_AGGREGATIONS.has(aggregation) || !type) {
      throw new CubeSchemaError(
        `Measure ${code} has unsupported aggregation ${JSON.stringify(aggregation)}`
      );
    }
    const format = metric.format;
    if (!SEMANTIC_FORMATS.has(format)) {
      throw new CubeSchemaError(
        `Measure ${code} has unsupported format ${JSON.stringify(format)}`
      );
    }
    lines.push(`      - name: ${quote(code)}`);
    if (metric.label.length > 0) {
      lines.push(`        title: ${quote(metric.label)}`);
    }
    if (aggregation !== 'count') {
      if (!metric.expression) {
        throw new CubeSchemaError(
          `Measure ${code} has no expression for aggregation ${aggregation}`
        );
      }
      const expression = requiredColumn(
        metric.expression.column,
        `measures.${code}.expression`,
        availableFor(principal)
      );
      lines.push(`        sql: ${quote(expression)}`);
    }
    lines.push(`        type: ${quote(type)}`);
    lines.push(`        format: ${quote(format)}`);
    if (format === 'currency') {
      const currency = requiredString(metric.currency_code, `measures.${code}.currency_code`);
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new CubeSchemaError(
          `Measure ${code} has an invalid ISO 4217 currency ${JSON.stringify(currency)}`
        );
      }
      lines.push(`        currency: ${quote(currency)}`);
    }
  }

  lines.push(
    '    accessPolicy:',
    '      - group: "steward"',
    '        rowLevel:',
    '          allowAll: true',
    '      - group: "business_user"',
    '        rowLevel:',
    '          filters:',
    `            - member: ${quote(accessField.name)}`,
    '              operator: "equals"',
    '              values:',
    '                - "{SECURITY_CONTEXT.department_code}"'
  );

  const referenceCubes: string[] = [];
  for (const dataset of referenceDatasets) {
    const cubeName = referenceCubeByName.get(dataset.name)!;
    const available = availableFor(dataset);
    if (dataset.fields.length === 0) {
      throw new CubeSchemaError(`Dataset ${dataset.name} has no fields`);
    }
    referenceCubes.push(
      `  - name: ${quote(cubeName)}`,
      `    description: ${quote(`Reference dataset ${dataset.name} for ${model.name}`)}`,
      `    sql_table: ${quote(dataset.source)}`,
      '    dimensions:'
    );
    for (const field of dataset.fields) {
      const code = referenceFieldName(dataset, field.name);
      const expression = requiredColumn(
        field.expression.column,
        `datasets.${dataset.name}.fields.${field.name}.expression`,
        available
      );
      const type = DIMENSION_TYPES[field.datatype];
      if (!type) {
        throw new CubeSchemaError(
          `Reference field ${field.name} has unsupported data_type ${JSON.stringify(field.datatype)}`
        );
      }
      referenceCubes.push(`      - name: ${quote(code)}`);
      if (field.label.length > 0) {
        referenceCubes.push(`        title: ${quote(field.label)}`);
      }
      referenceCubes.push(`        sql: ${quote(expression)}`);
      referenceCubes.push(`        type: ${quote(type)}`);
    }
  }
  lines.push(...referenceCubes);

  return {
    model_id: model.model_id,
    model_code: model.code,
    model_name: model.name,
    department_code: model.department_code,
    model_version_id: version.model_version_id,
    version_number: version.version_number,
    cube_name: model.code,
    cube_names: [model.code, ...referenceDatasets.map((dataset) => referenceCubeByName.get(dataset.name)!)],
    file_name: `${model.code}.yml`,
    content: `${lines.join('\n')}\n`,
    measures: metrics.map((metric) => metric.name),
  };
}
