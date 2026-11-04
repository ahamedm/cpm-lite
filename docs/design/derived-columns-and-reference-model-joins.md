# Design Note — Derived columns and reference-model joins

- **Status:** Draft — for offline review. Not approved, not implemented.
- **Date:** 2026-11-04
- **Companion ADR:** `docs/adr/0007-derived-columns-and-reference-model-joins.md` (Proposed)
- **Audience:** CPM Lite engineering, Data Engineering, FP&A/Planning Stewards
- **Scope:** cost-element models that derive a budget from departmental facts and
  effective-dated reference data, starting with manpower.

## 1. Why this note exists

The platform currently models one flat source (`gold.fact_financials`) with
plain-column dimensions and measures. A department budget in practice is not one
source:

- Manpower: headcount/FTE by grade, multiplied by a grade-based charge rate that
  changes over time, plus benefits and shift allowances.
- Fleet: vehicles or leases × contract rate, maintenance and fuel assumptions.
- SaaS: seats × tier price, term discounts, renewals.
- Marketing: impressions × CPM, agency retainers, campaign phasing.

Each is a **cost-element model**: a fact at a declared grain, one or more
effective-dated reference models, derived members, and department-owned scenario
inputs. This note defines the contract and the first implementation slice. It is
deliberately a design, not an accepted plan.

## 2. Current constraints (verified in the repository)

| Area | Current behaviour | Required for this design |
|---|---|---|
| `ModelDefinition` (`packages/contracts/openapi/schemas/models.yaml`) | `source`, `dimensions`, `measures`, `joins`, `access`; `schema_version` is only `1.0` | `1.1`: `grain`, derived members, multi-key joins with target version, templates |
| Expression handling (`apps/api/src/analytics.ts`, `apps/api/src/cube/schema.ts`) | Expressions must be plain columns present in the governed source | Structured AST compiled to SQL |
| Sources (`apps/api/src/analytics.ts`) | `SOURCE_DEFINITION` is a single hardcoded source; preview rejects other ids | Catalog of sources, including manpower fact and reference data |
| Joins (`apps/api/src/services/models.ts`) | `validateModelDefinition` requires both join members in the same model; no execution | Cross-model joins with keys, cardinality and target version |
| Preview (`AnalyticsHandle.preview`) | Single-source aggregates, department filter, no joins, no derived columns | Joined reference data and compiled expressions |
| Cube generation (`apps/api/src/cube/schema.ts`) | Plain-column dimensions, simple aggregations; no `joins:` emitted | Compiled SQL members and `many_to_one` joins |
| Scenario inputs (`apps/api/src/contracts.ts`) | `drivers`/`adjustments`/`assumptions` are unbound JSON with `driver_code`, value, unit and dimension filters | Typed inputs bound to model members, with scope/period |
| Job payload (`apps/api/src/services/jobs.ts`) | Pins model version, rule versions, dataset snapshot, period, engine version | Also pin reference model versions, compiler version and input values |
| Results (`db/migrations/0001_orchestrator.sql`) | `job.result` JSON / `result_uri` only | Result facts at a canonical grain, queryable through Cube |
| Scenario compute | External worker outstanding | Calculation runner inside the worker |

The existing `JoinDefinition` is cross-model in name only; it cannot validate or
execute a lookup. It will be extended, not reused unchanged.

## 3. Terminology

- **Derived member** — a dimension or measure whose value comes from an
  expression over source columns, joined reference fields and constants.
- **Reference model** — a global, versioned model at a declared grain used for
  lookup (grade rates, price lists, allocation bases). Joined `many_to_one`.
- **Template** — a named, parameterised expression owned by Data Engineering and
  offered to departments (e.g. `headcount_rate_cost`).
- **Calculation plan** — the declared order in which base selection, inputs,
  derived columns, adjustments, allocation and validation run.
- **Result fact** — a persisted scenario output row at the canonical grain.
- **Lookup** is not a separate object in this design: a lookup **is** a reference
  model joined into a fact model.

## 4. Target model contract

### 4.1 Model definition v1.1 (sketch)

```json
{
  "schema_version": "1.1",
  "source": { "source_id": "gold.fact_manpower_month" },
  "grain": ["position_id", "period"],
  "access": { "row_level_field": "department_code" },
  "joins": [
    {
      "name": "grade_rate",
      "relationship": "many_to_one",
      "target_model_code": "grade_rate_month",
      "target_model_version_id": "<uuid pinned at validation/publish>",
      "on": [
        { "source_member": "grade_code", "target_member": "grade_code" },
        { "source_member": "period",     "target_member": "period" }
      ]
    }
  ],
  "dimensions": [
    { "code": "department_code", "name": "Department", "data_type": "string", "expression": "department_code" },
    { "code": "period", "name": "Period", "data_type": "string", "expression": "period" }
  ],
  "measures": [
    {
      "code": "loaded_monthly_cost",
      "name": "Loaded monthly cost",
      "aggregation": "sum",
      "format": "currency",
      "currency_code": "USD",
      "expression": {
        "op": "multiply",
        "args": [
          { "column": "budgeted_fte" },
          {
            "op": "add",
            "args": [
              { "join": "grade_rate", "field": "monthly_rate" },
              {
                "op": "multiply",
                "args": [
                  { "join": "grade_rate", "field": "monthly_rate" },
                  { "join": "grade_rate", "field": "benefits_pct" }
                ]
              }
            ]
          }
        ]
      }
    }
  ]
}
```

Notes:

- `grain` is new and must be validated for uniqueness against the source.
- `joins[].on` replaces the single `source_member_code`/`target_member_code`
  pair; the old pair remains accepted for `1.0` definitions.
- `target_model_version_id` is resolved when the model version is validated and
  stored immutably with it.
- The expression has no aggregate functions; `aggregation` is applied outside it.
- `1.0` definitions continue to default `source` to `gold.fact_financials` and
  `access.row_level_field` to `department_code`, as today.

### 4.2 Reference model `grade_rate_month`

- Source: `gold.dim_grade_rate` (`grade_code`, `valid_from`, `valid_to`,
  `monthly_rate`, `benefits_pct`, `shift_allowance_pct`, `currency_code`).
- Grain: `(grade_code, period)` after period expansion from the effective
  window.
- Visibility: `global`; access: none (reference data, no department RLS).
- Fields are dimensions, not measures: a reference member must be a row-level
  attribute. Aggregating a joined cube is not supported in the first slice.
- Publish-time validation: `(grade_code, period)` unique; no overlapping windows
  in the source; currency consistent.

### 4.3 Fact model `manpower_cost`

- Source: `gold.fact_manpower_month` (`position_id`, `department_code`,
  `cost_centre_code`, `grade_code`, `period`, `budgeted_fte`, `filled_fte`).
- Grain: `(position_id, period)`; access on `department_code`.
- Dimensions: department, cost centre, grade, period.
- Join: `grade_rate` on `(grade_code, period)`.
- Derived measures: `monthly_base_cost`, `benefits_cost`, `shift_cost`,
  `loaded_monthly_cost`, `planned_monthly_cost`.

## 5. Expression AST

### 5.1 Allowed nodes

| Node | Shape | Notes |
|---|---|---|
| Column | `{"column": "budgeted_fte"}` | Must exist in the fact source |
| Joined field | `{"join": "grade_rate", "field": "monthly_rate"}` | Join name and target dimension |
| Constant | `{"value": "0.18", "type": "decimal"}` | No floats; decimal strings |
| Arithmetic | `{"op": "add|subtract|multiply|divide", "args": [...]}` | Divide-by-zero yields null |
| Coalesce | `{"op": "coalesce", "args": [...]}` | Typed fallback |
| Conditional | `{"op": "if", "args": [condition, then, else]}` | Condition is a comparison |
| Comparison | `{"op": "eq|ne|gt|gte|lt|lte", "args": [...]}` | Prefer an allowlisted shape |
| Round | `{"op": "round", "args": [value, scale]}` | Explicit rounding step |
| Date | `{"op": "date_trunc|extract", ...}` | Allowlisted units only |

Not allowed: string concatenation in SQL, subqueries, window functions, casts to
arbitrary types, function names supplied as strings, `eval`, or any raw SQL.

### 5.2 Type rules

- `decimal` for money and percentages (percentages are fractions, I11).
- `integer` for counts (FTE may be decimal).
- `date` and `string` for dimensions; arithmetic on them is rejected.
- Division: decimal/decimal; zero denominator yields `null`, not an error and not
  `Infinity`.
- Multiplication requires compatible numeric types; mixed decimal/integer is
  promoted to decimal.
- Rounding happens only at explicit `round` nodes and at defined result boundaries.
- Every aggregate is applied once, over the compiled row expression; nested
  aggregates are rejected.

### 5.3 Templates

A template is stored as a named AST with typed parameters:

```json
{
  "code": "headcount_rate_cost",
  "version": 1,
  "owner": "data_engineering",
  "parameters": [
    { "code": "fte", "type": "decimal" },
    { "code": "rate", "type": "decimal" },
    { "code": "benefits_pct", "type": "decimal" }
  ],
  "expression": {
    "op": "multiply",
    "args": [
      { "param": "fte" },
      { "op": "add", "args": [
        { "param": "rate" },
        { "op": "multiply", "args": [{ "param": "rate" }, { "param": "benefits_pct" }] }
      ]}
    ]
  }
}
```

Departments select a template and bind parameters to model members or scenario
inputs. Free-form AST authoring is a data-engineering capability.

## 6. Compiler

One module, working name `calculation/compiler` (location decided during
implementation; do not add a new runtime). Inputs:

- model definition (fact source, joins, derived members),
- pinned reference model versions,
- dialect (`duckdb` for preview/jobs, `cube` for generated YAML),
- row-level access field and scope value where applicable.

Outputs:

- parameterised DuckDB SQL (SELECT list, JOIN clauses, WHERE for scope),
- Cube dimension/measure SQL and `joins:` entries,
- a compiler version identifier.

Rules:

- Identifier quoting and schema qualification are centralised.
- The compiler never accepts a string expression from a user; it walks the AST.
- Deterministic output: same inputs → same SQL text.
- Column and member names are validated before compilation.
- The compiler is covered by injection, type, cycle and fan-out tests.
- Compiler version is stored in the model validation report and (later) job
  payload.

## 7. Validation matrix

| Check | When | Failure |
|---|---|---|
| Expression AST schema and allowlist | save/validate | reject |
| Unknown source column or joined field | validate | reject |
| Type mismatch, division/aggregate misuse | validate | reject |
| Cyclic derived members | validate | reject |
| Join target exists, is published, is global | validate and refresh | reject |
| Join target version matches the pin | publish and refresh | reject with “republish dependent” |
| Multiple key pairs all reference dimensions | validate | reject |
| Reference grain unique | publish and preview | reject |
| More than one join hop | validate | reject |
| Unsupported cardinality (not `many_to_one`) | validate | reject (first slice) |
| Result grain duplicates after join | preview | reject; no silent fan-out |
| Access field present and in the fact source | validate | reject |
| Currency mismatch in derived money | validate | reject |

Previews and jobs repeat the safety-critical checks; validation alone is not the
security boundary.

## 8. Preview

- One compiled query over the fact source with `many_to_one` joins to pinned
  reference sources.
- Department scope remains on the fact source; joined reference models carry no
  RLS.
- Group-by dimensions and aggregate measures come from the compiled AST.
- Preview returns the same column names as the model members; money remains a
  decimal string at the API boundary.
- Limit/aggregation caps stay as today (max four dimensions, six measures).
- A preview is still a read-only snapshot (`data/cpm_lite_preview.duckdb`); the
  reference data must be in that snapshot.

## 9. Cube generation

- Emit `sql_table`/`sql` for the fact and `joins:` with `many_to_one` to the
  reference cube, using the pinned target cube name.
- Generated measure SQL comes from the compiler; no raw user text.
- The fact cube keeps the department access policy; the reference cube is global
  read-only.
- Do not rely on joined-cube RLS for security. If reference rows ever become
  department-specific, model the department as an explicit dimension and filter
  it in the query; joined RLS is not a guarantee.
- Dynamic refresh verification (`/meta` + one `load`) covers derived measures.
- Static promotion (ADR 0006) must handle the extra cube and join; the promoted
  YAML includes the compiled SQL.

## 10. Scenario layer (later slices, not first)

### 10.1 Inputs

- Typed inputs bound to templates/model members: `headcount_delta`,
  `salary_inflation`, `vacancy_rate`, `overtime_rate`, one-off adjustments.
- Scope: department/cost centre/grade; effective period.
- Current `ScenarioDriver`/`ScenarioAdjustment`/`ScenarioAssumption` shapes need
  `effective_from`/`period` and binding metadata; they remain append-only per
  scenario version.

### 10.2 Calculation order

1. Select base (actuals/plan/scenario) and pin the source snapshot.
2. Apply headcount/mix drivers.
3. Resolve pinned reference rows for the period.
4. Compute derived columns.
5. Apply inflation/vacancy/overtime assumptions.
6. Apply one-off adjustments.
7. Allocate pools (ADR-level rules, strategy pattern).
8. Post-validate, write results and audit.

### 10.3 Result grain

```
scenario_result_fact(
  scenario_version_id, job_id,
  period, department_code, cost_centre_code,
  cost_element_code, account_code, measure_code,
  amount, currency_code,
  calculation_method,   -- direct | calculated | lookup_rate
  lineage                -- model/reference/compiler versions
)
```

This grain allows Manpower, Fleet and non-payroll financials to roll up into one
departmental budget and be queried through Cube after the job.

### 10.4 Lineage

The job payload and result facts pin: model version, reference model versions,
source snapshot, compiler version, resolved input values, rule versions. This is
required by I3 and by steward review: a reviewer must be able to explain a
calculated line.

## 11. Worked example (synthetic)

**Department:** Operations, cost centre `CC-NUR-01`.
**Reference:** 10 G6 FTE, monthly rate 5,600, benefits 18%, shift allowance 6%.

| Step | Value |
|---|---|
| Monthly base per FTE | 5,600.00 |
| Benefits | 1,008.00 |
| Shift allowance | 336.00 |
| Loaded monthly cost per FTE | 6,944.00 |
| 10 FTE | 69,440.00 |
| +4% inflation | 72,217.60 |
| −5% vacancy saving | 68,606.72 |
| One-off signing bonus (May only) | +30,000.00 |

Scenario inputs (department-owned): +3 G6 FTE from April; 4% inflation from
July; 5% vacancy; 30,000 USD signing bonus in May; 2% overtime assumption.

Expected outputs at the first slice: preview and Cube show
`loaded_monthly_cost` by department/cost centre/grade/period; the department
scope is enforced; the reference model is global. Result facts, review and
promotion come later.

## 12. First implementation slice

Backend and contract only; no scenario execution, no UI authoring.

1. **Synthetic data and catalog**
   - `gold.fact_manpower_month` and `gold.dim_grade_rate` (expanded to
     `grade_rate_month`) in `make data` and the preview snapshot.
   - Replace the single hardcoded source definition with catalog entries:
     grain, keys, relationships, access field.
2. **Contract v1.1**
   - OpenAPI `ModelDefinition`/`JoinDefinition`, new `grain`, derived members,
     templates; preserve `1.0`.
3. **Validation**
   - The matrix in §7; validation report lists resolved reference versions and
     compiler version.
4. **Compiler**
   - DuckDB and Cube emitters, deterministic, tested.
5. **Preview**
   - Joined reference data, department scope, derived members.
6. **Cube generation**
   - `joins:` emission, derived SQL, access policy, dynamic refresh
     verification.
7. **Verification**
   - `make verify` with the manpower cube; API tests; docs (PRD, C4, AGENTS,
     OpenAPI, Model Studio) updated in the same change as acceptance.

### Acceptance criteria

- A `1.0` model still publishes and previews unchanged.
- A `1.1` manpower model previews `loaded_monthly_cost` matching Cube totals.
- A finance token sees only finance; HR sees only HR; cross-department access is
  denied at the API and in Cube.
- Duplicate `(grade_code, period)` in the reference model is rejected.
- Republishing the reference model without the fact model fails the dependent
  refresh with the dependency named.
- Unsafe AST, unknown member, aggregate-in-expression, >1 hop and non-global
  reference are rejected.
- Decimal results are exact; zero/negative FTE and null rates are deterministic.
- `make test` and `make verify` pass.

## 13. Test plan

- **Unit:** AST parsing, type rules, cycle detection, SQL rendering, join key
  alignment, null/zero behaviour, rounding.
- **Property:** grain uniqueness; no fan-out (row count unchanged after
  `many_to_one` join); totals reconcile; deterministic reruns.
- **Rule table:** caps/thresholds later; no calculation rules in the first slice.
- **Authorization:** positive and cross-department negative preview/Cube tests;
  reference models global-only.
- **Contract:** OpenAPI `1.1` schema; backward compatibility for `1.0`.
- **Semantic layer:** `make verify` fixture with the derived cube and scoping.
- **E2E (later):** manpower scenario run → review → promotion, using synthetic
  data only (I13).

## 14. Security

- The AST is an allowlist; no SQL text escapes the compiler.
- Reference models are global data, not a security boundary; joined-cube RLS is
  not relied upon.
- Row-level scope stays on the fact source and on scenario result cubes.
- Preview and scenario jobs re-check access server-side.
- Expression errors never echo raw financial rows or tokens.

## 15. Risks and open questions

1. **Period-expanded reference vs range joins** — recommended period expansion;
   confirm. Range joins would reduce rows but add dialect semantics and fan-out
   risk.
2. **Target-version drift policy** — recommended “fail dependent refresh”;
   confirm vs blocking the target publish.
3. **Reference model lifecycle** — who owns grade-rate publication, and how is a
   “used by” impact view exposed before republishing?
4. **Template governance** — Data Engineering vs Planning Stewards as template
   owners; versioning and deprecation of templates.
5. **Multi-currency** — one reporting currency in the MVP; reference rates must
   carry a currency and reject mismatches.
6. **Model-on-model composition** — first slice allows one join hop only. A
   reference model that itself joins another model is a later decision with
   lineage/cycle implications.
7. **UI scope** — derived member/join/template authoring is a large UI slice that
   must follow the backend contract and the `impeccable` review.
8. **Worker dependency** — scenario execution cannot complete until the external
   job worker exists; the first slice must not imply that budgets can already be
   run end to end.

## Appendix A — the same pattern for other cost elements

| Cost element | Fact | Reference model | Derived measure |
|---|---|---|---|
| Manpower | position-month | grade rate by period | FTE × loaded rate |
| Fleet | vehicle-month | lease rate by vehicle class/period | vehicles × lease + maintenance |
| SaaS | subscription-month | tier price by period | seats × tier price × term factor |
| Marketing | campaign-period | CPM/agency rate | impressions/1000 × CPM |
| Manufacturing | production order | standard cost by item/period | units × standard cost × scrap factor |

The common shape is: fact at a grain + effective-dated reference model joined
`many_to_one` + derived AST + department inputs. If a cost element needs
multi-hop composition or statistical forecasting, it belongs in Data
Engineering/dbt, not in this first slice.
