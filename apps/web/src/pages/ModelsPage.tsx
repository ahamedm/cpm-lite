import { useDeferredValue, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Layers3, Plus, Search } from 'lucide-react';
import { useAuth } from '../auth';
import { useModels } from '../queries';
import { date, countLabel, titleCase } from '../format';
import { Button, EmptyState, Input, PageHeader, ProblemBanner, SkeletonTable, StatusPill } from '../components/ui';
import { ModelComposerDialog } from '../components/ModelComposer';

export function ModelsPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [composerOpen, setComposerOpen] = useState(false);
  const models = useModels(token, { limit: 50, q: deferredSearch || undefined });
  const items = models.data?.items ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Models"
        subtitle="Versioned dimensions, measures and joins exposed through the semantic layer."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setComposerOpen(true)}>
            New model
          </Button>
        }
      />

      <ProblemBanner error={models.error} onRetry={() => models.refetch()} />

      <div className="toolbar">
        <div className="search-field">
          <Search size={14} aria-hidden />
          <Input
            aria-label="Search models"
            placeholder="Search by name or code"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="toolbar__meta">
          {models.isPending ? 'Loading' : countLabel(items.length, 'model', models.data?.hasMore)}
        </span>
      </div>

      {models.isPending ? (
        <SkeletonTable rows={6} columns={6} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Layers3}
          title={deferredSearch ? 'No models match that search' : 'No models yet'}
          description={
            deferredSearch
              ? 'Try a different name or code, or clear the search.'
              : 'Start with a governed budget model built from dimensions and measures.'
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
                  <th>Model</th>
                  <th>Department</th>
                  <th>Visibility</th>
                  <th>Latest version</th>
                  <th>Cube refresh</th>
                  <th className="num">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((model) => (
                  <tr key={model.model_id}>
                    <td>
                      <Link className="primary-cell" to={`/models/${model.model_id}`}>
                        {model.name}
                        <span>{model.code}</span>
                      </Link>
                    </td>
                    <td>{titleCase(model.department_code)}</td>
                    <td className="capitalize">{model.visibility}</td>
                    <td>
                      <span className="inline-pair">
                        <StatusPill value={model.latest_version.status} />
                        <span className="mono muted">v{model.latest_version.version_number}</span>
                      </span>
                    </td>
                    <td><StatusPill value={model.latest_version.cube_refresh_status} /></td>
                    <td className="num muted">{date(model.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {models.data?.hasMore ? (
            <div className="load-more">
              <Button size="sm" loading={models.isFetchingNextPage} onClick={() => models.fetchNextPage()}>
                Load more models
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ModelComposerDialog
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={(modelId) => navigate(`/models/${modelId}`)}
      />
    </div>
  );
}
