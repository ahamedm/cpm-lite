import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Rocket, ShieldOff } from 'lucide-react';
import { useAuth } from '../auth';
import {
  createRuleVersion,
  publishRuleVersion,
  retireRuleVersion,
  validateRuleVersion,
} from '../api';
import { useMe, useRule, useRuleVersion, useRuleVersions } from '../queries';
import { dateTime, titleCase } from '../format';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Panel,
  ProblemBanner,
  Select,
  SkeletonTable,
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui';

export function RuleDetailPage() {
  const { ruleId } = useParams();
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const meQuery = useMe(token);
  const ruleQuery = useRule(token, ruleId);
  const versionsQuery = useRuleVersions(token, ruleId);
  const [selectedVersionId, setSelectedVersionId] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const isSteward = Boolean(meQuery.data?.data.roles.some((role) => role === 'steward' || role === 'admin'));
  const versions = versionsQuery.data?.data.data ?? [];
  const activeVersionId = selectedVersionId ?? versions[0]?.rule_version_id;
  const versionQuery = useRuleVersion(token, activeVersionId);

  const [evaluationPoint, setEvaluationPoint] = useState('pre_submit');
  const [priority, setPriority] = useState(100);
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState('');
  const [scopeType, setScopeType] = useState('global');
  const [scopeId, setScopeId] = useState('');
  const [kind, setKind] = useState('validation');
  const [parameters, setParameters] = useState('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['rule', ruleId] });
    queryClient.invalidateQueries({ queryKey: ['rule-versions', ruleId] });
    queryClient.invalidateQueries({ queryKey: ['rule-version', activeVersionId] });
  };

  const createVersion = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(parameters) as Record<string, unknown>;
        setJsonError(null);
      } catch {
        setJsonError('Parameters must be valid JSON.');
        throw new Error('Parameters must be valid JSON.');
      }
      return createRuleVersion(token!, ruleId!, {
        evaluation_point: evaluationPoint,
        priority,
        effective_from: effectiveFrom,
        effective_to: effectiveTo || null,
        scopes: [{ scope_type: scopeType, scope_id: scopeType === 'global' ? null : scopeId }],
        definition: { schema_version: '1.0', kind, parameters: parsed },
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['rule', ruleId] });
      queryClient.invalidateQueries({ queryKey: ['rule-versions', ruleId] });
      setSelectedVersionId(result.data.rule_version_id);
      setOpen(false);
      push({ tone: 'success', title: 'Draft rule version created', detail: 'Validate it before publishing.' });
    },
  });

  const validate = useMutation({
    mutationFn: () => validateRuleVersion(token!, activeVersionId!),
    onSuccess: (result) => {
      invalidate();
      push({
        tone: result.data.valid ? 'success' : 'error',
        title: result.data.valid ? 'Rule version validated' : 'Rule validation failed',
        detail: result.data.valid ? 'The version can be published.' : `${result.data.issues.length} issue(s) found.`,
      });
    },
  });

  const publish = useMutation({
    mutationFn: () => publishRuleVersion(token!, activeVersionId!, versionQuery.data!.etag!),
    onSuccess: () => {
      invalidate();
      push({ tone: 'success', title: 'Rule version active', detail: 'New scenario validations will resolve it by scope and effective date.' });
    },
  });

  const retire = useMutation({
    mutationFn: () => retireRuleVersion(token!, activeVersionId!, versionQuery.data!.etag!),
    onSuccess: () => {
      invalidate();
      push({ tone: 'success', title: 'Rule version retired' });
    },
  });

  if (ruleQuery.isPending) return <SkeletonTable rows={7} columns={4} />;
  if (ruleQuery.error) return <ProblemBanner error={ruleQuery.error} onRetry={() => ruleQuery.refetch()} />;
  const rule = ruleQuery.data!.data;
  const version = versionQuery.data?.data;
  const canPublish = version?.status === 'draft' && version.validation?.valid;

  return (
    <div className="stack">
      <PageHeader
        back={{ to: '/rules', label: 'Rules' }}
        title={rule.name}
        subtitle={<><span className="mono">{rule.code}</span> · {rule.owner_department_code ? titleCase(rule.owner_department_code) : 'Global'}</>}
        actions={
          isSteward ? (
            <>
              {version?.status === 'draft' ? (
                <Button icon={CheckCircle2} loading={validate.isPending} onClick={() => validate.mutate()}>Validate</Button>
              ) : null}
              {canPublish ? (
                <Button variant="primary" icon={Rocket} loading={publish.isPending} onClick={() => publish.mutate()}>Publish</Button>
              ) : null}
              {version?.status === 'active' ? (
                <Button variant="danger" icon={ShieldOff} loading={retire.isPending} onClick={() => retire.mutate()}>Retire</Button>
              ) : null}
              <Button icon={Plus} onClick={() => setOpen(true)}>New version</Button>
            </>
          ) : null
        }
      />

      <ProblemBanner error={validate.error ?? publish.error ?? retire.error ?? versionQuery.error} />

      <div className="split split--detail">
        <div className="stack">
          <Panel title="Rule" description={rule.description || 'No description supplied.'}>
            <dl className="facts facts--grid">
              <div><dt>Status</dt><dd><StatusPill value={rule.status} /></dd></div>
              <div><dt>Latest version</dt><dd className="mono">{rule.latest_version ? `v${rule.latest_version.version_number}` : '—'}</dd></div>
              <div><dt>Owner</dt><dd>{rule.owner_department_code ? titleCase(rule.owner_department_code) : 'Global'}</dd></div>
              <div><dt>Updated</dt><dd>{dateTime(rule.updated_at)}</dd></div>
            </dl>
          </Panel>

          <Panel title="Versions" description="Rules are immutable once active; edits create a new version.">
            {versionsQuery.isPending ? (
              <SkeletonTable rows={4} columns={4} />
            ) : versions.length === 0 ? (
              <EmptyState icon={Plus} title="No versions yet" description="Add a scoped version, validate it, then publish." />
            ) : (
              <div className="table-wrap">
                <table className="data-table data-table--compact">
                  <thead><tr><th>Version</th><th>Status</th><th>Point</th><th>Effective</th></tr></thead>
                  <tbody>
                    {versions.map((entry) => (
                      <tr key={entry.rule_version_id} className={entry.rule_version_id === activeVersionId ? 'row--selected' : ''}>
                        <td>
                          <button type="button" className="link-button mono" onClick={() => setSelectedVersionId(entry.rule_version_id)}>
                            v{entry.version_number}
                          </button>
                        </td>
                        <td><StatusPill value={entry.status} /></td>
                        <td className="muted">{titleCase(entry.evaluation_point)}</td>
                        <td className="muted">{entry.effective_from}{entry.effective_to ? ` → ${entry.effective_to}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {version ? (
            <Panel title={`Version ${version.version_number}`} description="Scope, effective window and declarative parameters.">
              <dl className="facts facts--grid">
                <div><dt>Status</dt><dd><StatusPill value={version.status} /></dd></div>
                <div><dt>Evaluation point</dt><dd>{titleCase(version.evaluation_point)}</dd></div>
                <div><dt>Priority</dt><dd>{version.priority}</dd></div>
                <div><dt>Effective</dt><dd>{version.effective_from}{version.effective_to ? ` → ${version.effective_to}` : ' → open'}</dd></div>
                <div><dt>Scope</dt><dd>{version.scopes.map((scope) => scope.scope_id ? `${titleCase(scope.scope_type)}: ${scope.scope_id}` : titleCase(scope.scope_type)).join(', ')}</dd></div>
                <div><dt>Kind</dt><dd>{titleCase(version.definition.kind)}</dd></div>
              </dl>
              <pre className="json-view">{JSON.stringify(version.definition.parameters, null, 2)}</pre>
              {version.validation ? (
                <div className={`validation validation--inline ${version.validation.valid ? 'validation--ok' : 'validation--bad'}`}>
                  <strong>{version.validation.valid ? 'Validation passed' : 'Validation failed'}</strong>
                  <span>{version.validation.issues.length} issue(s)</span>
                </div>
              ) : (
                <p className="fineprint">Not validated. Publishing is blocked until validation passes.</p>
              )}
            </Panel>
          ) : null}
        </div>

        <aside className="stack">
          <Panel title="Effective window">
            <p className="panel-copy">Resolution uses scope, effective date and priority. The resolved versions are pinned into every job payload.</p>
          </Panel>
          <Panel title="Authoring">
            <p className="panel-copy">Only stewards can create or publish rules. Retiring an active version keeps its history intact.</p>
          </Panel>
        </aside>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`New version · ${rule.name}`}
        description="Create a draft scoped rule version. Parameters are declarative data, never executable code."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={createVersion.isPending}>Cancel</Button>
            <Button variant="primary" loading={createVersion.isPending} onClick={() => createVersion.mutate()}>Create draft</Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Evaluation point" htmlFor="rule-point">
            <Select id="rule-point" value={evaluationPoint} onChange={(event) => setEvaluationPoint(event.target.value)}>
              <option value="pre_submit">Pre-submit</option>
              <option value="allocation">Allocation</option>
              <option value="post_calculation">Post-calculation</option>
              <option value="promotion">Promotion</option>
            </Select>
          </Field>
          <Field label="Priority" htmlFor="rule-priority" hint="Higher priority wins on overlapping scopes.">
            <Input id="rule-priority" type="number" value={priority} onChange={(event) => setPriority(Number(event.target.value))} />
          </Field>
          <Field label="Effective from" htmlFor="rule-from">
            <Input id="rule-from" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
          </Field>
          <Field label="Effective to" htmlFor="rule-to" hint="Leave blank for open-ended.">
            <Input id="rule-to" type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} />
          </Field>
          <Field label="Scope" htmlFor="rule-scope">
            <Select id="rule-scope" value={scopeType} onChange={(event) => setScopeType(event.target.value)}>
              <option value="global">Global</option>
              <option value="department">Department</option>
              <option value="cost_centre">Cost centre</option>
              <option value="scenario_type">Scenario type</option>
            </Select>
          </Field>
          {scopeType !== 'global' ? (
            <Field label="Scope id" htmlFor="rule-scope-id">
              <Input id="rule-scope-id" value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder={scopeType === 'scenario_type' ? 'budget' : 'finance'} />
            </Field>
          ) : null}
          <Field label="Rule kind" htmlFor="rule-kind">
            <Select id="rule-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="validation">Validation</option>
              <option value="allocation">Allocation</option>
              <option value="promotion">Promotion</option>
            </Select>
          </Field>
        </div>
        <Field label="Parameters (JSON)" htmlFor="rule-parameters" hint={jsonError ?? 'Declarative parameters validated by the rule kind.'}>
          <Textarea id="rule-parameters" rows={7} value={parameters} onChange={(event) => setParameters(event.target.value)} spellCheck={false} className="mono" />
        </Field>
        {kind === 'validation' ? (
          <p className="fineprint">Validation example: <code className="inline-code">{'{"required_driver_codes":["growth_pct"],"min_driver_count":1}'}</code></p>
        ) : null}
        <ProblemBanner error={createVersion.error} />
      </Dialog>
    </div>
  );
}
