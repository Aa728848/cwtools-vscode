# Agent Note: Manager inspector tabs remain peers on one row

Status: implemented

## Problem

The detached manager moved the shared sidebar return button into its tab list.
An older two-column grid placed Settings and Return below Changes and Run,
incorrectly suggesting a navigation hierarchy.

## Decision

Kept the shared return button in its original header, which the manager hides,
and removed the manager-only relocation and styling. The inspector grid now has
three equal columns for Changes, Run, and Settings. The existing top-level panel
toggle closes the manager inspector; sidebar return behavior is preserved.

## Alternatives considered

Renaming or shrinking Return would keep a redundant action in the tab list.
Hiding Settings in a menu would misrepresent its peer relationship to Run and Changes.

## Consequences

No settings controls or host messages changed. Compilation, type checking, and
13 manager contract tests pass. A headless Edge regression checks Chinese and
English at panel widths 260, 294, 320, 380, and 520 px: all three tabs share a row,
Return is absent from the manager navigation, keyboard/click selection and the
panel toggle work, and the sidebar still exposes its original return action.
