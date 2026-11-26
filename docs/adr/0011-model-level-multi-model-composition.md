# ADR 0011 — Model-level multi-model composition for scenarios

- **Status:** Accepted — MVP direction. A1 is the MVP slice; A2 follows.
- **Date:** 2026-11-26
- **Deciders:** CPM Lite engineering, FP&A, Data Engineering
- **Related:** ADR 0007 (derived columns and reference-model joins, Proposed),
  ADR 0008 (neutral semantic model), ADR 0009 (portable calculation plan),
  ADR 0010 (PRQL authoring surface); design note
  `docs/design/scenario-multi-model-composition.md`; PRD §4.1, §5.1, §6.1,
  §6.2; C4 `api`, `cube`, `olap`, `jobs`
- **Implementation:** A1 implemented 2026-11-26 across the model contract,
  semantic storage/validation, Cube joins, joined preview, calculation-plan
  join stages, worker execution and Model Studio reference authoring. A2
  (pinned cross-version reference models) remains outstanding.

## Context

A department budget is often not one flat fact. It needs reference lookups
(grade rates, price lists, FX rates), joins to dimensions, and sometimes a
combination of cost-element facts (manpower, fleet, SaaS, marketing).

The phase-1 path cannot express any of that:

- `scenario_version` carries one `model_version_id`;
- the canonical plan pins one model version and allows one `scan` with no
  `join` stage;
- PRQL rejects joins;
- the worker creates a view for one source only;
- semantic validation and Cube generation require exactly one dataset;
- `JoinDefinition` is cross-model in name only: its members must be dimensions
  of the same model;
- `semantic_relationship.pinned_model_version_id` is stored but never resolved
  or checked.

The neutral model (ADR 0008) already has `datasets`, `fields`, `metrics` and
`relationships`, and the OLTP schema can store them. The missing piece is a
decision about where composition belongs and what the MVP delivers.

The alternatives were analysed in
`docs/design/scenario-multi-model-composition.md`: model-level composition
(Option A), scenario-level composition (Option B), Data Engineering-owned
joined views (Option C), Cube-only joins (Option D) and union/composite models
(Option E).

## Decision

1. **Adopt Option A — model-level multi-model composition — as the MVP
   direction.** A scenario still pins exactly one immutable model version. That
   model version becomes a composition of datasets and relationships. The
   scenario contract, lifecycle, review, promotion and audit do not gain a
   second model reference.

2. **MVP slice is A1: multiple datasets inside one model version.** A model
   version may declare N datasets, each with its own governed source, primary
   key and fields, plus `many_to_one` or `one_to_one` relationships between
   them. The reference dataset is part of the same model version and is
   therefore covered by its `semantic_hash`. No cross-version target pin is
   required for A1.

3. **A2 is approved as the next slice, without a new ADR.** A2 adds
   cross-version reference-model joins: a fact model relationship names the
   exact published target `model_version_id`. Its prerequisites are the
   dependency graph, a "used by" view, and the refresh-failure policy described
   in ADR 0007. A2 is not part of the MVP release unless the MVP acceptance
   criteria explicitly require reusable reference models.

4. **One shared semantic definition serves Cube, preview and scenario jobs.**
   Model validation, Cube YAML generation, Model Studio preview, calculation
   plan compilation and the worker all consume the same datasets and
   relationships. No target may invent its own join semantics.

5. **The scenario remains single-model.** `scenario_version.model_version_id`
   stays a single column. The job payload continues to pin the scenario
   version, model version, semantic hash, plan hash, compiler version and
   dataset snapshot. For A2 it additionally records the resolved target model
   version IDs.

6. **Only lookup-safe cardinalities are allowed in the MVP.** Relationships are
   `many_to_one` or `one_to_one`. `one_to_many` and `many_to_many` joins are
   rejected; fact-to-fact combination is a union/composite-model problem
   (Option E), not a join. Target-key uniqueness is validated at run time, not
   trusted from the declaration.

7. **Joins are model structure, not scenario code.** PRQL remains an
   expression-only authoring surface for the row pipeline (ADR 0010). The first
   slice applies relationships implicitly to the scan; an explicit PRQL `join`
   transform is not required. Raw SQL, `s"..."` / `f"..."`, subqueries and
   user-supplied join predicates remain rejected.

8. **Contract and compatibility.** `ModelDefinition` gains a `1.1` shape with
   `datasets[]`, `grain` and `joins[].on[]`. This extends ADR 0007's `1.1`
   proposal: a single-dataset `1.1` document remains a valid subset of the
   multi-dataset form. The canonical `cpm-semantic-model` document gains a
   compatible schema version for multi-dataset documents. Existing `1.0`
   single-dataset models remain valid and are read through the compatibility
   projection. The normalized `semantic_dataset` and `semantic_relationship`
   rows remain the compiler source of truth (ADR 0008).

9. **Authorization stays per dataset and server-side.** The fact dataset keeps
   the governed `department_code` row-level policy. MVP reference datasets are
   global and carry no department column. Every new endpoint/query needs
   positive and cross-department negative tests (I7). A departmental reference
   dataset is out of scope until the policy semantics are decided.

10. **Determinism is part of the contract.** Joined decimals stay `DECIMAL`,
    lookup misses are deterministic `NULL`s, target-key uniqueness and grain
    are validated, and the same pinned payload must produce the same plan hash
    and result (I3, I11).

11. **Deferred decisions.** Option B (scenario-level N model versions) and
    Option E (union/composite model) are not part of the MVP and require their
    own ADRs. Option C remains the interim escape hatch for complex
    Data-Engineering-owned models. Option D is subsumed by Option A: Cube joins
    are one compiler target, not a separate architecture.

## MVP scope

### In scope

- N datasets in an immutable model version, each with a governed source,
  primary key and fields.
- `many_to_one` / `one_to_one` reference relationships within the model
  version (A1).
- `ModelDefinition` `1.1` and a compatible `cpm-semantic-model` schema bump;
  `1.0` remains valid.
- Target-independent validation: dataset count, unique dataset names, field
  membership per dataset, key pairs, cardinality, cycles, one hop, and runtime
  target-key uniqueness.
- Cube generation of `many_to_one` joins; reference datasets are compiled as
  join targets and are not presented as separate user-facing cubes.
- Model Studio preview with one join hop and the fact dataset's department
  policy.
- Calculation plan support for scanning a dataset and expanding its declared
  relationships; relationship metadata participates in `plan_hash`.
- Worker support for one attached analytical DB, a view per dataset, and
  deterministic `LEFT JOIN` execution at the declared grain.
- A minimal join builder in Model Studio and scenario lineage showing every
  dataset used; the read-only states and the existing design system apply.
- Tests and documentation listed under **Verification**.

### Out of scope

- Cross-version reference-model reuse (A2) — approved next slice, not the MVP
  release unless explicitly required.
- Scenario-level composition of N model versions (Option B).
- Union/composite models for cost-element facts (Option E).
- `one_to_many` / `many_to_many` joins and fact-to-fact joins.
- Range joins on `valid_from` / `valid_to`; period-expanded reference datasets
  are required.
- Department-scoped reference datasets; global reference data only.
- Arbitrary SQL, user-defined join predicates, templates, AI suggestions and a
  code editor.
- Multi-currency/FX translation beyond the existing single reporting currency.
- Pre-aggregations and Cube Store performance work.

## Data model and compilation

```text
scenario_version
  └── model_version_id (single, immutable)
        ├── semantic_hash
        ├── dataset: fact (governed source, primary key, fields)
        ├── dataset: reference (governed source, primary key, fields)
        └── relationship: reference
              cardinality: many_to_one
              source_dataset: fact
              source_fields: [grade_code, period]
              target_dataset: reference
              target_fields: [grade_code, period]
              pinned_model_version_id: null in A1, exact target in A2
```

Compilation flow:

```text
model version (datasets + relationships)
        │
        ├── validateSemanticModel   → dataset/key/cardinality/cycle checks
        ├── compileCube             → fact cube + reference cubes, many_to_one joins
        ├── compilePreview          → DuckDB SELECT with LEFT JOINs
        └── compileCalculationPlan  → dataset scan + join expansion, plan_hash
                                        │
                                        ▼
                                  job payload
                                  pins: scenario version,
                                        model version,
                                        semantic/plan hash,
                                        compiler version,
                                        dataset snapshot,
                                        resolved target versions (A2)
```

The plan may represent the join either implicitly (a dataset scan expands its
declared relationships) or as an explicit plan stage. The choice is an
implementation detail, but the plan hash must cover the resolved relationship
and target-version metadata.

## Invariants

- **I1 — Thin layer.** DuckDB executes the join; Cube expresses the same
  relationship. No new join engine or scheduler.
- **I2 — Job isolation.** One exclusive DuckDB per job. Multiple datasets are
  attached read-only to that instance; no shared temp schema.
- **I3 — Reproducibility.** The model version, semantic hash, relationship
  metadata, plan hash, compiler version and (A2) target model versions are
  pinned in the payload.
- **I4 — Immutability.** Datasets and relationships live in the immutable model
  version; edits create a new version.
- **I5 — Rules are data.** Joins use structured key pairs, not user SQL.
- **I7 — Authorization.** Per-dataset access decisions; fact policy remains
  server-side; cross-department negative tests.
- **I10 — Gold is read-only.** Reference datasets are read, never written.
- **I11 — Money is deterministic.** Joined decimals remain fixed-point; null
  and zero keys are handled explicitly.
- **I12 — No magic NFR numbers.** Join performance targets stay in
  configuration/PRD placeholders until resolved.

## Verification (planned)

- Contract: `ModelDefinition` `1.0` and `1.1` round-trip; OpenAPI lint.
- Validation: N datasets, duplicate dataset names, unknown members per dataset,
  missing keys, unsupported cardinality, cycles, more than one hop, unpublished
  targets (A2), and target drift.
- Cube golden: `many_to_one` joins emitted; reference cubes internal; no join
  for a single-dataset model (compatibility).
- Preview/job parity: the same model version, relationship and period produce
  identical totals.
- Runtime: target-key uniqueness, fan-out rejection, null lookup handling,
  exact decimals, declared grain preserved.
- Authorization: authorized and cross-department denied for the fact dataset and
  the reference dataset.
- Determinism: the same pinned payload produces the same plan hash and result
  across reruns.
- UI: loading, empty, error, disabled and permission-read-only states; reviewed
  at 1440 px and 390 px with no horizontal overflow; `impeccable` review.
- Performance: exercise the synthetic 10k-row dataset; no NFR target is claimed
  until a real number is approved.

## Consequences

- The MVP delivers reference lookups without changing the scenario lifecycle or
  introducing a scenario-to-model join table.
- Model authoring becomes richer: datasets, grain, relationships and a join
  builder. The existing single-dataset `1.0` path must stay working.
- Cube and scenario execution share one definition, avoiding two join
  semantics.
- A2 will add a dependency graph, target pins and refresh failure handling;
  those are operational prerequisites, not optional polish.
- Fan-out, effective dating and authorization remain the highest correctness
  risks.
- Option B and Option E are explicitly deferred; they cannot be smuggled in as
  "just another join".

## Alternatives considered

| Alternative | Outcome |
|---|---|
| Option B — scenario-level N model versions | Deferred. Flexible but duplicates the semantic layer, complicates authorization, pins and promotion, and diverges from Cube. |
| Option C — Data Engineering-owned joined view | Retained as the interim escape hatch for complex models; not self-service. |
| Option D — Cube-only joins | Rejected as an architecture; subsumed by Option A so preview and jobs share the definition. |
| Option E — union/composite model | Deferred to a separate ADR; the correct primitive for combining cost-element facts, not a lookup. |
| Fact-to-fact many-to-many joins | Rejected for the MVP; requires mandatory pre-aggregation and explicit grain semantics. |
| Range joins on effective dates | Rejected for the MVP; period-expanded reference datasets avoid overlap and double counting. |

## Delivery sequence

1. **Contract and storage.** `ModelDefinition` `1.1`, semantic schema bump,
   normalized dataset/relationship writes, `1.0` compatibility, validation.
2. **Cube and preview.** `compileCube` joins and reference cubes; preview with
   one join hop and department policy.
3. **Plan and worker.** Dataset scan + join expansion, relationship pins in
   `plan_hash`, worker views and deterministic `LEFT JOIN` execution.
4. **UI.** Minimal join builder, grain confirmation, lineage and read-only
   states; `impeccable` review.
5. **A2.** Cross-version target pins, dependency graph, "used by" view and
   refresh-failure policy.

Option C remains available at any point as the interim path for a specific
complex model.

## References

- `docs/design/scenario-multi-model-composition.md` — full option analysis and
  current-constraint evidence.
- `docs/adr/0007-derived-columns-and-reference-model-joins.md` — structured
  expressions, reference models, cardinality and target-version pins.
- `docs/adr/0008-neutral-semantic-model-and-target-compilers.md` — dataset /
  relationship storage and hash.
- `docs/adr/0009-portable-calculation-plan.md` — plan pins and deterministic
  DuckDB compilation.
- `docs/adr/0010-scenario-algorithm-authoring-surface.md` — PRQL subset.
- `docs/design/derived-columns-and-reference-model-joins.md` — manpower and
  grade-rate example.
- `apps/api/src/semantic/validate.ts`, `apps/api/src/cube/schema.ts`,
  `apps/api/src/calculation/plan.ts`,
  `apps/api/src/worker/scenario-executor.ts`, `apps/api/src/analytics.ts`.
