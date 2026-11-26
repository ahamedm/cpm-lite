import { createHash } from 'node:crypto';
import { stableStringify } from '../semantic/canonical.js';

export const CALCULATION_PLAN_FORMAT = 'cpm-calculation-plan/0' as const;
export const CALCULATION_COMPILER_VERSION = 'calculation-compiler/0' as const;

export type PlanValueType = 'decimal' | 'integer' | 'string' | 'date';
export type PlanColumnType = string;

export interface PlanPins {
  model_version_id: string;
  semantic_hash: string;
  rule_version_ids: string[];
  compiler_version?: string;
}

export interface PlanDriver {
  value: string;
  type: PlanValueType;
  applies_to: string;
  currency?: string;
  effective_period?: string;
  note?: string;
}

export type ArithmeticOp = 'add' | 'subtract' | 'multiply' | 'divide';
export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type LogicalOp = 'and' | 'or' | 'not';

export type PlanExpr =
  | { column: string }
  | { param: string }
  | { value: string; type: PlanValueType }
  | { op: ArithmeticOp | 'nullif' | 'coalesce' | 'round'; args: PlanExpr[] }
  | { op: ComparisonOp; args: PlanExpr[] }
  | { op: LogicalOp; args: PlanExpr[] }
  | { op: 'if'; args: PlanExpr[] };

export interface ScanStage {
  op: 'scan';
  source: string;
  artifact?: string;
  columns: string[];
}

export interface FilterStage {
  op: 'filter';
  predicate: PlanExpr;
}

export interface DeriveStage {
  op: 'derive';
  name: string;
  type: PlanColumnType;
  expression: PlanExpr;
}

export interface JoinKeyPair {
  /** Column in the current pipeline. */
  left: string;
  /** Column in the joined source. */
  right: string;
}

export interface JoinColumn {
  /** Source column to project from the joined table. */
  name: string;
  /** Output column name in the pipeline. */
  as: string;
}

export interface JoinStage {
  op: 'join';
  source: string;
  alias: string;
  type: 'left' | 'inner';
  on: JoinKeyPair[];
  columns: JoinColumn[];
}

export interface AllocateStage {
  op: 'allocate';
  pool: string;
  basis: string;
  partition_by: string[];
  eligible?: PlanExpr;
  strategy: 'proportional';
  rounding: { scale: number; mode: 'half_away_from_zero' };
  residual: { assign: 'last'; order_by: string[] };
  tolerance: string;
  output?: string;
}

export interface ValidateStage {
  op: 'validate';
  checks: string[];
}

export interface WriteStage {
  op: 'write';
  format: 'parquet';
  partition_by?: string[];
  measures: string[];
  summary?: {
    budget_measure?: string;
    actual_measure?: string;
    variance_measure?: string;
    currency_code?: string;
  };
}

export type PlanStage =
  | ScanStage
  | FilterStage
  | DeriveStage
  | JoinStage
  | AllocateStage
  | ValidateStage
  | WriteStage;

export interface CalculationPlan {
  format: typeof CALCULATION_PLAN_FORMAT;
  grain: string[];
  pins: PlanPins;
  drivers: Record<string, PlanDriver>;
  stages: PlanStage[];
}

export class CalculationPlanError extends Error {
  readonly code: string;
  readonly path: string;
  readonly reason: string;

  constructor(code: string, path: string, message: string) {
    super(`${path || '/'}: ${message}`);
    this.name = 'CalculationPlanError';
    this.code = code;
    this.path = path;
    this.reason = message;
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CalculationPlanError(code, path, message);
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED_SOURCE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const ARTIFACT = /^[A-Za-z0-9_./-]+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;
const PERIOD = /^\d{4}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const RESERVED_PREFIX = '__cpm_';

const VALUE_TYPES: readonly PlanValueType[] = ['decimal', 'integer', 'string', 'date'];
const COMPARISONS: readonly ComparisonOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
const ARITHMETIC: readonly ArithmeticOp[] = ['add', 'subtract', 'multiply', 'divide'];
const KNOWN_CHECKS = ['pool_conservation'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail('expected_object', path, 'Expected an object');
  return value;
}

function expectArray(value: unknown, path: string, minLength = 1): unknown[] {
  if (!Array.isArray(value)) fail('expected_array', path, 'Expected an array');
  if (value.length < minLength) fail('empty_array', path, `Expected at least ${minLength} item(s)`);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('expected_string', path, 'Expected a non-empty string');
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('expected_integer', path, 'Expected a non-negative integer');
  }
  return value;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail('unknown_key', `${path}/${key}`, `Unknown field "${key}"`);
  }
}

function assertIdentifier(value: unknown, path: string): string {
  const identifier = expectString(value, path);
  if (!IDENTIFIER.test(identifier)) {
    fail('invalid_identifier', path, `"${identifier}" is not a safe SQL identifier`);
  }
  if (identifier.startsWith(RESERVED_PREFIX)) {
    fail('reserved_identifier', path, `"${identifier}" uses the reserved "${RESERVED_PREFIX}" prefix`);
  }
  return identifier;
}

function assertQualifiedSource(value: unknown, path: string): string {
  const source = expectString(value, path);
  if (!QUALIFIED_SOURCE.test(source)) {
    fail('invalid_source', path, `"${source}" is not a safe qualified source name`);
  }
  return source;
}

function assertArtifact(value: unknown, path: string): string {
  const artifact = expectString(value, path);
  if (!ARTIFACT.test(artifact) || artifact.includes('..') || artifact.startsWith('/')) {
    fail('invalid_artifact', path, `"${artifact}" must be a safe relative artifact path`);
  }
  return artifact;
}

function parseValueType(value: unknown, path: string): PlanValueType {
  const type = expectString(value, path);
  if (!VALUE_TYPES.includes(type as PlanValueType)) {
    fail('invalid_value_type', path, `"${type}" is not a supported value type`);
  }
  return type as PlanValueType;
}

function assertValue(value: unknown, type: PlanValueType, path: string): string {
  const literal = expectString(value, path);
  switch (type) {
    case 'decimal':
      if (!DECIMAL.test(literal)) fail('invalid_decimal', path, `"${literal}" is not a decimal string`);
      break;
    case 'integer':
      if (!INTEGER.test(literal)) fail('invalid_integer', path, `"${literal}" is not an integer string`);
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(literal)) {
        fail('invalid_date', path, `"${literal}" is not an ISO date (YYYY-MM-DD)`);
      }
      break;
    case 'string':
      if (literal.includes('\0')) fail('invalid_string', path, 'String literals may not contain NUL');
      break;
  }
  return literal;
}

function parseColumnType(value: unknown, path: string): string {
  const type = expectString(value, path);
  if (type === 'integer' || type === 'string' || type === 'date') return type;
  const match = /^decimal\((\d{1,2}),(\d{1,2})\)$/i.exec(type);
  if (!match) fail('invalid_column_type', path, `"${type}" is not a supported column type`);
  const precision = Number(match[1]);
  const scale = Number(match[2]);
  if (precision < 1 || precision > 38 || scale < 0 || scale > precision) {
    fail('invalid_column_type', path, `"${type}" is outside DECIMAL(1..38, 0..precision)`);
  }
  return `DECIMAL(${precision},${scale})`;
}

function parseExpression(
  value: unknown,
  path: string,
  drivers: Record<string, PlanDriver>,
  columns: Set<string>
): PlanExpr {
  const record = expectRecord(value, path);

  if ('column' in record) {
    assertAllowedKeys(record, ['column'], path);
    const column = assertIdentifier(record.column, `${path}/column`);
    if (!columns.has(column)) fail('unknown_column', `${path}/column`, `Unknown column "${column}"`);
    return { column };
  }

  if ('param' in record) {
    assertAllowedKeys(record, ['param'], path);
    const param = assertIdentifier(record.param, `${path}/param`);
    if (!(param in drivers)) fail('unknown_param', `${path}/param`, `Unknown driver "${param}"`);
    return { param };
  }

  if ('value' in record) {
    assertAllowedKeys(record, ['value', 'type'], path);
    const type = parseValueType(record.type, `${path}/type`);
    return { value: assertValue(record.value, type, `${path}/value`), type };
  }

  if ('op' in record) {
    assertAllowedKeys(record, ['op', 'args'], path);
    const op = expectString(record.op, `${path}/op`);
    const args = expectArray(record.args, `${path}/args`, 1);

    if ((ARITHMETIC as readonly string[]).includes(op)) {
      if (args.length < 2) {
        fail('invalid_arity', `${path}/args`, `${op} requires at least two arguments`);
      }
      return {
        op: op as ArithmeticOp,
        args: args.map((arg, index) => parseExpression(arg, `${path}/args/${index}`, drivers, columns)),
      };
    }

    if (op === 'divide') {
      if (args.length !== 2) fail('invalid_arity', `${path}/args`, 'divide requires exactly two arguments');
      return {
        op,
        args: args.map((arg, index) => parseExpression(arg, `${path}/args/${index}`, drivers, columns)),
      };
    }

    if (op === 'nullif') {
      if (args.length !== 2) fail('invalid_arity', `${path}/args`, 'nullif requires exactly two arguments');
      return {
        op,
        args: args.map((arg, index) => parseExpression(arg, `${path}/args/${index}`, drivers, columns)),
      };
    }

    if (op === 'coalesce') {
      if (args.length < 2) {
        fail('invalid_arity', `${path}/args`, 'coalesce requires at least two arguments');
      }
      return {
        op,
        args: args.map((arg, index) => parseExpression(arg, `${path}/args/${index}`, drivers, columns)),
      };
    }

    if (op === 'round') {
      if (args.length !== 2) fail('invalid_arity', `${path}/args`, 'round requires exactly two arguments');
      const first = parseExpression(args[0], `${path}/args/0`, drivers, columns);
      const secondRecord = expectRecord(args[1], `${path}/args/1`);
      if (!('value' in secondRecord) || secondRecord.type !== 'integer') {
        fail('invalid_round', `${path}/args/1`, 'round scale must be an integer literal');
      }
      const second = parseExpression(args[1], `${path}/args/1`, drivers, columns);
      return { op, args: [first, second] };
    }

    if (op === 'if') {
      if (args.length !== 3) fail('invalid_arity', `${path}/args`, 'if requires exactly three arguments');
      return {
        op,
        args: args.map((arg, index) => parseExpression(arg, `${path}/args/${index}`, drivers, columns)),
      };
    }

    if ((COMPARISONS as readonly string[]).includes(op)) {
      if (args.length !== 2) {
        fail('invalid_arity', `${path}/args`, `${op} requires exactly two arguments`);
      }
      return {
        op: op as ComparisonOp,
        args: args.map((arg, index) => parseExpression(arg, `${path}/args/${index}`, drivers, columns)),
      };
    }

    if (op === 'and' || op === 'or') {
      if (args.length < 2) {
        fail('invalid_arity', `${path}/args`, `${op} requires at least two arguments`);
      }
      return {
        op,
        args: args.map((arg, index) => parseExpression(arg, `${path}/args/${index}`, drivers, columns)),
      };
    }

    if (op === 'not') {
      if (args.length !== 1) {
        fail('invalid_arity', `${path}/args`, 'not requires exactly one argument');
      }
      return {
        op,
        args: [parseExpression(args[0], `${path}/args/0`, drivers, columns)],
      };
    }

    fail('unsupported_operator', `${path}/op`, `Unsupported operator "${op}"`);
  }

  fail('invalid_expression', path, 'Expression must contain column, param, value or op');
}

function parseDrivers(value: unknown): Record<string, PlanDriver> {
  if (value === undefined) return {};
  const record = expectRecord(value, '/drivers');
  const drivers: Record<string, PlanDriver> = {};

  for (const [key, raw] of Object.entries(record)) {
    const path = `/drivers/${key}`;
    assertIdentifier(key, path);
    const driver = expectRecord(raw, path);
    assertAllowedKeys(driver, ['value', 'type', 'applies_to', 'currency', 'effective_period', 'note'], path);
    const type = parseValueType(driver.type, `${path}/type`);
    const appliesTo = assertIdentifier(driver.applies_to, `${path}/applies_to`);
    const parsed: PlanDriver = {
      value: assertValue(driver.value, type, `${path}/value`),
      type,
      applies_to: appliesTo,
    };
    if (driver.currency !== undefined) {
      const currency = expectString(driver.currency, `${path}/currency`);
      if (!CURRENCY.test(currency)) fail('invalid_currency', `${path}/currency`, 'Expected an ISO 4217 code');
      parsed.currency = currency;
    }
    if (driver.effective_period !== undefined) {
      const period = expectString(driver.effective_period, `${path}/effective_period`);
      if (!PERIOD.test(period)) fail('invalid_period', `${path}/effective_period`, 'Expected YYYY-MM');
      parsed.effective_period = period;
    }
    if (driver.note !== undefined) parsed.note = expectString(driver.note, `${path}/note`);
    drivers[key] = parsed;
  }

  return drivers;
}

function parsePins(value: unknown): PlanPins {
  const pins = expectRecord(value, '/pins');
  assertAllowedKeys(pins, ['model_version_id', 'semantic_hash', 'rule_version_ids', 'compiler_version'], '/pins');
  const modelVersionId = expectString(pins.model_version_id, '/pins/model_version_id');
  const semanticHash = expectString(pins.semantic_hash, '/pins/semantic_hash');
  const ruleVersions = expectArray(pins.rule_version_ids, '/pins/rule_version_ids', 0);
  const ruleVersionIds = ruleVersions.map((item, index) =>
    expectString(item, `/pins/rule_version_ids/${index}`)
  );
  const parsed: PlanPins = {
    model_version_id: modelVersionId,
    semantic_hash: semanticHash,
    rule_version_ids: ruleVersionIds,
  };
  if (pins.compiler_version !== undefined) {
    parsed.compiler_version = expectString(pins.compiler_version, '/pins/compiler_version');
  }
  return parsed;
}

function parseGrain(value: unknown): string[] {
  const grain = expectArray(value, '/grain');
  const parsed = grain.map((item, index) => assertIdentifier(item, `/grain/${index}`));
  if (new Set(parsed).size !== parsed.length) fail('duplicate_grain', '/grain', 'Grain keys must be unique');
  return parsed;
}

function assertKnownColumns(names: string[], columns: Set<string>, path: string): void {
  for (const name of names) {
    if (!columns.has(name)) fail('unknown_column', path, `Unknown column "${name}"`);
  }
}

function parseStages(
  value: unknown,
  drivers: Record<string, PlanDriver>,
  grain: string[]
): PlanStage[] {
  const rawStages = expectArray(value, '/stages');
  const stages: PlanStage[] = [];
  const columns = new Set<string>();
  let sawScan = false;
  let sawAllocate = false;
  let sawWrite = false;
  let sawPoolConservation = false;
  const joinAliases = new Set<string>();

  rawStages.forEach((raw, index) => {
    const path = `/stages/${index}`;
    const stage = expectRecord(raw, path);
    const op = expectString(stage.op, `${path}/op`);

    if (index === 0 && op !== 'scan') fail('invalid_stage_order', path, 'The first stage must be scan');
    if (index > 0 && op === 'scan') fail('duplicate_scan', path, 'Only one scan stage is allowed');
    if (sawWrite) fail('invalid_stage_order', path, 'write must be the last stage');
    if (sawAllocate && op === 'join') {
      fail('invalid_stage_order', path, 'join must precede allocate');
    }

    switch (op) {
      case 'scan': {
        assertAllowedKeys(stage, ['op', 'source', 'artifact', 'columns'], path);
        const source = assertQualifiedSource(stage.source, `${path}/source`);
        const artifact = stage.artifact === undefined ? undefined : assertArtifact(stage.artifact, `${path}/artifact`);
        const rawColumns = expectArray(stage.columns, `${path}/columns`);
        const parsedColumns = rawColumns.map((item, columnIndex) =>
          assertIdentifier(item, `${path}/columns/${columnIndex}`)
        );
        if (new Set(parsedColumns).size !== parsedColumns.length) {
          fail('duplicate_column', `${path}/columns`, 'Scan columns must be unique');
        }
        for (const column of parsedColumns) columns.add(column);
        sawScan = true;
        stages.push({ op, source, ...(artifact ? { artifact } : {}), columns: parsedColumns });
        break;
      }
      case 'filter': {
        assertAllowedKeys(stage, ['op', 'predicate'], path);
        stages.push({
          op,
          predicate: parseExpression(stage.predicate, `${path}/predicate`, drivers, columns),
        });
        break;
      }
      case 'derive': {
        assertAllowedKeys(stage, ['op', 'name', 'type', 'expression'], path);
        const name = assertIdentifier(stage.name, `${path}/name`);
        if (columns.has(name)) fail('duplicate_column', `${path}/name`, `Column "${name}" already exists`);
        const type = parseColumnType(stage.type, `${path}/type`);
        const expression = parseExpression(stage.expression, `${path}/expression`, drivers, columns);
        columns.add(name);
        stages.push({ op, name, type, expression });
        break;
      }
      case 'join': {
        assertAllowedKeys(stage, ['op', 'source', 'alias', 'type', 'on', 'columns'], path);
        const source = assertQualifiedSource(stage.source, `${path}/source`);
        const alias = assertIdentifier(stage.alias, `${path}/alias`);
        if (joinAliases.has(alias)) {
          fail('duplicate_join_alias', `${path}/alias`, `Join alias "${alias}" is already used`);
        }
        joinAliases.add(alias);
        const joinType =
          stage.type === 'left' || stage.type === 'inner'
            ? stage.type
            : fail('unsupported_join_type', `${path}/type`, 'Join type must be left or inner');
        const rawOn = expectArray(stage.on, `${path}/on`);
        const on = rawOn.map((item, pairIndex) => {
          const pairPath = `${path}/on/${pairIndex}`;
          const pair = expectRecord(item, pairPath);
          assertAllowedKeys(pair, ['left', 'right'], pairPath);
          return {
            left: assertIdentifier(pair.left, `${pairPath}/left`),
            right: assertIdentifier(pair.right, `${pairPath}/right`),
          };
        });
        if (new Set(on.map((pair) => pair.left)).size !== on.length) {
          fail('duplicate_join_key', `${path}/on`, 'Join left keys must be unique');
        }
        assertKnownColumns(on.map((pair) => pair.left), columns, `${path}/on`);
        const rawColumns = expectArray(stage.columns, `${path}/columns`);
        const joinedColumns = rawColumns.map((item, columnIndex) => {
          const columnPath = `${path}/columns/${columnIndex}`;
          const record = expectRecord(item, columnPath);
          assertAllowedKeys(record, ['name', 'as'], columnPath);
          const name = assertIdentifier(record.name, `${columnPath}/name`);
          const as = assertIdentifier(record.as, `${columnPath}/as`);
          if (columns.has(as)) {
            fail('duplicate_column', `${columnPath}/as`, `Column "${as}" already exists`);
          }
          return { name, as };
        });
        if (new Set(joinedColumns.map((column) => column.as)).size !== joinedColumns.length) {
          fail('duplicate_column', `${path}/columns`, 'Joined output columns must be unique');
        }
        for (const column of joinedColumns) columns.add(column.as);
        stages.push({ op, source, alias, type: joinType, on, columns: joinedColumns });
        break;
      }
      case 'allocate': {
        assertAllowedKeys(
          stage,
          ['op', 'pool', 'basis', 'partition_by', 'eligible', 'strategy', 'rounding', 'residual', 'tolerance', 'output'],
          path
        );
        if (sawAllocate) fail('duplicate_allocate', path, 'Only one allocate stage is allowed');
        const pool = assertIdentifier(stage.pool, `${path}/pool`);
        const basis = assertIdentifier(stage.basis, `${path}/basis`);
        assertKnownColumns([pool], columns, `${path}/pool`);
        assertKnownColumns([basis], columns, `${path}/basis`);
        const rawPartition = expectArray(stage.partition_by, `${path}/partition_by`);
        const partitionBy = rawPartition.map((item, partitionIndex) =>
          assertIdentifier(item, `${path}/partition_by/${partitionIndex}`)
        );
        if (new Set(partitionBy).size !== partitionBy.length) {
          fail('duplicate_partition', `${path}/partition_by`, 'Partition keys must be unique');
        }
        assertKnownColumns(partitionBy, columns, `${path}/partition_by`);
        const eligible =
          stage.eligible === undefined
            ? undefined
            : parseExpression(stage.eligible, `${path}/eligible`, drivers, columns);

        if (stage.strategy !== 'proportional') {
          fail('unsupported_strategy', `${path}/strategy`, 'Only proportional allocation is implemented');
        }

        const rounding = expectRecord(stage.rounding, `${path}/rounding`);
        assertAllowedKeys(rounding, ['scale', 'mode'], `${path}/rounding`);
        const scale = expectNonNegativeInteger(rounding.scale, `${path}/rounding/scale`);
        if (scale > 6) fail('invalid_scale', `${path}/rounding/scale`, 'Scale must be 0..6');
        if (rounding.mode !== 'half_away_from_zero') {
          fail('unsupported_rounding', `${path}/rounding/mode`, 'Only half_away_from_zero is implemented');
        }

        const residual = expectRecord(stage.residual, `${path}/residual`);
        assertAllowedKeys(residual, ['assign', 'order_by'], `${path}/residual`);
        if (residual.assign !== 'last') {
          fail('unsupported_residual', `${path}/residual/assign`, 'Only last-member residual assignment is implemented');
        }
        const rawOrder = expectArray(residual.order_by, `${path}/residual/order_by`);
        const orderBy = rawOrder.map((item, orderIndex) =>
          assertIdentifier(item, `${path}/residual/order_by/${orderIndex}`)
        );
        assertKnownColumns(orderBy, columns, `${path}/residual/order_by`);

        const tolerance = expectString(stage.tolerance, `${path}/tolerance`);
        if (!DECIMAL.test(tolerance) || Number(tolerance) < 0) {
          fail('invalid_tolerance', `${path}/tolerance`, 'Tolerance must be a non-negative decimal string');
        }

        const output = stage.output === undefined
          ? 'allocated_amount'
          : assertIdentifier(stage.output, `${path}/output`);
        if (columns.has(output)) fail('duplicate_column', `${path}/output`, `Column "${output}" already exists`);
        assertKnownColumns(grain, columns, `${path}/grain`);

        columns.add(output);
        sawAllocate = true;
        stages.push({
          op,
          pool,
          basis,
          partition_by: partitionBy,
          ...(eligible ? { eligible } : {}),
          strategy: 'proportional',
          rounding: { scale, mode: 'half_away_from_zero' },
          residual: { assign: 'last', order_by: orderBy },
          tolerance,
          output,
        });
        break;
      }
      case 'validate': {
        assertAllowedKeys(stage, ['op', 'checks'], path);
        const rawChecks = expectArray(stage.checks, `${path}/checks`);
        const checks = rawChecks.map((item, checkIndex) => {
          const check = expectString(item, `${path}/checks/${checkIndex}`);
          if (!(KNOWN_CHECKS as readonly string[]).includes(check)) {
            fail('unsupported_check', `${path}/checks/${checkIndex}`, `Unsupported check "${check}"`);
          }
          if (check === 'pool_conservation') sawPoolConservation = true;
          return check;
        });
        stages.push({ op, checks });
        break;
      }
      case 'write': {
        assertAllowedKeys(stage, ['op', 'format', 'partition_by', 'measures', 'summary'], path);
        if (stage.format !== 'parquet') {
          fail('unsupported_format', `${path}/format`, 'Only parquet output is implemented');
        }
        const rawMeasures = expectArray(stage.measures, `${path}/measures`);
        const measures = rawMeasures.map((item, measureIndex) =>
          assertIdentifier(item, `${path}/measures/${measureIndex}`)
        );
        assertKnownColumns(measures, columns, `${path}/measures`);
        let partitionBy: string[] | undefined;
        if (stage.partition_by !== undefined) {
          const rawPartition = expectArray(stage.partition_by, `${path}/partition_by`);
          partitionBy = rawPartition.map((item, partitionIndex) =>
            assertIdentifier(item, `${path}/partition_by/${partitionIndex}`)
          );
          assertKnownColumns(partitionBy, columns, `${path}/partition_by`);
        }
        let summary: WriteStage['summary'];
        if (stage.summary !== undefined) {
          const rawSummary = expectRecord(stage.summary, `${path}/summary`);
          assertAllowedKeys(
            rawSummary,
            ['budget_measure', 'actual_measure', 'variance_measure', 'currency_code'],
            `${path}/summary`
          );
          summary = {};
          for (const key of ['budget_measure', 'actual_measure', 'variance_measure'] as const) {
            if (rawSummary[key] !== undefined) {
              const measure = assertIdentifier(rawSummary[key], `${path}/summary/${key}`);
              if (!measures.includes(measure)) {
                fail(
                  'unknown_measure',
                  `${path}/summary/${key}`,
                  `"${measure}" must also appear in write.measures`
                );
              }
              summary[key] = measure;
            }
          }
          if (rawSummary.currency_code !== undefined) {
            const currency = expectString(rawSummary.currency_code, `${path}/summary/currency_code`);
            if (!CURRENCY.test(currency)) {
              fail('invalid_currency', `${path}/summary/currency_code`, 'Expected an ISO 4217 code');
            }
            summary.currency_code = currency;
          }
        }
        sawWrite = true;
        stages.push({
          op,
          format: 'parquet',
          ...(partitionBy ? { partition_by: partitionBy } : {}),
          measures,
          ...(summary ? { summary } : {}),
        });
        break;
      }
      default:
        fail('unsupported_stage', `${path}/op`, `Unsupported stage "${op}"`);
    }
  });

  if (!sawScan) fail('missing_scan', '/stages', 'A scan stage is required');
  if (sawPoolConservation && !sawAllocate) {
    fail('missing_allocation', '/stages', 'pool_conservation requires an allocate stage');
  }
  return stages;
}

/**
 * Validate and normalise a canonical calculation plan. Unknown fields are
 * rejected so a typo cannot silently change the calculation.
 */
export function validateCalculationPlan(value: unknown): CalculationPlan {
  const record = expectRecord(value, '');
  assertAllowedKeys(record, ['format', 'grain', 'pins', 'drivers', 'stages'], '');
  if (record.format !== CALCULATION_PLAN_FORMAT) {
    fail('invalid_format', '/format', `Expected "${CALCULATION_PLAN_FORMAT}"`);
  }
  const grain = parseGrain(record.grain);
  const pins = parsePins(record.pins);
  const drivers = parseDrivers(record.drivers);
  const stages = parseStages(record.stages, drivers, grain);
  return { format: CALCULATION_PLAN_FORMAT, grain, pins, drivers, stages };
}

/**
 * Content hash of a validated plan. Object keys are sorted; stage and member
 * order are preserved because they are part of the authored calculation.
 */
export function calculationPlanHash(plan: CalculationPlan): string {
  return createHash('sha256').update(stableStringify(plan)).digest('hex');
}
