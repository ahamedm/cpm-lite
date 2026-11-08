import { createHash } from 'node:crypto';
import type { SemanticModel } from './types.js';

/**
 * Deterministic JSON for hashing: object keys are sorted, array order is
 * preserved because member order is part of the authored model.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function semanticModelHash(model: SemanticModel): string {
  // Labels and descriptions are presentation; changing them must not change
  // the reproducibility hash of an immutable version's semantics.
  const { label: _label, description: _description, ...content } = model;
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}
