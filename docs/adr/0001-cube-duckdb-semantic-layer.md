# ADR 0001 — Cube semantic layer backed by DuckDB 2.0

- **Status:** Accepted (local/development)
- **Date:** 2026-10-31
- **Deciders:** CPM Lite engineering

## Context

The PRD (§5.3, §6.7) names Cube Core as the primary governed query entry point, with DuckDB as the columnar analytical engine (C4 DSL: `cube`, `olap`). The repository was greenfield and needed a runnable semantic layer over a synthetic dataset (Kaggle Budget vs Actual) to validate modelling, variance measures, and department-scoped access.

Two constraints shaped the implementation:

1. Cube's DuckDB driver (`@cubejs-backend/duckdb-driver@1.8.16`) pins `@duckdb/node-api@1.5.5`. DuckDB 2.0 writes storage format version 999, which the pinned driver rejects with `Trying to read a database file with version number 999`.
2. There is no production identity integration yet, but AGENTS.md invariant I7 requires deny-by-default, server-side department scoping.

## Decision

- Use **Cube Core 1.8.16** with the DuckDB driver, and **DuckDB 2.0** for the analytical store.
- Override `@duckdb/node-api` to **2.0.0-r.1** in `cube/package.json` so the Cube driver can read the 2.0 file. The driver API Cube uses (`DuckDBInstance`, `connect`, `run`, `stream`) is unchanged.
- Build a governed `gold` schema (fact, dimensions, date) plus `staging` and `ops`, using exact-row deduplication and quarantine for invalid dimension rows. Money is `DECIMAL(18,2)`.
- Expose `financials` (cube), reference cubes, and a `budget_vs_actual` view.
- Enforce department scope with Cube **row-level access policies** (`accessPolicy.rowLevel`) keyed on `securityContext.groups`; `contextToGroups` maps JWT groups into policy groups.
- Use a local HS256 JWT (`checkAuth`) for development, with `department_code` and `groups` claims. Production will use Microsoft Entra ID; the local path is not production authentication.
- Run locally with `CUBEJS_CACHE_AND_QUEUE_DRIVER=memory` and no pre-aggregations, so Cube Store is not required.

## Alternatives considered

- **Keep DuckDB 1.5.x** — avoids the override, but contradicts the explicit requirement for DuckDB 2.0 and would create a 2.0/1.5 split across tools.
- **Use PostgreSQL as the Cube data source** — viable long-term OLTP choice, but the task asked for DuckDB and the dataset is analytical.
- **Query DuckDB 2.0 through an external SQL service** — adds infrastructure with no benefit here; the Cube driver works with the override.
- **Custom `queryRewrite` filtering instead of `accessPolicy`** — less declarative and easier to bypass; `accessPolicy` is evaluated in Cube's SQL generation and applies to joined views.
- **Dev-mode unauthenticated playground** — dev mode disables Cube's security enforcement and would expose the model without tokens; the verifier runs with enforcement on.

## Consequences

- `make verify` must pass after any Cube or DuckDB upgrade; the override is the compatibility seam.
- Cube 1.8.16 is pinned. Upgrading requires checking whether the driver's pinned DuckDB Node API has caught up; remove the override once it has.
- Local auth is HS256 with a shared secret. Entra ID/OIDC, token rotation, and group-to-department mapping remain open (recorded in AGENTS.md).
- No pre-aggregations or Cube Store yet; queries hit DuckDB directly. Pre-aggregation strategy and result retention remain open.
- The DuckDB file is read-write to the Cube process. Production should open it read-only or point at a read-only replica; the loader is the only writer by convention.
- Scenario results and the Thin Layer API are out of scope for this ADR.
