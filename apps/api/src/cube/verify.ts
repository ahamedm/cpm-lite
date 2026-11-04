/**
 * End-to-end verification of a committed Cube schema snapshot.
 *
 * A refresh only counts as successful when Cube itself compiled the generated
 * schema and answered a query against every generated cube. The worker mints a
 * short-lived steward token with the shared local Cube secret; production
 * identity (Entra ID) will replace this exchange when it lands.
 */

import jwt from 'jsonwebtoken';
import type { AppConfig } from '../config.js';
import type { GeneratedCube } from './schema.js';

export interface CubeVerificationTarget {
  cube_name: string;
  measures: string[];
}

const VERIFY_TIMEOUT_MS = 10_000;

function target(cube: GeneratedCube): CubeVerificationTarget {
  return { cube_name: cube.cube_name, measures: cube.measures };
}

export function verificationTargets(cubes: GeneratedCube[]): CubeVerificationTarget[] {
  return cubes.map(target);
}

export async function verifyCubeSchema(
  config: Pick<AppConfig, 'cubeUrl' | 'cubeApiSecret'>,
  cubes: CubeVerificationTarget[]
): Promise<void> {
  if (!config.cubeUrl) {
    throw new Error('CPM_CUBE_URL is not configured, so the Cube refresh cannot be verified');
  }
  if (!config.cubeApiSecret) {
    throw new Error(
      'CPM_CUBE_API_SECRET is not configured, so the Cube refresh cannot be verified. Set it to the Cube CUBEJS_API_SECRET value.'
    );
  }

  const token = jwt.sign(
    { sub: 'cpm-lite:cube-refresh', role: 'steward', groups: ['steward'] },
    config.cubeApiSecret,
    { algorithm: 'HS256', expiresIn: 120 }
  );
  const baseUrl = config.cubeUrl.replace(/\/+$/, '');

  const metaResponse = await fetch(`${baseUrl}/cubejs-api/v1/meta`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  if (!metaResponse.ok) {
    throw new Error(`Cube meta returned ${metaResponse.status}: ${(await metaResponse.text()).slice(0, 300)}`);
  }
  const meta = (await metaResponse.json()) as { cubes?: Array<{ name?: string }> };
  const loaded = new Set((meta.cubes ?? []).map((cube) => cube.name ?? ''));
  const missing = cubes.map((cube) => cube.cube_name).filter((name) => !loaded.has(name));
  if (missing.length > 0) {
    throw new Error(`Cube did not compile the generated schema; missing cubes: ${missing.join(', ')}`);
  }

  for (const cube of cubes) {
    const measure = cube.measures[0];
    if (!measure) continue;
    const response = await fetch(`${baseUrl}/cubejs-api/v1/load`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: { measures: [`${cube.cube_name}.${measure}`], limit: 1 } }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Cube query for ${cube.cube_name}.${measure} returned ${response.status}: ${(await response.text()).slice(0, 300)}`
      );
    }
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new Error(`Cube query for ${cube.cube_name}.${measure} returned no data rows`);
    }
  }
}
