import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  ChartNoAxesCombined,
  ClipboardCheck,
  ExternalLink,
  FlaskConical,
  Layers3,
  LayoutDashboard,
  LogOut,
  PlugZap,
  Scale,
  ScrollText,
  Target,
} from 'lucide-react';
import { useAuth } from '../auth';
import { useMe } from '../queries';
import { ApiProblem } from '../api';
import { titleCase, personLabel } from '../format';

const navGroups = [
  {
    label: 'Plan',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/scenarios', label: 'Scenarios', icon: FlaskConical },
      { to: '/models', label: 'Models', icon: Layers3 },
    ],
  },
  {
    label: 'Operate',
    items: [
      { to: '/jobs', label: 'Jobs', icon: Activity },
      { to: '/reviews', label: 'Reviews', icon: ClipboardCheck },
      { to: '/plans', label: 'Plans', icon: Target },
    ],
  },
  {
    label: 'Govern',
    items: [
      { to: '/rules', label: 'Rules', icon: Scale },
      { to: '/audit', label: 'Audit', icon: ScrollText },
    ],
  },
  {
    label: 'Signals',
    items: [{ to: '/variance', label: 'Variance', icon: ChartNoAxesCombined }],
  },
];

const routeLabels: Array<[RegExp, string]> = [
  [/^\/$/, 'Overview'],
  [/^\/scenarios\/[^/]+$/, 'Scenario'],
  [/^\/scenarios$/, 'Scenarios'],
  [/^\/models\/[^/]+$/, 'Model'],
  [/^\/models$/, 'Models'],
  [/^\/jobs\/[^/]+$/, 'Job'],
  [/^\/jobs$/, 'Jobs'],
  [/^\/reviews\/[^/]+$/, 'Review'],
  [/^\/reviews$/, 'Reviews'],
  [/^\/plans\/[^/]+$/, 'Plan'],
  [/^\/plans$/, 'Plans'],
  [/^\/rules\/[^/]+$/, 'Rule'],
  [/^\/rules$/, 'Rules'],
  [/^\/variance$/, 'Variance'],
  [/^\/audit$/, 'Audit'],
  [/^\/connection$/, 'Connection'],
];

export function AppShell() {
  const { token, signOut } = useAuth();
  const meQuery = useMe(token);
  const location = useLocation();

  if (meQuery.error instanceof ApiProblem && meQuery.error.status === 401) {
    return <Navigate to="/connect?expired=1" replace />;
  }

  const me = meQuery.data?.data;
  const label = routeLabels.find(([pattern]) => pattern.test(location.pathname))?.[1] ?? 'Workspace';
  const docsUrl = import.meta.env.VITE_DOCS_URL ?? '/docs';

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <span className="brand__mark">CPM</span>
          <span className="brand__slash">/</span>
          <span className="brand__lite">LITE</span>
        </div>
        <p className="brand__caption">Planning workspace</p>

        <nav className="nav" aria-label="Primary">
          {navGroups.map((group) => (
            <div className="nav__group" key={group.label}>
              <span className="nav__label">{group.label}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={'end' in item ? item.end : undefined}
                  className={({ isActive }) => `nav__item ${isActive ? 'nav__item--active' : ''}`}
                >
                  <item.icon size={15} aria-hidden />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="rail__footer">
          <NavLink to="/connection" className={({ isActive }) => `nav__item ${isActive ? 'nav__item--active' : ''}`}>
            <PlugZap size={15} aria-hidden />
            <span>Connection</span>
          </NavLink>
          <a className="nav__item" href={docsUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={15} aria-hidden />
            <span>API documentation</span>
          </a>
          <div className="rail__user">
            <div>
              <strong>{me ? personLabel(me.display_name) : 'Connected user'}</strong>
              <span>
                {me?.department_code ? titleCase(me.department_code) : 'Cross-department'} ·{' '}
                {me?.roles.includes('steward') || me?.roles.includes('admin') ? 'Steward' : 'Business user'}
              </span>
            </div>
            <button type="button" className="icon-button icon-button--rail" onClick={signOut} aria-label="Sign out">
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__path">
            <span>Workspace</span>
            <span className="topbar__sep">/</span>
            <strong>{label}</strong>
          </div>
          <div className="topbar__meta">
            <span className={`connection-dot ${me ? 'connection-dot--on' : ''}`} />
            <span>{me ? 'API connected' : 'Connecting'}</span>
            {me?.department_code ? <span className="scope-pill">{titleCase(me.department_code)}</span> : null}
          </div>
        </header>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
