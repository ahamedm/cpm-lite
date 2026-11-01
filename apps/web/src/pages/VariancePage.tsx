import { useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import { useAuth } from '../auth';
import { useCubeVariance } from '../queries';
import { compactMoney, money, percent } from '../format';
import {
  EmptyState,
  LinkButton,
  PageHeader,
  Panel,
  ProblemBanner,
  Select,
  SkeletonTable,
} from '../components/ui';

export function VariancePage() {
  const { cubeToken } = useAuth();
  const [year, setYear] = useState(2023);
  const variance = useCubeVariance(cubeToken, year);
  const rows = variance.data ?? [];

  const totalBudget = rows.reduce((sum, row) => sum + Number(row['budget_vs_actual.budget_amount'] ?? 0), 0);
  const totalActual = rows.reduce((sum, row) => sum + Number(row['budget_vs_actual.actual_amount'] ?? 0), 0);
  const maxAbsVariance = Math.max(1, ...rows.map((row) => Math.abs(Number(row['budget_vs_actual.variance_amount'] ?? 0))));

  return (
    <div className="stack">
      <PageHeader
        title="Variance"
        subtitle="Governed budget vs actual by department, read through Cube access policies."
        actions={
          <div className="filter-field">
            <label htmlFor="variance-year">Year</label>
            <Select id="variance-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
              <option value={2023}>2023</option>
              <option value={2022}>2022</option>
              <option value={2021}>2021</option>
            </Select>
          </div>
        }
      />

      {!cubeToken ? (
        <EmptyState
          icon={ChartNoAxesCombined}
          title="Cube token required"
          description="The orchestrator token is connected, but variance measures come from Cube. Add a Cube token to read the governed budget-vs-actual view."
          action={<LinkButton to="/connection" variant="primary" size="sm">Open connection</LinkButton>}
        />
      ) : (
        <>
          <ProblemBanner error={variance.error} onRetry={() => variance.refetch()} />
          <Panel
            title={`Department variance · ${year}`}
            description="Actual minus budget. Positive variance means overspend."
          >
            {variance.isPending ? (
              <SkeletonTable rows={7} columns={5} />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={ChartNoAxesCombined}
                title="No rows in scope"
                description="Cube returned no budget or actual rows for this period and token scope."
              />
            ) : (
              <div className="table-wrap">
                <table className="data-table data-table--variance">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th className="num">Budget</th>
                      <th className="num">Actual</th>
                      <th className="num">Variance</th>
                      <th className="num">%</th>
                      <th>Share of variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const department = String(row['budget_vs_actual.department'] ?? '—');
                      const budget = String(row['budget_vs_actual.budget_amount'] ?? '0');
                      const actual = String(row['budget_vs_actual.actual_amount'] ?? '0');
                      const varianceValue = String(row['budget_vs_actual.variance_amount'] ?? '0');
                      const variancePct = String(row['budget_vs_actual.variance_pct'] ?? '0');
                      const numericVariance = Number(varianceValue);
                      const width = Math.min(100, (Math.abs(numericVariance) / maxAbsVariance) * 100);
                      return (
                        <tr key={department}>
                          <td>{department}</td>
                          <td className="num">{money(budget)}</td>
                          <td className="num">{money(actual)}</td>
                          <td className={`num ${numericVariance > 0 ? 'negative' : 'positive'}`}>{compactMoney(varianceValue)}</td>
                          <td className="num muted">{percent(variancePct)}</td>
                          <td>
                            <span className={`bar ${numericVariance > 0 ? 'bar--negative' : 'bar--positive'}`}>
                              <span style={{ width: `${width}%` }} />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className="num">{money(totalBudget)}</td>
                      <td className="num">{money(totalActual)}</td>
                      <td className={`num ${totalActual - totalBudget > 0 ? 'negative' : 'positive'}`}>{compactMoney(totalActual - totalBudget)}</td>
                      <td className="num muted">{totalBudget ? percent((totalActual - totalBudget) / totalBudget) : '—'}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="fineprint">Source: Cube <code className="inline-code">budget_vs_actual</code>. Department row-level policy is applied by Cube before aggregation.</p>
          </Panel>
        </>
      )}
    </div>
  );
}
