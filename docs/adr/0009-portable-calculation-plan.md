# ADR 0009 — Portable calculation plan (first slice)

- **Status:** Proposed (first slice implemented and wired into scenario versions and the job payload)
- **Date:** 2026-11-21
- **Deciders:** CPM Lite engineering
- **Related:** `docs/design/processing-flow-and-calculation-plan.md` (Draft),
  ADR 0007 (Proposed), ADR 0008 (Accepted), ADR 0010 (Proposed); PRD §4.2,
  §6.2; C4 `api`, `jobs`, `olap`
- **Implementation:** `apps/api/src/calculation/`,
  `apps/api/src/services/calculation-plan.ts`,
  `db/migrations/0003_scenario_calculation_plan.sql`,
  `apps/api/test/calculation-plan.test.ts`,
  `apps/api/test/calculation-plan-service.test.ts`,
  `apps/api/test/api.test.ts`

## Context

The phase-1 model compiler handles member expressions, but there is no
target-neutral representation of a whole scenario calculation. Scenario jobs
are still external, and the design note defines a staged plan
(`cpm-calculation-plan/0`) that composes a base scan, drivers, derived
measures, allocation and validation, then writes result facts.

The design note leaves several decisions open: where the plan lives, which
target is first, how decimal and rounding semantics are pinned, and what the
first implementation slice contains. This ADR records the choices made so the
slice is reviewable and the remaining work is explicit.

## Decision

1. **Canonical plan format.** Implement `cpm-calculation-plan/0` as a strict,
   structurally validated document: declared grain, pinned model/rule versions,
   bound drivers, ordered stages and typed expressions. Unknown fields, unsafe
   identifiers, unknown columns/params, raw operators and unsupported rounding
   modes are rejected. Drivers carry `value`, `type` and `applies_to` so an
   assumption cannot be applied to an unnamed measure. Expression result types
   are declared per `derive` stage; full target-independent type inference is a
   follow-up, not part of this slice.

2. **First-slice location.** Keep the runtime-neutral module in
   `apps/api/src/calculation` for this slice. It imports no Fastify, Kysely or
   database code. Extract it to `packages/domain/calculation` when the external
   scenario worker exists and needs the same compiler. The extraction is
   mechanical and does not change the plan format.

3. **DuckDB is the first target.** Compile `scan`, `filter`, `derive`,
   `allocate`, `write` (metadata) and `validate` (`pool_conservation`) to a
   deterministic DuckDB SELECT. Polars, dbt and client execution remain
   follow-up slices. The compiler emits:
   - explicit casts around every division (`DECIMAL / DECIMAL` returns `DOUBLE`
     in DuckDB);
   - `NULLIF(denominator, 0)` so zero division is `NULL`, never `inf`;
   - half-away-from-zero rounding, the DuckDB default;
   - a deterministic residual assigned to the last member by a declared key;
   - a left join on the declared grain, preserving ineligible/zero-basis rows
     with a zero allocation instead of dropping them.

4. **Lineage fields.** The compiler returns the generated SQL, selected columns,
   `compiler_version` and `plan_hash`. The scenario service validates the plan
   against the scenario version's model version, stores the normalized plan and
   its hash/compiler version, and pins all of them into `job.payload`. The job
   payload also derives `allocation_strategy` from an `allocate` stage.

5. **No scenario data in the repository.** Tests use a small synthetic
   `base_facts` fixture with generic department/cost-centre, amount, percentage,
   basis and pool columns. Domain-specific validation scenarios remain local,
   as requested.

## Consequences

- The calculation is now deterministic, testable and explicit about money,
  rounding and zero division.
- The first slice validates and compiles a plan, executes it on DuckDB and
  checks pool conservation. `npm --prefix apps/api test` passes.
- The compiler is called by the scenario service on create/update/validate and
  again before job submission. The job payload pins the plan, plan hash,
  compiler version and allocation strategy.
- Expression result types are declared, not inferred. A target-independent type
  checker (decimal/integer/date/string compatibility, division and aggregate
  rules) is the next compiler step.
- Grain uniqueness and pool constancy are runtime obligations; the compiler
  cannot infer them. A uniqueness check and a `pool_consistency` validation are
  follow-ups.
- Only DuckDB is targeted. The cross-target conformance suite, Parquet manifest,
  client preview and cost-centre dimension remain future work.

## Next steps

1. Add the Parquet snapshot/result writer and manifest with artifact and logical
   hashes.
2. Add grain-uniqueness and pool-constancy validation checks.
3. Add the Polars and dbt lowerings and run the cross-target conformance suite.
4. Resolve the remaining design-note decisions (Parquet role, artifact security,
   cost-centre dimension, engine pinning) and move this ADR to Accepted.
