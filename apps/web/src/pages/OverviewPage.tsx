import { Link } from 'react-router-dom';
import { ArrowUpRight, ChartNoAxesCombined, ClipboardCheck, FlaskConical, Layers3, Activity } from 'lucide-react';
import { useAuth } from '../auth';
import { useAuditEvents, useCubeVariance, useJobs, useMe, useModels, useScenarios, useSubmissions } from '../queries';
import { compactMoney, dateTime, money, percent, personLabel, relative, titleCase } from '../format';
import {
  EmptyState,
  LinkButton,
  Metric,
  MetricStrip,
  PageHeader,
  Panel,
  ProblemBanner,
  SkeletonTable,
  StatusPill,
} from '../components/ui';

export function OverviewPage() {
  const { token, cubeToken } = useAuth();
  const meQuery = useMe(token);
  const models = useModels(token, { limit: 200 });
  const scenarios = useScenarios(token, { limit: 200 });
  const jobs = useJobs(token, { limit: 200 });
  const submissions = useSubmissions(token, { limit: 200 });
  const isSteward = Boolean(meQuery.data?.data.roles.some((role) => role === 'steward' || role === 'admin'));
  const audit = useAuditEvents(token, { limit: 8 }, isSteward);
  const cube = useCubeVariance(cubeToken, 2023);

  const modelItems = models.data?.items ?? [];
  const scenarioItems = scenarios.data?.items ?? [];
  const jobItems = jobs.data?.items ?? [];
  const submissionItems = submissions.data?.items ?? [];

  const publishedModels = modelItems.filter((model) => model.latest_version.status === 'published').length;
  const inFlight = jobItems.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const failed = jobItems.filter((job) => job.status === 'failed').length;
  const awaitingReview = submissionItems.filter((submission) => submission.status === 'submitted').length;

  const workQueue = [...scenarioItems]
    .filter((scenario) => scenario.latest_version.status !== 'completed' || scenario.latest_version.review_status === 'submitted')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 8);

  const reviewQueue = submissionItems
    .filter((submission) => submission.status === 'submitted')
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
    .slice(0, 6);

  const error = models.error ?? scenarios.error ?? jobs.error ?? submissions.error ?? meQuery.error;

  return (
    <div className="stack">
      <PageHeader
        title="Portfolio"
        subtitle="Models, scenarios and approvals across the planning workspace."
        actions={
          <>
            <LinkButton to="/variance" icon={ChartNoAxesCombined}>
              Variance
            </LinkButton>
            <LinkButton to="/scenarios?new=1" variant="primary" icon={FlaskConical}>
              New scenario
            </LinkButton>
          </>
        }
      />

      <ProblemBanner error={error} onRetry={() => window.location.reload()} />

      <MetricStrip>
        <Metric
          label="Published models"
          value={models.isPending ? '—' : publishedModels}
          detail={models.isPending ? 'Loading' : `${modelItems.length - publishedModels} in draft or review`}
        />
        <Metric
          label="Scenarios"
          value={scenarios.isPending ? '—' : scenarioItems.length}
          detail={scenarios.isPending ? 'Loading' : `${workQueue.length} need attention`}
        />
        <Metric
          label="Jobs in flight"
          value={jobs.isPending ? '—' : inFlight}
          detail={jobs.isPending ? 'Loading' : failed ? `${failed} failed` : 'No failures'}
        />
        <Metric
          label="Awaiting review"
          value={submissions.isPending ? '—' : awaitingReview}
          detail={submissions.isPending ? 'Loading' : 'Submitted to stewards'}
        />
      </MetricStrip>

      <div className="split split--wide">
        <Panel
          title="Work queue"
          description="Scenarios that are still moving, failed, or waiting on review."
          action={<Link to="/scenarios" className="text-link">All scenarios <ArrowUpRight size={13} /></Link>}
        >
          {scenarios.isPending ? (
            <SkeletonTable rows={5} columns={5} />
          ) : workQueue.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title="No open scenarios"
              description="Create a budget or forecast scenario to start a runnable planning thread."
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th>Department</th>
                    <th>Run</th>
                    <th>Review</th>
                    <th className="num">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {workQueue.map((scenario) => (
                    <tr key={scenario.scenario_id}>
                      <td>
                        <Link className="primary-cell" to={`/scenarios/${scenario.scenario_id}`}>
                          {scenario.name}
                          <span>{scenario.code}</span>
                        </Link>
                      </td>
                      <td>{titleCase(scenario.department_code)}</td>
                      <td><StatusPill value={scenario.latest_version.status} /></td>
                      <td><StatusPill value={scenario.latest_version.review_status} /></td>
                      <td className="num muted">{relative(scenario.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Review queue"
          description="Completed scenario versions submitted for a steward decision."
          action={<Link to="/reviews" className="text-link">All reviews <ArrowUpRight size={13} /></Link>}
        >
          {submissions.isPending ? (
            <SkeletonTable rows={4} columns={4} />
          ) : reviewQueue.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="Review queue is clear"
              description="Completed scenarios submitted for review will appear here."
            />
          ) : (
            <div className="queue-list">
              {reviewQueue.map((submission) => (
                <Link className="queue-row" to={`/reviews/${submission.submission_id}`} key={submission.submission_id}>
                  <div>
                    <strong>{personLabel(submission.submitted_by)}</strong>
                    <span>{dateTime(submission.submitted_at)}</span>
                  </div>
                  <StatusPill value={submission.status} />
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="split">
        <Panel
          title="Variance by department"
          description="Governed budget vs actual for 2023, straight from Cube."
          action={<Link to="/variance" className="text-link">Open <ArrowUpRight size={13} /></Link>}
        >
          {!cubeToken ? (
            <EmptyState
              icon={ChartNoAxesCombined}
              title="Cube connection not configured"
              description="Add a Cube token on the Connection screen to read governed budget and actual measures."
              action={<LinkButton to="/connection" size="sm">Open connection</LinkButton>}
            />
          ) : cube.isPending ? (
            <SkeletonTable rows={5} columns={5} />
          ) : cube.error ? (
            <ProblemBanner error={cube.error} />
          ) : (cube.data ?? []).length === 0 ? (
            <EmptyState
              icon={ChartNoAxesCombined}
              title="No rows in scope"
              description="Cube returned no budget rows for this department and period."
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table data-table--variance">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th className="num">Budget</th>
                    <th className="num">Actual</th>
                    <th className="num">Variance</th>
                    <th className="num">%</th>
                  </tr>
                </thead>
                <tbody>
                  {(cube.data ?? []).slice(0, 6).map((row) => {
                    const department = String(row['budget_vs_actual.department'] ?? '—');
                    const budget = String(row['budget_vs_actual.budget_amount'] ?? '0');
                    const actual = String(row['budget_vs_actual.actual_amount'] ?? '0');
                    const variance = String(row['budget_vs_actual.variance_amount'] ?? '0');
                    const variancePct = String(row['budget_vs_actual.variance_pct'] ?? '0');
                    return (
                      <tr key={department}>
                        <td>{department}</td>
                        <td className="num">{compactMoney(budget)}</td>
                        <td className="num">{compactMoney(actual)}</td>
                        <td className={`num ${Number(variance) > 0 ? 'negative' : 'positive'}`}>
                          {compactMoney(variance)}
                        </td>
                        <td className="num muted">{percent(variancePct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Recent activity"
          description={isSteward ? 'Append-only audit trail, newest first.' : 'Latest jobs visible to your scope.'}
          action={<Link to={isSteward ? '/audit' : '/jobs'} className="text-link">Open <ArrowUpRight size={13} /></Link>}
        >
          {isSteward ? (
            audit.isPending ? (
              <SkeletonTable rows={5} columns={3} />
            ) : (audit.data?.items ?? []).length === 0 ? (
              <EmptyState icon={Activity} title="No activity yet" description="Audited actions will appear here as the workspace is used." />
            ) : (
              <ol className="activity">
                {(audit.data?.items ?? []).map((event) => (
                  <li key={event.audit_event_id}>
                    <span className="activity__time">{relative(event.occurred_at)}</span>
                    <span>
                      <strong>{event.action.replace(/[._]/g, ' ')}</strong>
                      <span>{personLabel(event.actor_subject)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )
          ) : jobs.isPending ? (
            <SkeletonTable rows={5} columns={3} />
          ) : jobItems.length === 0 ? (
            <EmptyState icon={Activity} title="No jobs yet" description="Scenario runs will appear here once submitted." />
          ) : (
            <ol className="activity">
              {jobItems.slice(0, 7).map((job) => (
                <li key={job.job_id}>
                  <span className={`activity__dot activity__dot--${job.status}`} />
                  <span>
                    <strong>Job {job.job_id.slice(0, 8)}</strong>
                    <span>Attempt {job.attempt} · {relative(job.queued_at)}</span>
                  </span>
                  <StatusPill value={job.status} />
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
