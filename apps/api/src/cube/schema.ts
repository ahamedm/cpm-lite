/**
 * Generates Cube Core schema for published model versions.
 *
 * The generated document is the only bridge between the model registry and
 * Cube Core: it is written as immutable YAML into the dynamic schema snapshot
 * (see `snapshot.ts`) and loaded by `cube/model/dynamic-repository.cjs`.
 *
 * Safety rules:
 * - cube names and member names are identifiers (no SQL, no YAML tricks);
 * - expressions must be plain columns of the governed source;
 * - every generated cube carries the department row-level access policy.
 *
 * Invariant I5: no thresholds, approvers or allocation values are emitted
 * here. This module only translates registry data into Cube members.
 */

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
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const SOURCE_ID = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

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

const MEASURE_FORMATS = new Set(['currency', 'percent', 'number']);

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

function resolveAccessMember(
  requested: string,
  dimensions: Array<Record<string, unknown>>,
  modelCode: string
): string {
  const dimension =
    dimensions.find((candidate) => candidate.code === requested) ??
    dimensions.find((candidate) => candidate.expression === requested);
  if (!dimension) {
    throw new CubeSchemaError(
      `Access field ${JSON.stringify(requested)} must be a dimension of model ${modelCode}`
    );
  }
  if (dimension.expression !== DEPARTMENT_SCOPE_COLUMN) {
    throw new CubeSchemaError(
      `Access dimension ${JSON.stringify(dimension.code)} of model ${modelCode} must read the governed ${DEPARTMENT_SCOPE_COLUMN} column`
    );
  }
  return String(dimension.code);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CubeSchemaError(`${path} must be a non-empty string`);
  }
  return value;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Renders one published model version as a Cube YAML document.
 */
export function buildCube(input: CubeGenerationInput): GeneratedCube {
  const { model, version } = input;
  const definition = asRecord(version.definition);
  // Definitions predating Model Studio (ADR 0003) have no source/access block;
  // they default to the governed source and the department scope.
  const declaredSource = asRecord(definition.source).source_id;
  const sourceId =
    typeof declaredSource === 'string' && declaredSource.length > 0
      ? declaredSource
      : input.source.source_id;

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
    throw new CubeSchemaError(`Model code ${JSON.stringify(model.code)} collides with a built-in Cube member`);
  }

  const available = new Set(input.source.columns);
  const dimensions = asArray(definition.dimensions);
  const measures = asArray(definition.measures);
  if (dimensions.length === 0) throw new CubeSchemaError(`Model ${model.code} has no dimensions`);
  if (measures.length === 0) throw new CubeSchemaError(`Model ${model.code} has no measures`);

  const memberNames = new Set<string>();
  for (const dimension of dimensions) {
    const code = requiredString(dimension.code, 'dimensions[].code');
    if (!IDENTIFIER.test(code)) throw new CubeSchemaError(`Dimension code ${JSON.stringify(code)} is not an identifier`);
    if (memberNames.has(code)) throw new CubeSchemaError(`Duplicate member code ${JSON.stringify(code)}`);
    memberNames.add(code);
  }
  for (const measure of measures) {
    const code = requiredString(measure.code, 'measures[].code');
    if (!IDENTIFIER.test(code)) throw new CubeSchemaError(`Measure code ${JSON.stringify(code)} is not an identifier`);
    if (memberNames.has(code)) throw new CubeSchemaError(`Duplicate member code ${JSON.stringify(code)}`);
    memberNames.add(code);
  }

  const declaredAccess = asRecord(definition.access).row_level_field;
  const accessField = resolveAccessMember(
    typeof declaredAccess === 'string' && declaredAccess.length > 0
      ? declaredAccess
      : DEPARTMENT_SCOPE_COLUMN,
    dimensions,
    model.code
  );

  const lines: string[] = ['cubes:', `  - name: ${quote(model.code)}`];
  const description = model.description?.trim()
    ? `${model.name}. ${model.description.trim()}`
    : model.name;
  lines.push(`    description: ${quote(description)}`);
  lines.push(`    sql_table: ${quote(sourceId)}`);

  lines.push('    dimensions:');
  for (const dimension of dimensions) {
    const code = String(dimension.code);
    const expression = requiredColumn(dimension.expression, `dimensions.${code}.expression`, available);
    const type = DIMENSION_TYPES[String(dimension.data_type)];
    if (!type) {
      throw new CubeSchemaError(
        `Dimension ${code} has unsupported data_type ${JSON.stringify(dimension.data_type)}`
      );
    }
    lines.push(`      - name: ${quote(code)}`);
    if (typeof dimension.name === 'string' && dimension.name.length > 0) {
      lines.push(`        title: ${quote(dimension.name)}`);
    }
    lines.push(`        sql: ${quote(expression)}`);
    lines.push(`        type: ${quote(type)}`);
  }

  lines.push('    measures:');
  for (const measure of measures) {
    const code = String(measure.code);
    const aggregation = String(measure.aggregation ?? 'sum');
    const type = AGGREGATION_TYPES[aggregation];
    if (!type) {
      throw new CubeSchemaError(`Measure ${code} has unsupported aggregation ${JSON.stringify(aggregation)}`);
    }
    const format = String(measure.format ?? 'number');
    if (!MEASURE_FORMATS.has(format)) {
      throw new CubeSchemaError(`Measure ${code} has unsupported format ${JSON.stringify(format)}`);
    }
    lines.push(`      - name: ${quote(code)}`);
    if (typeof measure.name === 'string' && measure.name.length > 0) {
      lines.push(`        title: ${quote(measure.name)}`);
    }
    if (aggregation !== 'count') {
      const expression = requiredColumn(measure.expression, `measures.${code}.expression`, available);
      lines.push(`        sql: ${quote(expression)}`);
    }
    lines.push(`        type: ${quote(type)}`);
    lines.push(`        format: ${quote(format)}`);
    if (format === 'currency') {
      const currency = requiredString(measure.currency_code, `measures.${code}.currency_code`);
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new CubeSchemaError(`Measure ${code} has an invalid ISO 4217 currency ${JSON.stringify(currency)}`);
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
    `            - member: ${quote(accessField)}`,
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
    measures: measures.map((measure) => String(measure.code)),
  };
}

function requiredColumn(value: unknown, path: string, available: Set<string>): string {
  const expression = requiredString(value, path);
  if (!IDENTIFIER.test(expression)) {
    throw new CubeSchemaError(`${path} must be a plain source column identifier`);
  }
  if (!available.has(expression)) {
    throw new CubeSchemaError(`${path} references ${JSON.stringify(expression)}, which is not a governed source column`);
  }
  return expression;
}
