/**
 * Promotes generated (dynamic) Cube models to reviewed static YAML.
 *
 * Usage (from the repository root):
 *   npm --prefix apps/api run promote-cube-schema
 *   npm --prefix apps/api run promote-cube-schema -- --model fy2026_department_budget
 *
 * The store is chosen by CPM_CUBE_SCHEMA_STORE, so this works against either the
 * local file snapshot or Valkey. No OLTP access is required, which keeps it
 * usable while the API is stopped for maintenance.
 */
import 'dotenv/config';
import path from 'node:path';
import { findRepoRoot, loadConfig } from '../src/config.js';
import { promoteCubeSchema } from '../src/cube/promoted.js';
import { createCubeSchemaStore } from '../src/cube/store.js';

const config = loadConfig();
const args = process.argv.slice(2);
const modelCodes: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--model' && args[index + 1]) {
    modelCodes.push(args[index + 1] as string);
    index += 1;
  }
}

const repoRoot = findRepoRoot();
const store = await createCubeSchemaStore(config, (message) => console.error(message));

try {
  const result = await promoteCubeSchema({
    store,
    cubeModelDir: path.join(repoRoot, 'cube', 'model'),
    manifestPath: config.cubePromotedManifestPath,
    modelCodes: modelCodes.length > 0 ? modelCodes : undefined,
    now: new Date(),
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review cube/model/cubes/promoted/*.yml and cube/model/promoted-models.json.');
  console.log('  2. Commit them with the data-engineering review.');
  console.log('  3. Deploy; the dynamic snapshot no longer contains the promoted cubes.');
} catch (error) {
  console.error(`Promotion failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await store.close();
}
