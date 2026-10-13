/**
 * Pure matcher for `path:line(-line)` file references inside chat text.
 * DOM-free so it can be unit-tested without a webview; the webview wraps each
 * hit in a `.file-ref-link` button (see chatPanel.ts linkifyFileReferences).
 */

export interface FileReferenceMatch {
    /** File path as written in the source text. */
    file: string;
    /** 1-based start line. */
    startLine: number;
    /** 1-based inclusive end line, present only for `path:start-end`. */
    endLine?: number;
    /** Offset of the match within the input text. */
    index: number;
    /** Full matched text (`path:line` or `path:line-line`). */
    text: string;
}

const FILE_REFERENCE_EXTENSIONS = [
    'txt', 'yml', 'yaml', 'gui', 'gfx', 'asset', 'mod', 'md', 'json',
    'cwt', 'loc', 'pdxtxt', 'shader', 'fxh', 'rules', 'ps1', 'py', 'js', 'ts',
] as const;

// A path segment may contain word chars, dots and hyphens; segments are joined
// by forward slashes. The leading lookbehind rejects matches glued onto a
// longer path (e.g. inside a URL) or onto a word/dot/slash character.
const FILE_REFERENCE_PATTERN = new RegExp(
    '(?<![\\w/.-])'
    + '((?:[\\w~-]+(?:\\.[\\w~-]+)*/)*[\\w~-]+(?:\\.[\\w~-]+)*\\.(?:'
    + FILE_REFERENCE_EXTENSIONS.join('|')
    + '))'
    + ':(\\d+)(?:-(\\d+))?(?!\\w)',
    'gi',
);

/** Upper bound so a pathological blob cannot keep the matcher busy forever. */
const MAX_FILE_REFERENCE_MATCHES = 500;

/**
 * Returns every `path:line(-line)` hit in `text`, in source order.
 * Extension-less paths (e.g. `kuat_missions.12:129-132`) never match because
 * the extension must come from the whitelist.
 */
export function findFileReferences(text: string): FileReferenceMatch[] {
    if (!text) return [];
    FILE_REFERENCE_PATTERN.lastIndex = 0;
    const matches: FileReferenceMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = FILE_REFERENCE_PATTERN.exec(text)) !== null) {
        const startLine = Number(match[2]);
        const endLine = match[3] !== undefined ? Number(match[3]) : undefined;
        matches.push({
            file: match[1]!,
            startLine,
            endLine: endLine !== undefined && endLine >= startLine ? endLine : undefined,
            index: match.index,
            text: match[0],
        });
        if (matches.length >= MAX_FILE_REFERENCE_MATCHES) break;
    }
    return matches;
}
