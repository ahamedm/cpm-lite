import type { Kysely } from 'kysely';
import { uuid } from './http.js';
import type { Database } from './schema.js';

export interface AuditInput {
  actorSubject: string;
  actorDepartmentCode: string | null;
  action: string;
  entityType: string;
  entityId: string;
  entityVersion?: number | null;
  correlationId: string;
  requestId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

export async function writeAudit(db: Kysely<Database>, input: AuditInput): Promise<void> {
  await db
    .insertInto('audit_event')
    .values({
      audit_event_id: uuid(),
      occurred_at: new Date(),
      actor_subject: input.actorSubject,
      actor_department_code: input.actorDepartmentCode,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      entity_version: input.entityVersion ?? null,
      correlation_id: input.correlationId,
      request_id: input.requestId ?? null,
      before_state: input.before === undefined ? null : JSON.stringify(input.before),
      after_state: input.after === undefined ? null : JSON.stringify(input.after),
      metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
    })
    .execute();
}

export async function writeOutbox(
  db: Kysely<Database>,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
  }
): Promise<void> {
  await db
    .insertInto('outbox_event')
    .values({
      outbox_event_id: uuid(),
      event_type: input.eventType,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      payload: JSON.stringify(input.payload),
      status: 'pending',
      attempts: 0,
      available_at: new Date(),
      created_at: new Date(),
      processed_at: null,
      last_error: null,
    })
    .execute();
}
