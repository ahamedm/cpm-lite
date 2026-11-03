# Design

<!-- impeccable:design-schema 1 -->

## Direction

A precise FP&A ledger, not a generic dashboard. Product surfaces are dense,
quiet and auditable. The interface earns familiarity through consistent controls
and lets the data carry the attention.

## Palette

All colours are defined in `apps/web/src/styles.css` as OKLCH tokens.

- **Canvas** `--canvas`: cool neutral `oklch(0.972 0.004 220)`.
- **Surfaces** `--surface`, `--surface-2`, `--surface-3`: near-white to cool grey.
- **Ink** `--ink`, `--ink-2`: near-black blue-grey for primary and secondary text.
- **Muted** `--muted`: body-secondary text; must clear 4.5:1 on canvas.
- **Lines** `--line`, `--line-strong`: 1px structural rules.
- **Rail** `--rail`, `--rail-2`, `--rail-ink`, `--rail-muted`: dark navigation.
- **Accent** `--accent`, `--accent-strong`, `--accent-soft`: oxidised copper for
  primary actions and current selection only.
- **State** `--positive`, `--warning`, `--negative`, `--info` with soft variants
  for status pills only.

No gradients, decorative glass, colored side-stripe borders, or accent-colored
decoration. State colour is reserved for state.

## Typography

- IBM Plex Sans for UI, headings, labels and prose.
- IBM Plex Mono for codes, money, timestamps, IDs and data.
- Fixed rem scale, no fluid display type. Product headings are 26–30px; labels
  11–12px; body 13–14px; data tables 12–13px.
- Uppercase is limited to small structural labels and table headers, with
  tracking; never as an eyebrow above every section.

## Layout

- Desktop shell: 236px ink rail + content column with a 32px page gutter.
- Detail pages: primary content plus a 300–340px aside, separated by a 1px rule,
  not a card.
- Model Studio: recipe rail + workspace + inspector, stacking at 1000px.
- Responsive changes are structural: rail becomes a wrapping top bar at 900px,
  splits stack, tables scroll inside `.table-wrap`.
- Cards are not the default container. Use open panels with rules; no nested
  cards.

## Components

Use the primitives in `apps/web/src/components/ui.tsx`: `Button`, `LinkButton`,
`StatusPill`, `PageHeader`, `Panel`, `Field`, `Input`, `Textarea`, `Select`,
`ProblemBanner`, `EmptyState`, `SkeletonTable`, `Metric`, `MetricStrip`, `Dialog`,
`ToastProvider`, `Code`.

Every interactive component needs default, hover, focus-visible, active,
disabled and loading states. Use native `<dialog>` for focused interruptions.
Motion is 140–220ms ease-out for state changes only; `prefers-reduced-motion`
removes transform/transition motion.

## Content

Use the domain glossary exactly: Model, Model Version, Dimension, Measure,
Scenario, Scenario Version, Driver, Job, Rule, Submission, Plan, Promotion,
Department, Cost Centre. Write action labels that name the action. Errors name
the problem and the recovery. Never leak a raw subject or UUID when a human label
exists; use `personLabel` and `shortId`.

## Guardrails

- No fake previews, jobs or financial values.
- Money is monospace, right-aligned, with an ISO currency; percentages are
  fractions displayed with `percent`.
- Access scope must be visible before publish.
- A published model is immutable; edits fork a draft.
- No modal for a task that needs a dedicated workspace (Model Studio is a page).

## Verification

- `make build-web` passes.
- Render at 1440px and 390px; no page-level horizontal overflow.
- Check loading, empty, error, disabled and permission states.
- Check focus rings, tab order, dialog focus restore and contrast.
- Run the impeccable detector over changed UI files before finishing.
