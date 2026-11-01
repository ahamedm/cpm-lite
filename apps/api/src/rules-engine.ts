import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { safeJson } from './http.js';
import type { Database, RuleVersionTable } from './schema.js';
import type { Selectable } from 'kysely';

type RuleVersionRow = Selectable<RuleVersionTable>;

export interface ResolvedRule extends RuleVersionRow {
  rule_code: string;
}

export interface RuleEvaluation {
  valid: boolean;
  issues: Array<{
    severity: 'error' | 'warning' | 'info';
    path: string;
    code: string;
    message: string;
  }>;
  outcomes: Array<{
    rule_version_id: string;
    rule_code: string;
    evaluation_point: string;
    decision: 'allow' | 'warn' | 'reject';
    message: string | null;
  }>;
  resolved_rules: Array<{
    rule_version_id: string;
    rule_code: string;
    version_number: number;
  }>;
}

export async function resolveRules(
  db: Kysely<Database>,
  filters: {
    evaluationPoint: string;
    departmentCode: string;
    costCentreCode: string | null;
    scenarioType: string;
    onDate: string;
  }
): Promise<ResolvedRule[]> {
  const result = await sql<ResolvedRule>`
    SELECT rv.*, r.code AS rule_code
    FROM rule_version rv
    JOIN rule r ON r.rule_id = rv.rule_id
    WHERE rv.status = 'active'
      AND r.status = 'active'
      AND rv.evaluation_point = ${filters.evaluationPoint}
      AND rv.effective_from <= ${filters.onDate}::DATE
      AND (rv.effective_to IS NULL OR rv.effective_to > ${filters.onDate}::DATE)
      AND EXISTS (
        SELECT 1
        FROM rule_scope rs
        WHERE rs.rule_version_id = rv.rule_version_id
          AND (
            rs.scope_type = 'global'
            OR (rs.scope_type = 'department' AND rs.scope_id = ${filters.departmentCode})
            OR (rs.scope_type = 'cost_centre' AND rs.scope_id = ${filters.costCentreCode ?? ''})
            OR (rs.scope_type = 'scenario_type' AND rs.scope_id = ${filters.scenarioType})
          )
      )
    ORDER BY rv.priority DESC, rv.rule_version_id ASC
  `.execute(db);

  return result.rows;
}

function monthsBetween(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  return (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + (endDate.getUTCMonth() - startDate.getUTCMonth()) + 1;
}

export async function evaluateValidationRules(
  db: Kysely<Database>,
  scenario: {
    departmentCode: string;
    costCentreCode: string | null;
    scenarioType: string;
    periodStart: string;
    periodEnd: string;
    drivers: Array<{ driver_code?: string }>;
  }
): Promise<RuleEvaluation> {
  const rules = await resolveRules(db, {
    evaluationPoint: 'pre_submit',
    departmentCode: scenario.departmentCode,
    costCentreCode: scenario.costCentreCode,
    scenarioType: scenario.scenarioType,
    onDate: new Date().toISOString().slice(0, 10),
  });

  const issues: RuleEvaluation['issues'] = [];
  const outcomes: RuleEvaluation['outcomes'] = [];

  for (const rule of rules) {
    const definition = safeJson<Record<string, unknown>>(rule.definition, {});
    const parameters = (definition.parameters ?? {}) as Record<string, unknown>;
    let decision: 'allow' | 'warn' | 'reject' = 'allow';
    let message: string | null = null;

    if (definition.kind === 'validation') {
      const requiredDrivers = Array.isArray(parameters.required_driver_codes)
        ? parameters.required_driver_codes.filter((value): value is string => typeof value === 'string')
        : [];
      const presentDrivers = new Set(scenario.drivers.map((driver) => driver.driver_code));
      const missing = requiredDrivers.filter((code) => !presentDrivers.has(code));
      if (missing.length > 0) {
        decision = 'reject';
        message = `Missing required drivers: ${missing.join(', ')}`;
      }

      if (typeof parameters.min_driver_count === 'number' && scenario.drivers.length < parameters.min_driver_count) {
        decision = 'reject';
        message = `At least ${parameters.min_driver_count} drivers are required`;
      }

      if (typeof parameters.max_period_months === 'number') {
        const months = monthsBetween(scenario.periodStart, scenario.periodEnd);
        if (months > parameters.max_period_months) {
          decision = 'reject';
          message = `Period covers ${months} months; maximum is ${parameters.max_period_months}`;
        }
      }
    }

    if (decision === 'reject') {
      issues.push({
        severity: 'error',
        path: '/',
        code: rule.rule_code,
        message: message ?? `Rule ${rule.rule_code} rejected the scenario`,
      });
    } else if ((decision as string) === 'warn') {
      issues.push({
        severity: 'warning',
        path: '/',
        code: rule.rule_code,
        message: message ?? `Rule ${rule.rule_code} produced a warning`,
      });
    }

    outcomes.push({
      rule_version_id: rule.rule_version_id,
      rule_code: rule.rule_code,
      evaluation_point: rule.evaluation_point,
      decision,
      message,
    });
  }

  return { valid: !issues.some((issue) => issue.severity === 'error'), issues, outcomes, resolved_rules: rules.map((rule) => ({ rule_version_id: rule.rule_version_id, rule_code: rule.rule_code, version_number: rule.version_number })) };
}

export async function evaluatePromotionRules(
  db: Kysely<Database>,
  scenario: {
    departmentCode: string;
    costCentreCode: string | null;
    scenarioType: string;
  }
): Promise<RuleEvaluation> {
  const rules = await resolveRules(db, {
    evaluationPoint: 'promotion',
    departmentCode: scenario.departmentCode,
    costCentreCode: scenario.costCentreCode,
    scenarioType: scenario.scenarioType,
    onDate: new Date().toISOString().slice(0, 10),
  });

  return {
    valid: true,
    issues: [],
    outcomes: rules.map((rule) => ({
      rule_version_id: rule.rule_version_id,
      rule_code: rule.rule_code,
      evaluation_point: rule.evaluation_point,
      decision: 'allow' as const,
      message: null,
    })),
    resolved_rules: rules.map((rule) => ({
      rule_version_id: rule.rule_version_id,
      rule_code: rule.rule_code,
      version_number: rule.version_number,
    })),
  };
}
