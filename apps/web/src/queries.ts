import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import * as api from './api';
import type { ApiResult } from './api';
import type {
  AuditEvent,
  Job,
  JobSummary,
  Me,
  Model,
  ModelVersion,
  Page,
  Plan,
  PlanVersionSummary,
  Rule,
  RuleVersionSummary,
  Scenario,
  ScenarioVersion,
  Submission,
} from './types';

export const qk = {
  me: ['me'] as const,
  models: (params: api.ListParams = {}) => ['models', params] as const,
  model: (id: string) => ['model', id] as const,
  modelVersion: (id: string) => ['model-version', id] as const,
  scenarios: (params: api.ListParams = {}) => ['scenarios', params] as const,
  scenario: (id: string) => ['scenario', id] as const,
  scenarioVersion: (id: string) => ['scenario-version', id] as const,
  scenarioVersionJobs: (id: string) => ['scenario-version-jobs', id] as const,
  jobs: (params: api.ListParams = {}) => ['jobs', params] as const,
  job: (id: string) => ['job', id] as const,
  submissions: (params: api.ListParams = {}) => ['submissions', params] as const,
  submission: (id: string) => ['submission', id] as const,
  plans: (params: api.ListParams = {}) => ['plans', params] as const,
  plan: (id: string) => ['plan', id] as const,
  planVersions: (id: string) => ['plan-versions', id] as const,
  planVersion: (id: string) => ['plan-version', id] as const,
  rules: (params: api.ListParams = {}) => ['rules', params] as const,
  rule: (id: string) => ['rule', id] as const,
  ruleVersions: (id: string) => ['rule-versions', id] as const,
  ruleVersion: (id: string) => ['rule-version', id] as const,
  audit: (params: api.ListParams = {}) => ['audit', params] as const,
  cubeVariance: (year: number) => ['cube-variance', year] as const,
};

function usePaged<T>(
  key: readonly unknown[],
  token: string | null,
  fetcher: (cursor?: string) => Promise<ApiResult<Page<T>>>,
  enabled = true
) {
  return useInfiniteQuery<
    ApiResult<Page<T>>,
    Error,
    { items: T[]; hasMore: boolean },
    readonly unknown[],
    string | undefined
  >({
    queryKey: key,
    queryFn: ({ pageParam }) => fetcher(pageParam),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.data.page_info.next_cursor ?? undefined,
    select: (data) => ({
      items: data.pages.flatMap((page) => page.data.data),
      hasMore: Boolean(data.pages.at(-1)?.data.page_info.has_more),
    }),
    enabled: Boolean(token) && enabled,
    staleTime: 15_000,
  });
}

export function useMe(token: string | null) {
  return useQuery<ApiResult<Me>, Error>({
    queryKey: ['me', token],
    queryFn: () => api.getMe(token!),
    enabled: Boolean(token),
    retry: false,
    staleTime: 60_000,
  });
}

export function useModels(token: string | null, params: api.ListParams = {}) {
  return usePaged(qk.models(params), token, (cursor) => api.listModels(token!, { ...params, cursor }));
}

export function useModel(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Model>, Error>({
    queryKey: qk.model(id ?? ''),
    queryFn: () => api.getModel(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useModelVersion(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<ModelVersion>, Error>({
    queryKey: qk.modelVersion(id ?? ''),
    queryFn: () => api.getModelVersion(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useScenarios(token: string | null, params: api.ListParams = {}) {
  return usePaged(qk.scenarios(params), token, (cursor) => api.listScenarios(token!, { ...params, cursor }));
}

export function useScenario(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Scenario>, Error>({
    queryKey: qk.scenario(id ?? ''),
    queryFn: () => api.getScenario(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useScenarioVersion(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<ScenarioVersion>, Error>({
    queryKey: qk.scenarioVersion(id ?? ''),
    queryFn: () => api.getScenarioVersion(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useScenarioVersionJobs(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Page<JobSummary>>, Error>({
    queryKey: qk.scenarioVersionJobs(id ?? ''),
    queryFn: () => api.listScenarioVersionJobs(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useJobs(token: string | null, params: api.ListParams = {}) {
  return usePaged(qk.jobs(params), token, (cursor) => api.listJobs(token!, { ...params, cursor }));
}

export function useJob(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Job>, Error>({
    queryKey: qk.job(id ?? ''),
    queryFn: () => api.getJob(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useSubmissions(token: string | null, params: api.ListParams = {}) {
  return usePaged(qk.submissions(params), token, (cursor) => api.listSubmissions(token!, { ...params, cursor }));
}

export function useSubmission(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Submission>, Error>({
    queryKey: qk.submission(id ?? ''),
    queryFn: () => api.getSubmission(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function usePlans(token: string | null, params: api.ListParams = {}) {
  return usePaged(qk.plans(params), token, (cursor) => api.listPlans(token!, { ...params, cursor }));
}

export function usePlan(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Plan>, Error>({
    queryKey: qk.plan(id ?? ''),
    queryFn: () => api.getPlan(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function usePlanVersions(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Page<PlanVersionSummary>>, Error>({
    queryKey: qk.planVersions(id ?? ''),
    queryFn: () => api.listPlanVersions(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function usePlanVersion(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<import('./types').PlanVersion>, Error>({
    queryKey: qk.planVersion(id ?? ''),
    queryFn: () => api.getPlanVersion(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useRules(token: string | null, params: api.ListParams = {}) {
  return usePaged(qk.rules(params), token, (cursor) => api.listRules(token!, { ...params, cursor }));
}

export function useRule(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Rule>, Error>({
    queryKey: qk.rule(id ?? ''),
    queryFn: () => api.getRule(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useRuleVersions(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<Page<RuleVersionSummary>>, Error>({
    queryKey: qk.ruleVersions(id ?? ''),
    queryFn: () => api.listRuleVersions(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useRuleVersion(token: string | null, id: string | undefined) {
  return useQuery<ApiResult<import('./types').RuleVersion>, Error>({
    queryKey: qk.ruleVersion(id ?? ''),
    queryFn: () => api.getRuleVersion(token!, id!),
    enabled: Boolean(token && id),
  });
}

export function useAuditEvents(token: string | null, params: api.ListParams = {}, enabled = true) {
  return usePaged(qk.audit(params), token, (cursor) => api.listAuditEvents(token!, { ...params, cursor }), enabled);
}

export function useCubeVariance(cubeToken: string | null, year: number) {
  return useQuery({
    queryKey: [...qk.cubeVariance(year), cubeToken],
    queryFn: ({ signal }) =>
      api.cubeLoad(
        cubeToken!,
        {
          measures: [
            'budget_vs_actual.budget_amount',
            'budget_vs_actual.actual_amount',
            'budget_vs_actual.variance_amount',
            'budget_vs_actual.variance_pct',
          ],
          dimensions: ['budget_vs_actual.department'],
          timeDimensions: [
            {
              dimension: 'budget_vs_actual.transaction_date',
              dateRange: [`${year}-01-01`, `${year}-12-31`],
            },
          ],
          order: { 'budget_vs_actual.variance_amount': 'desc' },
        },
        signal
      ),
    enabled: Boolean(cubeToken),
    staleTime: 60_000,
  });
}

export type { AuditEvent, Job, JobSummary, Me, Model, ModelVersion, Page, Plan, Rule, Scenario, ScenarioVersion, Submission };
