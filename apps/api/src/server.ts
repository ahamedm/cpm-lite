import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await buildApp(config);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      db: config.dbPath,
      docs: `http://localhost:${config.port}/docs`,
      openapi: `http://localhost:${config.port}/api/v1/openapi.json`,
    },
    'CPM Lite Thin Orchestrator API is running'
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
