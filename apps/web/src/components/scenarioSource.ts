import type {
  CalculationPlan,
  CalculationPlanStage,
  CalculationSource,
  ScenarioVersion,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Render a canonical expression as the PRQL subset the authoring compiler accepts. */
function expressionToPrql(expression: unknown): string {
  if (!isRecord(expression)) return '0';
  if (typeof expression.column === 'string') return expression.column;
  if (typeof expression.param === 'string') return expression.param;
  if ('value' in expression) {
    const value = String(expression.value);
    if (expression.type === 'string') return JSON.stringify(value);
    if (expression.type === 'date') return `@${value}`;
    return value;
  }

  const op = String(expression.op ?? '');
  const args = Array.isArray(expression.args) ? expression.args : [];
  const rendered = args.map(expressionToPrql);

  switch (op) {
    case 'add':
      return rendered.join(' + ');
    case 'subtract':
      return rendered.join(' - ');
    case 'multiply':
      return rendered.join(' * ');
    case 'divide':
      return `(${rendered[0] ?? '0'} / ${rendered[1] ?? '0'})`;
    case 'and':
      return rendered.map((item) => `(${item})`).join(' && ');
    case 'or':
      return rendered.map((item) => `(${item})`).join(' || ');
    case 'not':
      return `!(${rendered[0] ?? '0'})`;
    case 'eq':
      return `(${rendered[0]} == ${rendered[1]})`;
    case 'ne':
      return `(${rendered[0]} != ${rendered[1]})`;
    case 'gt':
      return `(${rendered[0]} > ${rendered[1]})`;
    case 'gte':
      return `(${rendered[0]} >= ${rendered[1]})`;
    case 'lt':
      return `(${rendered[0]} < ${rendered[1]})`;
    case 'lte':
      return `(${rendered[0]} <= ${rendered[1]})`;
    case 'if':
      return `case [${rendered[0]} => ${rendered[1]}, true => ${rendered[2]}]`;
    case 'round':
      return `(math.round ${rendered[1] ?? '2'} ${rendered[0] ?? '0'})`;
    case 'nullif':
      return `(nullif ${rendered[0]} ${rendered[1]})`;
    case 'coalesce':
      return `(coalesce ${rendered.join(' ')})`;
    default:
      return '0';
  }
}

export function stageLabel(stage: CalculationPlanStage): string {
  switch (stage.op) {
    case 'scan':
      return 'Scan';
    case 'filter':
      return 'Filter';
    case 'derive':
      return 'Derive';
    case 'allocate':
      return 'Allocate';
    case 'validate':
      return 'Validate';
    case 'write':
      return 'Write';
    default:
      return stage.op.replace(/_/g, ' ');
  }
}

export function stageDetail(stage: CalculationPlanStage): string {
  switch (stage.op) {
    case 'scan': {
      const source = typeof stage.source === 'string' ? stage.source : null;
      const artifact = typeof stage.artifact === 'string' ? stage.artifact : null;
      return [source, artifact ? `artifact ${artifact}` : null].filter(Boolean).join(' · ') || 'Source';
    }
    case 'filter':
      return 'Predicate applied to source rows';
    case 'derive': {
      const name = typeof stage.name === 'string' ? stage.name : 'measure';
      const type = typeof stage.type === 'string' ? stage.type : '';
      return type ? `${name} · ${type}` : name;
    }
    case 'allocate': {
      const pool = typeof stage.pool === 'string' ? stage.pool : 'pool';
      const basis = typeof stage.basis === 'string' ? stage.basis : 'basis';
      const partition = stringArray(stage.partition_by).join(', ');
      return `${pool} by ${basis}${partition ? ` · ${partition}` : ''}`;
    }
    case 'validate':
      return stringArray(stage.checks).map((check) => check.replace(/_/g, ' ')).join(' · ') || 'Checks';
    case 'write': {
      const format = typeof stage.format === 'string' ? stage.format.toUpperCase() : 'PARQUET';
      const measures = stringArray(stage.measures);
      return `${format} · ${measures.length} measure${measures.length === 1 ? '' : 's'}`;
    }
    default:
      return 'Unsupported stage';
  }
}

function structuredStages(plan: CalculationPlan): CalculationPlanStage[] {
  return plan.stages.filter(
    (stage) => stage.op === 'allocate' || stage.op === 'validate' || stage.op === 'write'
  );
}

function sourceFromPlan(version: ScenarioVersion, plan: CalculationPlan): CalculationSource {
  const scan = plan.stages.find((stage) => stage.op === 'scan');
  const write = plan.stages.find((stage) => stage.op === 'write');
  const filters = plan.stages.filter((stage) => stage.op === 'filter');
  const derives = plan.stages.filter((stage) => stage.op === 'derive');
  const measures = write ? stringArray(write.measures) : [];

  const lines: string[] = [];
  if (scan && typeof scan.source === 'string') lines.push(`from ${scan.source}`);
  for (const filter of filters) lines.push(`filter ${expressionToPrql(filter.predicate)}`);
  for (const derive of derives) {
    const name = typeof derive.name === 'string' ? derive.name : 'derived';
    lines.push(`derive ${name} = ${expressionToPrql(derive.expression)}`);
  }
  if (measures.length) lines.push(`select {${measures.join(', ')}}`);

  return {
    format: 'cpm-calculation-source/0',
    source: scan && typeof scan.source === 'string' ? scan.source : 'gold.fact_financials',
    ...(scan && typeof scan.artifact === 'string' ? { artifact: scan.artifact } : {}),
    columns: scan ? stringArray(scan.columns) : [],
    prql: lines.join('\n'),
    types: Object.fromEntries(
      derives
        .filter((derive) => typeof derive.name === 'string' && typeof derive.type === 'string')
        .map((derive) => [String(derive.name), String(derive.type)])
    ),
    grain: plan.grain,
    pins: plan.pins,
    drivers: plan.drivers ?? {},
    stages: structuredStages(plan),
  };
}

export function authoringSourceFromVersion(version: ScenarioVersion): CalculationSource {
  if (version.calculation_source) return version.calculation_source;
  if (version.calculation_plan) return sourceFromPlan(version, version.calculation_plan);
  return {
    format: 'cpm-calculation-source/0',
    source: 'gold.fact_financials',
    columns: [],
    prql: `from gold.fact_financials
filter period >= @2026-01-01
derive adjusted_budget = budget_amount * (1 + growth_pct)
select {department_code, adjusted_budget}`,
    types: { adjusted_budget: 'decimal(18,2)' },
    grain: [],
    pins: {
      model_version_id: version.model_version_id,
      semantic_hash: '',
      rule_version_ids: [],
    },
    drivers: {},
    stages: [{ op: 'write', format: 'parquet' }],
  };
}

export function settingsJsonFromSource(source: CalculationSource): string {
  const { format: _format, prql: _prql, types: _types, ...settings } = source;
  return JSON.stringify(settings, null, 2);
}

export function buildSource(
  settingsJson: string,
  prql: string,
  types: Array<{ name: string; type: string }>
): CalculationSource {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    throw new Error('Plan settings must be valid JSON.');
  }
  if (!isRecord(settings)) throw new Error('Plan settings must be a JSON object.');
  const typeMap: Record<string, string> = {};
  for (const row of types) {
    const name = row.name.trim();
    const type = row.type.trim();
    if (!name && !type) continue;
    if (!name || !type) throw new Error('Every derived column needs a name and a type.');
    typeMap[name] = type;
  }
  return {
    ...(settings as Partial<CalculationSource>),
    format: 'cpm-calculation-source/0',
    prql,
    types: typeMap,
  } as CalculationSource;
}
