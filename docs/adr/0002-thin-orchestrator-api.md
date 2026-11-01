# ADR 0002 — Thin Orchestrator API stack and interim DuckDB persistence

- **Status:** Accepted (phase 1 implemented)
- **Date:** 2026-11-01
- **Deciders:** CPM Lite engineering
- **Related:** PRD §5.2, §6.6, §7.5; C4 `api`, `oltp`; ADR 0001; `docs/api/thin-orchestrator-api.md`

## Context

The next component is the Thin Layer API and orchestration service. It must provide a model/scenario registry, asynchronous job submission and status, pre-submit rule validation, review/promotion workflow, Cube refresh signalling and audit.

The repository has no API code yet. The product requirement is to review the API schema before implementation. PostgreSQL is the preferred OLTP store, but the user has asked for DuckDB as the interim OLTP store.

DuckDB is an analytical, single-writer engine. It is acceptable for a local/MVP slice but changes concurrency, deployment and ORM choices.

## Decision

1. **Runtime:** Node.js 24 LTS with TypeScript in strict mode.
2. **HTTP framework:** Fastify 5, with request/response validation against the committed OpenAPI schemas.
3. **ORM/query layer:** Kysely 0.28.19 with `kysely-duckdb` 0.4.0 and `@duckdb/node-api` 2.0.0-r.1.
4. **OLTP store:** a separate DuckDB 2.0 file, `data/cpm_lite_oltp.duckdb`, in schema `orchestrator`. Cube keeps `data/cpm_lite.duckdb`; the two must not share a file. The file name deliberately differs from the schema because DuckDB treats a database whose catalog and schema share a name as ambiguous.
5. **Contract-first:** `packages/contracts/openapi/thin-orchestrator.v1.yaml` is the source of truth. The implementation conforms to it; the spec is not generated from code.
6. **Concurrency:** `row_version` + `ETag`/`If-Match` optimistic concurrency; state-transition conflicts are `409`, stale writes are `412`.
7. **Idempotency:** `Idempotency-Key` for job submission, retry, publish, submission and promotion, backed by an `idempotency_key` table.
8. **Async side effects:** transactional outbox events for job dispatch, Cube refresh and promotion; consumers are idempotent.
9. **Migrations:** forward-only SQL in `db/migrations`; no ORM auto-sync and no runtime DDL.
10. **Data conventions:** VARCHAR UUIDs in DuckDB, JSON as serialized strings through Kysely, DECIMAL as strings through the API, TIMESTAMPTZ as UTC.

## Why Kysely rather than a full ORM

No mainstream full ORM (Prisma, Drizzle, TypeORM, Sequelize) supports DuckDB. Kysely is a typed SQL query builder with a maintained DuckDB dialect, transaction support and schema-building APIs. It fits the "some ORM" requirement while staying honest about DuckDB's SQL surface.

A probe on DuckDB 2.0 verified CRUD, JSON round-trips, transaction rollback and FK enforcement through Kysely.

Two Kysely-specific constraints are recorded:

- **Pin Kysely 0.28.19.** `kysely-duckdb@0.4.0` imports `DEFAULT_MIGRATION_*` from the Kysely package root; Kysely 0.29 moved these exports to `kysely/migration`, so the dialect fails at import time. Upgrading requires a patched or custom dialect.
- **Use VARCHAR UUIDs and JSON strings.** DuckDB's node API returns `UUID` values as objects that cannot be rebound through Kysely's `ANY` parameter path; JSON columns round-trip as strings. Both are contained at the persistence boundary.

## Alternatives considered

- **PostgreSQL now:** the preferred long-term OLTP store, but explicitly deferred by the user for this slice. The schema and repository boundaries keep the move mechanical.
- **Prisma/Drizzle/TypeORM/Sequelize:** no supported DuckDB connector; a custom adapter would be larger and riskier than Kysely's dialect.
- **Kysely 0.29 with a custom DuckDB dialect:** removes the older pin but adds dialect maintenance before the first endpoint exists.
- **Kysely 0.28 with `kysely-duckdb`:** selected; smallest viable typed layer, with a documented upgrade seam.
- **Shared DuckDB file with Cube:** rejected; Cube queries and orchestration writes would contend on one writer and couple deployments.
- **Embedded SQLite instead of DuckDB:** contradicts the user's instruction and splits the analytical/operational storage story.
- **Synchronous job execution:** rejected; scenario execution must remain an isolated external job (AGENTS I2).

## Consequences

- The API must run as a **single replica** while DuckDB is the OLTP store. Horizontal scaling waits for PostgreSQL.
- Writes are serialized by DuckDB; request handlers must keep transactions short and avoid long-running work inside a transaction.
- Kysely 0.28.19 is pinned; a dependency upgrade audit is required before moving to 0.29.
- DuckDB cannot add FKs after table creation, create partial indexes, or reliably update rows referenced by FKs. FKs are kept on immutable reference data; mutable aggregate relationships are app-enforced and "one draft per aggregate" is enforced transactionally.
- The OpenAPI contract must be linted in CI (`make lint-api`) and implementation changes must update it in the same change.
- Job and Cube-refresh states may remain `queued`/`pending` until their workers exist; the API must not fake success.
- PostgreSQL migration will require: JSON → JSONB, add missing FKs and partial indexes, switch the Kysely dialect, and remove the single-replica constraint.
- Entra ID integration and Cube token exchange remain open decisions from the PRD.

## Verification

- OpenAPI 3.1 contract lints with Redocly 2.72.1 with zero warnings.
- DuckDB 2.0 schema applies, seeds 6 departments and 6 synthetic cost centres, and representative inserts succeed.
- Constraint probes reject invalid published versions, invalid scenario bases, global scopes with ids, premature approvals, duplicate submissions, incomplete promotions and invalid idempotency expiry.
- Kysely probe on DuckDB 2.0 verified CRUD, JSON, transactions and reference-table FK enforcement.
