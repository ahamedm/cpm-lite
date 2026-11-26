import { existsSync } from 'node:fs';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { AuthUser } from './auth.js';
import type { ModelDefinition, ModelPreviewRequest } from './contracts.js';
import { forbidden, serviceUnavailable, unprocessable } from './errors.js';
import { datasetNameFromSource } from './semantic/from-definition.js';

export interface ModelSourceColumn {
  name: string;
  label: string;
  data_type: 'string' | 'integer' | 'decimal' | 'date' | 'boolean';
  nullable: boolean;
  distinct_count: number;
  null_count: number;
  sample_values: string[];
  suggested_role: 'dimension' | 'measure' | 'time' | 'access';
  suggested_aggregation: string | null;
  format: string | null;
}

export interface ModelSourceRelationship {
  name: string;
  target_source_id: string;
  target_label: string;
  source_field: string;
  target_field: string;
  relationship: 'many_to_one';
}

export interface ModelSource {
  source_id: string;
  name: string;
  description: string;
  grain: string;
  grain_key: string;
  grain_unique: boolean;
  row_count: number;
  refreshed_at: string;
  columns: ModelSourceColumn[];
  relationships: ModelSourceRelationship[];
}

export interface ModelPreviewColumn {
  code: string;
  name: string;
  kind: 'dimension' | 'measure';
  data_type: string;
  format: string | null;
  currency_code: string | null;
}

export interface ModelPreview {
  source_id: string;
  columns: ModelPreviewColumn[];
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null>;
  row_count: number;
  truncated: boolean;
  scope: {
    department_code: string | null;
    applied: boolean;
    preview_as: boolean;
  };
  generated_at: string;
}

interface SourceDefinition {
  source_id: string;
  table: string;
  name: string;
  description: string;
  grain: string;
  grain_key: string;
  relationships: ModelSourceRelationship[];
}

interface ColumnMeta {
  label: string;
  role: ModelSourceColumn['suggested_role'];
  aggregation?: string | null;
  format?: string | null;
}

const SOURCE_DEFINITION: SourceDefinition = {
  source_id: 'gold.fact_financials',
  table: 'gold.fact_financials',
  name: 'Budget vs actual transactions',
  description: 'Governed budget and actual facts from the synthetic Kaggle workbook. Invalid dimension rows are quarantined by the loader.',
  grain: 'One row per governed source transaction',
  grain_key: 'financial_id',
  relationships: [
    {
      name: 'Departments',
      target_source_id: 'gold.dim_department',
      target_label: 'Department',
      source_field: 'department_code',
      target_field: 'department_code',
      relationship: 'many_to_one',
    },
    {
      name: 'Categories',
      target_source_id: 'gold.dim_category',
      target_label: 'Spend category',
      source_field: 'category_code',
      target_field: 'category_code',
      relationship: 'many_to_one',
    },
    {
      name: 'Regions',
      target_source_id: 'gold.dim_region',
      target_label: 'Region',
      source_field: 'region_code',
      target_field: 'region_code',
      relationship: 'many_to_one',
    },
  ],
};

const REFERENCE_SOURCE_DEFINITIONS: SourceDefinition[] = [
  {
    source_id: 'gold.dim_department',
    table: 'gold.dim_department',
    name: 'Departments',
    description: 'Governed department reference data.',
    grain: 'One row per department',
    grain_key: 'department_code',
    relationships: [],
  },
  {
    source_id: 'gold.dim_category',
    table: 'gold.dim_category',
    name: 'Spend categories',
    description: 'Governed spend category reference data.',
    grain: 'One row per category',
    grain_key: 'category_code',
    relationships: [],
  },
  {
    source_id: 'gold.dim_region',
    table: 'gold.dim_region',
    name: 'Regions',
    description: 'Governed region reference data.',
    grain: 'One row per region',
    grain_key: 'region_code',
    relationships: [],
  },
  {
    source_id: 'gold.dim_date',
    table: 'gold.dim_date',
    name: 'Fiscal dates',
    description: 'Governed date and period reference data.',
    grain: 'One row per date',
    grain_key: 'date_key',
    relationships: [],
  },
];

const SOURCE_DEFINITIONS: SourceDefinition[] = [SOURCE_DEFINITION, ...REFERENCE_SOURCE_DEFINITIONS];

const COLUMN_META: Record<string, ColumnMeta> = {
  financial_id: { label: 'Financial record', role: 'dimension' },
  transaction_id: { label: 'Transaction ID', role: 'dimension' },
  transaction_date: { label: 'Transaction date', role: 'time' },
  department_code: { label: 'Department', role: 'access' },
  category_code: { label: 'Category', role: 'dimension' },
  region_code: { label: 'Region', role: 'dimension' },
  payment_method: { label: 'Payment method', role: 'dimension' },
  currency_code: { label: 'Currency', role: 'dimension' },
  budget_amount: { label: 'Budget', role: 'measure', aggregation: 'sum', format: 'currency' },
  actual_amount: { label: 'Actual', role: 'measure', aggregation: 'sum', format: 'currency' },
  variance_amount: { label: 'Variance', role: 'measure', aggregation: 'sum', format: 'currency' },
};

const AGGREGATIONS = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_distinct']);
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const CACHE_MS = 60_000;

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw unprocessable(`Unsupported column identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteQualified(source: string): string {
  return source.split('.').map(quoteIdentifier).join('.');
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return String(value);
  return String(value);
}

function jsonValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return String(value);
  return value as string | number;
}

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dataType(columnType: string): ModelSourceColumn['data_type'] {
  const type = columnType.toUpperCase();
  if (type.includes('BOOL')) return 'boolean';
  if (type.includes('DATE') || type.includes('TIME')) return 'date';
  if (type.includes('INT')) return 'integer';
  if (type.includes('DECIMAL') || type.includes('NUMERIC') || type.includes('DOUBLE') || type.includes('FLOAT') || type.includes('REAL')) {
    return 'decimal';
  }
  return 'string';
}

function titleLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function suggestColumn(name: string, columnType: string): ColumnMeta {
  const meta = COLUMN_META[name];
  if (meta) return meta;
  const type = dataType(columnType);
  if (type === 'date') return { label: titleLabel(name), role: 'time' };
  if (type === 'integer' || type === 'decimal') {
    return {
      label: titleLabel(name),
      role: 'measure',
      aggregation: 'sum',
      format: name.includes('pct') ? 'percent' : 'number',
    };
  }
  return { label: titleLabel(name), role: 'dimension' };
}

export class AnalyticsHandle {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private catalog: { at: number; value: ModelSource[] } | null = null;

  constructor(private readonly databasePath: string) {}

  private async getConnection(): Promise<DuckDBConnection> {
    if (!existsSync(this.databasePath)) {
      throw serviceUnavailable(
        `Model preview snapshot not found at ${this.databasePath}. Run \`make data\` to build it.`
      );
    }
    if (this.connection) return this.connection;
    try {
      this.instance = await DuckDBInstance.create(this.databasePath, { access_mode: 'READ_ONLY' });
      this.connection = await this.instance.connect();
      return this.connection;
    } catch (error) {
      throw serviceUnavailable(
        `Model preview is unavailable: ${(error as Error).message}`
      );
    }
  }

  async listSources(): Promise<ModelSource[]> {
    if (this.catalog && Date.now() - this.catalog.at < CACHE_MS) return this.catalog.value;
    const connection = await this.getConnection();
    const sources: ModelSource[] = [];
    for (const definition of SOURCE_DEFINITIONS) {
      const [schema, table] = definition.table.split('.');
      if (!schema || !table) continue;
      const exists = await connection.runAndReadAll(
        `SELECT 1 AS present FROM information_schema.tables
         WHERE table_schema = ? AND table_name = ? LIMIT 1`,
        [schema, table]
      );
      if (exists.getRowObjects().length === 0) continue;
      sources.push(await this.buildSource(connection, definition));
    }
    this.catalog = { at: Date.now(), value: sources };
    return sources;
  }

  async getSource(sourceId?: string): Promise<ModelSource> {
    const sources = await this.listSources();
    const id = sourceId ?? SOURCE_DEFINITION.source_id;
    const source = sources.find((candidate) => candidate.source_id === id);
    if (!source) throw unprocessable(`Source ${id} is not available for preview`);
    return source;
  }

  async getSources(sourceIds: string[]): Promise<ModelSource[]> {
    const unique = [...new Set(sourceIds)];
    return Promise.all(unique.map((sourceId) => this.getSource(sourceId)));
  }

  private async buildSource(
    connection: DuckDBConnection,
    definition: SourceDefinition
  ): Promise<ModelSource> {
    const described = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${definition.table}`);
    const rows = described.getRowObjects();
    const rowCount = toNumber(
      (await connection.runAndReadAll(`SELECT count(*) AS n FROM ${definition.table}`)).getRowObjects()[0]?.n
    );

    const columns: ModelSourceColumn[] = [];
    for (const row of rows) {
      const name = String(row.column_name);
      const columnType = String(row.column_type);
      const stats = await connection.runAndReadAll(
        `SELECT count(*) AS total, count(DISTINCT ${quoteIdentifier(name)}) AS distinct_count,
                count(*) - count(${quoteIdentifier(name)}) AS null_count
         FROM ${definition.table}`
      );
      const sample = await connection.runAndReadAll(
        `SELECT ${quoteIdentifier(name)} AS value FROM ${definition.table}
         WHERE ${quoteIdentifier(name)} IS NOT NULL LIMIT 5`
      );
      const statRow = stats.getRowObjects()[0] ?? {};
      const meta = suggestColumn(name, columnType);
      columns.push({
        name,
        label: meta.label,
        data_type: dataType(columnType),
        nullable: String(row.null ?? 'YES').toUpperCase() !== 'NO',
        distinct_count: toNumber(statRow.distinct_count),
        null_count: toNumber(statRow.null_count),
        sample_values: sample
          .getRowObjects()
          .map((sampleRow) => displayValue(sampleRow.value))
          .filter((value): value is string => value !== null),
        suggested_role: meta.role,
        suggested_aggregation: meta.aggregation ?? null,
        format: meta.format ?? null,
      });
    }

    const grainColumn = columns.find((column) => column.name === definition.grain_key);
    return {
      ...definition,
      grain_unique: Boolean(grainColumn && grainColumn.distinct_count === rowCount),
      row_count: rowCount,
      refreshed_at: new Date().toISOString(),
      columns,
      relationships: definition.relationships,
    };
  }

  async preview(user: AuthUser, body: ModelPreviewRequest): Promise<ModelPreview> {
    const factSource = await this.getSource();
    const definition = body.definition;
    const sourceId = definition.source?.source_id ?? factSource.source_id;
    if (sourceId !== factSource.source_id) {
      throw unprocessable(`Source ${sourceId} is not available for preview`);
    }
    const factDataset = datasetNameFromSource(sourceId);

    const referenceDatasets = new Map<
      string,
      { source: string; fields: Array<Record<string, unknown>> }
    >();
    const rawDatasets = Array.isArray(definition.datasets) ? definition.datasets : [];
    for (const raw of rawDatasets) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw unprocessable('A reference dataset must be an object');
      }
      const value = raw as Record<string, unknown>;
      const name = String(value.name ?? '');
      const source = String(value.source ?? '');
      if (!name || !source) throw unprocessable('Every reference dataset needs a name and source');
      if (name === factDataset) {
        throw unprocessable(`Reference dataset ${name} collides with the principal dataset`);
      }
      if (referenceDatasets.has(name)) throw unprocessable(`Duplicate dataset ${name}`);
      referenceDatasets.set(name, {
        source,
        fields: Array.isArray(value.fields) ? (value.fields as Array<Record<string, unknown>>) : [],
      });
    }

    const datasetSources = new Map<string, ModelSource>([[factDataset, factSource]]);
    const datasetAliases = new Map<string, string>([[factDataset, 'f']]);
    let aliasIndex = 0;
    for (const [name, reference] of referenceDatasets) {
      datasetSources.set(name, await this.getSource(reference.source));
      datasetAliases.set(name, `j${aliasIndex++}`);
    }

    const factMembers = new Map<string, string>();
    for (const field of definition.dimensions) {
      if (String(field.dataset ?? factDataset) === factDataset) {
        factMembers.set(String(field.code), String(field.expression));
      }
    }
    const referenceMembers = new Map<string, Map<string, string>>();
    for (const [name, reference] of referenceDatasets) {
      referenceMembers.set(
        name,
        new Map(
          reference.fields.map((field) => [
            String(field.code ?? ''),
            String(field.expression ?? ''),
          ])
        )
      );
    }

    const joinedDatasets = new Set<string>();
    const joinClauses: string[] = [];
    const rawJoins = Array.isArray(definition.joins) ? definition.joins : [];
    for (const raw of rawJoins) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw unprocessable('A join must be an object');
      }
      const join = raw as Record<string, unknown>;
      const relationship = String(join.relationship ?? 'many_to_one');
      if (relationship !== 'many_to_one' && relationship !== 'one_to_one') {
        throw unprocessable(`Join ${String(join.name ?? '')} must be many_to_one or one_to_one`);
      }
      const sourceDataset = String(join.source_dataset ?? factDataset);
      if (sourceDataset !== factDataset) {
        throw unprocessable('Preview supports joins from the principal dataset only');
      }
      const targetDataset = String(
        join.target_dataset ??
          (join.target_model_code ? datasetNameFromSource(String(join.target_model_code)) : '')
      );
      const reference = referenceDatasets.get(targetDataset);
      if (!reference) {
        throw unprocessable(
          `Join target ${targetDataset || '(missing)'} is not a declared reference dataset`
        );
      }
      if (joinedDatasets.has(targetDataset)) {
        throw unprocessable(`Dataset ${targetDataset} is joined more than once`);
      }
      const targetSource = datasetSources.get(targetDataset)!;
      if (!targetSource.grain_unique) {
        throw unprocessable(`Reference dataset ${targetDataset} is not unique at its grain`);
      }
      const targetAlias = datasetAliases.get(targetDataset)!;
      const on = Array.isArray(join.on) ? (join.on as Array<Record<string, unknown>>) : [];
      const pairs = on.length
        ? on.map((pair) => ({
            source: String(pair.source_member ?? ''),
            target: String(pair.target_member ?? ''),
          }))
        : [
            {
              source: String(join.source_member_code ?? ''),
              target: String(join.target_member_code ?? ''),
            },
          ];
      if (pairs.some((pair) => !pair.source || !pair.target)) {
        throw unprocessable(`Join ${String(join.name ?? targetDataset)} is missing key members`);
      }
      const targetMembers = referenceMembers.get(targetDataset) ?? new Map<string, string>();
      const resolvedPairs = pairs.map((pair) => ({
        source: factMembers.get(pair.source) ?? pair.source,
        target: targetMembers.get(pair.target) ?? pair.target,
      }));
      for (const pair of resolvedPairs) {
        if (!factSource.columns.some((column) => column.name === pair.source)) {
          throw unprocessable(`Join source member ${pair.source} is not in the principal source`);
        }
        if (!targetSource.columns.some((column) => column.name === pair.target)) {
          throw unprocessable(`Join target member ${pair.target} is not in ${targetDataset}`);
        }
      }
      const conditions = resolvedPairs.map(
        (pair) => `f.${quoteIdentifier(pair.source)} = ${targetAlias}.${quoteIdentifier(pair.target)}`
      );
      joinClauses.push(
        `LEFT JOIN ${quoteQualified(reference.source)} AS ${targetAlias} ON ${conditions.join(' AND ')}`
      );
      joinedDatasets.add(targetDataset);
    }

    const dimensions = body.group_by.map((code) =>
      definition.dimensions.find((field) => field.code === code)
    );
    const measures = body.measures.map((code) =>
      definition.measures.find((field) => field.code === code)
    );

    if (dimensions.some((field) => !field)) throw unprocessable('A selected dimension is not in the model definition');
    if (measures.some((field) => !field)) throw unprocessable('A selected measure is not in the model definition');
    if (measures.length === 0) throw unprocessable('Select at least one measure to preview');
    if (body.group_by.length > 4) throw unprocessable('Preview supports at most four dimensions');
    if (body.measures.length > 6) throw unprocessable('Preview supports at most six measures');

    const selected = [...dimensions, ...measures] as Array<Record<string, unknown>>;
    if (new Set(selected.map((field) => String(field.code))).size !== selected.length) {
      throw unprocessable('Dimension and measure codes must be unique');
    }

    const accessField = String(definition.access?.row_level_field ?? 'department_code');
    if (accessField !== 'department_code') {
      throw unprocessable('The current preview supports department_code access only');
    }
    const accessDimension = definition.dimensions.find(
      (field) => String(field.code) === accessField || String(field.expression) === accessField
    );
    if (!accessDimension || String(accessDimension.dataset ?? factDataset) !== factDataset) {
      throw unprocessable(`Access field ${accessField} is not in the principal dataset`);
    }
    const accessColumn = String(accessDimension.expression ?? '');
    if (!factSource.columns.some((column) => column.name === accessColumn)) {
      throw unprocessable(`Access field ${accessField} is not in the governed source`);
    }

    const measureCodes = new Set(
      measures.map((field) => String((field as Record<string, unknown>).code))
    );
    for (const field of selected) {
      const value = field as Record<string, unknown>;
      const code = String(value.code ?? '');
      const owner = String(value.dataset ?? factDataset);
      const ownerSource = datasetSources.get(owner);
      if (!ownerSource) throw unprocessable(`Field ${code} references unknown dataset ${owner}`);
      const expression = String(value.expression ?? '');
      if (!SAFE_IDENTIFIER.test(code)) throw unprocessable(`Unsupported field code: ${code}`);
      if (!ownerSource.columns.some((column) => column.name === expression)) {
        throw unprocessable(`Expression for ${code} must reference a governed column of ${owner}`);
      }
      if (measureCodes.has(code) && owner !== factDataset) {
        throw unprocessable(`Measure ${code} must belong to the principal dataset`);
      }
      if (owner !== factDataset && !joinedDatasets.has(owner)) {
        throw unprocessable(`Dataset ${owner} is not joined by the model`);
      }
    }

    let departmentCode: string | null = null;
    let previewAs = false;
    if (user.isSteward) {
      departmentCode = body.preview_department_code ?? null;
      previewAs = Boolean(body.preview_department_code);
    } else {
      if (!user.departmentCode) throw forbidden('department scope is required');
      if (body.preview_department_code && body.preview_department_code !== user.departmentCode) {
        throw forbidden('preview_department_code is outside your scope');
      }
      departmentCode = user.departmentCode;
    }

    const select = [
      ...dimensions.map((field) => {
        const value = field as Record<string, unknown>;
        const owner = String(value.dataset ?? factDataset);
        return `${datasetAliases.get(owner)!}.${quoteIdentifier(String(value.expression))} AS ${quoteIdentifier(String(value.code))}`;
      }),
      ...measures.map((field) => {
        const value = field as Record<string, unknown>;
        return `${aggregateSql(value, 'f')} AS ${quoteIdentifier(String(value.code))}`;
      }),
    ];
    const measureSelect = measures.map((field) => {
      const value = field as Record<string, unknown>;
      return `${aggregateSql(value, 'f')} AS ${quoteIdentifier(String(value.code))}`;
    });
    const from = `${quoteQualified(factSource.source_id)} AS f${
      joinClauses.length > 0 ? ` ${joinClauses.join(' ')}` : ''
    }`;
    const groupBy = dimensions.length
      ? ` GROUP BY ${dimensions.map((_, index) => index + 1).join(', ')}`
      : '';
    const where = departmentCode ? ` WHERE f.${quoteIdentifier(accessColumn)} = ?` : '';
    const filterValues = departmentCode ? [departmentCode] : [];
    const limit = Math.min(Math.max(body.limit ?? 25, 1), 100);
    const connection = await this.getConnection();

    const previewReader = await connection.runAndReadAll(
      `SELECT ${select.join(', ')} FROM ${from}${where}${groupBy}
       ORDER BY ${dimensions.map((_, index) => index + 1).join(', ') || '1'} LIMIT ?`,
      [...filterValues, limit]
    );
    const totalsReader = await connection.runAndReadAll(
      `SELECT ${measureSelect.join(', ')} FROM ${from}${where}`,
      filterValues
    );
    const countReader = await connection.runAndReadAll(
      `SELECT count(*) AS n FROM ${from}${where}`,
      filterValues
    );

    const rows = previewReader.getRowObjects().map((row) => {
      const value: Record<string, string | number | null> = {};
      for (const [key, cell] of Object.entries(row)) value[key] = jsonValue(cell);
      return value;
    });
    const totalsRow = totalsReader.getRowObjects()[0] ?? {};
    const totals: Record<string, string | number | null> = {};
    for (const [key, cell] of Object.entries(totalsRow)) totals[key] = jsonValue(cell);

    return {
      source_id: factSource.source_id,
      columns: [
        ...dimensions.map((field) => {
          const value = field as Record<string, unknown>;
          return {
            code: String(value.code),
            name: String(value.name),
            kind: 'dimension' as const,
            data_type: String(value.data_type),
            format: null,
            currency_code: null,
          };
        }),
        ...measures.map((field) => {
          const value = field as Record<string, unknown>;
          return {
            code: String(value.code),
            name: String(value.name),
            kind: 'measure' as const,
            data_type: 'decimal',
            format: String(value.format ?? 'number'),
            currency_code: value.currency_code ? String(value.currency_code) : null,
          };
        }),
      ],
      rows,
      totals,
      row_count: toNumber(countReader.getRowObjects()[0]?.n),
      truncated: rows.length >= limit,
      scope: { department_code: departmentCode, applied: Boolean(departmentCode), preview_as: previewAs },
      generated_at: new Date().toISOString(),
    };
  }

  close(): void {
    this.connection?.closeSync();
    this.instance?.closeSync();
    this.connection = null;
    this.instance = null;
    this.catalog = null;
  }
}

function aggregateSql(field: Record<string, unknown>, alias = ''): string {
  const aggregation = String(field.aggregation ?? 'sum');
  const expression = String(field.expression ?? '');
  if (!AGGREGATIONS.has(aggregation)) {
    throw unprocessable(`Unsupported aggregation: ${aggregation}`);
  }
  if (aggregation === 'count') return 'count(*)';
  const operand = alias
    ? `${alias}.${quoteIdentifier(expression)}`
    : quoteIdentifier(expression);
  return `${aggregation === 'count_distinct' ? 'count(DISTINCT ' : `${aggregation}(`}${operand})`;
}

export function createAnalytics(databasePath: string): AnalyticsHandle {
  return new AnalyticsHandle(databasePath);
}
