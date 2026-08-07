export interface DraftTextPosition {
    line: number;
    character: number;
}

export interface DraftTextEdit {
    start: DraftTextPosition;
    end: DraftTextPosition;
    newText: string;
}

function positionOffset(text: string, position: DraftTextPosition): number {
    if (position.line <= 0) return Math.min(Math.max(0, position.character), text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    let line = 0;
    let offset = 0;
    while (line < position.line && offset < text.length) {
        const newline = text.indexOf('\n', offset);
        if (newline < 0) return text.length;
        offset = newline + 1;
        line++;
    }
    const newline = text.indexOf('\n', offset);
    const lineEnd = newline < 0 ? text.length : newline;
    return Math.min(offset + Math.max(0, position.character), lineEnd);
}

/** Apply non-overlapping VS Code-style text edits to an in-memory draft. */
export function applyDraftTextEdits(text: string, edits: readonly DraftTextEdit[]): string | undefined {
    const resolved = edits.map(edit => ({
        start: positionOffset(text, edit.start),
        end: positionOffset(text, edit.end),
        newText: edit.newText,
    })).sort((left, right) => right.start - left.start || right.end - left.end);

    let previousStart = text.length;
    let result = text;
    for (const edit of resolved) {
        if (edit.start > edit.end || edit.end > previousStart) return undefined;
        result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
        previousStart = edit.start;
    }
    return result;
}
