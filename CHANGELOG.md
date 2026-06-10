# Changelog

All notable changes to this project will be documented in this file.

## v8.1.0 (2026-06-10)

### Changed
- **Flex search implementation**: Checkpoint, worker-refinement, clue-filtered, custom-registry, and exhaustive searches now use the rank-merged Flex implementation internally. Public result shapes and package APIs are unchanged.

### Cleanup
- **Legacy Flex internals**: Removed the old grouped-Flex comparison runtime, probes, and unit tests now that the maintained Flex path handles public search execution.

### Developer Experience
- **Search diagnostics**: Diagnostic snapshots now report Flex graph/pool merge counters and projection/accounting loss with default-engine field names instead of old backend labels.
- **Release coverage**: Added coverage for representative item, book, clue-conditioned, custom-registry, and exhaustive cases on the maintained Flex path.

### Documentation
- **Engine documentation**: Updated the architecture, search-engine deep dive, Flex rank-merge notes, contribution guide, and public API notes to describe the current Flex implementation and keep implementation-specific classes outside the supported package API.

## v8.0.0 (2026-05-29)

### The "Mental Gymnastics" Update

Using some incredible mental gymnastics, the engine now runs faster, is more accurate, and uses less CPU and memory, especially for complex searches.
It also adds CLI support and formalizes the package API so future engine work can move without exposing search internals.

### Breaking
- **Package root API**: The package root is now a supported analyzer interface, not the internal engine surface. Callers that imported engine factories, registry factories, search and checkpoint classes, backend selectors, or diagnostic internals should migrate to `EnchantingAnalyzer` and the exported request/result types.
- **Registry customization**: Customization is now supported through vanilla-derived `RegistryMutation` inputs. Full resolved registry tables, packed lookup structures, and direct registry construction are no longer part of the package-root contract.

### Added
- **Supported package API**: Added a stable analyzer interface for applications and scripts, with human-readable and machine-readable result modes.
- **Package CLI**: Added `mcenchant` and `mc-enchanting-analyzer` commands for running analysis jobs from the terminal, with text and JSON output.
- **Vanilla-derived custom analyzers**: Added supported mutation-based customization for callers who need targeted rule changes on top of bundled Minecraft data.

### Improved
- **Deep book searches**: High-level book calculations can now be driven much further, allowing more reliable exhaustive searches even for modern books.
- **Clue-filtered results**: Searches with a shown table clue now track progress, uncertainty, and unfinished probability mass more consistently with normal searches.

### Performance
- **Large search efficiency**: Reduced CPU and memory use for the largest searches, especially high-level book calculations and deep refinement runs.

### Fixed
- **Legacy enchantment rules**: Restored the pre-1.8 additional-enchantment level decay, correcting historical book and additional-enchantment probabilities.

### Developer Experience
- **Public API contract coverage**: Added tests for the analyzer facade, CLI output modes, search controls, mutation types, packed-package declarations and runtime imports, and non-boundary Minecraft versions.
- **Release advisories**: Added read-only advisory preview jobs and expanded trusted CI and snapshot advisory summaries so reviewers can see CI-sensitive changes and generated snapshot deltas more clearly.
- **Search diagnostics and profiling**: Refreshed grouped-runtime counters, snapshot accounting diagnostics, and profiling scripts for the maintained V8 search path.

### Documentation
- **Supported API and architecture docs**: Updated public API, architecture, mass-accounting, and search-engine docs to describe the supported V8 surface and current engine design.

## v7.4.8 (2026-05-29)

### Developer Experience
- **Snapshot advisory**: Added a non-blocking PR advisory that summarizes generated snapshot changes against the base branch, including raw and human snapshot counts, diff volume, added cases, combo churn, accuracy shifts, and diagnostic/accounting field changes.
- **CI advisory summaries**: Replaced context-poor critical workflow diff excerpts with structured workflow behavior summaries that show new or changed triggers, permissions, concurrency, jobs, checkout targets, and CI entrypoints.

## v7.4.7 (2026-05-29)

### Developer Experience
- **CI advisory scope**: Made CI behavior detection advisory-only, removed the release-validator isolation failure for mixed CI/product changes, and taught the advisory to scan workflow/action files for invoked package scripts, transitive script calls, direct CI support scripts, changed helper files those scripts execute, and inline critical workflow diff lines for trigger, permission, target, and condition changes.

## v7.4.6 (2026-05-29)

### Developer Experience
- **Release policy cleanup**: Treated major-release names such as `### The "..." Update` as release metadata instead of changelog sections, moved changelog SemVer validation into one CI job, and kept branch-shape validation focused on release metadata.
- **Release docs policy**: Allowed public API and search-engine docs in final release metadata commits and required public API docs to be reviewed for minor and major releases.
- **CI advisory separation**: Split CI change advisory checks into their own target-branch workflow while keeping release pre-merge checks focused on release validation.

## v7.4.5 (2026-05-23)

### Performance
- **Flex checkpoint internals**: Reduced allocation and lookup overhead in explicit Flex checkpoint searches by keeping frontier mass directly on heap entries and avoiding temporary edge-share objects during expansion.

### Developer Experience
- **Flex mass diagnostics**: Added a detailed stage/operation accounting view for explicit Flex searches so internal comparisons can separate search mass movement from projection rounding while preserving the existing public accounting totals.

## v7.4.4 (2026-05-23)

### Cleanup
- **Experimental backend cleanup**: Removed the obsolete Plex prototype so internal grouped-search diagnostics use the maintained Flex path instead.

### Documentation
- **Factorized engine notes**: Updated the architecture, mass-accounting, and Flex design docs to describe Plex as a removed prototype and Flex as the only active grouped-engine diagnostic path.

## v7.4.3 (2026-05-22)

### Developer Experience
- **Release changelog categories**: Added patch-safe `Performance`, `Documentation`, and `Cleanup` sections, clarified reader-first release-note guidance, and documented common section near-misses.

## v7.4.2 (2026-05-22)

### Fixed
- **Flex custom-registry searches**: Kept unsafe explicit Flex searches inside Flex by switching only unsafe custom-registry cases to program-aware node identity.
- **Flex checkpoint consistency**: Drained equal-priority frontier bands at checkpoint limits so bounded book-heavy diagnostic searches do not split equivalent-priority mass arbitrarily.
- **Flex clue checkpoints**: Aligned explicit Flex clue-aware expansion and pending projection with concrete V7 by pruning clue-impossible grouped-edge mass while keeping unfinished clue-reachable branches pending.

### Developer Experience
- **Experimental backend framing**: Clarified that Plex and Flex are opt-in experimental/internal diagnostic backends. Concrete `SearchRun` remains the semantic reference and default product path.
- **Flex correctness coverage**: Added targeted coverage for custom-registry fallback, equal-priority checkpoint draining, exact clue projection, and concrete-led backend checks.

## v7.4.1 (2026-05-22)

### Fixed
- **Plex clue projection**: Corrected the internal Plex backend to treat observed clues as exact enchantment-rank matches during clue-aware pruning and concrete compatibility projection, rather than treating clue ranks as minimum target thresholds. This keeps backend-only Plex comparisons aligned with the public concrete engine.

## v7.4.0 (2026-05-21)

### Added
- **Plex backend routing**: Added an internal `searchBackend: 'plex'` selector so `SearchExecutionService` can route `searchToCheckpoint`, sequential checkpoints, and `getStats` through Plex while keeping concrete `SearchRun` as the default path.
- **Flex factorized backend**: Added `searchBackend: 'flex'` as the latest factorized-runtime iteration, with grouped fixed/choice programs, concrete-compatible projection, cached refinement resume, async checkpoint advancement, abort handling, and public stats/checkpoint routing when explicitly requested.
- **Flex parity controls**: Added an internal `probabilityFloor` override so Flex parity diagnostics can disable the bounded-search floor without changing the product default.

### Improved
- **Plex backend hardening**: Bounded Plex service caches, added reduced-key invariant fallback for unsafe mutated registries, and tuned Plex frontier/payload/projection internals for comparison workloads.

### Developer Experience
- **Backend comparison coverage**: Added service-level tests for concrete default routing, explicit Plex/Flex routing, cached run resumption, compatible stats accounting, and Flex abort behavior.
- **Flex validation probes**: Added Flex reduced-key invariant checks that accept representative vanilla shapes and reject an adversarial mutated-registry conflict graph, matching the Plex-style safety model before runtime fallback work.
- **Factorized-runtime docs**: Promoted Flex as the active factorized-tree design path, while keeping Plex documented as the historical prototype and comparison backend.
- **Profiling and parity tools**: Added/updated Plex parity harnesses and CPU profile phase-splitting utilities for backend comparison work.

## v7.3.0 (2026-05-19)

### Added
- **Experimental Plex search path**: Added an opt-in internal Plex search implementation that compresses mutually exclusive choice groups into aggregate payloads and materializes concrete compatibility views for comparison and diagnostics.
- **Plex checkpoint projection**: Added concrete result and pending projection for Plex checkpoints, including native book-removal projection, clue projection, phase-scoped projection accounting, split-residue diagnostics, and engine-native exit reasons.

### Developer Experience
- **Plex parity coverage**: Added targeted Plex tests for choice grouping, bounded advance, checkpoint projection, clue projection, split-residue harvesting, and concrete comparison fixtures. Focused exhaustive checks confirm matching concrete/projected result sets for sampled fully resolved item cases and `1.7.2` book XP 30.
- **Search documentation refresh**: Updated the V7 search and mass-accounting docs to describe Plex as an internal experimental path rather than only a future design sketch.

## v7.2.0 (2026-05-18)

### Improved
- **Generalized expansion blueprints**: Search graphs now reuse candidate-filter blueprints across rank-variant pools, reducing repeated eligible-entry scans while preserving exact graph edges and combo payloads.
- **Experimental suffix sharing**: Search runs now expose suffix identities and opt-in pending suffix merging for equivalent future states, with diagnostics showing when the optimization helps or hurts runtime.

### Developer Experience
- **Search overlap diagnostics**: Overlap reports now include actual blueprint hit/miss counts, candidate-check savings, suffix merge counts, and merged pending mass.
- **V7 architecture documentation**: Refreshed the architecture, mass-accounting, and V7 deep-dive docs to describe the current shared-search engine instead of the original rewrite plan.
- **Snapshot commit isolation**: Release validation now rejects commits that mix generated snapshot fixture updates with source, test, documentation, or package changes.

## v7.1.2 (2026-05-13)

### Security
- **CodeQL property-write hardening**: Reworked probability mass accumulation to avoid computed object-property writes flagged by CodeQL while preserving the existing public distribution shape.

### Developer Experience
- **Release snapshot workflow guidance**: Clarified that `main` is a tagged release snapshot branch and removed prescriptive release branch naming from the contribution guide.
- **Headerless release PR notes**: Release PR descriptions may now use the same heading-free release notes text that GitHub Releases publish, while still validating against `CHANGELOG.md`.
- **Shared PR advisory comments**: Release-policy and CI-change advisory jobs now use one reusable marker-comment helper with consistent stale, update, create, resolve, and permission-failure handling.

## v7.1.1 (2026-05-12)

### Developer Experience
- **Release gate migration cleanup**: Removed the temporary `pull_request` bridge from the release pre-merge workflow now that the stable `pull_request_target` gate is present on `main`.
- **Stable CI advisory activation**: `CI Change Advisory` now runs only from the base branch workflow on future PRs into `main`, keeps CI-sensitive review signals out of PR-authored workflow control, and maintains a single active floating PR comment that is marked stale or resolved as the PR changes.
- **Release note section validation**: Release metadata validation now enforces a standard changelog section vocabulary, checks that major, minor, and patch entries use sections appropriate to their SemVer bump, supports Developer Experience-only patch releases for CI/tooling updates, comments when the changelog implies the PR version should be promoted or lowered, and reports release format, changelog policy, and branch/archive readiness as separate jobs.

## v7.1.0 (2026-05-12)

### Improved
- **Registry rank intervals**: Enchantment metadata now compiles effective rank intervals up front, so registry consumers can reason about level availability without repeatedly reconstructing rank ranges.
- **Target and clue analysis consistency**: Service-level target and clue checks now use the compiled rank intervals, keeping derived availability aligned with registry construction.

### Fixed
- **Thorns III availability**: Restored the valid Thorns III rank range so matching rolls are included again in affected versions.
- **Registry baseline snapshots**: Updated engine baselines for book, spear, and mace cases after the rank interval correction.

### Developer Experience
- **Stable release gates**: Release PR policy now runs from the base branch workflow with `pull_request_target`, treating PR head release metadata as data so release rules cannot be bypassed by editing the PR workflow.
- **CI change advisory**: PRs that touch CI-sensitive files now get a non-required advisory check that distinguishes normal changes, CI logic edits, and high-risk workflow trigger/target changes.
- **Release archive fallback**: The release archive workflow can recover the source PR number for squash commits whose subject does not include the default `(#NN)` suffix.
- **Release PR guidance**: `CONTRIBUTING.md` now documents the expected release branch shape, PR description style, and final release metadata commit.

## v7.0.0 (2026-05-11)

### Added
- **More predictable limited searches**: V7 uses a shared XP-level search that spends work on the highest-probability remaining paths first, so time and iteration limits now track the whole calculation instead of being fragmented across separate XP rolls.
- **Better modern book coverage**: Latest-version book calculations now reach a high-confidence 99.95% classified result within the release gate, preserving the full classified combo distribution without requiring exhaustive tail expansion.
- **Simpler library stats API**: `getStats(...)` is now the standard entry point for callers that want summarized enchantment probabilities.

### Fixed
- **Search limit adherence**: Broad searches such as books now degrade much more gracefully under configured limits instead of letting each modified XP level consume an isolated budget before results are combined.
- **Exact probability accounting**: Active probability buckets now conserve exactly at fixed-point unit precision, closing the tiny unit-level mass leaks V6 could leave after aggregating separate XP-level searches.
- **Book combination mass splits**: Book-only random enchantment removal now carries indivisible split residue instead of assigning leftover units to one arbitrary redistributed combo.
- **Book target diagnostics**: Pending book branches now estimate target mass after random enchantment removal instead of treating matching pre-removal combos as fully retained.
- **Result output caps**: Large summary and snapshot exports now require an explicit `uncappedResults` opt-in, while normal UI/library calls keep bounded result materialization separate from search work.
- **Search input validation**: Direct checkpoint calls now reject unbounded or invalid stop conditions consistently, including non-finite probability targets and invalid iteration budgets.
- **Clue-conditioned accuracy**: Clue searches now use the same shared search/accounting path, so incompatible and pending probability mass are tracked consistently with normal searches.
- **Large-result regression coverage**: The release suite now includes a bounded modern-book golden fixture so limit behavior stays covered without making V7.0.0 depend on exhaustive latest-book completion.

### Developer Experience
- Snapshot generation supports mass-targeted cases, and engine snapshot tests reserve enough Node memory for large book fixtures.
- The engine test runner now resolves `tsx` from the local install, package resolution, or PATH instead of assuming a fixed `node_modules/.bin` path.
- Golden snapshots, mass conservation checks, worker protocol tests, UI regression tests, and release validation now exercise V7-native outputs.

### Breaking
- Removed the legacy `calculate(...)` engine entry point. Use `getStats(...)` for summarized probabilities or checkpoint APIs for raw search results.
- Removed obsolete V6 search scaffolding and V7-prefixed internal API names now that the shared search engine is the primary engine path.
- Removed the unused `resultsLimit` request option; use `summaryLimit` for summarized output size control.

## v6.1.0 (2026-05-09)

### Added
- **Chart click selection**: Clicking inside the probability chart now updates the selected enchanting level and reuses the existing selected-level refinement flow.

### Improved
- **Tiny probability display**: Very small top-combination odds now stay distinguishable instead of collapsing into the same low-percentage label.
- **Chart interaction affordance**: The chart now exposes a clearer hover/click cue for the new level-selection behavior.

### Fixed
- **Pending book result identities**: Pending book branches still contribute aggregate probability estimates, but raw pre-removal book combos no longer appear as visible target or clue-conditioned combo rows.

### Developer Experience
- **Release branch tags**: The release archive workflow can now transfer working tags from version branches to the history branch.

## v6.0.1 (2026-05-09)

### Fixed
- **Top combination sorting**: Restored the Most Enchantments and Highest Total Rank sort modes in the results list.
- **Version/item repair**: Switching to a version where the selected item is unavailable now repairs item, material, target, and chart state together.
- **Single-material items**: Items such as Trident now lock the material dropdown when only one material is valid.
- **Clue and target friction**: Conflicting shown clues and target selections are preserved and surface the existing no-match state instead of silently clearing user choices.

### Developer Experience
- **V6 test coverage cleanup**: Wired dormant engine suites into CI discovery, added a missed-test guard, reduced redundant behavioral assertions, and kept UI tests focused on UI behavior.
- **Release PR hygiene**: Release CI now checks that PR notes mirror the changelog entry and that release branches end with a version-bump commit covering package metadata, changelog notes, and any known release docs.

## v6.0.0 (2026-05-08)

### Changed
- **Registry-first engine API**: The library now uses `item` and `material` request fields consistently across engine calls, scripts, workers, and UI internals.
- **Cleaner vanilla registry model**: Enchanting data is organized around versioned item, material, enchantment group, and conflict rules, making historical version behavior easier to audit and maintain.

### Developer Experience
- **Resolved registry construction**: Normal callers build vanilla registries by version, while advanced callers can create vanilla-plus-mutation registries for targeted experiments.
- **Runtime registry state**: Engine instances now receive resolved registry state instead of carrying raw data packs through runtime objects.
- **Explicit item/material validation**: Direct engine calls reject known materials that are not valid for the selected item and version.

### Breaking
- Removed deprecated `cat` / `mat` request aliases and category-named registry helpers. Use `item` / `material` and item-named helpers instead.
- Removed full custom registry data-pack construction. Use `RegistryFactory.build(version)` for vanilla data or `RegistryFactory.buildWithMutations(version, mutations)` for vanilla-based variants.

## v5.4.3 (2026-05-07)

### Fixed
- **Sweeping Edge version boundary**: Added `1.11.1` as a selectable version so Sweeping Edge appears at its actual table-rollable introduction point.
- **Historical conflict cleanup**: Older registries no longer carry conflict links to enchantments that did not exist yet.

## v5.4.2 (2026-05-07)

### Fixed
- **Complete result accounting**: Engine defaults no longer cap terminal combinations before building result summaries.

## v5.4.1 (2026-05-06)

### Fixed
- **Modern Thorns table results**: Thorns III is no longer included in enchanting-table results, because its vanilla modified-level range starts above reachable table rolls.

### Developer Experience
- **Stable human snapshots**: Human snapshot output now uses stable tie ordering for equal-probability combinations.
- **Release workflow cleanup**: Release checks now gate PRs before merge, while release creation focuses on publishing, archiving, and cleaning up the release branch.

## v5.4.0 (2026-05-06)

### Added
- **Target clue advisor**: Target combo searches can now recommend the best enchanting level and shown clue to click, with a dedicated advisor view alongside the existing results.
- **Recommendation context**: Advisor results show how often a clue appears, how much it improves the target odds, and how it compares with compatible and random clicks.
- **Impossible target feedback**: Target combinations that cannot coexist are called out directly, so the advisor can explain why no recommendation is available.
- **High-roll guidance**: When no target combo is selected, the advisor highlights clues that tend to signal stronger modified-level rolls.

## v5.3.2 (2026-05-06)

### Fixed
- **Clue confidence display**: Fully resolved clue runs no longer look uncertain just because most of the search space cannot match the shown clue.

## v5.3.1 (2026-05-06)

### Fixed
- **Stable probability chart**: Moving the enchanting-level slider now refreshes only the selected-level results and no longer clears or redraws the XP sweep chart.

## v5.3.0 (2026-05-06)

### Added
- **Target combo filtering**: Select desired enchantments, such as `Efficiency IV+` and `Fortune III+`, to see the chance of getting them together.
- **Matching combinations view**: When targets are active, Top Combinations shows matching results and updates immediately when only the targets change.
- **Conflict-aware targets**: The target selector prevents impossible combinations such as `Sharpness` with `Smite`.

## v5.2.2 (2026-05-06)

### Fixed
- **Code scanning highlights**: Removed unsafe HTML placeholder rendering and hardened changelog extraction against malformed version input.

## v5.2.1 (2026-05-06)

### Fixed
- **Release history archiving**: Fixed the release archive workflow so patch releases can preserve their full branch history without violating the `release-history` branch rules.

### Developer Experience
- **Patch cleanup**: Removed stale correction labels and a small unused clue-conditioning argument.

## v5.2.0 (2026-05-05)

### Improved
- **Faster shown-enchantment searches**: Searches with a table clue now skip impossible branches earlier, which especially helps rare clues and complex book calculations.
- **Clearer clue confidence**: Clue runs now separate exact clue mismatches from low-probability pruning, so progress reflects how much of the search has truly been classified.

### Developer Experience
- **Clue-aware checkpoints**: Wired clue targets through checkpoint searches and covered them against full-search conditioning.
- **Stats schema cleanup**: Moved clue-known-space to `clue.knownSpace`, made shown-clue distributions conditional, and kept clue-incompatible mass as conserved accounting.
- **Maintenance cleanup**: Tightened snapshot parity, shared test helpers, and release-history workflow docs.

## v5.1.1 (2026-05-03)

### Fixed
- **Enchanting table registry data**: Corrected modern enchantment data so calculations only include enchantments and ranks that can actually be rolled by the enchanting table.
- **Modern spear and book results**: Updated Lunge and modern book behavior to match the current enchanting table data.
- **Impossible table entries**: Excluded treasure-only enchantments and documented why Quick Charge III is not included despite appearing as an empty `52-50` range in vanilla data.

## v5.1.0 (2026-05-03)

### Improved
- **Faster complex book searches**: Modern book calculations, especially no-clue `1.21.11` searches, now complete much faster while keeping the same results.
- **Quicker result reporting**: Large searches spend less time preparing summaries and snapshots after the search finishes.
- **Clearer performance timing**: Profiling output now separates search time from result-processing time, making long runs easier to understand.

### Developer Experience
- **Profiling baselines**: Added repeatable CPU profiles for the modern book cases used to guide this optimization pass.
- **Search frontier cleanup**: Reworked the V5 frontier and mass-forwarding internals around clearer ownership boundaries and lower-overhead node tracking.
- **Reporting consolidation**: Combined repeated summary and snapshot scans into one shared aggregation path.
- **Registry headroom**: Added an explicit fallback identity mode for larger supported enchantment registries.

### Fixed
- **Unsupported registry validation**: Added a clear error when a registry exceeds the current 64-enchantment internal model.

## v5.0.0 (2026-05-02)

### Added
- Introduced the V5 checkpoint-based search engine path and snapshot reporting model.
- Added release-oriented engine diagnostics, checkpoint scripts, and expanded invariant coverage.

### Changed
- Reworked engine terminology around search results and checkpoints.
- Consolidated worker, summary, and search-service request flows around V5 object-based calls.
- Replaced obsolete matrix-runner workflows with V5 checkpoint-driven reporting.

### Fixed
- Preserved last completed checkpoint results during aborted progressive searches.
- Cleaned import, worker bundling, and whitespace churn from the V5 branch history.

## v4.3.0 (2026-04-29)

### Added
- Integrated CodeQL static analysis for security and code quality.
- Automated PR-based release model with "Rebase-Sync" for history linearity.
- Standardized milestone-only history for the `main` branch.
- Automated standalone HTML analyzer builds.

### Changed
- Refactored engine structure into modular `#lib` architecture.
- Consolidated test suites into a unified TypeScript runner.
- Modernized CI/CD to target Node.js 22.x.

## v4.2.1 (2026-04-22)

### Changed
- **Internal naming cleanup**: Renamed internal engine and UI symbols to better match their real responsibilities, including `SearchManager` → `SearchStateTracker`, `MassAccountant` → `ProbabilityMassBookkeeper`, `DistributionPool` → `DistributionBufferPool`, `DistributionService` → `ModifiedLevelDistributionService`, and `StatAggregator` → `ProgressiveStatsAggregator`.
- **Registry consolidation**: Inlined the thin `RegistryMaterials` and `RegistryPools` helpers into `registry.ts`, and folded the tiny eligible-list helper into the registry layer to simplify ownership and reduce indirection.
- **UI/test naming alignment**: Renamed the chart files to `results-chart-controller.ts` and `results-chart-manager.ts`, aligned test filenames with the classes they cover, and cleaned up remaining clue-oriented naming leftovers.

### Developer Experience
- **Test workflow cleanup**: Restored the staged sequential test script flow and aligned script names with the updated test layout.
- **Blame hygiene**: Added the pure-rename and chart-rename commits to `.git-blame-ignore-revs` so future blame stays readable.
- **Code documentation**: Added high-value JSDoc and invariant comments around the registry, search pipeline, worker protocol, and clue-analysis path.

### Verified
- **Snapshot parity**: Regression snapshots remain identical to the rebuilt v4.2.0 baseline.
- **Release validation**: The full release pipeline passes, including build, lint, engine tests, snapshots, Playwright UI tests, and standalone bundle generation.
- **Scope discipline**: This release stays a cleanup-and-clarification pass. The later clue-semantics correction work is not folded into v4.2.1.

## v4.2.0 (2026-04-21)

### Improved
- **Heap Performance**: Reworked the frontier queue around an optimized 4-ary `SearchHeap` with lower-overhead metadata tracking and faster lookup behavior, substantially improving heavy searches while keeping result output stable.
- **Probability Accounting Efficiency**: Replaced `MassAccountant`'s internal record storage with a TypedArray-backed layout to reduce overhead without changing reported search totals.
- **Developer Tooling**: Aligned the benchmark, CPU profiling, profile-comparison, and lint script surface with the intended 4.2 developer workflow.

### Added
- **SearchHeap Regression Coverage**: Added a dedicated regression suite for heap behavior so the queue rewrite stays protected by targeted tests.
- **Performance Comparison Helper**: Added a profile-comparison script for comparing CPU captures from different optimization passes.

### Verified
- **Snapshot Parity**: Machine and human snapshot artifacts remain byte-for-byte identical to the fixed `v4.0.0` clue-conditioned baseline.

## v4.1.0 (2026-04-20)

### Improved
- **Reliable Timing**: Implemented a more accurate system for tracking calculation time that provides precise metrics without slowing down the engine during deep searches.
- **Engine Standardization**: Cleaned up internal "magic numbers" and centralized all engine rules and limits to ensure consistent behavior across all supported Minecraft versions.
- **Concurrent Search Safety**: Implemented better internal data handling to ensure that overlapping searches can execute without interfering with each other.

### Fixed
- **Accuracy Regressions**: Resolved several small bit-level discrepancies introduced during the recent modernization.
- **Stability**: Fixed potential runtime crashes related to numerical conversions in the search expansion path.


## v4.0.0 (2026-04-18)

### The "Modernization Update"
This major version represents a complete structural and logical overhaul, transitioning the analyzer to a more accurate prediction model that better reflects Minecraft's internal mechanics.

### Added
- **Intelligent Clue Filtering**: You can now filter results based on the enchantment clue shown in-game. This is significantly more accurate than before, as the engine now understands that the clue could be any of the enchantments selected by the table, not just the first one.
- **Architectural Renovation**: Completely re-built the internal systems with a modular design and a strict stability audit, making the entire application more robust and ready for future expansion.
- **Modern Repository Structure**: Reorganized the codebase into a tiered hierarchy for better performance and easier long-term maintenance.

### Improved
- **Calculated Accuracy**: By moving to a "fully random" generation model, the analyzer's predictions now more perfectly mirror the actual random-removal mechanics used in the game.
- **Infrastructure & Testing**: Expanded the automated testing framework to cover complex "clue-conditioned" scenarios, ensuring the results you see are always verified and reliable.

### Changed
- **Consolidated Generation**: Unified the way enchantments are analyzed, removing legacy assumptions in favor of a more flexible and realistic simulation.


## v3.2.0 (2026-04-12)

### Improved
- **Accuracy for Rare Results**: Implemented a "Mass Forwarding" system to prevent tiny probabilities from being accidentally discarded during deep calculations. This ensures that rare enchantment combinations and high-enchantment items are represented with near-perfect accuracy, even when they occupy a tiny fraction of the total results.
- **Reliable Deep Searches**: Optimized the engine to handle the accumulation of tiny values across complex searches (up to 6 concurrent enchantments), eliminating "rounding errors" that could previously occur at extreme search depths.
- **Honest Confidence Metrics**: Refined the way the app reports search progress, providing a more transparent view of exactly how much of the total probability space has been successfully analyzed.


## v3.1.0 (2026-04-11)

### Improved
- **Computation Speed**: Re-engineered the core search algorithms to be significantly faster, especially when dealing with complex items like multi-enchantment books.
- **Enhanced Accuracy**: Upgraded the internal math engine to use higher precision, ensuring calculated probabilities are even more reliable for rare enchantment combinations.
- **Book Logic**: Refined the rules for how multiple enchantments are distributed on books to better match the official mechanics of newer Minecraft versions.
- **Background Stability**: Added internal performance monitoring to ensure the app stays responsive even during the most demanding calculations.


## v3.0.1 (2026-04-07)

### Improved
- **User Interface**: Significantly improved responsiveness and eliminated flickering when switching between item categories or materials.
- **Book Enchanting**: Optimized the internal selection engine to ensure fluid performance, even when calculating hundreds of thousands of book combinations.
- **System Stability**: Resolved several background synchronization issues that could cause searches to stall or behave inconsistently under heavy load.
- **Reliability**: Enhanced the worker communication layer to handle interruptions and error boundaries more gracefully.

## v3.0.0 (2026-04-05)

### The "Precision Architecture" Update

A major internal overhaul focused on accuracy, performance, and long-term maintainability.

### Improved
- **Faster deep searches**: The engine now reuses work across refinement tiers, so complex items like books converge to precise results much faster.
- **Better book accuracy**: Fixed several edge cases in book enchantment probability tracking that could cause small inaccuracies at high precision.
- **Performance**: Significant speedups across the board — eliminated bottlenecks in probability redistribution and cache key handling.

### Fixed
- **Frost Walker** version availability corrected.
- **Quick Charge III** level range corrected.
- **Enchantment conflicts** are now validated automatically instead of relying on manually maintained lists.
- Fixed a rare issue where the search could double-count probability mass near queue capacity.

### Changed
- Complete internal restructuring of the engine, type system, and registry. The public-facing behavior is unchanged, but the codebase is now fully type-safe and modular.
- Expanded test suite from ~30 to 242 tests covering engine correctness, edge cases, and cross-version regression.

## v2.2.0 (2026-03-29)

### Added
- **Book Mechanics Test Suite**: A dedicated regression suite for Minecraft book enchantment rules across versions.

### Fixed
- **Multi-Enchant Book Rework**: Re-architected the book generation logic to handle true random removal. This matches the behavior of official Minecraft mechanics and significantly improves accuracy for high-level book results.

## v2.1.0 (2026-03-29)

### Fixed
- **UI chart freeze**: Resolved an issue from v2.0.0 where the chart would only update at the end of the highest precision calculation, making it painfully slow to see results for books.

## v2.0.2 (2026-03-25)

### Fixed
- **Guaranteed First Accuracy**: Fixed a bug where guaranteed enchantments would show less than 100% probability. (again)

## v2.0.1 (2026-03-25)

### Fixed
- **Improved Confidence Tracking**: Fixed a bug causing Calculation Confidence to be calculated incorrectly.
- **Chart Cleanup**: Removed the "Total Accounted" line that used to report the faulty data from the enchantment count view.


## v2.0.0 (2026-03-24)

### The "Divide & Conquer" Update
- **Complete Restructure**: The entire project has been internally reorganized to make future work easier.
- **Improved Book Accuracy**: Improved the engine to provide more precise results for books rolling multiple enchants.
- **Expanded Test Suite**: Added comprehensive unit and performance tests to ensure long-term stability.
- **Prettified README**: Finally fixed the README screenshot link to point at the correct location and took a better one.
- **Changed CHANGELOG**: All entries now use the `vX.X.X (YYYY-MM-DD)` format.

## v1.3.0 (2026-03-22)

### Improved Accuracy & Stability
- **Locked results**: Guaranteed enchantments now show a solid 100% on all charts, even during long calculations.
- **Performance boosts**: Added advanced memory management to keep the app fast during deep book searches.
- **Reliable builds**: Improved internal build scripts and testing for a smoother developer experience.
- **UI Stabilization**: Resolved an issue where results would flicker or disappear during long calculations.

## v1.2.0 (2026-03-22)

### Added
- **Greater Accuracy**: New probability tracking for partial search results.
- **Deeper Analysis**: Support for up to 6 concurrent enchantments on a single item.

## v1.1.2 (2026-03-21)

### Changed
- **Build Hygiene**: Added a `clean` script to safely remove the `dist` directory and updated the test workflow to ensure a clean state before building and testing.

## v1.1.1 (2026-03-21)

### Fixed
- **Visual Chart Glitch**: Resolved an issue where chart lines would momentarily dip to zero during high-accuracy progressive refinement.

## v1.1.0 (2026-03-21)

### Added
- **Modularized Utility Library**: Refactored the monolithic `utils.ts` into specialized modules (`math`, `domain`, `ui`, `collections`, `results`) for better maintainability.
- **Strict Typing for Registry**: Introduced formal interfaces (`ResolvedRegistry`, `MergedItems`, `MergedOverrides`) to eliminate `any` types from the core data model.
- **Centralized Configuration**: Moved hardcoded engine and UI constants into a dedicated `config.ts` system.
- **DRY Abstractions**: Consolidated repetitive DOM manipulation, string formatting, and fixed-point math into utility helpers.

### Changed
- Improved V8 engine friendliness by abstracting bitwise operations into static helper methods.
- Standardized probability scaling logic using `ProbUtils.scale`.
- Updated package exports to point to the new modular `dist/index.js`.

### Fixed
- ESM import resolution issues in bundled output.
- Missing fallback IDs for category and material lookups.

### Removed
- Unused `translateComboKey` function and other dead code identified during audit.

## v1.0.0 (2026-03-21)

### Added
- Initial release.
