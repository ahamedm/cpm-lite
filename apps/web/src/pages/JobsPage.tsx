import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, RefreshCcw } from 'lucide-react';
import { useAuth } from '../auth';
import { useJobs } from '../queries';
import { dateTime, countLabel, titleCase } from '../format';
import { Button, EmptyState, PageHeader, ProblemBanner, Select, SkeletonTable, StatusPill } from '../components/ui';

export function JobsPage() {
  const { token } = useAuth();
  const [status, setStatus] = useState('');
  const jobs = useJobs(token, { limit: 50, status: status || undefined });
  const items = jobs.data?.items ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Jobs"
        subtitle="Scenario executions and their pinned inputs. A job stays queued until the scenario worker claims it."
        actions={
          <Button icon={RefreshCcw} loading={jobs.isFetching} onClick={() => jobs.refetch()}>
            Refresh
          </Button>
        }
      />

      <ProblemBanner error={jobs.error} onRetry={() => jobs.refetch()} />

      <div className="toolbar">
        <div className="filter-field">
          <label htmlFor="job-status">Status</label>
          <Select id="job-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </div>
        <span className="toolbar__meta">{jobs.isPending ? 'Loading' : countLabel(items.length, 'job', jobs.data?.hasMore)}</span>
      </div>

      {jobs.isPending ? (
        <SkeletonTable rows={7} columns={6} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No jobs in this view"
          description="Queue a scenario run from a validated scenario version to create the first job."
          action={<Link className="button button--secondary button--sm" to="/scenarios">Open scenarios</Link>}
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Scenario version</th>
                  <th>Status</th>
                  <th className="num">Attempt</th>
                  <th className="num">Queued</th>
                  <th className="num">Finished</th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr key={job.job_id}>
                    <td><Link className="mono text-link" to={`/jobs/${job.job_id}`}>{job.job_id.slice(0, 8)}</Link></td>
                    <td className="mono muted">{job.scenario_version_id.slice(0, 8)}</td>
                    <td><StatusPill value={job.status} /></td>
                    <td className="num">{job.attempt}</td>
                    <td className="num muted">{dateTime(job.queued_at)}</td>
                    <td className="num muted">{dateTime(job.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {jobs.data?.hasMore ? (
            <div className="load-more">
              <Button size="sm" loading={jobs.isFetchingNextPage} onClick={() => jobs.fetchNextPage()}>Load more jobs</Button>
            </div>
          ) : null}
        </>
      )}

      <p className="fineprint">
        Queued jobs are completed by the scenario worker callback: <code className="inline-code">POST /internal/v1/jobs/{'{job_id}'}/status</code> with <code className="inline-code">X-CPM-Service-Token</code>.
      </p>
    </div>
  );
}
