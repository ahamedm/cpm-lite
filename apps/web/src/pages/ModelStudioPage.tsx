import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  ClipboardCheck,
  Columns3,
  Database,
  Link2,
  Plus,
  Rows3,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../auth';
import { createModel, validateModelVersion } from '../api';
import { useDepartments, useMe, useModelPreview, useModelSources } from '../queries';
import { dateTime, compactMoney, money, percent, titleCase } from '../format';
import type { ModelDefinition, ModelPreview, ModelSource, ModelSourceColumn } from '../types';
import {
  Button,
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

type StepId = 'source' | 'grain' | 'fields' | 'references' | 'access' | 'review';
type FieldRole = 'dimension' | 'measure';

interface FieldState {
  enabled: boolean;
  label: string;
  role: FieldRole;
  aggregation: string;
  format: string;
}

interface ReferenceFieldState {
  enabled: boolean;
  label: string;
}

interface ReferenceState {
  sourceId: string;
  name: string;
  sourceMember: string;
  targetMember: string;
  exposed: Record<string, ReferenceFieldState>;
}

const STEPS: Array<{ id: StepId; label: string; detail: string; icon: typeof Database }> = [
  { id: 'source', label: 'Source', detail: 'Choose governed data', icon: Database },
  { id: 'grain', label: 'Grain', detail: 'Confirm one row', icon: Rows3 },
  { id: 'fields', label: 'Fields', detail: 'Dimensions and measures', icon: Columns3 },
  { id: 'references', label: 'References', detail: 'Optional lookup', icon: Link2 },
  { id: 'access', label: 'Access', detail: 'Department scope', icon: ShieldCheck },
  { id: 'review', label: 'Review', detail: 'Name and create', icon: ClipboardCheck },
];

const DEFAULT_FIELDS = new Set([
  'department_code',
  'category_code',
  'region_code',
  'transaction_date',
  'budget_amount',
  'actual_amount',
  'variance_amount',
]);

const EMPTY_PREVIEW_BODY = {
  definition: { schema_version: '1.0', dimensions: [], measures: [] } as ModelDefinition,
  group_by: [] as string[],
  measures: [] as string[],
};

function useDebouncedValue<T>(value: T, delay = 280): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function initialFields(source: ModelSource): Record<string, FieldState> {
  return Object.fromEntries(
    source.columns.map((column) => [
      column.name,
      {
        enabled: DEFAULT_FIELDS.has(column.name),
        label: column.label,
        role: column.suggested_role === 'measure' ? 'measure' : 'dimension',
        aggregation: column.suggested_aggregation ?? 'sum',
        format: column.format ?? 'number',
      } satisfies FieldState,
    ])
  );
}

/** Must match the server's dataset naming so preview and Cube resolves agree. */
function datasetNameFromSource(sourceId: string): string {
  const tail = sourceId.split('.').pop() ?? sourceId;
  const normalized = tail
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return 'dataset';
  return /^[a-z_]/.test(normalized) ? normalized : `d_${normalized}`;
}

function buildDefinition(
  source: ModelSource,
  fields: Record<string, FieldState>,
  accessField: string,
  reference: ReferenceState | null,
  referenceSource: ModelSource | null
): ModelDefinition {
  const factDimensions: ModelDefinition['dimensions'] = [];
  const measures: ModelDefinition['measures'] = [];
  for (const column of source.columns) {
    const state = fields[column.name];
    if (!state?.enabled) continue;
    if (state.role === 'measure') {
      measures.push({
        code: column.name,
        name: state.label || column.label,
        aggregation: state.aggregation,
        expression: column.name,
        format: state.format,
        currency_code: state.format === 'currency' ? 'USD' : null,
      });
    } else {
      factDimensions.push({
        code: column.name,
        name: state.label || column.label,
        data_type: column.data_type,
        expression: column.name,
      });
    }
  }

  const dimensions = [...factDimensions];
  let datasets: ModelDefinition['datasets'];
  let joins: ModelDefinition['joins'];
  if (
    reference &&
    referenceSource &&
    reference.name.trim() &&
    reference.sourceMember &&
    reference.targetMember
  ) {
    const factDataset = datasetNameFromSource(source.source_id);
    const factCodes = new Set(factDimensions.map((dimension) => dimension.code));
    const referenceFields = referenceSource.columns.map((column) => ({
      code: column.name,
      name: column.label,
      data_type: column.data_type,
      expression: column.name,
    }));
    for (const column of referenceSource.columns) {
      const exposed = reference.exposed[column.name];
      if (!exposed?.enabled || factCodes.has(column.name)) continue;
      dimensions.push({
        code: column.name,
        name: exposed.label || column.label,
        data_type: column.data_type,
        expression: column.name,
        dataset: reference.name,
      });
    }
    datasets = [
      {
        name: reference.name,
        source: reference.sourceId,
        primary_key: [reference.targetMember],
        fields: referenceFields,
      },
    ];
    joins = [
      {
        name: reference.name,
        relationship: 'many_to_one',
        source_dataset: factDataset,
        target_dataset: reference.name,
        on: [{ source_member: reference.sourceMember, target_member: reference.targetMember }],
      },
    ];
  }

  return {
    schema_version: datasets ? '1.1' : '1.0',
    source: { source_id: source.source_id },
    access: { row_level_field: accessField },
    ...(datasets ? { datasets } : {}),
    ...(joins ? { joins } : {}),
    dimensions,
    measures,
  };
}

function formatPreviewValue(
  value: string | number | null | undefined,
  column: ModelPreview['columns'][number]
): string {
  if (value === null || value === undefined) return '—';
  if (column.kind === 'measure') {
    if (column.format === 'currency') return compactMoney(value, column.currency_code ?? 'USD');
    if (column.format === 'percent') return percent(value);
  }
  return String(value);
}

function fullPreviewValue(
  value: string | number | null | undefined,
  column: ModelPreview['columns'][number]
): string {
  if (value === null || value === undefined) return '—';
  if (column.kind === 'measure' && column.format === 'currency') {
    return money(value, column.currency_code ?? 'USD');
  }
  return formatPreviewValue(value, column);
}

function fieldId(name: string): string {
  return `studio-field-${name}`;
}

export function ModelStudioPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const sourcesQuery = useModelSources(token);
  const meQuery = useMe(token);
  const allSources = sourcesQuery.data?.data.data ?? [];
  const source = allSources[0] ?? null;
  const referenceSources = allSources.filter(
    (candidate) => candidate.source_id !== source?.source_id
  );
  const isSteward = Boolean(meQuery.data?.data.roles.some((role) => role === 'steward' || role === 'admin'));
  const canGlobal = Boolean(
    isSteward || meQuery.data?.data.roles.includes('data_engineer')
  );
  const departments = useDepartments(token, isSteward);

  const [step, setStep] = useState<StepId>('source');
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [grainConfirmed, setGrainConfirmed] = useState(false);
  const [accessField, setAccessField] = useState('department_code');
  const [reference, setReference] = useState<ReferenceState | null>(null);
  const [previewDepartment, setPreviewDepartment] = useState('');
  const [groupBy, setGroupBy] = useState<string[]>(['department_code']);
  const [fieldSearch, setFieldSearch] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'department' | 'global'>('department');
  const initializedSource = useRef<string | null>(null);

  useEffect(() => {
    if (!source || initializedSource.current === source.source_id) return;
    initializedSource.current = source.source_id;
    setFields(initialFields(source));
    setGrainConfirmed(false);
    setAccessField('department_code');
    setReference(null);
    setGroupBy(['department_code']);
    setStep('source');
  }, [source]);

  const factDimensions = useMemo(() => {
    if (!source) return [] as ModelDefinition['dimensions'];
    const selected: ModelDefinition['dimensions'] = [];
    for (const column of source.columns) {
      const state = fields[column.name];
      if (!state?.enabled || state.role === 'measure') continue;
      selected.push({
        code: column.name,
        name: state.label || column.label,
        data_type: column.data_type,
        expression: column.name,
      });
    }
    return selected;
  }, [source, fields]);
  const referenceSource = reference
    ? referenceSources.find((candidate) => candidate.source_id === reference.sourceId) ?? null
    : null;
  const referenceReady =
    !reference ||
    Boolean(
      reference.name.trim() &&
        reference.sourceMember &&
        reference.targetMember &&
        referenceSource &&
        Object.values(reference.exposed).some((field) => field.enabled)
    );

  const definition = useMemo(
    () =>
      source
        ? buildDefinition(source, fields, accessField, reference, referenceSource)
        : null,
    [source, fields, accessField, reference, referenceSource]
  );
  const dimensions = definition?.dimensions ?? [];
  const measures = definition?.measures ?? [];
  const referenceDimensions = dimensions.filter((dimension) => dimension.dataset);
  const activeGroupBy = useMemo(
    () => groupBy.filter((codeValue) => dimensions.some((dimension) => dimension.code === codeValue)).slice(0, 3),
    [groupBy, dimensions]
  );
  const fieldReady = factDimensions.length > 0 && measures.length > 0;
  const accessReady =
    Boolean(accessField) && factDimensions.some((dimension) => dimension.code === accessField);
  const previewMeasures = useMemo(() => measures.slice(0, 3).map((measure) => measure.code), [measures]);

  const previewBody = useMemo(() => {
    if (!definition || previewMeasures.length === 0) return null;
    return {
      definition,
      group_by: activeGroupBy,
      measures: previewMeasures,
      limit: 25,
      preview_department_code: isSteward && previewDepartment ? previewDepartment : null,
    };
  }, [definition, activeGroupBy, previewMeasures, isSteward, previewDepartment]);
  const debouncedPreviewBody = useDebouncedValue(previewBody);
  const preview = useModelPreview(
    token,
    debouncedPreviewBody ?? EMPTY_PREVIEW_BODY,
    Boolean(debouncedPreviewBody)
  );
  const previewData = preview.data?.data;
  const previewError = preview.error;

  const create = useMutation({
    mutationFn: async () => {
      if (!definition) throw new Error('Choose a governed source first.');
      const created = await createModel(token!, {
        name: name.trim(),
        ...(code.trim() ? { code: code.trim() } : {}),
        description: description.trim() || null,
        visibility,
        definition,
      });
      const versionId = created.data.latest_version.model_version_id;
      const validation = await validateModelVersion(token!, versionId);
      return { model: created.data, validation: validation.data };
    },
    onSuccess: ({ model, validation }) => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['model', model.model_id] });
      push({
        tone: validation.valid ? 'success' : 'error',
        title: validation.valid ? 'Draft model created' : 'Draft created with validation issues',
        detail: validation.valid
          ? 'Validate and publish it from the model page.'
          : `${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'} need attention.`,
      });
      navigate(`/models/${model.model_id}`);
    },
  });

  const currentStepIndex = STEPS.findIndex((item) => item.id === step);
  const canContinue =
    step === 'source'
      ? Boolean(source)
      : step === 'grain'
        ? grainConfirmed
        : step === 'fields'
          ? fieldReady
          : step === 'references'
            ? referenceReady
            : step === 'access'
              ? accessReady
              : Boolean(name.trim()) && fieldReady && referenceReady && accessReady && grainConfirmed && Boolean(previewData) && !previewError;
  const updateField = (nameValue: string, patch: Partial<FieldState>) => {
    setFields((current) => {
      const existing = current[nameValue];
      if (!existing) return current;
      return {
        ...current,
        [nameValue]: { ...existing, ...patch },
      };
    });
  };
  const toggleField = (column: ModelSourceColumn) => {
    setFields((current) => {
      const existing = current[column.name];
      if (!existing) return current;
      return {
        ...current,
        [column.name]: { ...existing, enabled: !existing.enabled },
      };
    });
  };
  const toggleGroup = (codeValue: string) => {
    setGroupBy((current) =>
      current.includes(codeValue)
        ? current.filter((value) => value !== codeValue)
        : current.length >= 3
          ? current
          : [...current, codeValue]
    );
  };
  function chooseReference(sourceId: string) {
    if (!sourceId) {
      setReference(null);
      return;
    }
    const candidate = referenceSources.find((entry) => entry.source_id === sourceId);
    if (!candidate) {
      setReference(null);
      return;
    }
    const factCodes = new Set(factDimensions.map((dimension) => dimension.code));
    const defaultFact =
      factDimensions.find((dimension) =>
        candidate.columns.some((column) => column.name === dimension.expression)
      ) ?? factDimensions[0];
    const defaultTarget =
      candidate.columns.find((column) => column.name === defaultFact?.expression) ??
      candidate.columns[0];
    const exposed: Record<string, ReferenceFieldState> = {};
    for (const column of candidate.columns) {
      if (factCodes.has(column.name) || column.name === defaultTarget?.name) continue;
      if (column.name.endsWith('_name') || column.name === 'period' || column.name === 'month_name') {
        exposed[column.name] = { enabled: true, label: column.label };
      }
    }
    if (Object.keys(exposed).length === 0) {
      const fallback = candidate.columns.find(
        (column) => column.name !== defaultTarget?.name && !factCodes.has(column.name)
      );
      if (fallback) exposed[fallback.name] = { enabled: true, label: fallback.label };
    }
    setReference({
      sourceId,
      name: datasetNameFromSource(sourceId),
      sourceMember: defaultFact?.code ?? '',
      targetMember: defaultTarget?.name ?? '',
      exposed,
    });
  }
  const goNext = () => {
    if (step === 'review') {
      if (canContinue) create.mutate();
      return;
    }
    const next = STEPS[currentStepIndex + 1];
    if (next) setStep(next.id);
  };
  const goBack = () => {
    if (step === 'source') {
      navigate('/models');
      return;
    }
    const previous = STEPS[currentStepIndex - 1];
    if (previous) setStep(previous.id);
  };

  if (sourcesQuery.isPending) {
    return <SkeletonTable rows={8} columns={5} />;
  }

  return (
    <div className="stack studio-page">
      <PageHeader
        back={{ to: '/models', label: 'Models' }}
        title="New model"
        subtitle="Start from a governed source, confirm its grain, then choose the fields people can query."
      />

      <ProblemBanner error={sourcesQuery.error} onRetry={() => sourcesQuery.refetch()} />
      <ProblemBanner error={create.error} />

      {!source ? (
        <EmptyState
          icon={Database}
          title="No governed source available"
          description="Build the analytical snapshot with `make data`, then reload this page."
        />
      ) : (
        <div className={`studio ${step === 'source' || step === 'grain' ? 'studio--wide' : ''}`}>
          <aside className="studio__recipe" aria-label="Model steps">
            <div className="studio__recipe-head">
              <span className="field-label">Recipe</span>
              <span className="mono muted">{currentStepIndex + 1} / {STEPS.length}</span>
            </div>
            <nav className="studio-steps">
              {STEPS.map((item, index) => {
                const Icon = item.icon;
                const complete =
                  index < currentStepIndex &&
                  (item.id === 'source'
                    ? Boolean(source)
                    : item.id === 'grain'
                      ? grainConfirmed
                      : item.id === 'fields'
                        ? fieldReady
                        : item.id === 'references'
                          ? referenceReady
                          : item.id === 'access'
                            ? accessReady
                            : false);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`studio-step ${step === item.id ? 'studio-step--active' : ''}`}
                    aria-current={step === item.id ? 'step' : undefined}
                    onClick={() => setStep(item.id)}
                  >
                    <span className="studio-step__index">{complete ? <Check size={13} /> : index + 1}</span>
                    <span className="studio-step__body">
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <Icon size={14} className="studio-step__icon" aria-hidden />
                  </button>
                );
              })}
            </nav>
            <p className="studio__recipe-note">
              Preview uses the same department scope as the API. Nothing is saved until you create the draft.
            </p>
          </aside>

          <section className="studio__canvas" aria-label="Model editor">
            {step === 'source' ? (
              <Panel title="Governed source" description="Choose the source this model should expose.">
                <div className="studio-source">
                  <div className="studio-source__main">
                    <span className="studio-source__icon"><Database size={16} aria-hidden /></span>
                    <div>
                      <h3>{source.name}</h3>
                      <p>{source.description}</p>
                      <div className="studio-source__meta">
                        <span className="mono">{source.source_id}</span>
                        <span>{source.row_count.toLocaleString()} rows</span>
                        <span>{source.columns.length} columns</span>
                        <span>Profiled {dateTime(source.refreshed_at)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="studio-source__checks">
                    <div className="studio-check-line">
                      <CheckCircle2 size={14} />
                      <span>{source.grain}</span>
                    </div>
                    <div className="studio-check-line">
                      <CheckCircle2 size={14} />
                      <span>Grain key <span className="mono">{source.grain_key}</span> is {source.grain_unique ? 'unique' : 'not unique'}</span>
                    </div>
                  </div>
                </div>
                <div className="studio-table-heading">
                  <h3>Column profile</h3>
                  <p>Profiles are read from the governed snapshot; they are not sample fixtures.</p>
                </div>
                <div className="table-wrap">
                  <table className="data-table data-table--compact studio-column-table">
                    <thead>
                      <tr><th>Column</th><th>Type</th><th>Distinct</th><th>Nulls</th><th>Sample values</th></tr>
                    </thead>
                    <tbody>
                      {source.columns.map((column) => (
                        <tr key={column.name}>
                          <td><span className="mono">{column.name}</span><span className="cell-sub">{column.label}</span></td>
                          <td className="muted">{column.data_type}</td>
                          <td className="num">{column.distinct_count.toLocaleString()}</td>
                          <td className="num">{column.null_count.toLocaleString()}</td>
                          <td className="studio-samples">{column.sample_values.length ? column.sample_values.join(' · ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="studio-source__relationships">
                  <span className="field-label">Reference data</span>
                  <div className="studio-relationship-row">
                    {source.relationships.map((relationship) => (
                      <span key={relationship.target_source_id} className="studio-relationship">
                        <span className="mono">{relationship.source_field}</span>
                        <span aria-hidden>→</span>
                        {relationship.target_label}
                      </span>
                    ))}
                  </div>
                  <p className="field__hint">Join authoring follows in a later slice; this draft uses the source columns.</p>
                </div>
              </Panel>
            ) : null}

            {step === 'grain' ? (
              <Panel title="What does one row represent?" description="Grain decides whether totals are trustworthy.">
                <div className="studio-grain">
                  <p className="studio-statement">{source.grain}</p>
                  <div className="facts facts--grid">
                    <div><dt>Grain key</dt><dd className="mono">{source.grain_key}</dd></div>
                    <div><dt>Rows</dt><dd className="mono">{source.row_count.toLocaleString()}</dd></div>
                    <div><dt>Distinct keys</dt><dd className="mono">{source.columns.find((column) => column.name === source.grain_key)?.distinct_count.toLocaleString() ?? '—'}</dd></div>
                    <div><dt>Duplicate keys</dt><dd className="mono">{source.grain_unique ? '0' : 'Present'}</dd></div>
                  </div>
                </div>
                <label className={`studio-check ${source.grain_unique ? '' : 'studio-check--warning'}`}>
                  <input
                    type="checkbox"
                    checked={grainConfirmed}
                    onChange={(event) => setGrainConfirmed(event.target.checked)}
                  />
                  <span>
                    <strong>I confirm this is the grain.</strong>
                    <small>Aggregating a different grain can double-count amounts. The loader already removes exact duplicate source rows.</small>
                  </span>
                </label>
                {!source.grain_unique ? (
                  <p className="studio-note studio-note--warning">
                    This key is not unique in the snapshot. Confirm the grain with the data owner before publishing.
                  </p>
                ) : null}
              </Panel>
            ) : null}

            {step === 'fields' ? (
              <Panel title="Fields" description="Choose what people can group by and what they can total.">
                <div className="studio-fields">
                  <div className="studio-field-picker">
                    <div className="search-field">
                      <Search size={14} aria-hidden />
                      <Input
                        aria-label="Search source columns"
                        placeholder="Search columns"
                        value={fieldSearch}
                        onChange={(event) => setFieldSearch(event.target.value)}
                      />
                    </div>
                    <div className="studio-column-list">
                      {source.columns
                        .filter((column) => column.name.includes(fieldSearch.toLowerCase()) || column.label.toLowerCase().includes(fieldSearch.toLowerCase()))
                        .map((column) => {
                          const state = fields[column.name];
                          return (
                            <label className="studio-column" key={column.name} htmlFor={fieldId(column.name)}>
                              <input
                                id={fieldId(column.name)}
                                type="checkbox"
                                checked={Boolean(state?.enabled)}
                                onChange={() => toggleField(column)}
                              />
                              <span className="studio-column__text">
                                <strong>{column.label}</strong>
                                <small><span className="mono">{column.name}</span> · {column.data_type}</small>
                              </span>
                              <span className={`studio-role studio-role--${state?.role ?? 'dimension'}`}>
                                {state?.role === 'measure' ? 'measure' : column.suggested_role === 'time' ? 'time' : 'dimension'}
                              </span>
                            </label>
                          );
                        })}
                    </div>
                  </div>

                  <div className="studio-field-selection">
                    <div className="studio-table-heading">
                      <h3>Selected fields</h3>
                      <p>{dimensions.length} dimensions · {measures.length} measures</p>
                    </div>
                    <div className="studio-field-list">
                      {source.columns.filter((column) => fields[column.name]?.enabled).map((column) => {
                        const state = fields[column.name];
                        if (!state) return null;
                        return (
                          <div className="studio-field-row" key={column.name}>
                            <div className="studio-field-row__name">
                              <Input
                                aria-label={`Label for ${column.name}`}
                                value={state.label}
                                onChange={(event) => updateField(column.name, { label: event.target.value })}
                              />
                              <span className="mono muted">{column.name}</span>
                            </div>
                            {state.role === 'measure' ? (
                              <div className="studio-field-row__measure">
                                <Select
                                  aria-label={`Aggregation for ${column.name}`}
                                  value={state.aggregation}
                                  onChange={(event) => updateField(column.name, { aggregation: event.target.value })}
                                >
                                  <option value="sum">Sum</option>
                                  <option value="avg">Average</option>
                                  <option value="min">Minimum</option>
                                  <option value="max">Maximum</option>
                                  <option value="count">Count rows</option>
                                  <option value="count_distinct">Distinct count</option>
                                </Select>
                                <Select
                                  aria-label={`Format for ${column.name}`}
                                  value={state.format}
                                  onChange={(event) => updateField(column.name, { format: event.target.value })}
                                >
                                  <option value="currency">Currency</option>
                                  <option value="number">Number</option>
                                  <option value="percent">Percent</option>
                                </Select>
                              </div>
                            ) : (
                              <span className="studio-field-row__type">{column.data_type}</span>
                            )}
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Remove ${column.label}`}
                              onClick={() => toggleField(column)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    <div className="studio-groupby">
                      <div className="studio-table-heading">
                        <h3>Preview grouping</h3>
                        <p>Up to three dimensions, or totals only.</p>
                      </div>
                      <div className="chip-row">
                        {dimensions.map((dimension) => (
                          <button
                            key={dimension.code}
                            type="button"
                            className={`choice-chip ${activeGroupBy.includes(dimension.code) ? 'choice-chip--active' : ''}`}
                            aria-pressed={activeGroupBy.includes(dimension.code)}
                            onClick={() => toggleGroup(dimension.code)}
                          >
                            {dimension.name}
                          </button>
                        ))}
                        {dimensions.length === 0 ? <span className="muted">Add a dimension to group the preview.</span> : null}
                      </div>
                    </div>
                  </div>
                </div>
              </Panel>
            ) : null}

            {step === 'references' ? (
              <Panel
                title="Reference data"
                description="Add one governed lookup. The join is many-to-one and the reference key must be unique."
              >
                {referenceSources.length === 0 ? (
                  <EmptyState
                    icon={Link2}
                    title="No reference source available"
                    description="The governed catalog has no additional source to join. Continue without a reference."
                  />
                ) : (
                  <>
                    <Field
                      label="Reference source"
                      htmlFor="studio-reference-source"
                      hint="Optional. A governed dimension or lookup table."
                    >
                      <Select
                        id="studio-reference-source"
                        value={reference?.sourceId ?? ''}
                        onChange={(event) => chooseReference(event.target.value)}
                      >
                        <option value="">No reference</option>
                        {referenceSources.map((candidate) => (
                          <option key={candidate.source_id} value={candidate.source_id}>
                            {candidate.name} · {candidate.source_id}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    {reference && referenceSource ? (
                      <>
                        <div className="form-grid">
                          <Field
                            label="Dataset code"
                            htmlFor="studio-reference-name"
                            hint="Used by joins and field lineage."
                          >
                            <Input
                              id="studio-reference-name"
                              value={reference.name}
                              onChange={(event) =>
                                setReference({ ...reference, name: event.target.value })
                              }
                            />
                          </Field>
                          <Field
                            label="Join from"
                            htmlFor="studio-reference-source-member"
                            hint="A dimension on the principal source."
                          >
                            <Select
                              id="studio-reference-source-member"
                              value={reference.sourceMember}
                              onChange={(event) =>
                                setReference({ ...reference, sourceMember: event.target.value })
                              }
                            >
                              {factDimensions.map((dimension) => (
                                <option key={dimension.code} value={dimension.code}>
                                  {dimension.name} · {dimension.code}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field
                            label="Join to"
                            htmlFor="studio-reference-target-member"
                            hint="The unique key on the reference source."
                          >
                            <Select
                              id="studio-reference-target-member"
                              value={reference.targetMember}
                              onChange={(event) =>
                                setReference({ ...reference, targetMember: event.target.value })
                              }
                            >
                              {referenceSource.columns.map((column) => (
                                <option key={column.name} value={column.name}>
                                  {column.label} · {column.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        </div>

                        <div className="studio-table-heading">
                          <h3>Exposed fields</h3>
                          <p>Reference fields become dimensions. The join key stays a key unless you expose it.</p>
                        </div>
                        <div className="table-wrap">
                          <table className="data-table data-table--compact">
                            <thead>
                              <tr>
                                <th>Expose</th>
                                <th>Field</th>
                                <th>Label</th>
                              </tr>
                            </thead>
                            <tbody>
                              {referenceSource.columns.map((column) => {
                                const field = reference.exposed[column.name] ?? {
                                  enabled: false,
                                  label: column.label,
                                };
                                const collision = factDimensions.some(
                                  (dimension) => dimension.code === column.name
                                );
                                return (
                                  <tr key={column.name}>
                                    <td>
                                      <input
                                        type="checkbox"
                                        aria-label={`Expose ${column.label}`}
                                        checked={field.enabled}
                                        disabled={collision}
                                        onChange={(event) =>
                                          setReference({
                                            ...reference,
                                            exposed: {
                                              ...reference.exposed,
                                              [column.name]: {
                                                ...field,
                                                enabled: event.target.checked,
                                              },
                                            },
                                          })
                                        }
                                      />
                                    </td>
                                    <td>
                                      <span className="mono">{column.name}</span>
                                      <span className="cell-sub">
                                        {column.label}
                                        {column.name === reference.targetMember ? ' · join key' : ''}
                                        {collision ? ' · conflicts with a principal field' : ''}
                                      </span>
                                    </td>
                                    <td>
                                      <Input
                                        aria-label={`Label for ${column.name}`}
                                        value={field.label}
                                        disabled={!field.enabled || collision}
                                        onChange={(event) =>
                                          setReference({
                                            ...reference,
                                            exposed: {
                                              ...reference.exposed,
                                              [column.name]: {
                                                ...field,
                                                label: event.target.value,
                                              },
                                            },
                                          })
                                        }
                                      />
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {referenceDimensions.length > 0 ? (
                          <div className="studio-groupby">
                            <div className="studio-table-heading">
                              <h3>Preview grouping</h3>
                              <p>Include a reference field in the live preview.</p>
                            </div>
                            <div className="chip-row">
                              {referenceDimensions.map((dimension) => (
                                <button
                                  key={dimension.code}
                                  type="button"
                                  className={`choice-chip ${activeGroupBy.includes(dimension.code) ? 'choice-chip--active' : ''}`}
                                  aria-pressed={activeGroupBy.includes(dimension.code)}
                                  onClick={() => toggleGroup(dimension.code)}
                                >
                                  {dimension.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        <p className="studio-note">
                          The reference key must be unique. The API rejects duplicate keys before a job writes a result.
                        </p>
                        <div className="studio-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Trash2}
                            onClick={() => setReference(null)}
                          >
                            Remove reference
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p className="studio-note">
                        Continue without a reference, or choose a source to expose joined labels and attributes.
                      </p>
                    )}
                  </>
                )}
              </Panel>
            ) : null}

            {step === 'access' ? (
              <Panel title="Access" description="Department scope is enforced by the API and Cube, not by hiding fields.">
                <div className="form-grid">
                  <Field label="Scope field" htmlFor="studio-access-field" hint="The governed column used for row-level filtering.">
                    <Select id="studio-access-field" value={accessField} onChange={(event) => setAccessField(event.target.value)}>
                      <option value="department_code">Department code</option>
                    </Select>
                  </Field>
                  {isSteward ? (
                    <Field label="Preview as" htmlFor="studio-preview-department" hint="See the rows another department would receive.">
                      <Select id="studio-preview-department" value={previewDepartment} onChange={(event) => setPreviewDepartment(event.target.value)}>
                        <option value="">All departments</option>
                        {(departments.data?.data.data ?? []).map((department) => (
                          <option key={department.department_code} value={department.department_code}>
                            {titleCase(department.department_name)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <Field label="Your scope" htmlFor="studio-scope-readonly">
                      <Input id="studio-scope-readonly" readOnly value={titleCase(meQuery.data?.data.department_code ?? 'Department')} />
                    </Field>
                  )}
                </div>
                {!dimensions.some((dimension) => dimension.code === 'department_code') ? (
                  <div className="studio-note studio-note--warning">
                    <strong>Department is not in the model fields.</strong>
                    <p>Add it before creating the draft so the access scope is visible to query users.</p>
                    <Button
                      size="sm"
                      icon={Plus}
                      onClick={() => updateField('department_code', { enabled: true })}
                    >
                      Add Department field
                    </Button>
                  </div>
                ) : null}
                <div className="studio-scope">
                  <div><span>Scope</span><strong>{previewData?.scope.department_code ? titleCase(previewData.scope.department_code) : 'All departments'}</strong></div>
                  <div><span>Rows in scope</span><strong className="mono">{previewData?.row_count.toLocaleString() ?? '—'}</strong></div>
                  <div><span>Preview groups</span><strong className="mono">{previewData?.rows.length ?? '—'}</strong></div>
                </div>
                <p className="studio-note">
                  The preview applies this scope server-side. Hiding a field in the UI is not a security boundary.
                </p>
              </Panel>
            ) : null}

            {step === 'review' ? (
              <>
                <Panel title="Name and ownership" description="This becomes the model record and its first draft version.">
                  <div className="form-grid">
                    <Field label="Model name" htmlFor="studio-name">
                      <Input
                        id="studio-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Department budget model"
                        autoFocus
                      />
                    </Field>
                    <Field label="Code" htmlFor="studio-code" hint="Optional; generated from the name when blank.">
                      <Input id="studio-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="department_budget" />
                    </Field>
                    <Field label="Visibility" htmlFor="studio-visibility">
                      <Select
                        id="studio-visibility"
                        value={visibility}
                        onChange={(event) => setVisibility(event.target.value as 'department' | 'global')}
                      >
                        <option value="department">Department</option>
                        <option value="global" disabled={!canGlobal}>Global</option>
                      </Select>
                    </Field>
                    <Field label="Description" htmlFor="studio-description" className="form-grid__wide">
                      <Textarea
                        id="studio-description"
                        rows={2}
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="What this model is for and who owns it."
                      />
                    </Field>
                  </div>
                </Panel>
                <Panel title="Definition" description="The immutable version created with this draft.">
                  <div className="facts facts--grid">
                    <div><dt>Source</dt><dd className="mono">{source.source_id}</dd></div>
                    <div><dt>Grain</dt><dd>{source.grain}</dd></div>
                    <div><dt>Dimensions</dt><dd>{dimensions.length}</dd></div>
                    <div><dt>Measures</dt><dd>{measures.length}</dd></div>
                    <div><dt>Reference fields</dt><dd>{referenceDimensions.length}</dd></div>
                    <div><dt>Reference join</dt><dd className="mono small">{reference && referenceSource ? `${reference.name} · many_to_one` : 'None'}</dd></div>
                    <div><dt>Access field</dt><dd className="mono">{accessField}</dd></div>
                    <div><dt>Scope</dt><dd>{isSteward && previewDepartment ? titleCase(previewDepartment) : titleCase(meQuery.data?.data.department_code ?? 'Department')}</dd></div>
                  </div>
                  <div className="studio-review-fields">
                    {dimensions.map((dimension) => (
                      <span
                        className="studio-review-chip"
                        key={`${dimension.dataset ?? 'fact'}-${dimension.code}`}
                        title={dimension.dataset ? `Reference: ${dimension.dataset}` : undefined}
                      >
                        {dimension.name}{dimension.dataset ? ' · ref' : ''}
                      </span>
                    ))}
                    {measures.map((measure) => <span className="studio-review-chip studio-review-chip--measure" key={measure.code}>{measure.name}</span>)}
                  </div>
                </Panel>
                <Panel title="Checks" description="Create a draft only when every check is clear.">
                  <ul className="studio-checks">
                    <CheckLine ok={Boolean(source)} label="Governed source loaded" />
                    <CheckLine ok={grainConfirmed} label="Grain confirmed" />
                    <CheckLine ok={factDimensions.length > 0} label="At least one principal dimension" />
                    <CheckLine ok={measures.length > 0} label="At least one measure" />
                    <CheckLine ok={referenceReady} label="Reference join complete or skipped" />
                    <CheckLine ok={accessReady} label="Department access field selected" />
                    <CheckLine ok={Boolean(previewData)} label="Authorized preview returned rows" />
                  </ul>
                  {previewError ? <ProblemBanner error={previewError} compact /> : null}
                </Panel>
              </>
            ) : null}

            <div className="studio-actions">
              <Button variant="ghost" onClick={goBack}>
                {step === 'source' ? 'Cancel' : 'Back'}
              </Button>
              <div className="studio-actions__right">
                <span className="mono muted">{step === 'review' ? 'One draft version' : `Step ${currentStepIndex + 1} of ${STEPS.length}`}</span>
                <Button
                  variant="primary"
                  onClick={goNext}
                  disabled={!canContinue}
                  loading={create.isPending}
                >
                  {step === 'review' ? 'Create draft' : 'Continue'}
                </Button>
              </div>
            </div>
          </section>

          <aside className="studio__preview" aria-label="Live preview">
            <PreviewPanel
              step={step}
              source={source}
              preview={previewData}
              pending={preview.isPending}
              error={previewError}
              measureCount={measures.length}
              groupCount={activeGroupBy.length}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function CheckLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`studio-check-line ${ok ? 'studio-check-line--ok' : ''}`}>
      {ok ? <CheckCircle2 size={14} /> : <span className="studio-check-line__empty" aria-hidden />}
      <span>{label}</span>
    </li>
  );
}

function PreviewPanel({
  step,
  source,
  preview,
  pending,
  error,
  measureCount,
  groupCount,
}: {
  step: StepId;
  source: ModelSource;
  preview: ModelPreview | undefined;
  pending: boolean;
  error: Error | null;
  measureCount: number;
  groupCount: number;
}) {
  return (
    <div className="studio-preview">
      <div className="studio-preview__head">
        <div>
          <span className="field-label">Preview</span>
          <h2>
            {step === 'source'
              ? 'Source profile'
              : step === 'grain'
                ? 'Grain check'
                : preview
                  ? `${preview.rows.length} ${preview.rows.length === 1 ? 'group' : 'groups'}`
                  : 'Live read-only'}
          </h2>
        </div>
        <StatusPill
          value={step === 'source' || step === 'grain' ? 'read_only' : 'live'}
          label={step === 'source' || step === 'grain' ? 'Read-only' : 'Live'}
          tone={step === 'source' || step === 'grain' ? 'neutral' : 'positive'}
        />
      </div>
      {step === 'source' || step === 'grain' ? (
        <div className="studio-preview__source">
          <p>{source.name}</p>
          <div className="studio-preview__stat"><span>Rows</span><strong className="mono">{source.row_count.toLocaleString()}</strong></div>
          <div className="studio-preview__stat"><span>Columns</span><strong className="mono">{source.columns.length}</strong></div>
          <div className="studio-preview__stat"><span>Grain</span><strong>{source.grain_unique ? 'Unique' : 'Review'}</strong></div>
          <p className="studio-note">The preview table is available from the Fields step once a measure is selected.</p>
        </div>
      ) : null}
      {step !== 'source' && step !== 'grain' ? (
        <>
          {error ? <ProblemBanner error={error} compact /> : null}
          {!error && measureCount === 0 ? (
            <EmptyState icon={Columns3} title="Add a measure" description="Choose at least one numeric field to run the preview." />
          ) : null}
          {!error && measureCount > 0 && pending ? <SkeletonTable rows={5} columns={4} /> : null}
          {!error && preview && measureCount > 0 ? (
            <>
              <div className="studio-preview__scope">
                <span className="status status--info"><span className="status__dot" aria-hidden />{preview.scope.applied ? titleCase(preview.scope.department_code ?? '') : 'All departments'}</span>
                <span className="mono muted">{preview.row_count.toLocaleString()} rows</span>
                <span className="mono muted">{groupCount === 0 ? 'Totals only' : `${groupCount} grouping${groupCount === 1 ? '' : 's'}`}</span>
              </div>
              <div className="table-wrap">
                <table
                  className="data-table data-table--compact studio-preview-table"
                  style={{ minWidth: Math.max(280, preview.columns.length * 68) }}
                >
                  <thead>
                    <tr>
                      {preview.columns.map((column) => <th key={column.code} className={column.kind === 'measure' ? 'num' : ''}>{column.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, index) => (
                      <tr key={index}>
                        {preview.columns.map((column) => (
                          <td
                            key={column.code}
                            className={column.kind === 'measure' ? 'num mono' : ''}
                            title={fullPreviewValue(row[column.code], column)}
                          >
                            {formatPreviewValue(row[column.code], column)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      {preview.columns.map((column, index) => (
                        <td key={column.code} className={column.kind === 'measure' ? 'num mono' : ''} title={column.kind === 'measure' ? fullPreviewValue(preview.totals[column.code], column) : undefined}>
                          {column.kind === 'measure' ? formatPreviewValue(preview.totals[column.code], column) : index === 0 ? 'Total' : ''}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
              {preview.truncated ? <p className="studio-note">Showing the first {preview.rows.length} groups.</p> : null}
              <p className="studio-preview__foot">Read-only query against the governed snapshot. Department scope is applied server-side.</p>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
