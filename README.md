# CPM Lite

Budgeting, forecasting, scenario modelling and plan promotion for FP&A teams. The
repository contains the Cube Core semantic layer, the Thin Orchestrator API, and
the React task UI, backed by **DuckDB 2.0**.

Cube exposes governed budget/actual metrics from the Kaggle *Budget vs Actual
Financial Dataset* with department row-level scoping. The API owns the model,
scenario, job, rule, review and promotion records. The UI turns those into a
ledger-like planning workspace.

## Full stack quickstart

Node.js 20+ and `unzip` are required. The local setup does not use Docker.

```bash
cp cube/.env.example cube/.env        # set CUBEJS_API_SECRET
cp apps/api/.env.example apps/api/.env # set CPM_API_JWT_SECRET and CPM_API_SERVICE_TOKEN
make setup
make data
make migrate-api
make seed-api
```

Run the services in three terminals:

```bash
make cube    # :4000
make api     # :8080, docs at /docs
make web     # :5173
```

Open <http://localhost:5173>, then paste an API token and an optional Cube token
on the Connection screen. Mint them with:

```bash
npm --prefix apps/api run token -- --department finance
npm --prefix cube run token -- --department finance
```

`make test` runs the Cube verifier, OpenAPI lint, API end-to-end test, and UI
production build.

## Cube semantic layer

Prerequisites: Node.js 20+, `unzip`, and network access on the first DuckDB extension install.

`npm` may report that `@cubejs-backend/native` / `cubestore` install scripts were skipped. Cube's REST semantic layer and `make verify` do not need them; approve those scripts only if you later add the SQL API or Cube Store.

```bash
make setup
cp cube/.env.example cube/.env       # set CUBEJS_API_SECRET
make data                            # builds data/cpm_lite.duckdb
make cube                            # Cube on http://localhost:4000
```

In another terminal, mint a local development token and query:

```bash
export CUBEJS_API_SECRET="$(grep '^CUBEJS_API_SECRET=' cube/.env | cut -d= -f2-)"
TOKEN=$(npm --prefix cube run token -- --department finance)

curl -sS http://localhost:4000/cubejs-api/v1/load \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": {
      "measures": ["budget_vs_actual.budget_amount", "budget_vs_actual.actual_amount"],
      "dimensions": ["budget_vs_actual.department"]
    }
  }'
```

`--role steward` mints a token that sees every department. Business-user tokens require `--department` and are filtered to that department by Cube row-level access policies.

## Semantic model

| Member | Type | Notes |
|---|---|---|
| `financials` | cube | Governed fact cube: budget, actual, variance, transaction count |
| `departments`, `categories`, `regions` | cubes | Reference dimensions joined from the gold layer |
| `budget_vs_actual` | view | Business-facing view with `department`, `category`, `region` aliases |
| `budget_amount`, `actual_amount` | measures | Sums; USD |
| `variance_amount` | measure | Actual minus budget; positive means overspend |
| `variance_pct`, `actual_to_budget_pct` | measures | Fractions, formatted as percentages |
| `transaction_count` | measure | Governed row count |
| `transaction_date` | time dimension | Query by day, month, quarter, year |
| `period` | dimension | `YYYY-MM` |

DuckDB `DECIMAL` measures are serialized by Cube's DuckDB driver as strings (`"132834178"`) so cents are not lost. Parse them with a decimal library; do not use `parseFloat`. Percentages are fractions (`0.15` means 15%).

Access policy:

- `steward` group: all rows.
- `business_user` group: rows where `department_code = {SECURITY_CONTEXT.department_code}`.
- Tokens are verified with `CUBEJS_API_SECRET` (HS256) by `cube.js`; headers and query parameters are never trusted.

Production replaces the local HS256 check with Microsoft Entra ID (OIDC/JWKS). That integration remains an open decision in `AGENTS.md`.

## Data layer

`make data` reads the workbook from `sample_data/` and builds:

| Object | Rows | Purpose |
|---|---:|---|
| `staging.financials_raw` | 10,010 | Raw workbook rows |
| `staging.financials_dedup` | 10,000 | Exact duplicate rows collapsed |
| `gold.fact_financials` | 9,995 | Governed fact |
| `gold.rejected_financials` | 5 | Rows with missing department/category/region |
| `gold.dim_department` | 6 | Department reference |
| `gold.dim_category` | 6 | Category reference |
| `gold.dim_region` | 5 | Region reference |
| `gold.dim_date` | 1,095 | Daily calendar for 2021–2023 |
| `ops.data_load_run` | 1 per load | Append-only load audit with source SHA-256 |
| `gold.v_data_quality` | latest | Load audit view |

Data-quality decisions:

- Exact duplicate source rows are collapsed; the dataset contains 10 duplicate transaction rows.
- Transaction IDs may repeat only when the full row is identical; conflicting IDs fail the load.
- Rows missing department, category, region, or payment method are quarantined, not silently assigned.
- The reporting currency is assumed to be USD (the dataset has no currency column).
- Budget and actual amounts are stored as `DECIMAL(18,2)`, never floats.

## DuckDB 2.0 compatibility

Cube's `@cubejs-backend/duckdb-driver@1.8.16` depends on `@duckdb/node-api@1.5.5`, which cannot read a DuckDB 2.0 storage file (format version 999). `cube/package.json` overrides the Node API to `2.0.0-r.1`; the driver API used by Cube is unchanged. When upgrading Cube, re-check this override and run `make verify`. See `docs/adr/0001-cube-duckdb-semantic-layer.md`.

## Verification

```bash
make data
make verify
```

`make verify` starts Cube on a free port with its own secret, then checks:

- steward totals per department against direct DuckDB SQL;
- finance and HR business users see exactly their own department;
- the joined `budget_vs_actual` view returns category and region;
- the base `financials` cube cannot be used to bypass the view's access policy;
- missing, invalid, and unscoped tokens return `403`.

The verifier runs from a temporary directory so a developer's `cube/.env` cannot weaken the checks.

## Thin Orchestrator API (phase 1)

The API is implemented with Node.js, Fastify 5, TypeScript, and Kysely over a
separate DuckDB 2.0 OLTP file. The committed OpenAPI contract remains the source
of truth.

```bash
cp apps/api/.env.example apps/api/.env   # set CPM_API_JWT_SECRET and CPM_API_SERVICE_TOKEN
make migrate-api
make seed-api
make api
```

- Swagger UI: <http://localhost:8080/docs>
- OpenAPI JSON: <http://localhost:8080/api/v1/openapi.json>
- Health: `/healthz`; readiness: `/readyz`

Mint a local token and call the API:

```bash
TOKEN=$(npm --prefix apps/api run token -- --department finance)
curl -sS http://localhost:8080/api/v1/me -H "Authorization: Bearer $TOKEN"
```

The internal worker callback completes a queued job:

```bash
curl -X POST http://localhost:8080/internal/v1/jobs/<job_id>/status \
  -H "X-CPM-Service-Token: $CPM_API_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed","result":{"result_uri":"ducklake://results/...","totals":{...}}}'
```

Implementation notes:

- OLTP file: `data/cpm_lite_oltp.duckdb`, schema `orchestrator`; keep the file name different from the schema to avoid DuckDB catalog/schema ambiguity.
- Model authoring uses `GET /api/v1/model-sources` for governed source profiles and `POST /api/v1/model-preview` for authorized aggregate previews. Preview reads a read-only copy, `data/cpm_lite_preview.duckdb`, created by `make data`; this avoids competing with Cube for the primary DuckDB lock. Only allowlisted source columns and aggregations are accepted; arbitrary expressions are rejected.
- Run one API replica while DuckDB is the OLTP store.
- Kysely is pinned to 0.28.19; a query plugin converts `Date` values to ISO strings and BigInt results to numbers because of `kysely-duckdb` limitations.
- FKs are kept on immutable reference data; mutable aggregate links are checked by the service because DuckDB can reject updates to rows still referenced by FKs.
- Jobs remain `queued` and Cube refresh remains `pending` until their external workers consume the outbox. The API never fakes completion.

Run all checks:

```bash
make test
```

This runs the Cube verifier, OpenAPI lint, TypeScript typecheck, and the API end-to-end test.

## CPM Lite UI

React 19 + TypeScript + Vite product UI for the orchestrator and Cube variance
view. It uses TanStack Query, native dialogs, and a custom ledger-style design
system rather than a component kit.

```bash
# API on :8080 and Cube on :4000 first
make web
```

Open <http://localhost:5173>. The Vite dev server proxies `/api`, `/docs` and
`/cubejs-api` to the local services.

On the Connection screen, paste:

- an API token from `npm --prefix apps/api run token -- --department finance`
- an optional Cube token from `npm --prefix cube run token -- --department finance`

Tokens live in the tab's session storage. The UI covers the portfolio overview,
models and model versions, scenarios and runs, jobs, reviews/decisions and
promotion, plans, rules, audit, and the governed variance view. Use
`make build-web` for a production build.

### Model Studio

`Models → New model` opens a source-first Model Studio: choose a governed source,
confirm its grain, select dimensions and measures, set department access, then
review and create a draft. The draft is validated immediately; publishing stays
an explicit action on the model page.

The source profile comes from `GET /api/v1/model-sources`; the live preview comes
from `POST /api/v1/model-preview`, which applies the caller's department scope
server-side. The preview reads `data/cpm_lite_preview.duckdb`, a read-only copy
created by `make data`, so it does not contend with Cube for the analytical file
lock. Join authoring, templates and the code editor remain follow-up slices.

## Layout

```
apps/api/                    Fastify orchestrator: routes, services, auth, migrations, tests
apps/web/                    React task UI: models, scenarios, jobs, reviews, plans, rules, variance
cube/                        Cube Core semantic layer
  cube.js                    Cube config: DuckDB driver, JWT auth, groups, RLS guard
  model/cubes/financials.yml Fact cube and access policy
  model/cubes/reference.yml  Department/category/region cubes
  model/views/               Business-facing view
  scripts/load-data.mjs      DuckDB 2.0 gold-layer loader
  scripts/verify.mjs         End-to-end semantic-layer checks
  scripts/mint-token.mjs     Local JWT generator
packages/contracts/          OpenAPI contract + Redocly lint
db/migrations/               Forward-only OLTP migrations
db/seeds/                    Synthetic department/cost-centre reference data
docs/api/                    API design/review notes
docs/ui/                     Model Studio product/UX brief
docs/adr/                    Architecture decision records
PRODUCT.md                   Product truth and user/job context
DESIGN.md                    Durable visual system and UI guardrails
data/                        Generated DuckDB files (gitignored)
sample_data/                 Source workbook (synthetic demo data)
```

## Not in scope here

- Scenario job dispatcher and scenario compute engine (`services/jobs`)
- Cube schema-refresh worker
- Business rule registry as a separate service (`services/rules`)
- Production identity, Cube Store, pre-aggregations, and read-only DuckDB deployment
- Real-time data refresh; DuckDB files are build artifacts
