import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { findRepoRoot } from './config.js';

export async function applyMigrations(dbPath: string): Promise<{ applied: number; skipped: number }> {
  const repoRoot = findRepoRoot();
  const migrationsDir = path.join(repoRoot, 'db', 'migrations');
  if (!existsSync(migrationsDir)) throw new Error(`Migrations directory not found: ${migrationsDir}`);

  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  let applied = 0;
  let skipped = 0;
  try {
    await connection.run('CREATE SCHEMA IF NOT EXISTS orchestrator');
    await connection.run(`
      CREATE TABLE IF NOT EXISTS orchestrator.schema_migration (
        version INTEGER PRIMARY KEY,
        name VARCHAR NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedReader = await connection.runAndReadAll('SELECT version FROM orchestrator.schema_migration');
    const appliedVersions = new Set(appliedReader.getRowObjects().map((row) => Number(row.version)));
    const files = readdirSync(migrationsDir)
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

    for (const file of files) {
      const version = Number.parseInt(file, 10);
      if (appliedVersions.has(version)) {
        skipped += 1;
        continue;
      }
      await connection.run(readFileSync(path.join(migrationsDir, file), 'utf8'));
      await connection.run(
        'INSERT INTO orchestrator.schema_migration (version, name) VALUES (?, ?) ON CONFLICT (version) DO NOTHING',
        [version, file.replace(/\.sql$/, '')]
      );
      appliedVersions.add(version);
      applied += 1;
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return { applied, skipped };
}

export async function applySeeds(dbPath: string): Promise<void> {
  const repoRoot = findRepoRoot();
  const seedsDir = path.join(repoRoot, 'db', 'seeds');
  if (!existsSync(seedsDir)) throw new Error(`Seeds directory not found: ${seedsDir}`);

  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  try {
    for (const file of readdirSync(seedsDir).filter((name) => name.endsWith('.sql')).sort()) {
      await connection.run(readFileSync(path.join(seedsDir, file), 'utf8'));
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
