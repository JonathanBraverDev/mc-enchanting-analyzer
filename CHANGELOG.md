# Changelog

All notable changes to this project will be documented in this file.

## [v5.0.0] - 2026-05-02

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

## [v4.3.0] - 2026-04-29

### Added
- Integrated CodeQL static analysis for security and code quality.
- Automated PR-based release model with "Rebase-Sync" for history linearity.
- Standardized milestone-only history for the `main` branch.
- Automated standalone HTML analyzer builds.

### Changed
- Refactored engine structure into modular `#lib` architecture.
- Consolidated test suites into a unified TypeScript runner.
- Modernized CI/CD to target Node.js 22.x.

## [v4.2.1] - 2026-04-29
- Fixed CI environment compatibility for Node.js 22.
- Re-initialized repository as a modernized foundation.
