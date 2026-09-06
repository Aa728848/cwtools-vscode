# Agent Note: Normalize Antigravity Pro aliases and hide editor models

Status: implemented

## Problem

Antigravity model discovery exposed runtime Pro aliases and editor-only Tab IDs in the chat picker. Filtering a backend Pro ID outright could remove the account's only Pro entry. Tab model names alone did not establish compatibility with the existing FIM completion interface.

## Decision

Discovery normalizes Gemini 3.1 Pro runtime aliases before deduplication and filters `chat_` / `tab_` entries. AI configuration exposes the same canonical Pro name for saved selections. Runtime reasoning mapping is unchanged. A valid account catalog with no chat models remains empty instead of falling back to an advertised default catalog.

Native Tab protocol investigation and editor integration are recorded separately in `../feature/2026-09-06-antigravity-tab-editing.md` and `docs/antigravity-tab-protocol.md`.

Regression tests cover alias-only discovery, deduplication, internal and Tab filtering, an editor-only account catalog, and provider-scoped normalization of selected models.

Validation passed: `npm run compile`, `npm run typecheck:test`, targeted tests, `npm run test:unit` (2,349 client tests and 35 rules-sync tests), `npm run build:docs`, and `npm run check:release -- --skip-compile --skip-test`.

## Alternatives considered

- Dropping `gemini-pro-agent` without mapping it loses Pro when the backend returns only the runtime ID.
- Enabling FIM from a successful HTTP response advertises an unsupported contract; live examples returned suffix echoes, escaped code, or incorrect predictions.
- Generic chat prompts were rejected after they failed framing and semantic checks; editor integration uses the subsequently verified native protocol.

## Consequences

The chat list exposes one Pro selection and hides editor models while preserving reasoning-based routing. Tab selection is handled separately from the chat catalog. No extra runtime dependency was introduced.
