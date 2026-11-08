-- ADR 0008: normalized, vendor-neutral semantic model storage.
--
-- These tables are the compiler's source of truth. `model_version.definition`
-- remains as a compatibility projection during the expand/contract window.
--
-- Keys are ordinal-based on purpose: draft definitions may contain duplicate
-- member codes, and validation must be able to report them instead of the
-- insert failing. Member codes are indexed but not unique.

ALTER TABLE orchestrator.model_version
  ADD COLUMN IF NOT EXISTS semantic_schema_version VARCHAR DEFAULT '1.0';

ALTER TABLE orchestrator.model_version
  ADD COLUMN IF NOT EXISTS semantic_hash VARCHAR;

CREATE TABLE IF NOT EXISTS orchestrator.semantic_dataset (
  model_version_id VARCHAR NOT NULL,
  dataset_code VARCHAR NOT NULL,
  source_id VARCHAR NOT NULL,
  primary_key JSON NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (model_version_id, ordinal)
);

CREATE TABLE IF NOT EXISTS orchestrator.semantic_field (
  model_version_id VARCHAR NOT NULL,
  dataset_code VARCHAR NOT NULL,
  field_code VARCHAR NOT NULL,
  label VARCHAR NOT NULL,
  datatype VARCHAR NOT NULL
    CHECK (datatype IN ('string', 'integer', 'decimal', 'date', 'boolean')),
  expression JSON NOT NULL,
  is_time BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (model_version_id, dataset_code, ordinal)
);

CREATE TABLE IF NOT EXISTS orchestrator.semantic_metric (
  model_version_id VARCHAR NOT NULL,
  metric_code VARCHAR NOT NULL,
  label VARCHAR NOT NULL,
  dataset_code VARCHAR NOT NULL,
  aggregation VARCHAR NOT NULL
    CHECK (aggregation IN ('sum', 'avg', 'min', 'max', 'count', 'count_distinct')),
  expression JSON,
  format VARCHAR NOT NULL
    CHECK (format IN ('currency', 'percent', 'number')),
  currency_code VARCHAR(3),
  description TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (model_version_id, ordinal)
);

CREATE TABLE IF NOT EXISTS orchestrator.semantic_relationship (
  model_version_id VARCHAR NOT NULL,
  relationship_code VARCHAR NOT NULL,
  cardinality VARCHAR NOT NULL
    CHECK (cardinality IN ('many_to_one', 'one_to_many', 'one_to_one')),
  source_dataset VARCHAR NOT NULL,
  source_fields JSON NOT NULL,
  target_dataset VARCHAR NOT NULL,
  target_fields JSON NOT NULL,
  pinned_model_version_id VARCHAR,
  description TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (model_version_id, ordinal)
);

CREATE TABLE IF NOT EXISTS orchestrator.semantic_access_policy (
  model_version_id VARCHAR NOT NULL,
  policy_code VARCHAR NOT NULL,
  row_level_field VARCHAR NOT NULL,
  PRIMARY KEY (model_version_id, policy_code)
);

CREATE INDEX IF NOT EXISTS ix_semantic_dataset_version
  ON orchestrator.semantic_dataset(model_version_id);
CREATE INDEX IF NOT EXISTS ix_semantic_field_version
  ON orchestrator.semantic_field(model_version_id);
CREATE INDEX IF NOT EXISTS ix_semantic_field_code
  ON orchestrator.semantic_field(model_version_id, field_code);
CREATE INDEX IF NOT EXISTS ix_semantic_metric_version
  ON orchestrator.semantic_metric(model_version_id);
CREATE INDEX IF NOT EXISTS ix_semantic_metric_code
  ON orchestrator.semantic_metric(model_version_id, metric_code);
CREATE INDEX IF NOT EXISTS ix_semantic_relationship_version
  ON orchestrator.semantic_relationship(model_version_id);
CREATE INDEX IF NOT EXISTS ix_semantic_access_version
  ON orchestrator.semantic_access_policy(model_version_id);

INSERT INTO orchestrator.schema_migration (version, name)
VALUES (2, '0002_neutral_semantic_model')
ON CONFLICT (version) DO NOTHING;
