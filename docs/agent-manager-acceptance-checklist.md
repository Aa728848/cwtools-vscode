# Agent Manager Acceptance Checklist

## Visual and Layout

- [ ] Desktop (>= 1440px): left rail, center conversation, right inspector all visible.
- [ ] Medium (980px-1439px): left rail + center stable, right inspector usable and non-overlapping.
- [ ] Narrow (< 980px): topics panel overlay works, input remains operable.
- [ ] No overlapping text in topic rows, message bubbles, inspector cards.
- [ ] Empty-state rendering is stable with no broken controls.

## Core Workflow

- [ ] Open `cwtools.ai.openAgentManager` and confirm manager panel initializes.
- [ ] Create new topic from manager and see immediate update in sidebar.
- [ ] Switch topic in sidebar and confirm manager conversation updates.
- [ ] Switch topic in manager and confirm sidebar conversation updates.
- [ ] Send message from manager and receive assistant response.

## Topic Metadata

- [ ] Toggle pin in manager and verify ordering updates in manager and sidebar.
- [ ] Set workspace group in manager and verify grouping appears.
- [ ] Clear workspace group and verify fallback group behavior.
- [ ] Archive/unarchive topic and verify list filtering behavior.

## Inspector

- [ ] `Agents` tab displays orchestrator phase and lane cards when progress events exist.
- [ ] `Artifacts` tab reflects host artifact list in descending creation time.
- [ ] `Tasks` tab reflects todo updates and status transitions.
- [ ] Inspector tabs switch without losing current state.

## Runtime and Recovery

- [ ] Close and reopen manager panel: snapshot reload restores topic/message/artifact state.
- [ ] Hide and re-show manager panel: snapshot refresh works and no duplicate UI blocks appear.
- [ ] During generation, status transitions to running; after completion/error returns to idle.

## Regression

- [ ] `npm run compile` passes.
- [ ] `client/test/unit/webviewSmoke.test.ts` passes.
- [ ] `client/test/unit/agentSessionCoordinator.test.ts` passes.
- [ ] `client/test/unit/agentUiBroadcaster.test.ts` passes.
- [ ] `client/test/unit/artifactStore.test.ts` passes.
- [ ] `client/test/unit/agentManagerContracts.test.ts` passes.
