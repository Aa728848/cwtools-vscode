# Agent Manager Implementation Progress

Last updated: 2026-05-18

## Completed

- [x] Register `cwtools.ai.openAgentManager` command and open detached manager panel.
- [x] Add manager-specific HTML wrapper and CSS shell.
- [x] Support multi-surface messaging (sidebar + manager).
- [x] Extract session runtime holder (`AgentSessionCoordinator`) for mode/workflow/live-run state.
- [x] Extract UI fan-out layer (`AgentUiBroadcaster`) for all active webviews.
- [x] Extract artifact state layer (`ArtifactStore`) and route artifact operations through it.
- [x] Add dedicated manager bundle entry (`agentManager.js`) and wire manager HTML to it.
- [x] Add manager snapshot protocol:
  - Webview -> Host: `requestManagerSnapshot`
  - Host -> Webview: `managerSnapshot`
- [x] Add manager runtime overlay:
  - requests snapshot on load/visibility restore
  - renders rail-level overview pills (topics, artifacts, steps, messages)
  - reflects mode/workflow/status from live host updates
- [x] Extend smoke/unit tests for new wiring and core abstractions.

## Remaining To Reach Plan Completion

- [x] Split manager runtime from shared chat runtime (remove implicit chat IIFE dependency).
- [x] Build manager-specific message contract layer (`shared/chat/manager` message modules).
- [x] Add manager-focused center pane renderer (conversation-focused, less chat-page coupling).
- [x] Add right inspector tabs for `Agents / Artifacts / Tasks` with explicit state model.
- [x] Add pinned conversations and workspace grouping metadata to topic model + persistence.
- [x] Add orchestrator lane inspector (sub-agent live lanes and recent-step drilldown).
- [x] Add conflict and cross-surface interaction tests (simultaneous actions from sidebar and manager).
- [x] Add end-to-end visual/manual verification checklist for wide/medium/narrow manager layouts.

## Suggested Next Execution Order

1. Runtime split (`chatPanel` boot API + manager boot API).
2. Manager inspector tabs (`Agents / Artifacts / Tasks`) with live data.
3. Topic metadata upgrade (`pinned`, `workspace`) and UI support.
4. Orchestrator lane details and summary widgets.
5. Final regression + release verification.
