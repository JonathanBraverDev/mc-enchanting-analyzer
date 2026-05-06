# Changelog

All notable changes to this project will be documented in this file.

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
