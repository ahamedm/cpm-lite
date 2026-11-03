# ADR 0003 — Source-first Model Studio and read-only preview snapshot

- **Status:** Accepted (implemented)
- **Date:** 2026-11-01
- **Deciders:** CPM Lite engineering
- **Related:** PRD §5.1, §5.3, §6.1, §6.6; C4 `ui`, `api`, `cube`, `olap`; ADR 0001; ADR 0002; `docs/ui/model-studio.md`

## Context

Business users need to create a model from a governed source without writing SQL
or waiting for a data engineer. The existing model dialog was expert-first: one
hardcoded starter definition, free-text expressions, and no source, grain,
profile, preview or access mapping.

The UI also needs a trustworthy preview. Cube owns the primary analytical DuckDB
file, and DuckDB permits only one writer process. Opening the same file from the
API is not viable while Cube is running. A hardcoded or client-side preview
would violate the product guardrail that previews use the governed data and the
caller's server-side scope.

## Decision

1. **Product term is Model.** “Cube” remains an implementation term for Cube Core
   YAML; user-facing UI and API resources say model.
2. **Source-first flow:** Source → Grain → Fields → Access → Review. The first
   model source is the allowlisted `gold.fact_financials`; the API returns real
   column profiles, row count and grain-key uniqueness.
3. **Preview snapshot:** the data loader writes a read-only copy,
   `data/cpm_lite_preview.duckdb`, after building the analytical file. The API
   opens this copy with `access_mode: READ_ONLY`. `make data` refreshes both.
4. **Authorized aggregate preview:** `POST /api/v1/model-preview` accepts only
   allowlisted source columns and documented aggregations. It applies department
   scope from the token; stewards may preview another department. Arbitrary SQL
   and arbitrary expressions are rejected.
5. **Model definition:** definitions gain optional `source` and `access` blocks.
   Existing models default to `gold.fact_financials` and `department_code`.
6. **Create, then publish:** Model Studio creates a draft model and immediately
   validates it. Publishing remains an explicit action from the model page,
   preserving the immutable-version lifecycle.
7. **Deferred:** join authoring, templates, a code editor and additional sources.

## Alternatives considered

- **Read the primary analytical file from the API:** rejected; it contends with
  Cube's DuckDB lock.
- **Preview through a draft Cube query:** rejected; unpublished definitions are
  not registered in Cube and dynamic draft registration adds a second schema
  lifecycle.
- **Client-side or hardcoded preview:** rejected; it would show data the caller
  may not be authorized to see and would not validate the definition.
- **PostgreSQL/warehouse preview now:** deferred with the OLTP migration.
- **Free-text expressions in the preview:** rejected; the preview uses an
  allowlisted column set and aggregation enum.

## Consequences

- The preview is a snapshot; it is as fresh as the last `make data`. The UI and
  README state this.
- The API and Cube can run concurrently without a DuckDB lock conflict.
- The first slice supports one source. Adding sources requires catalog metadata,
  source-specific profiling and join support; the API shape is extensible.
- Preview is limited to simple source-column expressions. Calculated measures
  and joins need a later validator/query compiler slice.
- Model creation does not implicitly publish or refresh Cube; the existing
  validate/publish flow remains authoritative.

## Verification

- API tests cover source profiling, finance-scoped preview totals, steward
  preview-as-department, business-user cross-department `403` and unsafe
  expression `422`.
- The OpenAPI contract includes `/api/v1/model-sources` and
  `/api/v1/model-preview`; Swagger UI serves at `/docs`.
- `make test` passes: Cube verification, OpenAPI lint, API end-to-end test and UI
  production build.
- Model Studio was reviewed at 1440 px and 390 px; a draft model was created and
  validated from the UI.
- The impeccable detector reported no findings for the new UI.
