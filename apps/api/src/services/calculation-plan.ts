import {
  CALCULATION_COMPILER_VERSION,
  CalculationPlanError,
  compileCalculationSource,
  compileDuckDbPlan,
  validateCalculationPlan,
  type CalculationPlan,
  type CalculationSource,
} from '../calculation/index.js';
import { unprocessable, type ValidationIssue } from '../errors.js';

export interface PreparedCalculationPlan {
  plan: CalculationPlan;
  plan_hash: string;
  compiler_version: string;
  has_allocation: boolean;
}

export interface PreparedCalculationSource extends PreparedCalculationPlan {
  source: CalculationSource;
  source_hash: string;
  authoring_version: string;
}

export interface CalculationPlanValidationReport {
  valid: boolean;
  plan_hash: string | null;
  compiler_version: string;
}

export function calculationPlanReport(
  prepared: PreparedCalculationPlan
): CalculationPlanValidationReport {
  return {
    valid: true,
    plan_hash: prepared.plan_hash,
    compiler_version: prepared.compiler_version,
  };
}

export function failedCalculationPlanReport(): CalculationPlanValidationReport {
  return {
    valid: false,
    plan_hash: null,
    compiler_version: CALCULATION_COMPILER_VERSION,
  };
}

export function calculationPlanIssue(error: CalculationPlanError): ValidationIssue {
  return {
    severity: 'error',
    path: error.path || '/',
    code: error.code,
    message: error.reason,
  };
}

/**
 * Validate a scenario's algorithm representation against the model version it
 * belongs to and compile it once to catch target-specific errors. Runtime
 * validation is intentional: the OpenAPI schema is permissive, while the plan
 * validator is the source of truth.
 */
export function prepareCalculationPlan(
  input: unknown,
  modelVersionId: string
): PreparedCalculationPlan | null {
  if (input === null || input === undefined) return null;

  try {
    const plan = validateCalculationPlan(input);
    if (plan.pins.model_version_id !== modelVersionId) {
      throw new CalculationPlanError(
        'calculation_plan_model_version_mismatch',
        '/pins/model_version_id',
        `Plan is pinned to ${plan.pins.model_version_id}, but the scenario version uses ${modelVersionId}`
      );
    }
    const compiled = compileDuckDbPlan(plan);
    return {
      plan,
      plan_hash: compiled.plan_hash,
      compiler_version: compiled.compiler_version,
      has_allocation: plan.stages.some((stage) => stage.op === 'allocate'),
    };
  } catch (error) {
    if (error instanceof CalculationPlanError) {
      throw unprocessable('Calculation plan validation failed', [calculationPlanIssue(error)]);
    }
    throw error;
  }
}

/**
 * Compile a PRQL authoring document into the canonical plan. The plan remains
 * the stored and executed artifact; the source is kept only for lineage.
 */
export function prepareCalculationSource(
  input: unknown,
  modelVersionId: string
): PreparedCalculationSource | null {
  if (input === null || input === undefined) return null;

  try {
    const compiled = compileCalculationSource(input);
    if (compiled.plan.pins.model_version_id !== modelVersionId) {
      throw new CalculationPlanError(
        'calculation_source_model_version_mismatch',
        '/pins/model_version_id',
        `Source is pinned to ${compiled.plan.pins.model_version_id}, but the scenario version uses ${modelVersionId}`
      );
    }
    const duck = compileDuckDbPlan(compiled.plan);
    return {
      plan: compiled.plan,
      plan_hash: duck.plan_hash,
      compiler_version: duck.compiler_version,
      source: compiled.source,
      source_hash: compiled.source_hash,
      authoring_version: compiled.authoring_version,
      has_allocation: compiled.plan.stages.some((stage) => stage.op === 'allocate'),
    };
  } catch (error) {
    if (error instanceof CalculationPlanError) {
      throw unprocessable('Calculation source validation failed', [calculationPlanIssue(error)]);
    }
    throw error;
  }
}
