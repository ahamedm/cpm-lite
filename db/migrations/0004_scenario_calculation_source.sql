-- ADR 0010: keep the PRQL authoring document beside the canonical plan.
--
-- `calculation_plan` remains the executable, hashed artifact. The source is
-- lineage only: it records what the author wrote, its content hash and the
-- authoring compiler version that produced the plan.

ALTER TABLE orchestrator.scenario_version
  ADD COLUMN IF NOT EXISTS calculation_source JSON;

ALTER TABLE orchestrator.scenario_version
  ADD COLUMN IF NOT EXISTS calculation_source_hash VARCHAR;

ALTER TABLE orchestrator.scenario_version
  ADD COLUMN IF NOT EXISTS calculation_authoring_version VARCHAR;
