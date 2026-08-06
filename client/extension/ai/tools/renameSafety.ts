import * as crypto from 'crypto';

export interface RenameEditPreview {
    file: string;
    startOffset: number;
    endOffset: number;
    newText: string;
    context: string;
}

export interface RenameExpansionPlan {
    oldName: string;
    newName: string;
    files: Array<{ file: string; edits: number }>;
    occurrences: Array<{ file: string; context: string }>;
    planHash: string;
}

const COMPOSITE_MARKER_RE = /\$[A-Za-z_][A-Za-z0-9_]*\$|(?:event_target|global_event_target|variable):[A-Za-z0-9_.$:@-]+/i;

export function renameNeedsExpansionPlan(oldName: string, newName: string, edits: readonly RenameEditPreview[]): boolean {
    if (COMPOSITE_MARKER_RE.test(oldName) || COMPOSITE_MARKER_RE.test(newName)) return true;
    return edits.some(edit =>
        COMPOSITE_MARKER_RE.test(edit.context)
        || (/[/\\]common[/\\]inline_scripts[/\\]/i.test(edit.file) && edit.context.includes('$'))
    );
}

export function applyRenameEdits(content: string, edits: readonly RenameEditPreview[]): string {
    const ordered = [...edits].sort((a, b) => b.startOffset - a.startOffset || b.endOffset - a.endOffset);
    let previousStart = content.length + 1;
    let output = content;
    for (const edit of ordered) {
        if (!Number.isInteger(edit.startOffset) || !Number.isInteger(edit.endOffset)
            || edit.startOffset < 0 || edit.endOffset < edit.startOffset || edit.endOffset > content.length) {
            throw new Error(`Rename edit range ${edit.startOffset}-${edit.endOffset} is outside the document.`);
        }
        if (edit.endOffset > previousStart) {
            throw new Error('Rename provider returned overlapping edits for one document.');
        }
        output = output.slice(0, edit.startOffset) + edit.newText + output.slice(edit.endOffset);
        previousStart = edit.startOffset;
    }
    return output;
}

export function buildRenameExpansionPlan(oldName: string, newName: string, edits: readonly RenameEditPreview[]): RenameExpansionPlan {
    const files = Array.from(
        edits.reduce((counts, edit) => counts.set(edit.file, (counts.get(edit.file) ?? 0) + 1), new Map<string, number>()),
        ([file, count]) => ({ file, edits: count }),
    ).sort((a, b) => a.file.localeCompare(b.file));
    const occurrences = edits
        .map(edit => ({ file: edit.file, context: edit.context.trim().slice(0, 240) }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.context.localeCompare(b.context));
    const canonical = JSON.stringify({ oldName, newName, files, occurrences });
    return {
        oldName,
        newName,
        files,
        occurrences: occurrences.slice(0, 100),
        planHash: crypto.createHash('sha256').update(canonical).digest('hex'),
    };
}
