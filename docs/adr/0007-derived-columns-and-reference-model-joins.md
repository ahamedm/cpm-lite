# ADR 0007 — Derived columns and reference-model joins

- **Status:** Proposed (not implemented; offline review pending)
- **Date:** 2026-11-04
- **Deciders:** CPM Lite engineering, FP&A, Data Engineering
- **Related:** PRD §4.1, §4.2, §5.1, §6.1, §6.2; C4 `api`, `cube`, `olap`; ADR 0001, ADR 0002, ADR 0004, ADR 0006; design note `docs/design/derived-columns-and-reference-model-joins.md`

## Context

Departments do not only plan from a flat history-budget/actual fact. A real
budget is assembled from cost-element models: manpower (headcount × grade rate),
fleet (vehicles × lease rate), SaaS (seats × price), marketing (impressions ×
CPM), and so on. These models combine a departmental fact with **reference data**
— for example a grade-based monthly charge with benefits and shift allowances —
and derive the budget amount through a calculation.

The current implementation cannot express that:

- `ModelDefinition` accepts dimensions and measures, but preview and generated
  Cube require every expression to be a **plain source column**; arithmetic,
  conditionals and lookups are rejected (`apps/api/src/analytics.ts`,
  `apps/api/src/cube/schema.ts`).
- The catalog is hardcoded to one source, `gold.fact_financials`. There is no
  manpower fact or grade-rate reference source.
- `JoinDefinition` exists in the OpenAPI contract, but validation requires both
  members to be dimensions of the **same** model, and neither preview nor Cube
  generation executes a join.
- Scenario drivers, adjustments and assumptions are loosely typed JSON with no
  binding to model members; the job payload pins the model and rules but not
  lookup versions or a compiler version.
- The external scenario worker is still outstanding, and there is no scenario
  result fact table — only `job.result` JSON / `result_uri`.

The product requirement (PRD §4.1, §6.1, §6.2) is that a department can compose
a simple model, run a budget scenario and submit it for steward review, while
complex foundational models remain Data Engineering-owned (I1, FR-DM-04).

## Decision (proposed)

1. **Model definition v1.1.** Extend the structured definition with:
   - `grain` — the declared uniqueness key of the source;
   - derived dimensions/measures whose `expression` is a **structured AST**, not
     SQL text;
   - `joins` to reference models with multiple key pairs and a pinned target
     model version;
   - optional `templates` metadata for department-facing inputs.
   Existing `1.0` definitions remain valid and default to the governed source
   and `department_code` access, as today.
2. **Structured expression AST.** Arithmetic, comparison, `coalesce`, `if`,
   `round` and basic date functions over source columns and joined reference
   members. No raw SQL, no `eval`, no user-supplied subqueries or functions
   (I5). The AST is type-checked (decimal/integer/date/string) and rejected on
   cycles, unknown members or aggregate nesting.
3. **Reference models via model-to-model joins.** A lookup such as grade rates is
   its own versioned model at a declared grain (for example
   `(grade_code, period)`), joined `many_to_one` from the fact model. Reference
   models are `visibility: global`, contain dimensions and row-level attributes,
   and never rely on joined-cube row-level security.
4. **Pinned target versions and visible drift.** A source model version records
   the exact `model_version_id` of each joined reference model. Preview and Cube
   generation use that version. If the reference model is republished without
   the dependent model being revalidated, the dependent refresh fails with an
   actionable message rather than silently changing meaning.
5. **One shared compiler.** A single compiler module emits parameterised DuckDB
   SQL for preview and scenario jobs and Cube member SQL for the semantic layer.
   The compiler version is pinned in model validation and job payloads (I3).
   SQL emission is centralised; no other component interpolates expression text.
6. **Authoring split.** Data engineers (or stewards) own free-form formulas,
   reference models and template definitions. Departments compose from approved
   templates, supply scenario inputs and run scenarios; they do not author
   arbitrary expressions in the first slice.
7. **First slice: model + preview + Cube.** Ship the source catalog, model
   contract, compiler, preview and generated Cube for a synthetic manpower
   example. **Not** in the first slice: scenario driver entry, job execution,
   result facts, template UI and promotion changes. Those build on the contract
   in later slices.
8. **Scenario layer follows.** Once the external scenario worker exists:
   typed inputs bound to model members, a declared calculation order, result
   facts at a canonical grain, lineage pinning, review and promotion.

## Proposed defaults to confirm during review

These are the two points left open from the design discussion; the ADR records
the recommendation, not an accepted answer.

1. **Period-expanded reference models** rather than range-based effective-date
   joins. `grade_rate_month` is materialised at `(grade_code, period)` from
   `valid_from`/`valid_to`. This keeps DuckDB, Cube and the compiler on the same
   equi-join, makes grain uniqueness trivial and removes overlapping-window
   fan-out. The alternative is a range join on effective dates, which reduces
   reference rows but adds dialect-specific semantics and double-count risk.
2. **Fail the dependent refresh** when a joined reference model has moved,
   rather than blocking the reference model publish while dependents exist. The
   former keeps publishing independent and surfaces the dependency; the latter
   is stricter but operationally heavier. Either way, a "used by" dependency view
   is required.

Also to confirm: whether the first template library is owned by Data
Engineering (recommended) or by Planning Stewards.

## Alternatives considered

- **Restricted SQL text in expressions.** More expressive, but requires a SQL
  parser/validator, is harder to type-check and secure, and drifts toward a
  bespoke formula engine (I1, I5). Rejected.
- **Cube-only calculated members.** Cube YAML can hold SQL expressions, but
  preview and scenario jobs need the same semantics; duplicating the logic in
  Cube, preview and jobs guarantees drift. Rejected.
- **dbt-only derived columns.** Data Engineering can model anything in dbt, but
  the PRD requires business-user self-service for simple cost-element models.
  Reserved for complex foundational models (FR-DM-04).
- **Inline lookup definitions per model.** Avoids a reference-model lifecycle,
  but duplicates grade rates across models and cannot be pinned or reused
  cleanly. Rejected in favour of model-to-model joins.
- **Model-to-model joins with range predicates.** Rejected as the default;
  retained as the alternative under "Proposed defaults".
- **Evaluating derived columns only at scenario time.** Would leave preview and
  Cube inconsistent with the resulting budget. Rejected; one compiler serves all
  three.

## Consequences

- The PRD's "simple models (dimensions, measures, basic facts)" and "basic
  joins" scope widens; PRD, C4 DSL, AGENTS, OpenAPI and Model Studio docs must be
  updated when the ADR is accepted. The design note lists the exact sections.
- `ModelDefinition` gains `schema_version: '1.1'`; existing `1.0` definitions
  keep working. Publishing a `1.1` model requires reference-model checks that do
  not exist today.
- Reference models become part of the dependency graph. A model can be joined
  by many fact models; target republishes have an operational impact and need a
  "used by" view before the first production use.
- The compiler becomes a security boundary. It must remain an allowlist and be
  covered by injection/type/cycle tests; any new operator is a reviewed change.
- Scenario execution remains blocked on the external worker; the first slice
  delivers preview/Cube value without it.
- The model authoring UI grows significantly (derived members, joins, templates,
  inputs). The first slice is backend/contract only; UI follows the `impeccable`
  review process.
- Pinning target versions and the compiler version increases payload size and
  requires lineage fields in validation reports and audit.

## Verification (planned)

- Publish-time validation rejects unsafe expressions, unknown members, duplicate
  reference grain keys, non-global reference models, more than one join hop and
  unmet target-version pins.
- Preview and Cube return identical totals for the manpower example, with the
  department row-level policy applied to the fact model.
- Decimal arithmetic is exact; zero/negative FTE and null rates are handled
  deterministically. Property tests cover lookup uniqueness, fan-out and
  rounding.
- `make verify` includes a derived manpower cube and a cross-department denial.
- Contract tests cover `schema_version: '1.1'` and the `1.0` compatibility path.
- Determinism: the same model version, reference version and compiler version
  produce identical SQL and results across reruns.

## References

- `docs/design/derived-columns-and-reference-model-joins.md` (Draft)
- `packages/contracts/openapi/schemas/models.yaml`
- `apps/api/src/analytics.ts`, `apps/api/src/cube/schema.ts`,
  `apps/api/src/services/models.ts`
- `docs/EPM_CPM_Platform_PRD.md` §4.1, §5.1, §6.1, §6.2
