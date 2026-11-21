import assert from 'node:assert/strict';
import test from 'node:test';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  CalculationPlanError,
  calculationPlanHash,
  compileDuckDbPlan,
  validateCalculationPlan,
  type CalculationPlan,
} from '../src/calculation/index.js';

type Row = Record<string, unknown>;

async function withConnection<T>(fn: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    return await fn(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function query(connection: DuckDBConnection, sql: string): Promise<Row[]> {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJson() as Row[];
}

async function createFixture(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    CREATE TABLE base_facts (
      department_code VARCHAR NOT NULL,
      cost_centre_code VARCHAR NOT NULL,
      amount DECIMAL(18,2) NOT NULL,
      pct DECIMAL(9,6) NOT NULL,
      basis DECIMAL(18,4) NOT NULL,
      pool DECIMAL(18,2) NOT NULL
    )
  `);
  await connection.run(`
    INSERT INTO base_facts VALUES
      ('ops', 'cc1', 100.00, 0.100000, 1.0000, 100.00),
      ('ops', 'cc2', 200.00, 0.000000, 1.0000, 100.00),
      ('ops', 'cc3', 300.00, 0.050000, 1.0000, 100.00),
      ('fin', 'cc4', 400.00, 0.020000, 10.0000, 100.00),
      ('fin', 'cc5', 500.00, 0.000000, 0.0000, 100.00),
      ('fin', 'cc6', 600.00, 0.010000, 30.0000, 100.00),
      ('fin', 'cc7', 700.00, 0.030000, 60.0000, 100.00)
  `);
}

function basePlan(): CalculationPlan {
  return {
    format: 'cpm-calculation-plan/0',
    grain: ['department_code', 'cost_centre_code'],
    pins: {
      model_version_id: 'mv-test',
      semantic_hash: 'sha256:test',
      rule_version_ids: ['rv-test'],
    },
    drivers: {
      growth_factor: { value: '1.02', type: 'decimal', applies_to: 'amount' },
      usage_uplift: { value: '1.02', type: 'decimal', applies_to: 'basis' },
    },
    stages: [
      {
        op: 'scan',
        source: 'base_facts',
        columns: ['department_code', 'cost_centre_code', 'amount', 'pct', 'basis', 'pool'],
      },
      {
        op: 'derive',
        name: 'adjusted_amount',
        type: 'decimal(18,2)',
        expression: {
          op: 'multiply',
          args: [
            { column: 'amount' },
            { op: 'add', args: [{ value: '1', type: 'integer' }, { column: 'pct' }] },
          ],
        },
      },
      {
        op: 'derive',
        name: 'forecast_amount',
        type: 'decimal(18,2)',
        expression: { op: 'multiply', args: [{ column: 'amount' }, { param: 'growth_factor' }] },
      },
      {
        op: 'derive',
        name: 'ratio',
        type: 'decimal(18,6)',
        expression: { op: 'divide', args: [{ column: 'amount' }, { column: 'basis' }] },
      },
      {
        op: 'allocate',
        pool: 'pool',
        basis: 'basis',
        partition_by: ['department_code'],
        eligible: { op: 'gt', args: [{ column: 'basis' }, { value: '0', type: 'integer' }] },
        strategy: 'proportional',
        rounding: { scale: 2, mode: 'half_away_from_zero' },
        residual: { assign: 'last', order_by: ['cost_centre_code'] },
        tolerance: '0.01',
        output: 'allocated_amount',
      },
      { op: 'validate', checks: ['pool_conservation'] },
      {
        op: 'write',
        format: 'parquet',
        measures: ['adjusted_amount', 'forecast_amount', 'ratio', 'allocated_amount'],
      },
    ],
  };
}

test('calculation plan compiles deterministically and hashes its content', () => {
  const first = compileDuckDbPlan(basePlan());
  const second = compileDuckDbPlan(basePlan());

  assert.equal(first.sql, second.sql);
  assert.equal(first.plan_hash, second.plan_hash);
  assert.equal(first.compiler_version, 'calculation-compiler/0');
  assert.match(first.sql, /CAST\(/);
  assert.match(first.sql, /NULLIF\(/);
});

test('DuckDB target executes derived measures, allocation and validation', async () => {
  await withConnection(async (connection) => {
    await createFixture(connection);
    const compiled = compileDuckDbPlan(basePlan());
    const rows = await query(
      connection,
      `SELECT department_code, cost_centre_code,
              CAST(adjusted_amount AS VARCHAR) AS adjusted_amount,
              CAST(forecast_amount AS VARCHAR) AS forecast_amount,
              CAST(ratio AS VARCHAR) AS ratio,
              CAST(allocated_amount AS VARCHAR) AS allocated_amount
       FROM (${compiled.sql}) result
       ORDER BY department_code, cost_centre_code`
    );

    assert.equal(rows.length, 7);
    const byKey = new Map(rows.map((row) => [`${row.department_code}/${row.cost_centre_code}`, row]));

    assert.equal(byKey.get('ops/cc1')?.adjusted_amount, '110.00');
    assert.equal(byKey.get('ops/cc1')?.forecast_amount, '102.00');
    assert.equal(byKey.get('ops/cc1')?.ratio, '100.000000');
    assert.equal(byKey.get('ops/cc1')?.allocated_amount, '33.33');

    assert.equal(byKey.get('ops/cc2')?.adjusted_amount, '200.00');
    assert.equal(byKey.get('ops/cc2')?.allocated_amount, '33.33');

    assert.equal(byKey.get('ops/cc3')?.adjusted_amount, '315.00');
    assert.equal(byKey.get('ops/cc3')?.allocated_amount, '33.34');

    assert.equal(byKey.get('fin/cc4')?.ratio, '40.000000');
    assert.equal(byKey.get('fin/cc4')?.allocated_amount, '10.00');

    // Zero basis: preserved in the result, excluded from the allocation pool.
    assert.equal(byKey.get('fin/cc5')?.ratio, null);
    assert.equal(byKey.get('fin/cc5')?.allocated_amount, '0.00');

    assert.equal(byKey.get('fin/cc6')?.allocated_amount, '30.00');
    assert.equal(byKey.get('fin/cc7')?.ratio, '11.666667');
    assert.equal(byKey.get('fin/cc7')?.allocated_amount, '60.00');

    const totals = await query(
      connection,
      `SELECT department_code, CAST(SUM(allocated_amount) AS VARCHAR) AS total
       FROM (${compiled.sql}) result
       GROUP BY department_code
       ORDER BY department_code`
    );
    assert.deepEqual(
      totals.map((row) => [row.department_code, row.total]),
      [
        ['fin', '100.00'],
        ['ops', '100.00'],
      ]
    );

    const validation = compiled.validations.find((item) => item.check === 'pool_conservation');
    assert.ok(validation);
    const violations = await query(connection, validation.sql);
    assert.deepEqual(violations, []);
  });
});

test('division by zero stays NULL and decimal, not infinity', async () => {
  await withConnection(async (connection) => {
    await createFixture(connection);
    const compiled = compileDuckDbPlan(basePlan());
    const [row] = await query(
      connection,
      `SELECT CAST(ratio AS VARCHAR) AS ratio, typeof(ratio) AS ratio_type
       FROM (${compiled.sql}) result
       WHERE cost_centre_code = 'cc5'`
    );
    assert.equal(row?.ratio, null);
    assert.equal(row?.ratio_type, 'DECIMAL(18,6)');
  });
});

test('driver parameters are resolved from the plan', () => {
  const compiled = compileDuckDbPlan(basePlan());
  assert.match(compiled.sql, /1\.02/);
});

test('plan hash is stable across object key order', () => {
  const plan = validateCalculationPlan(basePlan());
  const shuffled = JSON.parse(
    JSON.stringify({
      stages: plan.stages,
      drivers: plan.drivers,
      pins: plan.pins,
      grain: plan.grain,
      format: plan.format,
    })
  ) as CalculationPlan;
  assert.equal(calculationPlanHash(plan), calculationPlanHash(validateCalculationPlan(shuffled)));
});

test('unsafe identifiers and raw operators are rejected', () => {
  const unsafeColumn = basePlan() as unknown as {
    stages: Array<{ columns?: string[] }>;
  };
  const scan = unsafeColumn.stages[0];
  assert.ok(scan);
  scan.columns = ['amount; DROP TABLE base_facts'];

  assert.throws(
    () => validateCalculationPlan(unsafeColumn),
    (error: unknown) =>
      error instanceof CalculationPlanError && error.code === 'invalid_identifier'
  );

  const rawOperator: any = basePlan();
  rawOperator.stages[1].expression = { op: 'raw', args: [{ value: '1', type: 'integer' }] };
  assert.throws(
    () => validateCalculationPlan(rawOperator),
    (error: unknown) =>
      error instanceof CalculationPlanError && error.code === 'unsupported_operator'
  );
});

test('string literals are escaped', () => {
  const plan: any = basePlan();
  plan.stages.splice(1, 0, {
    op: 'filter',
    predicate: {
      op: 'eq',
      args: [{ column: 'department_code' }, { value: "O'Brien", type: 'string' }],
    },
  });
  const compiled = compileDuckDbPlan(plan);
  assert.match(compiled.sql, /'O''Brien'/);
});

test('unsupported rounding modes are rejected', () => {
  const plan: any = basePlan();
  const allocate = plan.stages.find((stage: any) => stage.op === 'allocate');
  assert.ok(allocate);
  allocate.rounding.mode = 'half_to_even';
  assert.throws(
    () => validateCalculationPlan(plan),
    (error: unknown) =>
      error instanceof CalculationPlanError && error.code === 'unsupported_rounding'
  );
});

test('the first stage must be scan', () => {
  const plan: any = basePlan();
  plan.stages.shift();
  assert.throws(
    () => validateCalculationPlan(plan),
    (error: unknown) =>
      error instanceof CalculationPlanError && error.message.includes('first stage must be scan')
  );
});
