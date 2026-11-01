import { useDeferredValue, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FlaskConical, Plus, Search } from 'lucide-react';
import { useAuth } from '../auth';
import { useScenarios } from '../queries';
import { date, countLabel, titleCase } from '../format';
import { Button, EmptyState, Input, PageHeader, ProblemBanner, SkeletonTable, StatusPill } from '../components/ui';
import { ScenarioComposerDialog } from '../components/ScenarioComposer';

export function ScenariosPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [composerOpen, setComposerOpen] = useState(params.get('new') === '1');
  const scenarios = useScenarios(token, { limit: 50, q: deferredSearch || undefined });
  const items = scenarios.data?.items ?? [];

  function closeComposer() {
    setComposerOpen(false);
    if (params.get('new')) {
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Scenarios"
        subtitle="What-if versions pinned to a published model, a base and a period."
        actions={
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => {
              setComposerOpen(true);
              setParams({ new: '1' }, { replace: true });
            }}
          >
            New scenario
          </Button>
        }
      />

      <ProblemBanner error={scenarios.error} onRetry={() => scenarios.refetch()} />

      <div className="toolbar">
        <div className="search-field">
          <Search size={14} aria-hidden />
          <Input aria-label="Search scenarios" placeholder="Search by name or code" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <span className="toolbar__meta">
          {scenarios.isPending ? 'Loading' : countLabel(items.length, 'scenario', scenarios.data?.hasMore)}
        </span>
      </div>

      {scenarios.isPending ? (
        <SkeletonTable rows={6} columns={6} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title={deferredSearch ? 'No scenarios match that search' : 'No scenarios yet'}
          description={
            deferredSearch
              ? 'Try a different name or code, or clear the search.'
              : 'Create a budget or forecast from a published model to start planning.'
          }
          action={
            deferredSearch ? (
              <Button size="sm" onClick={() => setSearch('')}>Clear search</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Type</th>
                  <th>Department</th>
                  <th>Run</th>
                  <th>Review</th>
                  <th className="num">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((scenario) => (
                  <tr key={scenario.scenario_id}>
                    <td>
                      <Link className="primary-cell" to={`/scenarios/${scenario.scenario_id}`}>
                        {scenario.name}
                        <span>{scenario.code}</span>
                      </Link>
                    </td>
                    <td className="capitalize">{scenario.scenario_type}</td>
                    <td>{titleCase(scenario.department_code)}</td>
                    <td><StatusPill value={scenario.latest_version.status} /></td>
                    <td><StatusPill value={scenario.latest_version.review_status} /></td>
                    <td className="num muted">{date(scenario.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {scenarios.data?.hasMore ? (
            <div className="load-more">
              <Button size="sm" loading={scenarios.isFetchingNextPage} onClick={() => scenarios.fetchNextPage()}>
                Load more scenarios
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ScenarioComposerDialog
        open={composerOpen}
        onClose={closeComposer}
        onCreated={(scenarioId) => navigate(`/scenarios/${scenarioId}`)}
      />
    </div>
  );
}
