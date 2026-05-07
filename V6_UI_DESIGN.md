# V6 UI Design Plan

## Common Description

This document is the working design plan for a V6 user-interface redesign of Minecraft Enchantment Analyzer.

V6 should turn the current V5 interface from a single probability dashboard with advisor features attached into two clear workflows: a probability explorer for understanding distributions, and a planner/advisor for deciding what enchanting action to take next.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Research Metadata](#research-metadata)
- [Summary](#summary)
- [Background](#background)
- [Current V5 UI Inventory](#current-v5-ui-inventory)
- [Design Principles](#design-principles)
- [V6 Information Architecture](#v6-information-architecture)
- [Probability Explorer](#probability-explorer)
- [Advisor / Optimizer](#advisor--optimizer)
- [Input Model](#input-model)
- [Charts and Information Displays](#charts-and-information-displays)
- [Light Mode and Color System](#light-mode-and-color-system)
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

## V6 Information Architecture

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

Recommended mobile layout:

- top mode switch remains visible
- setup rail becomes a collapsible “Scenario” drawer
- result summary remains above charts/lists
- advanced diagnostics collapse by default

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

### Candidate future branches

- `v6-ui-shell`
- `v6-theme-tokens`
- `v6-probability-explorer`
- `v6-advisor-planner`
- `v6-optimizer-model`
- `v6-mobile-layout`

## Implementation Plan

### Phase 0 — Safety / groundwork

- Land `test-suite-cleanup` first.
- Keep current V5 behavior covered by tests.
- Add visual/theme regression tests before major CSS changes.

### Phase 1 — Design system foundation

- Introduce layout tokens and theme tokens.
- Add light/dark/system theme support.
- Port color-refresh decisions into tokens.
- Validate contrast in both themes.

### Phase 2 — UI shell and mode split

- Add top-level Explore / Plan mode switch.
- Move global scenario controls into a clearer setup rail/drawer.
- Preserve existing V5 panels inside Explore mode first.

### Phase 3 — Probability Explorer

- Make chart metric a segmented control.
- Add target chance chart metric.
- Integrate click-to-level behavior.
- Integrate grouped rank legend behavior.
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

### Phase 6 — Mobile and polish

- Convert setup rail to drawer on small screens.
- Tune spacing, typography, and density.
- Add keyboard and accessibility review.
- Update README screenshots and release notes.

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
- What is the minimum mobile experience worth supporting for V6?
- Should tiny probability odds formatting land before V6 because it improves current readability immediately?

## References / Related Docs

- `README.md` — current product summary
- `ARCHITECTURE.md` — current V5 engine and worker architecture
- `MASS_HANDLING.md` — probability accounting and confidence model
- Nielsen Norman Group, “Progressive Disclosure” — show core choices first and defer advanced controls
- Nielsen Norman Group, “Memory Recognition and Recall in User Interfaces” — prefer recognition over recall
- MDN, “Color contrast” — WCAG contrast targets for text, UI components, and graphics
- Material Design 3 color overview — useful reference for token-based theme design

## Owner / Maintainer

Jonathan Braver

## Last Updated

2026-05-07
