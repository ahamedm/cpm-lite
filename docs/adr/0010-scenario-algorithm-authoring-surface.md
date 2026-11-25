# ADR 0010 — Scenario algorithm authoring surface

- **Status:** Accepted (implemented 2026-11-25; canonical plan unchanged)
- **Date:** 2026-11-25
- **Deciders:** CPM Lite engineering, FP&A
- **Related:** ADR 0009 (portable calculation plan); design note
  `docs/design/processing-flow-and-calculation-plan.md` §3.1, §5.4, §6 (V5),
  §11; PRD §4.2, §6.2; C4 `api`, `jobs`, `web`
- **Implementation:** `apps/api/src/calculation/authoring.ts`,
  `apps/api/src/services/calculation-plan.ts`,
  `apps/api/src/services/scenarios.ts`,
  `db/migrations/0004_scenario_calculation_source.sql`,
  `apps/api/test/calculation-authoring.test.ts`,
  `apps/api/test/api.test.ts`,
  `apps/web/src/components/ScenarioAlgorithmPanel.tsx`,
  `apps/web/src/components/scenarioSource.ts`

## Context

A scenario version stores an optional `cpm-calculation-plan/0` document
(`apps/api/src/calculation/plan.ts`). The API validates it structurally,
compiles it to a deterministic DuckDB SELECT (`duckdb.ts`), stores the plan
with a content hash and pins the plan, hash and compiler version into
`job.payload` (ADR 0009).

The only editable surface was a JSON textarea in
`apps/web/src/components/ScenarioAlgorithmPanel.tsx`. A hypothesis was raised
that PRQL would represent the algorithm better and make the UI declarative and
intuitive. The evaluation is recorded in the design note §11; this ADR records
the decision and its implementation.

## Decision

1. **`cpm-calculation-plan/0` remains canonical.** It stays the stored,
   hashed, pinned and executed representation. `plan_hash` continues to cover
   the normalised plan, so equivalent authoring produces one hash and the job
   payload does not depend on an authoring-language compiler version.

2. **PRQL is not the canonical plan.** PRQL compiles queries only: it cannot
   express `grain`, `pins`, `validate`, `write` or the `allocate` semantics,
   and it leaves decimal typing, division, null handling and rounding to the
   target dialect. Those are the guarantees ADR 0009 and I11 exist to pin. A
   user-editable PRQL surface also re-introduces user-supplied SQL through
   `s"..."` (I5).

3. **A PRQL authoring layer sits above the plan.** The implemented format is
   `cpm-calculation-source/0`:

   ```json
   {
     "format": "cpm-calculation-source/0",
     "source": "gold.fact_financials",
     "columns": ["department_code", "budget_amount", "period"],
     "prql": "from gold.fact_financials\nfilter period >= @2026-01-01\nderive adjusted_budget = budget_amount * (1 + growth_pct)\nselect {department_code, adjusted_budget}",
     "types": { "adjusted_budget": "decimal(18,2)" },
     "grain": ["department_code"],
     "pins": { "model_version_id": "...", "semantic_hash": "...", "rule_version_ids": [] },
     "drivers": { "growth_pct": { "value": "0.05", "type": "decimal", "applies_to": "budget_amount" } },
     "stages": [{ "op": "write", "format": "parquet" }]
   }
   ```

   The API compiles the PRQL pipeline into `scan`, `filter` and `derive`
   stages, appends the structured `allocate`/`validate`/`write` stages,
   validates the result as a canonical plan and stores both the source
   (for lineage) and the plan (for execution). The source, its hash and the
   authoring compiler version are stored in
   `calculation_source`, `calculation_source_hash` and
   `calculation_authoring_version`.

4. **The PRQL subset is expression-only.** `from`, `filter`, `derive` and
   `select` are accepted. `from` must name the declared governed source, raw
   SQL (`s"..."`, `f"..."`) is rejected, and joins, grouping, aggregation,
   window functions, `sort` and `take` are rejected. Derived columns require an
   explicit canonical type; missing or unused types are validation errors.
   `select` declares the write measures and must match `write.measures` when
   both are present. The compiler parses `prql_to_pl` and translates the AST;
   it never executes PRQL-generated SQL.

5. **H14 and V5 stay open.** A syntax change is not evidence that planners find
   the representation intuitive; the V5 study remains the acceptance test.

## Evidence

Summarised here; detail and compiled outputs are in design note §11.

| Finding | Consequence |
|---|---|
| Plan stages are only partly relational; `allocate`/`validate`/`write`/`pins` have no PRQL form | The authoring layer keeps them as structured JSON; PRQL covers only the row pipeline |
| `derive rate = amount / basis` lowers to plain `/` (DOUBLE, `inf` on zero) | The canonical compiler still emits the `DECIMAL(38,6)` cast and `NULLIF`; PRQL output is not executed |
| `s"..."` is emitted verbatim into the SELECT | The authoring compiler rejects `SString`/`FString` at the AST boundary |
| Window/aggregate lowering and column types follow the target | Those transforms are rejected; types are declared in `types` |
| `prql-js` 0.12.1 lags `prqlc` 0.13.14 | The binding is pinned and the authoring compiler version is recorded in the source hash lineage |

## Consequences

- Scenario validation, compilation, hashing, pinning and the development
  worker are unchanged: they still consume `calculation_plan`.
- `apps/api` now depends on `prql-js@0.12.1` (WASM). The dependency exists only
  for authoring; it is not imported by the job or Cube paths.
- `scenario_version` gains `calculation_source`, `calculation_source_hash` and
  `calculation_authoring_version`. Migration `0004` is forward-only and
  nullable, so existing versions remain valid.
- Creating or updating an algorithm accepts either `calculation_plan` or
  `calculation_source`, not both. Supplying `calculation_source: null` clears
  both representations; the stored plan always matches the stored source.
- `POST /api/v1/scenario-versions/{id}/algorithm/compile` previews a source
  without saving it. It requires draft status and the same department write
  scope as the version update.
- The UI keeps the canonical JSON editor as an advanced mode and makes PRQL the
  primary editing surface. Any UI change still requires the `impeccable` review
  mandated by `AGENTS.md`.
- Adopting PRQL as the canonical plan would require superseding this ADR and
  ADR 0009 and reworking the hash, pinning and cross-target contracts.

## Alternatives considered

| Alternative | Outcome |
|---|---|
| PRQL as the canonical plan | Rejected: loses decimal/zero-division guarantees, cannot express the non-relational stages, breaches I5 |
| Constrained PRQL subset for expressions | **Chosen and implemented**; PRQL syntax was the requested authoring experience |
| Small infix expression DSL compiled to `PlanExpr` | Not chosen: a PRQL grammar already exists and was explicitly requested; it remains the lower-dependency fallback |
| Template-first composer only | Deferred; the structured fields remain in the authoring document and can be promoted to forms in a later slice |

## Validation

1. **Conformance — done:** `apps/api/test/calculation-authoring.test.ts`
   compiles a source, asserts the stage sequence, stable source/plan hashes,
   decimal literal handling, logical operators, `math.round`, `nullif`, and
   executes the compiled plan on DuckDB with pool conservation.
2. **Security — done in unit and API tests:** `s"..."`, joins, unsupported
   functions, unknown columns, missing/unused types, source mismatch and
   cross-department compile access are rejected.
3. **Usability — open:** the V5 user study comparing template-first authoring
   with a free-form formula editor.
