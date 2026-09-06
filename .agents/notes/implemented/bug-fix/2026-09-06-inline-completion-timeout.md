# Agent Note: Allow native inline completions to finish

Status: implemented

## Problem

An installed extension with AI and Antigravity inline completion enabled produced no ghost text. Its output log showed repeated `FIM timed out after 1500ms` entries. The transport was being invoked, but the old default cancelled normal replies, including a synthetic native completion that took 1756ms.

## Decision

The inline request timeout default is 6000ms across the manifest, AI service and settings Webview. Explicit shorter limits remain supported, and editing still cancels stale suggestions. The reported VS Code installation's saved 1500ms value was updated to 6000ms without changing other settings. Bilingual descriptions and the protocol guide explain that this is a maximum wait and that existing saved values take precedence over new defaults.

Regression coverage runs the public inline provider with a simulated two-second response: the old default failed to display it and the new default succeeds. A companion case verifies that an explicit 500ms timeout still cancels the same response.

Validation passed: `npm run compile`, `npm run typecheck:test`, the targeted editor tests, all 2351 client and 35 rules-sync tests, `npm run build:docs`, and the release gate with duplicate compilation/tests skipped. The live synthetic probe reproduced a 1501ms timeout with the old setting and produced a valid CRLF insertion in 1756ms with the longer limit.

## Alternatives considered

- Changing trigger keys would not address the observed timeout logs.
- Changing only the manifest would leave the user's saved 1500ms override active and keep the service/Webview fallback defaults inconsistent.
- Disabling timeouts or silently ignoring explicit short settings would remove caller control. Requests remain bounded and cancellable.

## Consequences

Normal native responses can become ghost text instead of being cancelled too early. Fast replies are still returned immediately. Upgrades preserve deliberately configured timeouts; users with an old saved default can adjust it in AI settings.
