#!/usr/bin/env node
/**
 * Builds the CPM Lite DuckDB 2.0 gold layer from the Kaggle Budget vs Actual
 * workbook. The source workbook is synthetic demo data (AGENTS.md I13).
 *
 * Usage:
 *   node scripts/load-data.mjs
 *   CPM_DUCKDB_PATH=/path/to/file.duckdb node scripts/load-data.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const zipPath =
  process.env.CPM_SOURCE_ZIP ||
  path.join(repoRoot, 'sample_data/kaggle_kennathalexanderroy_budget_actual_financial_dataset.zip');
const dbPath = process.env.CPM_DUCKDB_PATH || path.join(repoRoot, 'data/cpm_lite.duckdb');
const stagingDir = path.join(repoRoot, 'data/staging');
const extensionDir = path.join(repoRoot, 'data/.duckdb-extensions');
const xlsxName = 'Budget_vs_Actual_Data.xlsx';

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function scalar(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  const row = reader.getRowObjects()[0];
  return row ? Object.values(row)[0] : undefined;
}

async function main() {
  assert(existsSync(zipPath), `Source dataset not found: ${zipPath}`);

  mkdirSync(path.dirname(dbPath), { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(extensionDir, { recursive: true });

  try {
    execFileSync('unzip', ['-o', zipPath, '-d', stagingDir], { stdio: 'ignore' });
  } catch (error) {
    throw new Error(
      `Could not extract ${zipPath}. Install unzip (or extract it manually to ${stagingDir}) and retry.`,
      { cause: error }
    );
  }

  const xlsxPath = path.join(stagingDir, xlsxName);
  assert(existsSync(xlsxPath), `Expected ${xlsxName} inside ${zipPath}`);

  const sourceSha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  const loadId = randomUUID();

  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();

  try {
    // DuckDB needs a writable directory for downloaded extensions.
    await connection.run(`SET extension_directory=${sqlLiteral(extensionDir)};`);
    await connection.run('INSTALL excel; LOAD excel;');

    await connection.run('CREATE SCHEMA IF NOT EXISTS staging;');
    await connection.run('CREATE SCHEMA IF NOT EXISTS gold;');
    await connection.run('CREATE SCHEMA IF NOT EXISTS ops;');

    console.log(`Reading ${xlsxPath}`);
    await connection.run(`
      CREATE OR REPLACE TABLE staging.financials_raw AS
      SELECT
        row_number() OVER () AS source_row_number,
        *
      FROM read_xlsx(${sqlLiteral(xlsxPath)})
    `);

    // Exact duplicate source rows are collapsed. The dataset contains 10 exact
    // duplicate transaction pairs; they must not double-count budget or actual.
    await connection.run(`
      CREATE OR REPLACE TABLE staging.financials_dedup AS
      SELECT DISTINCT
        "Date"::DATE AS transaction_date,
        nullif(trim("Department"), '') AS department,
        nullif(trim("Category"), '') AS category,
        nullif(trim("Region"), '') AS region,
        "Budget Amount"::DECIMAL(18, 2) AS budget_amount,
        "Actual Amount"::DECIMAL(18, 2) AS actual_amount,
        nullif(trim("Payment Method"), '') AS payment_method,
        nullif(trim("Transaction ID"), '') AS transaction_id
      FROM staging.financials_raw
    `);

    // A transaction id may repeat only when every other field is identical.
    // Anything else is a real conflict and must be resolved by a human.
    await connection.run(`
      CREATE OR REPLACE TABLE staging.transaction_conflicts AS
      SELECT transaction_id, count(*) AS row_count
      FROM staging.financials_dedup
      WHERE transaction_id IS NOT NULL
      GROUP BY transaction_id
      HAVING count(*) > 1
    `);
    const conflictCount = Number(await scalar(connection, 'SELECT count(*) FROM staging.transaction_conflicts'));
    assert(
      conflictCount === 0,
      `Found ${conflictCount} transaction id(s) with conflicting values; inspect staging.transaction_conflicts`
    );

    await connection.run(`
      CREATE OR REPLACE TABLE gold.rejected_financials AS
      SELECT
        transaction_id,
        transaction_date,
        department,
        category,
        region,
        budget_amount,
        actual_amount,
        payment_method,
        concat_ws('; ',
          CASE WHEN department IS NULL THEN 'missing_department' END,
          CASE WHEN category IS NULL THEN 'missing_category' END,
          CASE WHEN region IS NULL THEN 'missing_region' END,
          CASE WHEN payment_method IS NULL THEN 'missing_payment_method' END
        ) AS rejection_reason
      FROM staging.financials_dedup
      WHERE department IS NULL
         OR category IS NULL
         OR region IS NULL
         OR payment_method IS NULL
    `);

    await connection.run(`
      CREATE OR REPLACE TABLE gold.dim_department (
        department_code VARCHAR PRIMARY KEY,
        department_name VARCHAR NOT NULL
      )
    `);
    await connection.run(`
      INSERT INTO gold.dim_department
      SELECT
        lower(replace(department, ' ', '_')) AS department_code,
        department AS department_name
      FROM staging.financials_dedup
      WHERE department IS NOT NULL
      GROUP BY 1, 2
    `);

    await connection.run(`
      CREATE OR REPLACE TABLE gold.dim_category (
        category_code VARCHAR PRIMARY KEY,
        category_name VARCHAR NOT NULL
      )
    `);
    await connection.run(`
      INSERT INTO gold.dim_category
      SELECT
        lower(replace(category, ' ', '_')) AS category_code,
        category AS category_name
      FROM staging.financials_dedup
      WHERE category IS NOT NULL
      GROUP BY 1, 2
    `);

    await connection.run(`
      CREATE OR REPLACE TABLE gold.dim_region (
        region_code VARCHAR PRIMARY KEY,
        region_name VARCHAR NOT NULL
      )
    `);
    await connection.run(`
      INSERT INTO gold.dim_region
      SELECT
        lower(replace(region, ' ', '_')) AS region_code,
        region AS region_name
      FROM staging.financials_dedup
      WHERE region IS NOT NULL
      GROUP BY 1, 2
    `);

    await connection.run(`
      CREATE OR REPLACE TABLE gold.fact_financials (
        financial_id VARCHAR PRIMARY KEY,
        transaction_id VARCHAR,
        transaction_date DATE NOT NULL,
        department_code VARCHAR NOT NULL,
        category_code VARCHAR NOT NULL,
        region_code VARCHAR NOT NULL,
        payment_method VARCHAR NOT NULL,
        budget_amount DECIMAL(18, 2) NOT NULL,
        actual_amount DECIMAL(18, 2) NOT NULL,
        variance_amount DECIMAL(18, 2) NOT NULL,
        currency_code VARCHAR NOT NULL
      )
    `);
    await connection.run(`
      INSERT INTO gold.fact_financials
      SELECT
        md5(concat_ws('|',
          coalesce(transaction_id, ''),
          transaction_date::VARCHAR,
          department,
          category,
          region,
          budget_amount::VARCHAR,
          actual_amount::VARCHAR,
          payment_method
        )) AS financial_id,
        transaction_id,
        transaction_date,
        lower(replace(department, ' ', '_')) AS department_code,
        lower(replace(category, ' ', '_')) AS category_code,
        lower(replace(region, ' ', '_')) AS region_code,
        payment_method,
        budget_amount,
        actual_amount,
        actual_amount - budget_amount AS variance_amount,
        'USD' AS currency_code
      FROM staging.financials_dedup
      WHERE department IS NOT NULL
        AND category IS NOT NULL
        AND region IS NOT NULL
        AND payment_method IS NOT NULL
    `);

    await connection.run(`
      CREATE OR REPLACE TABLE gold.dim_date AS
      SELECT
        d::DATE AS date_key,
        EXTRACT(YEAR FROM d)::INTEGER AS year,
        EXTRACT(QUARTER FROM d)::INTEGER AS quarter,
        EXTRACT(MONTH FROM d)::INTEGER AS month,
        strftime(d, '%Y-%m') AS period,
        strftime(d, '%B') AS month_name,
        ((date_trunc('month', d) + INTERVAL 1 MONTH - INTERVAL 1 DAY)::DATE = d::DATE) AS is_month_end
      FROM generate_series(
        (SELECT min(transaction_date) FROM gold.fact_financials),
        (SELECT max(transaction_date) FROM gold.fact_financials),
        INTERVAL 1 DAY
      ) AS t(d)
    `);

    await connection.run(`
      CREATE TABLE IF NOT EXISTS ops.data_load_run (
        load_id VARCHAR PRIMARY KEY,
        source_file VARCHAR NOT NULL,
        source_sha256 VARCHAR NOT NULL,
        loaded_at TIMESTAMPTZ NOT NULL,
        raw_rows BIGINT NOT NULL,
        duplicate_rows_removed BIGINT NOT NULL,
        rejected_rows BIGINT NOT NULL,
        accepted_rows BIGINT NOT NULL,
        budget_total DECIMAL(18, 2) NOT NULL,
        actual_total DECIMAL(18, 2) NOT NULL
      )
    `);

    await connection.run(
      `
      INSERT INTO ops.data_load_run
      SELECT
        ?, ?, ?, now(),
        (SELECT count(*) FROM staging.financials_raw),
        (SELECT count(*) FROM staging.financials_raw) - (SELECT count(*) FROM staging.financials_dedup),
        (SELECT count(*) FROM gold.rejected_financials),
        (SELECT count(*) FROM gold.fact_financials),
        (SELECT coalesce(sum(budget_amount), 0) FROM gold.fact_financials),
        (SELECT coalesce(sum(actual_amount), 0) FROM gold.fact_financials)
      `,
      [loadId, path.relative(repoRoot, zipPath), sourceSha256]
    );

    await connection.run(`
      CREATE OR REPLACE VIEW gold.v_data_quality AS
      SELECT
        load_id,
        source_file,
        source_sha256,
        loaded_at,
        raw_rows,
        duplicate_rows_removed,
        rejected_rows,
        accepted_rows,
        budget_total,
        actual_total
      FROM ops.data_load_run
      ORDER BY loaded_at DESC
      LIMIT 1
    `);

    const rawRows = Number(await scalar(connection, 'SELECT count(*) FROM staging.financials_raw'));
    const dedupRows = Number(await scalar(connection, 'SELECT count(*) FROM staging.financials_dedup'));
    const rejectedRows = Number(await scalar(connection, 'SELECT count(*) FROM gold.rejected_financials'));
    const acceptedRows = Number(await scalar(connection, 'SELECT count(*) FROM gold.fact_financials'));

    assert(
      rejectedRows + acceptedRows === dedupRows,
      `Row reconciliation failed: ${rejectedRows} rejected + ${acceptedRows} accepted != ${dedupRows} deduplicated`
    );
    console.log(
      JSON.stringify(
        {
          database: dbPath,
          load_id: loadId,
          source_file: path.relative(repoRoot, zipPath),
          source_sha256: sourceSha256,
          raw_rows: rawRows,
          duplicate_rows_removed: rawRows - dedupRows,
          rejected_rows: rejectedRows,
          accepted_rows: acceptedRows,
          budget_total: String(await scalar(connection, 'SELECT sum(budget_amount) FROM gold.fact_financials')),
          actual_total: String(await scalar(connection, 'SELECT sum(actual_amount) FROM gold.fact_financials')),
        },
        null,
        2
      )
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
