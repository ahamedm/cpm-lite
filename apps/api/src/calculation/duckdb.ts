import {
  CALCULATION_COMPILER_VERSION,
  CalculationPlanError,
  calculationPlanHash,
  validateCalculationPlan,
  type AllocateStage,
  type CalculationPlan,
  type PlanDriver,
  type PlanExpr,
  type PlanValueType,
} from './plan.js';

export interface CompiledValidation {
  check: string;
  sql: string;
}

export interface CompiledDuckDbPlan {
  sql: string;
  columns: string[];
  compiler_version: string;
  plan_hash: string;
  validations: CompiledValidation[];
}

const RESERVED_HELPERS = {
  pool: '__cpm_pool',
  total: '__cpm_total_basis',
  raw: '__cpm_raw_alloc',
  rowNumber: '__cpm_rn',
  rowCount: '__cpm_n',
  alloc: '__cpm_alloc',
  residual: '__cpm_residual',
} as const;

const COMPARISON_SQL: Record<string, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteQualified(source: string): string {
  return source.split('.').map(quote).join('.');
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function literal(value: string, type: PlanValueType): string {
  switch (type) {
    case 'decimal':
    case 'integer':
      return value;
    case 'string':
      return sqlString(value);
    case 'date':
      return `DATE ${sqlString(value)}`;
  }
}

function expressionSql(expression: PlanExpr, drivers: Record<string, PlanDriver>): string {
  if ('column' in expression) return quote(expression.column);

  if ('param' in expression) {
    const driver = drivers[expression.param];
    if (!driver) {
      throw new CalculationPlanError('unknown_param', `/drivers/${expression.param}`, 'Unknown driver');
    }
    return literal(driver.value, driver.type);
  }

  if ('value' in expression) return literal(expression.value, expression.type);

  const args = expression.args;
  switch (expression.op) {
    case 'add':
      return `(${args.map((arg) => expressionSql(arg, drivers)).join(' + ')})`;
    case 'subtract':
      return `(${args.map((arg) => expressionSql(arg, drivers)).join(' - ')})`;
    case 'multiply':
      return `(${args.map((arg) => expressionSql(arg, drivers)).join(' * ')})`;
    case 'divide': {
      const [left, right] = args;
      if (!left || !right) {
        throw new CalculationPlanError('invalid_arity', '/expression/args', 'divide requires two arguments');
      }
      // DuckDB returns DOUBLE for DECIMAL / DECIMAL. Cast back to DECIMAL so
      // money and rates stay fixed-point (I11).
      return `CAST((${expressionSql(left, drivers)} / NULLIF(${expressionSql(right, drivers)}, 0)) AS DECIMAL(38,6))`;
    }
    case 'nullif': {
      const [left, right] = args;
      if (!left || !right) {
        throw new CalculationPlanError('invalid_arity', '/expression/args', 'nullif requires two arguments');
      }
      return `NULLIF(${expressionSql(left, drivers)}, ${expressionSql(right, drivers)})`;
    }
    case 'coalesce':
      return `COALESCE(${args.map((arg) => expressionSql(arg, drivers)).join(', ')})`;
    case 'round': {
      const [value, scale] = args;
      if (!value || !scale) {
        throw new CalculationPlanError('invalid_arity', '/expression/args', 'round requires two arguments');
      }
      return `ROUND(${expressionSql(value, drivers)}, ${expressionSql(scale, drivers)})`;
    }
    case 'if': {
      const [condition, thenValue, elseValue] = args;
      if (!condition || !thenValue || !elseValue) {
        throw new CalculationPlanError('invalid_arity', '/expression/args', 'if requires three arguments');
      }
      return `CASE WHEN ${expressionSql(condition, drivers)} THEN ${expressionSql(thenValue, drivers)} ELSE ${expressionSql(elseValue, drivers)} END`;
    }
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [left, right] = args;
      if (!left || !right) {
        throw new CalculationPlanError('invalid_arity', '/expression/args', `${expression.op} requires two arguments`);
      }
      return `(${expressionSql(left, drivers)} ${COMPARISON_SQL[expression.op]} ${expressionSql(right, drivers)})`;
    }
    case 'and':
      return `(${args.map((arg) => expressionSql(arg, drivers)).join(' AND ')})`;
    case 'or':
      return `(${args.map((arg) => expressionSql(arg, drivers)).join(' OR ')})`;
    case 'not': {
      const [operand] = args;
      if (!operand) {
        throw new CalculationPlanError('invalid_arity', '/expression/args', 'not requires one argument');
      }
      return `(NOT ${expressionSql(operand, drivers)})`;
    }
  }
}

function scanSql(stage: Extract<CalculationPlan['stages'][number], { op: 'scan' }>): string {
  const from = stage.artifact ? `read_parquet(${sqlString(stage.artifact)})` : quoteQualified(stage.source);
  return `SELECT ${stage.columns.map(quote).join(', ')} FROM ${from}`;
}

function allocateStageSql(
  stage: AllocateStage,
  previous: string,
  columns: string[],
  grain: string[],
  drivers: Record<string, PlanDriver>
): string {
  const output = stage.output ?? 'allocated_amount';
  const pool = quote(stage.pool);
  const basis = quote(stage.basis);
  const partition = stage.partition_by.map(quote).join(', ');
  const partitionOnEligible = stage.partition_by.map((column) => `e.${quote(column)}`).join(', ');
  const joinTotals = stage.partition_by
    .map((column) => `e.${quote(column)} = t.${quote(column)}`)
    .join(' AND ');
  const orderBy = stage.residual.order_by.map((column) => `e.${quote(column)}`).join(', ');
  const eligibility = stage.eligible
    ? `(${expressionSql(stage.eligible, drivers)}) AND ${basis} > 0`
    : `${basis} > 0`;
  const grainColumns = grain.map(quote).join(', ');
  const joinAllocated = grain
    .map((column) => `i.${quote(column)} = a.${quote(column)}`)
    .join(' AND ');
  const projected = columns.map((column) => `i.${quote(column)}`).join(', ');
  const moneyType = `DECIMAL(18,${stage.rounding.scale})`;

  // The left join preserves every input row. Ineligible or zero-basis members
  // are absent from the allocation CTE and receive a zero allocation.
  return `WITH eligible AS (
  SELECT * FROM ${previous}
  WHERE ${eligibility}
),
totals AS (
  SELECT ${partition},
         SUM(${basis}) AS ${RESERVED_HELPERS.total},
         ANY_VALUE(${pool}) AS ${RESERVED_HELPERS.pool}
  FROM eligible
  GROUP BY ${partition}
),
shares AS (
  SELECT e.*,
         t.${RESERVED_HELPERS.total} AS ${RESERVED_HELPERS.total},
         t.${RESERVED_HELPERS.pool} AS ${RESERVED_HELPERS.pool},
         CAST(e.${basis} * t.${RESERVED_HELPERS.pool} / NULLIF(t.${RESERVED_HELPERS.total}, 0) AS DECIMAL(38,6)) AS ${RESERVED_HELPERS.raw},
         ROW_NUMBER() OVER (PARTITION BY ${partitionOnEligible} ORDER BY ${orderBy}) AS ${RESERVED_HELPERS.rowNumber},
         COUNT(*) OVER (PARTITION BY ${partitionOnEligible}) AS ${RESERVED_HELPERS.rowCount}
  FROM eligible e
  JOIN totals t ON ${joinTotals}
),
residual AS (
  SELECT *,
         ROUND(${RESERVED_HELPERS.raw}, ${stage.rounding.scale}) AS ${RESERVED_HELPERS.alloc},
         SUM(ROUND(${RESERVED_HELPERS.raw}, ${stage.rounding.scale})) OVER (PARTITION BY ${partition}) - ${RESERVED_HELPERS.pool} AS ${RESERVED_HELPERS.residual}
  FROM shares
),
allocated AS (
  SELECT ${grainColumns},
         CAST(
           CASE
             WHEN ${RESERVED_HELPERS.rowNumber} = ${RESERVED_HELPERS.rowCount}
               THEN ${RESERVED_HELPERS.alloc} - ${RESERVED_HELPERS.residual}
             ELSE ${RESERVED_HELPERS.alloc}
           END AS ${moneyType}
         ) AS ${quote(output)}
  FROM residual
)
SELECT ${projected},
       COALESCE(a.${quote(output)}, CAST(0 AS ${moneyType})) AS ${quote(output)}
FROM ${previous} i
LEFT JOIN allocated a ON ${joinAllocated}`;
}

function poolConservationSql(
  stage: AllocateStage,
  compiledSql: string
): string {
  const output = stage.output ?? 'allocated_amount';
  const partition = stage.partition_by.map(quote).join(', ');
  return `SELECT ${partition},
       CAST(SUM(${quote(output)}) AS VARCHAR) AS allocated_amount,
       CAST(ANY_VALUE(${quote(stage.pool)}) AS VARCHAR) AS pool_amount
FROM (${compiledSql}) result
GROUP BY ${partition}
HAVING ABS(SUM(${quote(output)}) - ANY_VALUE(${quote(stage.pool)})) > ${stage.tolerance}`;
}

/**
 * Compile a canonical plan to a deterministic DuckDB SELECT. The compiler is
 * the only place that emits SQL; it walks validated expressions and never
 * interpolates raw user SQL.
 */
export function compileDuckDbPlan(input: unknown): CompiledDuckDbPlan {
  const plan = validateCalculationPlan(input);
  const ctes: string[] = [];
  let previous: string | null = null;
  let columns: string[] = [];
  let allocation: AllocateStage | undefined;

  plan.stages.forEach((stage, index) => {
    switch (stage.op) {
      case 'scan': {
        columns = [...stage.columns];
        const name = `stage_${index}_scan`;
        ctes.push(`${name} AS (${scanSql(stage)})`);
        previous = name;
        break;
      }
      case 'filter': {
        if (!previous) throw new CalculationPlanError('missing_scan', '/stages', 'filter appears before scan');
        const name = `stage_${index}_filter`;
        ctes.push(
          `${name} AS (SELECT * FROM ${previous} WHERE ${expressionSql(stage.predicate, plan.drivers)})`
        );
        previous = name;
        break;
      }
      case 'derive': {
        if (!previous) throw new CalculationPlanError('missing_scan', '/stages', 'derive appears before scan');
        const name = `stage_${index}_derive`;
        ctes.push(
          `${name} AS (SELECT *, CAST(${expressionSql(stage.expression, plan.drivers)} AS ${stage.type}) AS ${quote(stage.name)} FROM ${previous})`
        );
        columns.push(stage.name);
        previous = name;
        break;
      }
      case 'allocate': {
        if (!previous) throw new CalculationPlanError('missing_scan', '/stages', 'allocate appears before scan');
        const name = `stage_${index}_allocate`;
        ctes.push(`${name} AS (${allocateStageSql(stage, previous, columns, plan.grain, plan.drivers)})`);
        columns.push(stage.output ?? 'allocated_amount');
        previous = name;
        allocation = stage;
        break;
      }
      case 'validate':
      case 'write':
        break;
    }
  });

  if (!previous) {
    throw new CalculationPlanError('missing_scan', '/stages', 'A scan stage is required');
  }

  const sql = `WITH ${ctes.join(',\n')}\nSELECT ${columns.map(quote).join(', ')}\nFROM ${previous}`;
  const validations: CompiledValidation[] = [];
  const checks = new Set(
    plan.stages.flatMap((stage) => (stage.op === 'validate' ? stage.checks : []))
  );
  if (checks.has('pool_conservation')) {
    if (!allocation) {
      throw new CalculationPlanError(
        'missing_allocation',
        '/stages',
        'pool_conservation requires an allocate stage'
      );
    }
    validations.push({
      check: 'pool_conservation',
      sql: poolConservationSql(allocation, sql),
    });
  }

  return {
    sql,
    columns,
    compiler_version: CALCULATION_COMPILER_VERSION,
    plan_hash: calculationPlanHash(plan),
    validations,
  };
}
