# Plex Factorized Tree Notes

## Common Description

This document is a historical pointer for the removed Plex prototype. Plex proved that same-future alternatives can be compressed into weighted factorized payloads and projected back into concrete-compatible result rows, but it is no longer implemented or routed as an experimental/internal comparison backend.

Use [`docs/flex-factorized-tree.md`](flex-factorized-tree.md) for current factorized-tree design, migration policy, and guardrails.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Current Role](#current-role)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

This page exists to preserve old links and clarify terminology. It should not accumulate new design direction. New factorized-tree documentation belongs in [`docs/flex-factorized-tree.md`](flex-factorized-tree.md).

## Current Role

Plex is no longer available as an opt-in backend. Stale `searchBackend: 'plex'` requests now fail through the same unsupported-backend path as any other unknown selector. Concrete `SearchRun` remains the correctness reference; archived Plex output is historical diagnostic telemetry, not an oracle.

Flex replaces Plex as the active design target because it keeps the successful projection boundary while moving factor construction into graph/program building and keeping runtime closer to V7-style mass flow.

## References / Related Docs

- `docs/flex-factorized-tree.md` — current Flex/factorized-tree design.
- `docs/v7-shared-search-engine.md` — current V7 engine reference.
- `src/lib/search/flex/` — current Flex implementation.

## Owner / Maintainer

Jonathan Braver / V7 engine maintainers.

## Last Updated

2026-05-23
