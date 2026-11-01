import type { FastifyInstance } from 'fastify';
import type { InternalJobStatusRequest } from '../contracts.js';
import { requireServiceToken } from '../http.js';
import { internalUpdateJob } from '../services/jobs.js';
import { requestContext, sendPayload, type RouteDeps } from './helpers.js';

export function registerInternalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, config } = deps;

  app.post('/internal/v1/jobs/:job_id/status', { config: { public: true } }, async (request, reply) => {
    requireServiceToken(request, config.serviceToken);
    const { job_id } = request.params as { job_id: string };
    const result = await internalUpdateJob(
      db,
      job_id,
      request.body as InternalJobStatusRequest,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });
}
