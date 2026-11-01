import type { FastifyInstance } from 'fastify';
import { runIdempotent } from '../idempotency.js';
import { cancelJob, getJob, listJobs, retryJob } from '../services/jobs.js';
import { requestContext, sendPayload, type RouteDeps } from './helpers.js';

export function registerJobRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, config } = deps;

  app.get('/api/v1/jobs', async (request, reply) => {
    const result = await listJobs(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.get('/api/v1/jobs/:job_id', async (request, reply) => {
    const { job_id } = request.params as { job_id: string };
    const result = await getJob(db, request.user, job_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.post('/api/v1/jobs/:job_id/cancel', async (request, reply) => {
    const { job_id } = request.params as { job_id: string };
    const result = await runIdempotent(
      db,
      request,
      `job:${job_id}:cancel`,
      config.idempotencyTtlHours,
      async () => {
        const cancelled = await cancelJob(db, request.user, job_id, requestContext(request));
        return { status: cancelled.alreadyTerminal ? 200 : 202, payload: cancelled.payload };
      }
    );
    const payload = result.payload as { etag?: string };
    if (payload.etag) reply.header('ETag', payload.etag);
    return reply.code(result.status).send(payload);
  });

  app.post('/api/v1/jobs/:job_id/retry', async (request, reply) => {
    const { job_id } = request.params as { job_id: string };
    const result = await runIdempotent(
      db,
      request,
      `job:${job_id}:retry`,
      config.idempotencyTtlHours,
      async () => {
        const retried = await retryJob(db, request.user, job_id, config, requestContext(request));
        return { status: 202, payload: retried.payload };
      }
    );
    const payload = result.payload as { job_id?: string; etag?: string };
    if (payload.etag) reply.header('ETag', payload.etag);
    if (payload.job_id) reply.header('Location', `/api/v1/jobs/${payload.job_id}`);
    return reply.code(result.status).send(payload);
  });
}
