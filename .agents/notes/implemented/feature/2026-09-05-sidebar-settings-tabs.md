# Agent Note: Sidebar settings categories with complete configuration controls

Status: implemented

## Problem

AI settings used one long sidebar form containing model configuration, account quotas,
completion parameters, permissions, web search, MCP, skills, profile models, and usage
statistics. Common controls were hard to find. Opening settings also replaced a saved
context limit with model metadata, and delayed model updates could overwrite a manual edit.

## Decision

Grouped the existing form into Models, Agent, Tools, and Usage tabs within the same
Webview. Tab changes retain the original form elements, draft values, and per-tab scroll
positions. All existing static control IDs, provider choices, dynamic profile/MCP
configuration, account actions, and settings payload fields remain available.

Kept the editable context limit in the primary model section, including provider-default
zero. Model metadata fills the context field when the model changes, while settings and
model-list refreshes retain an explicit value. Model input changes finish on blur so a
pending update cannot subsequently replace a manual context edit.

Added draft status and discard/save actions. Connection and account operations retain
their existing independent actions. Quotas, connection details, completion parameters,
and cache analysis use local disclosure controls. English and Chinese labels and native
VS Code theme colors are supported. Search key visibility uses event listeners compatible
with the Webview CSP, and discovery buttons have one request handler each.

## Alternatives considered

- A separate full settings window would make a wider layout possible, but the primary
  workflow needs complete configuration within the VS Code sidebar.
- Keeping the long form and changing only colors would leave the navigation problem.
- Rebuilding settings from a reduced form schema would risk losing provider-specific
  fields and dynamic controls; the existing form and serialization are retained.

## Consequences

The shared settings surface remains usable in the detached Agent Manager. Narrow layouts
wrap API actions, MCP transport controls, and profile selectors without reducing available
configuration. Template contract tests cover bilingual category placement, existing
controls and profiles, the editable context field, and CSP-compatible key actions.
Future settings must be placed in a category and included in the existing save payload.
