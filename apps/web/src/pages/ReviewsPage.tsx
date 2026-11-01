import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, RefreshCcw } from 'lucide-react';
import { useAuth } from '../auth';
import { useSubmissions } from '../queries';
import { dateTime, countLabel, personLabel } from '../format';
import { Button, EmptyState, PageHeader, ProblemBanner, Select, SkeletonTable, StatusPill } from '../components/ui';

export function ReviewsPage() {
  const { token } = useAuth();
  const [status, setStatus] = useState('');
  const submissions = useSubmissions(token, { limit: 50, status: status || undefined });
  const items = submissions.data?.items ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Reviews"
        subtitle="Completed scenario versions submitted for a steward decision."
        actions={
          <Button icon={RefreshCcw} loading={submissions.isFetching} onClick={() => submissions.refetch()}>
            Refresh
          </Button>
        }
      />
      <ProblemBanner error={submissions.error} onRetry={() => submissions.refetch()} />

      <div className="toolbar">
        <div className="filter-field">
          <label htmlFor="review-status">Status</label>
          <Select id="review-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="changes_requested">Changes requested</option>
            <option value="promoted">Promoted</option>
          </Select>
        </div>
        <span className="toolbar__meta">{submissions.isPending ? 'Loading' : countLabel(items.length, 'submission', submissions.data?.hasMore)}</span>
      </div>

      {submissions.isPending ? (
        <SkeletonTable rows={6} columns={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Nothing in this review view"
          description="Submit a completed scenario for review; it will appear here for a steward decision."
          action={<Link className="button button--secondary button--sm" to="/scenarios">Open scenarios</Link>}
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Submission</th>
                  <th>Submitted by</th>
                  <th>Status</th>
                  <th>Decided by</th>
                  <th className="num">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {items.map((submission) => (
                  <tr key={submission.submission_id}>
                    <td>
                      <Link className="mono text-link" to={`/reviews/${submission.submission_id}`}>
                        {submission.submission_id.slice(0, 8)}
                      </Link>
                      <span className="cell-sub mono">{submission.scenario_version_id.slice(0, 8)}</span>
                    </td>
                    <td>{personLabel(submission.submitted_by)}</td>
                    <td><StatusPill value={submission.status} /></td>
                    <td className="muted">{personLabel(submission.decided_by)}</td>
                    <td className="num muted">{dateTime(submission.submitted_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {submissions.data?.hasMore ? (
            <div className="load-more">
              <Button size="sm" loading={submissions.isFetchingNextPage} onClick={() => submissions.fetchNextPage()}>Load more submissions</Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
