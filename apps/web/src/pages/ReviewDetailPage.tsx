import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCheck, Send, X } from 'lucide-react';
import { useAuth } from '../auth';
import { decideSubmission, promoteSubmission } from '../api';
import { useMe, usePlans, useScenarioVersion, useSubmission } from '../queries';
import { dateTime, money, periodLabel, personLabel, titleCase } from '../format';
import {
  Button,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  ProblemBanner,
  Select,
  SkeletonTable,
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui';

type Decision = 'approve' | 'reject' | 'request_changes';

export function ReviewDetailPage() {
  const { submissionId } = useParams();
  const { token } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const meQuery = useMe(token);
  const submissionQuery = useSubmission(token, submissionId);
  const versionId = submissionQuery.data?.data.scenario_version_id;
  const versionQuery = useScenarioVersion(token, versionId);
  const plans = usePlans(token, { limit: 100 });
  const [decision, setDecision] = useState<Decision>('approve');
  const [comment, setComment] = useState('');
  const [planId, setPlanId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

  const isSteward = Boolean(meQuery.data?.data.roles.some((role) => role === 'steward' || role === 'admin'));

  const decide = useMutation({
    mutationFn: () => decideSubmission(token!, submissionId!, submissionQuery.data!.etag!, decision, comment.trim() || null),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['submission', submissionId] });
      queryClient.invalidateQueries({ queryKey: ['submissions'] });
      queryClient.invalidateQueries({ queryKey: ['scenario-version', versionId] });
      push({ tone: 'success', title: 'Decision recorded', detail: `Submission is now ${result.data.status.replace(/_/g, ' ')}.` });
    },
  });

  const promote = useMutation({
    mutationFn: () =>
      promoteSubmission(
        token!,
        submissionId!,
        submissionQuery.data!.etag!,
        planId,
        effectiveFrom
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['submission', submissionId] });
      queryClient.invalidateQueries({ queryKey: ['submissions'] });
      queryClient.invalidateQueries({ queryKey: ['scenario-version', versionId] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      push({ tone: 'success', title: 'Promotion complete', detail: 'A new plan version is published.' });
      if (result.data.plan_id) navigate(`/plans/${result.data.plan_id}`);
    },
  });

  const selectedPlan = useMemo(
    () => (plans.data?.items ?? []).find((plan) => plan.plan_id === planId),
    [plans.data, planId]
  );

  if (submissionQuery.isPending) return <SkeletonTable rows={7} columns={4} />;
  if (submissionQuery.error) return <ProblemBanner error={submissionQuery.error} onRetry={() => submissionQuery.refetch()} />;
  const submission = submissionQuery.data!.data;
  const version = versionQuery.data?.data;
  const canDecide = isSteward && submission.status === 'submitted';
  const canPromote = isSteward && submission.status === 'approved';
  const commentRequired = decision !== 'approve' && !comment.trim();

  return (
    <div className="stack">
      <PageHeader
        back={{ to: '/reviews', label: 'Reviews' }}
        title="Review submission"
        subtitle={<><span className="mono">{submission.submission_id}</span> · {dateTime(submission.submitted_at)}</>}
        actions={<StatusPill value={submission.status} />}
      />

      <ProblemBanner error={decide.error ?? promote.error ?? versionQuery.error} />

      <div className="split split--detail">
        <div className="stack">
          <Panel title="Scenario version" description="The immutable completed snapshot under review.">
            {versionQuery.isPending ? (
              <SkeletonTable rows={4} columns={3} />
            ) : !version ? (
              <EmptyState icon={ClipboardCheck} title="Scenario version unavailable" description="The linked scenario version is outside your scope." />
            ) : (
              <>
                <dl className="facts facts--grid">
                  <div><dt>Scenario</dt><dd><Link className="text-link" to={`/scenarios/${version.scenario_id}`}>Open scenario</Link></dd></div>
                  <div><dt>Version</dt><dd className="mono">v{version.version_number}</dd></div>
                  <div><dt>Period</dt><dd>{periodLabel(version.period_start, version.period_end)}</dd></div>
                  <div><dt>Currency</dt><dd>{version.currency_code}</dd></div>
                  <div><dt>Execution</dt><dd><StatusPill value={version.status} /></dd></div>
                  <div><dt>Review</dt><dd><StatusPill value={version.review_status} /></dd></div>
                </dl>
                {version.result ? (
                  <div className="metric-strip metric-strip--panel">
                    <div className="metric"><span className="metric__label">Budget</span><strong className="metric__value">{money(version.result.totals.budget_amount, version.result.totals.currency_code)}</strong></div>
                    <div className="metric"><span className="metric__label">Actual</span><strong className="metric__value">{money(version.result.totals.actual_amount, version.result.totals.currency_code)}</strong></div>
                    <div className="metric"><span className="metric__label">Variance</span><strong className={`metric__value ${Number(version.result.totals.variance_amount) > 0 ? 'negative' : 'positive'}`}>{money(version.result.totals.variance_amount, version.result.totals.currency_code)}</strong></div>
                    <div className="metric"><span className="metric__label">Residual</span><strong className="metric__value">{money(version.result.allocation_summary.residual, version.result.totals.currency_code)}</strong></div>
                  </div>
                ) : null}
              </>
            )}
          </Panel>

          <Panel title="Submission" description="Note supplied by the submitter.">
            <p className="prose">{submission.note || 'No note was supplied.'}</p>
            <dl className="facts facts--grid">
              <div><dt>Submitted by</dt><dd>{personLabel(submission.submitted_by)}</dd></div>
              <div><dt>Submitted</dt><dd>{dateTime(submission.submitted_at)}</dd></div>
              <div><dt>Decided by</dt><dd>{personLabel(submission.decided_by)}</dd></div>
              <div><dt>Decided</dt><dd>{dateTime(submission.decided_at)}</dd></div>
            </dl>
            {submission.decision_comment ? <p className="prose prose--quote">{submission.decision_comment}</p> : null}
          </Panel>

          {canDecide ? (
            <Panel title="Decision" description="Approve, reject, or return for changes. Reject and changes requested require a comment.">
              <div className="decision-row" role="group" aria-label="Decision">
                {([
                  ['approve', 'Approve', Check],
                  ['request_changes', 'Request changes', Send],
                  ['reject', 'Reject', X],
                ] as const).map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    className={`decision ${decision === value ? 'decision--active' : ''}`}
                    aria-pressed={decision === value}
                    onClick={() => setDecision(value)}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </div>
              <Field label="Comment" htmlFor="decision-comment" hint={commentRequired ? 'Required for this decision.' : 'Optional for approval.'}>
                <Textarea id="decision-comment" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What did you check, and what should happen next?" />
              </Field>
              <div className="form-actions">
                <Button
                  variant="primary"
                  loading={decide.isPending}
                  disabled={commentRequired}
                  onClick={() => decide.mutate()}
                >
                  Record decision
                </Button>
              </div>
            </Panel>
          ) : null}

          {canPromote ? (
            <Panel title="Promote to plan" description="Promotion creates a new immutable plan version and marks this submission promoted.">
              {plans.isPending ? (
                <SkeletonTable rows={3} columns={2} />
              ) : (plans.data?.items.length ?? 0) === 0 ? (
                <EmptyState
                  icon={ClipboardCheck}
                  title="No plan exists"
                  description="Create a plan shell first, then promote this approved submission into it."
                  action={<Link className="button button--secondary button--sm" to="/plans">Open plans</Link>}
                />
              ) : (
                <>
                  <div className="form-grid">
                    <Field label="Plan" htmlFor="promotion-plan">
                      <Select id="promotion-plan" value={planId} onChange={(event) => setPlanId(event.target.value)}>
                        <option value="">Choose a plan</option>
                        {(plans.data?.items ?? []).map((plan) => (
                          <option key={plan.plan_id} value={plan.plan_id}>{plan.name} · FY{plan.fiscal_year}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Effective from" htmlFor="promotion-effective">
                      <input className="input" id="promotion-effective" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
                    </Field>
                  </div>
                  {selectedPlan ? <p className="fineprint">Target: {selectedPlan.name} · {titleCase(selectedPlan.department_code)}</p> : null}
                  <div className="form-actions">
                    <Button variant="primary" loading={promote.isPending} disabled={!planId} onClick={() => promote.mutate()}>
                      Promote submission
                    </Button>
                  </div>
                </>
              )}
            </Panel>
          ) : null}
        </div>

        <aside className="stack">
          <Panel title="Status">
            <dl className="facts">
              <div><dt>Submission</dt><dd><StatusPill value={submission.status} /></dd></div>
              <div><dt>Promotion</dt><dd className="mono small">{submission.promotion_id ?? '—'}</dd></div>
              <div><dt>Role check</dt><dd>{isSteward ? 'Steward' : 'Business user (read-only)'}</dd></div>
            </dl>
          </Panel>
          <Panel title="Governance">
            <p className="panel-copy">Only an approved submission can be promoted, and only by a steward. Plan versions are immutable.</p>
            <Link to="/plans" className="text-link">Open plans</Link>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
