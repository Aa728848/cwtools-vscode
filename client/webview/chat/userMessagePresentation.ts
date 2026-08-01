export const LONG_USER_MESSAGE_CHARACTER_THRESHOLD = 800;
export const LONG_USER_MESSAGE_LINE_THRESHOLD = 10;
export const LONG_USER_MESSAGE_PREVIEW_LINES = 5;
export const LONG_USER_MESSAGE_PREVIEW_CHARACTERS = 360;

export interface UserMessagePresentation {
    isLong: boolean;
    lineCount: number;
    characterCount: number;
    preview: string;
}

/** Build a deterministic, display-only summary without changing the submitted text. */
export function buildUserMessagePresentation(text: string): UserMessagePresentation {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const characterCount = Array.from(text).length;
    const lineCount = lines.length;
    const isLong = characterCount >= LONG_USER_MESSAGE_CHARACTER_THRESHOLD
        || lineCount >= LONG_USER_MESSAGE_LINE_THRESHOLD;

    let preview = lines.slice(0, LONG_USER_MESSAGE_PREVIEW_LINES).join('\n').trimEnd();
    if (Array.from(preview).length > LONG_USER_MESSAGE_PREVIEW_CHARACTERS) {
        preview = Array.from(preview)
            .slice(0, LONG_USER_MESSAGE_PREVIEW_CHARACTERS)
            .join('')
            .trimEnd() + '…';
    } else if (lineCount > LONG_USER_MESSAGE_PREVIEW_LINES) {
        preview += '\n…';
    }

    return { isLong, lineCount, characterCount, preview };
}
