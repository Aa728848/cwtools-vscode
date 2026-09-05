# Agent Note: Antigravity OAuth provider

Status: implemented

## Problem

CWTools lacked the Antigravity provider available in the local dsh-chatgpt-subscription project. A provider entry alone would not handle Google OAuth, project discovery, the wrapped Gemini stream, or signed tool-call continuation.

## Decision

Added Antigravity to the existing HTTP provider registry and bilingual settings flow. The host owns PKCE login on a loopback callback, SecretStorage credentials, serialized refresh and logout, project/model discovery, and quota status. OAuth calls use fixed Google origins with redirects disabled. Generation reuses the Gemini message mapper, applies the reference model routes, and parses wrapped SSE with cancellation, an idle timeout, and bounded response size. Signed parts survive transcript cloning and tool-result turns; token estimates include that state. Failover changes endpoints without silently changing the selected model.

## Alternatives considered

- An OpenAI-compatible custom endpoint was insufficient because Antigravity uses Google OAuth and a distinct request envelope.
- Reusing DSH's file credential store would duplicate credential management and put tokens outside VS Code SecretStorage.
- Copying the full DSH adapter would duplicate existing Gemini conversion and introduce unrelated host/client dependencies.
- Automatically falling back to another model was avoided because it changes the user's selected model and its behavior.

## Consequences

Users can sign in with Google and use Antigravity for streaming text, image input, and agent tool calls, with account models and quota shown in settings. FIM and utility calls remain disabled for this subscription channel. Accounts must have completed Antigravity setup. Upstream compatibility endpoints and public installed-app OAuth details can require future updates. Regression coverage includes PKCE/state, concurrent refresh, logout races, malformed data, endpoint failover, stream errors/cancellation, signed multi-tool replay, protocol validation, and bilingual account rendering. Live-account generation requires the user's Google login and is not exercised by automated tests.

Verification: TypeScript compilation and strict test typechecking, 79 targeted tests, the full unit/rules-sync suite, bilingual docs generation, targeted lint, and the release gate with separate compile/test runs. Rollup reports unresolved dependency warnings while completing the Webview bundles. The release URL scan has a file-specific exception for the state-checked Antigravity loopback callback, consistent with the existing OAuth integration.
