import type {
  AuditEvent,
  CostCentre,
  Department,
  Job,
  JobResult,
  JobSummary,
  Me,
  Model,
  ModelDefinition,
  ModelPreview,
  ModelSource,
  ModelVersion,
  ModelVersionSummary,
  Page,
  Plan,
  PlanVersion,
  PlanVersionSummary,
  Promotion,
  Rule,
  RuleVersion,
  RuleVersionSummary,
  Scenario,
  ScenarioBase,
  ScenarioDriver,
  ScenarioVersion,
  ScenarioVersionSummary,
  Submission,
  ValidationReport,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const CUBE_BASE = (import.meta.env.VITE_CUBE_BASE_URL ?? '').replace(/\/$/, '');

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly issues?: Array<{ severity: string; path: string; code: string; message: string }>;
  readonly correlationId?: string;

  constructor(input: {
    status: number;
    code: string;
    title: string;
    detail?: string;
    issues?: ApiProblem['issues'];
    correlationId?: string;
  }) {
    super(input.detail ?? input.title);
    this.name = 'ApiProblem';
    this.status = input.status;
    this.code = input.code;
    this.title = input.title;
    this.detail = input.detail;
    this.issues = input.issues;
    this.correlationId = input.correlationId;
  }
}

export interface RequestOptions {
  token?: string | null;
  etag?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ApiResult<T> {
  data: T;
  etag?: string;
  status: number;
}

export const newIdempotencyKey = () => crypto.randomUUID();

function headersFor(options: RequestOptions, hasBody: boolean): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Correlation-Id': crypto.randomUUID(),
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.etag) headers['If-Match'] = options.etag;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  return headers;
}

async function parseProblem(response: Response): Promise<ApiProblem> {
  const fallback = new ApiProblem({
    status: response.status,
    code: 'request_failed',
    title: 'Request failed',
    detail: `${response.status} ${response.statusText}`,
  });
  try {
    const body = (await response.json()) as {
      code?: string;
      title?: string;
      detail?: string;
      errors?: ApiProblem['issues'];
      correlation_id?: string;
    };
    return new ApiProblem({
      status: response.status,
      code: body.code ?? fallback.code,
      title: body.title ?? fallback.title,
      detail: body.detail ?? fallback.detail,
      issues: body.errors,
      correlationId: body.correlation_id,
    });
  } catch {
    return fallback;
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  options: RequestOptions
): Promise<ApiResult<T>> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headersFor(options, init.body !== undefined), ...(init.headers ?? {}) },
    signal: options.signal,
  });

  if (!response.ok) throw await parseProblem(response);

  const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return {
    data,
    etag: response.headers.get('etag') ?? undefined,
    status: response.status,
  };
}

function queryString(params: Record<string, string | number | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export function get<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  return request<T>(path, { method: 'GET' }, options);
}

export function post<T>(
  path: string,
  body: unknown,
  options: RequestOptions = {}
): Promise<ApiResult<T>> {
  return request<T>(
    path,
    { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) },
    options
  );
}

export function patch<T>(
  path: string,
  body: unknown,
  options: RequestOptions = {}
): Promise<ApiResult<T>> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, options);
}

export function del<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  return request<T>(path, { method: 'DELETE' }, options);
}

export function list<T>(
  path: string,
  params: Record<string, string | number | undefined | null> = {},
  options: RequestOptions = {}
): Promise<ApiResult<Page<T>>> {
  return get<Page<T>>(`${path}${queryString(params)}`, options);
}

// ---------- identity & reference ----------

export const getMe = (token: string) => get<Me>('/api/v1/me', { token });

export const listDepartments = (token: string) =>
  list<Department>('/api/v1/departments', { limit: 200 }, { token });

export const listCostCentres = (token: string, departmentCode?: string) =>
  list<CostCentre>('/api/v1/cost-centres', { limit: 200, department_code: departmentCode }, { token });

// ---------- models ----------

export interface ListParams {
  cursor?: string;
  limit?: number;
  q?: string;
  status?: string;
  department_code?: string;
  visibility?: string;
  scenario_type?: string;
  scenario_version_id?: string;
  entity_type?: string;
  entity_id?: string;
  actor_subject?: string;
  action?: string;
  occurred_from?: string;
  occurred_to?: string;
}

export const listModels = (token: string, params: ListParams = {}) =>
  list<Model>('/api/v1/models', { limit: 50, ...params }, { token });

export const getModel = (token: string, id: string) => get<Model>(`/api/v1/models/${id}`, { token });

export const listModelSources = (token: string) =>
  list<ModelSource>('/api/v1/model-sources', { limit: 50 }, { token });

export const previewModel = (
  token: string,
  body: {
    definition: ModelDefinition;
    group_by: string[];
    measures: string[];
    limit?: number;
    preview_department_code?: string | null;
  },
  signal?: AbortSignal
) => post<ModelPreview>('/api/v1/model-preview', body, { token, signal });

export const createModel = (
  token: string,
  body: {
    name: string;
    code?: string;
    description?: string | null;
    department_code?: string | null;
    visibility: 'department' | 'global';
    definition: ModelDefinition;
  }
) => post<Model>('/api/v1/models', body, { token });

export const listModelVersions = (token: string, modelId: string) =>
  list<ModelVersionSummary>(`/api/v1/models/${modelId}/versions`, { limit: 100 }, { token });

export const getModelVersion = (token: string, id: string) =>
  get<ModelVersion>(`/api/v1/model-versions/${id}`, { token });

export const createModelVersion = (
  token: string,
  modelId: string,
  body: { from_version_id?: string | null; definition: ModelDefinition }
) => post<ModelVersion>(`/api/v1/models/${modelId}/versions`, body, { token });

export const validateModelVersion = (token: string, id: string) =>
  post<ValidationReport>(`/api/v1/model-versions/${id}/validate`, undefined, { token });

export const publishModelVersion = (
  token: string,
  id: string,
  etag: string,
  idempotencyKey = newIdempotencyKey()
) =>
  post<{ model_version: ModelVersion; cube_refresh: unknown }>(
    `/api/v1/model-versions/${id}/publish`,
    undefined,
    { token, etag, idempotencyKey }
  );

// ---------- scenarios ----------

export const listScenarios = (token: string, params: ListParams = {}) =>
  list<Scenario>('/api/v1/scenarios', { limit: 50, ...params }, { token });

export const getScenario = (token: string, id: string) =>
  get<Scenario>(`/api/v1/scenarios/${id}`, { token });

export const createScenario = (
  token: string,
  body: {
    name: string;
    code?: string;
    description?: string | null;
    scenario_type: 'budget' | 'forecast';
    department_code?: string | null;
    cost_centre_code?: string | null;
    model_version_id: string;
    base: ScenarioBase;
    period_start: string;
    period_end: string;
    currency_code?: string;
    drivers: ScenarioDriver[];
  }
) => post<Scenario>('/api/v1/scenarios', body, { token });

export const listScenarioVersions = (token: string, scenarioId: string) =>
  list<ScenarioVersionSummary>(`/api/v1/scenarios/${scenarioId}/versions`, { limit: 100 }, { token });

export const getScenarioVersion = (token: string, id: string) =>
  get<ScenarioVersion>(`/api/v1/scenario-versions/${id}`, { token });

export const validateScenarioVersion = (token: string, id: string) =>
  post<{ model_version_id: string; report: ValidationReport }>(
    `/api/v1/scenario-versions/${id}/validate`,
    undefined,
    { token }
  );

export const submitScenarioJob = (
  token: string,
  id: string,
  etag: string,
  idempotencyKey = newIdempotencyKey()
) =>
  post<Job>(`/api/v1/scenario-versions/${id}/jobs`, undefined, {
    token,
    etag,
    idempotencyKey,
  });

export const getScenarioVersionResults = (token: string, id: string) =>
  get<JobResult>(`/api/v1/scenario-versions/${id}/results`, { token });

export const listScenarioVersionJobs = (token: string, id: string) =>
  list<JobSummary>(`/api/v1/scenario-versions/${id}/jobs`, { limit: 50 }, { token });

// ---------- jobs ----------

export const listJobs = (token: string, params: ListParams = {}) =>
  list<JobSummary>('/api/v1/jobs', { limit: 50, ...params }, { token });

export const getJob = (token: string, id: string) => get<Job>(`/api/v1/jobs/${id}`, { token });

export const cancelJob = (
  token: string,
  id: string,
  idempotencyKey = newIdempotencyKey()
) => post<Job>(`/api/v1/jobs/${id}/cancel`, undefined, { token, idempotencyKey });

export const retryJob = (
  token: string,
  id: string,
  idempotencyKey = newIdempotencyKey()
) => post<Job>(`/api/v1/jobs/${id}/retry`, undefined, { token, idempotencyKey });

// ---------- review & plans ----------

export const listSubmissions = (token: string, params: ListParams = {}) =>
  list<Submission>('/api/v1/submissions', { limit: 50, ...params }, { token });

export const getSubmission = (token: string, id: string) =>
  get<Submission>(`/api/v1/submissions/${id}`, { token });

export const createSubmission = (
  token: string,
  scenarioVersionId: string,
  note: string | null,
  idempotencyKey = newIdempotencyKey()
) =>
  post<Submission>(
    `/api/v1/scenario-versions/${scenarioVersionId}/submissions`,
    note ? { note } : {},
    { token, idempotencyKey }
  );

export const decideSubmission = (
  token: string,
  id: string,
  etag: string,
  decision: 'approve' | 'reject' | 'request_changes',
  comment: string | null
) => post<Submission>(`/api/v1/submissions/${id}/decisions`, { decision, comment }, { token, etag });

export const promoteSubmission = (
  token: string,
  id: string,
  etag: string,
  planId: string,
  effectiveFrom: string,
  idempotencyKey = newIdempotencyKey()
) =>
  post<Promotion>(
    `/api/v1/submissions/${id}/promotion`,
    { plan_id: planId, effective_from: effectiveFrom },
    { token, etag, idempotencyKey }
  );

export const getPromotion = (token: string, id: string) =>
  get<Promotion>(`/api/v1/promotions/${id}`, { token });

export const listPlans = (token: string, params: ListParams = {}) =>
  list<Plan>('/api/v1/plans', { limit: 50, ...params }, { token });

export const getPlan = (token: string, id: string) => get<Plan>(`/api/v1/plans/${id}`, { token });

export const createPlan = (
  token: string,
  body: { name: string; code?: string; department_code?: string | null; fiscal_year: number }
) => post<Plan>('/api/v1/plans', body, { token });

export const listPlanVersions = (token: string, planId: string) =>
  list<PlanVersionSummary>(`/api/v1/plans/${planId}/versions`, { limit: 100 }, { token });

export const getPlanVersion = (token: string, id: string) =>
  get<PlanVersion>(`/api/v1/plan-versions/${id}`, { token });

// ---------- rules ----------

export const listRules = (token: string, params: ListParams = {}) =>
  list<Rule>('/api/v1/rules', { limit: 50, ...params }, { token });

export const getRule = (token: string, id: string) => get<Rule>(`/api/v1/rules/${id}`, { token });

export const createRule = (
  token: string,
  body: { name: string; code?: string; description?: string | null; owner_department_code?: string | null }
) => post<Rule>('/api/v1/rules', body, { token });

export const listRuleVersions = (token: string, ruleId: string) =>
  list<RuleVersionSummary>(`/api/v1/rules/${ruleId}/versions`, { limit: 100 }, { token });

export const getRuleVersion = (token: string, id: string) =>
  get<RuleVersion>(`/api/v1/rule-versions/${id}`, { token });

export const createRuleVersion = (
  token: string,
  ruleId: string,
  body: {
    evaluation_point: string;
    priority: number;
    effective_from: string;
    effective_to?: string | null;
    scopes: Array<{ scope_type: string; scope_id?: string | null }>;
    definition: { schema_version: string; kind: string; parameters: Record<string, unknown> };
  }
) => post<RuleVersion>(`/api/v1/rules/${ruleId}/versions`, body, { token });

export const validateRuleVersion = (token: string, id: string) =>
  post<ValidationReport>(`/api/v1/rule-versions/${id}/validate`, undefined, { token });

export const publishRuleVersion = (token: string, id: string, etag: string) =>
  post<RuleVersion>(`/api/v1/rule-versions/${id}/publish`, undefined, { token, etag });

export const retireRuleVersion = (token: string, id: string, etag: string) =>
  post<RuleVersion>(`/api/v1/rule-versions/${id}/retire`, undefined, { token, etag });

// ---------- audit ----------

export const listAuditEvents = (token: string, params: ListParams = {}) =>
  list<AuditEvent>('/api/v1/audit-events', { limit: 50, ...params }, { token });

// ---------- Cube ----------

export interface CubeRow {
  [key: string]: string | number | null;
}

export async function cubeLoad(
  cubeToken: string,
  query: Record<string, unknown>,
  signal?: AbortSignal
): Promise<CubeRow[]> {
  const response = await fetch(`${CUBE_BASE}/cubejs-api/v1/load`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cubeToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!response.ok) throw await parseProblem(response);
  const body = (await response.json()) as { data?: CubeRow[]; error?: string };
  if (body.error) throw new Error(body.error);
  return body.data ?? [];
}
