import type { Kysely } from 'kysely';
import type { AuthUser } from '../auth.js';
import { canReadDepartment } from '../auth.js';
import { pageInfo, parseLimit, parseOffsetCursor } from '../http.js';
import type { Database } from '../schema.js';

type ListQuery = Record<string, string | undefined>;

export function getMe(user: AuthUser) {
  return {
    subject: user.subject,
    display_name: user.displayName,
    email: null,
    department_code: user.departmentCode,
    cost_centre_codes: user.costCentreCodes,
    roles: user.roles,
    groups: user.groups,
  };
}

export async function listDepartments(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  let builder = db.selectFrom('department').selectAll();
  if (!user.isSteward) builder = builder.where('department_code', '=', user.departmentCode ?? '');
  if (query.q) builder = builder.where('department_name', 'ilike', `%${query.q}%`);

  const rows = await builder
    .orderBy('department_name')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return {
    data: rows.slice(0, limit).map((row) => ({
      department_code: row.department_code,
      department_name: row.department_name,
    })),
    page_info: pageInfo(offset, limit, rows.length),
  };
}

export async function listCostCentres(db: Kysely<Database>, user: AuthUser, query: ListQuery) {
  const limit = parseLimit({ query } as never);
  const offset = parseOffsetCursor({ query } as never);
  let builder = db.selectFrom('cost_centre').selectAll();
  if (!user.isSteward) builder = builder.where('department_code', '=', user.departmentCode ?? '');
  if (query.department_code) {
    if (!canReadDepartment(user, query.department_code)) {
      return { data: [], page_info: { has_more: false, next_cursor: null } };
    }
    builder = builder.where('department_code', '=', query.department_code);
  }
  if (query.q) builder = builder.where('cost_centre_name', 'ilike', `%${query.q}%`);

  const rows = await builder
    .orderBy('cost_centre_name')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return {
    data: rows.slice(0, limit).map((row) => ({
      cost_centre_code: row.cost_centre_code,
      department_code: row.department_code,
      cost_centre_name: row.cost_centre_name,
    })),
    page_info: pageInfo(offset, limit, rows.length),
  };
}
