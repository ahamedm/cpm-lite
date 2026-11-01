import 'dotenv/config';
import { signToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const args = process.argv.slice(2);
const valueFor = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const role = (valueFor('--role') ?? 'business_user').toLowerCase();
const department = valueFor('--department')?.toLowerCase() ?? null;
if (role !== 'steward' && role !== 'admin' && !department) {
  console.error('A --department is required for business_user tokens');
  process.exit(1);
}

const token = signToken(config.jwtSecret, {
  subject: valueFor('--subject') ?? `dev-${role}${department ? `-${department}` : ''}`,
  role,
  departmentCode: department,
  costCentreCodes: valueFor('--cost-centre') ? [valueFor('--cost-centre')!] : [],
  issuer: config.jwtIssuer,
  expiresIn: '8h',
});

console.log(token);
