import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  compileDuckDbPlan,
  validateCalculationPlan,
  type AllocateStage,
  type CalculationPlan,
  type WriteStage,
} from '../calculation/index.js';

export interface ScenarioExecutionInput {
  plan: CalculationPlan;
  analyticsDbPath: string;
  resultsDir: string;
  repoRoot: string;
  scenarioVersionId: string;
  jobId: string;
  currencyCode: string;
}

export interface ScenarioExecutionResult {
  result_uri: string;
  totals: {
    budget_amount: string;
    actual_amount: string;
    variance_amount: string;
    currency_code: string;
    budget_measure: string;
    actual_measure: string | null;
    variance_measure: string | null;
  };
  allocation_summary: {
    pool_total: string;
    allocated_total: string;
    residual: string;
    tolerance: string;
    within_tolerance: boolean;
    strategy: string;
    driver_basis: string | null;
  };
  rule_outcomes: [];
  completed_at: string;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isMoneyType(type: string): boolean {
  return /^DECIMAL\(\d+,2\)$/i.test(type);
}

function isNumericType(type: string): boolean {
  return /^(DECIMAL|INTEGER|BIGINT|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|REAL)/i.test(type);
}

function firstNumericMeasure(
  measures: string[],
  columns: Map<string, string>
): string | null {
  for (const measure of measures) {
    const type = columns.get(measure);
    if (type && isMoneyType(type)) return measure;
  }
  for (const measure of measures) {
    const type = columns.get(measure);
    if (type && isNumericType(type)) return measure;
  }
  return null;
}

function sumSql(column: string | null): string {
  if (!column) return 'CAST(0 AS DECIMAL(18,2))';
  return `CAST(COALESCE(SUM(CAST(${quote(column)} AS DECIMAL(38,2))), 0) AS DECIMAL(18,2))`;
}

async function describeColumns(
  connection: DuckDBConnection,
  parquetPath: string
): Promise<Map<string, string>> {
  const reader = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet(${sqlString(parquetPath)})`
  );
  const rows = reader.getRowObjectsJson() as Array<Record<string, unknown>>;
  const columns = new Map<string, string>();
  for (const row of rows) {
    const name = row.column_name;
    const type = row.column_type;
    if (typeof name === 'string' && typeof type === 'string') columns.set(name, type);
  }
  return columns;
}

function createSourceViewSql(scanSource: string): string {
  const parts = scanSource.split('.');
  if (parts.length > 2) {
    throw new Error('Only one- or two-part source names are supported by the local worker');
  }
  const target = parts.map(quote).join('.');
  if (parts.length === 2) {
    return `CREATE SCHEMA IF NOT EXISTS ${quote(parts[0]!)}; CREATE VIEW ${target} AS SELECT * FROM analytics.${target}`;
  }
  return `CREATE VIEW ${target} AS SELECT * FROM analytics.${target}`;
}

async function allocationSummary(
  connection: DuckDBConnection,
  parquetPath: string,
  allocation: AllocateStage
): Promise<ScenarioExecutionResult['allocation_summary']> {
  const partition = allocation.partition_by.map(quote).join(', ');
  const output = allocation.output ?? 'allocated_amount';
  const reader = await connection.runAndReadAll(`
    WITH result AS (SELECT * FROM read_parquet(${sqlString(parquetPath)})),
    pools AS (
      SELECT ${partition}, MAX(${quote(allocation.pool)}) AS pool
      FROM result
      GROUP BY ${partition}
    ),
    totals AS (SELECT CAST(SUM(pool) AS DECIMAL(18,2)) AS pool_total FROM pools),
    allocated AS (SELECT CAST(SUM(${quote(output)}) AS DECIMAL(18,2)) AS allocated_total FROM result),
    tol AS (
      SELECT CAST(COUNT(*) * CAST(${allocation.tolerance} AS DECIMAL(18,2)) AS DECIMAL(18,2)) AS tolerance
      FROM pools
    )
    SELECT CAST(pool_total AS VARCHAR) AS pool_total,
           CAST(allocated_total AS VARCHAR) AS allocated_total,
           CAST(pool_total - allocated_total AS VARCHAR) AS residual,
           CAST(tolerance AS VARCHAR) AS tolerance,
           ABS(pool_total - allocated_total) <= tolerance AS within_tolerance
    FROM totals, allocated, tol
  `);
  const [row] = reader.getRowObjectsJson() as Array<Record<string, unknown>>;
  return {
    pool_total: String(row?.pool_total ?? '0.00'),
    allocated_total: String(row?.allocated_total ?? '0.00'),
    residual: String(row?.residual ?? '0.00'),
    tolerance: String(row?.tolerance ?? '0.00'),
    within_tolerance: Boolean(row?.within_tolerance),
    strategy: allocation.strategy,
    driver_basis: allocation.basis,
  };
}

/**
 * Execute one pinned calculation plan in an isolated in-memory DuckDB.
 *
 * The analytical store is attached read-only and exposed through a view at the
 * plan's declared source. Results are written to a job-scoped Parquet path;
 * Gold is never written.
 */
export async function executeScenarioPlan(
  input: ScenarioExecutionInput
): Promise<ScenarioExecutionResult> {
  const plan = validateCalculationPlan(input.plan);
  const compiled = compileDuckDbPlan(plan);
  const scan = plan.stages.find((stage) => stage.op === 'scan');
  if (!scan || scan.op !== 'scan') throw new Error('Plan has no scan stage');
  const write = plan.stages.find((stage) => stage.op === 'write') as WriteStage | undefined;
  const allocation = plan.stages.find((stage) => stage.op === 'allocate') as AllocateStage | undefined;

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    if (!scan.artifact) {
      await connection.run(
        `ATTACH ${sqlString(input.analyticsDbPath)} AS analytics (READ_ONLY)`
      );
      await connection.run(createSourceViewSql(scan.source));
    }

    const resultDir = path.join(input.resultsDir, input.scenarioVersionId);
    mkdirSync(resultDir, { recursive: true });
    const resultPath = path.join(resultDir, `${input.jobId}.parquet`);
    await connection.run(
      `COPY (${compiled.sql}) TO ${sqlString(resultPath)} (FORMAT PARQUET)`
    );

    const columns = await describeColumns(connection, resultPath);
    const measures = write?.measures ?? [...columns.keys()];
    const summary = write?.summary;
    const budgetMeasure =
      summary?.budget_measure ??
      (columns.has('budget_amount') ? 'budget_amount' : firstNumericMeasure(measures, columns));
    if (!budgetMeasure) {
      throw new Error('No numeric result measure is available for the job summary');
    }
    const actualMeasure =
      summary?.actual_measure ?? (columns.has('actual_amount') ? 'actual_amount' : null);
    const varianceMeasure =
      summary?.variance_measure ?? (columns.has('variance_amount') ? 'variance_amount' : null);
    const currencyCode = summary?.currency_code ?? input.currencyCode;

    const totalsReader = await connection.runAndReadAll(`
      SELECT CAST(${sumSql(budgetMeasure)} AS VARCHAR) AS budget_amount,
             CAST(${sumSql(actualMeasure)} AS VARCHAR) AS actual_amount,
             CAST(${sumSql(varianceMeasure)} AS VARCHAR) AS variance_amount
      FROM read_parquet(${sqlString(resultPath)})
    `);
    const [totalsRow] = totalsReader.getRowObjectsJson() as Array<Record<string, unknown>>;

    const relativeResultPath = path.relative(input.repoRoot, resultPath);
    const resultUri =
      relativeResultPath.startsWith('..') || path.isAbsolute(relativeResultPath)
        ? resultPath
        : relativeResultPath;

    return {
      result_uri: resultUri,
      totals: {
        budget_amount: String(totalsRow?.budget_amount ?? '0.00'),
        actual_amount: String(totalsRow?.actual_amount ?? '0.00'),
        variance_amount: String(totalsRow?.variance_amount ?? '0.00'),
        currency_code: currencyCode,
        budget_measure: budgetMeasure,
        actual_measure: actualMeasure,
        variance_measure: varianceMeasure,
      },
      allocation_summary: allocation
        ? await allocationSummary(connection, resultPath, allocation)
        : {
            pool_total: '0.00',
            allocated_total: '0.00',
            residual: '0.00',
            tolerance: '0.00',
            within_tolerance: true,
            strategy: 'none',
            driver_basis: null,
          },
      rule_outcomes: [],
      completed_at: new Date().toISOString(),
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
