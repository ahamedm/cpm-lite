#!/usr/bin/env node
/**
 * Dependency currency + supply-chain check for CPM Lite.
 *
 * Why this exists: model/training-cutoff knowledge of "current" package
 * versions is unreliable. This script derives the answer from the npm registry
 * and from `npm audit` on the committed lockfiles instead of memory.
 *
 * It does three things:
 *   1. compares every declared direct dependency against the npm `latest`
 *      dist-tag for each workspace;
 *   2. runs `npm audit --package-lock-only` for each workspace;
 *   3. fails on critical advisories, on high advisories that are not recorded
 *      in security/npm-audit-baseline.json, on expired exceptions, and on any
 *      `@cubejs-backend/*` package below 1.0.0 (the 0.22.x downgrade trap).
 *
 * Requires network access (npm registry). It is intentionally NOT part of
 * `make test`, because tests must not depend on the public internet.
 *
 * Usage: node scripts/check-dependencies.mjs [--offline]
 *   --offline  skip registry/audit network calls and only run local guards
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';
const BASELINE_FILE = path.join(ROOT, 'security', 'npm-audit-baseline.json');
const OFFLINE = process.argv.includes('--offline');

const WORKSPACES = [
  { name: 'cube', dir: 'cube' },
  { name: 'api', dir: 'apps/api' },
  { name: 'web', dir: 'apps/web' },
  { name: 'contracts', dir: 'packages/contracts' },
];

const failures = [];
const warnings = [];
const acceptedSeen = new Set();

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function extractVersion(range) {
  const match = String(range).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

function describeGap(declaredRange, latest) {
  const declared = extractVersion(declaredRange);
  if (!declared || !latest) return { status: 'unknown', major: false };
  const left = parseVersion(declared);
  const right = parseVersion(latest);
  if (!left || !right) return { status: 'unknown', major: false };
  if (
    left.major === right.major &&
    left.minor === right.minor &&
    left.patch === right.patch
  ) {
    return { status: 'current', major: false };
  }
  if (compareVersions(declared, latest) > 0) {
    return { status: 'ahead of latest', major: false };
  }
  if (left.major !== right.major) {
    return { status: `MAJOR behind (${right.major - left.major})`, major: true };
  }
  if (left.minor !== right.minor) {
    return { status: `minor behind (${right.minor - left.minor})`, major: false };
  }
  return { status: `patch behind (${right.patch - left.patch})`, major: false };
}

async function fetchLatest(pkg) {
  const url = `${REGISTRY}/${pkg.replace('/', '%2F')}/latest`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${pkg}: registry responded ${response.status}`);
  const body = await response.json();
  return body.version;
}

function runAudit(dir) {
  const npm = process.env.NPM || 'npm';
  const result = spawnSync(npm, ['audit', '--package-lock-only', '--json'], {
    cwd: path.join(ROOT, dir),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    return { error: (result.stderr || `npm audit exited ${result.status}`).trim() };
  }
  try {
    return JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch (error) {
    return { error: `could not parse npm audit output: ${error.message}` };
  }
}

function collectDeclared(manifest) {
  const declared = [];
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [pkg, range] of Object.entries(manifest[section] || {})) {
      declared.push({ pkg, range, section });
    }
  }
  return declared.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

function checkCubeLock(workspace, lock) {
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    if (!key.includes('@cubejs-backend/')) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!name.startsWith('@cubejs-backend/')) continue;
    const version = parseVersion(meta.version || '');
    if (version && version.major === 0) {
      failures.push(
        `${workspace}: ${name}@${meta.version} is pre-1.0; Cube 0.x is the ` +
          '`npm audit fix` downgrade trap and cannot read DuckDB 2.0 files',
      );
    }
  }
}

function loadBaseline() {
  try {
    return readJson(BASELINE_FILE, 'npm audit baseline');
  } catch (error) {
    if (OFFLINE) return { accepted: [] };
    warnings.push(`${error.message}; no high-severity exceptions will be accepted`);
    return { accepted: [] };
  }
}

async function main() {
  const baseline = loadBaseline();
  const today = new Date().toISOString().slice(0, 10);
  const acceptedByKey = new Map();
  for (const entry of baseline.accepted || []) {
    acceptedByKey.set(`${entry.workspace}\u0000${entry.package}`, entry);
    if (entry.reviewBy && entry.reviewBy < today) {
      failures.push(
        `security baseline entry for ${entry.workspace}/${entry.package} expired on ` +
          `${entry.reviewBy}; re-check upstream and renew or remove it`,
      );
    }
  }

  console.log(`CPM Lite dependency check — ${today}${OFFLINE ? ' (offline: registry/audit skipped)' : ''}\n`);

  let currentCount = 0;
  let behindCount = 0;
  const majorBehind = [];

  for (const workspace of WORKSPACES) {
    const manifest = readJson(path.join(ROOT, workspace.dir, 'package.json'), `${workspace.name} package.json`);
    const lock = readJson(path.join(ROOT, workspace.dir, 'package-lock.json'), `${workspace.name} package-lock.json`);
    checkCubeLock(workspace.name, lock);

    const declared = collectDeclared(manifest);
    if (!OFFLINE) {
      const rows = [];
      for (const dep of declared) {
        try {
          const latest = await fetchLatest(dep.pkg);
          const gap = describeGap(dep.range, latest);
          rows.push({ ...dep, latest, ...gap });
        } catch (error) {
          rows.push({ ...dep, latest: '-', status: `registry error: ${error.message}`, major: false });
          failures.push(`${workspace.name}: could not verify latest version for ${dep.pkg}`);
        }
      }
      console.log(`workspace: ${workspace.name} (${workspace.dir})`);
      for (const row of rows) {
        if (row.status === 'current') currentCount += 1;
        else if (row.status !== 'ahead of latest') {
          behindCount += 1;
          if (row.major) majorBehind.push(`${workspace.name}/${row.pkg} ${row.range} -> ${row.latest}`);
        }
        console.log(
          `  ${row.pkg.padEnd(34)} ${row.range.padEnd(12)} -> ${String(row.latest).padEnd(12)} ${row.status}`,
        );
      }
      console.log('');
    }

    if (OFFLINE) continue;

    const audit = runAudit(workspace.dir);
    if (audit.error) {
      failures.push(`${workspace.name}: npm audit failed — ${audit.error}`);
      continue;
    }
    const meta = audit.metadata?.vulnerabilities || {};
    console.log(
      `npm audit: ${workspace.name} — ${meta.total || 0} findings ` +
        `(critical ${meta.critical || 0}, high ${meta.high || 0}, ` +
        `moderate ${meta.moderate || 0}, low ${meta.low || 0})`,
    );

    for (const [pkg, finding] of Object.entries(audit.vulnerabilities || {})) {
      if (finding.severity === 'critical') {
        failures.push(`${workspace.name}: CRITICAL advisory for ${pkg} (${finding.range})`);
        continue;
      }
      if (finding.severity !== 'high') continue;
      const key = `${workspace.name}\u0000${pkg}`;
      const exception = acceptedByKey.get(key);
      if (!exception) {
        failures.push(
          `${workspace.name}: new HIGH advisory for ${pkg} (${finding.range}); ` +
            'upgrade to a fixed version or add a reviewed exception to security/npm-audit-baseline.json',
        );
      } else {
        acceptedSeen.add(key);
        console.log(`  accepted high: ${pkg} — ${exception.reason}`);
      }
    }
    console.log('');
  }

  if (acceptedByKey.size > 0) {
    for (const [key, entry] of acceptedByKey) {
      if (!acceptedSeen.has(key) && !OFFLINE) {
        warnings.push(
          `security baseline entry for ${entry.workspace}/${entry.package} no longer matches an ` +
            'open high advisory; remove it so the baseline stays accurate',
        );
      }
    }
  }

  if (behindCount > 0) {
    console.log(
      `Currency: ${currentCount} current, ${behindCount} behind latest.` +
        (majorBehind.length > 0 ? ` Major upgrades pending: ${majorBehind.join('; ')}.` : ''),
    );
    console.log('Patch/minor drift should be closed; majors need an explicit decision (see AGENTS.md).\n');
  } else if (!OFFLINE) {
    console.log(`Currency: all ${currentCount} declared dependencies are current.\n`);
  }

  if (warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of warnings) console.log(`  - ${warning}`);
    console.log('');
  }

  if (failures.length > 0) {
    console.error('FAILED dependency check:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Dependency check passed.');
  }
}

main().catch((error) => {
  console.error(`Dependency check could not run: ${error.message}`);
  process.exitCode = 1;
});
