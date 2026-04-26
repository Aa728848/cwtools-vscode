/**
 * Localization Enhancement Module
 * - Highlights §R, §G, §B etc. color markers in .yml files
 * - Provides hover preview for $REF$ references
 * - Provides Go to Definition for $REF$ references
 */
import * as vs from 'vscode';

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
    '§P': '#FFA4E4',   // Purple
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

// Pattern to match §X...§! or §X...end-of-value
const colorPattern = /§([RGBYWHETLMSP!])/gi;

// Pattern to match $REF$ references
const refPattern = /\$([A-Za-z_][A-Za-z0-9_.:]*)\$/g;

/**
 * Cached localization map — rebuilt incrementally on document/file changes.
 */
const documentLocCache = new Map<string, Map<string, { value: string; uri: vs.Uri; line: number }>>();
let initialScanPromise: Promise<void> | null = null;

function parseYmlContent(uri: vs.Uri, text: string) {
    const fileLocs = new Map<string, { value: string; uri: vs.Uri; line: number }>();
    const locPattern = /^\s*([a-zA-Z0-9_.:-]+)\s*:\d*\s*"(.*)"\s*$/;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const match = locPattern.exec(lines[i]);
        if (match) {
            fileLocs.set(match[1], { value: match[2], uri, line: i });
        }
    }
    documentLocCache.set(uri.toString(), fileLocs);
}

async function performInitialScan(batchSize = 50) {
    try {
        const uris = await vs.workspace.findFiles('**/*.yml');
        for (let i = 0; i < uris.length; i += batchSize) {
            const batch = uris.slice(i, i + batchSize);
            await Promise.all(batch.map(async (uri) => {
                try {
                    const stat = await vs.workspace.fs.stat(uri);
                    if (stat.size > 512 * 1024) return;
                    const data = await vs.workspace.fs.readFile(uri);
                    const text = new TextDecoder('utf-8').decode(data);
                    parseYmlContent(uri, text);
                } catch {
                    // Ignore read errors on individual files
                }
            }));
        }
    } catch {
        // Ignore search errors
    }
}

async function getLocMap(): Promise<Map<string, { value: string; uri: vs.Uri; line: number }>> {
    if (!initialScanPromise) {
        initialScanPromise = performInitialScan();
    }
    await initialScanPromise;

    const flatMap = new Map<string, { value: string; uri: vs.Uri; line: number }>();
    for (const fileLocs of documentLocCache.values()) {
        for (const [k, v] of fileLocs.entries()) {
            flatMap.set(k, v);
        }
    }
    return flatMap;
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
        const line = lines[lineIdx];

        // Find all color markers in this line
        const markers: { code: string; offset: number }[] = [];
        let match: RegExpExecArray | null;
        const linePattern = /§([RGBYWHETLMSP!])/gi;

        while ((match = linePattern.exec(line)) !== null) {
            const code = '§' + match[1].toUpperCase();
            markers.push({ code, offset: match.index });

            // Mark the §X itself as dim
            markerRanges.push({
                range: new vs.Range(lineIdx, match.index, lineIdx, match.index + 2),
            });
        }

        // Apply color ranges between markers
        for (let i = 0; i < markers.length; i++) {
            const marker = markers[i];
            if (marker.code === '§!') continue; // Reset marker, skip

            const startOffset = marker.offset + 2; // After §X
            const endOffset = i + 1 < markers.length
                ? markers[i + 1].offset
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
    async provideHover(document: vs.TextDocument, position: vs.Position): Promise<vs.Hover | null> {
        const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_][A-Za-z0-9_.:-]*\$/);
        if (!range) return null;

        const word = document.getText(range);
        const refName = word.replace(/^\$|\$$/g, '');

        const locMap = await getLocMap();
        const entry = locMap.get(refName);
        if (!entry) return null;

        // Strip color codes for display
        const cleanValue = entry.value.replace(/§[RGBYWHETLMSP!]/gi, '');

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
    async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
        const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_][A-Za-z0-9_.:-]*\$/);
        if (!range) return null;

        const word = document.getText(range);
        const refName = word.replace(/^\$|\$$/g, '');

        const locMap = await getLocMap();
        const entry = locMap.get(refName);
        if (!entry) return null;

        return new vs.Location(entry.uri, new vs.Position(entry.line, 0));
    }
}

/**
 * Register all localization enhancement features
 */
export function registerLocalizationFeatures(context: vs.ExtensionContext): void {
    // Register hover and definition providers for .yml files
    const ymlSelector: vs.DocumentSelector = { scheme: 'file', pattern: '**/*.yml' };

    context.subscriptions.push(
        vs.languages.registerHoverProvider(ymlSelector, new LocRefHoverProvider()),
        vs.languages.registerDefinitionProvider(ymlSelector, new LocRefDefinitionProvider()),
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
            if (event.document.fileName.endsWith('.yml')) {
                parseYmlContent(event.document.uri, event.document.getText());
            }
            const editor = vs.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                updateColorDecorations(editor);
            }
        }),
    );

    // Initial parse of any already open .yml files
    for (const doc of vs.workspace.textDocuments) {
        if (doc.fileName.endsWith('.yml')) {
            parseYmlContent(doc.uri, doc.getText());
        }
    }

    // Set up file system watchers for background tracking of .yml files
    const watcher = vs.workspace.createFileSystemWatcher('**/*.yml');
    context.subscriptions.push(watcher);

    watcher.onDidChange(async uri => {
        try {
            const data = await vs.workspace.fs.readFile(uri);
            const text = new TextDecoder('utf-8').decode(data);
            parseYmlContent(uri, text);
        } catch { }
    });
    watcher.onDidCreate(async uri => {
        try {
            const data = await vs.workspace.fs.readFile(uri);
            const text = new TextDecoder('utf-8').decode(data);
            parseYmlContent(uri, text);
        } catch { }
    });
    watcher.onDidDelete(uri => {
        documentLocCache.delete(uri.toString());
    });

    // Fire off the background scan
    if (!initialScanPromise) {
        initialScanPromise = performInitialScan();
    }

    // Apply decorations on startup for the current editor
    if (vs.window.activeTextEditor) {
        updateColorDecorations(vs.window.activeTextEditor);
    }
}
