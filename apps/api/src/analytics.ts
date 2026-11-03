import { existsSync } from 'node:fs';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { AuthUser } from './auth.js';
import type { ModelDefinition, ModelPreviewRequest } from './contracts.js';
import { forbidden, serviceUnavailable, unprocessable } from './errors.js';

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
  private catalog: { at: number; value: ModelSource } | null = null;

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
    const source = await this.getSource();
    return [source];
  }

  async getSource(): Promise<ModelSource> {
    if (this.catalog && Date.now() - this.catalog.at < CACHE_MS) return this.catalog.value;
    const connection = await this.getConnection();
    const described = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${SOURCE_DEFINITION.table}`);
    const rows = described.getRowObjects();
    const rowCount = toNumber(
      (await connection.runAndReadAll(`SELECT count(*) AS n FROM ${SOURCE_DEFINITION.table}`)).getRowObjects()[0]?.n
    );

    const columns: ModelSourceColumn[] = [];
    for (const row of rows) {
      const name = String(row.column_name);
      const columnType = String(row.column_type);
      const stats = await connection.runAndReadAll(
        `SELECT count(*) AS total, count(DISTINCT ${quoteIdentifier(name)}) AS distinct_count,
                count(*) - count(${quoteIdentifier(name)}) AS null_count
         FROM ${SOURCE_DEFINITION.table}`
      );
      const sample = await connection.runAndReadAll(
        `SELECT ${quoteIdentifier(name)} AS value FROM ${SOURCE_DEFINITION.table}
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

    const grainColumn = columns.find((column) => column.name === SOURCE_DEFINITION.grain_key);
    const source: ModelSource = {
      ...SOURCE_DEFINITION,
      grain_unique: Boolean(grainColumn && grainColumn.distinct_count === rowCount),
      row_count: rowCount,
      refreshed_at: new Date().toISOString(),
      columns,
      relationships: SOURCE_DEFINITION.relationships,
    };
    this.catalog = { at: Date.now(), value: source };
    return source;
  }

  async preview(user: AuthUser, body: ModelPreviewRequest): Promise<ModelPreview> {
    const source = await this.getSource();
    const definition = body.definition;
    const sourceId = definition.source?.source_id ?? source.source_id;
    if (sourceId !== source.source_id) {
      throw unprocessable(`Source ${sourceId} is not available for preview`);
    }

    const available = new Map(source.columns.map((column) => [column.name, column]));
    const dimensions = body.group_by.map((code) => definition.dimensions.find((field) => field.code === code));
    const measures = body.measures.map((code) => definition.measures.find((field) => field.code === code));

    if (dimensions.some((field) => !field)) throw unprocessable('A selected dimension is not in the model definition');
    if (measures.some((field) => !field)) throw unprocessable('A selected measure is not in the model definition');
    if (measures.length === 0) throw unprocessable('Select at least one measure to preview');
    if (body.group_by.length > 4) throw unprocessable('Preview supports at most four dimensions');
    if (body.measures.length > 6) throw unprocessable('Preview supports at most six measures');

    const selected = [...dimensions, ...measures] as Array<Record<string, unknown>>;
    if (new Set(selected.map((field) => String(field.code))).size !== selected.length) {
      throw unprocessable('Dimension and measure codes must be unique');
    }

    const accessField = definition.access?.row_level_field ?? 'department_code';
    if (accessField !== 'department_code') {
      throw unprocessable('The current preview supports department_code access only');
    }
    if (!available.has(accessField)) {
      throw unprocessable(`Access field ${accessField} is not in the governed source`);
    }

    for (const field of selected) {
      const expression = String(field.expression ?? '');
      const code = String(field.code ?? '');
      if (!SAFE_IDENTIFIER.test(code)) throw unprocessable(`Unsupported field code: ${code}`);
      if (!available.has(expression)) {
        throw unprocessable(`Expression for ${code} must reference a governed source column`);
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
      ...dimensions.map((field) => `${quoteIdentifier(String((field as Record<string, unknown>).expression))} AS ${quoteIdentifier(String((field as Record<string, unknown>).code))}`),
      ...measures.map((field) => `${aggregateSql(field as Record<string, unknown>)} AS ${quoteIdentifier(String((field as Record<string, unknown>).code))}`),
    ];
    const groupBy = dimensions.length
      ? ` GROUP BY ${dimensions.map((_, index) => index + 1).join(', ')}`
      : '';
    const where = departmentCode ? ` WHERE ${quoteIdentifier(accessField)} = ?` : '';
    const filterValues = departmentCode ? [departmentCode] : [];
    const limit = Math.min(Math.max(body.limit ?? 25, 1), 100);
    const connection = await this.getConnection();

    const previewReader = await connection.runAndReadAll(
      `SELECT ${select.join(', ')} FROM ${SOURCE_DEFINITION.table}${where}${groupBy}
       ORDER BY ${dimensions.map((_, index) => index + 1).join(', ') || '1'} LIMIT ?`,
      [...filterValues, limit]
    );
    const totalsReader = await connection.runAndReadAll(
      `SELECT ${measures.map((field) => `${aggregateSql(field as Record<string, unknown>)} AS ${quoteIdentifier(String((field as Record<string, unknown>).code))}`).join(', ')}
       FROM ${SOURCE_DEFINITION.table}${where}`,
      filterValues
    );
    const countReader = await connection.runAndReadAll(
      `SELECT count(*) AS n FROM ${SOURCE_DEFINITION.table}${where}`,
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
      source_id: source.source_id,
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

function aggregateSql(field: Record<string, unknown>): string {
  const aggregation = String(field.aggregation ?? 'sum');
  const expression = String(field.expression ?? '');
  if (!AGGREGATIONS.has(aggregation)) {
    throw unprocessable(`Unsupported aggregation: ${aggregation}`);
  }
  if (aggregation === 'count') return 'count(*)';
  return `${aggregation === 'count_distinct' ? 'count(DISTINCT ' : `${aggregation}(`}${quoteIdentifier(expression)})`;
}

export function createAnalytics(databasePath: string): AnalyticsHandle {
  return new AnalyticsHandle(databasePath);
}
