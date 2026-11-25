import 'dotenv/config';
import path from 'node:path';
import { CalculationPlanError, validateCalculationPlan } from '../src/calculation/index.js';
import { findRepoRoot } from '../src/config.js';
import { executeScenarioPlan } from '../src/worker/scenario-executor.js';

interface ClaimedJob {
  job_id: string;
  scenario_version_id: string;
  status: string;
  attempt: number;
  max_attempts: number;
  engine_version: string;
  payload: {
    inputs?: Record<string, unknown>;
    scenario?: {
      calculation_plan?: unknown;
      currency_code?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

const once = process.argv.includes('--once');
const repoRoot = findRepoRoot();
process.chdir(repoRoot);

const apiUrl = (process.env.CPM_API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const serviceToken = process.env.CPM_API_SERVICE_TOKEN;
const analyticsDbPath = path.resolve(
  repoRoot,
  process.env.CPM_SCENARIO_DUCKDB_PATH ?? 'data/cpm_lite.duckdb'
);
const resultsDir = path.resolve(repoRoot, process.env.CPM_RESULTS_DIR ?? 'data/results');
const parsedPollMs = Number.parseInt(process.env.CPM_WORKER_POLL_MS ?? '2000', 10);
const pollMs = Number.isFinite(parsedPollMs) && parsedPollMs > 0 ? parsedPollMs : 2000;

if (!serviceToken) {
  throw new Error('CPM_API_SERVICE_TOKEN is required for the scenario worker');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimJob(): Promise<ClaimedJob | null> {
  const response = await fetch(`${apiUrl}/internal/v1/jobs/claim`, {
    method: 'POST',
    headers: { 'x-cpm-service-token': serviceToken },
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`Claim failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { job: ClaimedJob };
  return body.job;
}

async function reportStatus(jobId: string, body: unknown): Promise<void> {
  const response = await fetch(`${apiUrl}/internal/v1/jobs/${jobId}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cpm-service-token': serviceToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Status callback failed (${response.status}): ${await response.text()}`);
  }
}

function failureCode(error: unknown): string {
  if (error instanceof CalculationPlanError) return 'calculation_plan_invalid';
  if (
    error instanceof Error &&
    /attach|no such file|does not exist|not found|lock|conflict/i.test(error.message)
  ) {
    return 'scenario_source_unavailable';
  }
  return 'scenario_execution_failed';
}

function failureMessage(error: unknown): string {
  if (error instanceof CalculationPlanError) return 'The pinned calculation plan is invalid.';
  if (
    error instanceof Error &&
    /attach|no such file|does not exist|not found|lock|conflict/i.test(error.message)
  ) {
    return 'The scenario source is unavailable. Check the analytical snapshot or stop the process holding it.';
  }
  return 'The scenario worker could not execute the pinned plan.';
}

async function processJob(job: ClaimedJob): Promise<void> {
  const scenario = job.payload?.scenario ?? {};
  const rawPlan = scenario.calculation_plan;
  if (!rawPlan) throw new Error('Job payload has no pinned calculation plan');

  const plan = validateCalculationPlan(rawPlan);
  const result = await executeScenarioPlan({
    plan,
    analyticsDbPath,
    resultsDir,
    repoRoot,
    scenarioVersionId: job.scenario_version_id,
    jobId: job.job_id,
    currencyCode:
      typeof scenario.currency_code === 'string' ? scenario.currency_code : 'USD',
  });

  await reportStatus(job.job_id, { status: 'completed', result });
}

async function main(): Promise<void> {
  console.log(
    JSON.stringify({
      worker: 'scenario',
      mode: 'development-only',
      apiUrl,
      analyticsDbPath,
      resultsDir,
      pollMs,
      once,
    })
  );

  for (;;) {
    let job: ClaimedJob | null = null;
    try {
      job = await claimJob();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ worker: 'scenario', status: 'claim_failed', error: message }));
      if (once) {
        process.exitCode = 1;
        return;
      }
      await sleep(pollMs);
      continue;
    }

    if (!job) {
      if (once) return;
      await sleep(pollMs);
      continue;
    }

    console.log(
      JSON.stringify({
        worker: 'scenario',
        status: 'running',
        job_id: job.job_id,
        scenario_version_id: job.scenario_version_id,
      })
    );

    try {
      await processJob(job);
      console.log(
        JSON.stringify({
          worker: 'scenario',
          status: 'completed',
          job_id: job.job_id,
          scenario_version_id: job.scenario_version_id,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          worker: 'scenario',
          status: 'failed',
          job_id: job.job_id,
          scenario_version_id: job.scenario_version_id,
          error: message,
        })
      );
      try {
        await reportStatus(job.job_id, {
          status: 'failed',
          error: { code: failureCode(error), message: failureMessage(error), retryable: false },
        });
      } catch (reportError) {
        console.error(
          JSON.stringify({
            worker: 'scenario',
            status: 'callback_failed',
            job_id: job.job_id,
            error: reportError instanceof Error ? reportError.message : String(reportError),
          })
        );
        process.exitCode = 1;
      }
    }

    if (once) return;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
