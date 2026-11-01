import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  jwtSecret: string;
  jwtIssuer: string | null;
  serviceToken: string | null;
  corsOrigins: string[];
  engineVersion: string;
  datasetSnapshot: string;
  maxJobAttempts: number;
  idempotencyTtlHours: number;
  logLevel: string;
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

export function resolveDbPath(override?: string): string {
  const repoRoot = findRepoRoot();
  const rawDbPath = override ?? process.env.CPM_OLTP_DUCKDB_PATH ?? 'data/cpm_lite_oltp.duckdb';
  return path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(repoRoot, rawDbPath);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const jwtSecret = overrides.jwtSecret ?? process.env.CPM_API_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('CPM_API_JWT_SECRET is required (copy apps/api/.env.example to apps/api/.env)');
  }

  const dbPath = resolveDbPath(overrides.dbPath);

  const corsOrigins = overrides.corsOrigins ?? (process.env.CPM_API_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    host: overrides.host ?? process.env.CPM_API_HOST ?? '0.0.0.0',
    port: overrides.port ?? envInt('CPM_API_PORT', 8080),
    dbPath,
    jwtSecret,
    jwtIssuer: overrides.jwtIssuer !== undefined ? overrides.jwtIssuer : (process.env.CPM_API_JWT_ISSUER ?? null),
    serviceToken: overrides.serviceToken ?? process.env.CPM_API_SERVICE_TOKEN ?? null,
    corsOrigins,
    engineVersion: overrides.engineVersion ?? process.env.CPM_API_ENGINE_VERSION ?? '0.1.0',
    datasetSnapshot: overrides.datasetSnapshot ?? process.env.CPM_API_DATASET_SNAPSHOT ?? 'gold:current',
    maxJobAttempts: overrides.maxJobAttempts ?? envInt('CPM_API_MAX_JOB_ATTEMPTS', 3),
    idempotencyTtlHours: overrides.idempotencyTtlHours ?? envInt('CPM_API_IDEMPOTENCY_TTL_HOURS', 168),
    logLevel: overrides.logLevel ?? process.env.LOG_LEVEL ?? 'info',
  };
}
