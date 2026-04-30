/**
 * CWTools AI Module — Diff Engine
 *
 * Lightweight Myers-based line diff algorithm for generating
 * line-level change visualization between file snapshots.
 * No external dependencies.
 */

export interface DiffLine {
    /** 'add' = new line, 'remove' = deleted line, 'context' = unchanged */
    type: 'add' | 'remove' | 'context';
    /** The text content of this line */
    content: string;
    /** Original line number (1-indexed, for 'remove' and 'context') */
    oldLineNo?: number;
    /** New line number (1-indexed, for 'add' and 'context') */
    newLineNo?: number;
}

export interface FileDiffResult {
    /** Total lines added */
    additions: number;
    /** Total lines removed */
    deletions: number;
    /** The diff lines (may be truncated) */
    lines: DiffLine[];
    /** Whether the output was truncated due to size limits */
    truncated: boolean;
}

/**
 * Maximum number of diff lines to emit per file.
 * Prevents the Webview from choking on huge diffs.
 */
const MAX_DIFF_LINES = 300;

/**
 * Maximum number of context lines to show around each change hunk.
 */
const CONTEXT_LINES = 3;

/**
 * Compute a line-level diff between two strings using a simplified
 * Myers-style algorithm with O(ND) time and O(N) space.
 *
 * Returns an array of DiffLine objects suitable for rendering.
 */
export function computeLineDiff(
    oldContent: string,
    newContent: string,
    maxLines: number = MAX_DIFF_LINES
): FileDiffResult {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // For very large files, fall back to a simpler approach
    const totalLines = oldLines.length + newLines.length;
    if (totalLines > 10000) {
        return computeSimpleDiff(oldLines, newLines, maxLines);
    }

    // Compute the LCS-based edit script
    const edits = myersDiff(oldLines, newLines);

    // Convert raw edits to DiffLine[] with context collapsing
    return formatDiffWithContext(edits, oldLines, newLines, maxLines);
}

// ── Myers Diff Core ──────────────────────────────────────────────────────────

interface Edit {
    type: 'keep' | 'insert' | 'delete';
    oldIdx?: number;  // index in oldLines (for keep/delete)
    newIdx?: number;  // index in newLines (for keep/insert)
}

function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
    const N = oldLines.length;
    const M = newLines.length;
    const MAX = N + M;

    if (MAX === 0) return [];

    // V[k] stores the furthest-reaching x for diagonal k
    // Using offset to handle negative indices: V[k + offset]
    const offset = MAX;
    const size = 2 * MAX + 1;
    const V = new Int32Array(size).fill(-1);
    V[1 + offset] = 0;

    // Store the trace for backtracking
    const trace: Int32Array[] = [];

    outer:
    for (let d = 0; d <= MAX; d++) {
        const Vcopy = new Int32Array(V);
        trace.push(Vcopy);

        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && V[k - 1 + offset]! < V[k + 1 + offset]!)) {
                x = V[k + 1 + offset]!;  // move down
            } else {
                x = V[k - 1 + offset]! + 1;  // move right
            }

            let y = x - k;

            // Follow diagonal (matching lines)
            while (x < N && y < M && oldLines[x] === newLines[y]) {
                x++;
                y++;
            }

            V[k + offset] = x;

            if (x >= N && y >= M) {
                break outer;
            }
        }
    }

    // Backtrack to find the edit script
    return backtrack(trace, oldLines, newLines, offset);
}

function backtrack(
    trace: Int32Array[],
    oldLines: string[],
    newLines: string[],
    offset: number
): Edit[] {
    const edits: Edit[] = [];
    let x = oldLines.length;
    let y = newLines.length;

    for (let d = trace.length - 1; d >= 0; d--) {
        const V = trace[d]!;
        const k = x - y;

        let prevK: number;
        if (k === -d || (k !== d && V[k - 1 + offset]! < V[k + 1 + offset]!)) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }

        const prevX = V[prevK + offset]!;
        const prevY = prevX - prevK;

        // Diagonal moves (matching lines) — walk backwards
        while (x > prevX && y > prevY) {
            x--;
            y--;
            edits.push({ type: 'keep', oldIdx: x, newIdx: y });
        }

        if (d > 0) {
            if (x === prevX) {
                // Vertical move = insertion
                y--;
                edits.push({ type: 'insert', newIdx: y });
            } else {
                // Horizontal move = deletion
                x--;
                edits.push({ type: 'delete', oldIdx: x });
            }
        }
    }

    edits.reverse();
    return edits;
}

// ── Output Formatting ────────────────────────────────────────────────────────

function formatDiffWithContext(
    edits: Edit[],
    oldLines: string[],
    newLines: string[],
    maxLines: number
): FileDiffResult {
    let additions = 0;
    let deletions = 0;
    const allLines: DiffLine[] = [];

    // First pass: convert all edits to DiffLines and count stats
    for (const edit of edits) {
        switch (edit.type) {
            case 'keep':
                allLines.push({
                    type: 'context',
                    content: oldLines[edit.oldIdx!]!,
                    oldLineNo: edit.oldIdx! + 1,
                    newLineNo: edit.newIdx! + 1,
                });
                break;
            case 'delete':
                deletions++;
                allLines.push({
                    type: 'remove',
                    content: oldLines[edit.oldIdx!]!,
                    oldLineNo: edit.oldIdx! + 1,
                });
                break;
            case 'insert':
                additions++;
                allLines.push({
                    type: 'add',
                    content: newLines[edit.newIdx!]!,
                    newLineNo: edit.newIdx! + 1,
                });
                break;
        }
    }

    // Second pass: collapse context lines, keeping only CONTEXT_LINES around changes
    const result: DiffLine[] = [];
    const changeIndices = new Set<number>();

    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i]!.type !== 'context') {
            // Mark this line and surrounding context
            for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(allLines.length - 1, i + CONTEXT_LINES); j++) {
                changeIndices.add(j);
            }
        }
    }

    let lastIncluded = -1;
    let truncated = false;

    for (let i = 0; i < allLines.length; i++) {
        if (changeIndices.has(i)) {
            // Add separator if there's a gap
            if (lastIncluded >= 0 && i > lastIncluded + 1) {
                const skipped = i - lastIncluded - 1;
                result.push({
                    type: 'context',
                    content: `... ${skipped} lines hidden ...`,
                });
            }
            result.push(allLines[i]!);
            lastIncluded = i;

            if (result.length >= maxLines) {
                truncated = true;
                break;
            }
        }
    }

    return { additions, deletions, lines: result, truncated };
}

// ── Simple Diff Fallback ─────────────────────────────────────────────────────

/**
 * For very large files (>10k lines), use a simpler LCS-free approach:
 * find contiguous blocks of changes using line hashing.
 */
function computeSimpleDiff(
    oldLines: string[],
    newLines: string[],
    maxLines: number
): FileDiffResult {
    let additions = 0;
    let deletions = 0;
    const lines: DiffLine[] = [];

    // Build line occurrence maps
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);

    // Lines only in old = deletions
    for (let i = 0; i < oldLines.length && lines.length < maxLines; i++) {
        if (!newSet.has(oldLines[i]!)) {
            deletions++;
            lines.push({ type: 'remove', content: oldLines[i]!, oldLineNo: i + 1 });
        }
    }

    // Lines only in new = additions
    for (let i = 0; i < newLines.length && lines.length < maxLines; i++) {
        if (!oldSet.has(newLines[i]!)) {
            additions++;
            lines.push({ type: 'add', content: newLines[i]!, newLineNo: i + 1 });
        }
    }

    return {
        additions,
        deletions,
        lines,
        truncated: lines.length >= maxLines,
    };
}
