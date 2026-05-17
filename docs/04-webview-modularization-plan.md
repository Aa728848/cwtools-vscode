# Webview Modularization Implementation Plan

## Goal

Split large webview entry files into focused modules so UI features can continue growing without making each change risky. The first targets are the AI chat panel and entity preview because they carry the most state, rendering, and interaction complexity.

## Current Signals

- `client/webview/chatPanel.ts` is roughly 4,700 lines.
- `client/webview/entityPreview.ts` is roughly 3,200 lines.
- Shared webview utilities already exist, such as `messageRenderer.ts`, `svgIcons.ts`, and `canvas.ts`.
- Rollup already builds multiple webview entry points.

## Principles

- Keep entry point filenames stable.
- Move behavior in small slices and keep public message contracts unchanged.
- Prefer modules with narrow responsibilities over a large framework rewrite.
- Add tests around pure parsing/rendering helpers before moving fragile code.

## Target Structure

```text
client/webview/chat/
  state.ts
  vscodeApi.ts
  messageList.ts
  liveSteps.ts
  settingsView.ts
  artifactsView.ts
  diffView.ts
  topicsView.ts
  workflowView.ts

client/webview/entity/
  scene.ts
  camera.ts
  materials.ts
  textures.ts
  locators.ts
  attachments.ts
  animation.ts
  ui.ts
```

The current entry files should become thin bootstrap files.

## Phase 1: Stabilize Message Contracts

1. Extract webview message types into shared modules.
2. Document host-to-webview and webview-to-host messages.
3. Add compile-time types for frequently used message payloads.
4. Avoid changing runtime behavior in this phase.

## Phase 2: Chat Panel Pure Helpers

1. Move escaping, formatting, run summary, and grouping helpers out of `chatPanel.ts`.
2. Add unit tests for the extracted helpers where practical.
3. Keep DOM mutation code in place until helper extraction is stable.

## Phase 3: Chat Panel Views

1. Extract settings view rendering and event binding.
2. Extract topic list rendering.
3. Extract live agent step rendering.
4. Extract artifact and diff rendering.
5. Keep a single state owner until the views are separated.

## Phase 4: Entity Preview Rendering Core

1. Extract Three.js scene setup and disposal.
2. Extract material and texture resolution.
3. Extract locator and attachment handling.
4. Extract animation playback.
5. Add disposal checks for geometry, materials, textures, workers, and event listeners.

## Phase 5: Visual Regression

1. Add screenshot checks for:
   - chat panel initial state
   - settings page
   - streamed agent response
   - entity preview loaded state
   - missing asset state
2. Run the checks after each extraction phase.

## Acceptance Criteria

- `chatPanel.ts` and `entityPreview.ts` become bootstrap files rather than feature containers.
- Webview message contracts are typed and documented.
- Extracted helpers have tests where they are pure enough to test cheaply.
- No user-visible behavior changes during modularization.
- Entity preview disposal is explicit and testable.

## Risks

- DOM event ordering can change during extraction.
- Webview code has browser-only constraints, so shared modules must not import Node or VS Code APIs.
- Refactors without visual checks may accidentally break layout or interaction.

## Suggested First PR

Extract chat panel message types and pure formatting helpers, then add tests for those helpers. This gives the rest of the split a safer base.
