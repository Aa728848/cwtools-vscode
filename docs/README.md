# Extension Roadmap Plans

This folder contains implementation plans for the next expansion stage of Eddy's Stellaris CWTools.

The recommended execution order is:

1. [GameProfile Platform](./01-game-profile-platform-plan.md)
2. [AI Workflow System](./02-ai-workflow-system-plan.md)
3. [Incremental Index and Knowledge Layer](./03-incremental-index-knowledge-layer-plan.md)
4. [Webview Modularization](./04-webview-modularization-plan.md)
5. [Test and Release Quality Gate](./05-test-and-release-quality-gate-plan.md)

## Planning Principle

The project already has strong feature depth. The next expansion should prioritize reusable platform boundaries, predictable AI workflows, shared indexed knowledge, maintainable webview modules, and release confidence.

## Suggested Milestones

### Milestone 1: Platform Base

- Add the `GameProfile` registry.
- Move read-only game-specific lookups behind the registry.
- Add profile resolution tests.

### Milestone 2: Guided AI

- Add AI workflow metadata.
- Thread `workflowId` through the runner.
- Launch the first workflow for diagnostic fixes.

### Milestone 3: Shared Knowledge

- Add the index service skeleton.
- Move localisation indexing behind the service.
- Add symbol and asset query APIs.

### Milestone 4: Maintainable Webviews

- Type webview message contracts.
- Extract chat panel helpers and views.
- Extract entity preview scene/material/locator modules.

### Milestone 5: Release Confidence

- Add `check:release`.
- Add CI for lint, compile, unit tests, and release checks.
- Add optional visual regression checks for webviews.
