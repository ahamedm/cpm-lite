import type { FastifyInstance } from 'fastify';
import type { ModelPreviewRequest } from '../contracts.js';
import { previewModelSources } from '../services/model-sources.js';
import { sendPayload, type RouteDeps } from './helpers.js';

export function registerModelingRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/v1/model-sources', async (request, reply) => {
    const sources = await previewModelSources(deps.analytics, request.user);
    return sendPayload(reply, {
      data: sources,
      page_info: { has_more: false, next_cursor: null },
    });
  });

  app.post(
    '/api/v1/model-preview',
    { config: { bodySchema: 'ModelPreviewRequest' } },
    async (request, reply) => {
      const preview = await deps.analytics.preview(request.user, request.body as ModelPreviewRequest);
      return sendPayload(reply, preview);
    }
  );
}
