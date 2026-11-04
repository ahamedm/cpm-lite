# ADR 0004 — Dynamic Cube schema and the Cube refresh worker

- **Status:** Accepted (implemented)
- **Date:** 2026-11-04
- **Deciders:** CPM Lite engineering
- **Related:** PRD §5.1, §5.2, §6.1, §6.6; C4 `api`, `cube`; ADR 0001; ADR 0002; ADR 0003; `docs/api/thin-orchestrator-api.md` §8

## Context

Publishing a model version wrote `cube_refresh_status = 'pending'` and a
`model_version.cube_refresh_requested` outbox event, but nothing consumed the
event. Cube's semantic model was a pair of hand-written YAML files, so a
published model never reached Cube and the UI showed "Pending" forever.

Two requirements meet here:

1. The refresh must be real: the status may only become `succeeded` when Cube has
   actually compiled the published model and can answer a query against it.
2. Dynamic schema is part of the MVP. A user who publishes a model must get a
   queryable Cube member without editing YAML or restarting Cube.

Constraints:

- DuckDB allows one writer per file, so a separate worker process cannot open the
  OLTP file while the API holds it (`data/cpm_lite_oltp.duckdb`).
- Cube Core 1.8.17 already exposes the two hooks dynamic schema needs:
  `repositoryFactory(context)` and `schemaVersion(context)`.
- Model definitions are registry data (invariant I4: published versions are
  immutable), so the generated schema must be reproducible from the registry.
- The verified snapshot must never leave Cube broken if generation or
  verification fails.

## Decision

1. **Generated schema is content-addressed and immutable.** The API renders the
   current published model versions as Cube YAML and writes them under
   `data/cube-schema/versions/<sha256>/`. `current.json` is an atomically
   replaced pointer holding the manifest (schema version, generated time, cube
   names). The same registry state always produces the same schema version.
2. **Cube reads the snapshot dynamically** through
   `cube/model/dynamic-repository.cjs`: a `FileRepository` subclass that serves
   the hand-written `cube/model` files plus the generated snapshot, and reports
   the snapshot hash from `schemaVersion()`. Cube recompiles when the hash
   changes, without a restart.
3. **The worker runs in the API process for this phase.** `processCubeRefreshOnce`
   is a standalone queue consumer (claim → running → generate → verify →
   succeed/retry/fail) so it can move to a separate service once OLTP is
   PostgreSQL. The in-process placement is forced by DuckDB's single writer.
4. **Verification is end-to-end.** The worker mints a short-lived steward JWT
   with the local Cube secret (`CPM_CUBE_API_SECRET`), loads
   `/cubejs-api/v1/meta`, asserts every generated cube is compiled, and runs one
   `load` query per cube. Only then is the snapshot kept and the model version
   marked `succeeded`.
5. **Failures are rolled back and retried.** A failed verification restores the
   previous pointer and discards the new version directory. The event is retried
   with linear backoff up to `CPM_CUBE_REFRESH_MAX_ATTEMPTS`; after that the
   model version and the event are `failed` with the error recorded.
6. **Regeneration is global and idempotent.** Each event rebuilds the snapshot
   from all published, non-archived models. Superseded versions are not emitted;
   their pending refresh is marked `failed` with a "superseded" message, and
   archiving a model enqueues a refresh so its cube leaves the semantic layer.
7. **Generated cubes enforce access policy.** Every generated cube carries the
   department row-level policy (`business_user` filtered on
   `access.row_level_field`; `steward` allowed all). Expressions must be plain
   columns of the governed source; model codes may not collide with the
   hand-written cubes or view. Definitions created before Model Studio keep
   working: a missing `source` defaults to the governed source and the access
   field resolves to the dimension that reads `department_code` (ADR 0003).
8. **Failure is recoverable.** `POST /api/v1/model-versions/{id}/refresh`
   re-queues a published version and coalesces with an already pending request,
   so a transient Cube outage or a fixed generator does not require forking a
   new version.

## Alternatives considered

- **Write YAML into `cube/model` and restart Cube:** rejected; it needs a restart
  per publish and gives no atomic rollback.
- **Fetch generated schema over HTTP from the API:** rejected for this phase; it
  adds a Cube→API credential exchange and a new internal endpoint. A shared
  directory is the smallest honest step for a single-host deployment; an
  HTTP or database-backed repository remains the production path.
- **Compile the generated schema inside the API:** rejected; it would duplicate
  Cube's compiler and still not prove Cube loaded the schema.
- **Separate refresh worker process now:** rejected while OLTP is DuckDB; two
  processes cannot open the database file. Revisit with PostgreSQL.
- **Mark `succeeded` as soon as files are written:** rejected; it would fake
  success when Cube cannot compile or query the cube.
- **Define a Cube view per model:** deferred; generated cubes are queryable as
  `<model code>.<member>` and a view adds naming decisions without new
  capability.

## Consequences

- The API and Cube must share the snapshot directory. Locally this is
  `data/cube-schema`. For multi-pod deployments use the optional Valkey store
  (ADR 0005), a shared volume, or an HTTP/database-backed repository.
- Cube verification needs the local HS256 Cube secret in the API
  (`CPM_CUBE_API_SECRET`). This is development wiring; Entra ID replaces it when
  identity lands.
- `make verify` now writes a generated snapshot fixture and asserts both dynamic
  loading and hot reload, alongside the existing totals, scoping and auth checks.
- Publishing remains `202`: the registry row is synchronous, the semantic layer
  is asynchronous and its status is truthful (`pending` → `running` →
  `succeeded`/`failed`).
- Generated files are gitignored; they are reproducible from the registry. A
  registry restore plus a publish/archive event reconstructs the semantic layer.

## Verification

- `npm --prefix apps/api test` covers YAML rendering, unsafe definitions,
  success (status, outbox, audit, snapshot), rollback with backoff, and terminal
  failure.
- `make verify` loads a generated snapshot in Cube, checks steward and department
  scoping on the generated cube, then commits a second snapshot and reads a new
  measure without restarting Cube.
