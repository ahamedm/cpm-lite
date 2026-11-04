import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  analyticsDbPath: string;
  jwtSecret: string;
  jwtIssuer: string | null;
  serviceToken: string | null;
  corsOrigins: string[];
  engineVersion: string;
  datasetSnapshot: string;
  maxJobAttempts: number;
  idempotencyTtlHours: number;
  logLevel: string;
  cubeRefreshEnabled: boolean;
  cubeRefreshPollMs: number;
  cubeRefreshMaxAttempts: number;
  cubeSchemaStore: 'file' | 'valkey';
  cubeSchemaDir: string;
  cubePromotedManifestPath: string;
  valkeyUrl: string | null;
  valkeyKeyPrefix: string;
  valkeySchemaTtlSeconds: number;
  cubeUrl: string | null;
  cubeApiSecret: string | null;
}

export function findRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, 'db', 'migrations'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function envOptional(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? raw.trim() : null;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function resolveCubeSchemaDir(override?: string): string {
  const repoRoot = findRepoRoot();
  const rawPath = override ?? process.env.CPM_CUBE_SCHEMA_DIR ?? 'data/cube-schema';
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
}

export function resolvePromotedManifestPath(override?: string): string {
  const repoRoot = findRepoRoot();
  const rawPath = override ?? process.env.CPM_CUBE_PROMOTED_MANIFEST ?? 'cube/model/promoted-models.json';
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
}

export function resolveDbPath(override?: string): string {
  const repoRoot = findRepoRoot();
  const rawDbPath = override ?? process.env.CPM_OLTP_DUCKDB_PATH ?? 'data/cpm_lite_oltp.duckdb';
  return path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(repoRoot, rawDbPath);
}

export function resolveAnalyticsPath(override?: string): string {
  const repoRoot = findRepoRoot();
  const rawPath = override ?? process.env.CPM_ANALYTICS_DUCKDB_PATH ?? 'data/cpm_lite_preview.duckdb';
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const jwtSecret = overrides.jwtSecret ?? process.env.CPM_API_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('CPM_API_JWT_SECRET is required (copy apps/api/.env.example to apps/api/.env)');
  }

  const dbPath = resolveDbPath(overrides.dbPath);
  const analyticsDbPath = resolveAnalyticsPath(overrides.analyticsDbPath);
  const cubeSchemaDir = resolveCubeSchemaDir(overrides.cubeSchemaDir);
  const cubePromotedManifestPath = resolvePromotedManifestPath(overrides.cubePromotedManifestPath);

  const cubeSchemaStore = (overrides.cubeSchemaStore ?? process.env.CPM_CUBE_SCHEMA_STORE ?? 'file')
    .trim()
    .toLowerCase();
  if (cubeSchemaStore !== 'file' && cubeSchemaStore !== 'valkey') {
    throw new Error('CPM_CUBE_SCHEMA_STORE must be "file" or "valkey"');
  }
  const valkeyUrl = overrides.valkeyUrl !== undefined ? overrides.valkeyUrl : envOptional('CPM_VALKEY_URL');
  if (cubeSchemaStore === 'valkey' && !valkeyUrl) {
    throw new Error('CPM_VALKEY_URL is required when CPM_CUBE_SCHEMA_STORE=valkey');
  }

  const corsOrigins = overrides.corsOrigins ?? (process.env.CPM_API_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    host: overrides.host ?? process.env.CPM_API_HOST ?? '0.0.0.0',
    port: overrides.port ?? envInt('CPM_API_PORT', 8080),
    dbPath,
    analyticsDbPath,
    jwtSecret,
    jwtIssuer: overrides.jwtIssuer !== undefined ? overrides.jwtIssuer : (process.env.CPM_API_JWT_ISSUER ?? null),
    serviceToken: overrides.serviceToken ?? process.env.CPM_API_SERVICE_TOKEN ?? null,
    corsOrigins,
    engineVersion: overrides.engineVersion ?? process.env.CPM_API_ENGINE_VERSION ?? '0.1.0',
    datasetSnapshot: overrides.datasetSnapshot ?? process.env.CPM_API_DATASET_SNAPSHOT ?? 'gold:current',
    maxJobAttempts: overrides.maxJobAttempts ?? envInt('CPM_API_MAX_JOB_ATTEMPTS', 3),
    idempotencyTtlHours: overrides.idempotencyTtlHours ?? envInt('CPM_API_IDEMPOTENCY_TTL_HOURS', 168),
    logLevel: overrides.logLevel ?? process.env.LOG_LEVEL ?? 'info',
    cubeRefreshEnabled: overrides.cubeRefreshEnabled ?? envBool('CPM_CUBE_REFRESH_ENABLED', true),
    cubeRefreshPollMs: overrides.cubeRefreshPollMs ?? envInt('CPM_CUBE_REFRESH_POLL_MS', 5_000),
    cubeRefreshMaxAttempts: overrides.cubeRefreshMaxAttempts ?? envInt('CPM_CUBE_REFRESH_MAX_ATTEMPTS', 5),
    cubeSchemaStore,
    cubeSchemaDir,
    cubePromotedManifestPath,
    valkeyUrl,
    valkeyKeyPrefix: overrides.valkeyKeyPrefix ?? process.env.CPM_VALKEY_KEY_PREFIX ?? 'cpm:cube-schema',
    valkeySchemaTtlSeconds:
      overrides.valkeySchemaTtlSeconds ?? envNonNegativeInt('CPM_VALKEY_SCHEMA_TTL_SECONDS', 0),
    cubeUrl: overrides.cubeUrl !== undefined ? overrides.cubeUrl : (envOptional('CPM_CUBE_URL') ?? 'http://localhost:4000'),
    cubeApiSecret: overrides.cubeApiSecret !== undefined ? overrides.cubeApiSecret : envOptional('CPM_CUBE_API_SECRET'),
  };
}
