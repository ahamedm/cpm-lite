-- ADR 0009: pin a canonical calculation plan on a scenario version.
--
-- The plan is the scenario's algorithm representation. It is nullable so
-- existing versions and clients remain valid. The hash and compiler version
-- are stored alongside it so a job can pin the exact plan it executes.

ALTER TABLE orchestrator.scenario_version
  ADD COLUMN IF NOT EXISTS calculation_plan JSON;

ALTER TABLE orchestrator.scenario_version
  ADD COLUMN IF NOT EXISTS calculation_plan_hash VARCHAR;

ALTER TABLE orchestrator.scenario_version
  ADD COLUMN IF NOT EXISTS calculation_compiler_version VARCHAR;
