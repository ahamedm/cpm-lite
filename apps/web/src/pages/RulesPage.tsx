import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Scale } from 'lucide-react';
import { useAuth } from '../auth';
import { createRule } from '../api';
import { useMe, useRules } from '../queries';
import { date, titleCase } from '../format';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  ProblemBanner,
  SkeletonTable,
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui';

export function RulesPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const meQuery = useMe(token);
  const rules = useRules(token, { limit: 50 });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const isSteward = Boolean(meQuery.data?.data.roles.some((role) => role === 'steward' || role === 'admin'));
  const items = rules.data?.items ?? [];

  const create = useMutation({
    mutationFn: () => createRule(token!, { name: name.trim(), description: description.trim() || null }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['rules'] });
      push({ tone: 'success', title: 'Rule created', detail: 'Add a version to make it evaluable.' });
      setOpen(false);
      setName('');
      setDescription('');
      navigate(`/rules/${result.data.rule_id}`);
    },
  });

  return (
    <div className="stack">
      <PageHeader
        title="Rules"
        subtitle="Versioned, scoped rules for validation, allocation and promotion."
        actions={
          isSteward ? (
            <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>New rule</Button>
          ) : null
        }
      />
      <ProblemBanner error={rules.error} onRetry={() => rules.refetch()} />

      {rules.isPending ? (
        <SkeletonTable rows={6} columns={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Scale}
          title="No rules yet"
          description={isSteward ? 'Create a rule, add a scoped version, validate, then publish.' : 'A steward has not published any rules for this workspace yet.'}
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Owner</th>
                  <th>Latest version</th>
                  <th>Evaluation point</th>
                  <th className="num">Effective from</th>
                </tr>
              </thead>
              <tbody>
                {items.map((rule) => (
                  <tr key={rule.rule_id}>
                    <td>
                      <Link className="primary-cell" to={`/rules/${rule.rule_id}`}>
                        {rule.name}
                        <span>{rule.code}</span>
                      </Link>
                    </td>
                    <td>{rule.owner_department_code ? titleCase(rule.owner_department_code) : 'Global'}</td>
                    <td>
                      {rule.latest_version ? (
                        <span className="inline-pair">
                          <StatusPill value={rule.latest_version.status} />
                          <span className="mono muted">v{rule.latest_version.version_number}</span>
                        </span>
                      ) : <span className="muted">No version</span>}
                    </td>
                    <td className="muted">{rule.latest_version ? titleCase(rule.latest_version.evaluation_point) : '—'}</td>
                    <td className="num muted">{rule.latest_version ? date(rule.latest_version.effective_from) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rules.data?.hasMore ? (
            <div className="load-more">
              <Button size="sm" loading={rules.isFetchingNextPage} onClick={() => rules.fetchNextPage()}>Load more rules</Button>
            </div>
          ) : null}
        </>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New rule"
        description="Create the rule identity. Versions carry scope, effective dating and parameters."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create rule</Button>
          </>
        }
      >
        <Field label="Rule name" htmlFor="rule-name">
          <Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Variance approval gate" autoFocus />
        </Field>
        <Field label="Description" htmlFor="rule-description">
          <Textarea id="rule-description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this rule protects and when it applies." />
        </Field>
        <ProblemBanner error={create.error} />
      </Dialog>
    </div>
  );
}
