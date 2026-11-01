import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Target } from 'lucide-react';
import { useAuth } from '../auth';
import { createPlan } from '../api';
import { useMe, usePlans } from '../queries';
import { date, titleCase } from '../format';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  ProblemBanner,
  SkeletonTable,
  StatusPill,
  useToast,
} from '../components/ui';

export function PlansPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const meQuery = useMe(token);
  const plans = usePlans(token, { limit: 50 });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [fiscalYear, setFiscalYear] = useState(new Date().getUTCFullYear());
  const isSteward = Boolean(meQuery.data?.data.roles.some((role) => role === 'steward' || role === 'admin'));
  const items = plans.data?.items ?? [];

  const create = useMutation({
    mutationFn: () => createPlan(token!, { name: name.trim(), fiscal_year: fiscalYear }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      push({ tone: 'success', title: 'Plan created', detail: `${result.data.name} is ready for promotion.` });
      setOpen(false);
      setName('');
      navigate(`/plans/${result.data.plan_id}`);
    },
  });

  return (
    <div className="stack">
      <PageHeader
        title="Plans"
        subtitle="The official plan lineage. Promotion writes a new immutable plan version."
        actions={
          isSteward ? (
            <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
              New plan
            </Button>
          ) : null
        }
      />

      <ProblemBanner error={plans.error} onRetry={() => plans.refetch()} />

      {plans.isPending ? (
        <SkeletonTable rows={5} columns={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No plans yet"
          description={
            isSteward
              ? 'Create a plan shell, then promote an approved scenario into it.'
              : 'A steward has not created a plan for this department yet.'
          }
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Department</th>
                  <th>Fiscal year</th>
                  <th>Latest version</th>
                  <th className="num">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((plan) => (
                  <tr key={plan.plan_id}>
                    <td>
                      <Link className="primary-cell" to={`/plans/${plan.plan_id}`}>
                        {plan.name}
                        <span>{plan.code}</span>
                      </Link>
                    </td>
                    <td>{titleCase(plan.department_code)}</td>
                    <td className="num">{plan.fiscal_year}</td>
                    <td>
                      {plan.latest_version ? (
                        <span className="inline-pair">
                          <StatusPill value={plan.latest_version.status} />
                          <span className="mono muted">v{plan.latest_version.version_number}</span>
                        </span>
                      ) : (
                        <span className="muted">No version</span>
                      )}
                    </td>
                    <td className="num muted">{date(plan.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plans.data?.hasMore ? (
            <div className="load-more">
              <Button size="sm" loading={plans.isFetchingNextPage} onClick={() => plans.fetchNextPage()}>Load more plans</Button>
            </div>
          ) : null}
        </>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New plan"
        description="Create the plan shell that promotions will version into."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
              Create plan
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Plan name" htmlFor="plan-name">
            <Input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="FY2026 Finance Plan" autoFocus />
          </Field>
          <Field label="Fiscal year" htmlFor="plan-year">
            <Input id="plan-year" type="number" min={2000} max={2200} value={fiscalYear} onChange={(event) => setFiscalYear(Number(event.target.value))} />
          </Field>
        </div>
        <p className="fineprint">Department is taken from your token scope; only a steward can create plans.</p>
        <ProblemBanner error={create.error} />
      </Dialog>
    </div>
  );
}
