import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, preconditionFailed } from './errors.js';

export const uuid = randomUUID;

export function etag(rowVersion: number): string {
  return `W/"${rowVersion}"`;
}

export function setEtag(reply: FastifyReply, rowVersion: number): void {
  reply.header('ETag', etag(rowVersion));
}

export function requireIfMatch(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  if (typeof raw !== 'string' || raw.length === 0) throw preconditionFailed('If-Match header is required');
  const match = raw.match(/(?:\/?W\/)?"?(\d+)"?/);
  if (!match) throw preconditionFailed('If-Match must contain a row version');
  return Number.parseInt(match[1]!, 10);
}

export function parseLimit(request: FastifyRequest, fallback = 50, max = 200): number {
  const raw = request.query && typeof (request.query as Record<string, unknown>).limit === 'string'
    ? Number.parseInt((request.query as Record<string, string>).limit!, 10)
    : fallback;
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(raw, max);
}

export function parseOffsetCursor(request: FastifyRequest): number {
  const raw = request.query && typeof (request.query as Record<string, unknown>).cursor === 'string'
    ? (request.query as Record<string, string>).cursor!
    : null;
  if (!raw) return 0;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const match = decoded.match(/^offset:(\d+)$/);
    return match ? Number.parseInt(match[1]!, 10) : 0;
  } catch {
    return 0;
  }
}

export function nextCursor(offset: number, hasMore: boolean): string | null {
  return hasMore ? Buffer.from(`offset:${offset}`, 'utf8').toString('base64url') : null;
}

export function pageInfo(offset: number, limit: number, rowCount: number) {
  const hasMore = rowCount > limit;
  const nextOffset = offset + limit;
  return {
    has_more: hasMore,
    next_cursor: nextCursor(nextOffset, hasMore),
  };
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return slug.length >= 3 ? slug : `item_${slug || 'unnamed'}`;
}

export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function correlationId(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : randomUUID();
}

export function requireServiceToken(request: FastifyRequest, expected: string | null): void {
  if (!expected) {
    throw new ApiError(503, 'service_unavailable', 'Service unavailable', 'Internal worker callback is not configured');
  }
  const provided = request.headers['x-cpm-service-token'];
  if (typeof provided !== 'string' || provided !== expected) {
    throw new ApiError(403, 'forbidden', 'Forbidden', 'Invalid service token');
  }
}
