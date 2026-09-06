# Agent Note: Antigravity native Tab completion and manual next-edit jump

Status: implemented

## Problem

The OAuth model directory exposed two editor models, but ordinary prefix/suffix chat requests returned escaped text, echoed suffixes or incorrect predictions. The project already had a FIM insertion path; treating native edit output as plain insertion text would corrupt suggestions.

## Decision

An authorized synthetic-code probe captured the official IDE's `tab` and `tab_jump` requests. Native replies continue a prefilled XML-wrapped JSON edit call. The direct adapter uses that format with a concise instruction, decodes one uniquely matching replacement, and never executes model-emitted calls. No official language-server binary is required at runtime.

Antigravity exposes a separate inline model catalog. Its FIM adapter accepts only edits that preserve the prefix and suffix, keeping the resulting whitespace intact. The manual next-edit command predicts within a bounded current-file window and only moves the cursor. Cancellation, document versions, cursor changes, disposal and provider/model cache identity prevent stale results. The optional previous-edit snapshot is bounded and held in memory.

Five live adapter checks passed: addition, indentation, Stellaris resources, suffix preservation and locating an outdated variable after a rename. Targeted tests cover native framing, JSON escapes, CRLF, Unicode, ambiguous targets, credential refresh, cancellation, FIM isolation and stale editor state. README, the protocol document, command translations and the release manifest describe the delivered behavior in both languages.

Validation passed: extension/Webview compilation, strict test type checking, 2,349 client unit tests and 35 rules-sync tests, bilingual documentation generation and the release quality gate. The release gate skipped its duplicate compile/test steps because those had already passed separately.

## Alternatives considered

- Generic chat/FIM prompts were rejected after inconsistent live outputs.
- Bundling or depending on the official language server would add installation and lifecycle complexity; it was used only for protocol validation.
- Automatically applying arbitrary edits or binding Tab to cursor jumps would broaden the editing behavior. Existing ghost text handles insertion; an explicit command handles jumps.

## Consequences

Both editor models can be used through the existing OAuth/proxy without exposing them as chat models. Responses outside the validated contract are discarded. The adapter supports one nearby edit in the current file, with no general file-edit execution or cross-file jump. Upstream compatibility-protocol changes may require updating the adapter.
