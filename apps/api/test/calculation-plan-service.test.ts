import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/errors.js';
import { prepareCalculationPlan } from '../src/services/calculation-plan.js';

const MODEL_VERSION_ID = 'mv-service-test';

function allocationPlan() {
  return {
    format: 'cpm-calculation-plan/0',
    grain: ['department_code'],
    pins: {
      model_version_id: MODEL_VERSION_ID,
      semantic_hash: 'sha256:test',
      rule_version_ids: [],
    },
    drivers: {},
    stages: [
      {
        op: 'scan',
        source: 'base_facts',
        columns: ['department_code', 'cost_centre_code', 'pool', 'basis'],
      },
      {
        op: 'allocate',
        pool: 'pool',
        basis: 'basis',
        partition_by: ['department_code'],
        strategy: 'proportional',
        rounding: { scale: 2, mode: 'half_away_from_zero' },
        residual: { assign: 'last', order_by: ['cost_centre_code'] },
        tolerance: '0.01',
        output: 'allocated_amount',
      },
      { op: 'write', format: 'parquet', measures: ['allocated_amount'] },
    ],
  };
}

test('prepares a plan, pins its hash and detects an allocation stage', () => {
  const prepared = prepareCalculationPlan(allocationPlan(), MODEL_VERSION_ID);
  assert.ok(prepared);
  assert.equal(prepared.compiler_version, 'calculation-compiler/0');
  assert.equal(prepared.has_allocation, true);
  assert.equal(prepared.plan.pins.model_version_id, MODEL_VERSION_ID);
  assert.match(prepared.plan_hash, /^[a-f0-9]{64}$/);
});

test('rejects a plan pinned to a different model version', () => {
  assert.throws(
    () => prepareCalculationPlan(allocationPlan(), 'mv-other'),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 422 &&
      error.issues?.some((issue) => issue.code === 'calculation_plan_model_version_mismatch') === true
  );
});

test('rejects an unsafe plan with a stable issue code', () => {
  const plan: any = allocationPlan();
  plan.stages[0].columns = ['basis; DROP TABLE base_facts'];
  assert.throws(
    () => prepareCalculationPlan(plan, MODEL_VERSION_ID),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 422 &&
      error.issues?.some((issue) => issue.code === 'invalid_identifier') === true
  );
});
