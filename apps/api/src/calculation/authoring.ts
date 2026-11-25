import { createHash } from 'node:crypto';
import prql from 'prql-js';
import { stableStringify } from '../semantic/canonical.js';
import {
  CalculationPlanError,
  validateCalculationPlan,
  type AllocateStage,
  type CalculationPlan,
  type DeriveStage,
  type FilterStage,
  type PlanDriver,
  type PlanExpr,
  type PlanPins,
  type PlanStage,
  type ScanStage,
  type ValidateStage,
  type WriteStage,
} from './plan.js';

export const CALCULATION_SOURCE_FORMAT = 'cpm-calculation-source/0' as const;
// Keep this in sync with the prql-js dependency in package.json.
export const CALCULATION_AUTHORING_COMPILER_VERSION = 'prql-authoring/0+prqlc-0.12.1' as const;

const MAX_PRQL_LENGTH = 20_000;
const MAX_EXPRESSION_DEPTH = 64;

export interface CalculationSourceWriteStage {
  op: 'write';
  format: 'parquet';
  partition_by?: string[];
  measures?: string[];
  summary?: WriteStage['summary'];
}

export type CalculationSourceStage =
  | AllocateStage
  | ValidateStage
  | CalculationSourceWriteStage;

export interface CalculationSource {
  format: typeof CALCULATION_SOURCE_FORMAT;
  source: string;
  artifact?: string;
  columns: string[];
  prql: string;
  types: Record<string, string>;
  grain: string[];
  pins: PlanPins;
  drivers?: Record<string, PlanDriver>;
  stages: CalculationSourceStage[];
}

export interface CompiledCalculationSource {
  source: CalculationSource;
  plan: CalculationPlan;
  source_hash: string;
  authoring_version: string;
}

type PlNode = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, path: string, message: string): never {
  throw new CalculationPlanError(code, path, message);
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

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail('unknown_key', `${path}/${key}`, `Unknown field "${key}"`);
  }
}

/**
 * Validate the authoring envelope. The compiled plan is validated again by
 * `validateCalculationPlan`; this pass only checks the fields the compiler reads
 * before it can build that plan.
 */
export function validateCalculationSource(value: unknown): CalculationSource {
  const record = expectRecord(value, '');
  assertAllowedKeys(
    record,
    ['format', 'source', 'artifact', 'columns', 'prql', 'types', 'grain', 'pins', 'drivers', 'stages'],
    ''
  );

  if (record.format !== CALCULATION_SOURCE_FORMAT) {
    fail('invalid_format', '/format', `Expected "${CALCULATION_SOURCE_FORMAT}"`);
  }

  const source = expectString(record.source, '/source');
  const artifact = record.artifact === undefined ? undefined : expectString(record.artifact, '/artifact');
  const rawColumns = expectArray(record.columns, '/columns');
  const columns = rawColumns.map((item, index) => expectString(item, `/columns/${index}`));
  if (new Set(columns).size !== columns.length) {
    fail('duplicate_column', '/columns', 'Scan columns must be unique');
  }

  const prqlSource = expectString(record.prql, '/prql');
  if (prqlSource.length > MAX_PRQL_LENGTH) {
    fail('prql_too_large', '/prql', `PRQL source must be at most ${MAX_PRQL_LENGTH} characters`);
  }

  const types: Record<string, string> = {};
  if (record.types !== undefined) {
    const rawTypes = expectRecord(record.types, '/types');
    for (const [name, type] of Object.entries(rawTypes)) {
      types[name] = expectString(type, `/types/${name}`);
    }
  }

  const grain = expectArray(record.grain, '/grain');
  if (!isRecord(record.pins)) fail('expected_object', '/pins', 'Expected an object');

  let drivers: Record<string, PlanDriver> | undefined;
  if (record.drivers !== undefined) {
    const rawDrivers = expectRecord(record.drivers, '/drivers');
    for (const name of Object.keys(rawDrivers)) {
      if (columns.includes(name)) {
        fail(
          'driver_column_collision',
          `/drivers/${name}`,
          `Driver "${name}" collides with a scan column; use distinct names`
        );
      }
    }
    drivers = rawDrivers as Record<string, PlanDriver>;
  }

  const rawStages = expectArray(record.stages, '/stages', 0);
  const stages: CalculationSourceStage[] = rawStages.map((raw, index) => {
    const path = `/stages/${index}`;
    const stage = expectRecord(raw, path);
    const op = expectString(stage.op, `${path}/op`);
    if (op === 'scan' || op === 'filter' || op === 'derive') {
      fail(
        'unsupported_stage',
        `${path}/op`,
        `"${op}" belongs in the PRQL pipeline; the structured stages accept allocate, validate and write`
      );
    }
    if (op !== 'allocate' && op !== 'validate' && op !== 'write') {
      fail('unsupported_stage', `${path}/op`, `Unsupported stage "${op}"`);
    }
    if (op === 'write' && stage.measures !== undefined) {
      expectArray(stage.measures, `${path}/measures`, 0);
    }
    return stage as unknown as CalculationSourceStage;
  });

  return {
    format: CALCULATION_SOURCE_FORMAT,
    source,
    ...(artifact ? { artifact } : {}),
    columns,
    prql: prqlSource,
    types,
    grain: grain as string[],
    pins: record.pins as unknown as PlanPins,
    ...(drivers ? { drivers } : {}),
    stages,
  };
}

function prqlErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as {
      inner?: Array<{ reason?: string; display?: string }>;
    };
    const first = parsed.inner?.[0];
    if (first?.reason) return first.reason;
    if (first?.display) return first.display.split('\n')[0] ?? first.display;
  } catch {
    // Not the structured PRQL error payload; use the raw message.
  }
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
}

function parsePrql(source: CalculationSource): unknown {
  let raw: string | undefined;
  try {
    raw = prql.prql_to_pl(source.prql);
  } catch (error) {
    fail('invalid_prql', '/prql', `PRQL could not be parsed: ${prqlErrorMessage(error)}`);
  }
  if (!raw) fail('invalid_prql', '/prql', 'PRQL could not be parsed');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail('invalid_prql', '/prql', 'PRQL produced an unreadable parse tree');
  }
}

function functionName(name: unknown): string[] {
  if (!isRecord(name)) return [];
  if (typeof name.Ident === 'string') return [name.Ident];
  if (isRecord(name.Indirection)) {
    const base = functionName(name.Indirection.base);
    const field = name.Indirection.field;
    if (isRecord(field)) {
      if (typeof field.Name === 'string') return [...base, field.Name];
      if (typeof field.Ident === 'string') return [...base, field.Ident];
    }
  }
  return [];
}

function identifierPath(node: unknown): string | null {
  if (!isRecord(node)) return null;
  if (typeof node.Ident === 'string') return node.Ident;
  if (isRecord(node.Indirection)) {
    const base = identifierPath(node.Indirection.base);
    const field = node.Indirection.field;
    if (!isRecord(field) || !base) return null;
    if (typeof field.Name === 'string') return `${base}.${field.Name}`;
    if (typeof field.Ident === 'string') return `${base}.${field.Ident}`;
  }
  return null;
}

function funcCall(node: unknown, path: string): { name: string[]; args: unknown[] } {
  const record = expectRecord(node, path);
  if (!isRecord(record.FuncCall)) fail('unsupported_expression', path, 'Expected a function call');
  const name = functionName(record.FuncCall.name);
  const args = record.FuncCall.args === undefined ? [] : expectArray(record.FuncCall.args, `${path}/args`, 0);
  return { name, args };
}

function translateLiteral(literal: Record<string, unknown>, path: string): PlanExpr {
  if ('Integer' in literal) {
    const value = literal.Integer;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      fail('invalid_literal', path, 'Integer literal is outside the safe range');
    }
    return { value: String(value), type: 'integer' };
  }
  if ('String' in literal) {
    if (typeof literal.String !== 'string') fail('invalid_literal', path, 'Expected a string literal');
    return { value: literal.String, type: 'string' };
  }
  if ('Date' in literal) {
    if (typeof literal.Date !== 'string') fail('invalid_literal', path, 'Expected a date literal');
    return { value: literal.Date, type: 'date' };
  }
  if ('Float' in literal) {
    const value = literal.Float;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('invalid_literal', path, 'Expected a finite numeric literal');
    }
    const text = String(value);
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      fail(
        'unsupported_literal',
        path,
        'This numeric literal cannot be represented as an exact decimal; bind a driver instead'
      );
    }
    return { value: text, type: 'decimal' };
  }
  if ('Boolean' in literal || 'Null' in literal) {
    fail('unsupported_literal', path, 'Boolean and null literals are only supported as a case fallback');
  }
  fail('unsupported_literal', path, 'Unsupported PRQL literal');
}

const BINARY_OPS: Record<
  string,
  'add' | 'subtract' | 'multiply' | 'divide' | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'and' | 'or'
> = {
  Add: 'add',
  Sub: 'subtract',
  Mul: 'multiply',
  DivFloat: 'divide',
  Eq: 'eq',
  Ne: 'ne',
  Gt: 'gt',
  Gte: 'gte',
  Lt: 'lt',
  Lte: 'lte',
  And: 'and',
  Or: 'or',
};

interface ExpressionContext {
  columns: Set<string>;
  drivers: Set<string>;
}

function translateExpression(
  node: unknown,
  path: string,
  context: ExpressionContext,
  depth = 0
): PlanExpr {
  if (depth > MAX_EXPRESSION_DEPTH) {
    fail('expression_too_deep', path, `Expression exceeds ${MAX_EXPRESSION_DEPTH} levels`);
  }
  const record = expectRecord(node, path);

  if (typeof record.Ident === 'string') {
    const name = record.Ident;
    if (context.drivers.has(name)) return { param: name };
    if (context.columns.has(name)) return { column: name };
    fail(
      'unknown_column',
      path,
      `Unknown column or driver "${name}"; add it to columns, derive it earlier, or bind it as a driver`
    );
  }

  if (isRecord(record.Literal)) {
    return translateLiteral(record.Literal, `${path}/Literal`);
  }

  if ('SString' in record || 'FString' in record) {
    fail('unsupported_sstring', path, 'Raw SQL and formatted strings are not allowed in a calculation');
  }

  if (isRecord(record.Binary)) {
    const op = BINARY_OPS[String(record.Binary.op)];
    if (!op) {
      fail('unsupported_operator', `${path}/Binary/op`, `Operator "${String(record.Binary.op)}" is not supported`);
    }
    const left = translateExpression(record.Binary.left, `${path}/Binary/left`, context, depth + 1);
    const right = translateExpression(record.Binary.right, `${path}/Binary/right`, context, depth + 1);
    return { op, args: [left, right] };
  }

  if (isRecord(record.Unary)) {
    const operand = translateExpression(record.Unary.expr, `${path}/Unary/expr`, context, depth + 1);
    if (record.Unary.op === 'Neg') {
      return { op: 'subtract', args: [{ value: '0', type: 'integer' }, operand] };
    }
    if (record.Unary.op === 'Not') {
      return { op: 'not', args: [operand] };
    }
    fail('unsupported_operator', `${path}/Unary/op`, `Unary operator "${String(record.Unary.op)}" is not supported`);
  }

  if (Array.isArray(record.Case)) {
    const branches = record.Case.map((branch, index) => {
      const item = expectRecord(branch, `${path}/Case/${index}`);
      return {
        condition: item.condition,
        value: item.value,
      };
    });
    if (branches.length === 0) fail('invalid_case', path, 'case requires at least one branch');
    const lastIndex = branches.length - 1;
    const last = branches[lastIndex];
    if (!last) fail('invalid_case', path, 'case requires at least one branch');
    const lastCondition = expectRecord(last.condition, `${path}/Case/${lastIndex}/condition`);
    const lastLiteral = isRecord(lastCondition.Literal) ? lastCondition.Literal : null;
    if (!lastLiteral || lastLiteral.Boolean !== true) {
      fail('invalid_case', `${path}/Case`, 'case must end with a "true" fallback branch');
    }
    let elseExpr = translateExpression(last.value, `${path}/Case/${lastIndex}/value`, context, depth + 1);
    for (let index = lastIndex - 1; index >= 0; index -= 1) {
      const branch = branches[index];
      if (!branch) continue;
      elseExpr = {
        op: 'if',
        args: [
          translateExpression(branch.condition, `${path}/Case/${index}/condition`, context, depth + 1),
          translateExpression(branch.value, `${path}/Case/${index}/value`, context, depth + 1),
          elseExpr,
        ],
      };
    }
    return elseExpr;
  }

  if (isRecord(record.FuncCall)) {
    const call = funcCall(node, path);
    const name = call.name.join('.');
    if (name === 'math.round') {
      if (call.args.length !== 2) {
        fail('invalid_arity', `${path}/FuncCall/args`, 'math.round requires a scale and a value');
      }
      const scaleRecord = expectRecord(call.args[0], `${path}/FuncCall/args/0`);
      const scaleLiteral = isRecord(scaleRecord.Literal) ? scaleRecord.Literal.Integer : undefined;
      if (typeof scaleLiteral !== 'number' || !Number.isInteger(scaleLiteral) || scaleLiteral < 0 || scaleLiteral > 6) {
        fail('invalid_round', `${path}/FuncCall/args/0`, 'math.round scale must be an integer from 0 to 6');
      }
      const value = translateExpression(call.args[1], `${path}/FuncCall/args/1`, context, depth + 1);
      return { op: 'round', args: [value, { value: String(scaleLiteral), type: 'integer' }] };
    }
    if (name === 'coalesce') {
      if (call.args.length < 2) {
        fail('invalid_arity', `${path}/FuncCall/args`, 'coalesce requires at least two arguments');
      }
      return {
        op: 'coalesce',
        args: call.args.map((arg, index) =>
          translateExpression(arg, `${path}/FuncCall/args/${index}`, context, depth + 1)
        ),
      };
    }
    if (name === 'nullif') {
      if (call.args.length !== 2) {
        fail('invalid_arity', `${path}/FuncCall/args`, 'nullif requires exactly two arguments');
      }
      return {
        op: 'nullif',
        args: call.args.map((arg, index) =>
          translateExpression(arg, `${path}/FuncCall/args/${index}`, context, depth + 1)
        ),
      };
    }
    fail(
      'unsupported_function',
      `${path}/FuncCall`,
      `Function "${name}" is not allowed; use arithmetic, a comparison, case, coalesce, nullif or math.round`
    );
  }

  fail('unsupported_expression', path, 'Unsupported PRQL expression');
}

function aliasedExpression(item: unknown, path: string): { alias: string; expression: unknown } {
  const record = expectRecord(item, path);
  if (typeof record.alias !== 'string' || record.alias.length === 0) {
    fail('missing_alias', path, 'Every derive expression needs a column alias');
  }
  return { alias: record.alias, expression: record };
}

interface TranslatedPipeline {
  filters: FilterStage[];
  derives: DeriveStage[];
  select: string[] | null;
}

function translatePipeline(parseTree: unknown, source: CalculationSource): TranslatedPipeline {
  const project = expectRecord(parseTree, '/prql');
  const statements = expectArray(project.stmts, '/prql/stmts');
  if (statements.length !== 1) {
    fail('unsupported_prql', '/prql', 'Only a single PRQL pipeline is supported; remove let bindings');
  }
  const statement = expectRecord(statements[0], '/prql/stmts/0');
  const definition = isRecord(statement.VarDef) ? statement.VarDef : null;
  if (!definition || definition.kind !== 'Main' || !isRecord(definition.value)) {
    fail('unsupported_prql', '/prql', 'Expected a single main PRQL pipeline');
  }
  const pipeline = isRecord(definition.value.Pipeline) ? definition.value.Pipeline : null;
  if (!pipeline) fail('unsupported_prql', '/prql', 'Expected a PRQL pipeline');
  const exprs = expectArray(pipeline.exprs, '/prql/pipeline');

  const columns = new Set(source.columns);
  const drivers = new Set(Object.keys(source.drivers ?? {}));
  const filters: FilterStage[] = [];
  const derives: DeriveStage[] = [];
  let select: string[] | null = null;
  let sawFrom = false;

  exprs.forEach((expr, index) => {
    const path = `/prql/exprs/${index}`;
    const call = funcCall(expr, path);
    const name = call.name.join('.');

    if (index === 0 && name !== 'from') {
      fail('invalid_prql', '/prql', 'The PRQL pipeline must start with "from"');
    }
    if (name === 'from') {
      if (sawFrom) fail('invalid_prql', path, 'Only one from transform is allowed');
      if (call.args.length !== 1) fail('invalid_arity', `${path}/args`, 'from requires one source');
      const from = identifierPath(call.args[0]);
      if (!from) {
        fail('invalid_prql', `${path}/args/0`, 'from must name a governed source, not a raw string');
      }
      if (from !== source.source) {
        fail(
          'source_mismatch',
          `${path}/args/0`,
          `PRQL reads "${from}", but this authoring document declares "${source.source}"`
        );
      }
      sawFrom = true;
      return;
    }

    if (name === 'filter') {
      if (call.args.length !== 1) fail('invalid_arity', `${path}/args`, 'filter requires one predicate');
      filters.push({
        op: 'filter',
        predicate: translateExpression(call.args[0], `${path}/args/0`, { columns, drivers }),
      });
      return;
    }

    if (name === 'derive') {
      if (call.args.length !== 1) fail('invalid_arity', `${path}/args`, 'derive requires one expression');
      const arg = expectRecord(call.args[0], `${path}/args/0`);
      const items = Array.isArray(arg.Tuple) ? arg.Tuple : [call.args[0]];
      for (const [itemIndex, item] of items.entries()) {
        const itemPath = Array.isArray(arg.Tuple) ? `${path}/args/0/Tuple/${itemIndex}` : `${path}/args/0`;
        const { alias, expression } = aliasedExpression(item, itemPath);
        if (columns.has(alias)) {
          fail('duplicate_column', itemPath, `Column "${alias}" already exists`);
        }
        if (drivers.has(alias)) {
          fail('driver_column_collision', itemPath, `Derived column "${alias}" collides with a bound driver`);
        }
        const type = source.types[alias];
        if (!type) {
          fail(
            'missing_type',
            `/types/${alias}`,
            `Declare a decimal, integer, string or date type for derived column "${alias}"`
          );
        }
        derives.push({
          op: 'derive',
          name: alias,
          type,
          expression: translateExpression(expression, `${itemPath}/expression`, { columns, drivers }),
        });
        columns.add(alias);
      }
      return;
    }

    if (name === 'select') {
      if (select) fail('invalid_prql', path, 'Only one select transform is allowed');
      if (index !== exprs.length - 1) {
        fail('invalid_prql', path, 'select must be the last transform');
      }
      if (call.args.length !== 1) fail('invalid_arity', `${path}/args`, 'select requires one tuple');
      const tuple = expectRecord(call.args[0], `${path}/args/0`);
      if (!Array.isArray(tuple.Tuple)) fail('invalid_prql', `${path}/args/0`, 'select requires a tuple');
      const names = tuple.Tuple.map((item, itemIndex) => {
        const itemPath = `${path}/args/0/Tuple/${itemIndex}`;
        const record = expectRecord(item, itemPath);
        if (typeof record.Ident !== 'string') {
          fail('invalid_prql', itemPath, 'select accepts column names only');
        }
        if (!columns.has(record.Ident)) {
          fail('unknown_column', itemPath, `Unknown column "${record.Ident}"`);
        }
        return record.Ident;
      });
      if (new Set(names).size !== names.length) {
        fail('duplicate_column', `${path}/args/0`, 'select columns must be unique');
      }
      select = names;
      return;
    }

    fail(
      'unsupported_transform',
      path,
      `Transform "${name || 'unknown'}" is not supported; use from, filter, derive and select`
    );
  });

  if (!sawFrom) fail('invalid_prql', '/prql', 'The PRQL pipeline must start with "from"');

  const usedTypes = new Set(derives.map((stage) => stage.name));
  for (const name of Object.keys(source.types)) {
    if (!usedTypes.has(name)) {
      fail('unused_type', `/types/${name}`, `No derived column uses the type for "${name}"`);
    }
  }

  return { filters, derives, select };
}

function buildWriteStage(
  stage: CalculationSourceWriteStage,
  select: string[] | null,
  index: number
): WriteStage {
  const path = `/stages/${index}`;
  if (stage.measures && select) {
    const declared = [...stage.measures].sort();
    const selected = [...select].sort();
    if (declared.length !== selected.length || declared.some((name, position) => name !== selected[position])) {
      fail(
        'measure_mismatch',
        `${path}/measures`,
        'write.measures must match the PRQL select list when both are present'
      );
    }
  }
  const measures = stage.measures ?? select;
  if (!measures || measures.length === 0) {
    fail('missing_measures', `${path}/measures`, 'Declare write.measures or end the PRQL pipeline with select');
  }
  return {
    op: 'write',
    format: stage.format,
    ...(stage.partition_by ? { partition_by: stage.partition_by } : {}),
    measures,
    ...(stage.summary ? { summary: stage.summary } : {}),
  };
}

function buildPlan(source: CalculationSource, pipeline: TranslatedPipeline): CalculationPlan {
  const scan: ScanStage = {
    op: 'scan',
    source: source.source,
    ...(source.artifact ? { artifact: source.artifact } : {}),
    columns: source.columns,
  };
  const hasWrite = source.stages.some((stage) => stage.op === 'write');
  if (pipeline.select && !hasWrite) {
    fail('missing_write', '/stages', 'Add a write stage; the PRQL select declares its measures');
  }
  const structured: PlanStage[] = source.stages.map((stage, index) =>
    stage.op === 'write' ? buildWriteStage(stage, pipeline.select, index) : stage
  );
  return validateCalculationPlan({
    format: 'cpm-calculation-plan/0',
    grain: source.grain,
    pins: source.pins,
    drivers: source.drivers ?? {},
    stages: [scan, ...pipeline.filters, ...pipeline.derives, ...structured],
  });
}

/**
 * Compile a `cpm-calculation-source/0` authoring document into the canonical
 * plan. PRQL is parsed for its syntax tree only: this module never executes
 * PRQL-generated SQL, and raw SQL s-strings are rejected.
 */
export function compileCalculationSource(input: unknown): CompiledCalculationSource {
  const source = validateCalculationSource(input);
  const parseTree = parsePrql(source);
  const pipeline = translatePipeline(parseTree, source);
  const plan = buildPlan(source, pipeline);
  return {
    source,
    plan,
    source_hash: calculationSourceHash(source),
    authoring_version: CALCULATION_AUTHORING_COMPILER_VERSION,
  };
}

export function calculationSourceHash(source: CalculationSource): string {
  return createHash('sha256').update(stableStringify(source)).digest('hex');
}
