# Changelog

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
