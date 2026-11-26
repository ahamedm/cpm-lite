import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { validateCalculationPlan } from '../src/calculation/index.js';
import { executeScenarioPlan } from '../src/worker/scenario-executor.js';

async function createAnalyticsDb(dir: string): Promise<string> {
  const dbPath = path.join(dir, 'analytics.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run(`
    CREATE SCHEMA gold;
    CREATE TABLE gold.fact_financials (
      department_code VARCHAR NOT NULL,
      budget_amount DECIMAL(18,2) NOT NULL,
      actual_amount DECIMAL(18,2) NOT NULL,
      variance_amount DECIMAL(18,2) NOT NULL
    );
    INSERT INTO gold.fact_financials VALUES
      ('finance', 100.00, 110.00, 10.00),
      ('finance', 200.00, 180.00, -20.00),
      ('hr', 300.00, 310.00, 10.00);
    CREATE TABLE gold.dim_department (
      department_code VARCHAR NOT NULL,
      department_name VARCHAR NOT NULL
    );
    INSERT INTO gold.dim_department VALUES
      ('finance', 'Finance'),
      ('hr', 'Human Resources');
    CREATE TABLE gold.base_facts (
      department_code VARCHAR NOT NULL,
      cost_centre_code VARCHAR NOT NULL,
      pool DECIMAL(18,2) NOT NULL,
      basis DECIMAL(18,4) NOT NULL
    );
    INSERT INTO gold.base_facts VALUES
      ('ops', 'cc1', 100.00, 1.0000),
      ('ops', 'cc2', 100.00, 1.0000),
      ('ops', 'cc3', 100.00, 1.0000),
      ('fin', 'cc4', 100.00, 10.0000),
      ('fin', 'cc5', 100.00, 0.0000),
      ('fin', 'cc6', 100.00, 30.0000),
      ('fin', 'cc7', 100.00, 60.0000);
  `);
  connection.closeSync();
  instance.closeSync();
  return dbPath;
}

test('executes a derived plan and writes a job-scoped Parquet result', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-worker-test-'));
  try {
    const analyticsDbPath = await createAnalyticsDb(dir);
    const resultsDir = path.join(dir, 'results');
    const plan = validateCalculationPlan({
      format: 'cpm-calculation-plan/0',
      grain: ['department_code'],
      pins: {
        model_version_id: 'mv-worker-test',
        semantic_hash: 'sha256:test',
        rule_version_ids: [],
      },
      drivers: {},
      stages: [
        {
          op: 'scan',
          source: 'gold.fact_financials',
          columns: ['department_code', 'budget_amount', 'actual_amount', 'variance_amount'],
        },
        {
          op: 'derive',
          name: 'adjusted_budget',
          type: 'decimal(18,2)',
          expression: {
            op: 'multiply',
            args: [{ column: 'budget_amount' }, { value: '1.05', type: 'decimal' }],
          },
        },
        {
          op: 'write',
          format: 'parquet',
          measures: ['adjusted_budget', 'actual_amount', 'variance_amount'],
          summary: {
            budget_measure: 'adjusted_budget',
            actual_measure: 'actual_amount',
            variance_measure: 'variance_amount',
            currency_code: 'USD',
          },
        },
      ],
    });

    const result = await executeScenarioPlan({
      plan,
      analyticsDbPath,
      resultsDir,
      repoRoot: dir,
      scenarioVersionId: 'sv-1',
      jobId: 'job-1',
      currencyCode: 'USD',
    });

    assert.equal(result.result_uri, path.join('results', 'sv-1', 'job-1.parquet'));
    assert.ok(existsSync(path.join(resultsDir, 'sv-1', 'job-1.parquet')));
    assert.equal(result.totals.budget_amount, '630.00');
    assert.equal(result.totals.actual_amount, '600.00');
    assert.equal(result.totals.variance_amount, '0.00');
    assert.equal(result.totals.currency_code, 'USD');
    assert.equal(result.totals.budget_measure, 'adjusted_budget');
    assert.equal(result.allocation_summary.strategy, 'none');
    assert.equal(result.allocation_summary.within_tolerance, true);
    assert.deepEqual(result.rule_outcomes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executes an allocation plan and reports the allocation summary', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-worker-test-'));
  try {
    const analyticsDbPath = await createAnalyticsDb(dir);
    const resultsDir = path.join(dir, 'results');
    const plan = validateCalculationPlan({
      format: 'cpm-calculation-plan/0',
      grain: ['department_code', 'cost_centre_code'],
      pins: {
        model_version_id: 'mv-worker-test',
        semantic_hash: 'sha256:test',
        rule_version_ids: [],
      },
      drivers: {},
      stages: [
        {
          op: 'scan',
          source: 'gold.base_facts',
          columns: ['department_code', 'cost_centre_code', 'pool', 'basis'],
        },
        {
          op: 'allocate',
          pool: 'pool',
          basis: 'basis',
          partition_by: ['department_code'],
          strategy: 'proportional',
          rounding: { scale: 2, mode: 'half_away_from_zero' },
          residual: { assign: 'last', order_by: ['cost_centre_code'] },
          tolerance: '0.01',
          output: 'allocated_amount',
        },
        {
          op: 'write',
          format: 'parquet',
          measures: ['allocated_amount'],
          summary: { budget_measure: 'allocated_amount', currency_code: 'USD' },
        },
      ],
    });

    const result = await executeScenarioPlan({
      plan,
      analyticsDbPath,
      resultsDir,
      repoRoot: dir,
      scenarioVersionId: 'sv-2',
      jobId: 'job-2',
      currencyCode: 'USD',
    });

    assert.equal(result.totals.budget_amount, '200.00');
    assert.equal(result.allocation_summary.pool_total, '200.00');
    assert.equal(result.allocation_summary.allocated_total, '200.00');
    assert.equal(result.allocation_summary.residual, '0.00');
    assert.equal(result.allocation_summary.tolerance, '0.02');
    assert.equal(result.allocation_summary.within_tolerance, true);
    assert.equal(result.allocation_summary.strategy, 'proportional');
    assert.equal(result.allocation_summary.driver_basis, 'basis');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function joinPlan() {
  return validateCalculationPlan({
    format: 'cpm-calculation-plan/0',
    grain: ['department_code'],
    pins: {
      model_version_id: 'mv-worker-test',
      semantic_hash: 'sha256:test',
      rule_version_ids: [],
    },
    drivers: {},
    stages: [
      {
        op: 'scan',
        source: 'gold.fact_financials',
        columns: ['department_code', 'budget_amount', 'actual_amount', 'variance_amount'],
      },
      {
        op: 'join',
        source: 'gold.dim_department',
        alias: 'd',
        type: 'left',
        on: [{ left: 'department_code', right: 'department_code' }],
        columns: [{ name: 'department_name', as: 'department_name' }],
      },
      {
        op: 'write',
        format: 'parquet',
        measures: ['department_code', 'department_name', 'budget_amount', 'actual_amount', 'variance_amount'],
        summary: {
          budget_measure: 'budget_amount',
          actual_measure: 'actual_amount',
          variance_measure: 'variance_amount',
          currency_code: 'USD',
        },
      },
    ],
  });
}

test('executes a plan with a reference join', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-worker-test-'));
  try {
    const analyticsDbPath = await createAnalyticsDb(dir);
    const resultsDir = path.join(dir, 'results');
    const result = await executeScenarioPlan({
      plan: joinPlan(),
      analyticsDbPath,
      resultsDir,
      repoRoot: dir,
      scenarioVersionId: 'sv-3',
      jobId: 'job-3',
      currencyCode: 'USD',
    });

    assert.equal(result.totals.budget_amount, '600.00');
    assert.equal(result.totals.actual_amount, '600.00');
    assert.equal(result.totals.variance_amount, '0.00');

    const resultPath = path.join(resultsDir, 'sv-3', 'job-3.parquet');
    assert.ok(existsSync(resultPath));
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(
        `SELECT department_code, department_name, CAST(budget_amount AS VARCHAR) AS budget_amount
         FROM read_parquet('${resultPath.replaceAll("'", "''")}')
         ORDER BY department_code, budget_amount`
      );
      assert.deepEqual(
        reader.getRowObjects().map((row) => [
          row.department_code,
          row.department_name,
          row.budget_amount,
        ]),
        [
          ['finance', 'Finance', '100.00'],
          ['finance', 'Finance', '200.00'],
          ['hr', 'Human Resources', '300.00'],
        ]
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a join with duplicate target keys before writing a result', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-worker-test-'));
  try {
    const analyticsDbPath = await createAnalyticsDb(dir);
    const instance = await DuckDBInstance.create(analyticsDbPath);
    const connection = await instance.connect();
    await connection.run(`INSERT INTO gold.dim_department VALUES ('finance', 'Finance duplicate')`);
    connection.closeSync();
    instance.closeSync();

    const resultsDir = path.join(dir, 'results');
    await assert.rejects(
      () =>
        executeScenarioPlan({
          plan: joinPlan(),
          analyticsDbPath,
          resultsDir,
          repoRoot: dir,
          scenarioVersionId: 'sv-4',
          jobId: 'job-4',
          currencyCode: 'USD',
        }),
      /join_key_uniqueness/
    );
    assert.equal(existsSync(path.join(resultsDir, 'sv-4', 'job-4.parquet')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
