import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CheckCircle2, RefreshCcw, Rocket } from 'lucide-react';
import { useAuth } from '../auth';
import { createModelVersion, publishModelVersion, validateModelVersion } from '../api';
import { useModel, useModelVersion } from '../queries';
import { dateTime, shortId, titleCase } from '../format';
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

export function ModelDetailPage() {
  const { modelId } = useParams();
  const { token } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const modelQuery = useModel(token, modelId);
  const latestVersionId = modelQuery.data?.data.latest_version.model_version_id;
  const versionQuery = useModelVersion(token, latestVersionId);

  const validate = useMutation({
    mutationFn: () => validateModelVersion(token!, latestVersionId!),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['model', modelId] });
      queryClient.invalidateQueries({ queryKey: ['model-version', latestVersionId] });
      push({
        tone: result.data.valid ? 'success' : 'error',
        title: result.data.valid ? 'Model validated' : 'Validation found issues',
        detail: result.data.valid
          ? 'The version can now be published.'
          : `${result.data.issues.length} issue${result.data.issues.length === 1 ? '' : 's'} need attention.`,
      });
    },
  });

  const publish = useMutation({
    mutationFn: () => publishModelVersion(token!, latestVersionId!, versionQuery.data!.etag!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model', modelId] });
      queryClient.invalidateQueries({ queryKey: ['model-version', latestVersionId] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      push({ tone: 'success', title: 'Model published', detail: 'Cube refresh is queued.' });
    },
  });

  const nextVersion = useMutation({
    mutationFn: () =>
      createModelVersion(token!, modelId!, {
        from_version_id: latestVersionId,
        definition: versionQuery.data!.data.definition,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['model', modelId] });
      navigate(`/models/${modelId}`);
      push({ tone: 'success', title: 'Draft version created', detail: `Version ${result.data.version_number} is ready to edit.` });
    },
  });

  if (modelQuery.isPending) return <SkeletonTable rows={8} columns={4} />;
  if (modelQuery.error) return <ProblemBanner error={modelQuery.error} onRetry={() => modelQuery.refetch()} />;
  const model = modelQuery.data!.data;

  return (
    <div className="stack">
      <PageHeader
        back={{ to: '/models', label: 'Models' }}
        title={model.name}
        subtitle={
          <>
            <span className="mono">{model.code}</span> · {titleCase(model.department_code)} · {model.visibility} model
          </>
        }
        actions={
          <>
            {versionQuery.data && (versionQuery.data.data.status === 'draft' || versionQuery.data.data.status === 'validated') ? (
              <Button
                icon={CheckCircle2}
                loading={validate.isPending}
                onClick={() => validate.mutate()}
              >
                Validate
              </Button>
            ) : null}
            {versionQuery.data?.data.status === 'validated' ? (
              <Button variant="primary" icon={Rocket} loading={publish.isPending} onClick={() => publish.mutate()}>
                Publish
              </Button>
            ) : null}
            {versionQuery.data?.data.status === 'published' ? (
              <Button icon={RefreshCcw} loading={nextVersion.isPending} onClick={() => nextVersion.mutate()}>
                Next version
              </Button>
            ) : null}
          </>
        }
      />

      <ProblemBanner error={validate.error ?? publish.error ?? nextVersion.error} />
      {versionQuery.isPending ? <SkeletonTable rows={7} columns={4} /> : null}
      {versionQuery.error ? <ProblemBanner error={versionQuery.error} onRetry={() => versionQuery.refetch()} /> : null}

      {versionQuery.data ? (
        <div className="split split--detail">
          <div className="stack">
            <Panel title="Dimensions" description="Columns users group and filter by.">
              <div className="table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr><th>Code</th><th>Name</th><th>Type</th><th>Expression</th></tr>
                  </thead>
                  <tbody>
                    {versionQuery.data.data.definition.dimensions.map((dimension) => (
                      <tr key={dimension.code}>
                        <td className="mono">{dimension.code}</td>
                        <td>{dimension.name}</td>
                        <td className="muted">{dimension.data_type}</td>
                        <td className="mono muted">{dimension.expression}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Measures" description="Numeric outputs exposed through Cube.">
              <div className="table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr><th>Code</th><th>Name</th><th>Aggregation</th><th>Expression</th><th>Format</th></tr>
                  </thead>
                  <tbody>
                    {versionQuery.data.data.definition.measures.map((measure) => (
                      <tr key={measure.code}>
                        <td className="mono">{measure.code}</td>
                        <td>{measure.name}</td>
                        <td className="muted">{measure.aggregation.replace(/_/g, ' ')}</td>
                        <td className="mono muted">{measure.expression}</td>
                        <td className="muted">{measure.format}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel
              title="Validation"
              description="Structural and semantic checks run against this draft."
              action={
                versionQuery.data.data.validation ? (
                  <StatusPill value={versionQuery.data.data.validation.valid ? 'validated' : 'failed'} label={versionQuery.data.data.validation.valid ? 'Passing' : 'Needs attention'} />
                ) : null
              }
            >
              {!versionQuery.data.data.validation ? (
                <EmptyState icon={CheckCircle2} title="Not validated yet" description="Run validation to check the definition before publishing." />
              ) : (
                <div className="validation">
                  <p className="validation__summary">
                    {versionQuery.data.data.validation.valid
                      ? 'No blocking issues. This version is ready to publish.'
                      : 'Publishing is blocked until the issues below are resolved.'}
                  </p>
                  {versionQuery.data.data.validation.issues.length ? (
                    <ul className="issue-list">
                      {versionQuery.data.data.validation.issues.map((issue) => (
                        <li key={`${issue.path}-${issue.code}`}>
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
          </div>

          <aside className="stack">
            <Panel title="Version">
              <dl className="facts">
                <div><dt>Status</dt><dd><StatusPill value={versionQuery.data.data.status} /></dd></div>
                <div><dt>Version</dt><dd className="mono">v{versionQuery.data.data.version_number}</dd></div>
                <div><dt>Created</dt><dd>{dateTime(versionQuery.data.data.created_at)}</dd></div>
                <div><dt>Published</dt><dd>{dateTime(versionQuery.data.data.published_at)}</dd></div>
                <div><dt>Cube refresh</dt><dd><StatusPill value={versionQuery.data.data.cube_refresh.status} /></dd></div>
                <div><dt>Model ID</dt><dd className="mono small" title={model.model_id}>{shortId(model.model_id)}</dd></div>
              </dl>
              {versionQuery.data.data.cube_refresh.error ? (
                <p className="fineprint negative">{versionQuery.data.data.cube_refresh.error}</p>
              ) : null}
            </Panel>

            <Panel title="Next">
              <p className="panel-copy">
                {versionQuery.data.data.status === 'published'
                  ? 'Create a new draft when the model needs to change. Running scenarios stay pinned to this published version.'
                  : 'Validate, then publish. Cube refresh runs asynchronously; the status above is the source of truth.'}
              </p>
              <Link to="/variance" className="text-link">
                Open variance <ArrowUpRight size={13} />
              </Link>
            </Panel>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
