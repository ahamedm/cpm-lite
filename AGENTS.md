# AGENTS.md — CPM Lite

Thin-layer budgeting, forecasting, scenario modelling and plan-promotion platform.
**Status: phase 1.** The Cube Core semantic layer (including dynamic schema for published models), DuckDB 2.0 gold layer, Thin Orchestrator API and React task UI are working. The external scenario worker and production identity remain.

## Progress snapshot

Verified on 2026-11-04:

| Area | Implemented |
|---|---|
| **Semantic layer** | Cube 1.8.17 over DuckDB 2.0; 9,995 governed facts across 6 departments; `budget_vs_actual` view; department row-level policies; dynamic Cube schema materialised from published model versions by the in-process refresh worker. `make verify` checks totals, scoping, the joined view, auth failures, generated-schema loading and hot reload. |
| **OLTP + API** | 20-table `orchestrator` schema in `data/cpm_lite_oltp.duckdb`; Fastify 5 + Kysely API for models, scenarios, jobs, rules, submissions/decisions, promotions, plans, audit and reference data. Governed source profiling at `/api/v1/model-sources` and authorized aggregate preview at `/api/v1/model-preview`; preview reads the read-only `data/cpm_lite_preview.duckdb` snapshot. Swagger UI at `/docs`, OpenAPI at `/api/v1/openapi.json`; ETags, idempotency, outbox and worker callback are implemented. `make verify-api` covers the end-to-end workflow and denials. |
| **UI** | React 19 + Vite task UI covering connection, portfolio, models/model versions, the source-first Model Studio, scenarios/validation/runs, jobs, reviews/decisions, promotion, plans, rules, audit and the Cube-backed variance view. `make build-web` typechecks and builds; the flows were reviewed at 1440 px and 390 px. |
| **Docs** | PRD, C4 DSL, ADRs 0001–0006, API design notes, Model Studio brief, PRODUCT.md, DESIGN.md, root README and `apps/web/README.md`. |
| **Checks** | `make test` passes: Cube verifier, Cube repository tests, OpenAPI lint, API typecheck/end-to-end test, UI production build. `make audit` verifies direct dependency currency and npm advisories. |

Still outstanding: the external scenario worker, Entra ID integration, PostgreSQL migration, Cube Store/pre-aggregations, and the open decisions below.

## What this is

CPM Lite (the repo name; the PRD calls it *EPM / CPM Platform*) lets department planners and FP&A users:

1. compose simple models (dimensions, measures, facts),
2. create budget/forecast scenarios from a base plan or actuals,
3. run each scenario as an isolated job with rule-driven cost allocation,
4. submit results for steward review and promote approved scenarios to the official Plan.

It is deliberately a **thin layer** over Cube Core, DuckDB/DuckLake, PostgreSQL and optional dbt. Do not rebuild what those tools already do.

**Out of scope (MVP):** replacing enterprise data pipelines or the Gold layer, ML/statistical forecasting engines, statutory consolidation and pixel-perfect reporting, real-time multi-user cell editing, and a full proprietary BRMS. If a request lands here, say so rather than expanding scope.

## Sources of truth

| Document | Authority |
|---|---|
| `docs/EPM_CPM_Platform_PRD.md` | Product scope, functional requirements (FR-*), NFR placeholders, roles |
| `design/c4_architecture_intent.dsl` | Containers, components, responsibilities, relationships, Azure deployment intent |
| `packages/contracts/openapi/thin-orchestrator.v1.yaml` | HTTP contract for the Thin Orchestrator API (implemented phase 1) |
| `docs/ui/model-studio.md` | Agreed Model Studio flow, API needs and MVP boundary |
| `docs/api/thin-orchestrator-api.md` | API design, state machines, persistence and review questions |
| `AGENTS.md` (this file) | Engineering rules and conventions for agents and humans |

Precedence: PRD for **what**, C4 DSL for **how it is structured**, OpenAPI for the **HTTP shape**, this file for **how we build it**. If they conflict, stop and surface the conflict; do not silently pick one. When behaviour or architecture changes, update the affected document in the same change (plus an ADR under `docs/adr/` for significant decisions).

Read the relevant PRD section and the DSL before changing a container boundary, lifecycle, rule, or promotion flow.

## Commands

Node.js 20+ and `unzip` are required. The local setup does not use Docker.

| Command | What it does |
|---|---|
| `cp cube/.env.example cube/.env` | Local Cube config; set `CUBEJS_API_SECRET` |
| `cp apps/api/.env.example apps/api/.env` | Local API config; set `CPM_API_JWT_SECRET` and `CPM_API_SERVICE_TOKEN` |
| `make setup` | Install Cube, contract, API and UI dependencies |
| `make data` | Load the workbook and rebuild `data/cpm_lite.duckdb` |
| `make cube` | Start Cube on `http://localhost:4000` |
| `make verify` | Start Cube on a free port and run semantic-layer/access/dynamic-schema checks |
| `make lint-api` | Lint the Thin Orchestrator OpenAPI contract |
| `make migrate-api` | Apply forward-only migrations to `data/cpm_lite_oltp.duckdb` |
| `make seed-api` | Seed reference departments and cost centres |
| `make promote-cube-schema` | Promote generated models to reviewed static Cube YAML (maintenance window; ADR 0006) |
| `make api` | Start the API on `http://localhost:8080`; docs at `/docs` |
| `make web` | Start the React UI on `http://localhost:5173` |
| `make build-api` | TypeScript build to `apps/api/dist` |
| `make typecheck-api` | Typecheck the API |
| `make verify-api` | Run the API end-to-end integration test |
| `make test-cube` | Run the Cube schema-repository tests (file and Valkey transports) |
| `make build-web` | Typecheck and production-build the UI |
| `make audit` | Check direct dependency currency and npm advisories (network required; not part of `make test`) |
| `make test` | Cube verify + Cube tests + OpenAPI lint + API typecheck/tests + UI build |

`make verify` checks the semantic layer; `make lint-api` checks the contract; `make verify-api` checks the orchestrator end to end. API documentation is served at `/docs` with the OpenAPI JSON at `/api/v1/openapi.json`. The UI proxies `/api`, `/docs` and `/cubejs-api` through Vite during development. `make audit` is the dependency/supply-chain gate; see [Dependencies & supply chain](#dependencies--supply-chain-mandatory).

## Repository layout

Existing:

```
apps/api/            Fastify + Kysely orchestrator: routes, services, auth, migrations, tests
apps/web/            React + Vite task UI: portfolio, models, scenarios, jobs, reviews, plans, rules, variance
cube/                Cube Core project: config, cubes, view, loader, verifier, token tool
packages/contracts/  OpenAPI contract, schemas and Redocly lint
db/                  Forward-only OLTP migrations and synthetic reference seeds
docs/                PRD, ADRs, API review notes, runbooks
data/                Generated DuckDB files + staging + extensions (gitignored)
design/              C4 Structurizr DSL
sample_data/         Synthetic Kaggle workbook (demo Gold data)
scripts/             Repo-level checks (dependency currency + npm advisories)
security/            Accepted high-severity npm advisories with reasons and review dates
```

Not created yet:

```
services/jobs/       Ephemeral scenario job entry point
services/rules/      Rule registry + evaluation engine
packages/domain/     Entities, lifecycles, allocation contracts
dbt/                 Optional light dbt project
infra/               Azure/AKS, PostgreSQL, ADLS, observability
tests/               Cross-service integration/e2e fixtures
```

## Architecture

| Container | Owns | Must not |
|---|---|---|
| **Web UI** (`React/TS`) | Model composer, scenario screens, job status, comparisons, review/promotion screens, scoped navigation | Talk to the database directly; hold service credentials; be the only place access is filtered |
| **Thin Layer API** | Registry, workflow, job submission, pre-submit validation, promotion, Cube schema refresh, dbt triggers | Run heavy scenario compute in-process; bypass the rules engine |
| **Rules** | Versioned rule definitions, scoped/effective-dated resolution, stateless evaluation at pre-submit, allocation, post-calculation and promotion | Execute arbitrary user code; hold scenario state |
| **Cube Core** | Semantic layer, governed metrics, dimensions, access policies, dynamic schema loading from the shared cache (boot + refresh events), primary analytical query entry point | Become the system of record |
| **Schema Snapshot Cache (Valkey)** | Content-addressed Cube schema snapshots, promoted-model exclusions and refresh events shared by API and Cube replicas | Become the system of record; hold model definitions or financial rows |
| **DuckDB / DuckLake (OLAP)** | Columnar compute, driver calculations, allocations, hybrid reads | Be shared between concurrent jobs |
| **PostgreSQL (OLTP)** | System of record: catalog, model versions, scenarios, jobs, workflow, rules, audit, promoted plans | Store bulk scenario facts if a columnar store is the better fit |
| **Scenario Jobs** | Exclusive compute per run: base calc → allocation → post-validation → result write-back | Reuse another job's DuckDB instance, temp schema or lock |
| **dbt (optional)** | Targeted transforms for simple business models | Take over foundational Data Engineering models |

**Implemented slice:** `cube/` runs Cube Core 1.8.17 against `data/cpm_lite.duckdb` (DuckDB 2.0) via `@cubejs-backend/duckdb-driver`. `cube/package.json` overrides `@duckdb/node-api` to `2.0.0-r.1` because the driver pins 1.5.5 and cannot read DuckDB 2.0 storage. The `gold` schema, `budget_vs_actual` view, and department row-level policies are live. See `docs/adr/0001-cube-duckdb-semantic-layer.md`.

The Thin Orchestrator API is implemented in `apps/api` (Fastify 5 + Kysely + DuckDB) and serves Swagger UI at `/docs` and the OpenAPI JSON at `/api/v1/openapi.json`. It covers models, scenarios, jobs, rules, review/decisions, promotion, plans, audit, idempotency, ETags and an internal worker callback. The Cube refresh consumer is implemented in-process (DuckDB single writer): it materialises published model versions into a content-addressed Cube schema snapshot (file or Valkey), verifies it against Cube, and records `succeeded`/`failed`. Scenario compute and job dispatch remain external workers. See `docs/adr/0002-thin-orchestrator-api.md`, `docs/adr/0004-cube-dynamic-schema-refresh.md`, `docs/adr/0005-valkey-schema-store.md` and `docs/adr/0006-promote-dynamic-schema-to-static-yaml.md`.

The Thin Layer UI is implemented in `apps/web` (React 19 + Vite + TanStack Query) with a custom ledger-style design system. It covers the portfolio overview, models, the source-first Model Studio, scenarios, jobs, reviews/decisions, promotion, plans, rules, audit and the Cube-backed variance view. API/Cube tokens are entered on the Connection screen and kept in session storage. See `apps/web/README.md` and `docs/ui/model-studio.md`.

### Canonical flows

- **Publish model:** UI → API validates → new immutable model version in OLTP → Cube schema refresh.
- **Submit scenario:** UI → API resolves applicable rules and pins inputs → persist scenario version + job payload → enqueue → `202` with job id.
- **Run job:** dequeue → acquire exclusive lock → start exclusive DuckDB → load pinned base data → apply drivers/adjustments → allocate → post-validate → write results + rule audit + terminal status → release lock.
- **Promote:** Steward approves → API evaluates promotion gates → write a new Plan version from the approved scenario snapshot → audit.

## Domain glossary

Use these terms exactly; do not introduce synonyms in code or UI.

- **Model / Model Version** — business-user definition of dimensions, measures and joins. Versions are immutable once published.
- **Dimension / Measure / Fact** — semantic building blocks exposed through Cube.
- **Scenario / Scenario Version** — a what-if based on a base plan or actuals, with drivers, adjustments and assumptions.
- **Driver / Adjustment / Assumption** — named input that changes scenario output (growth %, headcount, spend, etc.).
- **Job / Job Attempt** — one asynchronous execution of one scenario version, in an exclusive compute instance.
- **Allocation Strategy / Pool / Driver Basis / Residual** — pluggable cost-allocation rule, the cost pool being spread, the basis used, and the unallocated remainder.
- **Business Rule / Rule Version / Scope / Effective Window / Evaluation Point** — rules-as-data, scoped to global/department/cost centre/scenario type, evaluated at `pre_submit`, `allocation`, `post_calculation` or `promotion`.
- **Plan / Plan Version** — the official approved plan; promotion creates a new version.
- **Promotion** — the audited act of turning an approved scenario snapshot into a Plan version.
- **Department / Cost Centre** — the authorization and data-scoping units.

## Lifecycles

**Model:** `draft → validated → published` (published versions immutable; changes create a new draft/version).

**Scenario:** `draft → queued → running → completed | failed | cancelled`, then review `submitted → approved | rejected | changes_requested`, then `promoted`. Review and promotion always target a specific, immutable `scenario_version_id`. Rejection never mutates a completed version.

**Job:** `queued → running → completed | failed | cancelled`. Terminal status is always written, including on cancellation or node eviction. Retries are bounded by policy and recorded as attempts.

**Rule:** new version on every edit; never update an existing version in place. Resolution is by scope + effective date + priority, and the resolved rule versions are pinned into the job payload.

## Non-negotiable invariants

- **I1 — Thin layer.** No bespoke query engine, scheduler, OLAP store, BI layer or BRMS. Reuse Cube, DuckDB, PostgreSQL and dbt. If a feature seems to need a new core engine, raise it first.
- **I2 — Job isolation.** Exactly one exclusive DuckDB instance/lock per job. No shared temp schemas, no cross-scenario reads, no orphaned locks. Release in a `finally` path.
- **I3 — Reproducibility.** A job payload pins scenario version, model versions, resolved rule versions, allocation strategy, dataset/period and code/image version. Re-running the same payload must produce the same result.
- **I4 — Immutability.** Published models, rule versions, completed scenario versions, audit records and promoted plans are immutable. Edits create new versions.
- **I5 — Rules are data.** No allocation percentages, thresholds, approver names or tolerances hardcoded in application code. Rules are versioned, scoped and effective-dated. Evaluation is declarative and side-effect free — never `eval`, dynamic imports or user-supplied SQL.
- **I6 — Strategy pattern for allocation.** Headcount, revenue, usage, fixed % and custom methods implement one `AllocationStrategy` contract; do not grow an `if/else` chain.
- **I7 — Authorization is server-side.** Deny by default. Enforce department/cost-centre scope in the API **and** in Cube access policies. UI filtering is UX, not security. Every new endpoint/query needs positive and cross-department negative tests.
- **I8 — Audit is append-only.** Record actor, timestamp, action, before/after, correlation id, and the rule/model versions used. Never update or delete audit rows.
- **I9 — Promotion gate.** Only an approved scenario version, only by a steward, only after promotion rules pass. Promotion is idempotent and creates a new Plan version plus audit.
- **I10 — Gold is read-only.** Never write to the enterprise Gold layer. Scenario results go to a dedicated results location keyed by scenario/version/job, never overwriting another scenario's output.
- **I11 — Money is deterministic.** Use fixed-point decimals, never floats. Percentages are fractions (`0.15`, not `15`). Allocation must balance to the pool within the configured tolerance; distribute rounding remainders deterministically.
- **I12 — No magic NFR numbers.** PRD placeholders (`{{scenario_p95_sec}}`, `{{authz_ms}}`, etc.) live in configuration, never in code. When resolved, update the PRD and the quality-attribute catalogue together.
- **I13 — Synthetic data only.** No real customer financials in the repo, CI, demos or non-production environments.
- **I14 — Idempotent writes.** Async submissions, retries and promotions must be safe to repeat; use an idempotency key per logical operation.

## Conventions

- **Naming:** `snake_case` for database columns, JSON fields and SQL; `PascalCase` for types/classes; `camelCase` for local variables. IDs are `<entity>_id` (UUID); human-readable business keys are a separate `code`. Use the domain terms above verbatim.
- **API:** versioned under `/api/v1`; contract-first OpenAPI in `packages/contracts`; async work returns `202` + job resource; errors are RFC 9457 `application/problem+json` with a stable `code` and `correlation_id`; no stack traces or internal details.
- **Money & time:** `NUMERIC/DECIMAL` in PostgreSQL and DuckDB with an explicit ISO 4217 `currency_code`; Cube/DuckDB DECIMAL measures are serialized as strings by the DuckDB driver — parse them with a decimal library, never `parseFloat`; timestamps are UTC `timestamptz`/ISO 8601; fiscal periods are `YYYY-MM` backed by an explicit fiscal calendar, never inferred from a date; effective windows are `[valid_from, valid_to)`.
- **Enums:** lowercase `snake_case` text values with DB `CHECK` constraints; no magic integers.
- **SQL:** parameterized only; schema-qualified; explicit column lists in contracts and migrations; no `SELECT *` in application code.
- **Config:** 12-factor environment variables, validated at startup; secrets from Key Vault/env only. Never commit credentials.
- **Migrations:** forward-only, reviewed, expand/contract for destructive changes; no runtime DDL.
- **Dependencies:** do not add a library that duplicates Cube, DuckDB, PostgreSQL or dbt responsibilities. Justify new infrastructure in an ADR.
- **Observability:** structured JSON logs with `correlation_id`, `job_id`, `scenario_id`, `rule_version`; OpenTelemetry traces across API → job → Cube; never log full financial rows or tokens at info level.

## UI work — anti-slop (mandatory)

Any change under `apps/web/`, or any user-facing copy, layout, component or
screen, **must start by invoking the `impeccable` skill**. It is the required
design review for this product, not an optional style aid. Load the
**product register** rules, then apply them to the existing CPM Lite design
system rather than importing a new aesthetic.

If the skill is not exposed by the current host:

- stop and ask for it to be installed, or install it through the capability
  installer where available;
- do not silently substitute generic design advice;
- never claim the skill was used when it was not.

When the skill is available, it must be applied together with these project
rules:

- Read `apps/web/README.md` and reuse the tokens, `ui.tsx` primitives and page
  patterns already in place. Do not introduce a second design system.
- Product register, not marketing: calm neutral canvas, ink rail, copper accent,
  IBM Plex Sans/Mono, hairline rules, dense ledger tables and native dialogs.
- Ban: gradient text or backgrounds, glassmorphism, card grids as the default
  layout, side-stripe accent borders, eyebrow kickers on every section,
  oversized hero metrics, decorative numbered markers, pill clusters and fake
  depth.
- Use the accent for primary action and current selection only; use semantic
  green/amber/red only for state. Do not color-code decoration.
- Motion only for state feedback, 140–180 ms, and disabled under
  `prefers-reduced-motion`.
- Responsiveness is structural: rail becomes a wrapping top nav at 900 px, split
  panes stack, tables scroll inside `.table-wrap`, and the page itself never
  overflows horizontally at 390 px.
- Every screen needs loading, empty, error, disabled and permission-read-only
  states. Never simulate job completion or fabricate financial values.
- Use `personLabel`, `shortId`, `money`, `percent`, `periodLabel` and the other
  `format.ts` helpers; do not leak raw internal subjects or UUIDs when a human
  label exists. Money and codes are monospace.

Before calling UI work done, record that:

1. the `impeccable` skill was invoked (or the blocker was surfaced);
2. `make build-web` passes;
3. the changed screens were reviewed at 1440 px and 390 px;
4. loading, empty, error, disabled and permission states were checked;
5. no horizontal overflow remains at 390 px;
6. focus, contrast and keyboard paths are usable;
7. `apps/web/README.md` or the design notes were updated if the design system
   changed.

## Testing

Scale tests to the change; the default bar for this product is:

- **Unit** — domain lifecycles, allocation strategies, rule resolution and evaluation.
- **Property-based** — allocation conserves the pool within tolerance, respects eligibility/constraints, is deterministic, and handles zero/negative driver bases.
- **Rule table tests** — scope precedence, effective dating, priority ties, warn vs reject outcomes.
- **Authorization** — every endpoint and Cube query tested with an authorised user and a cross-department unauthorised user.
- **Semantic layer** — `make verify` checks steward totals against DuckDB, per-department scoping, the joined view, 403s for missing/invalid/unscoped tokens, and dynamic generated-schema loading plus hot reload. Run it after model, policy, loader or driver changes.
- **Cube refresh** — `npm --prefix apps/api test` covers schema rendering, unsafe definitions, verified refresh, rollback with backoff, terminal failure, manual re-queue, the Valkey store and static-YAML promotion; `make test-cube` covers the file and Valkey Cube repositories. Run both after changing the generator, worker, store, promotion or Cube repository.
- **Job integration** — real DuckDB, exclusive locking, cancellation/SIGTERM, retry attempts, orphan-lock absence, terminal status always written.
- **Contract** — OpenAPI schema conformance; Cube query contracts. Run `make lint-api` after changing the spec or implementation.
- **Orchestrator API** — `make verify-api` runs an end-to-end test: model publish → scenario job → internal completion → review → approval → promotion, plus cross-department denials, idempotency, and rule-driven validation failure.
- **UI** — `make build-web` typechecks and production-builds the React app. Review the main flows at desktop (1440) and mobile (390) widths; verify empty, loading, error and disabled states, not just the happy path.
- **E2E** — model publish → scenario run → allocation → variance view → review → promotion, using the synthetic datasets in PRD §8. Treat them as demo Gold data only.
- **Determinism** — same pinned payload yields identical results across reruns.

CI must run lint, typecheck, unit and integration tests; no test may depend on the public internet.

## Security & data handling

- Authenticate via Microsoft Entra ID (OIDC). Validate signature, issuer, audience, expiry and not-before on **every** API request and Cube query; never trust UI claims. The local HS256 JWT in `cube/scripts/mint-token.mjs` is development-only.
- Map identity claims/groups to department and cost-centre membership server-side. Cross-department visibility is role-driven, deny-by-default.
- Least-privilege DB roles: API reads/writes OLTP; jobs read Gold and write only their own results; no runtime DDL.
- Audit successful and failed access attempts.
- Keep tokens, secrets and financial payloads out of logs, traces and error responses.

## Dependencies & supply chain (mandatory)

Model memory of package versions is **not** evidence. Every dependency decision must be checked against the npm registry and the advisory database, not against what an assistant, a scaffold or a boilerplate "remembers". On 2026-11-03 the direct dependencies were re-verified against `latest` and the patch/minor drift was closed:

| Workspace | Stack | Verified state |
|---|---|---|
| `cube` | Cube Core 1.8.17 (`server` + `duckdb-driver`), DuckDB Node API 2.0.0-r.1, ioredis 6.0.0 (optional Valkey schema store) | current; 27 advisories, 0 critical, 6 high accepted in `security/npm-audit-baseline.json` |
| `apps/api` | Fastify 5.12.8, Kysely 0.28.19, TypeScript 5.9, ioredis 6.0.0 (optional) | current except the deliberate Kysely pin (see Notes) and the TypeScript 7 / `@types/node` 26 majors, which are open decisions |
| `apps/web` | React 19.3, Vite 8.3, React Router 7.18, TanStack Query 5.105 | current; 0 advisories |
| `packages/contracts` | Redocly CLI 2.72.1 | current; 0 advisories |

### Required check

Run `make audit` whenever a dependency or lockfile changes, before a release, and at least quarterly. It requires network access and:

1. compares every declared direct dependency in the four workspaces with the npm `latest` dist-tag and reports patch/minor/major drift;
2. runs `npm audit --package-lock-only` per workspace against the committed lockfile;
3. fails on critical advisories, high advisories not recorded in `security/npm-audit-baseline.json`, expired exceptions, and any `@cubejs-backend/*` package below 1.0.0.

`make audit` is deliberately **not** part of `make test`, because no test may depend on the public internet. `node scripts/check-dependencies.mjs --offline` runs only the local Cube-version guard.

### Never trust `npm audit fix`

`npm audit fix` picks the nearest version **outside** an advisory range, which is often a downgrade, not a fix. On this lockfile it proposes:

- `@cubejs-backend/server` 1.8.17 → **0.26.13** — a pre-1.0 downgrade of the same 0.2x generation; Cube 0.x cannot read DuckDB 2.0;
- `@fastify/swagger-ui` 6.1.2 → **2.1.0** — a semver-major downgrade that breaks the API;
- `graphql-scalars` 1.26.0 → **1.24.0** — a pre-advisory version.

Upgrade the direct package forward with an explicit version (`npm install pkg@version`), run `make test`, and only use `npm audit fix` after inspecting the resulting lockfile diff. **Never run `npm audit fix --force` in this repo.**

### Exceptions

- Critical advisories are never accepted.
- A high advisory may be accepted only when no forward fix exists, with the upstream pin, why it is not reachable, and a review date no more than 90 days away.
- Record it in `security/npm-audit-baseline.json`; the check fails when an exception expires and warns when one is no longer needed.
- Moderate/low findings are reported but do not fail the check; fix them with the next upstream patch or when the advisory becomes high.

### Skills for dependency and security checks

Use these skills instead of ad-hoc judgement:

| Skill | When |
|---|---|
| `security-review` | After any dependency, auth, token, query or endpoint change. Reviews the branch diff for injection, authz, secrets, deserialization, path traversal and crypto issues. |
| `research` | To confirm an advisory, the first fixed version, or whether upstream has adopted it; combines registry/upstream sources with code reading. |
| `test` | After upgrading dependencies; runs the project suite and works failures to green. |
| `review` | General correctness review of the dependency or docs change itself. |

`impeccable` is the required review for UI changes, not for dependency checks. Skills are aids; `make audit` and `make test` remain the evidence.

## Definition of done

A change is done when: the relevant PRD requirement is satisfied; invariants I1–I14 still hold; unit/integration tests cover the behaviour (including negative authorization); docs (PRD/DSL/AGENTS/OpenAPI) are updated if behaviour or structure changed; `make lint-api` passes; lint/typecheck/tests pass; for UI changes the anti-slop section above and its review checklist are complete; dependency changes have a fresh `make audit` run and every new high/critical advisory is fixed or recorded with a review date; no scratch files, secrets or debug output remain.

## Open decisions — do not silently choose

Record the resolution in an ADR and update this file when decided.

- **API runtime:** implemented as Node.js 24 + Fastify 5 + Kysely in `apps/api` (ADR 0002). Contract-first remains mandatory.
- **Job runtime:** AKS Jobs vs Azure Container Apps Jobs (DSL deployment view assumes AKS with a dedicated jobs node pool).
- **OLTP engine:** DuckDB 2.0 is the interim store; PostgreSQL is preferred long-term. While DuckDB is used, the API must run as a single writer replica and migration to PostgreSQL must stay mechanical. See ADR 0002.
- **Remaining API questions:** rule parameter typing and cost-centre enforcement depth are still open; the other review questions were resolved by the phase-1 implementation and are recorded in ADR 0002.
- **Identity integration:** Entra ID app registrations, group→scope mapping and Cube token exchange. Local HS256 dev auth exists; it is not production authentication.
- **NFR placeholders:** all `{{...}}` values in PRD §7 remain unresolved.
- **Multi-currency / FX translation:** not specified in the PRD; confirm before modelling currency beyond a single reporting currency.
- **Scenario result retention and pre-aggregation strategy** in Cube/DuckLake.
- **Approval thresholds and approver routing** beyond the rule-driven default.
- **TypeScript 7 / `@types/node` 26:** both are new majors (TypeScript 7 is the native-compiler line). Decide whether to adopt them once `tsx`, Vite and the Kysely/DuckDB typings are verified against them; until then stay on TypeScript 5.9 and `@types/node` 24.

## Notes

- `make data` builds 10,010 raw rows → 10,000 after exact-duplicate collapse → 9,995 governed facts; 5 rows are quarantined in `gold.rejected_financials` for missing department/category/region. It also writes `data/cpm_lite_preview.duckdb`, the read-only snapshot used by Model Studio preview.
- Cube's DuckDB driver 1.8.17 pins `@duckdb/node-api@1.5.5`; the `overrides` entry to `2.0.0-r.1` is required to read DuckDB 2.0 files. Re-check on every Cube upgrade and run `make verify`.
- Cube resolves `schemaPath` relative to the process working directory (`path.join(cwd, schemaPath)`), not relative to `cube.js`.
- `CUBEJS_DEV_MODE=true` disables Cube's security enforcement. `.env.example` sets it to `false`; `make verify` runs with its own secret from a temp directory so a local `.env` cannot weaken the checks.
- Local runs use `CUBEJS_CACHE_AND_QUEUE_DRIVER=memory`; no Cube Store or pre-aggregations yet.
- The DuckDB Excel extension is installed into `data/.duckdb-extensions` so the loader works without a writable `$HOME`.
- The API contract lints with Redocly 2.72.1 via `make lint-api`; keep the committed OpenAPI file as the source of truth.
- OLTP will use a separate DuckDB file (`data/cpm_lite_oltp.duckdb`), not the Cube analytical file. Run one API replica while DuckDB is the OLTP store. Keep the file name different from the `orchestrator` schema (DuckDB catalog/schema name collision).
- Kysely is pinned to 0.28.19 because `kysely-duckdb@0.4.0` imports migration constants removed from Kysely 0.29. Use VARCHAR UUIDs and JSON strings at the Kysely boundary; see ADR 0002.
- `apps/api` converts `Date` parameters to ISO strings and BigInt results to numbers with a Kysely plugin; `kysely-duckdb` cannot bind Dates directly.
- FKs are kept only on immutable reference data. Mutable relationships are service-enforced because DuckDB can reject updates to rows referenced by FKs.
- API docs: `make api` then open `http://localhost:8080/docs`; the raw spec is at `/api/v1/openapi.json`.
- API jobs stay `queued` until the external worker calls `POST /internal/v1/jobs/{job_id}/status` with `X-CPM-Service-Token`.
- Cube refresh is real as of ADR 0004. Publishing writes a `model_version.cube_refresh_requested` outbox event; the in-process consumer (DuckDB single writer) renders all published, non-archived model versions into `data/cube-schema/versions/<sha256>/`, commits `current.json`, then verifies `/meta` and one `load` per cube before marking `succeeded`. Failures roll the pointer back and retry with backoff; the model version and event end `failed` after `CPM_CUBE_REFRESH_MAX_ATTEMPTS`. Cube reads the snapshot through `cube/model/dynamic-repository.cjs` and recompiles when the hash changes.
- Cube verification needs `CPM_CUBE_API_SECRET` set to Cube's `CUBEJS_API_SECRET` (local HS256 only). In the default `file` mode the API and Cube must share `CPM_CUBE_SCHEMA_DIR`; locally it defaults to `data/cube-schema` on both sides. Generated schema is gitignored and reproducible from the registry.
- The schema transport is pluggable (ADR 0005): `CPM_CUBE_SCHEMA_STORE=file` (default, single host) or `valkey` (multi-pod). For Valkey, set the same `CPM_VALKEY_URL` and `CPM_VALKEY_KEY_PREFIX` on the API and Cube; keys are `<prefix>:current`, `<prefix>:versions` and `<prefix>:versions:<hash>:<file>`. Cube caches the pointer for 1s and keeps its last compiled snapshot if Valkey is unavailable; the API writes files first and the pointer last, and rolls back on verification failure. Use `noeviction` or a TTL (`CPM_VALKEY_SCHEMA_TTL_SECONDS`, default 0). Cube Store is not Valkey-backed: cache/queue is `memory` or `cubestore`.
- Cube boot reads the snapshot directly from the configured store (Valkey or file); it never calls the API, so there is no Cube→API→OLTP boot cycle. Commit and rollback publish on `<prefix>:events`; Cube replicas keep a dedicated subscriber that invalidates the 1s pointer cache. Events are advisory — a missed message converges on the next poll, and a restart re-reads the pointer.
- Stable models are promoted to reviewed static YAML (ADR 0006) with `make promote-cube-schema` (optional `-- --model <code>`). This reads the committed snapshot, writes `cube/model/cubes/promoted/<cube>.yml` plus `cube/model/promoted-models.json`, commits a dynamic snapshot without those cubes, and publishes the event. The generator excludes promoted codes; a matching published version is marked `succeeded` with `mode: static_yaml`, while a newer version fails the refresh until the YAML and manifest are re-promoted. Promotion is a maintenance operation: stop the API, run the command, review/commit, deploy, restart.
- `make verify` opens `data/cpm_lite.duckdb`; if a local Cube is already running it holds the DuckDB lock, so point `CPM_DUCKDB_PATH` at a copy, or stop Cube first.
- The UI is a **product** register: IBM Plex Sans/Mono, cool neutral canvas, ink rail, copper action accent, 1px rules, dense ledger tables, native dialogs, no gradients/card grids/glass. Tokens live in `apps/web/src/styles.css`; keep new screens on the same vocabulary.
- Vite proxies `/api`, `/docs` and `/cubejs-api`; UI tokens are stored in `sessionStorage` and cleared on sign-out. There is no token endpoint in the API.
- Model Studio is source-first: `/models/new` uses `/api/v1/model-sources` and `/api/v1/model-preview`; the preview query only accepts allowlisted source columns and aggregations. The API opens `data/cpm_lite_preview.duckdb` read-only because Cube owns the primary DuckDB file; refresh the snapshot with `make data`. Join authoring, templates and a code editor remain follow-up slices.
- The `impeccable` skill was installed and its detector was run over the Model Studio UI (`[]` findings). Keep using it for any further UI change; see the mandatory UI section above.
