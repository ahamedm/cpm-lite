import type { FastifyInstance } from 'fastify';
import { listAuditEvents } from '../services/audit-query.js';
import { getMe, listCostCentres, listDepartments } from '../services/reference.js';
import { sendPayload, type RouteDeps } from './helpers.js';

export function registerReferenceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db } = deps;

  app.get('/api/v1/me', async (request, reply) => sendPayload(reply, getMe(request.user)));

  app.get('/api/v1/departments', async (request, reply) => {
    const result = await listDepartments(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.get('/api/v1/cost-centres', async (request, reply) => {
    const result = await listCostCentres(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.get('/api/v1/audit-events', async (request, reply) => {
    const result = await listAuditEvents(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });
}
