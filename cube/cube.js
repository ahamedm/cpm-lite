/* eslint-disable no-console */
const path = require('node:path');
const jwt = require('jsonwebtoken');
const DuckDBDriver = require('@cubejs-backend/duckdb-driver');
const { CubejsHandlerError } = require('@cubejs-backend/api-gateway/dist/src/cubejs-handler-error');

const databasePath = process.env.CPM_DUCKDB_PATH || path.resolve(__dirname, '../data/cpm_lite.duckdb');
const apiSecret = process.env.CUBEJS_API_SECRET;

if (!apiSecret) {
  throw new Error(
    'CUBEJS_API_SECRET is required. Copy cube/.env.example to cube/.env and set a local secret.'
  );
}

/**
 * Cube Core semantic layer for CPM Lite.
 *
 * DuckDB 2.0 is the analytical store. Cube's 1.8.x DuckDB driver pins the
 * DuckDB Node API to 1.5.x; package.json overrides it to 2.0.0-r.1 so the
 * driver can read the 2.0 storage format.
 *
 * Authentication uses a local HS256 token for development (see checkAuth).
 * Production identity is Microsoft Entra ID; that integration is an open
 * decision recorded in AGENTS.md. Do not treat the local JWT path as
 * production authentication.
 */
module.exports = {
  telemetry: false,
  scheduledRefreshTimer: false,
  apiSecret,
  // Cube resolves schemaPath with path.join(process.cwd(), schemaPath), so it
  // must stay relative to the process working directory.
  schemaPath: process.env.CUBEJS_SCHEMA_PATH || 'model',

  driverFactory: () => new DuckDBDriver({ databasePath }),

  /**
   * Cube needs an explicit mapping from the request context to policy groups.
   * Tokens are issued by the local dev mint script and, in production, by the
   * identity layer (Entra ID integration is an open decision).
   */
  contextToGroups: (context) =>
    Array.isArray(context?.securityContext?.groups) ? context.securityContext.groups : [],

  /**
   * Local JWT verification. The token is the only source of scope; headers and
   * query parameters are never trusted. Production replaces this HS256 check
   * with Microsoft Entra ID (OIDC/JWKS); that integration is an open decision.
   */
  checkAuth: async (req, token) => {
    if (!token) {
      throw new CubejsHandlerError(403, 'Forbidden', 'Authorization header is required');
    }

    let payload;
    try {
      payload = jwt.verify(token, apiSecret, { algorithms: ['HS256'] });
    } catch (error) {
      throw new CubejsHandlerError(403, 'Forbidden', 'Invalid or expired token', error);
    }

    const rawGroups = Array.isArray(payload.groups) ? payload.groups : [];
    // A steward is never narrowed by a business_user grant.
    const groups = rawGroups.includes('steward')
      ? ['steward']
      : rawGroups.filter((group) => group === 'business_user');
    const isSteward = groups.includes('steward');
    if (!isSteward && !groups.includes('business_user')) {
      throw new CubejsHandlerError(403, 'Forbidden', 'A recognised CPM group is required');
    }
    if (!isSteward && !payload.department_code) {
      throw new CubejsHandlerError(403, 'Forbidden', 'department_code claim is required');
    }

    const securityContext = { ...payload, groups };
    req.securityContext = securityContext;
    return { security_context: securityContext };
  },

  /**
   * Defence in depth on top of the model-level row-level access policies.
   * A token must carry a recognised group and, unless it is a steward, a
   * department_code. The access policy does the actual row filtering.
   */
  queryRewrite: (query, { securityContext }) => {
    const groups = Array.isArray(securityContext?.groups) ? securityContext.groups : [];
    const isSteward = groups.includes('steward');

    if (!isSteward && !groups.includes('business_user')) {
      throw new Error('Forbidden: a recognised CPM group is required');
    }
    if (!isSteward && !securityContext?.department_code) {
      throw new Error('Forbidden: department_code claim is required');
    }

    return query;
  },
};
