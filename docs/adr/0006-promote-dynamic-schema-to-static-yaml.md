# ADR 0006 — Promoting dynamic models to reviewed static YAML

- **Status:** Accepted (implemented)
- **Date:** 2026-11-04
- **Deciders:** CPM Lite engineering
- **Related:** ADR 0004 (dynamic schema), ADR 0005 (Valkey store); `cube/model/promoted-models.json`

## Context

Dynamic schema makes a published model queryable immediately, but the generated
YAML lives in a cache (files or Valkey), not in the repository. Business-critical
models should eventually be frozen as reviewed static YAML, owned by a data
engineer and changed through a normal code review.

Promotion has to avoid two failure modes:

1. **Duplicate cube names.** A cube cannot exist both as a generated document and
   as a static file in `cube/model`; Cube would reject the schema (or silently
   pick one, depending on version).
2. **Silent staleness.** If a promoted model is published again, the dynamic
   refresh must not quietly leave Cube on the old static definition.

Promotion is also an operational act: it changes files that ship in the Cube
image, so it needs a maintenance window and a deploy.

## Decision

1. **Static target.** `cube/model/cubes/promoted/<cube_name>.yml`. Each file is
   ordinary Cube YAML with a generated header recording the model, version,
   source `model_version_id`, promotion timestamp and a re-promote instruction.
   `FileRepository` picks the directory up automatically.
2. **Manifest.** `cube/model/promoted-models.json` (format
   `cpm-promoted-models/1`) lists the promoted models: model code, cube name,
   pinned `model_version_id`, version number, timestamp and relative file. It is
   the contract between the promotion script and the generator, and it is
   committed with the YAML.
3. **Promotion command.** `make promote-cube-schema` (optionally
   `-- --model <code>`), implemented in `apps/api/scripts/promote-cube-schema.ts`
   with reusable logic in `apps/api/src/cube/promoted.ts`:
   - reads the current committed snapshot from the configured store (file or
     Valkey) — no OLTP access, so it runs while the API is stopped;
   - writes the static YAML and updates the manifest atomically;
   - commits a dynamic snapshot without the promoted cubes and publishes the
     Valkey refresh event (ADR 0005).
4. **Generator exclusion.** The refresh worker loads the manifest and:
   - omits promoted model codes from the generated snapshot;
   - when the published version matches the promoted `model_version_id`, marks
     that version `succeeded` with audit metadata `mode: static_yaml` (the static
     YAML already represents it);
   - when a newer version is published, fails the refresh with an actionable
     error naming the static file and the manifest. The status stays truthful;
     a data engineer re-promotes instead of the registry silently diverging.
5. **Operational sequence.** Promotion is a maintenance operation:
   1. stop the API (single DuckDB writer; avoids a refresh racing the cutover);
   2. run `make promote-cube-schema`;
   3. review and commit `cube/model/cubes/promoted/*.yml` plus
      `cube/model/promoted-models.json`;
   4. deploy the new Cube image (required in Valkey/container mode; with a
      shared file schema directory the files are already visible);
   5. restart the API and Cube.
   The script commits the reduced dynamic snapshot, so Cube will not double-load
   the promoted cube once the static files are present.
6. **Rollback.** Revert the commit (remove the static file and manifest entry)
   and run a refresh (`POST /api/v1/model-versions/{id}/refresh` or the next
   publish). The dynamic generator will emit the model again.

## Alternatives considered

- **A `promoted` flag on `model_version` in OLTP:** cleaner state, but a
  forward-only migration, API surface and UI change for an operational workflow
  that is inherently code-reviewed. The manifest keeps the cutover in the same
  PR as the YAML.
- **Export only, without cutting over:** leaves two sources of truth and does not
  stop dynamic regeneration.
- **Automatic promotion on age/stability:** rejected; promotion is a review act,
  not a time-based one.
- **Store static YAML in Valkey only:** makes Cube depend on Valkey for the
  reviewed baseline; the point of promotion is to leave the runtime cache.

## Consequences

- Promoted models change only through a reviewed YAML edit and a new promotion;
  publishing a new version fails the refresh until the data engineer updates the
  static file and manifest.
- The manifest must be committed and deployed with the YAML; a stale image with a
  newer manifest would exclude a model with no static file, so they are changed
  in the same commit.
- The DB keeps the model and its versions; promotion does not archive or freeze
  the registry record. Audit and history remain intact.
- Models archived after promotion keep their static YAML until a data engineer
  removes it; the generator no longer emits them either way.

## Verification

- `apps/api` tests cover manifest parsing, promotion filtering, the stale-version
  failure, static-file + manifest output, the reduced snapshot, and a refresh
  that marks a promoted version `succeeded` with `mode: static_yaml`.
- A real Valkey run confirms Cube boots from the store and picks up a new
  snapshot within one second of a commit event.
