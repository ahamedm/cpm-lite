import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, RotateCcw, TerminalSquare } from 'lucide-react';
import { useAuth } from '../auth';
import { cancelJob, retryJob } from '../api';
import { useJob } from '../queries';
import { dateTime, money, periodLabel, personLabel, titleCase } from '../format';
import {
  Button,
  EmptyState,
  PageHeader,
  Panel,
  ProblemBanner,
  SkeletonTable,
  StatusPill,
  useToast,
} from '../components/ui';

export function JobDetailPage() {
  const { jobId } = useParams();
  const { token } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const jobQuery = useJob(token, jobId);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    if (jobQuery.data?.data.scenario_version_id) {
      queryClient.invalidateQueries({ queryKey: ['scenario-version', jobQuery.data.data.scenario_version_id] });
      queryClient.invalidateQueries({ queryKey: ['scenario-version-jobs', jobQuery.data.data.scenario_version_id] });
    }
  }

  const cancel = useMutation({
    mutationFn: () => cancelJob(token!, jobId!),
    onSuccess: () => {
      invalidate();
      push({ tone: 'success', title: 'Cancellation recorded', detail: 'The job is now terminal.' });
    },
  });

  const retry = useMutation({
    mutationFn: () => retryJob(token!, jobId!),
    onSuccess: (result) => {
      invalidate();
      push({ tone: 'success', title: 'Retry queued', detail: 'A new job was created from the same pinned payload.' });
      navigate(`/jobs/${result.data.job_id}`);
    },
  });

  if (jobQuery.isPending) return <SkeletonTable rows={8} columns={4} />;
  if (jobQuery.error) return <ProblemBanner error={jobQuery.error} onRetry={() => jobQuery.refetch()} />;
  const job = jobQuery.data!.data;
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);
  const retryable = ['failed', 'cancelled'].includes(job.status);

  return (
    <div className="stack">
      <PageHeader
        back={{ to: '/jobs', label: 'Jobs' }}
        title={`Job ${job.job_id.slice(0, 8)}`}
        subtitle={<><span className="mono">{job.job_id}</span> · attempt {job.attempt} of {job.max_attempts}</>}
        actions={
          <>
            {!terminal ? (
              <Button variant="danger" icon={Ban} loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel
              </Button>
            ) : null}
            {retryable ? (
              <Button variant="primary" icon={RotateCcw} loading={retry.isPending} onClick={() => retry.mutate()}>
                Retry as new job
              </Button>
            ) : null}
          </>
        }
      />

      <ProblemBanner error={cancel.error ?? retry.error} />

      <div className="split split--detail">
        <div className="stack">
          <Panel
            title="Execution"
            description="Pinned inputs and terminal state for this attempt."
            action={<StatusPill value={job.status} />}
          >
            <dl className="facts facts--grid">
              <div><dt>Scenario version</dt><dd className="mono small">{job.scenario_version_id}</dd></div>
              <div><dt>Model version</dt><dd className="mono small">{job.inputs.model_version_id ?? '—'}</dd></div>
              <div><dt>Engine</dt><dd className="mono">{job.engine_version}</dd></div>
              <div><dt>Dataset snapshot</dt><dd className="mono">{job.inputs.dataset_snapshot ?? '—'}</dd></div>
              <div><dt>Period</dt><dd>{periodLabel(job.inputs.period_start ?? '', job.inputs.period_end ?? '')}</dd></div>
              <div><dt>Allocation strategy</dt><dd>{job.inputs.allocation_strategy ? titleCase(job.inputs.allocation_strategy) : '—'}</dd></div>
              <div><dt>Queued</dt><dd>{dateTime(job.queued_at)}</dd></div>
              <div><dt>Started</dt><dd>{dateTime(job.started_at)}</dd></div>
              <div><dt>Finished</dt><dd>{dateTime(job.finished_at)}</dd></div>
              <div><dt>Retry of</dt><dd className="mono small">{job.retry_of_job_id ?? '—'}</dd></div>
            </dl>
            {job.inputs.rule_version_ids?.length ? (
              <div className="rule-pins">
                <span>Pinned rules</span>
                {job.inputs.rule_version_ids.map((rule) => <code key={rule} className="inline-code">{rule.slice(0, 8)}</code>)}
              </div>
            ) : null}
          </Panel>

          {job.error ? (
            <Panel title="Failure">
              <div className="problem">
                <TerminalSquare size={16} />
                <div>
                  <strong>{job.error.code}</strong>
                  <p>{job.error.message}</p>
                  <p className="problem__meta">{job.error.retryable ? 'Retryable by policy' : 'Not retryable'}</p>
                </div>
              </div>
            </Panel>
          ) : null}

          {job.result ? (
            <>
              <Panel title="Totals" description="Result summary; bulk facts stay in the scenario store.">
                <div className="metric-strip metric-strip--panel">
                  <div className="metric"><span className="metric__label">Budget</span><strong className="metric__value">{money(job.result.totals.budget_amount, job.result.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Actual</span><strong className="metric__value">{money(job.result.totals.actual_amount, job.result.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Variance</span><strong className={`metric__value ${Number(job.result.totals.variance_amount) > 0 ? 'negative' : 'positive'}`}>{money(job.result.totals.variance_amount, job.result.totals.currency_code)}</strong></div>
                  <div className="metric"><span className="metric__label">Residual</span><strong className="metric__value">{money(job.result.allocation_summary.residual, job.result.totals.currency_code)}</strong></div>
                </div>
                <dl className="facts facts--grid">
                  <div><dt>Strategy</dt><dd>{titleCase(job.result.allocation_summary.strategy)}</dd></div>
                  <div><dt>Pool</dt><dd>{money(job.result.allocation_summary.pool_total, job.result.totals.currency_code)}</dd></div>
                  <div><dt>Allocated</dt><dd>{money(job.result.allocation_summary.allocated_total, job.result.totals.currency_code)}</dd></div>
                  <div><dt>Tolerance</dt><dd>{money(job.result.allocation_summary.tolerance, job.result.totals.currency_code)}</dd></div>
                  <div><dt>Within tolerance</dt><dd>{job.result.allocation_summary.within_tolerance ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Result URI</dt><dd className="mono small">{job.result.result_uri}</dd></div>
                </dl>
              </Panel>

              <Panel title="Rule outcomes" description="Rules evaluated inside the job.">
                {job.result.rule_outcomes.length === 0 ? (
                  <EmptyState icon={TerminalSquare} title="No rule outcomes" description="No allocation or post-calculation rules applied to this run." />
                ) : (
                  <div className="table-wrap">
                    <table className="data-table data-table--compact">
                      <thead><tr><th>Rule</th><th>Decision</th><th>Message</th></tr></thead>
                      <tbody>
                        {job.result.rule_outcomes.map((outcome) => (
                          <tr key={outcome.rule_version_id}>
                            <td className="mono">{outcome.rule_code}</td>
                            <td><StatusPill value={outcome.decision} /></td>
                            <td className="muted">{outcome.message ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          ) : (
            <Panel title="Result">
              <EmptyState
                icon={TerminalSquare}
                title={terminal ? 'No result recorded' : 'Waiting for the worker'}
                description={
                  terminal
                    ? 'This attempt ended without a result payload.'
                    : 'The scenario worker completes the job through the internal callback. Refresh after it reports.'
                }
              />
            </Panel>
          )}
        </div>

        <aside className="stack">
          <Panel title="Attempt">
            <dl className="facts">
              <div><dt>Status</dt><dd><StatusPill value={job.status} /></dd></div>
              <div><dt>Attempt</dt><dd>{job.attempt} / {job.max_attempts}</dd></div>
              <div><dt>Created by</dt><dd>{personLabel(job.created_by)}</dd></div>
              <div><dt>Created</dt><dd>{dateTime(job.created_at)}</dd></div>
            </dl>
          </Panel>
          <Panel title="Navigate">
            <div className="link-stack">
              <Link to="/jobs" className="text-link">All jobs</Link>
              <Link to="/scenarios" className="text-link">Scenarios</Link>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
