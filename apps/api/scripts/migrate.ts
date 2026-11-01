import 'dotenv/config';
import { applyMigrations } from '../src/migrate.js';
import { resolveDbPath } from '../src/config.js';

async function main() {
  const dbPath = resolveDbPath();
  const result = await applyMigrations(dbPath);
  console.log(JSON.stringify({ database: dbPath, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
