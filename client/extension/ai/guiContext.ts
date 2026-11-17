import { parseGuiFile } from '../guiParser';
import { resolveGuiElementReference, type GuiSelectionContextData } from '../../shared/guiPreview';

const GUI_ELEMENT_PROMPT_LIMIT = 4000;
const GUI_SELECTION_PROMPT_LIMIT = 20000;

/** Build bounded model context from the latest in-memory document, never a stale selection snapshot. */
export function buildGuiSelectionPrompt(
    content: string,
    context: GuiSelectionContextData,
    currentDocumentVersion: number,
    dirty: boolean,
): string {
    const parsed = parseGuiFile(content, new Map());
    const lines = content.split(/\r?\n/);
    const fence = String.fromCharCode(96).repeat(3);
    const header = [
        `GUI selection: ${context.uri}`,
        `Document version: attached=${context.documentVersion}, current=${currentDocumentVersion}, dirty=${dirty}`,
        'Element paths are zero-based sibling indexes. Verify the current source before editing.',
        'Preserve engine-required named controls, including off-canvas controls, their names and hierarchy.',
    ];
    if (context.region) {
        header.push(`Marquee region in GUI coordinates: x=${context.region.x}, y=${context.region.y}, width=${context.region.width}, height=${context.region.height}`);
    }
    if (dirty) header.push('The document has unsaved changes. Do not write it until the user has saved it.');
    const blocks: string[] = [];
    let remaining = GUI_SELECTION_PROMPT_LIMIT;
    for (const reference of context.elements) {
        const resolved = resolveGuiElementReference(parsed, reference);
        if (!resolved) {
            blocks.push(`[Stale or ambiguous GUI element: path=${reference.path}, name=${reference.name}, type=${reference.type}. Ask the user to reselect it.]`);
            continue;
        }
        const start = Math.max(0, resolved.element.line - 1);
        const end = Math.min(lines.length, resolved.element.endLine);
        const raw = lines.slice(start, end).join('\n');
        const clipped = raw.length > Math.min(GUI_ELEMENT_PROMPT_LIMIT, remaining);
        const excerpt = raw.slice(0, Math.max(0, Math.min(GUI_ELEMENT_PROMPT_LIMIT, remaining)));
        remaining -= excerpt.length;
        blocks.push([
            `Element: ${resolved.element.name || '(unnamed)'} (${resolved.element.type}), path=${resolved.path}, lines ${resolved.element.line}-${resolved.element.endLine}`,
            fence + 'pdx',
            excerpt + (clipped ? '\n... [truncated]' : ''),
            fence,
        ].join('\n'));
        if (remaining <= 0) {
            blocks.push('[Remaining GUI elements omitted by the context size limit.]');
            break;
        }
    }
    return [...header, ...blocks].join('\n');
}
