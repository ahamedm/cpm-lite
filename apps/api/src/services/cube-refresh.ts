/**
 * Cube refresh worker.
 *
 * Publishing a model version writes a `model_version.cube_refresh_requested`
 * outbox event in the same transaction (see services/models.ts). This consumer
 * turns the current published model registry into a content-addressed Cube
 * schema snapshot, asks Cube to compile it, and writes the truthful outcome
 * back onto the model version and the outbox event.
 *
 * DuckDB allows a single writer per file, so the consumer runs in the API
 * process for the current single-replica phase. It is written as a standalone
 * queue processor (`processCubeRefreshOnce`) so it can be lifted into a worker
 * service once the OLTP store moves to PostgreSQL.
 */

import type { Kysely } from 'kysely';
import type { AnalyticsHandle } from '../analytics.js';
import { writeAudit } from '../audit.js';
import type { AppConfig } from '../config.js';
import {
  buildCube,
  type GeneratedCube,
} from '../cube/schema.js';
import {
  applyPromotions,
  loadPromotedManifest,
  type PromotedModel,
} from '../cube/promoted.js';
import { schemaVersionFromPointer } from '../cube/snapshot.js';
import {
  createCubeSchemaStore,
  type CubeSchemaCommit,
  type CubeSchemaStore,
} from '../cube/store.js';
import { verificationTargets, verifyCubeSchema } from '../cube/verify.js';
import { uuid } from '../http.js';
import type { Database } from '../schema.js';

const EVENT_TYPE = 'model_version.cube_refresh_requested';
const WORKER_ACTOR = 'system:cube-refresh';
const MAX_EVENTS_PER_TICK = 10;

export interface CubeRefreshDeps {
  db: Kysely<Database>;
  analytics: Pick<AnalyticsHandle, 'getSource'>;
  config: AppConfig;
  /** Injectable for tests; defaults to the configured store (file or Valkey). */
  store?: CubeSchemaStore;
  /** Injectable for tests; defaults to the HTTP verification against Cube. */
  verify?: (cubes: GeneratedCube[]) => Promise<void>;
  now?: () => Date;
}

interface RefreshLogger {
  info: (payload: object, message: string) => void;
  warn: (payload: object, message: string) => void;
  error: (payload: object, message: string) => void;
}

interface PublishedVersionRow {
  model_version_id: string;
  version_number: number;
  definition: string;
  cube_refresh_status: string;
  row_version: number;
  model_id: string;
  code: string;
  name: string;
  description: string | null;
  department_code: string;
  model_status: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}

function retryDelayMs(attempts: number): number {
  return Math.min(5_000 * attempts, 60_000);
}

/** Exposed for tests: the published model versions a refresh will materialise. */
export async function listPublishedVersions(db: Kysely<Database>): Promise<PublishedVersionRow[]> {
  return (await db
    .selectFrom('model_version as mv')
    .innerJoin('model as m', 'm.model_id', 'mv.model_id')
    .select([
      'mv.model_version_id',
      'mv.version_number',
      'mv.definition',
      'mv.cube_refresh_status',
      'mv.row_version',
      'm.model_id',
      'm.code',
      'm.name',
      'm.description',
      'm.department_code',
      'm.status as model_status',
    ])
    .where('mv.status', '=', 'published')
    .where('m.status', '=', 'active')
    .orderBy('m.code', 'asc')
    .orderBy('mv.version_number', 'asc')
    .execute()) as PublishedVersionRow[];
}

function cubeInputFor(row: PublishedVersionRow, source: { source_id: string; columns: Array<{ name: string }> }) {
  return {
    model: {
      model_id: row.model_id,
      code: row.code,
      name: row.name,
      description: row.description,
      department_code: row.department_code,
      status: row.model_status,
    },
    version: {
      model_version_id: row.model_version_id,
      version_number: row.version_number,
      status: 'published',
      definition: JSON.parse(row.definition) as Record<string, unknown>,
    },
    source: {
      source_id: source.source_id,
      columns: source.columns.map((column) => column.name),
    },
  };
}

/**
 * Processes at most one due refresh event. Returns whether an event was handled.
 * Never throws for a refresh failure: the failure is persisted on the model
 * version and the outbox event.
 */
export async function processCubeRefreshOnce(
  deps: CubeRefreshDeps
): Promise<{ processed: boolean; schemaVersion?: string; error?: string }> {
  const { db, config } = deps;
  const now = deps.now?.() ?? new Date();

  const event = await db
    .selectFrom('outbox_event')
    .selectAll()
    .where('event_type', '=', EVENT_TYPE)
    .where('status', '=', 'pending')
    .where('available_at', '<=', now)
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (!event) return { processed: false };

  const pendingEvents = await db
    .selectFrom('outbox_event')
    .select(['outbox_event_id', 'aggregate_id'])
    .where('event_type', '=', EVENT_TYPE)
    .where('status', '=', 'pending')
    .where('created_at', '<=', now)
    .execute();
  const pendingEventIds = pendingEvents.map((row) => row.outbox_event_id);

  const claimed = await db
    .updateTable('outbox_event')
    .set({ status: 'processing', attempts: event.attempts + 1, last_error: null })
    .where('outbox_event_id', '=', event.outbox_event_id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) === 0) return { processed: false };
  const attempts = event.attempts + 1;

  const trigger = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_version_id', '=', event.aggregate_id)
    .executeTakeFirst();

  if (
    trigger &&
    trigger.status === 'published' &&
    (trigger.cube_refresh_status === 'pending' || trigger.cube_refresh_status === 'not_requested')
  ) {
    await db
      .updateTable('model_version')
      .set({
        cube_refresh_status: 'running',
        cube_refresh_error: null,
        row_version: trigger.row_version + 1,
      })
      .where('model_version_id', '=', trigger.model_version_id)
      .execute();
  }

  let committed: CubeSchemaCommit | null = null;
  let rows: PublishedVersionRow[] = [];
  let promoted: Array<{ row: PublishedVersionRow; entry: PromotedModel }> = [];
  let store: CubeSchemaStore | null = deps.store ?? null;
  let ownedStore: CubeSchemaStore | null = null;
  try {
    if (!store) {
      store = await createCubeSchemaStore(config);
      ownedStore = store;
    }

    const source = await deps.analytics.getSource();
    const promotion = applyPromotions(
      await listPublishedVersions(db),
      loadPromotedManifest(config.cubePromotedManifestPath)
    );
    rows = promotion.rows;
    promoted = promotion.promoted;
    const cubes = rows.map((row) => buildCube(cubeInputFor(row, source)));
    committed = await store.commit(cubes, now);

    const verify = deps.verify ?? ((target) => verifyCubeSchema(config, verificationTargets(target)));
    await verify(cubes);

    await markSucceeded(deps, {
      eventId: event.outbox_event_id,
      pendingEventIds,
      rows,
      promoted,
      snapshot: committed,
      now,
    });

    const keep = [committed.schema_version];
    const previousVersion = schemaVersionFromPointer(committed.previous);
    if (previousVersion && previousVersion !== committed.schema_version) keep.push(previousVersion);
    await store.prune(keep);

    return { processed: true, schemaVersion: committed.schema_version };
  } catch (error) {
    const message = messageOf(error);
    if (committed && store) {
      try {
        await store.rollback(committed);
      } catch {
        // Keep the original failure; the next refresh reconciles the pointer.
      }
    }
    await markFailed(deps, {
      eventId: event.outbox_event_id,
      attempts,
      error: message,
      trigger,
      now,
    });
    return { processed: true, error: message };
  } finally {
    if (ownedStore) await ownedStore.close();
  }
}

async function markSucceeded(
  deps: CubeRefreshDeps,
  input: {
    eventId: string;
    pendingEventIds: string[];
    rows: PublishedVersionRow[];
    promoted: Array<{ row: PublishedVersionRow; entry: PromotedModel }>;
    snapshot: CubeSchemaCommit;
    now: Date;
  }
): Promise<void> {
  const { db } = deps;
  const { rows, snapshot, now } = input;

  for (const row of rows) {
    const cube = snapshot.manifest.models.find((entry) => entry.model_version_id === row.model_version_id);
    if (!cube) continue;
    const changed = row.cube_refresh_status !== 'succeeded';
    if (changed) {
      await db
        .updateTable('model_version')
        .set({
          cube_refresh_status: 'succeeded',
          cube_refresh_completed_at: now,
          cube_refresh_error: null,
          row_version: row.row_version + 1,
        })
        .where('model_version_id', '=', row.model_version_id)
        .where('cube_refresh_status', '<>', 'succeeded')
        .execute();

      await writeAudit(db, {
        actorSubject: WORKER_ACTOR,
        actorDepartmentCode: row.department_code,
        action: 'model_version.cube_refresh_succeeded',
        entityType: 'model_version',
        entityId: row.model_version_id,
        entityVersion: row.row_version + 1,
        correlationId: uuid(),
        before: { cube_refresh_status: row.cube_refresh_status },
        after: {
          cube_refresh_status: 'succeeded',
          cube_name: cube.cube_name,
          schema_version: snapshot.schema_version,
        },
      });
    }
  }

  // Promoted models are served from reviewed static YAML; the published version
  // they represent is therefore already live.
  for (const { row, entry } of input.promoted) {
    if (row.cube_refresh_status === 'succeeded') continue;
    await db
      .updateTable('model_version')
      .set({
        cube_refresh_status: 'succeeded',
        cube_refresh_completed_at: now,
        cube_refresh_error: null,
        row_version: row.row_version + 1,
      })
      .where('model_version_id', '=', row.model_version_id)
      .where('cube_refresh_status', '<>', 'succeeded')
      .execute();

    await writeAudit(db, {
      actorSubject: WORKER_ACTOR,
      actorDepartmentCode: row.department_code,
      action: 'model_version.cube_refresh_succeeded',
      entityType: 'model_version',
      entityId: row.model_version_id,
      entityVersion: row.row_version + 1,
      correlationId: uuid(),
      before: { cube_refresh_status: row.cube_refresh_status },
      after: { cube_refresh_status: 'succeeded', mode: 'static_yaml', file: entry.file },
    });
  }

  // A superseded version can never be refreshed again; record why instead of
  // leaving it pending forever (it may have been superseded mid-refresh).
  const superseded = await db
    .selectFrom('model_version')
    .select(['model_version_id', 'row_version'])
    .where('status', '=', 'superseded')
    .where('cube_refresh_status', 'in', ['pending', 'running'])
    .execute();
  for (const version of superseded) {
    await db
      .updateTable('model_version')
      .set({
        cube_refresh_status: 'failed',
        cube_refresh_completed_at: null,
        cube_refresh_error: 'Superseded before the Cube refresh completed',
        row_version: version.row_version + 1,
      })
      .where('model_version_id', '=', version.model_version_id)
      .execute();
  }

  const eventIds = [...new Set([...input.pendingEventIds, input.eventId])];
  if (eventIds.length > 0) {
    await db
      .updateTable('outbox_event')
      .set({ status: 'succeeded', processed_at: now, last_error: null })
      .where('outbox_event_id', 'in', eventIds)
      .where('status', 'in', ['pending', 'processing'])
      .execute();
  }
}

async function markFailed(
  deps: CubeRefreshDeps,
  input: {
    eventId: string;
    attempts: number;
    error: string;
    trigger: { model_version_id: string; status: string } | undefined;
    now: Date;
  }
): Promise<void> {
  const { db, config } = deps;
  const { attempts, error, trigger, now } = input;
  const exhausted = attempts >= config.cubeRefreshMaxAttempts;

  if (exhausted) {
    await db
      .updateTable('outbox_event')
      .set({ status: 'failed', last_error: error })
      .where('outbox_event_id', '=', input.eventId)
      .where('status', '=', 'processing')
      .execute();
  } else {
    await db
      .updateTable('outbox_event')
      .set({
        status: 'pending',
        available_at: new Date(now.getTime() + retryDelayMs(attempts)),
        last_error: error,
      })
      .where('outbox_event_id', '=', input.eventId)
      .where('status', '=', 'processing')
      .execute();
  }

  if (!trigger || trigger.status !== 'published') return;

  const row = await db
    .selectFrom('model_version')
    .selectAll()
    .where('model_version_id', '=', trigger.model_version_id)
    .executeTakeFirst();
  if (!row) return;

  await db
    .updateTable('model_version')
    .set({
      cube_refresh_status: exhausted ? 'failed' : 'pending',
      cube_refresh_completed_at: null,
      cube_refresh_error: error,
      row_version: row.row_version + 1,
    })
    .where('model_version_id', '=', trigger.model_version_id)
    .execute();

  if (exhausted) {
    const model = await db
      .selectFrom('model')
      .select('department_code')
      .where('model_id', '=', row.model_id)
      .executeTakeFirst();
    await writeAudit(db, {
      actorSubject: WORKER_ACTOR,
      actorDepartmentCode: model?.department_code ?? null,
      action: 'model_version.cube_refresh_failed',
      entityType: 'model_version',
      entityId: trigger.model_version_id,
      entityVersion: row.row_version + 1,
      correlationId: uuid(),
      before: { cube_refresh_status: row.cube_refresh_status },
      after: { cube_refresh_status: 'failed', attempts },
      metadata: { error },
    });
  }
}

export async function processCubeRefreshQueue(
  deps: CubeRefreshDeps,
  logger: RefreshLogger,
  max = MAX_EVENTS_PER_TICK
): Promise<{ handled: number; failures: number }> {
  let handled = 0;
  let failures = 0;
  for (let index = 0; index < max; index += 1) {
    const result = await processCubeRefreshOnce(deps);
    if (!result.processed) break;
    handled += 1;
    if (result.error) {
      failures += 1;
      logger.warn(
        { err: result.error, schema_version: result.schemaVersion },
        'Cube refresh attempt failed'
      );
    } else {
      logger.info({ schema_version: result.schemaVersion }, 'Cube schema refreshed');
    }
  }
  return { handled, failures };
}

/**
 * Starts the in-process refresh loop. The store is opened once and closed on
 * shutdown. Returns a stop function used on shutdown.
 */
export async function startCubeRefreshWorker(
  deps: CubeRefreshDeps,
  logger: RefreshLogger
): Promise<{ stop: () => void }> {
  if (!deps.config.cubeRefreshEnabled) {
    logger.info({}, 'Cube refresh worker disabled by configuration');
    return { stop: () => undefined };
  }

  const store =
    deps.store ??
    (await createCubeSchemaStore(deps.config, (message) =>
      logger.warn({ err: message }, 'Valkey schema store error')
    ));
  const workerDeps: CubeRefreshDeps = { ...deps, store };
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await processCubeRefreshQueue(workerDeps, logger);
    } catch (error) {
      logger.error({ err: messageOf(error) }, 'Cube refresh worker tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), deps.config.cubeRefreshPollMs);
  interval.unref?.();
  const initial = setTimeout(() => void tick(), 500);
  initial.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(initial);
      void store.close();
    },
  };
}
