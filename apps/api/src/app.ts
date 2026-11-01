import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ApiError, notFound, problemBody, unauthorized } from './errors.js';
import { authenticateRequest, type AuthUser } from './auth.js';
import { loadValidationBundle, validateBody, type ValidationBundle } from './validation.js';
import { correlationId as getCorrelationId } from './http.js';
import { findRepoRoot, loadConfig, type AppConfig } from './config.js';
import { createDatabase } from './db.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerModelRoutes } from './routes/models.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerWorkflowRoutes } from './routes/workflow.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerReferenceRoutes } from './routes/reference.js';
import { registerInternalRoutes } from './routes/internal.js';
import type { Database } from './schema.js';
import type { Kysely } from 'kysely';

export interface BuildAppResult {
  app: import('fastify').FastifyInstance;
  config: AppConfig;
}

function isPublicRequest(url: string): boolean {
  return (
    url === '/healthz' ||
    url === '/readyz' ||
    url === '/api/v1/openapi.json' ||
    url.startsWith('/docs') ||
    url.startsWith('/internal/')
  );
}

export async function buildApp(overrides: Partial<AppConfig> = {}): Promise<BuildAppResult> {
  const { default: Fastify } = await import('fastify');
  const { default: cors } = await import('@fastify/cors');
  const { default: swagger } = await import('@fastify/swagger');
  const { default: swaggerUi } = await import('@fastify/swagger-ui');

  const config = loadConfig(overrides);
  const handle = await createDatabase(config.dbPath);
  const specPath = path.join(findRepoRoot(), 'packages', 'contracts', 'openapi', 'thin-orchestrator.v1.yaml');
  if (!existsSync(specPath)) {
    throw new Error(`OpenAPI contract not found at ${specPath}`);
  }
  const validation: ValidationBundle = await loadValidationBundle(specPath);

  const app = Fastify({ logger: { level: config.logLevel } });
  app.decorateRequest('user', null as unknown as AuthUser);
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = getCorrelationId(request);
    reply.header('X-Correlation-Id', request.correlationId);
  });

  app.addHook('preHandler', async (request) => {
    if (request.method === 'OPTIONS') return;
    if (isPublicRequest(request.url)) return;
    request.user = authenticateRequest(request.headers.authorization, config);
  });

  app.addHook('preValidation', async (request) => {
    const routeConfig = (request.routeOptions.config ?? {}) as { bodySchema?: string; bodyOptional?: boolean };
    if (!routeConfig.bodySchema) return;
    if (request.body === undefined && routeConfig.bodyOptional) return;
    validateBody(validation, routeConfig.bodySchema, request.body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.status)
        .type('application/problem+json')
        .send(problemBody(error, request.correlationId ?? getCorrelationId(request)));
    }

    const statusCode = typeof (error as { statusCode?: number }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    if (statusCode === 401) {
      const authError = unauthorized();
      return reply.code(401).type('application/problem+json').send(problemBody(authError, request.correlationId));
    }
    if (statusCode === 400) {
      return reply.code(400).type('application/problem+json').send(
        problemBody(
          new ApiError(400, 'invalid_request', 'Invalid request', (error as Error).message),
          request.correlationId ?? getCorrelationId(request)
        )
      );
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).type('application/problem+json').send(
        problemBody(
          new ApiError(statusCode, 'request_error', 'Request rejected', (error as Error).message),
          request.correlationId ?? getCorrelationId(request)
        )
      );
    }

    request.log.error({ err: error }, 'Unhandled API error');
    return reply.code(500).type('application/problem+json').send(
      problemBody(new ApiError(500, 'internal_error', 'Internal server error', undefined), request.correlationId ?? getCorrelationId(request))
    );
  });

  app.setNotFoundHandler((request, reply) => {
    const error = notFound('Route');
    return reply
      .code(404)
      .type('application/problem+json')
      .send(problemBody(error, request.correlationId ?? getCorrelationId(request)));
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(swagger, {
    mode: 'static',
    specification: { document: validation.document as never },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  app.get('/api/v1/openapi.json', { config: { public: true } }, async (_request, reply) => {
    return reply.type('application/json').send(validation.document);
  });

  registerHealthRoutes(app, { db: handle.db, config });
  registerReferenceRoutes(app, { db: handle.db, config });
  registerModelRoutes(app, { db: handle.db, config });
  registerScenarioRoutes(app, { db: handle.db, config });
  registerJobRoutes(app, { db: handle.db, config });
  registerWorkflowRoutes(app, { db: handle.db, config });
  registerRuleRoutes(app, { db: handle.db, config });
  registerInternalRoutes(app, { db: handle.db, config });

  app.addHook('onClose', async () => {
    await handle.close();
  });

  return { app, config };
}

export type { Database, Kysely };
