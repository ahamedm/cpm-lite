# CPM Lite UI

React 19 + TypeScript + Vite task UI for the Thin Orchestrator and Cube variance view.

```bash
make setup          # installs api/cube/contracts/web dependencies
make migrate-api
make seed-api
make api            # terminal 1, :8080
make cube           # terminal 2, :4000 (after make data)
make web            # terminal 3, :5173
```

Vite proxies `/api`, `/docs` and `/cubejs-api` to localhost. Tokens are pasted on
the Connection screen and stored in `sessionStorage`; there is no token minting
endpoint.

## Design direction

Product register, not marketing. The physical scene: an FP&A analyst in a bright
office, late morning, moving a scenario from run to steward review. The UI should
feel like a precise ledger: calm, dense, and auditable.

- **Canvas**: cool neutral `oklch(0.972 0.004 220)`, not cream.
- **Rail**: deep ink, one active surface, copper icon for the current section.
- **Accent**: oxidized copper `oklch(0.55 0.13 38)` for primary actions and current
  selection only; semantic green/amber/red carry state.
- **Type**: IBM Plex Sans for UI, IBM Plex Mono for codes, money and timestamps.
  Fixed rem scale; no display font in labels or buttons.
- **Layout**: dense ledger tables, hairline rules, one aside per detail view.
  Cards are not the default; no nested cards, gradients, glass, hero metrics,
  side-stripe accents, or pill-shaped sections.
- **Motion**: 140–180 ms state feedback only; `prefers-reduced-motion` removes it.
- **Responsive**: structural, not fluid type. The rail becomes a wrapping top nav
  at 900 px; split panes stack; tables scroll inside their own container.

Design tokens and primitives live in `src/styles.css` and `src/components/ui.tsx`.

## Model Studio

`/models/new` is a full-page source-first authoring workspace, not a modal. It:

1. loads governed sources and column profiles from `/api/v1/model-sources`;
2. asks for grain confirmation with a real duplicate-key check;
3. lets the user pick columns, rename fields, choose aggregation and format;
4. maps department scope and, for stewards, previews as another department;
5. shows a live, read-only aggregate preview from `/api/v1/model-preview`;
6. creates a draft model and validates it; publishing remains on the model page.

The preview reads `data/cpm_lite_preview.duckdb`, built by `make data` as a
read-only copy of the analytical snapshot. This avoids DuckDB's single-writer
lock contention with Cube. The preview API only accepts allowlisted source
columns and aggregations; arbitrary expressions are rejected.

Follow-up slices: join authoring, templates and a code view.

## Scenario algorithm

The scenario detail page shows the canonical `calculation_plan` and, when the
algorithm was authored in PRQL, the authoring source and its lineage. The plan is
read-only once the version leaves `draft`.

Drafts are edited through **Edit algorithm**. PRQL is the primary mode:

- `from`, `filter`, `derive` and `select` compile to the plan's scan, filter and
  derive stages;
- every derived column needs an explicit type;
- source, columns, grain, pins, drivers and the allocate/validate/write stages
  live in the collapsible **Plan settings** JSON;
- **Compile preview** calls
  `POST /scenario-versions/{id}/algorithm/compile` and shows the resulting
  stages without saving.

**Plan JSON** keeps the canonical `cpm-calculation-plan/0` editor for advanced
changes. The API compiles and validates the result against the version's pinned
model version before saving; invalid sources return path-addressed problem
details in the dialog. Saving does not run the scenario — the existing Validate
action compiles the plan and evaluates pre-submit rules, and the Run action
queues the job.

The API stores `calculation_source`, `calculation_source_hash` and
`calculation_authoring_version` beside the plan. PRQL is authoring lineage; the
canonical plan is what the worker executes. Raw SQL, joins, grouping and window
functions are rejected.

Job detail shows the pinned plan hash and compiler version alongside the other
lineage fields. The Algorithm panel is a read-only view for non-draft versions
and for users outside the scenario's write scope.

## Structure

```
src/
  api.ts             typed fetch client, problem details, ETag/idempotency, Cube
  auth.tsx           sessionStorage token context
  queries.ts         TanStack Query hooks and paged queries
  format.ts          money/percent/date/person labels
  components/        app shell, dialogs, tables, status, toasts
  pages/             portfolio, models, model studio, scenarios, jobs, reviews, plans, rules, variance, audit
```

Every screen has loading, empty, error and disabled states. Jobs remain `queued`
until the scenario worker reports through the internal callback; the UI never
simulates completion.
