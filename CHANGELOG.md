# Changelog

## v1.3.0 (2026-03-22)

### Improved Accuracy & Stability
- **Locked results**: Guaranteed enchantments now show a solid 100% on all charts, even during long calculations.
- **Performance boosts**: Added advanced memory management to keep the app fast during deep book searches.
- **Reliable builds**: Improved internal build scripts and testing for a smoother developer experience.
- **UI Stabilization**: Resolved an issue where results would flicker or disappear during long calculations.

## [1.2.0] - 2026-03-22

### Added
- **Greater Accuracy**: New probability tracking for partial search results.
- **Deeper Analysis**: Support for up to 6 concurrent enchantments on a single item.

## [1.1.2] - 2026-03-21

### Changed
- **Build Hygiene**: Added a `clean` script to safely remove the `dist` directory and updated the test workflow to ensure a clean state before building and testing.

## [1.1.1] - 2026-03-21

### Fixed
- **Visual Chart Glitch**: Resolved an issue where chart lines would momentarily dip to zero during high-accuracy progressive refinement.

## [1.1.0] - 2026-03-21

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
