import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { serviceUnavailable } from '../errors.js';
import type { RouteDeps } from './helpers.js';

export function registerHealthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db } = deps;

  app.get('/healthz', { config: { public: true } }, async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });

  app.get('/readyz', { config: { public: true } }, async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
    } catch {
      throw serviceUnavailable('OLTP database is not reachable');
    }
    return reply.send({ status: 'ok', checks: { database: 'ok', cube: 'degraded' } });
  });
}
