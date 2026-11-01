import type { FastifyInstance } from 'fastify';
import type { DecisionRequest, PlanCreateRequest, PromotionRequest, SubmissionCreateRequest } from '../contracts.js';
import { requireIfMatch } from '../http.js';
import { runIdempotent } from '../idempotency.js';
import {
  createPlan,
  decideSubmission,
  getPlanById,
  getPlanVersionById,
  getPromotion,
  getSubmission,
  listPlanVersions,
  listPlans,
  listSubmissions,
  promoteSubmission,
  submitScenarioVersion,
} from '../services/workflow.js';
import { requestContext, sendPayload, type RouteDeps } from './helpers.js';

export function registerWorkflowRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, config } = deps;

  app.post(
    '/api/v1/scenario-versions/:scenario_version_id/submissions',
    { config: { bodySchema: 'SubmissionCreateRequest', bodyOptional: true } },
    async (request, reply) => {
      const { scenario_version_id } = request.params as { scenario_version_id: string };
      const result = await runIdempotent(
        db,
        request,
        `scenario_version:${scenario_version_id}:submission`,
        config.idempotencyTtlHours,
        async () => {
          const submitted = await submitScenarioVersion(
            db,
            request.user,
            scenario_version_id,
            (request.body as SubmissionCreateRequest | undefined) ?? {},
            requestContext(request)
          );
          return { status: 201, payload: submitted.payload };
        }
      );
      const payload = result.payload as { submission_id?: string; etag?: string };
      if (payload.etag) reply.header('ETag', payload.etag);
      if (payload.submission_id) reply.header('Location', `/api/v1/submissions/${payload.submission_id}`);
      return reply.code(result.status).send(payload);
    }
  );

  app.get('/api/v1/submissions', async (request, reply) => {
    const result = await listSubmissions(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.get('/api/v1/submissions/:submission_id', async (request, reply) => {
    const { submission_id } = request.params as { submission_id: string };
    const result = await getSubmission(db, request.user, submission_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.post(
    '/api/v1/submissions/:submission_id/decisions',
    { config: { bodySchema: 'DecisionRequest' } },
    async (request, reply) => {
      const { submission_id } = request.params as { submission_id: string };
      const expected = requireIfMatch(request);
      const result = await decideSubmission(
        db,
        request.user,
        submission_id,
        request.body as DecisionRequest,
        expected,
        requestContext(request)
      );
      return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
    }
  );

  app.post(
    '/api/v1/submissions/:submission_id/promotion',
    { config: { bodySchema: 'PromotionRequest' } },
    async (request, reply) => {
      const { submission_id } = request.params as { submission_id: string };
      const expected = requireIfMatch(request);
      const result = await runIdempotent(
        db,
        request,
        `submission:${submission_id}:promotion`,
        config.idempotencyTtlHours,
        async () => {
          const promoted = await promoteSubmission(
            db,
            request.user,
            submission_id,
            request.body as PromotionRequest,
            expected,
            requestContext(request)
          );
          return { status: 202, payload: promoted.payload };
        }
      );
      const payload = result.payload as { promotion_id?: string; etag?: string };
      if (payload.etag) reply.header('ETag', payload.etag);
      if (payload.promotion_id) reply.header('Location', `/api/v1/promotions/${payload.promotion_id}`);
      return reply.code(result.status).send(payload);
    }
  );

  app.get('/api/v1/promotions/:promotion_id', async (request, reply) => {
    const { promotion_id } = request.params as { promotion_id: string };
    const result = await getPromotion(db, request.user, promotion_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.get('/api/v1/plans', async (request, reply) => {
    const result = await listPlans(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.post('/api/v1/plans', { config: { bodySchema: 'PlanCreateRequest' } }, async (request, reply) => {
    const result = await createPlan(db, request.user, request.body as PlanCreateRequest, requestContext(request));
    return sendPayload(reply, result.payload, {
      status: 201,
      rowVersion: result.rowVersion,
      location: `/api/v1/plans/${result.payload.plan_id}`,
    });
  });

  app.get('/api/v1/plans/:plan_id', async (request, reply) => {
    const { plan_id } = request.params as { plan_id: string };
    const result = await getPlanById(db, request.user, plan_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.get('/api/v1/plans/:plan_id/versions', async (request, reply) => {
    const { plan_id } = request.params as { plan_id: string };
    const result = await listPlanVersions(db, request.user, plan_id, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.get('/api/v1/plan-versions/:plan_version_id', async (request, reply) => {
    const { plan_version_id } = request.params as { plan_version_id: string };
    const result = await getPlanVersionById(db, request.user, plan_version_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });
}
