# UI Redesign Plan

## Common Description

This document is the working design plan for a user-interface redesign of Minecraft Enchantment Analyzer.

The redesign should turn the current interface from a single probability dashboard with advisor features attached into two clear workflows: a probability explorer for understanding distributions, and a planner/advisor for deciding what enchanting action to take next.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Research Metadata](#research-metadata)
- [Summary](#summary)
- [Background](#background)
- [Current V5 UI Inventory](#current-v5-ui-inventory)
- [Design Principles](#design-principles)
- [UI Information Architecture](#ui-information-architecture)
- [Probability Explorer](#probability-explorer)
- [Advisor / Optimizer](#advisor--optimizer)
- [Input Model](#input-model)
- [UI / Data / Engine Decoupling](#ui--data--engine-decoupling)
- [Charts and Information Displays](#charts-and-information-displays)
- [Charting Library Alternatives](#charting-library-alternatives)
- [Light Mode and Color System](#light-mode-and-color-system)
- [Responsive / Mobile Stretch Goal](#responsive--mobile-stretch-goal)
- [Branch Triage](#branch-triage)
- [Implementation Plan](#implementation-plan)
- [Options Considered](#options-considered)
- [Recommendation](#recommendation)
- [Open Questions](#open-questions)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

This design covers:

- where the current dropdowns, graphs, modes, and result panels should live in a redesigned UI
- how to make the clue advisor a first-class workflow
- how to include light mode and the adjusted color system in V6
- which current UI branches should be treated as V6 work instead of V5 patch work
- a staged implementation plan that can be split into small branches

This document does not define engine changes in detail. It may identify planner-facing data needs, but engine/API design should get a separate spec if the optimizer requires new calculations.

## Research Metadata

- Research Date: 2026-05-07
- Researcher: Thing 2 / OpenClaw
- Ticket: none yet
- Status: Draft
- Source: Current V5 UI files, recent UI branches, and general UX/accessibility guidance

## Summary

V6 should introduce two primary modes:

1. **Probability Explorer** — answer “what are the probabilities for this exact scenario?”
2. **Advisor / Optimizer** — answer “what should I do next to get the enchantment result I want?”

The current V5 layout mixes these jobs:

- global inputs live in a left sidebar
- chart metric lives inside the chart card
- advisor mode is hidden as a combo-sort option
- target selection is present, but not treated as the main user goal
- clue analysis appears as supporting information, not as a planning workflow

V6 should preserve the V5 engine strengths, but reorganize the UI around user intent.

## Background

The V5 UI is functional and testable, but several small UI branches now point toward a larger redesign:

- grouped rank chart controls
- adjusted chart/color styling
- chart click-to-level interaction
- tiny probability odds formatting
- light mode / color-system needs
- a clue advisor that is important enough to deserve its own space

Treating all of these as independent V5 patches risks making the current UI more complex without solving the underlying information architecture problem.

## Current V5 UI Inventory

### Global inputs

Currently in the left sidebar:

- Version
- Item Category
- Material
- Shown in Table / clue select
- Target Combination select + add button + chips
- Enchanting Level slider
- Enchantability display

### Main displays

Currently in the main area:

- header: “Enchantment Probabilities”
- Probability Sweep chart card
  - chart status
  - chart metric dropdown: Any Enchantment, Specific Ranks, Enchantment Count
  - grouped legend when specific-rank charts are active
- Top Combinations card
  - refinement status
  - combo sort dropdown: Highest Probability, Most Enchantments, Highest Total Rank, Best Clues
  - combo list
  - target diagnostics and clue advisor rows when relevant
- rank grid of any-enchantment probabilities

### Supported conceptual modes

The current UI has more conceptual modes than visible mode controls:

- unconditioned probability lookup
- clue-conditioned probability lookup
- target-match probability lookup
- target clue advisor
- high-roll clue signal advisor
- level + clue advisor
- chart metric inspection
- combo sorting / ranking

V6 should make these modes explicit and reduce hidden mode coupling.

## Design Principles

### 1. Split “inspect” from “decide”

Probability exploration and action planning are different jobs. V6 should not hide planner behavior inside a sort dropdown.

### 2. Use progressive disclosure

Show the most important choices first, and disclose specialized controls only when the user asks for them. This is especially important because Minecraft enchanting has many interacting dimensions: version, item, material, level, clue, target, costs, and time.

### 3. Prefer recognition over recall

Use visible choices, grouped controls, chips, and presets where possible. Avoid making users remember exact enchantment names, rank boundaries, or compatible combinations.

### 4. Keep the user goal persistent

The target build should be visible across both major modes. The user should always know what outcome the planner is optimizing for.

### 5. Show confidence without making it the center

Refinement/confidence is important for trust, but it should usually be a quiet status strip or detail drawer, not a primary card competing with the answer.

### 6. Design color as a semantic system

V6 colors should support both dark and light mode. Chart line identity should not depend on color alone; line shape, rank grouping, labels, and contrast must also carry meaning.

### 7. Make UI experiments cheap

The UI must be decoupled from data generation, engine execution, and worker/process orchestration. V6 should make the interface a replaceable presentation layer over stable typed data, so large UI experiments can happen without risking the probability engine.

## UI Information Architecture

### Shell layout

Recommended desktop layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Top bar: app title | mode switch | theme | share/export      │
├───────────────┬──────────────────────────────────────────────┤
│ Setup rail    │ Main mode workspace                          │
│               │                                              │
│ Scenario      │ Probability Explorer OR Advisor / Optimizer   │
│ Goal          │                                              │
│ Constraints   │                                              │
│ Status        │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

Possible future mobile layout if mobile becomes important:

- top mode switch remains visible
- setup rail becomes a collapsible “Scenario” drawer
- result summary remains above charts/lists
- advanced diagnostics collapse by default

This is a stretch-goal direction, not first-party V6 scope.

### Top-level mode switch

Use explicit tabs or segmented buttons:

- **Explore probabilities**
- **Plan / optimize**

Do not represent this as a dropdown and do not bury it under combo sorting.

## Probability Explorer

Purpose: understand probability distributions for a chosen scenario.

### Primary controls

- XP level slider / numeric input
- shown clue selector: None / observed table clue
- chart metric segmented control:
  - Target chance
  - Any enchantment
  - Specific ranks
  - Enchantment count

### Primary displays

1. **Scenario summary strip**
   - item + material + version
   - selected level
   - enchantability
   - clue-conditioning state
   - target match chance if a target exists
   - refinement confidence

2. **Probability sweep chart**
   - central visual for level-by-level comparison
   - click-to-level interaction
   - visible, grouped rank legend for specific-rank mode
   - target-chance metric should become a first-class chart option

3. **Outcome cards**
   - Top combinations
   - Any enchantment probabilities
   - Specific target diagnostics

4. **Details drawer**
   - accounting: resolved, pending, sieved, overflow, rounding
   - clue-known compatible/incompatible mass
   - exact technical interpretation of the displayed probabilities

## Advisor / Optimizer

Purpose: recommend the next action for a desired result.

This should become the home for clue advisory, level advisory, and future time/XP/chance/anvil-cost optimization.

### Primary controls

- target build / desired enchantments
- allowed ranks: exact, at least, any
- optimization objective:
  - maximize single-attempt chance
  - minimize expected attempts
  - minimize expected XP
  - minimize expected time
  - minimize expected anvil cost
  - balanced recommendation
- constraints:
  - maximum XP level
  - maximum attempts
  - available lapis/books/items if later modeled
  - allowed anvil operations if later modeled

### Primary displays

1. **Best next action**
   - recommended level
   - recommended clue to wait for / accept
   - chance per attempt
   - expected attempts
   - expected XP/time
   - expected anvil cost when modeled
   - “why this is best” explanation

2. **Level + clue matrix**
   - rows: XP levels or grouped level bands
   - columns/cards: shown clues
   - score by selected objective
   - visual encoding for chance, cost, or expected value

3. **Build plan**
   - target enchantments and ranks
   - compatible alternatives
   - conflict blockers
   - “one target short” near misses
   - combine/anvil plan when available

4. **Recommendation explanation**
   - baseline chance
   - clue-conditioned chance
   - compatible baseline
   - lift over baseline
   - clue appearance chance
   - confidence / search completeness

### Naming

Use user-centered labels:

- “Plan / optimize” for the mode
- “Best next action” for the top card
- “Shown clue value” or “Clue signal” for clue-lift displays
- “Expected attempts” instead of only raw probability

## Input Model

### Version

Keep global. Use a searchable select or grouped list if versions grow.

Version labels should be explicit ranges, not only the internal breakpoint versions. The data model can keep using canonical breakpoint keys such as `1.14.3`, but the UI should explain the span of Minecraft releases covered by that ruleset.

Examples:

- `1.0` should display as a range ending before the next rules breakpoint, not as only `1.0`.
- `1.14.3` should communicate “1.14.3 through the versions before 1.16” rather than implying only exactly `1.14.3`.
- The latest ruleset should display as an open-ended range, for example `1.21.11+`, if no later breakpoint exists.

Implementation notes:

- Keep the select option `value` as the canonical engine version key.
- Generate a separate display label such as `start-end`, `start-before next`, or `start+`.
- Put version-label formatting in UI metadata/projection code, not inside the engine.
- Add a small test for version option labels so future data changes do not make the UI ambiguous again.

### Item category and material

Keep global, but consider card/segmented selection:

- category groups: Armor, Tools, Weapons, Other
- material should only show compatible options
- avoid contradictory defaults; one selected category only

### Target build

Make this the central goal object:

- selected enchantment chips
- per-chip rank mode: exact / at least / any
- conflict warnings inline
- target presets later: “God pickaxe”, “Max sword”, etc.

### Shown clue

In Explore mode: an observed scenario input.

In Plan mode: a candidate signal or filter:

- “I saw this clue” for current-table advice
- “Which clue should I wait for?” for planner mode

### XP level

In Explore mode: one selected level plus chart sweep.

In Plan mode: a search dimension with constraints.

## UI / Data / Engine Decoupling

V6 should deliberately separate the product into independent layers:

1. **Engine / data layer** — Minecraft mechanics, probability calculations, snapshot generation, accounting, and planner scoring.
2. **Worker / process layer** — background execution, progressive refinement, cancellation, checkpointing, and message/protocol handling.
3. **Projection layer** — converts engine/worker outputs into stable UI-facing view models.
4. **Presentation layer** — layout, controls, charts, lists, theme, and interaction design.

The presentation layer should be free to change radically. Chart.js, ECharts, a custom SVG matrix, a React shell, or a no-framework shell should all consume the same projected data contracts.

### Required boundaries

- Engine code must not depend on DOM, CSS, browser layout, chart libraries, or UI component state.
- Worker protocols must remain explicit typed messages, not implicit UI callbacks.
- UI code should send user intent as commands/inputs, not call internal engine steps directly.
- Charts should consume normalized chart view models, not raw engine internals.
- Planner displays should consume planner/advisor view models, not reconstruct scoring logic in the UI.
- Theme/color tokens should live outside probability data; data semantics should not depend on a specific visual palette.
- UI experiments should be able to swap shell/layout/chart components without changing engine tests.

### Practical V6 contracts

- `ScenarioInput` — version, item category, material, level, clue, target build, and constraints.
- `ExplorerViewModel` — scenario summary, sweep series, top combinations, rank probabilities, diagnostics.
- `PlannerViewModel` — best next action, objective scores, level + clue matrix, explanation, diagnostics.
- `ChartViewModel` — chart-independent series/matrix data with labels, semantic roles, and recommended encodings.
- `RunStatusViewModel` — progress, confidence, accounting, pending/refined/completed state.

These names are illustrative; exact types should be defined near the V6 implementation work. The important rule is that UI components render view models and emit intent events.

### Acceptance criteria

- It should be possible to prototype a new V6 shell using recorded snapshots/view models without running the full engine live.
- It should be possible to replace the chart library without changing engine or worker code.
- It should be possible to test engine/planner output independently from UI rendering.
- It should be possible to run UI regression tests from fixed fixture data.
- Any future mobile/adaptive presentation should reuse the same data contracts rather than forking calculation logic.

## Charts and Information Displays

### Charts to keep / add

- Keep probability sweep.
- Add target chance as a first-class chart metric.
- Keep specific-rank chart, but use grouped controls and non-color line distinctions.
- Consider an optimizer matrix instead of forcing advisor data into line charts.

### Lists to keep / reshape

- Top combinations remains useful in Explore mode.
- Rank grid remains useful, but should become an “Enchantments” panel with filtering/search if it grows.
- Advisor rows should move out of the combo list into dedicated Planner cards.

### Status displays

- Chart status and refinement status should consolidate into one scenario/result status region.
- Technical accounting should be available, but behind details.

## Charting Library Alternatives

V5 currently uses Chart.js from a CDN for the probability sweep chart. V6 should treat charting as an explicit dependency decision because the product is becoming less like a simple dashboard and more like an exploratory/planning tool.

### Evaluation criteria for V6

- Line-chart quality for 1-30 enchanting levels with many possible series.
- Heatmap/matrix support for the Advisor level + clue matrix.
- Click/hover/keyboard interaction hooks for “click level to inspect” and “select planner cell”.
- Support for grouped legends, dashed/ranked line styles, and non-color encodings.
- Theme integration with V6 light/dark tokens.
- Small enough bundle for a static app, or tree-shakeable enough to justify the features.
- Comfortable TypeScript integration without fighting the current no-framework/static-app shape.

### Shortlist

#### Apache ECharts

Best candidate if V6 wants rich interaction without building everything by hand.

Pros:

- Strong built-in support for line charts, heatmaps, scatter, visual maps, brushing, zooming, legends, tooltips, and mobile interactions.
- Can cover both Probability Explorer sweeps and Advisor matrix views with one library.
- Supports Canvas and SVG renderers, datasets, encodings, and custom series for unusual displays.
- Apache-2.0 license.

Cons:

- Large dependency compared with the current minimal Chart.js setup.
- Option schema can become verbose; needs a thin app-local adapter to keep chart specs readable.

V6 fit:

- Good default recommendation to prototype first, especially for the Level + Clue matrix.

#### Vega-Lite / Vega Embed

Best candidate if we want chart specs to be declarative, testable, and close to the data model.

Pros:

- Declarative grammar with line, rect/heatmap, text, layered views, point selection, and interval selection.
- Nice match for snapshot-style data and for documenting chart intent.
- BSD-3-Clause license.

Cons:

- Interaction with app state can feel indirect compared with imperative chart APIs.
- Bundle stack is not tiny once Vega/Vega-Lite/Vega-Embed are included.

V6 fit:

- Worth a prototype for the optimizer matrix and “explainable chart spec” direction.

#### Observable Plot

Best candidate for compact exploratory static charts, but probably not enough for V6 planner interactions.

Pros:

- Concise API, good defaults, strong support for exploratory plots, tooltips, pointer/crosshair, and SVG output.
- Smaller than the heavier dashboard/scientific libraries.
- ISC license.

Cons:

- Brushing/selection and pan/zoom are still limited/planned rather than mature built-ins.
- Reactivity/app-state integration requires re-rendering or lower-level DOM handling.

V6 fit:

- Good for quick internal prototypes; risky as the main V6 chart engine if planner selection is central.

#### visx

Best candidate if V6 moves to React and wants full design-system control.

Pros:

- Low-level React + D3 primitives; excellent control over markup, theme tokens, accessibility, custom legends, and interaction semantics.
- Small modular packages instead of one large all-in-one runtime.
- MIT license.

Cons:

- Not a batteries-included charting library; we would build legends, tooltips, matrix cells, gestures, and interactions ourselves.
- Only a natural choice if the V6 UI also adopts React or a similar component layer.

V6 fit:

- Keep as a candidate only if the broader UI architecture changes toward React/components.

#### Plotly.js

Best candidate for scientific-style charts, but likely heavy for this app.

Pros:

- Rich chart types, heatmaps/contours, declarative JSON specs, hover/zoom/export, and WebGL-backed scatter options.
- MIT license for plotly.js.

Cons:

- More charting power than V6 needs; UI chrome and behavior may feel less native to the app.
- Bundle weight and styling integration are concerns.

V6 fit:

- Consider only if ECharts/Vega-Lite cannot handle the matrix/explorer interactions cleanly.

#### uPlot

Best candidate for ultra-fast line sweeps, but not a full V6 solution.

Pros:

- Very small and fast for line/time-series-style charts; supports zoom, cursor, live legend values, dashed line styles, and plugins.
- MIT license.

Cons:

- Focused on lines/areas/bars, not planner heatmaps or rich categorical matrix views.
- Would need a second visualization approach for Advisor.

V6 fit:

- Good fallback if the Explorer chart must stay tiny and fast, but not ideal as the only chart library.

### Initial recommendation

Prototype **Apache ECharts** first for V6 charting.

Reasons:

- It covers both major V6 visualization needs: probability sweep lines and advisor matrices.
- It has mature built-in interaction features, reducing custom chart code.
- It supports non-color encodings and rich legend/tooling better than the current Chart.js setup.

Keep **Vega-Lite** as the second prototype if the desired direction is “chart specs as data”. Keep **visx** only if V6 adopts React/component architecture. Avoid committing to **Observable Plot** as the main library unless planner interactions stay simple.

### Prototype tasks

1. Build a small ECharts probability sweep prototype from existing sweep data.
2. Build a small ECharts level + clue heatmap prototype with cell click/hover.
3. Measure generated bundle size in the current esbuild pipeline.
4. Confirm dark/light token integration and line dash/shape encodings.
5. Decide whether to keep one chart adapter for both Explore and Plan, or separate chart components behind one data-normalization layer.

## Light Mode and Color System

Light mode should be part of V6, not a late visual patch.

### Requirements

- Theme tokens for both dark and light mode:
  - background
  - surface
  - surface-raised
  - border
  - text-primary
  - text-muted
  - accent
  - success/warning/danger/info
  - chart palette
- Minimum contrast targets:
  - body text: WCAG AA 4.5:1
  - large text: WCAG AA 3:1
  - UI components and graphical objects: 3:1
- Chart semantics must not rely on hue alone.
- Rank lines need stable color per enchantment plus shape/dash distinction per rank.
- Color changes from `color-refresh-2026-05-06` should be reviewed as design-system tokens, not one-off constants.

### Theme behavior

- Default to system preference if no saved setting exists.
- Offer explicit Light / Dark / System control.
- Persist the user choice locally.
- Test both themes in UI regression tests.

## Responsive / Mobile Stretch Goal

Mobile should be treated as a stretch goal, not first-party V6 support. The product is dense, chart-heavy, and planner-oriented; forcing full mobile support into the first V6 pass would likely distort the desktop/tablet workflow that matters most.

The current V5 page is a mobile non-starter and should not receive dedicated mobile investment. Its responsive layer is shallow: the dashboard collapses from two columns to one below 1200px, but the page still uses a fixed 320px sidebar, `height: 100vh`, `overflow: hidden` on the body, generous desktop padding, inline header/card styles, and a 400px chart container.

The V6 goal is therefore not “build mobile support now.” The goal is to avoid architectural decisions that would make mobile painful later if it becomes important.

### Effort estimate

#### Small V5 patch: not recommended

Goal: make the current page not broken on narrow screens.

- Stack sidebar above main content below a mobile breakpoint.
- Allow normal document scrolling instead of body-level overflow hiding.
- Reduce main/card padding and chart height on phones.
- Make chart/result card headers wrap cleanly.
- Make selects/buttons full-width where needed.

This is technically possible in 0.5-1 day, but it is not worth doing unless there is an urgent need. V5 mobile is not a supported target.

#### Future-safe V6 layout: 0.5-1.5 days inside shell work

Goal: avoid making future responsiveness harder.

- Introduce layout tokens and breakpoint rules.
- Avoid hard-coding desktop-only dimensions where simple CSS variables would work.
- Keep setup/scenario controls structurally separate from result panels.
- Avoid inline styles for major layout decisions.
- Keep chart controls and result summaries in semantic containers that can reflow later.
- Add one narrow-viewport smoke test only if it is cheap and does not imply full mobile support.

This is the recommended V6 posture.

#### Real mobile support: stretch goal / V6.x+

Goal: make the Advisor / Optimizer experience feel intentionally designed for phones.

- Design dedicated mobile flows for selecting targets, clues, objectives, and constraints.
- Build bottom-sheet or stepper interactions for dense controls.
- Tune the level + clue matrix for small screens, including sticky labels or drill-down cards.
- Add accessibility/keyboard review, visual regression snapshots, and real-device manual testing.
- Validate chart-library-specific touch behavior as part of the ECharts/Vega-Lite prototype.

This is likely 1-2 weeks and should not be part of first-party V6 scope unless mobile becomes a primary product goal.

### Recommendation

Treat mobile as a stretch goal. Do not build first-party mobile support in the initial V6 plan. During V6 shell/design-system work, preserve the option to support mobile later by keeping layout structure clean, avoiding brittle fixed dimensions, and separating setup controls from result displays.

Minimum V6 posture:

- Desktop: setup rail + main workspace.
- Tablet/narrow desktop: should degrade gracefully if practical.
- Phone: not first-party supported; avoid making future support harder.

### Likely implementation model

If mobile support becomes worth doing later, use **one adaptive web app**, not a separate mobile build.

The app should keep one shared engine, state model, data normalization layer, route/page, and design-token system. Mobile-specific work should live at the presentation layer only.

Recommended structure:

- **Shared core:** engine snapshots, planner inputs, chart data transforms, theme tokens, formatting helpers.
- **Shared page shell:** one V6 page with mode state, scenario state, and result state.
- **Adaptive layout:** CSS grid/flex/container queries decide whether setup controls render as a rail, stacked panel, or future drawer.
- **Optional mobile variants:** only for genuinely dense UI pieces, such as the target builder, chart legend, and level + clue matrix.
- **No separate build:** avoid `m.` routes, duplicate bundles, duplicate state wiring, or mobile-only engine behavior.

What fits this project best:

- Initial V6 should be **desktop/tablet-first with future-safe adaptive structure**.
- If phone support happens later, it should be an **adaptive presentation layer** on top of the same V6 app.
- A fully separate mobile build does not fit the project size or maintenance budget.
- A native app is out of scope unless mobile becomes the main use case.

Practical examples:

- Setup rail: desktop sidebar → narrow stacked panel → future mobile drawer.
- Probability sweep: desktop full chart + legend → future mobile simplified chart with collapsible legend.
- Advisor matrix: desktop heatmap/table → future mobile drill-down cards or level-grouped list.
- Details/accounting: desktop drawer/panel → future mobile collapsed disclosure sections.

### Mobile compatibility risks

The main risk is not that mobile is impossible. The risk is that a dense desktop-first planner becomes either cramped, misleading, or expensive to retrofit.

- **Information density:** Version, item, material, clue, target build, level, metric, sort, status, charts, combinations, and rank grids compete for limited vertical space.
- **Chart legibility:** Multi-series probability sweeps and grouped rank legends can become unreadable on small screens, especially when color/dash/label encodings all matter.
- **Matrix usability:** The Advisor level + clue matrix may not fit phone widths without horizontal scrolling, drill-down cards, or a completely different interaction pattern.
- **Touch precision:** Click-to-level, hover tooltips, dense legends, chip removal, and tiny select controls need larger touch targets and cannot rely on hover.
- **Control flow complexity:** Planner interactions may need drawers, steppers, or bottom sheets so the user can change scenario inputs without losing the result context.
- **Viewport and scrolling traps:** Fixed sidebars, `100vh`, sticky panels, and chart canvases can behave poorly on mobile browser chrome and virtual keyboards.
- **Performance/battery:** Rich chart libraries, large canvases/SVGs, and frequent re-renders can feel heavier on low-end phones than on desktop.
- **Testing burden:** Real support would require additional Playwright viewports, touch behavior checks, browser quirks, and probably some real-device testing.
- **Design distortion:** Optimizing too early for phone screens could compromise the desktop/tablet workflow, which is the likely primary use case for this app.

Mitigation for first-pass V6 is architectural: keep sections separable, avoid fixed desktop-only assumptions, and do not make hover-only or canvas-only interactions the only way to understand the result.

## Branch Triage

### Move into V6 design/implementation

- `color-refresh-2026-05-06`
  - Good input for V6 chart palette and rank style system.
  - Should not be treated as only a small V5 color patch unless needed urgently.

- `chart-display-grouping`
  - Grouped rank legend belongs in the V6 chart system.
  - Tiny probability odds formatting can land independently if desired, but the rank chart UX is V6-aligned.

- `chart-click-set-level`
  - Click-to-level is a strong Explorer interaction.
  - Should be preserved in V6 chart behavior.

### Keep separate from V6

- `test-suite-cleanup`
  - This is infrastructure hygiene, not V6 design.
  - It should land early because it makes future UI work safer.

- `refinement-checkpoint-calibration`
  - This is engine/service research, not UI design.
  - It should instrument checkpoint accuracy, resolved graph distribution, iteration limits, and threshold choices across items.
  - The UI should consume the resulting confidence/status model, but should not own the search-threshold tuning.

### Imported current UI pointers

The following notes were deduped against the plan above. Items already covered by existing sections are listed here only when they add concrete behavior or acceptance detail.

- **Chart legibility and interaction**
  - Covered by: Design color as a semantic system, Charts and Information Displays, Charting Library Alternatives, Light Mode and Color System.
  - Carry forward: add axis labels; sort tooltips by visible value; use filled legend swatches; highlight the hovered chart line; when hovering a legend label, highlight that series and mute or desaturate the rest.
  - Carry forward: make enchant ranks distinguishable by more than small lightness changes, using larger color deltas plus dash/shape/marker differences.
  - Carry forward: choose palettes so enchantments likely to appear together do not receive confusingly similar encodings. Crossbow and tool charts are good stress cases.
  - Carry forward: remove the current specific-rank discoverability trap where lower-priority series can be excluded by an alphabetical/top-N cutoff.

- **Version and material affordances**
  - Covered by: Input Model / Version, Input Model / Item category and material.
  - Carry forward: tint or otherwise mark versions that do not support the currently selected item while keeping them selectable.
  - Carry forward: add material colors or tints so material choices are easier to scan.

- **Layout and polish**
  - Covered by: Responsive / Mobile Stretch Goal and Phase 6.
  - Carry forward: remove brittle fixed sizing in the redesigned shell; keep desktop/tablet first, but preserve a clean path to an adaptive mobile presentation.
  - Carry forward: add a custom tab icon/favicon as polish.

- **Explorer display modes**
  - Covered by: Probability Explorer and Charts and Information Displays.
  - Carry forward: add a grouped-by-level sidebar/list mode similar to the first list on minecraft.tools, separate from the grouped rank legend.

- **Run status model**
  - Covered by: Charts and Information Displays / Status displays and UI / Data / Engine Decoupling.
  - Carry forward: top-combination refinement and full chart sweep progress may finish at different times, especially for books. They should be derived from one status model, but the UI must make each run's state legible.

### Notes not carried forward as V6 todos

These notes describe behavior that is already present in the current app, or was fixed during the 6.0.1 patch, so they should not be re-added as new UI-plan work unless later regression evidence appears.

- Multi-enchant target filtering with non-100% filtered totals.
- Target clue advisor / desired-roll recommendation and high-roll clue signals.
- Top-combination sort modes for most enchants and highest total rank.
- Item/version repair when switching to unsupported items such as trident in `1.0`.
- Single-material item locking for trident-like items.
- Preserving conflicting shown clue + target selections and showing the existing no-match state.
- Separate selected-level/top-result status and chart sweep status.
- Simple-item completion status reaching `Complete`.

### Candidate future branches

- `v6-ui-shell`
- `v6-theme-tokens`
- `v6-probability-explorer`
- `v6-advisor-planner`
- `v6-optimizer-model`
- `v6-mobile-layout` (stretch goal / V6.x only)

## Implementation Plan

### Phase 0 — Safety / groundwork

- Land `test-suite-cleanup` first.
- Keep current V5 behavior covered by tests.
- Define or stabilize V6 UI-facing view models before major layout experiments.
- Add fixture/snapshot-driven UI tests so UI experiments do not require live engine runs.
- Add visual/theme regression tests before major CSS changes.

### Phase 1 — Design system foundation

- Introduce layout tokens and theme tokens.
- Add light/dark/system theme support.
- Port color-refresh decisions into tokens.
- Define semantic chart encodings for enchant identity, rank identity, hover state, and material identity.
- Validate contrast in both themes.

### Phase 2 — UI shell and mode split

- Add top-level Explore / Plan mode switch.
- Move global scenario controls into a clearer setup rail/drawer.
- Preserve existing V5 panels inside Explore mode first.
- Avoid fixed desktop-only sizing that would block later adaptive layouts.

### Phase 3 — Probability Explorer

- Make chart metric a segmented control.
- Add target chance chart metric.
- Integrate click-to-level behavior.
- Integrate grouped rank legend behavior.
- Add grouped-by-level sidebar/list behavior.
- Add chart axis labels, value-sorted tooltips, filled legend swatches, legend/line hover highlighting, and discoverable controls for hidden series.
- Move technical accounting into a detail drawer.

### Phase 4 — Advisor / Optimizer

- Move clue advisor out of combo sorting.
- Build Best Next Action card.
- Build Level + Clue matrix.
- Add objective selector and constraints.
- Add explanation/why-this-is-best panel.

### Phase 5 — Optimizer expansion

- Model expected attempts, XP, time, and anvil costs.
- Decide whether anvil planning is deterministic UI logic or needs an engine-level API.
- Add tests around optimizer scoring and visible recommendations.

### Phase 6 — Polish

- Tune spacing, typography, and density.
- Add keyboard and accessibility review.
- Update README screenshots and release notes.
- Keep mobile-specific layout work as a stretch goal unless product priorities change.

## Options Considered

### Option A — Patch V5 incrementally

Pros:

- lowest short-term risk
- branches are already small
- faster to land isolated UI improvements

Cons:

- advisor remains hidden in a sort dropdown
- sidebar/dashboard complexity grows
- light mode and color changes may be bolted on instead of systematic

### Option B — Full rewrite of UI before landing any branches

Pros:

- cleanest design
- avoids carrying V5 layout constraints

Cons:

- high regression risk
- harder to review
- delays useful improvements

### Option C — V6 shell first, then migrate branches into it

Pros:

- preserves small-branch discipline
- lets V6 architecture guide the UI work
- allows current tested behavior to remain stable during migration

Cons:

- requires discipline not to over-polish V5 in parallel
- some branches may need to be rebased/redesigned

## Recommendation

Use Option C.

Create a V6 UI branch line with a shell/design-system foundation first, then migrate the existing UI branches into the new architecture:

1. Land test-suite cleanup.
2. Create V6 theme tokens and light mode.
3. Create the Explore / Plan mode split.
4. Migrate chart click and grouped chart controls into Explore mode.
5. Promote clue advisor into Plan mode.
6. Add optimizer dimensions after the planner UI has a stable place for them.

This keeps V6 ambitious without turning it into one giant unreviewable rewrite.

## Open Questions

- Should V6 remain a single-page static app, or is a small state/router layer worth adding?
- What is the first optimizer objective: chance, XP, time, anvil cost, or balanced score?
- Should anvil cost optimization be in V6 initial scope or a V6.x follow-up?
- Do we need saved target presets?
- Should probability Explorer and Planner share the same chart component or use separate visualization components?
- Should V6 replace Chart.js, and if so should Apache ECharts be the first prototype?
- What small layout constraints should V6 avoid so future mobile support remains possible?
- Should tiny probability odds formatting land before V6 because it improves current readability immediately?

## References / Related Docs

- `README.md` — current product summary
- `ARCHITECTURE.md` — current V5 engine and worker architecture
- `MASS_HANDLING.md` — probability accounting and confidence model
- Nielsen Norman Group, “Progressive Disclosure” — show core choices first and defer advanced controls
- Nielsen Norman Group, “Memory Recognition and Recall in User Interfaces” — prefer recognition over recall
- MDN, “Color contrast” — WCAG contrast targets for text, UI components, and graphics
- Material Design 3 color overview — useful reference for token-based theme design
- Chart.js documentation — current V5 chart baseline
- Apache ECharts features documentation — line, heatmap, brush, zoom, tooltip, visualMap, Canvas/SVG support
- Vega-Lite documentation — declarative marks and selection parameters
- Observable Plot interactions documentation — pointer/crosshair support and current selection/zoom limitations
- visx README — low-level React + D3 visualization primitives
- Plotly.js documentation — declarative scientific charting and high-performance chart types
- uPlot documentation — small, fast line-chart-focused alternative

## Owner / Maintainer

Jonathan Braver

## Last Updated

2026-05-09
