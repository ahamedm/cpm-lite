# Model Studio — product and UX brief

Status: agreed direction; implemented in `apps/web` as `/models/new`.
Recorded: 2026-11-01.

**Implementation:** source → grain → fields → access → review; live authorized
preview; create draft and validate. Preview reads the read-only snapshot
`data/cpm_lite_preview.duckdb` created by `make data`, because Cube owns the
primary analytical file. See ADR 0003. Join authoring, templates and a code
editor remain deferred.

## Framing

“Cube” is an implementation term from Cube Core. In the product, the object is a
**Model**: a governed definition of one source, its grain, dimensions, measures
and access scope. The UI should say “model” everywhere. “Cube” stays in code,
Cube YAML and engineering documentation.

The current `New model` dialog is a form for someone who already knows the
answer: one hardcoded starter definition, free-text expressions, no source,
grain, sample data, preview or access mapping. Model Studio replaces it with a
source-first workspace.

## User job

A department planner or FP&A analyst has a governed Gold table and wants to make
it queryable without writing SQL or waiting for a data engineer. They need to
answer four questions confidently:

1. What does one row represent?
2. Which fields can people group and filter by?
3. Which numbers can people aggregate, and in what format?
4. Who is allowed to see which rows?

## Three entry points

| Entry | Audience | Behaviour |
|---|---|---|
| **Start from data** | Default | Pick a governed source, profile it, generate a draft model |
| **Start from a template** | FP&A | Budget vs Actual, Department Spend, Headcount, Vendor Spend |
| **Start from code** | Data engineer | YAML/Cube editor with validation, diff and preview |

All paths produce the same draft model. Code is the escape hatch, not the front
door.

## Flow

Use a persistent recipe rather than a locked wizard:

**Source → Grain → Fields → Access → Review**

1. **Source**
   - Searchable governed source list.
   - Show owner, freshness, row count and sensitivity.
   - Selecting a source loads real column profiles: type, nulls, distinct count,
     sample values and suggested role.

2. **Grain**
   - Ask “What does one row represent?” in plain language.
   - Show the source grain and a duplicate-key check.
   - Prevent fan-out before any measure is created.

3. **Fields**
   - Two-column picker: available columns on the left, model fields on the right.
   - Auto-suggest dimensions (low-cardinality text/dates) and measures (numeric).
   - Rename to business labels; choose aggregation and format.
   - Raw expressions stay behind an advanced affordance.

4. **Access**
   - Map a model field to the department scope.
   - Show the row count a Finance user would see.
   - Stewards can preview as another role; business users are fixed to their
     token scope.

5. **Review**
   - Plain-language summary and validation checks.
   - Live preview table and totals.
   - Create a draft/validate; publishing remains an explicit, versioned action.

## Workspace shape

```
┌ Model studio ──────────────────────────────────────────────────────┐
│ Budget vs Actual model        Draft · autosaved     [Create draft] │
├───────────────┬─────────────────────────────────┬──────────────────┤
│ RECIPE        │ PREVIEW                         │ INSPECTOR        │
│ ✓ Source      │ department | budget | actual | variance             │
│ ✓ Grain       │ Finance    | 46.1M  | 48.0M  | 1.9M                │
│ ● Fields      │ HR         | 12.4M  | 13.1M  | 0.7M                │
│ ○ Access      │ ...                                             │
│ ○ Review      │ [Group by: Department] [Measure: Variance]      │
├───────────────┴─────────────────────────────────┴──────────────────┤
│ Field: Department · string · 6 distinct · 0 nulls                    │
│ [Rename] [Format] [Sample values] [Use as access scope]             │
└─────────────────────────────────────────────────────────────────────┘
```

The preview is the product. It uses the same server-side authorization as the
API; it is not a hardcoded sample.

## Guardrails

- **Grain first.** No model proceeds without a stated grain and duplicate check.
- **Typed money and time.** Currency, percent and fiscal period are fields, not
  expression text.
- **Access is visible.** Department scope is previewable before publish; hiding
  a field is not security.
- **Published models are immutable.** Edits fork a draft; publish shows a diff.
- **No fake previews.** Preview goes through the API and the governed DuckDB
  source with the caller's scope.
- **Desktop-first modelling.** Mobile offers read-only browsing of the studio,
  not a squeezed builder.
- **AI may suggest, never publish.** Suggestions for names, measures or joins
  are proposals a human accepts.

## Borrowed patterns

| Product | Borrow | Skip |
|---|---|---|
| Looker / LookML IDE | Validation, project health, impact analysis | Code-first default for business users |
| Cube Cloud | Model tree with a query playground | Cube jargon and raw YAML as the front door |
| Holistics | Dataset builder, field settings, join suggestions | BI breadth |
| dbt Cloud | Model preview, compiled SQL drawer, lineage | dbt project ceremony |
| Metabase Models | Friendly source-first path, human labels | Shallow relationship handling |
| Excel Power Query | Visible “Applied Steps” recipe | Transform overload |
| Power BI / Tableau | Data-source preview and cardinality display | Dense desktop chrome |
| Airtable | Inline field type/format editing | Row-centric views |
| Linear / Notion | Command palette, autosave, calm empty states | Decoration for its own sake |
| DataHub / Atlan | Ownership, freshness and lineage | Governance dashboards that overwhelm |

## Implemented in this slice

- Governed source catalog with real profiling.
- Source → grain → fields → access → review.
- Live, authorized preview with totals.
- Create draft and validate; publish from the existing model detail.
- No join authoring, templates, AI suggestions or code editor yet.

## Preview data path

`make data` writes `data/cpm_lite.duckdb` for Cube and a read-only copy,
`data/cpm_lite_preview.duckdb`, for Model Studio preview. The API opens the copy
with `access_mode: READ_ONLY`. The preview is a snapshot: it is as fresh as the
last `make data`. This avoids DuckDB's single-writer lock conflict with Cube.

Only allowlisted source columns and aggregations are accepted. Department scope
is applied server-side; stewards may preview another department. The API rejects
arbitrary SQL and unsupported expressions.

## API needs

- `GET /api/v1/model-sources` — allowlisted sources, columns, profiles and
  relationships.
- `POST /api/v1/model-preview` — validated definition + selected dimensions and
  measures; returns grouped rows and totals under the caller's scope.
- Model definitions gain an optional `source` and `access` block. Existing models
  default to `gold.fact_financials`.

## Success signals

- A first model can be created without typing an expression.
- The preview total equals the governed Cube/DuckDB total for the same scope.
- A business user cannot preview another department by changing a request.
- A steward can see the scoped row count before publishing.
