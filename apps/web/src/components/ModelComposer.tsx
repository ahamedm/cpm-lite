import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { createModel } from '../api';
import type { ModelDefinition } from '../types';
import { useToast, Button, Dialog, Field, Input, ProblemBanner, Select, Textarea } from './ui';

type Dimension = ModelDefinition['dimensions'][number];
type Measure = ModelDefinition['measures'][number];

const starterDimensions: Dimension[] = [
  { code: 'department', name: 'Department', data_type: 'string', expression: 'department_code' },
  { code: 'category', name: 'Category', data_type: 'string', expression: 'category_code' },
  { code: 'region', name: 'Region', data_type: 'string', expression: 'region_code' },
];

const starterMeasures: Measure[] = [
  { code: 'budget_amount', name: 'Budget', aggregation: 'sum', expression: 'budget_amount', format: 'currency', currency_code: 'USD' },
  { code: 'actual_amount', name: 'Actual', aggregation: 'sum', expression: 'actual_amount', format: 'currency', currency_code: 'USD' },
];

export function ModelComposerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (modelId: string) => void;
}) {
  const { token } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'department' | 'global'>('department');
  const [dimensions, setDimensions] = useState<Dimension[]>(starterDimensions);
  const [measures, setMeasures] = useState<Measure[]>(starterMeasures);

  const mutation = useMutation({
    mutationFn: () =>
      createModel(token!, {
        name: name.trim(),
        ...(code.trim() ? { code: code.trim() } : {}),
        description: description.trim() || null,
        visibility,
        definition: { schema_version: '1.0', dimensions, measures },
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
      push({ tone: 'success', title: 'Model created', detail: `${result.data.name} is ready for validation.` });
      reset();
      onCreated(result.data.model_id);
      onClose();
    },
  });

  function reset() {
    setName('');
    setCode('');
    setDescription('');
    setVisibility('department');
    setDimensions(starterDimensions);
    setMeasures(starterMeasures);
    mutation.reset();
  }

  function updateDimension(index: number, patch: Partial<Dimension>) {
    setDimensions((current) => current.map((dimension, position) => (position === index ? { ...dimension, ...patch } : dimension)));
  }

  function updateMeasure(index: number, patch: Partial<Measure>) {
    setMeasures((current) => current.map((measure, position) => (position === index ? { ...measure, ...patch } : measure)));
  }

  const canSubmit = name.trim().length > 0 && dimensions.length > 0 && measures.length > 0 && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!mutation.isPending) {
          reset();
          onClose();
        }
      }}
      title="New model"
      description="Define the dimensions and measures business users can query. Expressions are validated against the governed source."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button variant="primary" onClick={() => mutation.mutate()} disabled={!canSubmit} loading={mutation.isPending}>
            Create model
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Model name" htmlFor="model-name">
          <Input id="model-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Department budget model" autoFocus />
        </Field>
        <Field label="Code" htmlFor="model-code" hint="Optional; generated from the name when blank.">
          <Input id="model-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="department_budget" />
        </Field>
        <Field label="Visibility" htmlFor="model-visibility">
          <Select id="model-visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as 'department' | 'global')}>
            <option value="department">Department</option>
            <option value="global">Global</option>
          </Select>
        </Field>
        <Field label="Description" htmlFor="model-description" className="form-grid__wide">
          <Textarea id="model-description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this model is for and who owns it." />
        </Field>
      </div>

      <div className="composer-section">
        <div className="composer-section__header">
          <div>
            <h3>Dimensions</h3>
            <p>Columns users group and filter by.</p>
          </div>
          <Button size="sm" icon={Plus} onClick={() => setDimensions((current) => [...current, { code: '', name: '', data_type: 'string', expression: '' }])}>
            Add dimension
          </Button>
        </div>
        <div className="composer-rows">
          <div className="composer-row composer-row--header" aria-hidden>
            <span>Code</span><span>Name</span><span>Type</span><span>Expression</span><span />
          </div>
          {dimensions.map((dimension, index) => (
            <div className="composer-row" key={index}>
              <Input aria-label={`Dimension ${index + 1} code`} value={dimension.code} onChange={(event) => updateDimension(index, { code: event.target.value })} placeholder="code" />
              <Input aria-label={`Dimension ${index + 1} name`} value={dimension.name} onChange={(event) => updateDimension(index, { name: event.target.value })} placeholder="Name" />
              <Select aria-label={`Dimension ${index + 1} type`} value={dimension.data_type} onChange={(event) => updateDimension(index, { data_type: event.target.value })}>
                <option value="string">String</option>
                <option value="integer">Integer</option>
                <option value="decimal">Decimal</option>
                <option value="date">Date</option>
                <option value="boolean">Boolean</option>
              </Select>
              <Input aria-label={`Dimension ${index + 1} expression`} value={dimension.expression} onChange={(event) => updateDimension(index, { expression: event.target.value })} placeholder="expression" />
              <button type="button" className="icon-button" aria-label="Remove dimension" onClick={() => setDimensions((current) => current.filter((_, position) => position !== index))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="composer-section">
        <div className="composer-section__header">
          <div>
            <h3>Measures</h3>
            <p>Numeric outputs users aggregate.</p>
          </div>
          <Button size="sm" icon={Plus} onClick={() => setMeasures((current) => [...current, { code: '', name: '', aggregation: 'sum', expression: '', format: 'currency', currency_code: 'USD' }])}>
            Add measure
          </Button>
        </div>
        <div className="composer-rows">
          <div className="composer-row composer-row--measure composer-row--header" aria-hidden>
            <span>Code</span><span>Name</span><span>Aggregation</span><span>Expression</span><span>Format</span><span />
          </div>
          {measures.map((measure, index) => (
            <div className="composer-row composer-row--measure" key={index}>
              <Input aria-label={`Measure ${index + 1} code`} value={measure.code} onChange={(event) => updateMeasure(index, { code: event.target.value })} placeholder="code" />
              <Input aria-label={`Measure ${index + 1} name`} value={measure.name} onChange={(event) => updateMeasure(index, { name: event.target.value })} placeholder="Name" />
              <Select aria-label={`Measure ${index + 1} aggregation`} value={measure.aggregation} onChange={(event) => updateMeasure(index, { aggregation: event.target.value })}>
                <option value="sum">Sum</option>
                <option value="avg">Average</option>
                <option value="min">Minimum</option>
                <option value="max">Maximum</option>
                <option value="count">Count</option>
                <option value="count_distinct">Distinct count</option>
              </Select>
              <Input aria-label={`Measure ${index + 1} expression`} value={measure.expression} onChange={(event) => updateMeasure(index, { expression: event.target.value })} placeholder="expression" />
              <Select aria-label={`Measure ${index + 1} format`} value={measure.format} onChange={(event) => updateMeasure(index, { format: event.target.value })}>
                <option value="currency">Currency</option>
                <option value="number">Number</option>
                <option value="percent">Percent</option>
              </Select>
              <button type="button" className="icon-button" aria-label="Remove measure" onClick={() => setMeasures((current) => current.filter((_, position) => position !== index))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <ProblemBanner error={mutation.error} />
    </Dialog>
  );
}
