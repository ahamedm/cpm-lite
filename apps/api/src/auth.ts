import jwt from 'jsonwebtoken';
import { forbidden, unauthorized } from './errors.js';
import type { AppConfig } from './config.js';

export interface AuthUser {
  subject: string;
  displayName: string;
  departmentCode: string | null;
  costCentreCodes: string[];
  roles: string[];
  groups: string[];
  isSteward: boolean;
}

interface TokenPayload extends jwt.JwtPayload {
  sub?: string;
  name?: string;
  department_code?: string | null;
  cost_centre_codes?: string[];
  roles?: string[];
  groups?: string[];
}

export function authenticateRequest(authorization: string | undefined, config: AppConfig): AuthUser {
  if (!authorization?.startsWith('Bearer ')) {
    throw unauthorized();
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw unauthorized();

  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      ...(config.jwtIssuer ? { issuer: config.jwtIssuer } : {}),
    }) as TokenPayload;
  } catch {
    throw unauthorized('Invalid or expired bearer token');
  }

  if (!payload.sub) throw unauthorized('Token is missing the sub claim');

  const rawRoles = [...(payload.roles ?? []), ...(payload.groups ?? [])];
  const roles = [...new Set(rawRoles.filter((role) => typeof role === 'string'))];
  const isSteward = roles.includes('steward') || roles.includes('admin');
  const departmentCode = payload.department_code ?? null;

  if (!isSteward && !departmentCode) {
    throw forbidden('department_code claim is required for non-steward tokens');
  }

  return {
    subject: payload.sub,
    displayName: payload.name ?? payload.sub,
    departmentCode,
    costCentreCodes: Array.isArray(payload.cost_centre_codes) ? payload.cost_centre_codes : [],
    roles,
    groups: Array.isArray(payload.groups) ? payload.groups : [],
    isSteward,
  };
}

export function signToken(
  secret: string,
  options: {
    subject: string;
    role: string;
    departmentCode?: string | null;
    costCentreCodes?: string[];
    name?: string;
    issuer?: string | null;
    expiresIn?: string;
  }
): string {
  const roles = options.role === 'steward' || options.role === 'admin'
    ? [options.role]
    : [options.role];
  const payload: Record<string, unknown> = {
    sub: options.subject,
    name: options.name ?? options.subject,
    role: options.role,
    roles,
    groups: roles,
    department_code: options.departmentCode ?? null,
    cost_centre_codes: options.costCentreCodes ?? [],
  };
  if (options.issuer) payload.iss = options.issuer;
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: (options.expiresIn ?? '1h') as jwt.SignOptions['expiresIn'] });
}

export function canReadDepartment(user: AuthUser, departmentCode: string): boolean {
  return user.isSteward || user.departmentCode === departmentCode;
}

export function assertDepartmentRead(user: AuthUser, departmentCode: string): void {
  if (!canReadDepartment(user, departmentCode)) throw forbidden();
}

export function assertDepartmentWrite(user: AuthUser, departmentCode: string): void {
  if (!canReadDepartment(user, departmentCode)) throw forbidden();
}

export function assertCostCentre(user: AuthUser, costCentreCode: string | null | undefined): void {
  if (!costCentreCode || user.isSteward) return;
  if (!user.costCentreCodes.includes(costCentreCode)) {
    throw forbidden('cost centre is outside the token scope');
  }
}

export function requireSteward(user: AuthUser): void {
  if (!user.isSteward) throw forbidden('steward role is required');
}
