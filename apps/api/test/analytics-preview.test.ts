import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { createAnalytics } from '../src/analytics.js';
import type { AuthUser } from '../src/auth.js';

const DEFINITION = {
  schema_version: '1.1',
  source: { source_id: 'gold.fact_financials' },
  access: { row_level_field: 'department_code' },
  grain: ['department_code'],
  datasets: [
    {
      name: 'dim_department',
      source: 'gold.dim_department',
      primary_key: ['department_code'],
      fields: [
        { code: 'department_code', name: 'Department code', data_type: 'string', expression: 'department_code' },
        { code: 'department_name', name: 'Department name', data_type: 'string', expression: 'department_name' },
      ],
    },
  ],
  dimensions: [
    { code: 'department_code', name: 'Department', data_type: 'string', expression: 'department_code' },
    { code: 'department_name', name: 'Department name', data_type: 'string', expression: 'department_name', dataset: 'dim_department' },
  ],
  measures: [
    { code: 'budget_amount', name: 'Budget', aggregation: 'sum', expression: 'budget_amount', format: 'currency', currency_code: 'USD' },
  ],
  joins: [
    {
      name: 'department',
      relationship: 'many_to_one',
      source_dataset: 'fact_financials',
      target_dataset: 'dim_department',
      on: [{ source_member: 'department_code', target_member: 'department_code' }],
    },
  ],
};

const STEWARD: AuthUser = {
  subject: 'steward',
  displayName: 'Steward',
  departmentCode: null,
  costCentreCodes: [],
  roles: ['steward'],
  groups: ['steward'],
  isSteward: true,
};

const FINANCE_USER: AuthUser = {
  subject: 'finance-user',
  displayName: 'Finance User',
  departmentCode: 'finance',
  costCentreCodes: [],
  roles: ['business_user'],
  groups: ['finance'],
  isSteward: false,
};

async function createFixture(dir: string): Promise<string> {
  const dbPath = path.join(dir, 'analytics.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run(`
    CREATE SCHEMA gold;
    CREATE TABLE gold.fact_financials (
      department_code VARCHAR NOT NULL,
      budget_amount DECIMAL(18,2) NOT NULL
    );
    INSERT INTO gold.fact_financials VALUES
      ('finance', 100.00),
      ('finance', 50.00),
      ('hr', 25.00);
    CREATE TABLE gold.dim_department (
      department_code VARCHAR NOT NULL,
      department_name VARCHAR NOT NULL
    );
    INSERT INTO gold.dim_department VALUES
      ('finance', 'Finance'),
      ('hr', 'Human Resources');
  `);
  connection.closeSync();
  instance.closeSync();
  return dbPath;
}

test('preview joins a declared reference dataset and applies department scope', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpm-preview-test-'));
  const analytics = createAnalytics(await createFixture(dir));
  try {
    const steward = await analytics.preview(STEWARD, {
      definition: DEFINITION,
      group_by: ['department_name'],
      measures: ['budget_amount'],
      limit: 25,
    });
    assert.equal(steward.source_id, 'gold.fact_financials');
    assert.equal(steward.totals.budget_amount, '175.00');
    assert.equal(steward.rows.length, 2);
    const finance = steward.rows.find((row) => row.department_name === 'Finance');
    assert.equal(finance?.budget_amount, '150.00');
    const hr = steward.rows.find((row) => row.department_name === 'Human Resources');
    assert.equal(hr?.budget_amount, '25.00');

    const scoped = await analytics.preview(FINANCE_USER, {
      definition: DEFINITION,
      group_by: ['department_name'],
      measures: ['budget_amount'],
      limit: 25,
    });
    assert.equal(scoped.scope.department_code, 'finance');
    assert.equal(scoped.totals.budget_amount, '150.00');
    assert.deepEqual(scoped.rows, [
      { department_name: 'Finance', budget_amount: '150.00' },
    ]);

    await assert.rejects(
      () =>
        analytics.preview(STEWARD, {
          definition: { ...DEFINITION, joins: [] },
          group_by: ['department_name'],
          measures: ['budget_amount'],
        }),
      /not joined/
    );
  } finally {
    analytics.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
