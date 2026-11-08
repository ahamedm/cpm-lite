# ADR 0008 — Neutral semantic model and target compilers

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** CPM Lite engineering
- **Related:** ADR 0001, ADR 0002, ADR 0003, ADR 0004, ADR 0006, ADR 0007; PRD §4.1–§4.2; C4 `api`, `cube`, `olap`
- **Borrows from:** Apache Ossie (incubating), formerly Open Semantic Interchange (OSI), Apache-2.0. Ossie 0.1.1 is the only released line; the 0.2 line is still draft. This ADR borrows vocabulary and structure, not the draft contract.

## Context

A published model is currently stored as a JSON document in
`orchestrator.model_version.definition` and interpreted directly by
`apps/api/src/cube/schema.ts` into Cube YAML. Cube YAML is already a derived
artifact, but the stored JSON is a bespoke, Cube-adjacent shape:

- the API contract speaks in `dimensions`, `measures`, `joins`, `source` and
  `access`;
- Cube-specific rules (reserved cube names, aggregation names, `accessPolicy`,
  member formatting) live in the same module that reads the registry;
- there is no target-neutral representation that preview, scenario jobs, Cube
  and a future exchange format can share;
- model members are only queryable by parsing the whole JSON blob, which makes
  lineage and impact queries awkward;
- ADR 0007 already needs one shared compiler for preview, jobs and Cube, and a
  structured expression contract.

We need a canonical model that is vendor-neutral, versioned, validated once and
compiled to each target. Cube must remain the semantic layer (I1) and must not
become the system of record.

## Decision

1. **Adopt a canonical neutral semantic model**, `cpm-semantic-model/1`
   (`SEMANTIC_SCHEMA_VERSION = "1.0"`). It borrows Ossie concepts and names:
   a model has `datasets`, `fields`, `metrics`, `relationships` and typed
   expressions. CPM governance is carried in a documented `extensions.cpm`
   block because Ossie has no access-control construct.

2. **Store the model relationally in OLTP.** A model version owns immutable
   child rows:

   | Table | Purpose |
   |---|---|
   | `orchestrator.semantic_dataset` | dataset code, governed source, primary key, ordinal |
   | `orchestrator.semantic_field` | dimensions: code, label, datatype, structured expression, time flag |
   | `orchestrator.semantic_metric` | measures: code, label, dataset, aggregation, expression, format, currency |
   | `orchestrator.semantic_relationship` | joins: cardinality, source/target dataset and fields, pinned version |
   | `orchestrator.semantic_access_policy` | row-level field (CPM governance extension) |

   `model_version` gains `semantic_schema_version` and `semantic_hash`.
   `semantic_hash` is the SHA-256 of the canonical semantic content (labels and
   descriptions are presentation and excluded), so a version can be compared
   and pinned (I3) without re-reading Cube YAML.

3. **`model_version.definition` becomes a compatibility projection.** It stays
   during the expand/contract window because the public HTTP contract and the
   Model Studio still read `definition.dimensions` / `definition.measures`.
   Compilers and validation read the neutral model from the normalized tables
   first and fall back to the legacy JSON only when a version predates them.
   Dropping `definition` is a later contract migration, not part of this ADR.

4. **Cube becomes a target compiler.** `buildCube()` keeps its existing input
   for compatibility, converts to the neutral model and calls `compileCube()`.
   Cube-specific checks (reserved cube names, `accessPolicy` rendering, YAML
   emission) stay in the Cube target. The neutral module never emits YAML or
   SQL.

5. **Expressions stay structured.** v1 stores the existing plain-column form as
   `{ kind: "column", column: "<source column>" }`. Raw SQL text is never the
   neutral representation. ADR 0007's arithmetic/conditional AST extends this
   union; adapters lower the same tree for DuckDB preview, scenario jobs, Cube
   and any exchange format.

6. **Ossie is an adapter, not the contract.** `toOssieDocument()` exports the
   documented subset (datasets, fields, metrics, relationships) and puts CPM
   aggregation/format/currency/access in `custom_extensions`. We do not adopt
   Ossie 0.2.0.dev0 as OLTP storage: it is draft, and it has no row-level
   access model. A validated importer can be added when the spec and its access
   story stabilise.

7. **Backfill is explicit.** `make backfill-semantic` (or
   `npm --prefix apps/api run backfill-semantic`) reads legacy `definition`
   JSON and writes normalized rows where none exist. It is idempotent and
   reports scanned/written/skipped/invalid counts. New and edited versions are
   written by the API in the same transaction as the version row.

## Canonical document

```yaml
format: cpm-semantic-model/1
schema_version: "1.0"
name: finance_budget_model
label: Finance budget model
description: Department budget and actuals
datasets:
  - name: fact_financials
    source: gold.fact_financials
    primary_key: []
    fields:
      - name: department
        label: Department
        datatype: string
        expression: { kind: column, column: department_code }
        is_time: false
metrics:
  - name: budget
    label: Budget
    dataset: fact_financials
    aggregation: sum
    expression: { kind: column, column: budget_amount }
    format: currency
    currency_code: USD
relationships: []
access:
  row_level_field: department
extensions:
  cpm:
    department_code: finance
```

The canonical JSON is deterministic for object keys and preserves member order.
The hash is computed over that document.

## OLTP mapping

| Neutral concept | OLTP storage |
|---|---|
| dataset | `semantic_dataset(model_version_id, dataset_code, source_id, primary_key JSON, ordinal)` |
| field | `semantic_field(..., field_code, label, datatype, expression JSON, is_time, ordinal)` |
| metric | `semantic_metric(..., metric_code, label, dataset_code, aggregation, expression JSON, format, currency_code, ordinal)` |
| relationship | `semantic_relationship(..., relationship_code, cardinality, source_dataset, source_fields JSON, target_dataset, target_fields JSON, pinned_model_version_id, ordinal)` |
| access | `semantic_access_policy(model_version_id, policy_code, row_level_field)` |

Rows are keyed by `model_version_id` and are insert-only once the version is
published (I4). The current service keeps mutable relationships service-enforced
rather than adding foreign keys, consistent with the existing DuckDB convention.

## Compiler boundary

```
                 canonical neutral model (OLTP rows)
                              │
          ┌───────────────────┼────────────────────┐
          ▼                   ▼                    ▼
   validateSemanticModel   compileCube        toOssieDocument
   (registry rules)        (Cube YAML)        (exchange subset)
                              │
                              ▼
                 content-addressed file / Valkey snapshot
```

- Validation is target-independent: at least one dataset/field/metric, unique
  member codes, allowed datatypes/aggregations/formats, required currency,
  resolvable access field and known join members.
- Cube-only rejection (reserved names, governed source columns, safe identifiers)
  stays in `compileCube()`.
- Preview and future job compilers consume the same neutral model. They must not
  read `definition` directly.

## Migration and rollback

1. Apply migration `0002` (additive tables and two `model_version` columns).
2. Deploy the API; new writes populate normalized rows and the legacy JSON.
3. Run `make backfill-semantic` for existing versions.
4. Verify `make typecheck-api` and `npm --prefix apps/api test`.
5. Rollback is additive-safe: leave the tables in place, revert the API. The
   legacy `definition` is still authoritative for old code.

## Testing

- Unit: legacy-to-neutral conversion, validation rules, deterministic hash,
  Ossie export shape.
- Golden: `buildCube()` byte output is unchanged for the existing fixture.
- Persistence: write → read round-trip through real DuckDB child tables.
- Decoupling: a published version whose `definition` JSON is `{}` still
  refreshes when normalized rows exist.
- Backfill: idempotent, skips already-migrated versions, leaves invalid JSON
  untouched and reports it.
- Existing API end-to-end and Cube refresh suites remain green.

## Alternatives considered

- **Adopt Ossie 0.2.0.dev0 as the OLTP contract.** Rejected: draft status and no
  access-control model; governance would become unvalidated extension data.
- **Keep the JSON blob and add only a Cube adapter.** Rejected: does not remove
  the Cube-shaped vocabulary, does not enable lineage queries and leaves ADR
  0007 without a shared representation.
- **Store Cube YAML as the canonical artifact.** Rejected: YAML is output, not
  a registry; it cannot carry workflow, access or promotion semantics.
- **Fully normalize and drop `definition` immediately.** Rejected: breaks the
  public HTTP contract and Model Studio in one step. Expand/contract is safer.
- **Use Ossie `expression.sql` strings.** Rejected: reopens injection and
  portability problems and conflicts with ADR 0007's structured AST.

## Consequences

- The model registry gains a stable, queryable representation and a hash for
  reproducibility.
- Cube generation no longer owns the model's meaning; it owns one lowering.
- Two representations exist during the compatibility window. They are written
  together and the normalized rows win for compilers; the pair must not drift.
  Tests cover this, and the legacy column is scheduled for removal.
- Ossie interoperability is possible without betting the product on a draft
  specification.
- New targets (scenario jobs, another BI tool) implement a compiler, not a new
  source of truth.

## Follow-ups

- Extend the expression union with ADR 0007's structured AST and one shared
  DuckDB SQL compiler.
- Add a validated Ossie importer once the spec is released with access control.
- Remove `model_version.definition` after the API contract and UI move to the
  neutral document.
- Add lineage queries over `semantic_field` / `semantic_metric` for impact
  analysis and "used by" views.
