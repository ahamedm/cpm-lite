import type { FastifyInstance } from 'fastify';
import type {
  RuleCreateRequest,
  RuleUpdateRequest,
  RuleVersionCreateRequest,
  RuleVersionUpdateRequest,
} from '../contracts.js';
import { requireIfMatch } from '../http.js';
import {
  createRule,
  createRuleVersion,
  getRuleById,
  getRuleVersionById,
  listRuleVersions,
  listRules,
  patchRule,
  publishRuleVersion,
  retireRuleVersion,
  updateRuleVersion,
  validateRuleVersion,
} from '../services/rules.js';
import { requestContext, sendPayload, type RouteDeps } from './helpers.js';

export function registerRuleRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db } = deps;

  app.get('/api/v1/rules', async (request, reply) => {
    const result = await listRules(db, request.user, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.post('/api/v1/rules', { config: { bodySchema: 'RuleCreateRequest' } }, async (request, reply) => {
    const result = await createRule(db, request.user, request.body as RuleCreateRequest, requestContext(request));
    return sendPayload(reply, result.payload, {
      status: 201,
      rowVersion: result.rowVersion,
      location: `/api/v1/rules/${result.payload.rule_id}`,
    });
  });

  app.get('/api/v1/rules/:rule_id', async (request, reply) => {
    const { rule_id } = request.params as { rule_id: string };
    const result = await getRuleById(db, rule_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.patch('/api/v1/rules/:rule_id', { config: { bodySchema: 'RuleUpdateRequest' } }, async (request, reply) => {
    const { rule_id } = request.params as { rule_id: string };
    const expected = requireIfMatch(request);
    const result = await patchRule(db, request.user, rule_id, request.body as RuleUpdateRequest, expected, requestContext(request));
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.get('/api/v1/rules/:rule_id/versions', async (request, reply) => {
    const { rule_id } = request.params as { rule_id: string };
    const result = await listRuleVersions(db, rule_id, request.query as Record<string, string | undefined>);
    return sendPayload(reply, result);
  });

  app.post('/api/v1/rules/:rule_id/versions', { config: { bodySchema: 'RuleVersionCreateRequest' } }, async (request, reply) => {
    const { rule_id } = request.params as { rule_id: string };
    const result = await createRuleVersion(
      db,
      request.user,
      rule_id,
      request.body as RuleVersionCreateRequest,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, {
      status: 201,
      rowVersion: result.rowVersion,
      location: `/api/v1/rule-versions/${result.payload.rule_version_id}`,
    });
  });

  app.get('/api/v1/rule-versions/:rule_version_id', async (request, reply) => {
    const { rule_version_id } = request.params as { rule_version_id: string };
    const result = await getRuleVersionById(db, rule_version_id);
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.patch('/api/v1/rule-versions/:rule_version_id', { config: { bodySchema: 'RuleVersionUpdateRequest' } }, async (request, reply) => {
    const { rule_version_id } = request.params as { rule_version_id: string };
    const expected = requireIfMatch(request);
    const result = await updateRuleVersion(
      db,
      request.user,
      rule_version_id,
      request.body as RuleVersionUpdateRequest,
      expected,
      requestContext(request)
    );
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.post('/api/v1/rule-versions/:rule_version_id/validate', async (request, reply) => {
    const { rule_version_id } = request.params as { rule_version_id: string };
    const result = await validateRuleVersion(db, request.user, rule_version_id, requestContext(request));
    return sendPayload(reply, result);
  });

  app.post('/api/v1/rule-versions/:rule_version_id/publish', async (request, reply) => {
    const { rule_version_id } = request.params as { rule_version_id: string };
    const expected = requireIfMatch(request);
    const result = await publishRuleVersion(db, request.user, rule_version_id, expected, requestContext(request));
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });

  app.post('/api/v1/rule-versions/:rule_version_id/retire', async (request, reply) => {
    const { rule_version_id } = request.params as { rule_version_id: string };
    const expected = requireIfMatch(request);
    const result = await retireRuleVersion(db, request.user, rule_version_id, expected, requestContext(request));
    return sendPayload(reply, result.payload, { rowVersion: result.rowVersion });
  });
}
