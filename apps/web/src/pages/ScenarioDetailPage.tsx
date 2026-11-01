import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CheckCircle2, ClipboardCheck, Play, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth';
import { createSubmission, submitScenarioJob, validateScenarioVersion } from '../api';
import { useScenario, useScenarioVersion, useScenarioVersionJobs } from '../queries';
import { dateTime, money, periodLabel, personLabel, titleCase } from '../format';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  ProblemBanner,
  SkeletonTable,
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui';

export function ScenarioDetailPage() {
  const { scenarioId } = useParams();
  const { token } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const scenarioQuery = useScenario(token, scenarioId);
  const versionId = scenarioQuery.data?.data.latest_version.scenario_version_id;
  const versionQuery = useScenarioVersion(token, versionId);
  const jobsQuery = useScenarioVersionJobs(token, versionId);
  const [runOpen, setRunOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewNote, setReviewNote] = useState('');

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['scenario', scenarioId] });
    queryClient.invalidateQueries({ queryKey: ['scenario-version', versionId] });
    queryClient.invalidateQueries({ queryKey: ['scenario-version-jobs', versionId] });
    queryClient.invalidateQueries({ queryKey: ['scenarios'] });
  }

  const validate = useMutation({
    mutationFn: () => validateScenarioVersion(token!, versionId!),
    onSuccess: (result) => {
      invalidate();
      push({
        tone: result.data.report.valid ? 'success' : 'error',
        title: result.data.report.valid ? 'Scenario validated' : 'Pre-submit validation failed',
        detail: result.data.report.valid
          ? 'The scenario is ready to run.'
          : `${result.data.report.issues.length} issue${result.data.report.issues.length === 1 ? '' : 's'} need attention.`,
      });
    },
  });

  const run = useMutation({
    mutationFn: () => submitScenarioJob(token!, versionId!, versionQuery.data!.etag!),
    onSuccess: (result) => {
      setRunOpen(false);
      invalidate();
      push({ tone: 'success', title: 'Job queued', detail: `Job ${result.data.job_id.slice(0, 8)} is waiting for the scenario worker.` });
    },
  });

  const submitReview = useMutation({
    mutationFn: () => createSubmission(token!, versionId!, reviewNote.trim() || null),
    onSuccess: (result) => {
      setReviewOpen(false);
      invalidate();
      navigate(`/reviews/${result.data.submission_id}`);
    },
  });

  if (scenarioQuery.isPending) return <SkeletonTable rows={8} columns={4} />;
  if (scenarioQuery.error) return <ProblemBanner error={scenarioQuery.error} onRetry={() => scenarioQuery.refetch()} />;
  const scenario = scenarioQuery.data!.data;
  const version = versionQuery.data?.data;
  const jobs = jobsQuery.data?.data.data ?? [];

  const canValidate = version?.status === 'draft' || version?.status === 'validated';
  const canRun = version?.status === 'draft' || version?.status === 'validated' || version?.status === 'failed' || version?.status === 'cancelled';
  const canSubmitReview = version?.status === 'completed' && version.review_status === 'not_submitted';
  const lifecycle = ['draft', 'validated', 'queued', 'running', 'completed'];
  const lifecycleIndex = version ? lifecycle.indexOf(version.status) : -1;

  return (
    <div className="stack">
      <PageHeader
        back={{ to: '/scenarios', label: 'Scenarios' }}
        title={scenario.name}
        subtitle={
          <>
            <span className="mono">{scenario.code}</span> · {scenario.scenario_type} · {titleCase(scenario.department_code)}
          </>
        }
        actions={
          <>
            {canValidate ? (
              <Button icon={CheckCircle2} loading={validate.isPending} onClick={() => validate.mutate()}>
                Validate
              </Button>
            ) : null}
            {canRun ? (
              <Button variant="primary" icon={Play} onClick={() => setRunOpen(true)}>
                {version?.status === 'failed' || version?.status === 'cancelled' ? 'Re-run scenario' : 'Run scenario'}
              </Button>
            ) : null}
            {canSubmitReview ? (
              <Button icon={ClipboardCheck} onClick={() => setReviewOpen(true)}>
                Submit for review
              </Button>
            ) : null}
            {version?.review_status === 'submitted' ? (
              <Link className="button button--secondary button--md" to="/reviews">
                <ClipboardCheck size={14} />
                <span>In review</span>
              </Link>
            ) : null}
          </>
        }
      />

      <ProblemBanner error={validate.error ?? run.error ?? submitReview.error ?? versionQuery.error} />

      {versionQuery.isPending ? <SkeletonTable rows={8} columns={4} /> : null}

      {version ? (
        <div className="split split--detail">
          <div className="stack">
            <Panel title="Definition" description="Pinned inputs for this scenario version.">
              <dl className="facts facts--grid">
                <div><dt>Model version</dt><dd className="mono small">{version.model_version_id}</dd></div>
                <div><dt>Base</dt><dd>{titleCase(version.base.base_type)}</dd></div>
                <div><dt>Period</dt><dd>{periodLabel(version.period_start, version.period_end)}</dd></div>
                <div><dt>Currency</dt><dd>{version.currency_code}</dd></div>
                <div><dt>Version</dt><dd className="mono">v{version.version_number}</dd></div>
                <div><dt>Updated</dt><dd>{dateTime(version.updated_at)}</dd></div>
              </dl>
            </Panel>

            <Panel title="Drivers" description="Assumptions applied by the scenario engine.">
              {version.drivers.length === 0 ? (
                <EmptyState icon={Play} title="No drivers" description="This scenario has no drivers; the run will use base data only." />
              ) : (
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr><th>Driver</th><th>Code</th><th className="num">Value</th><th>Unit</th></tr>
                    </thead>
                    <tbody>
                      {version.drivers.map((driver) => (
                        <tr key={driver.driver_code}>
                          <td>{driver.name}</td>
                          <td className="mono muted">{driver.driver_code}</td>
                          <td className="num mono">{driver.value}</td>
                          <td className="muted">{driver.unit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              title="Validation"
              description="Rules resolvable at the scenario's department, cost centre and type."
              action={
                version.validation ? (
                  <StatusPill value={version.validation.valid ? 'validated' : 'failed'} label={version.validation.valid ? 'Passing' : 'Blocked'} />
                ) : null
              }
            >
              {!version.validation ? (
                <EmptyState icon={CheckCircle2} title="Not validated yet" description="Run validation before queueing the scenario." />
              ) : (
                <div className="validation">
                  <p className="validation__summary">
                    {version.validation.valid
                      ? 'Pre-submit rules passed. The job can be queued.'
                      : 'Pre-submit rules rejected this version. Resolve the issues before running.'}
                  </p>
                  {version.validation.issues.length ? (
                    <ul className="issue-list">
                      {version.validation.issues.map((issue) => (
                        <li key={`${issue.path}-${issue.code}-${issue.message}`}>
                          <span className={`issue-severity issue-severity--${issue.severity}`}>{issue.severity}</span>
                          <div>
                            <strong>{issue.code.replace(/_/g, ' ')}</strong>
                            <p>{issue.message}</p>
                            <code>{issue.path || '/'}</code>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
            </Panel>

            {version.result ? (
              <Panel title="Result" description={`Completed ${dateTime(version.result.completed_at)}`}>
                <div className="metric-strip metric-strip--panel">
                  <div className="metric"><span className="metric__label">Budget</span><strong className="metric__value">{money(version.result.totals.budget_amount, version.result.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Actual</span><strong className="metric__value">{money(version.result.totals.actual_amount, version.result.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Variance</span><strong className={`metric__value ${Number(version.result.totals.variance_amount) > 0 ? 'negative' : 'positive'}`}>{money(version.result.totals.variance_amount, version.result.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Allocated</span><strong className="metric__value">{money(version.result.allocation_summary.allocated_total, version.result.totals.currency_code)}</strong></div>
                </div>
                <dl className="facts facts--grid">
                  <div><dt>Allocation strategy</dt><dd>{titleCase(version.result.allocation_summary.strategy)}</dd></div>
                  <div><dt>Residual</dt><dd>{money(version.result.allocation_summary.residual, version.result.totals.currency_code)}</dd></div>
                  <div><dt>Within tolerance</dt><dd>{version.result.allocation_summary.within_tolerance ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Result URI</dt><dd className="mono small">{version.result.result_uri}</dd></div>
                </dl>
                {version.result.rule_outcomes.length ? (
                  <div className="table-wrap">
                    <table className="data-table data-table--compact">
                      <thead><tr><th>Rule</th><th>Decision</th><th>Message</th></tr></thead>
                      <tbody>
                        {version.result.rule_outcomes.map((outcome) => (
                          <tr key={outcome.rule_version_id}>
                            <td className="mono">{outcome.rule_code}</td>
                            <td><StatusPill value={outcome.decision} /></td>
                            <td className="muted">{outcome.message ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </Panel>
            ) : null}

            <Panel
              title="Jobs"
              description="Every submission pins the model, rules and dataset snapshot."
              action={jobsQuery.isFetching ? <span className="muted small">Refreshing…</span> : null}
            >
              {jobsQuery.isPending ? (
                <SkeletonTable rows={3} columns={4} />
              ) : jobs.length === 0 ? (
                <EmptyState icon={Play} title="No jobs yet" description="Queue a run to create the first job for this version." />
              ) : (
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead><tr><th>Job</th><th>Attempt</th><th>Status</th><th className="num">Queued</th><th className="num">Finished</th></tr></thead>
                    <tbody>
                      {jobs.map((job) => (
                        <tr key={job.job_id}>
                          <td><Link className="mono text-link" to={`/jobs/${job.job_id}`}>{job.job_id.slice(0, 8)}</Link></td>
                          <td>{job.attempt}</td>
                          <td><StatusPill value={job.status} /></td>
                          <td className="num muted">{dateTime(job.queued_at)}</td>
                          <td className="num muted">{dateTime(job.finished_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <aside className="stack">
            <Panel title="Lifecycle">
              <ol className="lifecycle">
                {lifecycle.map((step, index) => (
                  <li
                    key={step}
                    className={`lifecycle__step ${index <= lifecycleIndex ? 'lifecycle__step--done' : ''} ${index === lifecycleIndex ? 'lifecycle__step--current' : ''}`}
                  >
                    <span className="lifecycle__marker">{index + 1}</span>
                    <span>{titleCase(step)}</span>
                  </li>
                ))}
                <li className={`lifecycle__step ${version.review_status !== 'not_submitted' ? 'lifecycle__step--done' : ''} ${version.review_status === 'submitted' ? 'lifecycle__step--current' : ''}`}>
                  <span className="lifecycle__marker">6</span>
                  <span>Review</span>
                </li>
                <li className={`lifecycle__step ${version.review_status === 'promoted' ? 'lifecycle__step--done' : ''}`}>
                  <span className="lifecycle__marker">7</span>
                  <span>Promoted</span>
                </li>
              </ol>
              {version.status === 'failed' || version.status === 'cancelled' ? (
                <p className="fineprint negative">The last run ended as {version.status}. Re-run to create a new job.</p>
              ) : null}
            </Panel>

            <Panel title="Review">
              <dl className="facts">
                <div><dt>Status</dt><dd><StatusPill value={version.review_status} /></dd></div>
                <div><dt>Completed</dt><dd>{dateTime(version.completed_at)}</dd></div>
              </dl>
              {version.review_status === 'submitted' ? (
                <Link to="/reviews" className="text-link">Open review queue <ArrowUpRight size={13} /></Link>
              ) : null}
              {version.review_status === 'approved' || version.review_status === 'promoted' ? (
                <p className="fineprint">Approved by a steward. Plan promotion is recorded in Plans.</p>
              ) : null}
            </Panel>

            <Panel title="Scenario">
              <dl className="facts">
                <div><dt>Department</dt><dd>{titleCase(scenario.department_code)}</dd></div>
                <div><dt>Cost centre</dt><dd>{scenario.cost_centre_code ?? '—'}</dd></div>
                <div><dt>Owner</dt><dd>{personLabel(scenario.owner_subject)}</dd></div>
                <div><dt>Created</dt><dd>{dateTime(scenario.created_at)}</dd></div>
              </dl>
            </Panel>
          </aside>
        </div>
      ) : null}

      <Dialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        title="Queue scenario run"
        description="The job pins the current scenario version, published model, resolved rules and dataset snapshot."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRunOpen(false)} disabled={run.isPending}>Cancel</Button>
            <Button variant="primary" icon={Play} loading={run.isPending} onClick={() => run.mutate()}>
              Queue job
            </Button>
          </>
        }
      >
        <dl className="facts">
          <div><dt>Scenario version</dt><dd className="mono small">{versionId}</dd></div>
          <div><dt>Model version</dt><dd className="mono small">{version?.model_version_id}</dd></div>
          <div><dt>Period</dt><dd>{version ? periodLabel(version.period_start, version.period_end) : '—'}</dd></div>
          <div><dt>Base</dt><dd>{version ? titleCase(version.base.base_type) : '—'}</dd></div>
        </dl>
      </Dialog>

      <Dialog
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Submit for review"
        description="A steward will review the completed scenario version before it can become the official plan."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReviewOpen(false)} disabled={submitReview.isPending}>Cancel</Button>
            <Button variant="primary" loading={submitReview.isPending} onClick={() => submitReview.mutate()}>
              Submit for review
            </Button>
          </>
        }
      >
        <Field label="Review note" htmlFor="review-note" hint="Optional context for the steward.">
          <Textarea
            id="review-note"
            rows={3}
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            placeholder="What changed and what should the steward focus on?"
          />
        </Field>
        <p className="fineprint">The completed version is immutable; changes require a new scenario version.</p>
      </Dialog>

      {version?.status === 'queued' || version?.status === 'running' ? (
        <div className="inline-status">
          <RotateCcw size={14} className="spin-slow" />
          <span>Job is {version.status}. Refresh after the worker callback to see completion.</span>
        </div>
      ) : null}
    </div>
  );
}
