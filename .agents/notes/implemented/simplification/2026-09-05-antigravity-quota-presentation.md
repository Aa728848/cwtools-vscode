# Agent Note: Antigravity quota presentation

Status: implemented

## Problem
Antigravity displayed quota buckets as small text lines, unlike the Codex subscription progress bars. The subscription proxy section also included explanatory fine print that the user asked to remove.

## Decision
Adapted Antigravity remaining percentages and reset timestamps to the existing Codex quota renderer. Both providers now use the same accessible usage bars, remaining percentages, reset labels, and warning colors. Limited the subdued settings-hint styling to account identity so quota bars retain normal contrast. Removed both static proxy explanations and retained the controls and live connection status. Added English and Chinese rendering regression coverage.

## Alternatives considered
- Duplicating the progress-bar markup and styles would create two implementations of the same display.
- Filling the bars with remaining quota would reverse the meaning and warning thresholds relative to Codex.
- Removing the live proxy status would hide useful connection and error feedback.

## Consequences
Antigravity quota presentation matches Codex without new CSS or changes to account/proxy transport. Existing HTML escaping, bounded quota rendering, unknown reset handling, and bilingual labels remain in use. Tests cover multiple buckets, usage conversion, warning colors, reset times, escaped names, and missing account/quota data.
