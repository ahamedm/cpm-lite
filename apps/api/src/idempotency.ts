import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { badRequest, conflict } from './errors.js';
import type { Database } from './schema.js';

export interface IdempotentResult {
  status: number;
  payload: unknown;
  replayed: boolean;
}

function requestHash(request: FastifyRequest): string {
  const material = JSON.stringify({
    method: request.method,
    url: request.routeOptions.url,
    params: request.params,
    query: request.query,
    body: request.body ?? null,
    ifMatch: request.headers['if-match'] ?? null,
    subject: request.user?.subject ?? null,
  });
  return createHash('sha256').update(material).digest('hex');
}

export async function runIdempotent(
  db: Kysely<Database>,
  request: FastifyRequest,
  scope: string,
  ttlHours: number,
  handler: () => Promise<{ status: number; payload: unknown }>
): Promise<IdempotentResult> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw badRequest('idempotency_key_required', 'Idempotency-Key header is required');
  }
  if (key.length < 8 || key.length > 200) {
    throw badRequest('idempotency_key_invalid', 'Idempotency-Key must be 8-200 characters');
  }

  const hash = requestHash(request);
  const existing = await db
    .selectFrom('idempotency_key')
    .selectAll()
    .where('scope', '=', scope)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();

  if (existing) {
    if (existing.request_hash !== hash) {
      throw conflict('idempotency_key_reuse', 'Idempotency-Key was reused with a different request');
    }
    return {
      status: existing.response_status,
      payload: JSON.parse(existing.response_body),
      replayed: true,
    };
  }

  const result = await handler();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db
    .insertInto('idempotency_key')
    .values({
      scope,
      idempotency_key: key,
      request_hash: hash,
      response_status: result.status,
      response_body: JSON.stringify(result.payload ?? {}),
      created_at: new Date(),
      expires_at: expiresAt,
    })
    .execute();

  return { ...result, replayed: false };
}
