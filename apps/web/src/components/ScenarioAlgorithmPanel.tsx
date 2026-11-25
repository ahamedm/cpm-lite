import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Braces, Eye, EyeOff, Pencil, Plus, X } from 'lucide-react';
import { useAuth } from '../auth';
import { compileCalculationSource, updateScenarioVersion } from '../api';
import type {
  CalculationSourceCompileResponse,
  ScenarioVersion,
  ValidationIssue,
} from '../types';
import { shortId } from '../format';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Panel,
  ProblemBanner,
  Select,
  StatusPill,
  Textarea,
  useToast,
} from './ui';
import {
  authoringSourceFromVersion,
  buildSource,
  settingsJsonFromSource,
  stageDetail,
  stageLabel,
} from './scenarioSource';

const COLUMN_TYPES = [
  'decimal(18,2)',
  'decimal(18,4)',
  'decimal(18,6)',
  'decimal(38,6)',
  'integer',
  'string',
  'date',
];

interface TypeRow {
  name: string;
  type: string;
}

function isPlanIssue(issue: ValidationIssue): boolean {
  const path = issue.path || '';
  return ['/format', '/grain', '/pins', '/drivers', '/stages', '/prql', '/types', '/source', '/columns'].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

export function ScenarioAlgorithmPanel({
  version,
  etag,
  canEdit,
  onChanged,
}: {
  version: ScenarioVersion;
  etag: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { token } = useAuth();
  const { push } = useToast();
  const [jsonOpen, setJsonOpen] = useState(false);
  const [prqlOpen, setPrqlOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [mode, setMode] = useState<'prql' | 'json'>('prql');
  const [draftJson, setDraftJson] = useState('');
  const [draftPrql, setDraftPrql] = useState('');
  const [settingsJson, setSettingsJson] = useState('');
  const [typeRows, setTypeRows] = useState<TypeRow[]>([]);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CalculationSourceCompileResponse | null>(null);

  const plan = version.calculation_plan;
  const source = version.calculation_source;
  const planValidation = version.validation?.calculation_plan ?? null;
  const planIssues = version.validation?.issues.filter(isPlanIssue) ?? [];
  const planHash = version.calculation_plan_hash ?? planValidation?.plan_hash ?? null;
  const compilerVersion =
    version.calculation_compiler_version ?? planValidation?.compiler_version ?? null;
  const editable = canEdit && version.status === 'draft';
  const hasAlgorithm = Boolean(plan || source);

  const planState = !plan
    ? 'none'
    : planValidation?.valid === false || planIssues.length > 0
      ? 'blocked'
      : planValidation?.valid
        ? 'valid'
        : 'not_validated';

  function openEditor(nextMode: 'prql' | 'json') {
    const initial = authoringSourceFromVersion(version);
    setDraftPrql(initial.prql);
    setSettingsJson(settingsJsonFromSource(initial));
    setTypeRows(Object.entries(initial.types).map(([name, type]) => ({ name, type })));
    setDraftJson(plan ? JSON.stringify(plan, null, 2) : '');
    setPreview(null);
    setJsonError(null);
    setMode(nextMode);
    compile.reset();
    save.reset();
    setEditorOpen(true);
  }

  function editorSource() {
    return buildSource(settingsJson, draftPrql, typeRows);
  }

  function updateTypeRows(updater: (current: TypeRow[]) => TypeRow[]) {
    setTypeRows(updater);
    setPreview(null);
  }

  const compile = useMutation({
    mutationFn: () => compileCalculationSource(token!, version.scenario_version_id, editorSource()),
    onSuccess: (result) => setPreview(result.data),
  });

  const save = useMutation({
    mutationFn: () => {
      if (!etag) throw new Error('Refresh the scenario before saving the algorithm.');
      if (mode === 'json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(draftJson);
          setJsonError(null);
        } catch {
          setJsonError('The algorithm must be valid JSON.');
          throw new Error('The algorithm must be valid JSON.');
        }
        return updateScenarioVersion(
          token!,
          version.scenario_version_id,
          { calculation_plan: parsed },
          etag
        );
      }
      return updateScenarioVersion(
        token!,
        version.scenario_version_id,
        { calculation_source: editorSource() },
        etag
      );
    },
    onSuccess: () => {
      setEditorOpen(false);
      onChanged();
      push({
        tone: 'success',
        title: 'Algorithm saved',
        detail:
          mode === 'prql'
            ? 'The PRQL source was compiled and pinned to this draft. Validate before running.'
            : 'The plan was validated and pinned to this draft. Validate before running.',
      });
    },
  });

  function formatJson() {
    try {
      setDraftJson(JSON.stringify(JSON.parse(draftJson), null, 2));
      setJsonError(null);
    } catch {
      setJsonError('The algorithm must be valid JSON.');
    }
  }

  const statusPill =
    planState === 'valid' ? (
      <StatusPill value="validated" label="Algorithm valid" />
    ) : planState === 'blocked' ? (
      <StatusPill value="failed" label="Algorithm blocked" />
    ) : planState === 'not_validated' ? (
      <StatusPill value="draft" label="Not validated" tone="info" />
    ) : (
      <StatusPill value="draft" label="No algorithm" tone="neutral" />
    );

  return (
    <>
      <Panel
        title="Algorithm"
        description="PRQL authoring source, canonical calculation plan and lineage for this scenario version."
        action={statusPill}
      >
        {!hasAlgorithm ? (
          <EmptyState
            icon={Braces}
            title="No algorithm pinned"
            description={
              editable
                ? 'Add a PRQL algorithm and its plan settings. The API compiles it to a canonical cpm-calculation-plan/0 before saving.'
                : 'This version has no calculation plan. Create a new draft version to add one.'
            }
            action={
              editable ? (
                <Button variant="primary" icon={Plus} onClick={() => openEditor('prql')}>
                  Add algorithm
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <dl className="facts facts--grid">
              <div>
                <dt>Format</dt>
                <dd className="mono">{plan?.format ?? source?.format ?? '—'}</dd>
              </div>
              <div>
                <dt>Grain</dt>
                <dd className="mono small">
                  {(plan?.grain ?? source?.grain ?? []).join(' · ') || '—'}
                </dd>
              </div>
              {source ? (
                <div>
                  <dt>Authoring</dt>
                  <dd className="mono">{version.calculation_authoring_version ?? '—'}</dd>
                </div>
              ) : null}
              <div>
                <dt>Compiler</dt>
                <dd className="mono">{compilerVersion ?? '—'}</dd>
              </div>
              <div>
                <dt>Plan hash</dt>
                <dd className="mono small" title={planHash ?? undefined}>
                  {planHash ? shortId(planHash) : '—'}
                </dd>
              </div>
              {source ? (
                <div>
                  <dt>Source hash</dt>
                  <dd
                    className="mono small"
                    title={version.calculation_source_hash ?? undefined}
                  >
                    {version.calculation_source_hash
                      ? shortId(version.calculation_source_hash)
                      : '—'}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Stages</dt>
                <dd className="mono">{plan?.stages.length ?? 0}</dd>
              </div>
              <div>
                <dt>Drivers</dt>
                <dd className="mono">
                  {Object.keys(plan?.drivers ?? source?.drivers ?? {}).length}
                </dd>
              </div>
            </dl>

            {plan && plan.stages.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Stage</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.stages.map((stage, index) => (
                      <tr key={`${index}-${stage.op}`}>
                        <td className="num muted">{index + 1}</td>
                        <td>{stageLabel(stage)}</td>
                        <td className="muted">{stageDetail(stage)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="fineprint">No stages are pinned in this plan.</p>
            )}

            {source ? (
              <div className="algorithm-source">
                <div className="algorithm-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={prqlOpen ? EyeOff : Eye}
                    onClick={() => setPrqlOpen((value) => !value)}
                  >
                    {prqlOpen ? 'Hide PRQL' : 'View PRQL'}
                  </Button>
                </div>
                {prqlOpen ? <pre className="json-view">{source.prql}</pre> : null}
                <p className="fineprint">
                  PRQL is the authoring source. The canonical plan above is what the worker executes.
                </p>
              </div>
            ) : null}
            <div className="algorithm-drivers">
              <h3 className="algorithm-drivers__title">Bound drivers</h3>
              {Object.keys(plan?.drivers ?? source?.drivers ?? {}).length === 0 ? (
                <p className="fineprint">
                  No bound drivers; the plan uses literals and source columns.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th className="num">Value</th>
                        <th>Type</th>
                        <th>Applies to</th>
                        <th>Period</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(plan?.drivers ?? source?.drivers ?? {}).map(
                        ([code, driver]) => (
                          <tr key={code}>
                            <td className="mono">{code}</td>
                            <td className="num mono">{driver.value}</td>
                            <td className="muted">{driver.type}</td>
                            <td className="mono muted">{driver.applies_to}</td>
                            <td className="muted">{driver.effective_period ?? '—'}</td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {Object.keys(plan?.drivers ?? source?.drivers ?? {}).length > 0 ? (
                <p className="fineprint">
                  Bound values are pinned in the plan; scenario drivers are listed separately
                  below.
                </p>
              ) : null}
            </div>

            {planState === 'blocked' ? (
              planIssues.length ? (
                <div className="validation">
                  <p className="validation__summary">
                    The algorithm has issues that block validation.
                  </p>
                  <ul className="issue-list">
                    {planIssues.map((issue) => (
                      <li key={`${issue.path}-${issue.code}-${issue.message}`}>
                        <span className={`issue-severity issue-severity--${issue.severity}`}>
                          {issue.severity}
                        </span>
                        <div>
                          <strong>{issue.code.replace(/_/g, ' ')}</strong>
                          <p>{issue.message}</p>
                          <code>{issue.path || '/'}</code>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="fineprint negative">
                  The algorithm is blocked. See Validation for details.
                </p>
              )
            ) : planState === 'valid' ? (
              <p className="fineprint">
                {`Validated with ${planValidation?.compiler_version ?? compilerVersion ?? 'the pinned compiler'}.`}
              </p>
            ) : planState === 'not_validated' ? (
              <p className="fineprint">
                Run Validate to compile the plan and check it before queueing a job.
              </p>
            ) : null}

            {jsonOpen && plan ? <pre className="json-view">{JSON.stringify(plan, null, 2)}</pre> : null}

            <div className="algorithm-actions">
              {editable ? (
                <Button size="sm" icon={Pencil} onClick={() => openEditor('prql')}>
                  Edit algorithm
                </Button>
              ) : null}
              {plan ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Braces}
                  onClick={() => setJsonOpen((value) => !value)}
                >
                  {jsonOpen ? 'Hide plan JSON' : 'View plan JSON'}
                </Button>
              ) : null}
            </div>

            {!editable ? (
              <p className="fineprint">
                {version.status === 'draft'
                  ? 'Read-only: your scope cannot edit this scenario.'
                  : 'Read-only: the algorithm is immutable once the version leaves draft.'}
              </p>
            ) : null}
          </>
        )}
      </Panel>

      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title="Calculation algorithm"
        description={
          mode === 'prql'
            ? 'Write the row-level algorithm in PRQL. The API compiles it into the canonical plan before saving.'
            : 'Edit the canonical plan directly. The API validates and compiles it against this model version.'
        }
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setEditorOpen(false)}
              disabled={save.isPending || compile.isPending}
            >
              Cancel
            </Button>
            {mode === 'json' ? (
              <Button onClick={formatJson} disabled={save.isPending}>
                Format
              </Button>
            ) : (
              <Button
                onClick={() => compile.mutate()}
                loading={compile.isPending}
                disabled={!draftPrql.trim() || save.isPending}
              >
                Compile preview
              </Button>
            )}
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => save.mutate()}
              disabled={
                !etag ||
                (mode === 'json'
                  ? !draftJson.trim()
                  : !draftPrql.trim() || !settingsJson.trim())
              }
            >
              Save algorithm
            </Button>
          </>
        }
      >
        <div className="algorithm-actions" role="group" aria-label="Editor mode">
          <Button
            size="sm"
            variant={mode === 'prql' ? 'primary' : 'ghost'}
            onClick={() => setMode('prql')}
          >
            PRQL
          </Button>
          <Button
            size="sm"
            variant={mode === 'json' ? 'primary' : 'ghost'}
            onClick={() => setMode('json')}
          >
            Plan JSON
          </Button>
        </div>

        {mode === 'prql' ? (
          <>
            <Field
              label="PRQL pipeline"
              htmlFor="algorithm-prql"
              hint="from, filter, derive and select. Raw SQL, joins, grouping and window functions are rejected."
            >
              <Textarea
                id="algorithm-prql"
                rows={14}
                value={draftPrql}
                onChange={(event) => {
                  setDraftPrql(event.target.value);
                  setPreview(null);
                }}
                spellCheck={false}
                className="mono"
                placeholder={'from scenario_base\nfilter headcount > 0\nderive adjusted = amount * (1 + growth_pct)\nselect {department_code, adjusted}'}
              />
            </Field>

            <div className="algorithm-types">
              <div className="algorithm-types__head">
                <h3 className="algorithm-drivers__title">Derived column types</h3>
                <Button
                  size="sm"
                  icon={Plus}
                  onClick={() =>
                    updateTypeRows((current) => [
                      ...current,
                      { name: '', type: 'decimal(18,2)' },
                    ])
                  }
                >
                  Add type
                </Button>
              </div>
              {typeRows.length === 0 ? (
                <p className="fineprint">
                  Every derive alias needs a type. Add one row per derived column.
                </p>
              ) : (
                <div className="algorithm-types__rows">
                  {typeRows.map((row, index) => (
                    <div className="algorithm-types__row" key={index}>
                      <Input
                        aria-label={`Derived column ${index + 1}`}
                        value={row.name}
                        onChange={(event) =>
                          updateTypeRows((current) =>
                            current.map((entry, position) =>
                              position === index
                                ? { ...entry, name: event.target.value }
                                : entry
                            )
                          )
                        }
                        placeholder="adjusted_budget"
                        className="algorithm-types__name mono"
                      />
                      <Select
                        aria-label={`Type for ${row.name || 'derived column'}`}
                        value={row.type}
                        onChange={(event) =>
                          updateTypeRows((current) =>
                            current.map((entry, position) =>
                              position === index
                                ? { ...entry, type: event.target.value }
                                : entry
                            )
                          )
                        }
                        className="algorithm-types__type"
                      >
                        {COLUMN_TYPES.includes(row.type) ? null : (
                          <option value={row.type}>{row.type}</option>
                        )}
                        {COLUMN_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={X}
                        aria-label={`Remove type for ${row.name || `column ${index + 1}`}`}
                        onClick={() =>
                          updateTypeRows((current) =>
                            current.filter((_, position) => position !== index)
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <details className="algorithm-settings">
              <summary>Plan settings</summary>
              <p className="fineprint">
                Source, columns, grain, pins, drivers and the allocate/validate/write stages.
                PRQL covers the row-level pipeline. New algorithm? Declare at least one scan
                column, the grain and a write stage here.
              </p>
              <Field label="Settings JSON" htmlFor="algorithm-settings">
                <Textarea
                  id="algorithm-settings"
                  rows={12}
                  value={settingsJson}
                  onChange={(event) => {
                    setSettingsJson(event.target.value);
                    setPreview(null);
                  }}
                  spellCheck={false}
                  className="mono"
                />
              </Field>
            </details>

            <ProblemBanner error={compile.error ?? save.error} />

            {preview ? (
              <div className="algorithm-preview">
                <h3 className="algorithm-drivers__title">Compiled plan</h3>
                <dl className="facts facts--grid">
                  <div>
                    <dt>Plan hash</dt>
                    <dd className="mono small" title={preview.calculation_plan_hash}>
                      {shortId(preview.calculation_plan_hash)}
                    </dd>
                  </div>
                  <div>
                    <dt>Compiler</dt>
                    <dd className="mono">{preview.calculation_compiler_version}</dd>
                  </div>
                  <div>
                    <dt>Authoring</dt>
                    <dd className="mono">{preview.calculation_authoring_version}</dd>
                  </div>
                  <div>
                    <dt>Stages</dt>
                    <dd className="mono">{preview.calculation_plan.stages.length}</dd>
                  </div>
                </dl>
                <div className="table-wrap">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th className="num">#</th>
                        <th>Stage</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.calculation_plan.stages.map((stage, index) => (
                        <tr key={`${index}-${stage.op}`}>
                          <td className="num muted">{index + 1}</td>
                          <td>{stageLabel(stage)}</td>
                          <td className="muted">{stageDetail(stage)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <Field
              label="Plan JSON"
              htmlFor="algorithm-json"
              error={jsonError ?? undefined}
              hint={`cpm-calculation-plan/0. pins.model_version_id must match ${shortId(version.model_version_id)}.`}
            >
              <Textarea
                id="algorithm-json"
                rows={18}
                value={draftJson}
                onChange={(event) => setDraftJson(event.target.value)}
                spellCheck={false}
                className="mono"
                placeholder={'{\n  "format": "cpm-calculation-plan/0",\n  "grain": [],\n  "pins": {},\n  "drivers": {},\n  "stages": []\n}'}
              />
            </Field>
            <ProblemBanner error={save.error} />
            <p className="fineprint">
              Saving does not run the scenario. The version stays draft until you run Validate and
              queue a job.
            </p>
          </>
        )}
      </Dialog>
    </>
  );
}
