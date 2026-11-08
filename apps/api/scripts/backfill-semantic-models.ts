import 'dotenv/config';
import { resolveDbPath } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { applyMigrations } from '../src/migrate.js';
import { backfillSemanticModels } from '../src/semantic/repository.js';

/**
 * Expands legacy `model_version.definition` JSON into the normalized semantic
 * tables introduced by ADR 0008. Idempotent; safe to re-run.
 *
 *   npm --prefix apps/api run backfill-semantic -- --dry-run
 */
async function main() {
  const dbPath = resolveDbPath();
  await applyMigrations(dbPath);
  const handle = await createDatabase(dbPath);
  const dryRun = process.argv.includes('--dry-run');
  try {
    const result = await backfillSemanticModels(handle.db, { dryRun });
    console.log(JSON.stringify({ database: dbPath, dry_run: dryRun, ...result }, null, 2));
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
