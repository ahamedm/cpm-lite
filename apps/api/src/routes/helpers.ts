import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { AnalyticsHandle } from '../analytics.js';
import type { AppConfig } from '../config.js';
import { etag } from '../http.js';
import type { Database } from '../schema.js';
import type { RequestContext } from '../services/common.js';

export interface RouteDeps {
  db: Kysely<Database>;
  config: AppConfig;
  analytics: AnalyticsHandle;
}

export function requestContext(request: FastifyRequest): RequestContext {
  return { correlationId: request.correlationId, requestId: request.id };
}

export function sendPayload(
  reply: FastifyReply,
  payload: unknown,
  options: { status?: number; rowVersion?: number; location?: string } = {}
) {
  if (options.status) reply.code(options.status);
  if (options.rowVersion !== undefined) reply.header('ETag', etag(options.rowVersion));
  if (options.location) reply.header('Location', options.location);
  return reply.send(payload);
}
