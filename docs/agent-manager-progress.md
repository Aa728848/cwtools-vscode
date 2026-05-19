# Agent Manager Implementation Progress

Last updated: 2026-05-19

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
  - receives restored shared runtime state plus manager snapshots on load/visibility restore
  - renders rail-level overview pills (topics, artifacts, steps, messages)
  - reflects mode/workflow/status from live host updates
- [x] Reconnect the manager shell to the shared chat runtime so settings, composer controls, rich message rendering, approvals, and plan cards inherit the same behavior as the sidebar.
- [x] Keep manager-only enhancements as an additive layer:
  - workspace-grouped topic rail
  - `Agents / Artifacts / Tasks` inspector tabs
  - rail-level overview pills
- [x] Close the remaining manager parity gaps:
  - desktop artifact drawer now opens and closes from the manager header
  - settings requests stay scoped to the originating surface
  - workspace toggle remains available in the detached window
  - composer `+` and quick-model menus are positioned inside the manager composer
  - Exa search token is restored and saved with the rest of the settings payload
- [x] Close detached-window interaction regressions found during manual verification:
  - floating cards and slash popup now follow the active inspector width instead of a fixed right offset
  - composer menus anchor to the real trigger positions and reflow on resize
  - approved plan / walkthrough / blueprint cards stay dismissed after history restore
  - replaying hidden-session steps rebuilds the live process view without showing a background-running banner
  - manager settings keep a readable bounded width
  - task rows use compact status symbols (`✓`, `…`, `○`) rather than raw status labels
- [x] Polish manager entry and rail behavior:
  - add a header button in the sidebar chat for opening the detached Agent Manager
  - hide manager-only overview counters from the detached left rail
  - let the manager topics rail collapse and expand from the header topics button
  - target restore/replay messages to the surface that became visible so closing the sidebar does not add a manager background banner
  - shift the manager conversation and composer left when the side workspace is open
- [x] Extend smoke/unit tests for new wiring and core abstractions.

## Remaining To Reach Plan Completion

- [x] Share the chat runtime between sidebar and manager while keeping manager-only presentation enhancements isolated.
- [x] Build manager-specific message contract layer (`shared/chat/manager` message modules).
- [x] Add manager-focused center pane renderer (conversation-focused, less chat-page coupling).
- [x] Add right inspector tabs for `Agents / Artifacts / Tasks` with explicit state model.
- [x] Add pinned conversations and workspace grouping metadata to topic model + persistence.
- [x] Add orchestrator lane inspector (sub-agent live lanes and recent-step drilldown).
- [x] Add conflict and cross-surface interaction tests (simultaneous actions from sidebar and manager).
- [x] Add end-to-end visual/manual verification checklist for wide/medium/narrow manager layouts.

## Final Verification Focus

1. Manually verify wide, medium, and narrow layouts from the acceptance checklist.
2. Exercise shared-runtime parity in the manager shell:
   - settings
   - quick model selection
   - permission cards
   - write confirmation cards
   - plan / walkthrough annotation flows
3. Re-run release verification before packaging.
