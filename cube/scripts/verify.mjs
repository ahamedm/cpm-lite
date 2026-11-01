#!/usr/bin/env node
/**
 * Starts Cube, exercises the semantic layer over HTTP, and checks:
 *   1. steward sees every department and totals match DuckDB;
 *   2. a business user sees only their department;
 *   3. a different department is scoped independently;
 *   4. a missing, invalid, or unscoped token is rejected.
 */
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const cubeDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dbPath = process.env.CPM_DUCKDB_PATH || path.join(repoRoot, 'data/cpm_lite.duckdb');
const serverBin = path.join(cubeDir, 'node_modules', '.bin', 'cubejs-server');
const apiSecret = `verify-${Math.random().toString(36).slice(2)}-${Date.now()}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function tokenFor({ role = 'business_user', department } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: `verify-${role}${department ? `-${department}` : ''}`,
    role,
    department_code: department,
    groups: role === 'steward' ? ['steward'] : ['business_user'],
    iat: now,
    exp: now + 60 * 10,
  };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = createHmac('sha256', apiSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, token, child, logs) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Cube exited before becoming ready.\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/cubejs-api/v1/meta`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for Cube at ${baseUrl}.\n${logs.join('')}`);
}

async function load(baseUrl, query, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/cubejs-api/v1/load`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function expectedByDepartment() {
  const instance = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`
      SELECT
        d.department_name AS department,
        sum(f.budget_amount)::DOUBLE AS budget_amount,
        sum(f.actual_amount)::DOUBLE AS actual_amount,
        sum(f.variance_amount)::DOUBLE AS variance_amount,
        count(*)::INTEGER AS transaction_count
      FROM gold.fact_financials f
      JOIN gold.dim_department d USING (department_code)
      GROUP BY 1
      ORDER BY 1
    `);
    return reader.getRowObjects();
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function byName(rows, field = 'budget_vs_actual.department') {
  return new Map(rows.map((row) => [row[field], row]));
}

function number(value, label) {
  const parsed = Number(value);
  assert(Number.isFinite(parsed), `${label} is not numeric: ${value}`);
  return parsed;
}

function assertClose(actual, expected, label) {
  assert(Math.abs(actual - expected) <= 0.01, `${label}: expected ${expected}, got ${actual}`);
}

async function main() {
  assert(existsSync(dbPath), `Missing ${dbPath}. Run "npm run load" first.`);
  assert(existsSync(serverBin), `Missing ${serverBin}. Run "npm install" first.`);

  const expected = await expectedByDepartment();
  assert(expected.length === 6, `Expected 6 departments in DuckDB, got ${expected.length}`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];

  // Run from a clean directory so a developer's cube/.env cannot override the
  // verification secret or disable auth enforcement.
  const verifyDir = mkdtempSync(path.join(os.tmpdir(), 'cpm-cube-verify-'));
  writeFileSync(
    path.join(verifyDir, 'cube.js'),
    `module.exports = require(${JSON.stringify(path.join(cubeDir, 'cube.js'))});\n`
  );

  const child = spawn(serverBin, [], {
    cwd: verifyDir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      // Production-like auth enforcement: in dev mode Cube allows missing
      // tokens through and relies on RLS returning zero rows.
      CUBEJS_DEV_MODE: 'false',
      CUBEJS_DB_TYPE: 'duckdb',
      CUBEJS_CACHE_AND_QUEUE_DRIVER: 'memory',
      CUBEJS_API_SECRET: apiSecret,
      CUBEJS_SCHEMA_PATH: path.relative(verifyDir, path.join(cubeDir, 'model')),
      CUBEJS_SCHEDULED_REFRESH_TIMER: 'false',
      CUBEJS_TELEMETRY: 'false',
      CPM_DUCKDB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const capture = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.length > 100) logs.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    const steward = tokenFor({ role: 'steward' });
    await waitForServer(baseUrl, steward, child, logs);

    const grouped = await load(
      baseUrl,
      {
        measures: [
          'budget_vs_actual.budget_amount',
          'budget_vs_actual.actual_amount',
          'budget_vs_actual.variance_amount',
          'budget_vs_actual.transaction_count',
        ],
        dimensions: ['budget_vs_actual.department'],
        order: { 'budget_vs_actual.department': 'asc' },
      },
      steward
    );
    assert(grouped.status === 200, `Steward query failed: ${JSON.stringify(grouped.body)}`);
    assert(grouped.body.data.length === 6, `Steward should see 6 departments, saw ${grouped.body.data.length}`);

    const cubeRows = byName(grouped.body.data);
    for (const row of expected) {
      const cube = cubeRows.get(row.department);
      assert(cube, `Steward results missing department ${row.department}`);
      assertClose(number(cube['budget_vs_actual.budget_amount'], 'budget'), row.budget_amount, `${row.department} budget`);
      assertClose(number(cube['budget_vs_actual.actual_amount'], 'actual'), row.actual_amount, `${row.department} actual`);
      assertClose(
        number(cube['budget_vs_actual.variance_amount'], 'variance'),
        row.variance_amount,
        `${row.department} variance`
      );
      assert(
        number(cube['budget_vs_actual.transaction_count'], 'count') === row.transaction_count,
        `${row.department} transaction count: expected ${row.transaction_count}, got ${cube['budget_vs_actual.transaction_count']}`
      );
    }

    for (const department of ['finance', 'hr']) {
      const response = await load(
        baseUrl,
        {
          measures: ['budget_vs_actual.budget_amount', 'budget_vs_actual.actual_amount'],
          dimensions: ['budget_vs_actual.department'],
        },
        tokenFor({ department })
      );
      assert(response.status === 200, `${department} query failed: ${JSON.stringify(response.body)}`);
      assert(response.body.data.length === 1, `${department} should see exactly one department, saw ${response.body.data.length}`);
      const expectedRow = expected.find((row) => row.department.toLowerCase() === department);
      assert(expectedRow, `No DuckDB row for ${department}`);
      assert(
        response.body.data[0]['budget_vs_actual.department'].toLowerCase() === department,
        `${department} leaked another department: ${response.body.data[0]['budget_vs_actual.department']}`
      );
      assertClose(
        number(response.body.data[0]['budget_vs_actual.budget_amount'], 'budget'),
        expectedRow.budget_amount,
        `${department} scoped budget`
      );
    }

    const viewQuery = await load(
      baseUrl,
      {
        measures: ['budget_vs_actual.budget_amount'],
        dimensions: ['budget_vs_actual.department', 'budget_vs_actual.category', 'budget_vs_actual.region'],
        limit: 5,
      },
      steward
    );
    assert(viewQuery.status === 200, `Joined view query failed: ${JSON.stringify(viewQuery.body)}`);
    assert(viewQuery.body.data.length > 0, 'Joined view query returned no rows');

    // The base cube must not be a bypass around the view's access policy.
    const baseCube = await load(
      baseUrl,
      {
        measures: ['financials.budget_amount'],
        dimensions: ['financials.department_code'],
      },
      tokenFor({ department: 'finance' })
    );
    assert(baseCube.status === 200, `Base cube query failed: ${JSON.stringify(baseCube.body)}`);
    assert(baseCube.body.data.length === 1, `Base cube should be scoped to one department, saw ${baseCube.body.data.length}`);
    assert(
      baseCube.body.data[0]['financials.department_code'] === 'finance',
      `Base cube leaked ${baseCube.body.data[0]['financials.department_code']}`
    );

    const noToken = await load(baseUrl, { measures: ['budget_vs_actual.budget_amount'] });
    assert(noToken.status === 403, `Missing token should be 403, got ${noToken.status}`);

    const invalidToken = await load(
      baseUrl,
      { measures: ['budget_vs_actual.budget_amount'] },
      `${steward.slice(0, -4)}beef`
    );
    assert(invalidToken.status === 403, `Invalid token should be 403, got ${invalidToken.status}`);

    const unscoped = tokenFor({ department: undefined });
    const unscopedResponse = await load(baseUrl, { measures: ['budget_vs_actual.budget_amount'] }, unscoped);
    assert(unscopedResponse.status === 403, `Unscoped business user should be 403, got ${unscopedResponse.status}`);

    console.log('Semantic layer verification passed.');
    console.log(
      JSON.stringify(
        {
          departments: expected.length,
          steward_rows: grouped.body.data.length,
          finance_scope: 'ok',
          hr_scope: 'ok',
          joined_view: 'ok',
          missing_token: noToken.status,
          invalid_token: invalidToken.status,
          unscoped_token: unscopedResponse.status,
        },
        null,
        2
      )
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
