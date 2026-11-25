import assert from 'node:assert/strict';
import test from 'node:test';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  CALCULATION_AUTHORING_COMPILER_VERSION,
  CalculationPlanError,
  calculationSourceHash,
  compileCalculationSource,
  compileDuckDbPlan,
} from '../src/calculation/index.js';

const columns = ['department_code', 'cost_centre_code', 'amount', 'pct', 'basis', 'pool'];

function validSource() {
  return {
    format: 'cpm-calculation-source/0',
    source: 'base_facts',
    columns,
    prql: `from base_facts
filter basis > 0 && amount >= 0
derive adjusted_amount = amount * (1 + pct)
derive ratio = adjusted_amount / basis
derive band = case [pct >= 0.05 => "high", true => "low"]
select {department_code, cost_centre_code, adjusted_amount, ratio, band}`,
    types: {
      adjusted_amount: 'decimal(18,2)',
      ratio: 'decimal(18,6)',
      band: 'string',
    },
    grain: ['department_code', 'cost_centre_code'],
    pins: { model_version_id: 'mv-test', semantic_hash: 'sha256:test', rule_version_ids: [] },
    drivers: {},
    stages: [
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
      },
      { op: 'validate', checks: ['pool_conservation'] },
      { op: 'write', format: 'parquet' },
    ],
  };
}

test('PRQL authoring compiles to the canonical plan and fills write measures from select', () => {
  const compiled = compileCalculationSource(validSource());
  const stages = compiled.plan.stages;

  assert.equal(stages[0]?.op, 'scan');
  assert.deepEqual(stages[0], {
    op: 'scan',
    source: 'base_facts',
    columns,
  });

  const filter = stages[1];
  assert.equal(filter?.op, 'filter');
  if (filter?.op === 'filter') {
    assert.ok('op' in filter.predicate);
    assert.equal(filter.predicate.op, 'and');
  }

  const derives = stages.filter((stage) => stage.op === 'derive');
  assert.equal(derives.length, 3);
  assert.deepEqual(
    derives.map((stage) => (stage.op === 'derive' ? stage.name : null)),
    ['adjusted_amount', 'ratio', 'band']
  );

  const write = stages.find((stage) => stage.op === 'write');
  assert.equal(write?.op, 'write');
  if (write?.op === 'write') {
    assert.deepEqual(write.measures, [
      'department_code',
      'cost_centre_code',
      'adjusted_amount',
      'ratio',
      'band',
    ]);
  }

  assert.equal(compiled.authoring_version, CALCULATION_AUTHORING_COMPILER_VERSION);
  assert.equal(compiled.plan.format, 'cpm-calculation-plan/0');
  assert.equal(compiled.plan.grain[0], 'department_code');
});

test('authoring and plan hashes are content-addressed and stable', () => {
  const first = compileCalculationSource(validSource());
  const second = compileCalculationSource({
    ...validSource(),
    types: {
      band: 'string',
      ratio: 'decimal(18,6)',
      adjusted_amount: 'decimal(18,2)',
    },
  });
  assert.equal(first.source_hash, second.source_hash);
  assert.equal(compileDuckDbPlan(first.plan).plan_hash, compileDuckDbPlan(second.plan).plan_hash);

  const changed = compileCalculationSource({
    ...validSource(),
    prql: validSource().prql.replace('amount >= 0', 'amount > 0'),
  });
  assert.notEqual(changed.source_hash, first.source_hash);
  assert.notEqual(compileDuckDbPlan(changed.plan).plan_hash, compileDuckDbPlan(first.plan).plan_hash);
  assert.equal(calculationSourceHash(first.source), first.source_hash);
});

test('a fractional literal becomes an exact decimal string', () => {
  const compiled = compileCalculationSource({
    ...validSource(),
    prql: `from base_facts
derive x = amount * 0.15
select {x}`,
    types: { x: 'decimal(18,2)' },
  });
  const derive = compiled.plan.stages.find((stage) => stage.op === 'derive');
  assert.equal(derive?.op, 'derive');
  if (derive?.op === 'derive') {
    assert.deepEqual(derive.expression, {
      op: 'multiply',
      args: [
        { column: 'amount' },
        { value: '0.15', type: 'decimal' },
      ],
    });
  }
});

test('logical operators, math.round and nullif reach the DuckDB compiler', () => {
  const source = validSource();
  const compiled = compileCalculationSource({
    ...source,
    prql: `from base_facts
filter (basis > 0 || amount > 0) && !(pct < 0)
derive adjusted_amount = (math.round 2 (amount * (1 + pct)))
derive safe_amount = (nullif adjusted_amount 0)
select {department_code, cost_centre_code, adjusted_amount, safe_amount}`,
    types: { adjusted_amount: 'decimal(18,2)', safe_amount: 'decimal(18,2)' },
  });
  const sql = compileDuckDbPlan(compiled.plan).sql;
  assert.match(sql, /AND/);
  assert.match(sql, /OR/);
  assert.match(sql, /NOT/);
  assert.match(sql, /ROUND/);
  assert.match(sql, /NULLIF/);
});

async function withConnection<T>(fn: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
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
        ('fin', 'cc4', 400.00, 0.020000, 10.0000, 100.00)
    `);
    return await fn(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

test('the compiled authoring plan executes on DuckDB with pool conservation', async () => {
  const compiled = compileCalculationSource(validSource());
  const duck = compileDuckDbPlan(compiled.plan);
  await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT department_code, cost_centre_code,
              CAST(adjusted_amount AS VARCHAR) AS adjusted_amount,
              CAST(ratio AS VARCHAR) AS ratio,
              band
       FROM (${duck.sql}) result
       ORDER BY department_code, cost_centre_code`
    );
    const rows = reader.getRowObjectsJson();
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => [row.department_code, row.cost_centre_code, row.adjusted_amount, row.ratio, row.band]),
      [
        ['fin', 'cc4', '408.00', '40.800000', 'low'],
        ['ops', 'cc1', '110.00', '110.000000', 'high'],
        ['ops', 'cc2', '200.00', '200.000000', 'low'],
        ['ops', 'cc3', '315.00', '315.000000', 'high'],
      ]
    );
    const check = await connection.runAndReadAll(duck.validations[0]!.sql);
    assert.equal(check.getRowObjectsJson().length, 0);
  });
});

test('unsafe or unsupported PRQL is rejected with a path', () => {
  const base = validSource();
  const cases: Array<[string, unknown, string]> = [
    [
      's-string',
      { ...base, prql: `from base_facts\nderive x = s"1); DROP TABLE z; --"\nselect {x}`, types: { x: 'string' } },
      'unsupported_sstring',
    ],
    [
      'join',
      { ...base, prql: `from base_facts\njoin other (==cost_centre_code)\nselect {department_code}` },
      'unsupported_transform',
    ],
    [
      'unsupported function',
      {
        ...base,
        prql: `from base_facts\nderive x = (math.abs amount)\nselect {x}`,
        types: { x: 'decimal(18,2)' },
      },
      'unsupported_function',
    ],
    [
      'unknown column',
      {
        ...base,
        prql: `from base_facts\nderive x = missing_column + 1\nselect {x}`,
        types: { x: 'decimal(18,2)' },
      },
      'unknown_column',
    ],
    [
      'missing type',
      { ...base, prql: `from base_facts\nderive x = amount\nselect {x}` },
      'missing_type',
    ],
    [
      'source mismatch',
      { ...base, prql: `from other_table\nselect {department_code}` },
      'source_mismatch',
    ],
    [
      'unused type',
      { ...base, types: { ...base.types, unused: 'decimal(18,2)' } },
      'unused_type',
    ],
  ];

  for (const [name, input, code] of cases) {
    assert.throws(
      () => compileCalculationSource(input),
      (error: unknown) => {
        assert.ok(error instanceof CalculationPlanError, `${name}: expected CalculationPlanError`);
        assert.equal(error.code, code, `${name}: ${error.message}`);
        assert.ok(error.path.startsWith('/'), `${name}: expected a path`);
        return true;
      },
      name
    );
  }
});
