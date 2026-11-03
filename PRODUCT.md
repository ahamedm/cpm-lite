# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Department planners and FP&A analysts are the primary users. They create models
and budget/forecast scenarios, run jobs, compare variances and submit results.
Planning stewards review, approve and promote scenarios. Data engineers own the
governed Gold data and the advanced semantic definitions.

## Product Purpose

CPM Lite is a thin budgeting, forecasting, scenario-modelling and plan-promotion
platform. It makes governed financial data queryable through Cube Core, runs
scenario calculations as isolated jobs, and keeps review and promotion auditable.
Success means a planner can move from a governed source to a useful model and a
reviewable plan without waiting for a data engineer for every change.

## Positioning

The product is a thin layer over Cube Core, DuckDB, PostgreSQL and optional dbt.
Its mechanism is a governed semantic model plus a versioned scenario workflow,
not a proprietary query engine, BI tool or BRMS. Financial scope is enforced by
department and cost centre in both the API and Cube.

## Operating Context

Users work at a desktop in a planning cycle: inspect a governed source, define a
model, create or rerun a scenario, compare budget and actual, submit for review,
and promote an approved snapshot into the official plan. Work is asynchronous and
auditable. The current local stack uses DuckDB for both analytical and interim
OLTP storage; production moves to PostgreSQL.

## Capabilities and Constraints

- Models are versioned; published versions are immutable.
- Models expose dimensions, measures, joins and a department access scope.
- Scenarios run as isolated jobs and produce a result summary plus a result URI.
- Rules are versioned data, effective-dated and evaluated at defined points.
- Review decisions and promotions are explicit, auditable transitions.
- Money is fixed-point decimal with an ISO 4217 currency; percentages are
  fractions. Cube/DuckDB decimal measures may arrive as strings.
- The UI must never claim a job completed or fabricate financial data.
- “Cube” is an implementation term; the product object is a **Model**.

## Brand Commitments

The existing product vocabulary is calm, precise and ledger-like: IBM Plex
Sans/Mono, a cool neutral canvas, an ink navigation rail and a restrained copper
accent. It is a working tool, not a marketing surface. Keep that identity.

## Evidence on Hand

- `docs/EPM_CPM_Platform_PRD.md` — product scope and requirements.
- `design/c4_architecture_intent.dsl` — architecture intent.
- `data/cpm_lite.duckdb` — synthetic Kaggle budget-vs-actual Gold data.
- `apps/web/README.md` — current design direction and UI runbook.
- `docs/ui/model-studio.md` — agreed Model Studio direction.

No real customer financials, logos or testimonials exist and none may be
invented.

## Product Principles

1. **Governed by default.** Every query and mutation is scoped server-side.
2. **Source before semantics.** Start from a real source and its grain, not a
   blank definition.
3. **Preview what you publish.** Show the rows, totals and scope the user will
   get, using the real authorization path.
4. **Immutability earns trust.** Versions, reviews and promotions are explicit.
5. **Thin layer, earned familiarity.** Reuse Cube, DuckDB and PostgreSQL; make
   the product feel like a precise tool, not a novel framework.

## Accessibility & Inclusion

Body and placeholder text must meet 4.5:1 contrast; large text 3:1. Keyboard
focus must remain visible, dialogs must trap and restore focus, and motion must
respect `prefers-reduced-motion`. Data tables must remain usable at narrow
widths through contained horizontal scrolling, not page overflow.
