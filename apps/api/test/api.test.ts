import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { buildApp } from '../src/app.js';
import { signToken } from '../src/auth.js';
import { applyMigrations, applySeeds } from '../src/migrate.js';

const jwtSecret = 'test-secret-for-cpm-lite-api';
const serviceToken = 'test-service-token';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function idempotent(token: string, key: string, extra: Record<string, string> = {}) {
  return { ...auth(token), 'idempotency-key': key, ...extra };
}

test('Thin Orchestrator API end-to-end', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cpm-api-test-'));
  const dbPath = path.join(tempDir, 'oltp.duckdb');
  const analyticsPath = path.join(tempDir, 'analytics.duckdb');
  await applyMigrations(dbPath);
  await applySeeds(dbPath);

  const analyticsInstance = await DuckDBInstance.create(analyticsPath);
  const analyticsConnection = await analyticsInstance.connect();
  await analyticsConnection.run(`
    CREATE SCHEMA gold;
    CREATE TABLE gold.fact_financials (
      financial_id VARCHAR PRIMARY KEY,
      transaction_id VARCHAR,
      transaction_date DATE NOT NULL,
      department_code VARCHAR NOT NULL,
      category_code VARCHAR NOT NULL,
      region_code VARCHAR NOT NULL,
      payment_method VARCHAR NOT NULL,
      budget_amount DECIMAL(18, 2) NOT NULL,
      actual_amount DECIMAL(18, 2) NOT NULL,
      variance_amount DECIMAL(18, 2) NOT NULL,
      currency_code VARCHAR NOT NULL
    );
    INSERT INTO gold.fact_financials VALUES
      ('f1', 't1', DATE '2026-01-15', 'finance', 'software', 'north', 'card', 100.00, 120.00, 20.00, 'USD'),
      ('f2', 't2', DATE '2026-02-15', 'finance', 'software', 'north', 'card', 200.00, 180.00, -20.00, 'USD'),
      ('h1', 't3', DATE '2026-01-20', 'hr', 'payroll', 'west', 'transfer', 300.00, 310.00, 10.00, 'USD');
  `);
  analyticsConnection.closeSync();
  analyticsInstance.closeSync();

  const { app } = await buildApp({
    dbPath,
    analyticsDbPath: analyticsPath,
    jwtSecret,
    serviceToken,
    jwtIssuer: null,
    logLevel: 'silent',
    engineVersion: 'test-engine',
    datasetSnapshot: 'test-snapshot',
    maxJobAttempts: 3,
    idempotencyTtlHours: 1,
    corsOrigins: [],
  });
  await app.ready();

  const finance = signToken(jwtSecret, {
    subject: 'finance-user',
    role: 'business_user',
    departmentCode: 'finance',
    costCentreCodes: ['cc_finance'],
  });
  const hr = signToken(jwtSecret, {
    subject: 'hr-user',
    role: 'business_user',
    departmentCode: 'hr',
    costCentreCodes: ['cc_hr'],
  });
  const steward = signToken(jwtSecret, {
    subject: 'steward-user',
    role: 'steward',
    departmentCode: 'finance',
  });

  try {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);

    const docs = await app.inject({ method: 'GET', url: '/docs' });
    assert.equal(docs.statusCode, 200);
    assert.match(docs.body, /swagger/i);

    const openapi = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    assert.equal(openapi.statusCode, 200);
    assert.equal(openapi.json().openapi, '3.1.0');

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(finance) });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().department_code, 'finance');

    const modelSources = await app.inject({
      method: 'GET',
      url: '/api/v1/model-sources',
      headers: auth(finance),
    });
    assert.equal(modelSources.statusCode, 200, modelSources.body);
    const source = modelSources.json().data[0];
    assert.equal(source.source_id, 'gold.fact_financials');
    assert.equal(source.row_count, 3);
    assert.equal(source.grain_unique, true);
    assert.ok(source.columns.some((column: { name: string; suggested_role: string }) => column.name === 'budget_amount' && column.suggested_role === 'measure'));

    const previewDefinition = {
      schema_version: '1.0',
      source: { source_id: 'gold.fact_financials' },
      access: { row_level_field: 'department_code' },
      dimensions: [
        { code: 'department', name: 'Department', data_type: 'string', expression: 'department_code' },
      ],
      measures: [
        {
          code: 'budget',
          name: 'Budget',
          aggregation: 'sum',
          expression: 'budget_amount',
          format: 'currency',
          currency_code: 'USD',
        },
      ],
    };

    const financePreview = await app.inject({
      method: 'POST',
      url: '/api/v1/model-preview',
      headers: auth(finance),
      payload: { definition: previewDefinition, group_by: ['department'], measures: ['budget'], limit: 10 },
    });
    assert.equal(financePreview.statusCode, 200, financePreview.body);
    assert.equal(financePreview.json().row_count, 2);
    assert.equal(String(financePreview.json().totals.budget), '300.00');
    assert.equal(financePreview.json().rows[0].department, 'finance');
    assert.equal(financePreview.json().scope.applied, true);

    const crossDepartmentPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/model-preview',
      headers: auth(finance),
      payload: {
        definition: previewDefinition,
        group_by: ['department'],
        measures: ['budget'],
        preview_department_code: 'hr',
      },
    });
    assert.equal(crossDepartmentPreview.statusCode, 403);

    const stewardScopedPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/model-preview',
      headers: auth(steward),
      payload: {
        definition: previewDefinition,
        group_by: ['department'],
        measures: ['budget'],
        preview_department_code: 'finance',
      },
    });
    assert.equal(stewardScopedPreview.statusCode, 200, stewardScopedPreview.body);
    assert.equal(String(stewardScopedPreview.json().totals.budget), '300.00');
    assert.equal(stewardScopedPreview.json().scope.preview_as, true);

    const stewardAllPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/model-preview',
      headers: auth(steward),
      payload: { definition: previewDefinition, group_by: ['department'], measures: ['budget'] },
    });
    assert.equal(stewardAllPreview.statusCode, 200, stewardAllPreview.body);
    assert.equal(String(stewardAllPreview.json().totals.budget), '600.00');
    assert.equal(stewardAllPreview.json().scope.applied, false);

    const unsafePreview = await app.inject({
      method: 'POST',
      url: '/api/v1/model-preview',
      headers: auth(finance),
      payload: {
        definition: {
          ...previewDefinition,
          dimensions: [
            {
              code: 'department',
              name: 'Department',
              data_type: 'string',
              expression: 'department_code; DROP TABLE gold.fact_financials',
            },
          ],
        },
        group_by: ['department'],
        measures: ['budget'],
      },
    });
    assert.equal(unsafePreview.statusCode, 422);

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/models' });
    assert.equal(unauthenticated.statusCode, 401);

    const createModel = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: auth(finance),
      payload: {
        name: 'Finance Budget Model',
        visibility: 'department',
        definition: {
          schema_version: '1.0',
          dimensions: [{ code: 'department', name: 'Department', data_type: 'string', expression: 'department_code' }],
          measures: [{ code: 'budget', name: 'Budget', aggregation: 'sum', expression: 'budget_amount', format: 'currency', currency_code: 'USD' }],
        },
      },
    });
    assert.equal(createModel.statusCode, 201, createModel.body);
    const model = createModel.json();
    const modelId = model.model_id as string;
    const modelVersionId = model.latest_version.model_version_id as string;

    const validateModel = await app.inject({
      method: 'POST',
      url: `/api/v1/model-versions/${modelVersionId}/validate`,
      headers: auth(finance),
    });
    assert.equal(validateModel.statusCode, 200, validateModel.body);
    assert.equal(validateModel.json().valid, true);

    const currentModelVersion = await app.inject({
      method: 'GET',
      url: `/api/v1/model-versions/${modelVersionId}`,
      headers: auth(finance),
    });
    assert.equal(currentModelVersion.statusCode, 200);
    const modelVersionEtag = currentModelVersion.headers.etag as string;

    const publishModel = await app.inject({
      method: 'POST',
      url: `/api/v1/model-versions/${modelVersionId}/publish`,
      headers: idempotent(finance, 'publish-model-key', { 'if-match': modelVersionEtag }),
    });
    assert.equal(publishModel.statusCode, 202, publishModel.body);
    assert.equal(publishModel.json().model_version.status, 'published');
    assert.equal(publishModel.json().cube_refresh.status, 'pending');

    const crossDepartmentModel = await app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}`,
      headers: auth(hr),
    });
    assert.equal(crossDepartmentModel.statusCode, 404);

    const createScenario = await app.inject({
      method: 'POST',
      url: '/api/v1/scenarios',
      headers: auth(finance),
      payload: {
        name: 'FY2026 Finance Budget',
        scenario_type: 'budget',
        cost_centre_code: 'cc_finance',
        model_version_id: modelVersionId,
        base: { base_type: 'actuals' },
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        currency_code: 'USD',
        drivers: [{ driver_code: 'growth_pct', name: 'Growth', value: '0.05', unit: 'percent' }],
      },
    });
    assert.equal(createScenario.statusCode, 201, createScenario.body);
    const scenario = createScenario.json();
    const scenarioId = scenario.scenario_id as string;
    const scenarioVersionId = scenario.latest_version.scenario_version_id as string;

    const validateScenario = await app.inject({
      method: 'POST',
      url: `/api/v1/scenario-versions/${scenarioVersionId}/validate`,
      headers: auth(finance),
    });
    assert.equal(validateScenario.statusCode, 200, validateScenario.body);
    assert.equal(validateScenario.json().report.valid, true);

    const currentScenarioVersion = await app.inject({
      method: 'GET',
      url: `/api/v1/scenario-versions/${scenarioVersionId}`,
      headers: auth(finance),
    });
    assert.equal(currentScenarioVersion.statusCode, 200);
    const scenarioVersionEtag = currentScenarioVersion.headers.etag as string;

    const submitJob = await app.inject({
      method: 'POST',
      url: `/api/v1/scenario-versions/${scenarioVersionId}/jobs`,
      headers: idempotent(finance, 'job-submit-key', { 'if-match': scenarioVersionEtag }),
    });
    assert.equal(submitJob.statusCode, 202, submitJob.body);
    const job = submitJob.json();
    const jobId = job.job_id as string;
    assert.equal(job.status, 'queued');
    assert.equal(job.inputs.dataset_snapshot, 'test-snapshot');

    const replayJob = await app.inject({
      method: 'POST',
      url: `/api/v1/scenario-versions/${scenarioVersionId}/jobs`,
      headers: idempotent(finance, 'job-submit-key', { 'if-match': scenarioVersionEtag }),
    });
    assert.equal(replayJob.statusCode, 202);
    assert.equal(replayJob.json().job_id, jobId);

    const unauthorisedWorker = await app.inject({
      method: 'POST',
      url: `/internal/v1/jobs/${jobId}/status`,
      payload: { status: 'running' },
    });
    assert.equal(unauthorisedWorker.statusCode, 403);

    const completeJob = await app.inject({
      method: 'POST',
      url: `/internal/v1/jobs/${jobId}/status`,
      headers: { 'x-cpm-service-token': serviceToken },
      payload: {
        status: 'completed',
        result: {
          result_uri: 'test://results/finance-budget',
          totals: {
            budget_amount: '1000.00',
            actual_amount: '1100.00',
            variance_amount: '100.00',
            currency_code: 'USD',
          },
          allocation_summary: {
            pool_total: '1000.00',
            allocated_total: '1000.00',
            residual: '0.00',
            tolerance: '0.01',
            within_tolerance: true,
            strategy: 'headcount',
            driver_basis: 'headcount',
          },
          rule_outcomes: [],
          completed_at: new Date().toISOString(),
        },
      },
    });
    assert.equal(completeJob.statusCode, 200, completeJob.body);
    assert.equal(completeJob.json().status, 'completed');

    const completedVersion = await app.inject({
      method: 'GET',
      url: `/api/v1/scenario-versions/${scenarioVersionId}`,
      headers: auth(finance),
    });
    assert.equal(completedVersion.statusCode, 200);
    assert.equal(completedVersion.json().status, 'completed');
    assert.equal(completedVersion.json().result.result_uri, 'test://results/finance-budget');

    const results = await app.inject({
      method: 'GET',
      url: `/api/v1/scenario-versions/${scenarioVersionId}/results`,
      headers: auth(finance),
    });
    assert.equal(results.statusCode, 200);
    assert.equal(results.json().totals.variance_amount, '100.00');

    const createSubmission = await app.inject({
      method: 'POST',
      url: `/api/v1/scenario-versions/${scenarioVersionId}/submissions`,
      headers: idempotent(finance, 'submission-key'),
      payload: { note: 'please review' },
    });
    assert.equal(createSubmission.statusCode, 201, createSubmission.body);
    const submission = createSubmission.json();
    const submissionId = submission.submission_id as string;
    assert.equal(submission.status, 'submitted');

    const crossDepartmentSubmission = await app.inject({
      method: 'GET',
      url: `/api/v1/submissions/${submissionId}`,
      headers: auth(hr),
    });
    assert.equal(crossDepartmentSubmission.statusCode, 404);

    const businessDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${submissionId}/decisions`,
      headers: idempotent(finance, 'forbidden-decision', { 'if-match': submission.etag }),
      payload: { decision: 'approve' },
    });
    assert.equal(businessDecision.statusCode, 403);

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${submissionId}/decisions`,
      headers: { ...auth(steward), 'if-match': submission.etag },
      payload: { decision: 'approve', comment: 'looks good' },
    });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.equal(approve.json().status, 'approved');
    const approvedEtag = approve.headers.etag as string;

    const createPlan = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: auth(steward),
      payload: { name: 'FY2026 Finance Plan', fiscal_year: 2026 },
    });
    assert.equal(createPlan.statusCode, 201, createPlan.body);
    const planId = createPlan.json().plan_id as string;

    const promote = await app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${submissionId}/promotion`,
      headers: idempotent(steward, 'promotion-key', { 'if-match': approvedEtag }),
      payload: { plan_id: planId, effective_from: '2026-01-01' },
    });
    assert.equal(promote.statusCode, 202, promote.body);
    assert.equal(promote.json().status, 'succeeded');
    assert.ok(promote.json().plan_version_id);

    const planVersions = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${planId}/versions`,
      headers: auth(steward),
    });
    assert.equal(planVersions.statusCode, 200);
    assert.equal(planVersions.json().data.length, 1);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-events',
      headers: auth(steward),
    });
    assert.equal(audit.statusCode, 200);
    assert.ok(audit.json().data.length > 0);

    // Rule-driven pre-submit validation: a new version without growth_pct must fail.
    const createRule = await app.inject({
      method: 'POST',
      url: '/api/v1/rules',
      headers: auth(steward),
      payload: { name: 'Require growth driver' },
    });
    assert.equal(createRule.statusCode, 201, createRule.body);
    const ruleId = createRule.json().rule_id as string;

    const createRuleVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/rules/${ruleId}/versions`,
      headers: auth(steward),
      payload: {
        evaluation_point: 'pre_submit',
        priority: 10,
        effective_from: '2026-01-01',
        scopes: [{ scope_type: 'global' }],
        definition: {
          schema_version: '1.0',
          kind: 'validation',
          parameters: { required_driver_codes: ['growth_pct'] },
        },
      },
    });
    assert.equal(createRuleVersion.statusCode, 201, createRuleVersion.body);
    const ruleVersion = createRuleVersion.json();
    const ruleVersionId = ruleVersion.rule_version_id as string;

    const validateRule = await app.inject({
      method: 'POST',
      url: `/api/v1/rule-versions/${ruleVersionId}/validate`,
      headers: auth(steward),
    });
    assert.equal(validateRule.statusCode, 200, validateRule.body);
    assert.equal(validateRule.json().valid, true);

    const currentRuleVersion = await app.inject({
      method: 'GET',
      url: `/api/v1/rule-versions/${ruleVersionId}`,
      headers: auth(steward),
    });
    const ruleVersionEtag = currentRuleVersion.headers.etag as string;

    const publishRule = await app.inject({
      method: 'POST',
      url: `/api/v1/rule-versions/${ruleVersionId}/publish`,
      headers: { ...auth(steward), 'if-match': ruleVersionEtag },
    });
    assert.equal(publishRule.statusCode, 200, publishRule.body);
    assert.equal(publishRule.json().status, 'active');

    const createSecondVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/scenarios/${scenarioId}/versions`,
      headers: auth(finance),
      payload: {
        model_version_id: modelVersionId,
        base: { base_type: 'actuals' },
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        currency_code: 'USD',
        drivers: [],
      },
    });
    assert.equal(createSecondVersion.statusCode, 201, createSecondVersion.body);
    const secondVersionId = createSecondVersion.json().scenario_version_id as string;

    const failedValidation = await app.inject({
      method: 'POST',
      url: `/api/v1/scenario-versions/${secondVersionId}/validate`,
      headers: auth(finance),
    });
    assert.equal(failedValidation.statusCode, 200);
    assert.equal(failedValidation.json().report.valid, false);
    assert.ok(failedValidation.json().report.issues.some((issue: { code: string }) => issue.code === 'require_growth_driver'));
  } finally {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
