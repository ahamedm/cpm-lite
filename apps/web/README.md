# CPM Lite UI

React 19 + TypeScript + Vite task UI for the Thin Orchestrator and Cube variance view.

```bash
make setup          # installs api/cube/contracts/web dependencies
make migrate-api
make seed-api
make api            # terminal 1, :8080
make cube           # terminal 2, :4000 (after make data)
make web            # terminal 3, :5173
```

Vite proxies `/api`, `/docs` and `/cubejs-api` to localhost. Tokens are pasted on
the Connection screen and stored in `sessionStorage`; there is no token minting
endpoint.

## Design direction

Product register, not marketing. The physical scene: an FP&A analyst in a bright
office, late morning, moving a scenario from run to steward review. The UI should
feel like a precise ledger: calm, dense, and auditable.

- **Canvas**: cool neutral `oklch(0.972 0.004 220)`, not cream.
- **Rail**: deep ink, one active surface, copper icon for the current section.
- **Accent**: oxidized copper `oklch(0.55 0.13 38)` for primary actions and current
  selection only; semantic green/amber/red carry state.
- **Type**: IBM Plex Sans for UI, IBM Plex Mono for codes, money and timestamps.
  Fixed rem scale; no display font in labels or buttons.
- **Layout**: dense ledger tables, hairline rules, one aside per detail view.
  Cards are not the default; no nested cards, gradients, glass, hero metrics,
  side-stripe accents, or pill-shaped sections.
- **Motion**: 140–180 ms state feedback only; `prefers-reduced-motion` removes it.
- **Responsive**: structural, not fluid type. The rail becomes a wrapping top nav
  at 900 px; split panes stack; tables scroll inside their own container.

Design tokens and primitives live in `src/styles.css` and `src/components/ui.tsx`.

## Structure

```
src/
  api.ts             typed fetch client, problem details, ETag/idempotency, Cube
  auth.tsx           sessionStorage token context
  queries.ts         TanStack Query hooks and paged queries
  format.ts          money/percent/date/person labels
  components/        app shell, dialogs, tables, status, toasts, composers
  pages/             portfolio, models, scenarios, jobs, reviews, plans, rules, variance, audit
```

Every screen has loading, empty, error and disabled states. Jobs remain `queued`
until the scenario worker reports through the internal callback; the UI never
simulates completion.
