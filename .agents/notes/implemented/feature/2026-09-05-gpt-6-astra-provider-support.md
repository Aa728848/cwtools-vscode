# Agent Note: GPT-6 Astra provider support

Status: implemented

## Problem

The OpenAI API and ChatGPT Codex subscription catalogs did not offer `gpt-6-astra`. Existing model matching missed its vision and output limits, and Responses reasoning translation downgraded native `max` to `xhigh`.

## Decision

Added Astra to both catalogs while preserving the existing default models. Registered image input, the 1,050,000-token API context, 128,000-token output limit, and `low` through `max` reasoning controls. Explicitly reduced-thinking calls use `low`; sampling temperature is omitted. Existing Responses routing and OAuth endpoint isolation remain in use.

Added the standard API token prices ($10 input / $50 output per million tokens) using the table's existing 6.82 CNY conversion and the 10% cached-input ratio. Sources: [official model specifications](https://developers.openai.com/api/docs/models/gpt-6-astra) and [model integration guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra).

## Alternatives considered

- Adding only a picker entry would retain incorrect reasoning, sampling, output, and cache-cost behavior.
- Replacing the current defaults would change existing users' model selection and cost without being requested.
- Applying the API context to subscription calls would bypass the existing 272,000-token Codex service limit. Astra inherits that provider limit until subscription-specific metadata is available.

## Consequences

Both provider pickers and OAuth account status expose Astra. Regression coverage checks catalog availability, provider-specific context limits, reasoning controls, request routing and temperature omission, and price lookup. Model access remains subject to the upstream account's availability. Cost estimates retain the existing standard-rate table; long-context and service-tier multipliers are not modeled.

Validation passed: `npm run compile`, `npm run typecheck:test`, 62 focused tests through the full unit-test harness, and `npm run test:unit` (2,287 unit tests plus 35 rules-sync tests). Standalone provider tests require the suite's VS Code stub initialization, so the focused run used the full file glob with a suite filter.
