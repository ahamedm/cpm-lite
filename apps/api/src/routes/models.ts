import type { FastifyInstance } from 'fastify';
import type { ModelCreateRequest, ModelUpdateRequest, ModelVersionCreateRequest, ModelVersionUpdateRequest } from '../contracts.js';
import { requireIfMatch } from '../http.js';
import { runIdempotent } from '../idempotency.js';
import {
  archiveModel,
  createModel,
  createModelVersion,
  getModel,
  getModelVersion,
  listModels,
  listModelVersions,
  patchModel,
  publishModelVersion,
  updateModelVersion,
  validateModelVersion,
} from '../services/models.js';
import { requestContext, sendPayload, type RouteDeps } from './helpers.js';

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, config } = deps;

  app.get('/api/v1/models', async (request, reply) => {
    const result = await listModels(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.post('/api/v1/models', { config: { bodySchema: 'ModelCreateRequest' } }, async (request, reply) => {
    const result = await createModel(db, request.user, request.body as ModelCreateRequest, requestContext(request));
    return sendPayload(reply, result.payload, {
      status: 201,
      rowVersion: result.rowVersion,
      location: `/api/v1/models/${result.payload.model_id}`,
    });
  });

  app.get('/api/v1/models/:model_id', async (request, reply) => {
    const { model_id } = request.params as { model_id: string };
    const result = await getModel(db, request.user, model_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.patch('/api/v1/models/:model_id', { config: { bodySchema: 'ModelUpdateRequest' } }, async (request, reply) => {
    const { model_id } = request.params as { model_id: string };
    const expected = requireIfMatch(request);
    const result = await patchModel(db, request.user, model_id, request.body as ModelUpdateRequest, expected, requestContext(request));
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.delete('/api/v1/models/:model_id', async (request, reply) => {
    const { model_id } = request.params as { model_id: string };
    const expected = requireIfMatch(request);
    const result = await archiveModel(db, request.user, model_id, expected, requestContext(request));
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.get('/api/v1/models/:model_id/versions', async (request, reply) => {
    const { model_id } = request.params as { model_id: string };
    const result = await listModelVersions(db, request.user, model_id, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.post('/api/v1/models/:model_id/versions', { config: { bodySchema: 'ModelVersionCreateRequest' } }, async (request, reply) => {
    const { model_id } = request.params as { model_id: string };
    const result = await createModelVersion(
      db,
      request.user,
      model_id,
      request.body as ModelVersionCreateRequest,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, {
      status: 201,
      rowVersion: result.rowVersion,
      location: `/api/v1/model-versions/${result.payload.model_version_id}`,
    });
  });

  app.get('/api/v1/model-versions/:model_version_id', async (request, reply) => {
    const { model_version_id } = request.params as { model_version_id: string };
    const result = await getModelVersion(db, request.user, model_version_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.patch('/api/v1/model-versions/:model_version_id', { config: { bodySchema: 'ModelVersionUpdateRequest' } }, async (request, reply) => {
    const { model_version_id } = request.params as { model_version_id: string };
    const expected = requireIfMatch(request);
    const result = await updateModelVersion(
      db,
      request.user,
      model_version_id,
      request.body as ModelVersionUpdateRequest,
      expected,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.post('/api/v1/model-versions/:model_version_id/validate', async (request, reply) => {
    const { model_version_id } = request.params as { model_version_id: string };
    const result = await validateModelVersion(db, request.user, model_version_id, requestContext(request));
    return sendPayload(reply, result);
  });

  app.post('/api/v1/model-versions/:model_version_id/publish', async (request, reply) => {
    const { model_version_id } = request.params as { model_version_id: string };
    const expected = requireIfMatch(request);
    const result = await runIdempotent(
      db,
      request,
      `model_version:${model_version_id}:publish`,
      config.idempotencyTtlHours,
      async () => {
        const published = await publishModelVersion(db, request.user, model_version_id, expected, requestContext(request));
        return { status: 202, payload: published.payload };
      }
    );
    const payload = result.payload as { model_version?: { etag?: string } };
    if (payload.model_version?.etag) reply.header('ETag', payload.model_version.etag);
    reply.header('Location', `/api/v1/model-versions/${model_version_id}`);
    return reply.code(result.status).send(payload);
  });
}
