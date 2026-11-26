# Design Note — Multi-model composition for scenarios

- **Status:** Draft — analysis. Option A accepted as the MVP direction in
  ADR 0011; A1 is the MVP slice, A2 follows. Not implemented.
- **Date:** 2026-11-26
- **Audience:** CPM Lite engineering, FP&A, Data Engineering
- **Related:** ADR 0007 (derived columns and reference-model joins, Proposed),
  ADR 0008 (neutral semantic model), ADR 0009 (portable calculation plan),
  ADR 0010 (PRQL authoring surface), ADR 0011 (model-level multi-model
  composition, Accepted); PRD §4.1, §5.1, §6.1, §6.2;
  `docs/design/derived-columns-and-reference-model-joins.md`
- **Scope:** whether a scenario can use more than one model, and how lookups
  and joins should be represented. No implementation is included.

## 1. Question

Complex budgets are rarely one flat fact table. A department budget may need:

- a **lookup** from a fact to reference data — grade rates, price lists, FX
  rates, allocation bases;
- a **join** between two facts or between a fact and a dimension — manpower
  positions to grade rates, transactions to cost centres;
- a **combination** of several cost-element models — manpower + fleet + SaaS +
  marketing — into one department budget.

The question is where that composition belongs:

1. inside one model version, as multiple datasets and relationships;
2. at scenario level, with the scenario referencing several model versions;
3. outside the platform, as a Data Engineering-owned joined view;
4. at the semantic layer only, for Cube queries;
5. as a union of model results rather than a join.

This note analyses those options. **Option A — model-level multi-dataset
composition — is the accepted MVP direction (ADR 0011).** It is described first
and in the most detail.

### Decision

ADR 0011 (Accepted, 2026-11-26) resolves the direction:

- **MVP:** Option A, delivered first as **A1** — multiple datasets inside one
  immutable model version, with `many_to_one` / `one_to_one` reference
  relationships.
- **Next slice:** **A2** — pinned cross-version reference-model joins. Approved
  in principle; it adds the dependency graph and target-version pins.
- **Deferred:** Option B (scenario-level N model versions) and Option E
  (union/composite model) require their own ADRs. Option C remains the interim
  escape hatch; Option D is subsumed by Option A.

The rest of this note is the analysis behind that decision. Section 8 records
what remains open.

## 2. Current constraints (verified in the repository)

The phase-1 path is single-model, single-dataset and single-source end to end:

| Area | Current behaviour | Evidence |
|---|---|---|
| Scenario version | One `model_version_id` per version | `apps/api/src/schema.ts:160` |
| Plan pin | Exactly one `pins.model_version_id`, enforced against the scenario version | `apps/api/src/calculation/plan.ts:10-15`; `apps/api/src/services/calculation-plan.ts:72-76` |
| Plan stages | Exactly one `scan`; no `join` op | `apps/api/src/calculation/plan.ts:38-42,454-455` |
| PRQL authoring | `from`, `filter`, `derive`, `select` only; joins rejected | `apps/api/src/calculation/authoring.ts:577` |
| Job execution | One analytic DB attached read-only; one view created at `scan.source` | `apps/api/src/worker/scenario-executor.ts:99-108,170-175` |
| Semantic validation | A model must expose exactly one dataset | `apps/api/src/semantic/validate.ts:43-47` |
| Cube generation | A model must expose exactly one dataset; no `joins:` emitted | `apps/api/src/cube/schema.ts:146-153` |
| Join validation | `JoinDefinition` members must exist as dimensions of the same model | `apps/api/src/semantic/validate.ts:168-193` |
| Target-version pin | `semantic_relationship.pinned_model_version_id` is stored but never resolved or checked | `apps/api/src/schema.ts:102`; `apps/api/src/semantic/repository.ts:113,228` |
| Source catalog | Relationships to `dim_department`, `dim_category`, `dim_region` are catalogued for model authoring, but neither preview nor jobs join them | `apps/api/src/analytics.ts:90-120` |
| Model Studio | Join authoring is an explicit follow-up | `docs/ui/model-studio.md:137` |

The neutral model introduced by ADR 0008 already has the vocabulary for
multiple datasets and relationships (`semantic_dataset`,
`semantic_relationship`), and the schema can store them. The gap is that every
validator and compiler collapses it back to exactly one dataset, and the
scenario plan has no join primitive. The current `joins` contract is
cross-model in name only.

## 3. Requirements are not all joins

“More than one model” hides three different problems. They should not share one
solution.

| Requirement | Shape | Example | Correct primitive |
|---|---|---|---|
| **Reference lookup** | fact × reference, `many_to_one` | positions × grade rate; transactions × FX rate | model relationship, `LEFT JOIN` |
| **Combine cost-element facts** | fact ∪ fact at a conformed grain | manpower + fleet + SaaS = department budget | `union` / composite model, **not** a join |
| **Ad-hoc cross-model scenario** | scenario references N independent published models | demand model × supply model | scenario-level composition (separate decision) |

Joining two facts is usually wrong: it multiplies rows and double-counts unless
one side is pre-aggregated to the join key. That is why “combine models” is a
union problem, not a join problem. Do not let a lookup feature silently become
a fact-to-fact join feature.

Within a model, vocabulary should stay explicit:

- **dataset** — one governed physical source at a declared grain;
- **relationship** — a declared join between two datasets with a cardinality
  and key pairs;
- **reference model** — a global, versioned model used for lookup;
- **derived member** — a dimension or measure computed from source, joined
  fields and constants;
- **composite model** — a model whose result is a union of model outputs, not
  a join.

## 4. Options

### Option A — Model-level multi-dataset composition (accepted MVP)

One model version owns several datasets and relationships. The scenario still
pins **one** `model_version_id`. Composition is structure, authored and
versioned with the model.

There are two useful variants. A1 is the first slice; A2 delivers true
model-to-model reference joins.

#### A1 — Multiple datasets in one model version

The fact dataset and the reference dataset are both rows of the same immutable
model version:

```yaml
format: cpm-semantic-model/1
schema_version: "1.0"
datasets:
  - name: manpower
    source: gold.fact_manpower_month
    primary_key: [position_id, period]
    fields:
      - { name: department_code, datatype: string, expression: department_code }
      - { name: grade_code,      datatype: string, expression: grade_code }
      - { name: period,          datatype: string, expression: period }
  - name: grade_rate
    source: gold.dim_grade_rate_month
    primary_key: [grade_code, period]
    fields:
      - { name: grade_code,     datatype: string,  expression: grade_code }
      - { name: period,         datatype: string,  expression: period }
      - { name: monthly_rate,   datatype: decimal, expression: monthly_rate }
      - { name: benefits_pct,   datatype: decimal, expression: benefits_pct }
metrics:
  - name: loaded_cost
    dataset: manpower
    aggregation: sum
    expression:
      op: multiply
      args:
        - { column: budgeted_fte }
        - { join: grade_rate, field: monthly_rate }
relationships:
  - name: grade_rate
    cardinality: many_to_one
    source_dataset: manpower
    source_fields: [grade_code, period]
    target_dataset: grade_rate
    target_fields: [grade_code, period]
access:
  row_level_field: department_code
```

- No cross-version pin is needed: the reference rows are part of the same model
  version and therefore covered by its `semantic_hash`.
- Publishing the model publishes both datasets atomically.
- A new rate card means a new model version; existing scenarios keep the old
  one.
- The expression shape above assumes ADR 0007's structured AST; existing
  plain-column expressions remain valid, so `cpm-semantic-model` needs a
  schema-version bump (for example `1.1`) to distinguish a multi-dataset
  document from the single-dataset `1.0` form.
- This is the smallest correct step and removes the single-dataset guards.

#### A2 — Pinned reference-model joins across model versions

The reference dataset belongs to its own global model version. The fact model
records the exact target version:

```yaml
relationships:
  - name: grade_rate
    cardinality: many_to_one
    source_dataset: manpower
    source_fields: [grade_code, period]
    target_dataset: grade_rate
    target_fields: [grade_code, period]
    pinned_model_version_id: 6a1f...   # exact published reference version
```

- The reference model is reusable across many fact models.
- The target dataset is defined by the pinned reference model version; the
  source model references it rather than repeating its fields.
- Republishing the reference model does not change existing fact model
  versions: the pin keeps them reproducible.
- The dependent model refresh fails with an actionable error when the pinned
  target disappears or a new target version is expected (ADR 0007's proposed
  default).
- A “used by” dependency view becomes necessary before production use.

#### Why A is the accepted direction

- **One scenario cardinality.** `scenario_version.model_version_id` stays
  single, so the scenario lifecycle, review, promotion and audit do not change.
- **One semantic meaning.** Cube joins and scenario joins are compiled from the
  same relationship definition. Option D would create two meanings.
- **One pin.** `pins.model_version_id` plus `semantic_hash` covers the
  relationships and, for A2, the target version pins. The job payload can add a
  resolved `model_version_ids` list for audit without changing the scenario
  contract.
- **Reuse.** Reference models (grade rates, price lists) are versioned and
  shared instead of copied into every fact model.
- **Alignment.** ADR 0007 and ADR 0008 already describe this structure; the
  work is implementation, not a new architecture.
- **Authorization stays local.** The fact model's row-level policy remains on
  the fact dataset; global reference data has no department column.

#### What A requires

| Layer | Change |
|---|---|
| Contract | `ModelDefinition` v1.1 (`datasets[]`, `grain`, `joins[].on[]`, `target_model_version_id`) and a compatible `cpm-semantic-model` schema-version bump, or the canonical neutral document as the authoring surface |
| OLTP | Keep `semantic_dataset` / `semantic_relationship`; remove the single-dataset assumption in reads and writes; resolve target versions at validation/publish |
| Validation | Allow N datasets; validate key pairs against the target dataset; enforce `many_to_one` / `one_to_one` for lookups; reject cycles, more than one hop, and unpublished targets |
| Cube | `compileCube` emits `joins:` with `many_to_one`; render all published target cubes in the same snapshot; fail dependents when a pinned target drifts |
| Preview | Multi-source allowlist; compiled joins; department policy on the fact dataset; reference models must be global or explicitly scoped |
| Calculation plan | Replace “scan one source” with “scan a dataset and expand declared relationships”, or add an explicit `join` stage; validate keys, grain and cardinality; include relationships and target pins in `plan_hash` |
| PRQL | Either keep joins implicit in the scan (recommended for the first slice) or allow a strict `join` transform with declared cardinality and no SQL strings; ADR 0010's expression-only rule stays |
| Worker | Attach the analytical DB once; create a view per dataset; emit deterministic `LEFT JOIN`s; preserve the declared result grain |
| Authorization | One access decision per dataset; start with global reference models; add cross-department deny tests |
| UI | Join builder and target-version display in Model Studio; scenario lineage shows every model version used |
| Tests | Target-key uniqueness, null keys, fan-out rejection, decimal preservation, determinism, Cube/job parity, refresh invalidation, per-dataset authorization |

#### Correctness rules for A

1. **Fan-out.** A `many_to_one` join is safe only when the target key is
   actually unique. Validate uniqueness at run time or fail the job; do not
   trust the declaration.
2. **Grain.** Joins must not change the declared result grain. If they do, an
   explicit aggregation and a new grain are required.
3. **Effective dating.** Prefer period-expanded reference tables over range
   joins on `valid_from` / `valid_to`; overlapping windows double-count.
4. **Null keys.** A lookup miss must be deterministic: `LEFT JOIN` preserves
   the fact row with `NULL` reference fields, and downstream expressions must
   handle `NULL` explicitly.
5. **Money.** Joined decimal columns remain `DECIMAL`; no floats.
6. **Pins.** Every relationship and target model version participates in the
   model hash and the job payload.
7. **Dependencies.** A reference model can be used by many fact models; a
   “used by” view and a refresh-failure policy are prerequisites for A2.

### Option B — Scenario-level composition (N model versions)

Add a `scenario_version_model` table. A scenario version references several
model versions and defines joins in its algorithm.

**Pros:** ad-hoc composition without publishing a composite model; a scenario
can mix independently owned models.

**Cons:**

- the scenario starts owning semantic structure that Cube also needs;
- every model version must be authorized separately;
- plan, job payload, promotion, audit and lineage all grow;
- reproducibility requires resolving and pinning N versions at submit;
- two join semantics (scenario vs Cube) drift;
- the UI becomes a second modelling surface.

**Verdict:** not the first move. Keep it as a possible later feature for
cross-model what-if, after model-level joins exist. It is also not a substitute
for a union when the requirement is “sum several cost models”.

### Option C — Data Engineering-owned joined view or dbt model

Create `gold.budget_cost_elements` (or a per-model view) with the lookup already
joined, register it as one governed source, and model it as today.

**Pros:** zero platform change; works now; keeps complex joins under Data
Engineering ownership, which is consistent with FR-DM-04; reproducible through
the dataset snapshot.

**Cons:** not self-service; every new lookup needs Data Engineering; semantic
join metadata, cardinality and “used by” lineage are lost; the same reference
data can be duplicated across views.

**Verdict:** the correct **interim** unblock and permanent escape hatch for
complex foundational models. It does not deliver the product requirement that
business users compose simple models with basic joins.

### Option D — Cube-only joins

Emit Cube `joins` so variance and exploration can query joined data.

**Pros:** fast analytical value; Cube already understands `many_to_one`.

**Cons:** scenario execution and preview still cannot join; the same model
means different things in Cube and in jobs.

**Verdict:** insufficient alone. It is part of Option A, not an alternative to
it.

### Option E — Union / composite model

For “manpower + fleet + SaaS = department budget”, define a composite model that
unions each cost element at a common result grain.

**Pros:** the correct semantics for combining cost-element facts; avoids
fact-to-fact fan-out.

**Cons:** needs a `union` stage or composite-model type, a conformed result
schema, and per-element lineage; it is not a lookup.

**Verdict:** a separate feature. Do not implement it by joining facts.

## 5. Comparison

| Criterion | A (model-level) | B (scenario-level) | C (DE view) | D (Cube-only) | E (union) |
|---|---|---|---|---|---|
| Scenario contract unchanged | Yes | No | Yes | Yes | Depends |
| Reproducible pin | One model version (+ target pins) | N model versions | One model version | N/A | One composite version |
| Cube and job share semantics | Yes | No | Yes | Cube only | Yes |
| Self-service join authoring | Yes | Yes, but per scenario | No | Partial | Yes |
| Reuses reference models | Yes (A2) | Yes | No | Yes | N/A |
| Handles fact-to-fact without fan-out | Only with pre-aggregation | Same risk | Delegated | N/A | Yes |
| Authorization complexity | Per dataset | Per model version | Source-level | Cube policies | Per element |
| Change size | Medium/large | Large | None | Small | Medium |
| Recommended / accepted | **Yes (MVP)** | Later, if needed | Interim | Part of A | Separate |

## 6. Accepted target architecture (Option A)

```
scenario_version
  └── model_version_id (single, immutable)
        ├── semantic_hash  ← covers datasets, relationships, target pins
        ├── dataset: manpower_fact   ← scan target
        ├── dataset: grade_rate      ← reference (A1: same version; A2: pinned model version)
        └── relationship: grade_rate
              cardinality: many_to_one
              source_fields: [grade_code, period]
              target_fields: [grade_code, period]
              pinned_model_version_id: <A2 only>
```

Compilation flow:

```
model version (datasets + relationships)
        │
        ├── validateSemanticModel  → N datasets, key/cardinality/cycle checks
        ├── compileCube            → Cube joins (many_to_one)
        ├── compilePreview         → DuckDB SELECT with LEFT JOINs
        └── compileCalculationPlan → scan + join expansion, plan_hash
                                        │
                                        ▼
                                  job payload
                                  pins: model_version_id,
                                        target model versions,
                                        semantic/plan hash,
                                        compiler version
```

The scenario detail should show the pinned model version **and** every joined
target version, so a steward can audit what produced the number.

## 7. Phased delivery

1. **Interim (now).** If a lookup is blocking a real scenario, use Option C: a
   Data Engineering-owned joined view registered as one source. Document the
   boundary; do not present it as self-service modelling.
2. **Slice 1 — A1 in the semantic layer.** Remove the exactly-one-dataset guard;
   validate N datasets and relationships; compile Cube joins; extend preview to
   one `many_to_one` hop. This is ADR 0007's first slice, adjusted for multiple
   datasets.
3. **Slice 2 — A1 in scenario execution.** Extend the canonical plan with
   dataset scans and join expansion; pin all relationships; teach the worker to
   create views for every dataset; add grain-uniqueness, fan-out and
   null-key checks; run Cube/job parity tests.
4. **Slice 3 — A2 reference models.** Resolve and pin target model versions;
   add the dependency graph and “used by” view; fail dependents on target
   drift; extend the job payload with the resolved target version list.
5. **Slice 4 — authoring and lineage UI.** Join builder, grain confirmation,
   target-version display and impact analysis in Model Studio; scenario lineage
   for every joined version.
6. **Separate decision — Option B / E.** Only if the requirement is genuinely
   “one scenario, several independent models” or “sum cost-element models”.
   Neither is a lookup join; both need their own ADR.

## 8. Open decisions

ADR 0011 resolved the MVP direction. Remaining items are marked; do not
implement past an open item without a decision.

1. **Meaning of “complex scenario”.** **Resolved for the MVP:** A1 reference
   lookups; combining cost-element models (Option E) is deferred.
2. **A1 first or A2 directly.** **Resolved:** A1 is the MVP slice; A2 follows.
3. **Cardinality policy.** **Resolved for the MVP:** `many_to_one` and
   `one_to_one` only; `one_to_many` and `many_to_many` are rejected.
4. **Effective dating.** **Resolved for the MVP:** period-expanded reference
   datasets; range joins are rejected.
5. **Reference-model scope.** **Resolved for the MVP:** global reference data
   only. Department-scoped reference data remains open.
6. **Row-level authorization on joins.** **Resolved for the MVP:** the fact
   dataset's policy governs and global reference datasets have no department
   column. Department-scoped reference data needs a policy decision.
7. **Join authoring surface.** **Resolved for the MVP:** relationships are
   declared on the model and applied implicitly to the scan; an explicit PRQL
   `join` transform is not required.
8. **Scenario-level composition.** **Resolved:** Option B is deferred to its
   own ADR, after model-level joins and a union primitive exist.

## 9. References

- `docs/adr/0011-model-level-multi-model-composition.md` — accepted MVP
  direction, scope, contract and delivery sequence.
- `docs/adr/0007-derived-columns-and-reference-model-joins.md` — proposed
  reference-model joins, cardinality and target-version pins.
- `docs/adr/0008-neutral-semantic-model-and-target-compilers.md` — datasets,
  fields, metrics and relationships; normalized storage.
- `docs/adr/0009-portable-calculation-plan.md` — single-scan plan, pins and
  deterministic DuckDB compilation.
- `docs/adr/0010-scenario-algorithm-authoring-surface.md` — PRQL subset and the
  rejection of joins.
- `docs/design/derived-columns-and-reference-model-joins.md` — target model
  contract and manpower example.
- `docs/ui/model-studio.md` — source-first authoring and the join-authoring
  follow-up.
- `apps/api/src/schema.ts`, `apps/api/src/semantic/*`, `apps/api/src/cube/schema.ts`,
  `apps/api/src/calculation/*`, `apps/api/src/worker/scenario-executor.ts`,
  `apps/api/src/analytics.ts`.
