/**
 * Localization Enhancement Module
 * - Highlights §R, §G, §B etc. color markers in .yml files
 * - Provides hover preview for $REF$ references
 * - Provides Go to Definition for $REF$ references
 */
import * as vs from 'vscode';
import type { IndexService, LocEntry } from './indexing/indexService';
import { parseLocFile } from './indexing/locParser';

// Paradox color code mapping
const COLOR_MAP: Record<string, string> = {
    '§R': '#FF4444',   // Red
    '§G': '#00CC00',   // Green
    '§B': '#4488FF',   // Blue
    '§Y': '#FFFF00',   // Yellow
    '§W': '#FFFFFF',   // White
    '§H': '#FFD700',   // Header (Gold)
    '§E': '#00CED1',   // Cyan/Teal
    '§T': '#BBBBBB',   // Tan/Gray
    '§L': '#CCAA55',   // Light brown
    '§M': '#FF44FF',   // Magenta
    '§S': '#AADDAA',   // Soft green
    '§P': '#FFA4E4',   // Pink
    '§r': '#9849FF',   // Purple
    '§!': '#CCCCCC',   // Reset (gray)
};

// Create decoration types for each color
const colorDecorationTypes = new Map<string, vs.TextEditorDecorationType>();

for (const [code, color] of Object.entries(COLOR_MAP)) {
    colorDecorationTypes.set(code, vs.window.createTextEditorDecorationType({
        color: color,
        // The §X marker itself gets a subtle background
        before: undefined,
    }));
}

// Decoration for the §X markers themselves
const markerDecorationType = vs.window.createTextEditorDecorationType({
    opacity: '0.5',
    fontStyle: 'italic',
});

type LocLookupEntry = { value: string; uri: vs.Uri; line: number };

const openDocumentLocCache = new Map<string, Map<string, LocLookupEntry>>();

function isYmlDocument(document: vs.TextDocument): boolean {
    return document.uri.scheme === 'file' && document.fileName.endsWith('.yml');
}

function cacheOpenDocumentLocalisation(document: vs.TextDocument): void {
    if (!isYmlDocument(document)) return;

    const entries = parseLocFile(document.getText(), document.uri.fsPath);
    const fileLocs = new Map<string, LocLookupEntry>();
    for (const entry of entries) {
        fileLocs.set(entry.key, {
            value: entry.value,
            uri: document.uri,
            line: Math.max(0, entry.line - 1),
        });
    }
    openDocumentLocCache.set(document.uri.toString(), fileLocs);
}

function fromIndexedEntry(entry: LocEntry): LocLookupEntry {
    return {
        value: entry.value,
        uri: vs.Uri.file(entry.file),
        line: Math.max(0, entry.line - 1),
    };
}

function findLocEntry(
    key: string,
    preferredDocument: vs.TextDocument,
    indexService?: IndexService,
): LocLookupEntry | undefined {
    // Fast path: check open document caches first (hash map O(1) lookup)
    const preferred = openDocumentLocCache.get(preferredDocument.uri.toString())?.get(key);
    if (preferred) return preferred;

    for (const fileLocs of openDocumentLocCache.values()) {
        const entry = fileLocs.get(key);
        if (entry) return entry;
    }

    // Non-blocking: query whatever has been indexed so far.
    const indexedEntry = indexService?.queryLocalisation({ key, limit: 1 })[0];
    return indexedEntry ? fromIndexedEntry(indexedEntry) : undefined;
}

/**
 * Apply color decorations to a .yml editor
 */
function updateColorDecorations(editor: vs.TextEditor) {
    if (!editor.document.fileName.endsWith('.yml')) return;

    const text = editor.document.getText();
    const markerRanges: vs.DecorationOptions[] = [];

    // Group colored ranges by color code
    const colorRanges = new Map<string, vs.DecorationOptions[]>();
    for (const code of colorDecorationTypes.keys()) {
        colorRanges.set(code, []);
    }

    // Parse each line for color codes
    const lines = text.split('\n');
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
         
        const line = lines[lineIdx]!;

        // Find all color markers in this line
        const markers: { code: string; offset: number }[] = [];
        let match: RegExpExecArray | null;
        const linePattern = /§([RGBYWHETLMSPr!])/g;

        while ((match = linePattern.exec(line)) !== null) {
            const code = '\u00A7' + match[1]!;
            markers.push({ code, offset: match.index! });

            // Mark the §X itself as dim
            markerRanges.push({
                range: new vs.Range(lineIdx, match.index, lineIdx, match.index + 2),
            });
        }

        // Apply color ranges between markers
        for (let i = 0; i < markers.length; i++) {
            const marker = markers[i]!;
            if (marker.code === '\u00A7!') continue; // Reset marker, skip

            const startOffset = marker.offset + 2; // After \u00A7X
            const endOffset = i + 1 < markers.length
                ? markers[i + 1]!.offset
                : line.length;

            if (startOffset < endOffset) {
                const ranges = colorRanges.get(marker.code);
                if (ranges) {
                    ranges.push({
                        range: new vs.Range(lineIdx, startOffset, lineIdx, endOffset),
                    });
                }
            }
        }
    }

    // Apply all decorations
    editor.setDecorations(markerDecorationType, markerRanges);
    for (const [code, decorationType] of colorDecorationTypes) {
        const ranges = colorRanges.get(code) || [];
        editor.setDecorations(decorationType, ranges);
    }
}

/**
 * Hover provider for $REF$ references in .yml files
 */
class LocRefHoverProvider implements vs.HoverProvider {
    constructor(private readonly indexService: IndexService) {}

    async provideHover(document: vs.TextDocument, position: vs.Position): Promise<vs.Hover | null> {
        const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_][A-Za-z0-9_.:-]*\$/);
        if (!range) return null;

        const word = document.getText(range);
        const refName = word.replace(/^\$|\$$/g, '');

        const entry = findLocEntry(refName, document, this.indexService);
        if (!entry) return null;

        // Strip color codes for display
        const cleanValue = entry.value.replace(/§[RGBYWHETLMSPr!]/g, '');

        const md = new vs.MarkdownString();
        md.appendMarkdown(`**${refName}**\n\n`);
        md.appendMarkdown(`> ${cleanValue}\n\n`);
        md.appendMarkdown(`*Source: ${vs.workspace.asRelativePath(entry.uri)}:${entry.line + 1}*`);

        return new vs.Hover(md, range);
    }
}

/**
 * Definition provider for $REF$ references in .yml files
 */
class LocRefDefinitionProvider implements vs.DefinitionProvider {
    constructor(private readonly indexService: IndexService) {}

    async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
        const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_][A-Za-z0-9_.:-]*\$/);
        if (!range) return null;

        const word = document.getText(range);
        const refName = word.replace(/^\$|\$$/g, '');

        const entry = findLocEntry(refName, document, this.indexService);
        if (!entry) return null;

        return new vs.Location(entry.uri, new vs.Position(entry.line, 0));
    }
}

/**
 * Patterns that precede a loc-key reference in PDXScript assignments.
 * Only unquoted identifiers following these patterns are treated as potential loc keys.
 */
const LOC_KEY_CONTEXT_RE = /\b(?:title|desc|name|tooltip|text|custom_tooltip|fail_text|success_text|option_name|trigger_tooltip|description|localization|loc|key)\s*=\s*$/;

/** Common PDXScript keywords and prefixes that are never localisation keys. */
const NON_LOC_KEYWORDS_RE = /^(yes|no|none|root|prev|from|this|event_target|owner|capital_scope|controller|solar_system|planet|pop|species|leader|country|fleet|ship|army|sector|federation|galactic_community|is_|has_|any_|every_|random_|count_|set_|add_|remove_|change_|check_|limit|modifier|potential|allow|effect|trigger|weight|factor|mult|if|else|else_if|switch|while|NOT|AND|OR|NOR|NAND)$/i;

/** 
* Jump to the definition of localization key in the script file 
* Support title = "xxx" / name = xxx / desc = xxx and other reference formats.
* 
* Performance: Unquoted identifiers are only matched when preceded by a known
* loc-key assignment context (title =, desc =, etc.) to avoid flooding the
* IndexService with lookups for every PDXScript keyword on every Ctrl+Click.
*/
class ScriptLocDefinitionProvider implements vs.DefinitionProvider {
    constructor(private readonly indexService: IndexService) {}

    async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
        // 1. Prefer quoted strings — these are almost always loc key references
        let range = document.getWordRangeAtPosition(position, /"([A-Za-z_][A-Za-z0-9_.:-]+)"/);
        const isQuoted = !!range;

        // 2. Fall back to unquoted identifiers only if preceded by a loc-key context
        if (!range) {
            range = document.getWordRangeAtPosition(position, /\b([A-Za-z_][A-Za-z0-9_.:-]+)\b/);
            if (!range) return null;

            // Check that the text before this word matches a loc assignment pattern
            const lineText = document.lineAt(position.line).text;
            const textBefore = lineText.substring(0, range.start.character);
            if (!LOC_KEY_CONTEXT_RE.test(textBefore)) return null;
        }

        const word = document.getText(range).replace(/^"|"$/g, '');

        // Skip obvious non-localisation tokens
        if (/^\d+$/.test(word) || word.length < 2) return null;
        if (NON_LOC_KEYWORDS_RE.test(word)) return null;
        // Skip identifiers with common non-loc prefixes (GFX_, event., trigger names, etc.)
        if (!isQuoted && /^(GFX_|gfx\/|event\.|@)/.test(word)) return null;

        const entry = findLocEntry(word, document, this.indexService);
        if (!entry) return null;

        return new vs.Location(entry.uri, new vs.Position(entry.line, 0));
    }
}


/** 
* Register all localization enhancements 
*/
export function registerLocalizationFeatures(context: vs.ExtensionContext, indexService: IndexService): void {
    // Register the hover and definition jump referenced by $REF$ in the .yml file
    const ymlSelector: vs.DocumentSelector = { scheme: 'file', pattern: '**/*.yml' };

    // Game script language selector — used to jump to the loc key in the script file
    const gameLanguages = ['stellaris', 'hoi4', 'eu4', 'ck2', 'imperator', 'vic2', 'vic3', 'ck3', 'eu5', 'paradox'];
    const scriptSelector: vs.DocumentSelector = gameLanguages.map(lang => ({ scheme: 'file', language: lang }));

    context.subscriptions.push(
        // $REF$ reference inside .yml file
        vs.languages.registerHoverProvider(ymlSelector, new LocRefHoverProvider(indexService)),
        vs.languages.registerDefinitionProvider(ymlSelector, new LocRefDefinitionProvider(indexService)),
        //Ctrl+Click jump of loc key in script file
        // Note: ScriptLocHoverProvider is not registered because the F# CWTools backend already passes
        // lochoverFromInfo provides a localized floating preview of the loc key in the script file.
        // Repeated registration will cause the translated text to appear twice in the hover pop-up window.
        vs.languages.registerDefinitionProvider(scriptSelector, new ScriptLocDefinitionProvider(indexService)),
    );

    // Apply decorations on active editor change
    context.subscriptions.push(
        vs.window.onDidChangeActiveTextEditor(editor => {
            if (editor) updateColorDecorations(editor);
        }),
    );

    // Update LocMap on document changes (active unsaved typing)
    context.subscriptions.push(
        vs.workspace.onDidChangeTextDocument(event => {
            if (isYmlDocument(event.document)) {
                cacheOpenDocumentLocalisation(event.document);
            }
            const editor = vs.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                updateColorDecorations(editor);
            }
        }),
    );

    // Initial parse of any already open .yml files
    for (const doc of vs.workspace.textDocuments) {
        if (isYmlDocument(doc)) {
            cacheOpenDocumentLocalisation(doc);
        }
    }

    // Apply decorations on startup for the current editor
    if (vs.window.activeTextEditor) {
        updateColorDecorations(vs.window.activeTextEditor);
    }
}
