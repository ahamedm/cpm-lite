import { useParams } from 'react-router-dom';
import { Target } from 'lucide-react';
import { useAuth } from '../auth';
import { usePlan, usePlanVersion, usePlanVersions } from '../queries';
import { dateTime, money, personLabel, titleCase } from '../format';
import {
  EmptyState,
  PageHeader,
  Panel,
  ProblemBanner,
  SkeletonTable,
  StatusPill,
} from '../components/ui';

export function PlanDetailPage() {
  const { planId } = useParams();
  const { token } = useAuth();
  const planQuery = usePlan(token, planId);
  const versionsQuery = usePlanVersions(token, planId);
  const latestVersionId = planQuery.data?.data.latest_version?.plan_version_id;
  const latestVersionQuery = usePlanVersion(token, latestVersionId);
  const versions = versionsQuery.data?.data.data ?? [];

  if (planQuery.isPending) return <SkeletonTable rows={7} columns={4} />;
  if (planQuery.error) return <ProblemBanner error={planQuery.error} onRetry={() => planQuery.refetch()} />;
  const plan = planQuery.data!.data;
  const latest = latestVersionQuery.data?.data;

  return (
    <div className="stack">
      <PageHeader
        back={{ to: '/plans', label: 'Plans' }}
        title={plan.name}
        subtitle={<><span className="mono">{plan.code}</span> · {titleCase(plan.department_code)} · FY{plan.fiscal_year}</>}
        actions={plan.latest_version ? <StatusPill value={plan.latest_version.status} /> : null}
      />

      <ProblemBanner error={versionsQuery.error ?? latestVersionQuery.error} />

      <div className="split split--detail">
        <div className="stack">
          <Panel title="Latest published version" description="The current official plan snapshot.">
            {latestVersionQuery.isPending ? (
              <SkeletonTable rows={3} columns={4} />
            ) : !latest ? (
              <EmptyState icon={Target} title="No published version" description="Promote an approved scenario to publish the first plan version." />
            ) : (
              <>
                <div className="metric-strip metric-strip--panel">
                  <div className="metric"><span className="metric__label">Budget</span><strong className="metric__value">{money(latest.totals.budget_amount, latest.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Actual</span><strong className="metric__value">{money(latest.totals.actual_amount, latest.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Variance</span><strong className={`metric__value ${Number(latest.totals.variance_amount) > 0 ? 'negative' : 'positive'}`}>{money(latest.totals.variance_amount, latest.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Effective</span><strong className="metric__value metric__value--date">{latest.effective_from}</strong></div>
                </div>
                <dl className="facts facts--grid">
                  <div><dt>Version</dt><dd className="mono">v{latest.version_number}</dd></div>
                  <div><dt>Published by</dt><dd>{personLabel(latest.published_by)}</dd></div>
                  <div><dt>Published</dt><dd>{dateTime(latest.published_at)}</dd></div>
                  <div><dt>Source scenario version</dt><dd className="mono small">{latest.source_scenario_version_id}</dd></div>
                  <div><dt>Source submission</dt><dd className="mono small">{latest.source_submission_id}</dd></div>
                </dl>
              </>
            )}
          </Panel>

          <Panel title="Version history" description="Every promotion appends a new immutable version.">
            {versionsQuery.isPending ? (
              <SkeletonTable rows={4} columns={4} />
            ) : versions.length === 0 ? (
              <EmptyState icon={Target} title="No versions yet" description="Promotions from approved submissions will appear here." />
            ) : (
              <div className="table-wrap">
                <table className="data-table data-table--compact">
                  <thead><tr><th>Version</th><th>Status</th><th>Effective from</th><th className="num">Published</th></tr></thead>
                  <tbody>
                    {versions.map((version) => (
                      <tr key={version.plan_version_id}>
                        <td className="mono">v{version.version_number}</td>
                        <td><StatusPill value={version.status} /></td>
                        <td>{version.effective_from}</td>
                        <td className="num muted">{dateTime(version.published_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <aside className="stack">
          <Panel title="Plan">
            <dl className="facts">
              <div><dt>Status</dt><dd><StatusPill value={plan.status} /></dd></div>
              <div><dt>Fiscal year</dt><dd>{plan.fiscal_year}</dd></div>
              <div><dt>Department</dt><dd>{titleCase(plan.department_code)}</dd></div>
              <div><dt>Created</dt><dd>{dateTime(plan.created_at)}</dd></div>
            </dl>
          </Panel>
          <Panel title="Governance">
            <p className="panel-copy">Only approved scenario versions can be promoted. Plan versions are immutable and audited.</p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
