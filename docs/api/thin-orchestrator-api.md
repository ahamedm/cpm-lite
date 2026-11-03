# Thin Orchestrator API — schema review

**Status:** Implemented (phase 1) in `apps/api`; contract remains the source of truth.
**Date:** 2026-11-01
**Scope:** Thin Layer API and orchestration (PRD §5.2). Not scenario compute, Cube querying, or the UI.

This package defined the review gate before implementation; the phase-1 service now conforms to it.

| Artifact | Purpose |
|---|---|
| `packages/contracts/openapi/thin-orchestrator.v1.yaml` | Contract-first HTTP surface |
| `packages/contracts/openapi/schemas/*.yaml` | Domain request/response schemas |
| `db/migrations/0001_orchestrator.sql` | DuckDB 2.0 OLTP schema |
| `db/seeds/0001_reference.sql` | Synthetic departments/cost centres |
| `docs/adr/0002-thin-orchestrator-api.md` | Stack and persistence decisions |

`make lint-api` passes with zero warnings. The DDL was applied to DuckDB 2.0 and its constraints were probed (see Verification).

---

## 1. What the orchestrator owns

From PRD §5.2 and the C4 DSL, this service owns:

1. Model and scenario registry, including draft → validate → publish.
2. Asynchronous job submission and status tracking.
3. Pre-submit rule validation and rule-version pinning.
4. Review and promotion workflow state.
5. Cube schema-refresh signalling when a model is published.
6. Audit access.

It does **not** run scenario calculations, allocate costs, query Cube, or serve the UI. A job row is a dispatch request plus status/result metadata; the scenario engine remains an ephemeral external worker (AGENTS I2).

---

## 2. Resource model

| Resource | Aggregate root | Key rules |
|---|---|---|
| `Model` | yes | Metadata; no inline definition |
| `ModelVersion` | no | Immutable after publish; one draft at a time (app-enforced) |
| `Scenario` | yes | Metadata; department/cost-centre scoped |
| `ScenarioVersion` | no | Pins a published model version; immutable once queued |
| `Job` | yes | One execution attempt; retry creates a new job |
| `Rule` | yes | Metadata |
| `RuleVersion` | no | Immutable after activation; effective-dated scopes |
| `Submission` | yes | One per scenario version; review state |
| `Promotion` | yes | Async conversion of an approved submission |
| `Plan` / `PlanVersion` | yes / no | Plan version is immutable once published |
| `AuditEvent` | yes | Append-only |
| `Department` / `CostCentre` | reference | Read-only from the orchestrator’s perspective |

Versioned resources carry a `row_version` that becomes the HTTP `ETag`. User-facing writes never mutate a published/completed version; they create a new version.

---

## 3. State machines

### Model version

```text
draft ──validate──> validated ──publish──> published ──new version──> superseded
  │                     │
  └──edit───────────────┘ (draft/validated only)
```

Publish requires `validated`. Publish is synchronous for the registry row and asynchronous for the Cube refresh (`cube_refresh.status`). A publish never mutates a previously published version.

### Scenario execution + review

Execution status and review status are separate columns to avoid invalid combinations.

```text
execution: draft ──job submitted──> queued ──> running ──> completed
                                    │            ├──> failed
                                    └──> cancelled <── cancelled

review:    not_submitted ──submit──> submitted ──decide──> approved
                                              ├──> rejected
                                              └──> changes_requested
approved ──promote──> promoted
```

- A submission requires `execution = completed`.
- `approved`/`promoted` review states require a completed execution (DB check).
- Rejection or changes requested never mutates the completed scenario version; a new scenario version is created for changes.
- `GET /scenario-versions/{id}/results` is available only when completed.

### Job

```text
queued ──> running ──> completed
   │          ├──> failed
   └──> cancelled <── cancel requested
failed/cancelled ──retry──> new queued job (retry_of_job_id)
```

Terminal status is always written. `max_attempts` comes from configuration, never a hardcoded default in code.

### Rule

```text
draft ──publish──> active ──retire──> retired
```

### Submission / promotion

```text
submitted ──approve──> approved ──promotion succeeded──> promoted
          ├──reject──> rejected
          └──request_changes──> changes_requested

promotion: requested ──> running ──> succeeded
                              └──> failed
```

---

## 4. HTTP surface

Base path `/api/v1`. Full request/response schemas are in the OpenAPI file.

| Area | Endpoints |
|---|---|
| Identity/reference | `GET /me`, `GET /departments`, `GET /cost-centres` |
| Models | `GET/POST /models`, `GET/PATCH/DELETE /models/{id}`, `GET/POST /models/{id}/versions`, `GET/PATCH /model-versions/{id}`, `POST /model-versions/{id}/validate`, `POST /model-versions/{id}/publish` |
| Model authoring | `GET /model-sources`, `POST /model-preview` |
| Scenarios | `GET/POST /scenarios`, `GET/PATCH/DELETE /scenarios/{id}`, `GET/POST /scenarios/{id}/versions`, `GET/PATCH /scenario-versions/{id}`, `POST /scenario-versions/{id}/validate`, `GET /scenario-versions/{id}/results` |
| Jobs | `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`, `POST /jobs/{id}/retry`, `GET/POST /scenario-versions/{id}/jobs` |
| Rules (phase 2) | `GET/POST /rules`, `GET/PATCH /rules/{id}`, `GET/POST /rules/{id}/versions`, `GET/PATCH /rule-versions/{id}`, `POST /rule-versions/{id}/validate`, `POST /rule-versions/{id}/publish`, `POST /rule-versions/{id}/retire` |
| Review | `POST /scenario-versions/{id}/submissions`, `GET /submissions`, `GET /submissions/{id}`, `POST /submissions/{id}/decisions`, `POST /submissions/{id}/promotion`, `GET /promotions/{id}` |
| Plans | `GET/POST /plans`, `GET /plans/{id}`, `GET /plans/{id}/versions`, `GET /plan-versions/{id}` |
| Audit | `GET /audit-events` |
| Health | `GET /healthz`, `GET /readyz` (no auth) |

Phase 1 covers models, scenarios, jobs, review/promotion, plans, audit and reference. Phase 2 adds rule authoring; phase 1 still evaluates seeded/active rule versions during pre-submit validation.

---

## 5. API conventions

- **JSON only.** UUIDs are strings. IDs are generated by the API, not clients.
- **Exact numbers are strings.** Money uses `^-?\d+\.\d{2}$`; decimals/percentages are strings (`0.15` = 15%). This matches the Cube layer and avoids float drift.
- **Time:** RFC 3339 UTC timestamps; dates are `YYYY-MM-DD`; fiscal periods are explicit dates, not inferred.
- **Pagination:** `limit` (1–200, default 50) + opaque `cursor`; response envelope `{data, page_info:{next_cursor,has_more}}`. No offset pagination.
- **Filtering/sorting:** explicit enums; `sort` supports `name`, `created_at`, `updated_at` and `-` prefix for descending.
- **Optimistic concurrency:** mutable resources return `ETag: W/"<row_version>"`; PATCH and state transitions require `If-Match`. Mismatch → `412 Precondition Failed`. Invalid domain transition → `409 Conflict`.
- **Idempotency:** `Idempotency-Key` is required for job submission, retry, publish, submission, and promotion. Reusing a key with a different request hash → `409`. Proposed retention: 7 days.
- **Async:** `202 Accepted` + `Location`; clients poll the returned resource. Job submission returns the `Job`; publish returns the model version plus refresh state; promotion returns a `Promotion`.
- **Errors:** RFC 9457 `application/problem+json` with `type`, `title`, `status`, stable `code`, `correlation_id`, and field-level `errors[]`. No stack traces in production.
- **Correlation:** `X-Correlation-Id` echoed or generated; included in audit and responses.
- **No hard deletes.** DELETE archives the aggregate; history remains.
- **Versioning:** path version `/api/v1`; additive changes within v1; breaking changes require v2.
- **Bulk data never goes in OLTP.** Scenario facts live at `result_uri`; OLTP stores metadata, summaries and audit.

---

## 6. Authorization model

Token (production Entra ID; local HS256 dev token) carries:

```json
{
  "sub": "user-object-id",
  "department_code": "finance",
  "cost_centre_codes": ["cc_finance"],
  "groups": ["business_user"],
  "roles": ["business_user"]
}
```

| Role | Scope |
|---|---|
| `business_user` | Own department (and token cost centres); create/edit own models/scenarios; submit jobs/reviews; read own results |
| `steward` | Cross-department read; review decisions; promotion; plan and rule administration |
| `data_engineer` | Global/foundational model authoring; no financial scenario data by default |
| `admin` | Platform administration; treated as steward for review actions |

Rules:

- Scope is derived from the token server-side. Body/query `department_code` is only honoured for stewards.
- Object-level checks happen on every read and write; use `404` rather than `403` when revealing existence would leak another department’s data.
- Stewards can see cross-department metadata; financial results remain governed by Cube policies too.
- Audit records successful and failed access attempts.
- Every endpoint and Cube query needs positive and cross-department negative tests (AGENTS I7).

---

## 7. Persistence

### Interim DuckDB OLTP

Use a **separate file** from the Cube analytical store: `data/cpm_lite_oltp.duckdb` (Cube uses `data/cpm_lite.duckdb`). Sharing one file would put Cube queries and OLTP writes behind the same single-writer lock. Keep the file name different from the `orchestrator` schema; DuckDB treats matching catalog/schema names as ambiguous.

Schema `orchestrator` contains 20 tables: registry, versions, jobs, rules, submissions, plans, audit, idempotency and outbox.

Key DuckDB constraints that the implementation must respect:

- **Single writer.** Run one API replica against the file. Do not scale the API horizontally until PostgreSQL is in place.
- **No partial indexes.** “One draft version per model/scenario” is enforced by a transactional check, not a unique index.
- **FKs only on immutable reference data.** `department`, `cost_centre` and `plan` keep FKs. Mutable aggregate relationships are app-enforced because DuckDB can reject an `UPDATE` on a row still referenced by a FK; this was reproduced against the actual schema.
- **Keep transactions short.** DuckDB serialises writes; long API transactions block everything else.
- **Forward-only migrations.** No runtime DDL and no ORM auto-sync.

### Model preview snapshot

Model authoring needs real source profiles and a preview without competing with
Cube for the analytical DuckDB file. `make data` writes a read-only copy,
`data/cpm_lite_preview.duckdb`, alongside `data/cpm_lite.duckdb`; the API opens
the copy with `access_mode: READ_ONLY`.

- `GET /api/v1/model-sources` returns the allowlisted `gold.fact_financials`
  source with row count, grain-key uniqueness, column types, samples, distinct
  counts and suggested roles.
- `POST /api/v1/model-preview` accepts a draft definition plus selected
  dimensions/measures. It executes an aggregate over allowlisted source columns
  only, filters on `department_code` from the token (stewards may pass
  `preview_department_code`), and returns rows, totals and scope metadata.
- Arbitrary SQL, non-allowlisted columns and unsupported aggregations are
  rejected. Join authoring and calculated-expression preview are deferred.

The snapshot is only as fresh as the last `make data`; the UI states this.

### ORM: Kysely

Proposed stack: Node.js 24 LTS, TypeScript strict, Fastify 5, Kysely 0.28.19, `kysely-duckdb` 0.4.0, `@duckdb/node-api` 2.0.0-r.1.

Why Kysely: it is the only maintained typed query builder with a DuckDB dialect. A probe verified CRUD, JSON and transaction rollback; FK enforcement was verified on standalone tables, then narrowed in this schema because DuckDB rejects updates to referenced rows.

Non-obvious constraints:

- **Pin Kysely 0.28.19.** `kysely-duckdb@0.4.0` imports `DEFAULT_MIGRATION_*` from the Kysely root; Kysely 0.29 moved them to `kysely/migration`, so the dialect crashes at import. Upgrade only with a patched/custom dialect.
- **Use `VARCHAR` UUIDs in the DB.** DuckDB returns `UUID` columns as `DuckDBUUIDValue` objects through Kysely, which cannot be rebound to an `ANY` parameter. API/domain values remain UUID strings.
- **JSON columns round-trip as strings.** Serialize with `JSON.stringify` and parse at the domain boundary. Do not pass raw objects to Kysely.
- **DECIMAL round-trips as strings.** Keep strings throughout the API.
- **TIMESTAMPTZ round-trips as `Date`.** Convert to ISO strings at the API boundary.

### Concurrency

- Each mutable aggregate has `row_version`.
- Writes use `UPDATE ... WHERE id = ? AND row_version = ?`; zero affected rows → `412`.
- State-transition writes are one transaction: load + validate + update + audit + outbox.
- One open draft per model/scenario is checked inside the same transaction.
- Retries of idempotent requests return the stored response; a different body hash is `409`.

### PostgreSQL path

The schema deliberately uses `VARCHAR` UUIDs, `TIMESTAMPTZ`, `DECIMAL`, `JSON` and explicit `CHECK`s. Moving to PostgreSQL means:

- `VARCHAR` UUIDs → `UUID` (or keep `VARCHAR`);
- `JSON` → `JSONB`;
- add the cross-aggregate FKs that DuckDB could not add;
- add a partial unique index for one draft per aggregate;
- switch the Kysely dialect;
- remove the single-replica constraint.

---

## 8. Async integration

Use a transactional outbox:

| Event | Produced by | Consumer |
|---|---|---|
| `job.dispatch_requested` | Job submission | Scenario job dispatcher (AKS Job / Container Apps Job) |
| `model_version.cube_refresh_requested` | Model publish | Cube schema refresher |
| `promotion.requested` | Promotion endpoint | Promotion worker |

The outbox row is written in the same transaction as the state change. Consumers must be idempotent by `outbox_event_id` and record `status`, `attempts`, `available_at`, `last_error`.

Slice 1 may leave jobs `queued` and Cube refresh `pending`; the API and schema are ready before the workers exist. Do not fake success. `GET /jobs/{id}` and `GET /model-versions/{id}` expose the truthful state.

---

## 9. Decisions taken and implemented

1. Contract-first OpenAPI 3.1; implementation conforms.
2. Separate DuckDB file for OLTP; Cube keeps its analytical file.
3. Kysely 0.28.19 + `kysely-duckdb` 0.4.0 + `@duckdb/node-api` 2.0.0-r.1.
4. ETag/If-Match optimistic concurrency, not body `version` fields.
5. Idempotency-Key for retryable unsafe POSTs.
6. Money/decimals as strings; never floats.
7. Rule authoring and evaluation hooks are implemented; a separate rules service is still future work.
8. Model definitions are structured expressions, not arbitrary SQL.
9. Jobs are async; promotion is executed synchronously but returns `202` for forward compatibility. Bulk results stay outside OLTP.
10. Archive instead of hard delete; audit is append-only.
11. A plan must exist before a promotion; the API does not silently create plans.
12. Scenario execution status and review status are separate fields.
13. Source-first model authoring uses an allowlisted source profile and a
    read-only preview snapshot; arbitrary expressions are not accepted by the
    preview endpoint.

---

## 10. Review questions

Resolved by the phase-1 implementation:

1. **ORM pin:** Kysely 0.28.19 + `kysely-duckdb` 0.4.0 accepted, with a Date/BigInt Kysely plugin.
2. **Single API replica:** accepted while DuckDB is the OLTP store.
3. **Model expression language:** structured expressions are the contract; the validator rejects unsafe/duplicate definitions.
4. **Promotion target:** requires an existing plan.
5. **Cost-centre scope:** optional, enforced against the token when present.
6. **API framework:** Fastify 5 + Kysely implemented.
7. **Decimal responses:** strings, consistent with Cube.
8. **Archive verb:** `DELETE` with archive semantics.

Still open:

1. **Rule definition shape:** typed parameters per `kind` vs the current generic object with a small evaluator.
2. **Cost-centre enforcement depth:** token cost-centre list is checked on writes, but cross-department read filtering is department-level.
3. **Idempotency retention:** 7 days currently; tune with usage.
4. **Workers:** job dispatcher and Cube refresher ownership and timeline.
5. **Audit redaction/retention:** which before/after fields may be stored and for how long.

Deferred: multi-currency/FX, scenario comparison endpoint (Cube serves it), pre-aggregation strategy, and Entra ID app registration details.

---

## 11. Verification performed

- `make lint-api` → OpenAPI valid, zero warnings (Redocly 2.72.1).
- `make verify-api` → end-to-end API test passes: model publish → scenario job → internal completion → submission → approval → promotion, plus cross-department denials, idempotency, and rule-driven validation failure.
- `make typecheck-api` → TypeScript strict typecheck passes.
- Migration applied to DuckDB 2.0; 20 tables and 6+6 reference rows created.
- Representative inserts succeeded across model → version → plan → scenario → job → submission → promotion → outbox.
- Constraints probed and rejected:
  - published model version without `published_at`;
  - plan/scenario base without the required reference;
  - global rule scope with an id;
  - `approved` review on a non-completed scenario;
  - duplicate submission for one scenario version;
  - successful promotion without a plan version;
  - job referencing a missing scenario version (app-level check, since the FK was removed for DuckDB update compatibility);
  - idempotency key with `expires_at <= created_at`.
- Kysely probe: CRUD, JSON, transaction rollback and reference-table FK enforcement work with the pins above.
- Built API served `/healthz`, `/docs`, `/api/v1/openapi.json` and authenticated `/api/v1/me` successfully.
- Model preview test: source profile returns 3 rows in the fixture; finance preview totals `300.00` and sees 2 rows; steward preview-as-finance sees `300.00`; steward unrestricted sees `600.00`; finance requesting HR gets `403`; an unsafe expression gets `422`.

---

## 12. Implementation status

1. **Slice 1 — implemented:** migration runner, Kysely DB layer, auth/scope middleware, models/scenarios/jobs, submission/decision/promotion, rules, audit, idempotency, ETags, outbox writes, internal worker callback, Swagger UI, model source catalog/preview, end-to-end test.
2. **Slice 2 — partly implemented:** rule authoring exists; Cube refresh worker and job dispatcher integration remain.
3. **Slice 3 — pending:** PostgreSQL migration, multi-replica API, Cube token exchange with Entra ID.
