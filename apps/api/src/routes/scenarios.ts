import type { FastifyInstance } from 'fastify';
import type {
  ScenarioCreateRequest,
  ScenarioUpdateRequest,
  ScenarioVersionCreateRequest,
  ScenarioVersionUpdateRequest,
} from '../contracts.js';
import { requireIfMatch } from '../http.js';
import { runIdempotent } from '../idempotency.js';
import {
  archiveScenario,
  createScenario,
  createScenarioVersion,
  getScenario,
  getScenarioVersion,
  getScenarioVersionResults,
  listScenarios,
  listScenarioVersions,
  patchScenario,
  updateScenarioVersion,
  validateScenarioVersion,
} from '../services/scenarios.js';
import { listScenarioVersionJobs, submitScenarioJob } from '../services/jobs.js';
import { requestContext, sendPayload, type RouteDeps } from './helpers.js';

export function registerScenarioRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, config } = deps;

  app.get('/api/v1/scenarios', async (request, reply) => {
    const result = await listScenarios(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.post('/api/v1/scenarios', { config: { bodySchema: 'ScenarioCreateRequest' } }, async (request, reply) => {
    const result = await createScenario(db, request.user, request.body as ScenarioCreateRequest, requestContext(request));
    return sendPayload(reply, result.payload, {
      status: 201,
      rowVersion: result.rowVersion,
      location: `/api/v1/scenarios/${result.payload.scenario_id}`,
    });
  });

  app.get('/api/v1/scenarios/:scenario_id', async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const result = await getScenario(db, request.user, scenario_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.patch('/api/v1/scenarios/:scenario_id', { config: { bodySchema: 'ScenarioUpdateRequest' } }, async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const expected = requireIfMatch(request);
    const result = await patchScenario(
      db,
      request.user,
      scenario_id,
      request.body as ScenarioUpdateRequest,
      expected,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.delete('/api/v1/scenarios/:scenario_id', async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const expected = requireIfMatch(request);
    const result = await archiveScenario(db, request.user, scenario_id, expected, requestContext(request));
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.get('/api/v1/scenarios/:scenario_id/versions', async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const result = await listScenarioVersions(db, request.user, scenario_id, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.post('/api/v1/scenarios/:scenario_id/versions', { config: { bodySchema: 'ScenarioVersionCreateRequest' } }, async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const result = await createScenarioVersion(
      db,
      request.user,
      scenario_id,
      request.body as ScenarioVersionCreateRequest,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, {
      status: 201,
      rowVersion: result.rowVersion,
      location: `/api/v1/scenario-versions/${result.payload.scenario_version_id}`,
    });
  });

  app.get('/api/v1/scenario-versions/:scenario_version_id', async (request, reply) => {
    const { scenario_version_id } = request.params as { scenario_version_id: string };
    const result = await getScenarioVersion(db, request.user, scenario_version_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.patch('/api/v1/scenario-versions/:scenario_version_id', { config: { bodySchema: 'ScenarioVersionUpdateRequest' } }, async (request, reply) => {
    const { scenario_version_id } = request.params as { scenario_version_id: string };
    const expected = requireIfMatch(request);
    const result = await updateScenarioVersion(
      db,
      request.user,
      scenario_version_id,
      request.body as ScenarioVersionUpdateRequest,
      expected,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.post('/api/v1/scenario-versions/:scenario_version_id/validate', async (request, reply) => {
    const { scenario_version_id } = request.params as { scenario_version_id: string };
    const result = await validateScenarioVersion(db, request.user, scenario_version_id, requestContext(request));
    return sendPayload(reply, result);
  });

  app.get('/api/v1/scenario-versions/:scenario_version_id/results', async (request, reply) => {
    const { scenario_version_id } = request.params as { scenario_version_id: string };
    const result = await getScenarioVersionResults(db, request.user, scenario_version_id);
    return sendPayload(reply, result);
  });

  app.get('/api/v1/scenario-versions/:scenario_version_id/jobs', async (request, reply) => {
    const { scenario_version_id } = request.params as { scenario_version_id: string };
    const result = await listScenarioVersionJobs(
      db,
      request.user,
      scenario_version_id,
      request.query as Record<string, string | undefined>
    );
    return sendPayload(reply, result);
  });

  app.post('/api/v1/scenario-versions/:scenario_version_id/jobs', async (request, reply) => {
    const { scenario_version_id } = request.params as { scenario_version_id: string };
    const expected = requireIfMatch(request);
    const result = await runIdempotent(
      db,
      request,
      `scenario_version:${scenario_version_id}:jobs`,
      config.idempotencyTtlHours,
      async () => {
        const submitted = await submitScenarioJob(
          db,
          request.user,
          scenario_version_id,
          expected,
          config,
          requestContext(request)
        );
        return { status: 202, payload: submitted.payload };
      }
    );
    const payload = result.payload as { job_id?: string; etag?: string };
    if (payload.etag) reply.header('ETag', payload.etag);
    if (payload.job_id) reply.header('Location', `/api/v1/jobs/${payload.job_id}`);
    return reply.code(result.status).send(payload);
  });
}
