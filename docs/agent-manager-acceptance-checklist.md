# Agent Manager Acceptance Checklist

## Visual and Layout

- [ ] Desktop (>= 1440px): left rail, center conversation, right inspector all visible.
- [ ] Medium (980px-1439px): left rail + center stable, right inspector usable and non-overlapping.
- [ ] Narrow (< 980px): topics panel overlay works, input remains operable.
- [ ] No overlapping text in topic rows, message bubbles, inspector cards.
- [ ] Empty-state rendering is stable with no broken controls.
- [ ] Opening/closing `Artifacts` updates the center-pane floating cards and slash popup width without leaving a stale right-side gap.
- [ ] Resizing the manager keeps the composer `+` menu and quick-model menu aligned with their trigger buttons.
- [ ] Settings stay centered and bounded instead of stretching edge to edge on wide screens.

## Core Workflow

- [ ] Open `cwtools.ai.openAgentManager` and confirm manager panel initializes.
- [ ] Create new topic from manager and see immediate update in sidebar.
- [ ] Switch topic in sidebar and confirm manager conversation updates.
- [ ] Switch topic in manager and confirm sidebar conversation updates.
- [ ] Send message from manager and receive assistant response.
- [ ] Open Settings from manager and confirm provider/model/MCP controls are usable.
- [ ] Use the composer `+` menu and quick model selector from manager.
- [ ] Trigger permission, write confirmation, and plan annotation flows from manager and complete them without returning to the sidebar.
- [ ] After confirming a plan / walkthrough / blueprint card, hide and re-show the manager panel; the dismissed annotation card does not reopen.
- [ ] Open Settings from manager and confirm the sidebar does not also switch into settings.
- [ ] Save Brave and Exa search tokens from manager, reopen settings, and confirm both fields restore as masked values.

## Topic Metadata

- [ ] Toggle pin in manager and verify ordering updates in manager and sidebar.
- [ ] Set workspace group in manager and verify grouping appears.
- [ ] Clear workspace group and verify fallback group behavior.
- [ ] Archive/unarchive topic and verify list filtering behavior.

## Inspector

- [ ] `Agents` tab displays orchestrator phase and lane cards when progress events exist.
- [ ] `Artifacts` tab reflects host artifact list in descending creation time.
- [ ] `Tasks` tab reflects todo updates and status transitions.
- [ ] `Tasks` tab shows symbolic status marks (`✓`, `…`, `○`) rather than plain status text.
- [ ] Inspector tabs switch without losing current state.
- [ ] Header `Artifacts` button can collapse and reopen the inspector on desktop.
- [ ] Workspace button is available in the manager header and can reopen the active plan/diff workspace.

## Runtime and Recovery

- [ ] Close and reopen manager panel: snapshot reload restores topic/message/artifact state.
- [ ] Hide and re-show manager panel: snapshot refresh works and no duplicate UI blocks appear.
- [ ] Reopening the panel during generation keeps only one background-running banner in the conversation.
- [ ] During generation, status transitions to running; after completion/error returns to idle.

## Regression

- [x] `npm run compile` passes.
- [x] `client/test/unit/webviewSmoke.test.ts` passes.
- [x] `client/test/unit/agentSessionCoordinator.test.ts` passes.
- [x] `client/test/unit/agentUiBroadcaster.test.ts` passes.
- [x] `client/test/unit/artifactStore.test.ts` passes.
- [x] `client/test/unit/agentManagerContracts.test.ts` passes.
- [x] `npm run test:unit` passes.
