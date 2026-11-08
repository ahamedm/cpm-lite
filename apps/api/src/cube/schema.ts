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

import {
  SEMANTIC_AGGREGATIONS,
  SEMANTIC_FORMATS,
  SOURCE_ID,
  IDENTIFIER,
} from '../semantic/constants.js';
import { semanticModelFromDefinition } from '../semantic/from-definition.js';
import type { SemanticModel } from '../semantic/types.js';

export interface GeneratedCube {
  model_id: string;
  model_code: string;
  model_name: string;
  department_code: string;
  model_version_id: string;
  version_number: number;
  cube_name: string;
  file_name: string;
  content: string;
  measures: string[];
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
  source: {
    source_id: string;
    columns: string[];
  };
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

/** Renders the canonical neutral model as a Cube YAML document. */
export function compileCube(input: CubeGenerationInput & { semantic: SemanticModel }): GeneratedCube {
  const { model, version, semantic } = input;

  if (semantic.datasets.length !== 1) {
    throw new CubeSchemaError(
      `Model ${model.code} must expose exactly one dataset in this phase`
    );
  }
  const dataset = semantic.datasets[0];
  if (!dataset) {
    throw new CubeSchemaError(`Model ${model.code} has no dataset`);
  }

  const sourceId = dataset.source;
  if (sourceId !== input.source.source_id) {
    throw new CubeSchemaError(
      `Model ${model.code} reads ${sourceId}, which is not the governed source ${input.source.source_id}`
    );
  }
  if (!SOURCE_ID.test(sourceId)) {
    throw new CubeSchemaError(`Source ${sourceId} is not a schema-qualified table`);
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

  const available = new Set(input.source.columns);
  const fields = dataset.fields;
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

  const lines: string[] = ['cubes:', `  - name: ${quote(model.code)}`];
  const description = model.description?.trim()
    ? `${model.name}. ${model.description.trim()}`
    : model.name;
  lines.push(`    description: ${quote(description)}`);
  lines.push(`    sql_table: ${quote(sourceId)}`);

  lines.push('    dimensions:');
  for (const field of fields) {
    const code = field.name;
    const expression = requiredColumn(
      field.expression.column,
      `dimensions.${code}.expression`,
      available
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
        available
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

  return {
    model_id: model.model_id,
    model_code: model.code,
    model_name: model.name,
    department_code: model.department_code,
    model_version_id: version.model_version_id,
    version_number: version.version_number,
    cube_name: model.code,
    file_name: `${model.code}.yml`,
    content: `${lines.join('\n')}\n`,
    measures: metrics.map((metric) => metric.name),
  };
}
