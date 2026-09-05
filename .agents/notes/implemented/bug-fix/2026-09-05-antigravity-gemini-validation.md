# Agent Note: Antigravity Gemini request validation

Status: implemented

## Problem
Gemini 3.8 Flash failed with HTTP 400 during routing and tool continuation. Antigravity sent the unsupported MINIMAL thinking level for disabled/minimal thinking on tiered Gemini 3.7/3.8 runtimes. Replayed Gemini function calls retained upstream IDs, but their function responses omitted those IDs. HTTP failures also discarded the upstream validation message.

## Decision
Mapped disabled/minimal thinking to LOW on tiered runtimes while keeping includeThoughts false for disabled thinking. Echoed native function-call IDs in matching Antigravity tool results without sending locally generated IDs for older ID-less Gemini responses. Retained signed replay parts and existing Claude behavior. Added bounded, cancellable error-body reading with a five-second diagnostic deadline, a 16 KiB read limit, a 1,500-character message limit, and access-token redaction. Failed diagnostic reads preserve the HTTP status and attach their cause.

The model constraints were checked against Google's Gemini 3.8 guide: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash.

## Alternatives considered
- Retrying all 400 responses would resend invalid payloads and obscure deterministic validation failures.
- Removing function-call IDs or thought signatures would lose native replay information required by tool continuation.
- Sending all locally generated IDs would change ID-less Gemini history without a matching upstream call ID.
- Showing entire error bodies would permit unbounded or credential-bearing diagnostics.

## Consequences
Routing and tool-result requests follow the model's supported thinking levels and ID matching rules. Errors include upstream validation details when available, while endpoint failover and one-time OAuth refresh retain their status-based behavior. Regression coverage includes tiered aliases, parallel calls with and without native IDs, signed replay, diagnostic bounds, token redaction, cancellation, and other provider paths. Live Google-account generation was not exercised by automated tests.
