import { DuckDBInstance } from '@duckdb/node-api';
import { Kysely, type Dialect } from 'kysely';
import { DuckDbDialect } from 'kysely-duckdb';
import type { Database } from './schema.js';
import { DateToIsoPlugin } from './date-plugin.js';

export interface DatabaseHandle {
  db: Kysely<Database>;
  instance: DuckDBInstance;
  close: () => Promise<void>;
}

export async function createDatabase(dbPath: string): Promise<DatabaseHandle> {
  const instance = await DuckDBInstance.create(dbPath);
  const dialect = new DuckDbDialect({
    database: instance,
    onCreateConnection: async (connection) => {
      await connection.run("SET schema='orchestrator'");
    },
  }) as unknown as Dialect;

  const db = new Kysely<Database>({ dialect, plugins: [new DateToIsoPlugin()] });

  return {
    db,
    instance,
    close: async () => {
      await db.destroy();
      instance.closeSync();
    },
  };
}
