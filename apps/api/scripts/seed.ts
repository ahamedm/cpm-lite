import 'dotenv/config';
import { applySeeds } from '../src/migrate.js';
import { resolveDbPath } from '../src/config.js';

async function main() {
  const dbPath = resolveDbPath();
  await applySeeds(dbPath);
  console.log(JSON.stringify({ database: dbPath, seeded: true }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
