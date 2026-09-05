# Agent Note: Restore centered composers and stable model selection

Status: implemented

## Problem

The empty sidebar composer was moved to the bottom and gained an unwanted welcome
section. The detached manager disabled the composer transition entirely. Model
names stretched their toolbar slot, changing spacing between controls.

## Decision

Removed the welcome heading, workspace label, suggestions, and their listeners.
Both surfaces center the empty composer and animate it to the bottom when the
conversation gains content; clearing a topic returns it to the center. The manager
keeps its existing grid column and bottom row, translating only the composer.
Reduced-motion preferences disable the movement.

The model selector uses a 200 px slot that can shrink in narrow layouts. Its label
aligns to the dropdown arrow and truncates long names; adjacent controls keep fixed
gaps. Context, permissions, domains, reasoning, and sending retain their controls.

Composer state changes and completed transitions refresh floating popup offsets.
Model, permission, slash, and mention menus stay scrollable within the available
space above the centered composer.

## Alternatives considered

- Keeping a bottom-only composer or welcome suggestions contradicts the requested
  empty-state behavior.
- Moving the manager composer outside its grid would duplicate panel-width and
  responsive-column logic.
- Sizing the model button to its text would keep shifting neighboring controls.

## Consequences

No host protocol, settings data, dependencies, or backend behavior changed. Compile,
strict type checking, and targeted settings/model/manager/Webview unit checks pass.
Headless Edge checks cover short and long names, Chinese/English sidebar and manager
layouts, center-to-bottom transitions, clearing/history, reduced motion, popup
anchors, inspector alignment, context-limit saves, and short-window model menus.
