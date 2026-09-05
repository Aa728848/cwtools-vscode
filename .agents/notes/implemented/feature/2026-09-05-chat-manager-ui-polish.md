# Agent Note: Compact chat navigation and readable manager inspection

Status: implemented

## Problem

A fixed 420 px chat minimum clipped sidebar navigation and Send. The empty composer
named a fixed project. Topic actions crowded each row. The
manager received topic snapshots without rendering the shared list and displayed
tiny, repetitive trajectory records and redundant settings headings.

## Decision

Removed the chat minimum and allowed composer controls to wrap at narrow widths.
The empty composer centers and animates down when a conversation starts, on both
surfaces. Model controls keep stable spacing; context mentions remain in the Add
menu. Secondary header and topic actions
use labeled disclosures. All topic commands remain accessible. Rename completion
prevents synchronous blur from submitting/replacing the input twice.

Manager snapshots hydrate the shared topic list without replacing active search
results. Changes, Run, and Settings share one row of peer tabs.
The inspector initially stays closed until file changes need it, and retains user
choices. Settings retain context limits, advanced controls, drafts, and host payloads;
folded sections summarize completion, MCP, and customized profile configuration.

Trajectory groups calls by invocation and agent, with search, filters, duration, and
a chronological raw view. Grouped calls retain created/start/end event inspection.
Correlation respects agent and process identity; raw records expand in batches of
300. Finished-run duration uses the same stable clock in both views. Diagnostics
and transcripts are disclosures. Conversation and inspection typography is larger;
usage charts fill the available width and tool rankings expose all entries.

## Alternatives considered

- Removing advanced controls would lose configuration and diagnostic capabilities.
- Separate chat implementations would duplicate host routing and draft state.
- Keeping start/end records expanded would preserve clutter; the raw view retains
  chronological detail while grouping is the default.

## Consequences

No dependencies or host protocol changes are required. Unit tests cover invocation
correlation, failure summaries, and event retention. Headless Edge checks exercise
localized/themed narrow layouts, snapshot topic rendering, search/rename/archive,
trajectory filtering and event inspection, stable clocks, and settings drafts across
panel tabs. Existing settings checks cover context save/reopen/default zero,
profiles, MCP, keys, account and proxy actions. Installed extensions still require
the normal packaging/reload flow to pick up source changes.
