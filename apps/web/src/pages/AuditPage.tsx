import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import { useAuth } from '../auth';
import { useAuditEvents, useMe } from '../queries';
import { dateTime, countLabel, personLabel, shortId, titleCase } from '../format';
import { Button, EmptyState, PageHeader, ProblemBanner, Select, SkeletonTable } from '../components/ui';

export function AuditPage() {
  const { token } = useAuth();
  const meQuery = useMe(token);
  const [entityType, setEntityType] = useState('');
  const isSteward = Boolean(meQuery.data?.data.roles.some((role) => role === 'steward' || role === 'admin'));
  const audit = useAuditEvents(token, { limit: 50, entity_type: entityType || undefined }, isSteward);
  const items = audit.data?.items ?? [];

  if (!isSteward && meQuery.data) {
    return (
      <div className="stack">
        <PageHeader title="Audit" subtitle="Append-only trail of governed actions." />
        <EmptyState
          icon={ScrollText}
          title="Steward access required"
          description="Audit events are restricted to stewards and administrators because they can include cross-department actions."
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader
        title="Audit"
        subtitle="Append-only trail: actor, action, entity, before/after state and correlation id."
      />
      <ProblemBanner error={audit.error} onRetry={() => audit.refetch()} />

      <div className="toolbar">
        <div className="filter-field">
          <label htmlFor="audit-entity">Entity</label>
          <Select id="audit-entity" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
            <option value="">All entities</option>
            <option value="model">Model</option>
            <option value="model_version">Model version</option>
            <option value="scenario">Scenario</option>
            <option value="scenario_version">Scenario version</option>
            <option value="job">Job</option>
            <option value="rule">Rule</option>
            <option value="rule_version">Rule version</option>
            <option value="submission">Submission</option>
            <option value="promotion">Promotion</option>
            <option value="plan">Plan</option>
            <option value="plan_version">Plan version</option>
          </Select>
        </div>
        <span className="toolbar__meta">{audit.isPending ? 'Loading' : countLabel(items.length, 'event', audit.data?.hasMore)}</span>
      </div>

      {audit.isPending ? (
        <SkeletonTable rows={8} columns={5} />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit events" description="Governed actions will appear here as they occur." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table audit-table">
              <thead>
                <tr><th>Occurred</th><th>Actor</th><th>Action</th><th>Entity</th><th>Correlation</th></tr>
              </thead>
              <tbody>
                {items.map((event) => (
                  <tr key={event.audit_event_id}>
                    <td className="muted">{dateTime(event.occurred_at)}</td>
                    <td>
                      {personLabel(event.actor_subject)}
                      <span className="cell-sub">{event.actor_department_code ? titleCase(event.actor_department_code) : '—'}</span>
                    </td>
                    <td>
              <strong>{event.action.replace(/[._]/g, ' ')}</strong>
                      {event.after_state ? (
                        <details className="audit-detail">
                          <summary>After state</summary>
                          <pre className="json-view">{JSON.stringify(event.after_state, null, 2)}</pre>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      {titleCase(event.entity_type)}
                      <span className="cell-sub mono">{shortId(event.entity_id)}</span>
                    </td>
                    <td className="mono muted small">{shortId(event.correlation_id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.data?.hasMore ? (
            <div className="load-more">
              <Button size="sm" loading={audit.isFetchingNextPage} onClick={() => audit.fetchNextPage()}>Load more events</Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
