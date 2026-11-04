# ADR 0005 — Optional Valkey snapshot store for the dynamic Cube schema

- **Status:** Accepted (implemented)
- **Date:** 2026-11-04
- **Deciders:** CPM Lite engineering
- **Related:** ADR 0004; `docs/api/thin-orchestrator-api.md` §8; C4 `cube`, `api`; AGENTS dependencies and open decisions

## Context

ADR 0004 generates Cube schema from published model versions and stores it as a
content-addressed snapshot:

```
<dir>/current.json
<dir>/versions/<sha256>/<model>.yml
```

The API writes it and Cube reads it through `repositoryFactory`. That is correct
for one host, but a container deployment gives each pod its own filesystem:

- the API and Cube in separate pods cannot see the same directory;
- two Cube replicas on different nodes diverge;
- a rolling deploy starts with an empty local volume until the next refresh.

The requirement is an optional shared transport for multi-pod deployments while
keeping files as the zero-infrastructure default.

A related misconception is worth recording: **Cube Store is not backed by
Redis/Valkey.** Cube Store is Cube's own Rust pre-aggregation store (RocksDB,
Parquet, Arrow) with its own storage. In Cube 1.8.17,
`CUBEJS_CACHE_AND_QUEUE_DRIVER` accepts only `memory` or `cubestore`; Redis cache
and queue support was removed in Cube 0.36. There is no configuration that makes
Cube Store use Valkey. Valkey can carry the schema snapshot only because we
implement the repository ourselves.

## Decision

1. **One store interface, two transports.** `apps/api/src/cube/store.ts` exposes
   `CubeSchemaStore` (`commit`, `rollback`, `prune`, `close`):
   - `FileCubeSchemaStore` — the existing local directory; the default.
   - `ValkeyCubeSchemaStore` — versioned keys plus an atomic pointer.
   Selection is `CPM_CUBE_SCHEMA_STORE=file|valkey` (default `file`).
2. **Valkey layout.** With prefix `CPM_VALKEY_KEY_PREFIX` (default
   `cpm:cube-schema`):
   - `…:current` — manifest JSON, written last (atomic pointer);
   - `…:versions` — set of committed schema versions, used by `prune`;
   - `…:versions:<hash>:<model>.yml` — generated YAML.
   `commit` writes files first (pipeline) then the pointer; `rollback` restores
   the previous pointer and deletes the new version keys; `prune` keeps the
   versions referenced by the current and previous snapshots.
   `CPM_VALKEY_SCHEMA_TTL_SECONDS` (default `0` = no expiry) can expire version
   keys for environments that prefer TTL cleanup.
3. **Cube side.** `cube/model/dynamic-repository.cjs` gains
   `ValkeySchemaRepository` with the same `FileRepository` contract. On boot the
   first compile reads the pointer and files straight from Valkey — no API call
   is involved. It caches the pointer for one second (so `schemaVersion()` is not
   a request-per-query network hop), validates the manifest, and keeps the last
   known snapshot when Valkey is unreachable. A cold start with no snapshot
   serves the static cubes.
4. **No hard dependency.** `ioredis` is loaded lazily only when
   `CPM_CUBE_SCHEMA_STORE=valkey`; file-backed deployments never construct a
   client. `ioredis@6.0.0` is pinned in `apps/api` and `cube`.
5. **Refresh signalling.** `commit` and `rollback` publish a small JSON event on
   `<prefix>:events` after the pointer is updated. Each Cube replica keeps a
   dedicated subscriber connection, and a message invalidates its pointer cache,
   so the next query recompiles on the new hash instead of waiting for the poll.
   Pub/Sub is deliberate: the pointer is the durable state, and a missed message
   is repaired by the one-second poll and by the boot read. Streams would add
   consumer-group lifecycle without changing correctness.
6. **Unchanged semantics.** Generation, verification (`/meta` + one `load` per
   cube), rollback, retry, status and audit are transport-independent. The
   refresh consumer remains single-leader while DuckDB is the OLTP store; after
   the PostgreSQL move the outbox can be leased by any number of API replicas.

## Alternatives considered

- **Shared ReadWriteMany volume (Azure Files/NFS):** no new service, but a
  stateful volume, cross-pod attribute-cache lag and CSI-specific rename
  semantics. Kept as a possible fallback, not the default.
- **HTTP repository served by the API:** no new infrastructure, but adds an
  internal endpoint, service auth and request latency on compile.
- **Snapshot rows in PostgreSQL:** natural after the OLTP migration, but couples
  Cube to the database and still needs a read-only Cube role.
- **Point Cube's cache/queue at Valkey:** not supported in 1.8.17; Cube Store
  remains the pre-aggregation layer.
- **Regenerate inside each Cube pod:** duplicates the generator and risks drift.

## Consequences

- File remains the local-development and single-host default; Valkey is opt-in
  for multi-pod deployments. Both store the same content-addressed manifest, so
  a deployment can migrate by publishing one snapshot to the new store.
- Valkey is not the system of record: the model registry is. If the store is
  lost, the next publish/archive/manual refresh rebuilds it.
- Operators should use a dedicated instance/database with `maxmemory-policy
  noeviction` (or a TTL longer than the longest expected gap between refreshes),
  TLS/auth in `CPM_VALKEY_URL`, and the same prefix on API and Cube.
- A Valkey outage degrades a warm Cube replica to its last compiled schema;
  a cold replica serves static cubes and logs a throttled warning. The API
  records a failed refresh and retries.
- The C4 deployment view includes the Valkey container, the API→Valkey publish and Cube→Valkey read/subscribe relationships, and the Azure Cache node; no other container boundaries change.
- Events are advisory: a replica that misses one converges on the one-second
  pointer poll, and a reboot reads the pointer directly from Valkey.
- Dependency policy: `ioredis` was added at the registry's current version
  (`6.0.0`) with no advisories; run `make audit` after upgrades.

## Verification

- `apps/api` tests: commit/rollback/prune against an injected Valkey client,
  event publication on commit/rollback, and a refresh executed with the Valkey
  store (pointer and generated keys written, no file-store artifacts).
- `cube` tests: file and Valkey repositories merge static and generated cubes,
  follow a new pointer, invalidate the pointer cache on an event, and fall back
  to the last known schema during an outage.
- Live Valkey 9.0.6 (`localhost:6479`): Cube booted with
  `CPM_CUBE_SCHEMA_STORE=valkey`, served a generated cube from the store, and
  exposed a newly committed measure 741 ms after an external commit.
- `make test` includes the Cube repository tests (`make test-cube`).
