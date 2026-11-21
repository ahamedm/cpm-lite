# Design Note — Processing flow and portable calculation plan

- **Status:** Draft — for review. Not approved, not implemented.
- **Date:** 2026-11-21
- **Companion ADRs:** `docs/adr/0007-derived-columns-and-reference-model-joins.md`
  (Proposed), `docs/adr/0008-neutral-semantic-model-and-target-compilers.md`
  (Accepted)
- **Related:** PRD §4.1–§4.4, §5.2–§5.4, §6.1–§6.7; C4 `api`, `jobs`, `cube`,
  `olap`; design note
  `docs/design/derived-columns-and-reference-model-joins.md` (Draft)
- **Audience:** CPM Lite engineering, Data Engineering, FP&A/Planning Stewards
- **Scope:** The conceptual processing flow and the portable calculation plan
  that turns a department budget recipe into deterministic result facts. This
  note records validated hypotheses, the remaining validation plan, and the
  implementation plan. It does not change current behaviour.

---

## 1. Why this note exists

The phase-1 system has a working model registry, scenario/job records, rule
pinning, Cube refresh and a governed query surface. The scenario compute itself
is still an external worker, and the current model contract only expresses
plain-column dimensions and measures. The product needs a calculation model that:

1. a planner can compose from familiar budgeting blocks;
2. can be compiled to more than one data-processing target;
3. can run client-side or server-side without changing its meaning;
4. uses a portable, immutable artifact boundary.

This note defines that model, records which parts were empirically validated on
2026-11-21, and states what must be validated before implementation.

The governing invariant is **I1 — thin layer**. The calculation plan is a
declarative contract that lowers to DuckDB, Polars, dbt or Cube. It must not
become a new execution engine.

**Proven now:** Parquet preserves typed facts; allocation conserves the pool
with a deterministic residual; equivalent plans produce identical results in
DuckDB, Polars, dbt-duckdb and DuckDB-WASM when the decimal and rounding rules
are explicit; Cube and dbt can consume the artifacts; a scoped client preview
over Parquet works.

**Not yet proven:** automated lowering from one IR to every target; cost centre
as a first-class analytical dimension; usability of the authoring model; scale
and performance; encryption/column omission; the authoritative worker.

---

## 2. Conceptual processing flow

### 2.1 Four planes

```text
 AUTHORING                    CANONICAL PLAN                 EXECUTION                 ARTIFACTS
 (domain blocks)              (typed, deterministic)         (interchangeable)         (portable)
 ──────────────────           ──────────────────────         ─────────────────         ───────────
 budget recipe / graph   ──▶  staged DAG of typed       ──▶  DuckDB SQL / Polars  ──▶  Parquet + manifest
 templates, drivers           operators + pin metadata       dbt model / Cube          (inputs, stage
                                                                                        outputs, results)
                                      │
                                      └──────────▶ client (DuckDB-WASM, local) or server (job)
```

- **Authoring plane** — the planner-facing vocabulary: base, driver, assumption,
  adjustment, line, allocation, validation.
- **Canonical plan** — the typed, deterministic logical plan. This is the
  contract that is hashed and pinned.
- **Execution plane** — target adapters. The same plan is lowered to DuckDB SQL,
  a Polars `LazyFrame`, a dbt model, or Cube member SQL.
- **Artifact plane** — Parquet snapshots, stage outputs, result facts and a
  manifest. Parquet is the exchange and persistence substrate, not the catalog.

### 2.2 Measures are aggregations; the algorithm emits facts

The most important conceptual correction:

> In OLAP, a measure is an aggregation over fact rows. A scenario algorithm
> consumes facts at a declared grain and emits **new facts**. Cube then exposes
> those facts as measures.

A scenario algorithm cannot operate on an already-aggregated Cube query result.
It operates at the declared calculation grain (for example department, cost
centre, period, cost element) and materialises result facts at that grain. This
is why the result grain is part of the plan contract and why the output is
Parquet facts, not a new Cube measure definition.

### 2.3 Two kinds of driver

| Driver kind | Examples | OLAP nature | Correct use |
|---|---|---|---|
| **Basis driver** | headcount, revenue, usage, square metres | additive measure | denominator or weight in allocation |
| **Rate driver / assumption** | growth %, inflation %, vacancy %, fixed % | coefficient, **not** additive | applied per cell; never summed |

`ScenarioDriver.unit` already distinguishes `percent | currency | headcount |
number`, but the plan must distinguish *basis* from *rate*. Summing percentages
is a semantic error, not a formatting issue.

### 2.4 Staged flow

```text
1. Compose     planner assembles a budget recipe from approved templates
2. Compile     recipe + model version + pins → canonical staged plan (hash)
3. Bind        scenario version pins drivers, rules, snapshot and engine versions
4. Extract     server resolves scope → Parquet input snapshot + manifest
5. Execute     client preview (scoped extract)  OR  server job (authoritative)
6. Materialise each stage to Parquet/Arrow; allocate; validate
7. Publish     result facts keyed by scenario/version/job; lineage and rule audit
8. Query       Cube exposes result facts as governed measures and dimensions
9. Promote     steward approves → new Plan version from the immutable result snapshot
```

The stages are semantic, not merely a DAG: base → rates → lookups → adjustments
→ allocation → validation → write. Each stage boundary is a natural
materialisation and audit point.

### 2.5 The algebra

Let `d ∈ D` be the dimension tuple at the declared grain, `m ∈ M` the base
measures, `r` rate drivers, `a` adjustments:

```text
budget'(d) = base(d) · Πₖ (1 + rₖ(d)) + Σⱼ aⱼ(d) + alloc_in(d) − alloc_out(d)

allocation:  alloc(e) = P · basis(e) / Σ_{e'∈E} basis(e')     ∀ e ∈ E
constraint:  Σ_{e∈E} alloc(e) = P ± tolerance
```

Two consequences:

1. Rates are applied at the grain, then results are re-aggregated. Never sum
   percentages.
2. Allocation is the only operation that moves value between dimension members;
   it needs its own conservation invariant and audit record.

### 2.6 Immutability by pinning

“Inputs are immutable” is implemented as **the evaluation is a pure function of
a content-addressed input set**, not as a frozen copy of Gold:

```text
InputSet = (model_version_id, semantic_hash, base snapshot/period,
            drivers + adjustments + assumptions, resolved rule_version_ids,
            allocation strategy, plan_hash, compiler/engine version)
Output   = result facts keyed by (scenario_version_id, job_id)
```

A rerun of the same `InputSet` must reproduce the same output (I3). Changes
produce a new scenario version, never a mutation. The current
`scenario_version` rule already enforces the first half: it is editable only
while `draft`, then pinned into `job.payload`.

**Gap:** the current payload pins model version, rule versions, dataset snapshot
and engine version, but `allocation_strategy` is `null`, and there is no
plan/compiler hash or driver content hash.

---

## 3. Portable calculation plan

### 3.1 Layer model

```text
Domain recipe        named blocks a planner composes (templates, drivers, pools)
      │
      ▼
Canonical plan       typed staged IR; hashed; target-neutral
      │
      ├──▶ DuckDB SQL      server jobs, preview, Cube-backed reads
      ├──▶ Polars           local/notebook/server columnar execution
      ├──▶ dbt model        optional materialisation and lineage
      └──▶ Cube YAML         governed query surface (aggregates only)
      │
      ▼
Parquet + manifest    immutable inputs, stage outputs, result facts
```

The canonical plan is the only source of truth. Targets are lowerings, never a
second definition of the calculation.

### 3.2 Canonical plan

A plan declares:

- `format` — `cpm-calculation-plan/0` (draft version);
- `grain` — the uniqueness key of the result facts;
- `stages` — an ordered list of operators;
- `types` — explicit decimal/integer/date/string contracts;
- `pins` — model version, semantic hash, rule versions, reference versions;
- `compiler_version` — the lowering version included in lineage.

Initial operator set:

| Operator | Purpose |
|---|---|
| `scan` | read a governed source or a pinned Parquet artifact |
| `filter` | row scope and eligibility |
| `join` | `many_to_one` reference lookup with a pinned target version |
| `derive` | typed expression AST over columns, joined fields and constants |
| `apply_rate` | apply a coefficient per cell (never aggregate it first) |
| `adjust` | one-off amount or percentage adjustment |
| `aggregate` | roll up to a declared grain |
| `allocate` | pool, basis, eligibility, strategy, tolerance, residual rule |
| `validate` | pre-submit, allocation or post-calculation rule set |
| `write` | materialise result facts with lineage |

A minimal plan is in Appendix A.

### 3.3 Lowering contract

Every target adapter must satisfy:

1. Same typed schema at every stage boundary (Arrow/Parquet logical types).
2. Same null, divide-by-zero and overflow semantics.
3. Division results are cast back to the declared decimal type. This is not
   optional: DuckDB's `DECIMAL / DECIMAL` returns `DOUBLE` (validated below).
4. Rounding happens only at declared nodes, with a pinned mode. DuckDB rounds
   half away from zero; Polars defaults to half to even. The plan must pin the
   mode.
5. A zero denominator is guarded explicitly. DuckDB returns `inf`; Polars raises
   a compute error. The canonical result is `NULL` or an eligibility exclusion,
   stated by the plan.
6. Deterministic ordering: allocation residual ties break on a declared key
   (`cost_centre`, then member key). Window ordering is explicit.
7. No target-only functions in canonical plans.
8. Allocation conserves the pool within the configured tolerance (I11).

These rules are the compiler's responsibility, not each adapter author's.

### 3.4 Execution locality and authority

| Context | Engine | Permitted use |
|---|---|---|
| Browser | DuckDB-WASM over a scoped Parquet extract | authoring feedback, what-if preview |
| Desktop / notebook | local DuckDB or Polars | analyst exploration, debugging |
| Server job | DuckDB (or Polars) in the isolated worker | authoritative scenario execution |
| Scheduled / dbt | dbt-duckdb over Parquet | periodic materialisation, lineage |

Non-negotiable boundaries:

- **Authorization stays server-side (I7).** Client-side execution is legitimate
  only on an extract already scoped by the server. Filtering an unscoped
  Parquet file in the browser is not access control.
- **Only the server run is authoritative (I3, I8, I10).** Client results are
  advisory previews; they never become scenario results or Plan versions.
- **The client declares its capabilities.** Engine version, supported operators
  and decimal behaviour are checked before execution.

### 3.5 Parquet artifacts and manifest

Parquet fits because it is columnar, typed, self-describing and readable
without conversion by DuckDB, Polars, dbt-duckdb, Cube's DuckDB driver and
DuckDB-WASM. Use it for:

| Artifact | Purpose |
|---|---|
| pinned base snapshot | immutable, hashable input |
| stage-boundary intermediates | replay, debugging, determinism checks |
| scenario result facts | queryable through Cube without OLTP bulk writes |
| conformance fixtures | same bytes for every target |
| client extracts | scoped, range-readable input |

Parquet is a file format, not a database. The plan therefore requires a
manifest with:

- artifact path, SHA-256, row count and schema hash;
- a **logical content hash** in addition to the file hash;
- plan hash, compiler version, model version, semantic hash, rule versions;
- engine name and version;
- partition key (`scenario_version_id`, `job_id`);
- created-at and producer identity.

An example manifest is in Appendix B.

Two validated constraints:

- **File hashes are writer-dependent.** Identical DuckDB writes produced
  identical bytes, but DuckDB and PyArrow writes of the same logical rows
  produced different bytes. Pin the artifact hash for byte-level immutability
  and the logical hash for semantic identity.
- **Parquet has no row-level security.** Row-group statistics expose min/max
  values. Sensitive extracts need a writer that can disable statistics
  (PyArrow/Polars), encryption, or column omission. DuckDB's `COPY ... (FORMAT
  PARQUET)` does not support a `write_statistics` option (validated).

### 3.6 Target matrix

| Target | Strength | Constraint |
|---|---|---|
| DuckDB SQL | allocation windows, Parquet scans, decimals | decimal division must be cast; zero denominator guarded |
| Polars | lazy, Arrow-native, local/server | rounding mode defaults to half-even; division by zero errors |
| dbt | lineage, tests, scheduled materialisation | build tool, not an interactive planner; keep thin (I1) |
| Cube | governed measures, access policy, caching | aggregate reads only; cannot express the calculation stages |
| DuckDB-WASM | client-side authoring/preview | older engine; pin version and run conformance |

---

## 4. What was validated

### 4.1 Environment

Probes were run in the session scratch on 2026-11-21. Nothing was added to the
repository.

| Component | Version |
|---|---|
| Node.js | 22.22.2 (`~/.nvm/versions/node/v22.22.2`) |
| DuckDB (server) | 2.0.1 |
| DuckDB Node API | 2.0.0-r.1 |
| Polars | 2.1.0 |
| PyArrow | 26.0.1 |
| DuckDB-WASM | `@duckdb/duckdb-wasm@1.29.0`, engine `v1.1.1` |
| dbt Core / dbt-duckdb | 1.12.7 / 1.11.1 |
| Cube Core | 1.8.17 |

Fixtures: a base fact table with `DECIMAL(18,2)` money, `DECIMAL(9,6)`
percentages and timestamps; an allocation pool of `100.00` split over three
equal members and over `10/0/30/60`; a Parquet result artifact.

### 4.2 Results

| Hypothesis | Result |
|---|---|
| Parquet preserves decimal and timestamp values | **Pass.** `DECIMAL(18,2)`, `DECIMAL(9,6)` and `TIMESTAMP` round-trip exactly; `60.60` and `0.733333` preserved. |
| Parquet is readable by every target | **Pass.** DuckDB, Polars/PyArrow, dbt-duckdb, Cube and DuckDB-WASM read the same artifact. |
| Allocation conserves the pool with deterministic residual | **Pass.** Equal bases: `33.33 + 33.33 + 33.34 = 100.00`. `10/30/60`: `10 + 30 + 60 = 100.00`. Residual goes to the last member by `cost_centre`. |
| Zero/negative basis is handled | **Pass with an explicit rule.** Zero basis is excluded; it receives no allocation. A zero denominator yields `NULL` when guarded. |
| The same plan gives identical results across targets | **Pass semantically.** DuckDB 2.0.1, Polars 2.1.0, DuckDB-WASM 1.1.1 and dbt-duckdb 1.11.1 produced identical decimal strings for the fixture. Automated lowering from one IR is **not** yet built. |
| Client-side execution over Parquet is feasible | **Pass.** DuckDB-WASM read the Parquet file, ran the allocation SQL and returned the same rows. |
| Cube can expose Parquet-backed result facts | **Pass.** Cube 1.8.17 queried a DuckDB view over Parquet; `ops` saw only `ops`, a cross-department filter returned zero rows, and an invalid token returned `403`. |
| dbt can consume Parquet and test conservation | **Pass.** A dbt-duckdb model materialised the result and a singular conservation test passed. |
| Deterministic SQL lowering | **Partial.** A toy canonical plan compiled twice to identical SQL and executed correctly; the production IR/compiler is not built. |
| Content-addressed pinning detects drift | **Pass with a condition.** Identical writer output has identical bytes; file hashes differ across writers; logical hashes match; a changed input changes the artifact hash. |
| A canonical logical hash is stable across writers and row order | **Pass.** DuckDB- and PyArrow-written artifacts, and two row orders, produced the same sorted, string-cast logical hash. |
| Parquet statistics can be suppressed | **Pass with a writer condition.** PyArrow `write_statistics=False` and Polars `statistics=False` remove statistics; DuckDB `COPY` does not expose the option. |
| Identical decimal/rounding/zero-division semantics | **Fail by default; pass with explicit rules.** See §4.3. |

### 4.3 Detailed findings

**Decimal division in DuckDB silently becomes `DOUBLE`.**

```sql
SELECT typeof(pool * basis / basis)      -- DOUBLE
FROM alloc;
-- with an explicit cast:
SELECT typeof(CAST(pool * basis / basis AS DECIMAL(38,6)));  -- DECIMAL(38,6)
```

The allocation SQL must therefore cast every division before rounding, then cast
the result to the declared money type. Otherwise money leaves fixed-point
arithmetic, violating I11. The validated form is in Appendix C.

**Zero division differs across engines.**

| Engine | `1.00 / 0.00` |
|---|---|
| DuckDB 2.0.1 | `inf` (`DOUBLE`) |
| DuckDB-WASM 1.1.1 | `inf` |
| Polars 2.1.0 | `ComputeError: division by zero Decimal` |

The canonical plan must guard the denominator (`NULLIF`, or an eligibility
filter) and define the result as `NULL` or exclusion. A raw division is not
portable.

**Rounding differs across engines.**

| Value | DuckDB 2.0.1 | Polars default | Polars `half_away_from_zero` |
|---|---|---|---|
| `2.5` → 0 dp | `3` | `2` | `3` |
| `-2.5` → 0 dp | `-3` | `-2` | `-3` |
| `1.005` → 2 dp | `1.01` | `1.00` | `1.01` |

The plan must pin the rounding mode. `half_away_from_zero` matched DuckDB
exactly in the probe.

**Parquet schema evolution is opt-in.** Reading two files with different
columns without `union_by_name=true` fails with a schema mismatch; with
`union_by_name=true` the missing columns become `NULL`. The plan must pin a
schema-compatibility policy rather than relying on implicit evolution.

**Parquet partitioning works and isolates scenarios.** Writing with
`PARTITION_BY (scenario_version_id)` produced
`scenario_version_id=sv1/data_0.parquet` and
`scenario_version_id=sv2/data_0.parquet`; both read correctly with
`hive_partitioning=true`. The result writer must never overwrite another
scenario's partition (I10).

**Projection and filter pushdown work.** `EXPLAIN` showed `Read Parquet` with a
projection and `Filters: department = 'ops'`, so a scoped extract can be
efficient without materialising all columns.

**Cube returns exact decimal strings but not a fixed scale.** The allocation
measure returned `"10"` for `10.00` and `"33.33"` for `33.33`. Values are exact
strings, but presentation code must format money with the project's `money`
helper; do not `parseFloat`.

**Client and server engines differ.** DuckDB-WASM 1.29.0 bundles engine
`v1.1.1`, while the server is DuckDB 2.0.1. The probe produced identical
results, but this is a version-pinning and conformance-test obligation, not a
guarantee.

---

## 5. Hypothesis register

### 5.1 Validated

| ID | Hypothesis | Evidence |
|---|---|---|
| H2 | Allocation conserves the pool with deterministic residual and explicit zero-basis handling | §4.2, Appendix C |
| H3 | Parquet preserves decimal/timestamp semantics across engines | §4.2 |
| H4 | Parquet supports projection/filter pushdown, partitioning and opt-in schema evolution | §4.3 |
| H5 | Parquet statistics leak min/max; PyArrow/Polars can suppress them | §4.3 |
| H6 | Equivalent plans produce identical results in DuckDB, Polars, dbt and DuckDB-WASM | §4.2; manual lowerings |
| H7 | DuckDB-WASM can execute a plan over a scoped Parquet extract client-side | §4.2 |
| H9 | Cube can expose Parquet-backed result facts with row-level access policy | §4.2 |
| H10 | dbt-duckdb can consume Parquet and run a conservation test | §4.2 |
| H12 | Decimal/rounding/zero-division semantics can be made identical with explicit rules | §4.3 |
| H19 | A canonical logical hash is stable across writers and row orders | Sorted, string-cast hash matched for DuckDB/PyArrow writes and two input orders |

### 5.2 Partially validated or conditional

| ID | Hypothesis | Limitation |
|---|---|---|
| H1 | A canonical staged plan lowers deterministically to DuckDB SQL | Only a toy plan was compiled; the production IR and compiler are not built |
| H11 | Content-addressed pinning supports reproducibility | File hash is writer-dependent; a logical hash is also required |
| H6x | Automated multi-target lowering | Results match, but the lowerings were written manually; no shared compiler yet |
| H9x | Full Cube result semantics | Basic load, filters and RLS passed; caching, larger datasets and result-version routing are untested |
| H10x | Compiler-generated dbt models | A hand-written dbt model passed; no generator yet |

The `x` suffix marks an extended claim beyond the narrow behaviour that passed
in §4.2; it is not a second hypothesis ID.

### 5.3 Refuted as stated

| ID | Hypothesis | Finding |
|---|---|---|
| H8 | Client-side execution can be authoritative | Refuted. It has no server-side authorization, audit or result-write authority. It is preview-only and must consume a pre-scoped extract. |
| H12b | Default decimal semantics are portable | Refuted. DuckDB division returns `DOUBLE`, zero division differs, and rounding modes differ by default. |

### 5.4 Not validated — must be validated before or during implementation

| ID | Hypothesis | Why it is not validated | Validation |
|---|---|---|---|
| H13 | Cost centre is a first-class analytical dimension | The sample fact `gold.fact_financials` has department, category and region, not cost centre; cost centre is currently an authorization/scope attribute | V4 |
| H14 | The abstract representation is intuitive for planners | No user study | V5 |
| H15 | One canonical plan can be lowered automatically to Polars and dbt | No generator; only manual equivalence | V1, V9 |
| H16 | Sensitive extracts can be protected by statistics-off, encryption or column omission | Options exist; encryption and column omission were not executed | V6 |
| H17 | Client and server performance is acceptable at realistic scale | No benchmark; fixture was tiny | V7 |
| H18 | The external worker can execute the plan with exclusive locking, cancellation and terminal status | Worker is outstanding | V10 |

---

## 6. Hypothesis validation plan

Each validation produces a committed test or a recorded decision. A hypothesis
is not “validated” because a demo worked; it needs a repeatable check.

### V1 — Canonical plan → target conformance

- Build one canonical plan for the allocation fixture and a second for a
  rate/adjustment scenario.
- Lower it to DuckDB SQL, Polars and dbt. Run all targets over the same Parquet
  input.
- Compare exact decimal strings, row order and schema types.
- **Pass:** no differences on the golden fixtures; zero/negative bases, null
  drivers and rounding remainders included.
- **Phase:** 1 and 5.

### V2 — Pinning and reproducibility

- Record a manifest with artifact hash, logical hash, plan hash, compiler
  version, model version, semantic hash and rule versions.
- Run the same input set twice; compare results and manifest.
- Mutate one driver, one rule version and one input row; confirm the relevant
  hash changes and the run is rejected or treated as a new version.
- Define the canonical logical hash (sorted rows, typed columns, no writer
  metadata).
- **Pass:** identical input set → identical manifest and results; any change is
  detectable.
- **Phase:** 1 and 2.

### V3 — Authority and scoping negative tests

- Confirm a client preview cannot write result facts, submit a review or
  promote a Plan.
- Confirm an unscoped extract is never issued to a business user.
- Confirm a cross-department client query returns zero rows and a server
  cross-department attempt returns the documented denial.
- **Pass:** all negative tests fail closed; audit records exist for server
  attempts.
- **Phase:** 4.

### V4 — Cost-centre dimension

- Profile the governed source: does it carry a cost-centre key at the required
  grain?
- If not, define the mapping from department/cost centre to facts and add a
  governed dimension (or an explicit reference model).
- Test allocation and Cube access policy at cost-centre grain.
- **Pass:** a planner can budget and allocate for a cost centre without
  inferring it from department; RLS is enforced at the same grain.
- **Phase:** 0–2.

### V5 — Usability of the abstract representation

- Give 5–8 planners a task: compose a budget from a template, set a growth
  driver, allocate a pool, read the result.
- Measure task success, time, error type and whether the planner can explain the
  calculation.
- Compare a template-first composer with a free-form formula editor.
- **Pass:** template-first meets the task-success target and produces fewer
  semantic errors; free-form remains a Data Engineering capability.
- **Phase:** before Phase 4 UI work.

### V6 — Sensitive Parquet extracts

- Write a sensitive extract with PyArrow/Polars `statistics=False`; verify
  `parquet_metadata` has no min/max.
- Test encryption and column omission for a scoped extract.
- Confirm logs and traces contain no financial rows or tokens.
- **Pass:** no statistics leak; encryption path documented and tested; audit
  records access.
- **Phase:** 2.

### V7 — Performance and scale

- Benchmark server DuckDB and client DuckDB-WASM on 1M and 10M row Parquet
  artifacts: scan, filter, allocation, result write.
- Measure browser memory, time-to-first-preview and range-read volume.
- Apply NFR placeholders from configuration; do not hardcode thresholds (I12).
- **Pass:** server within the configured target; client preview limited to an
  aggregate or row cap and remains responsive.
- **Phase:** 4 and 6.

### V8 — Result facts through Cube

- Write result facts at the canonical grain; expose measures/dimensions through
  generated Cube YAML.
- Test exact decimal serialization, scale handling, filters, caching and
  row-level policy for department and cost centre.
- Test a completed scenario version and a superseded one.
- **Pass:** only completed, authorized results are queryable; money is exact.
- **Phase:** 3.

### V9 — Compiler-generated dbt model

- Emit a dbt model plus a conservation/quality test from the canonical plan.
- Run `dbt build` against a Parquet input in CI without network.
- **Pass:** generated model is deterministic, reviewable and passes the same
  golden assertions as the DuckDB target.
- **Phase:** 5.

### V10 — Authoritative worker integration

- Run a real job in an isolated DuckDB instance: read the scoped snapshot,
  execute the plan, allocate, validate, write result facts and audit.
- Test cancellation/SIGTERM, bounded retries, orphan-lock absence and terminal
  status on every path.
- Confirm a rerun of the same pinned payload is identical.
- **Pass:** all job invariants (I2, I3, I10) and the existing `make verify-api`
  workflow pass.
- **Phase:** 3.

---

## 7. Implementation plan

### 7.1 Principles

1. **One canonical plan, many lowerings.** No target owns the calculation.
2. **DuckDB first.** The server target and the existing analytical store are the
   first proof; Polars and dbt follow.
3. **Parquet at the boundary.** Inputs, stage outputs and results are Parquet +
   manifest; OLTP remains the catalog.
4. **Server authority.** Client execution is preview-only.
5. **No new engine (I1).** The plan lowers to existing tools.
6. **Rules are data (I5).** No `eval`, no user SQL, no user-supplied functions.
7. **Test the semantics, not only the SQL.** Golden decimal/ordering fixtures
   are the acceptance evidence.

### 7.2 Phases

#### Phase 0 — Decisions, fixtures and harness

- Write and review the ADR for the portable calculation plan; resolve the
  decisions in §8.
- Freeze plan format `cpm-calculation-plan/0` and manifest format
  `cpm-parquet-snapshot/0`.
- Add golden fixtures: growth, allocation with residual, zero/negative basis,
  null driver, schema evolution.
- Add a conformance harness that runs a plan on one or more targets and compares
  exact results.
- **Exit:** ADR accepted; fixtures reviewed; harness runs on DuckDB only; no
  production behaviour changed.

#### Phase 1 — Canonical plan and DuckDB compiler

- Implement the typed plan IR, validation and DuckDB lowering.
- Enforce the lowering contract: explicit decimal casts, pinned rounding,
  zero-denominator guard, deterministic allocation residual, declared grain.
- Emit `plan_hash` and `compiler_version` into the job payload.
- Unit/property tests: pool conservation, determinism, injection, unknown
  columns, type errors, aggregate nesting, cycle detection.
- **Exit:** V1 (DuckDB), V2 and the DuckDB half of H12 pass; `make test` is green.

#### Phase 2 — Parquet artifacts and manifest

- Implement the scoped input snapshot writer and manifest.
- Implement the result-facts writer keyed by `scenario_version_id`/`job_id`;
  enforce partition isolation and no overwrite.
- Adopt a writer policy for sensitive extracts (statistics-off; encryption or
  column omission where required).
- Define the logical hash canonicalisation and the schema-evolution policy.
- **Exit:** V2, V4, V6 and the Parquet half of H3/H4/H5/H11 pass.

#### Phase 3 — Authoritative scenario worker

- Execute the plan in the external worker with one exclusive DuckDB instance.
- Read the pinned Parquet snapshot; write only the job’s result partition.
- Evaluate allocation/post-calculation rules; write rule audit and lineage.
- Expose result facts through generated Cube YAML.
- **Exit:** V8, V10 and the existing end-to-end workflow pass; no fake
  completion; terminal status on cancellation and failure.

#### Phase 4 — Client preview

- Serve a short-lived, already-scoped Parquet extract.
- Run DuckDB-WASM with a pinned engine version and a capability check.
- Label the result as advisory; provide no write/promote path.
- Review the UI at 1440 px and 390 px, including loading, empty, error,
  disabled and permission-read-only states; invoke the `impeccable` skill.
- **Exit:** V3 and V7 pass; no horizontal overflow; authority negative tests
  pass.

#### Phase 5 — Polars and dbt adapters

- Lower the canonical plan to Polars and to a dbt model plus tests.
- Run the full conformance suite on all targets; record engine versions.
- Keep dbt optional and thin (I1); generated models are reviewed artifacts.
- **Exit:** V1 (all targets), V9 and H15 pass.

#### Phase 6 — Hardening and documentation

- Run `security-review` (auth, tokens, query, artifact access) and `make audit`
  for any dependency change.
- Add performance baselines and NFR configuration.
- Update PRD/DSL/AGENTS/ADR 0007/0008 and this note’s status.
- **Exit:** definition of done in `AGENTS.md`; no scratch files or secrets.

### 7.3 Test matrix

| Layer | Tests |
|---|---|
| Plan IR | schema validation, type checking, cycle detection, unknown members, injection |
| Compiler | deterministic SQL/YAML, explicit decimal casts, rounding mode, null guards |
| Allocation | property-based conservation, zero/negative basis, rounding residual, determinism |
| Parquet | round-trip types, schema evolution, partitioning, statistics policy, logical hash |
| Targets | DuckDB, Polars, dbt and DuckDB-WASM on the same golden fixtures |
| Cube | exact money, filters, row-level policy, completed-only results |
| Jobs | exclusive lock, cancellation, retries, terminal status, rerun identity |
| Client | scoped extract, no write authority, no unscoped data, memory/time caps |
| Security | cross-department denials, artifact access, no secrets/rows in logs |

### 7.4 Rollout and rollback

- The plan compiler and Parquet artifacts are additive; existing model
  definitions and the current preview path remain until the first slice is
  proven.
- The external worker is the only writer of result facts; the API never fakes
  completion.
- A failed conformance target is disabled, not silently approximated. The
  DuckDB target remains the reference.
- The feature flag/config selects targets; production defaults to the target
  that passed the full conformance suite.

---

## 8. Decisions required (ADR)

The implementation must record these in an ADR before Phase 1:

1. **IR location and ownership** — a new target-neutral package
   (`packages/domain/calculation`) or a module inside `apps/api`. It must be
   consumable by the worker without importing API routes.
2. **Parquet role** — primary result store, or staging format with DuckDB/
   DuckLake as the query store. The manifest and retention policy depend on it.
3. **Target order** — confirm DuckDB first, then Polars, then dbt; client
   preview after the authoritative worker.
4. **Equality definition** — exact decimal strings and ordering, or a declared
   tolerance. This is the conformance gate.
5. **Sensitive artifact policy** — statistics-off by default, encryption,
   column omission, or a combination. Record the residual risk.
6. **Cost-centre dimension** — add it to the governed source/model grain, or
   model it as a reference/mapping. This affects the domain model and Cube
   policies.
7. **Engine pinning** — server DuckDB 2.0.x and DuckDB-WASM 1.x will diverge.
   Define the supported matrix and upgrade/conformance policy.
8. **Client preview scope** — which operators, row caps and aggregates are
   permitted in the browser.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Semantic drift across engines | One canonical IR; conformance suite; explicit decimal/rounding/zero rules |
| Money silently becomes `DOUBLE` | Compiler casts every division; type assertions in tests; no `parseFloat` |
| Client preview leaks unscoped data | Server-issued scoped extracts; no client access to Gold; negative tests |
| Parquet statistics leak values | Statistics-off writers; encryption/column omission; metadata review |
| Schema evolution changes meaning | Pinned reference versions; explicit `union_by_name` policy; republish dependent models |
| Two definitions of the calculation | Targets are lowerings only; no hand-written target SQL in production |
| New engine scope creep | I1 review in the ADR; DuckDB/Polars/dbt adapters only |
| Client memory/time at scale | Row caps, aggregates, range reads; benchmark before enabling |
| Worker and API race on OLTP | Single-writer constraint until PostgreSQL; outbox and idempotency |

---

## 10. Open questions

- Is the result grain per cost element, or per account/cost element/period?
  The design note for derived columns proposes
  `scenario_result_fact(scenario_version_id, job_id, period,
  department_code, cost_centre_code, cost_element_code, account_code,
  measure_code, amount, currency_code, calculation_method, lineage)`.
- Do plans compose (a departmental plan references a shared cost-element plan),
  or is composition only at the model/template layer?
- What is the retention policy for stage Parquet artifacts?
- Does Cube query Parquet directly through a view, or a DuckDB/DuckLake table
  materialised from Parquet? Both were validated at the DuckDB layer; the
  operating choice is open.
- Are allocation rules fully data-driven (rule parameters) or can a steward
  choose a strategy that changes the plan shape?

---

## Appendix A — Minimal canonical plan

```json
{
  "format": "cpm-calculation-plan/0",
  "grain": ["department_code", "cost_centre_code", "period"],
  "pins": {
    "model_version_id": "mv_...",
    "semantic_hash": "sha256:...",
    "rule_version_ids": ["rv_..."],
    "compiler_version": "calculation-compiler/0"
  },
  "stages": [
    {
      "op": "scan",
      "source": "scenario_base",
      "artifact": "base.parquet"
    },
    {
      "op": "derive",
      "name": "adjusted_budget",
      "type": "decimal(18,2)",
      "expression": {
        "op": "multiply",
        "args": [
          { "column": "base_budget" },
          { "op": "add", "args": [{ "value": "1.000000", "type": "decimal" }, { "param": "growth_rate" }] }
        ]
      }
    },
    {
      "op": "allocate",
      "pool": "adjusted_budget",
      "basis": "headcount",
      "partition_by": ["period"],
      "eligible": { "op": "gt", "args": [{ "column": "headcount" }, { "value": "0", "type": "decimal" }] },
      "strategy": "proportional",
      "rounding": { "scale": 2, "mode": "half_away_from_zero" },
      "residual": { "assign": "last", "order_by": ["cost_centre_code"] },
      "tolerance": "0.01"
    },
    {
      "op": "validate",
      "rule_set": "post_calculation",
      "checks": ["pool_conservation"]
    },
    {
      "op": "write",
      "format": "parquet",
      "partition_by": ["scenario_version_id"],
      "measures": ["allocated_amount"]
    }
  ]
}
```

## Appendix B — Manifest example

```json
{
  "format": "cpm-parquet-snapshot/0",
  "scenario_version_id": "sv_...",
  "job_id": "job_...",
  "plan_hash": "sha256:...",
  "logical_hash": "sha256:...",
  "compiler_version": "calculation-compiler/0",
  "model_version_id": "mv_...",
  "semantic_hash": "sha256:...",
  "rule_version_ids": ["rv_..."],
  "engine": { "name": "duckdb", "version": "2.0.1" },
  "artifacts": [
    {
      "path": "scenario_version_id=sv_.../part-000.parquet",
      "sha256": "...",
      "rows": 1234,
      "schema_hash": "sha256:..."
    }
  ],
  "created_at": "2026-11-21T00:00:00Z"
}
```

The artifact hash answers “are these the same bytes?”. The logical hash answers
“is this the same data?”. Both are required because Parquet bytes are
writer-dependent.

## Appendix C — Decimal-safe allocation SQL

Validated on DuckDB 2.0.1, DuckDB-WASM 1.1.1, Polars 2.1.0 and dbt-duckdb
1.11.1. The cast around the division is mandatory: DuckDB returns `DOUBLE` for
`DECIMAL / DECIMAL`.

```sql
WITH eligible AS (
  SELECT * FROM scenario_input
  WHERE basis > 0
),
totals AS (
  SELECT department, period,
         SUM(basis) AS total_basis,
         ANY_VALUE(pool) AS pool
  FROM eligible
  GROUP BY department, period
),
shares AS (
  SELECT e.*, t.pool,
         CAST(t.pool * e.basis / NULLIF(t.total_basis, 0) AS DECIMAL(38, 6)) AS raw,
         ROW_NUMBER() OVER (
           PARTITION BY e.department, e.period ORDER BY e.cost_centre
         ) AS rn,
         COUNT(*) OVER (PARTITION BY e.department, e.period) AS n
  FROM eligible e
  JOIN totals t USING (department, period)
),
residual AS (
  SELECT *,
         ROUND(raw, 2) AS alloc,
         SUM(ROUND(raw, 2)) OVER (PARTITION BY department, period) - pool AS residual
  FROM shares
)
SELECT department, cost_centre,
       CAST(CASE WHEN rn = n THEN alloc - residual ELSE alloc END AS DECIMAL(18, 2))
         AS allocated_amount
FROM residual
ORDER BY department, cost_centre;
```

Rules encoded here:

- eligibility excludes zero/negative basis;
- `NULLIF` guards the denominator;
- the division is cast to decimal before rounding;
- rounding mode is the engine default that matches half-away-from-zero (DuckDB);
  Polars must be configured with `mode='half_away_from_zero'`;
- the residual is assigned to the last member by a declared key;
- the final money column is cast to `DECIMAL(18,2)`.

## Appendix D — Reproduction notes

The probes were run in the session scratch, not committed. To reproduce the
critical checks:

- Parquet round-trip: `COPY ... TO ... (FORMAT PARQUET)` then
  `read_parquet(...)`; compare `typeof` and exact decimal strings.
- Statistics: `SELECT path_in_schema, stats_min, stats_max FROM
  parquet_metadata('file.parquet')`; compare a DuckDB write with a PyArrow
  `write_table(..., write_statistics=False)` write.
- Allocation: run Appendix C, then compare `SUM(allocated_amount)` with the
  pool per partition.
- Cross-engine: run the same fixture in Polars with
  `round(2, mode='half_away_from_zero')` and an explicit
  `Decimal(18, 2)` cast.
- Cube: create a DuckDB view over the Parquet artifact and a cube with a
  `business_user` row-level policy; query `/cubejs-api/v1/load` with a scoped
  token.
- Client: serve the artifact and run the same SQL in DuckDB-WASM; compare rows
  and totals.

The next step is to turn these probes into committed golden fixtures and target
adapters under the conformance harness in Phase 0.