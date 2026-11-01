#!/usr/bin/env node
/**
 * Prints a local development JWT for the Cube API.
 *
 * Production identity is Microsoft Entra ID (AGENTS.md); this HS256 token is
 * only for local development against CUBEJS_API_SECRET.
 *
 * Usage:
 *   npm run token -- --department finance
 *   npm run token -- --role steward
 */
import { createHmac } from 'node:crypto';

const apiSecret = process.env.CUBEJS_API_SECRET;
if (!apiSecret) {
  console.error('CUBEJS_API_SECRET is required');
  process.exit(1);
}

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const role = (valueFor('--role') || 'business_user').toLowerCase();
const department = valueFor('--department')?.toLowerCase();

if (role !== 'steward' && !department) {
  console.error('A --department is required for role business_user');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  sub: `dev-${role}${department ? `-${department}` : ''}`,
  role,
  department_code: department,
  groups: role === 'steward' ? ['steward'] : ['business_user'],
  iat: now,
  exp: now + 60 * 60,
};

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${encode(header)}.${encode(payload)}`;
const signature = createHmac('sha256', apiSecret).update(unsigned).digest('base64url');

console.log(`${unsigned}.${signature}`);
