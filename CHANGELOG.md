# Changelog

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
