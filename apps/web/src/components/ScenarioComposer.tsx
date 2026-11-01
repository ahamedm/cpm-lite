import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { createScenario } from '../api';
import { useModels, usePlanVersions, usePlans } from '../queries';
import type { ScenarioBase, ScenarioDriver } from '../types';
import { Button, Dialog, Field, Input, ProblemBanner, Select, useToast } from './ui';

const starterDrivers: ScenarioDriver[] = [
  { driver_code: 'growth_pct', name: 'Revenue growth', value: '0.05', unit: 'percent' },
];

export function ScenarioComposerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (scenarioId: string) => void;
}) {
  const { token } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const models = useModels(token, { limit: 200 });
  const plans = usePlans(token, { limit: 100 });
  const [name, setName] = useState('');
  const [scenarioType, setScenarioType] = useState<'budget' | 'forecast'>('budget');
  const [modelVersionId, setModelVersionId] = useState('');
  const [baseType, setBaseType] = useState<'actuals' | 'plan'>('actuals');
  const [planId, setPlanId] = useState('');
  const planVersions = usePlanVersions(token, planId || undefined);
  const [planVersionId, setPlanVersionId] = useState('');
  const [periodStart, setPeriodStart] = useState('2026-01-01');
  const [periodEnd, setPeriodEnd] = useState('2026-12-31');
  const [drivers, setDrivers] = useState<ScenarioDriver[]>(starterDrivers);

  const publishedModels = useMemo(
    () => (models.data?.items ?? []).filter((model) => model.latest_version.status === 'published'),
    [models.data]
  );
  const publishedPlanVersions = useMemo(
    () => (planVersions.data?.data.data ?? []).filter((version) => version.status === 'published'),
    [planVersions.data]
  );

  const mutation = useMutation({
    mutationFn: () => {
      const base: ScenarioBase =
        baseType === 'plan'
          ? { base_type: 'plan', plan_version_id: planVersionId }
          : { base_type: 'actuals' };
      return createScenario(token!, {
        name: name.trim(),
        scenario_type: scenarioType,
        model_version_id: modelVersionId,
        base,
        period_start: periodStart,
        period_end: periodEnd,
        currency_code: 'USD',
        drivers: drivers.filter((driver) => driver.driver_code && driver.name),
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] });
      push({ tone: 'success', title: 'Scenario created', detail: `${result.data.name} has a draft version.` });
      onCreated(result.data.scenario_id);
      onClose();
    },
  });

  const canSubmit =
    Boolean(name.trim() && modelVersionId && periodStart && periodEnd) &&
    (baseType === 'actuals' || Boolean(planVersionId)) &&
    !mutation.isPending;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title="New scenario"
      description="Pin a published model, a base, and the drivers that shape the run. The scenario version stays draft until validation."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button variant="primary" onClick={() => mutation.mutate()} disabled={!canSubmit} loading={mutation.isPending}>
            Create scenario
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Scenario name" htmlFor="scenario-name">
          <Input id="scenario-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="FY2026 Finance Budget" autoFocus />
        </Field>
        <Field label="Type" htmlFor="scenario-type">
          <Select id="scenario-type" value={scenarioType} onChange={(event) => setScenarioType(event.target.value as 'budget' | 'forecast')}>
            <option value="budget">Budget</option>
            <option value="forecast">Forecast</option>
          </Select>
        </Field>
        <Field label="Published model" htmlFor="scenario-model" hint={publishedModels.length === 0 ? 'Publish a model first.' : undefined} className="form-grid__wide">
          <Select id="scenario-model" value={modelVersionId} onChange={(event) => setModelVersionId(event.target.value)}>
            <option value="">Choose a published model version</option>
            {publishedModels.map((model) => (
              <option key={model.latest_version.model_version_id} value={model.latest_version.model_version_id}>
                {model.name} · v{model.latest_version.version_number}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Base" htmlFor="scenario-base" className="form-grid__wide">
          <Select
            id="scenario-base"
            value={baseType}
            onChange={(event) => {
              const next = event.target.value as 'actuals' | 'plan';
              setBaseType(next);
              setPlanVersionId('');
            }}
          >
            <option value="actuals">Actuals</option>
            <option value="plan" disabled={(plans.data?.items.length ?? 0) === 0}>Plan version</option>
          </Select>
        </Field>
        {baseType === 'plan' ? (
          <>
            <Field label="Plan" htmlFor="scenario-plan">
              <Select id="scenario-plan" value={planId} onChange={(event) => { setPlanId(event.target.value); setPlanVersionId(''); }}>
                <option value="">Choose a plan</option>
                {(plans.data?.items ?? []).map((plan) => (
                  <option key={plan.plan_id} value={plan.plan_id}>{plan.name} · FY{plan.fiscal_year}</option>
                ))}
              </Select>
            </Field>
            <Field label="Plan version" htmlFor="scenario-plan-version">
              <Select id="scenario-plan-version" value={planVersionId} onChange={(event) => setPlanVersionId(event.target.value)}>
                <option value="">Choose a published version</option>
                {publishedPlanVersions.map((version) => (
                  <option key={version.plan_version_id} value={version.plan_version_id}>v{version.version_number}</option>
                ))}
              </Select>
            </Field>
          </>
        ) : null}
        <Field label="Period start" htmlFor="period-start">
          <Input id="period-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
        </Field>
        <Field label="Period end" htmlFor="period-end">
          <Input id="period-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
        </Field>
      </div>

      <div className="composer-section">
        <div className="composer-section__header">
          <div>
            <h3>Drivers</h3>
            <p>Named inputs used by the scenario engine. Percentages are fractions.</p>
          </div>
          <Button
            size="sm"
            icon={Plus}
            onClick={() => setDrivers((current) => [...current, { driver_code: '', name: '', value: '0', unit: 'number' }])}
          >
            Add driver
          </Button>
        </div>
        <div className="composer-rows">
          <div className="composer-row composer-row--driver composer-row--header" aria-hidden>
            <span>Code</span><span>Name</span><span>Value</span><span>Unit</span><span />
          </div>
          {drivers.map((driver, index) => (
            <div className="composer-row composer-row--driver" key={index}>
              <Input
                aria-label={`Driver ${index + 1} code`}
                value={driver.driver_code}
                onChange={(event) => setDrivers((current) => current.map((entry, position) => position === index ? { ...entry, driver_code: event.target.value } : entry))}
                placeholder="growth_pct"
              />
              <Input
                aria-label={`Driver ${index + 1} name`}
                value={driver.name}
                onChange={(event) => setDrivers((current) => current.map((entry, position) => position === index ? { ...entry, name: event.target.value } : entry))}
                placeholder="Revenue growth"
              />
              <Input
                aria-label={`Driver ${index + 1} value`}
                value={driver.value}
                onChange={(event) => setDrivers((current) => current.map((entry, position) => position === index ? { ...entry, value: event.target.value } : entry))}
                placeholder="0.05"
              />
              <Select
                aria-label={`Driver ${index + 1} unit`}
                value={driver.unit}
                onChange={(event) => setDrivers((current) => current.map((entry, position) => position === index ? { ...entry, unit: event.target.value as ScenarioDriver['unit'] } : entry))}
              >
                <option value="percent">Percent</option>
                <option value="currency">Currency</option>
                <option value="headcount">Headcount</option>
                <option value="number">Number</option>
              </Select>
              <button type="button" className="icon-button" aria-label="Remove driver" onClick={() => setDrivers((current) => current.filter((_, position) => position !== index))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <ProblemBanner error={mutation.error ?? models.error ?? plans.error} />
    </Dialog>
  );
}
