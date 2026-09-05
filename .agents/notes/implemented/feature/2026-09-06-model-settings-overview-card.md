# Agent Note: Model settings overview card

Status: implemented

## Problem

The configuration overview was hidden in a disclosure below the model forms.
Opening settings expanded the chat form before showing the current configuration.

## Decision

Moved the existing overview to a persistent card at the top of the Models tab.
The card uses VS Code theme colors and the existing live summary renderer. Chat,
completion, and translation details start collapsed and remain keyboard accessible.
All settings controls and their IDs stay in their original categories.

Removed obsolete manager-specific overview widths so the card fills the same
content column in sidebar and detached settings. Updated the existing layout
regression checks to cover the overview location and collapsed chat default.

## Alternatives considered

- Keeping the overview folded would continue hiding the information needed first.
- Wrapping all settings in another disclosure would add an unnecessary navigation
  level to the existing category accordions.

## Consequences

No settings values, save payloads, or host behavior changed. Compile, strict type
checking, and 55 targeted tests pass. Headless Edge verification covers 24
locale/theme/width combinations, keyboard expansion, live context summary updates,
collapsed-state draft retention, context saves including zero, and access to
completion and translation settings on both surfaces.
