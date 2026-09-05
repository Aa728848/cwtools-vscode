# Agent Note: Antigravity tool JSON Schema transport

Status: implemented

## Problem
Antigravity rejected requests containing the real CWTools tool catalog with HTTP 400: `Unknown name "propertyNames"` inside function declaration parameters. The adapter sent full JSON Schema through Google's typed `parameters` field. The previous metadata-only filter did not make that schema compatible and could delete legitimate property names or literal data such as `$id`.

## Decision
Antigravity function declarations now use `parametersJsonSchema`, following the Google Gemini CLI tool and Code Assist request path. The Antigravity envelope retains the complete schema, including property-name constraints, unions, references, metadata, and literal default values. Removed the recursive metadata filter. Other provider wire formats and canonical tool definitions are unchanged.

Reference: [Google Gemini CLI tool schemas](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/tools.ts) and [Code Assist request conversion](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/converter.ts).

## Alternatives considered
- Stripping `propertyNames` alone would discard constraints and leave other JSON Schema keywords exposed to the typed Schema parser.
- Maintaining a lossy JSON Schema-to-typed-Schema converter would require ongoing keyword translation and reference handling despite the upstream JSON Schema field.
- Changing shared tool definitions would weaken contracts for local validation and other providers, and unnecessarily affect the separately maintained MCP schema.

## Consequences
The provider emits one JSON Schema field per tool and preserves the original schema without mutating the tool catalog. Regression tests exercise the final HTTP request through AIService for Gemini and Claude on Antigravity, covering every built-in tool, the disclosed blueprint schema, and an external schema containing nested references, unions, propertyNames, and keyword-like property/default data. The tests reproduce the reported 400 before the fix. Live-account generation remains outside the automated tests.
