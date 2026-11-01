export type JsonObject = Record<string, any>;

export interface ModelDefinition {
  schema_version: string;
  dimensions: JsonObject[];
  measures: JsonObject[];
  joins?: JsonObject[];
  [key: string]: unknown;
}

export interface ModelCreateRequest {
  code?: string;
  name: string;
  description?: string | null;
  department_code?: string | null;
  visibility: 'department' | 'global';
  definition: ModelDefinition;
}

export interface ModelUpdateRequest {
  name?: string;
  description?: string | null;
  visibility?: 'department' | 'global';
}

export interface ModelVersionCreateRequest {
  from_version_id?: string | null;
  definition: ModelDefinition;
}

export interface ModelVersionUpdateRequest {
  definition: ModelDefinition;
}

export type ScenarioBase =
  | { base_type: 'actuals'; actuals_as_of?: string | null }
  | { base_type: 'plan'; plan_version_id: string }
  | { base_type: 'scenario'; scenario_version_id: string };

export interface ScenarioDriver {
  driver_code: string;
  name: string;
  value: string;
  unit: 'percent' | 'currency' | 'headcount' | 'number';
  dimension_filters?: Record<string, string>;
  note?: string | null;
}

export interface ScenarioAdjustment {
  adjustment_code: string;
  name: string;
  amount: string;
  currency_code: string;
  dimension_filters?: Record<string, string>;
  note?: string | null;
}

export interface ScenarioAssumption {
  assumption_code: string;
  name: string;
  value: string;
  unit: 'percent' | 'currency' | 'headcount' | 'number';
  note?: string | null;
}

export interface ScenarioCreateRequest {
  code?: string;
  name: string;
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
  adjustments?: ScenarioAdjustment[];
  assumptions?: ScenarioAssumption[];
}

export interface ScenarioUpdateRequest {
  name?: string;
  description?: string | null;
  cost_centre_code?: string | null;
}

export interface ScenarioVersionCreateRequest {
  from_version_id?: string | null;
  model_version_id: string;
  base: ScenarioBase;
  period_start: string;
  period_end: string;
  currency_code?: string;
  drivers: ScenarioDriver[];
  adjustments?: ScenarioAdjustment[];
  assumptions?: ScenarioAssumption[];
}

export interface ScenarioVersionUpdateRequest {
  model_version_id?: string;
  base?: ScenarioBase;
  period_start?: string;
  period_end?: string;
  currency_code?: string;
  drivers?: ScenarioDriver[];
  adjustments?: ScenarioAdjustment[];
  assumptions?: ScenarioAssumption[];
}

export interface RuleScopeRequest {
  scope_type: 'global' | 'department' | 'cost_centre' | 'scenario_type';
  scope_id?: string | null;
}

export interface RuleDefinitionRequest {
  schema_version: string;
  kind: 'allocation' | 'validation' | 'promotion';
  parameters: JsonObject;
  message_template?: string | null;
}

export interface RuleCreateRequest {
  code?: string;
  name: string;
  description?: string | null;
  owner_department_code?: string | null;
}

export interface RuleUpdateRequest {
  name?: string;
  description?: string | null;
}

export interface RuleVersionCreateRequest {
  evaluation_point: 'pre_submit' | 'allocation' | 'post_calculation' | 'promotion';
  priority: number;
  effective_from: string;
  effective_to?: string | null;
  scopes: RuleScopeRequest[];
  definition: RuleDefinitionRequest;
}

export interface RuleVersionUpdateRequest {
  evaluation_point?: 'pre_submit' | 'allocation' | 'post_calculation' | 'promotion';
  priority?: number;
  effective_from?: string;
  effective_to?: string | null;
  scopes?: RuleScopeRequest[];
  definition?: RuleDefinitionRequest;
}

export interface SubmissionCreateRequest {
  note?: string | null;
}

export interface DecisionRequest {
  decision: 'approve' | 'reject' | 'request_changes';
  comment?: string | null;
}

export interface PromotionRequest {
  plan_id: string;
  effective_from: string;
  note?: string | null;
}

export interface PlanCreateRequest {
  code?: string;
  name: string;
  department_code?: string | null;
  fiscal_year: number;
}

export interface InternalJobStatusRequest {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: JsonObject;
  error?: { code: string; message: string; retryable?: boolean };
}
