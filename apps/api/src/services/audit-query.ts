import type { Kysely } from 'kysely';
import type { AuthUser } from '../auth.js';
import { requireSteward } from '../auth.js';
import { pageInfo, parseLimit, parseOffsetCursor } from '../http.js';
import type { Database } from '../schema.js';
import { toAuditEvent } from '../serializers.js';

type ListQuery = Record<string, string | undefined>;

export async function listAuditEvents(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  requireSteward(user);
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);

  let builder = db.selectFrom('audit_event').selectAll();
  if (query.entity_type) builder = builder.where('entity_type', '=', query.entity_type);
  if (query.entity_id) builder = builder.where('entity_id', '=', query.entity_id);
  if (query.actor_subject) builder = builder.where('actor_subject', '=', query.actor_subject);
  if (query.action) builder = builder.where('action', '=', query.action);
  if (query.occurred_from) builder = builder.where('occurred_at', '>=', new Date(query.occurred_from));
  if (query.occurred_to) builder = builder.where('occurred_at', '<=', new Date(query.occurred_to));

  const rows = await builder
    .orderBy('occurred_at', 'desc')
    .orderBy('audit_event_id', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return { data: rows.slice(0, limit).map(toAuditEvent), page_info: pageInfo(offset, limit, rows.length) };
}
