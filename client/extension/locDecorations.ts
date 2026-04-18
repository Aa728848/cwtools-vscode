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
    '§P': '#AA88CC',   // Purple
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
 * Build a map of localization keys to their values from all open .yml files
 */
function buildLocMap(): Map<string, { value: string; uri: vs.Uri; line: number }> {
    const locMap = new Map<string, { value: string; uri: vs.Uri; line: number }>();
    const locPattern = /^\s*([a-zA-Z0-9_.:]+)\s*:\d*\s*"(.*)"\s*$/;

    for (const doc of vs.workspace.textDocuments) {
        if (!doc.fileName.endsWith('.yml')) continue;
        const text = doc.getText();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const match = locPattern.exec(lines[i]);
            if (match) {
                locMap.set(match[1], {
                    value: match[2],
                    uri: doc.uri,
                    line: i,
                });
            }
        }
    }
    return locMap;
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
    provideHover(document: vs.TextDocument, position: vs.Position): vs.Hover | null {
        const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_][A-Za-z0-9_.:]*\$/);
        if (!range) return null;

        const word = document.getText(range);
        const refName = word.replace(/^\$|\$$/g, '');

        const locMap = buildLocMap();
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
    provideDefinition(document: vs.TextDocument, position: vs.Position): vs.Location | null {
        const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_][A-Za-z0-9_.:]*\$/);
        if (!range) return null;

        const word = document.getText(range);
        const refName = word.replace(/^\$|\$$/g, '');

        const locMap = buildLocMap();
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

    // Apply decorations on document change
    context.subscriptions.push(
        vs.workspace.onDidChangeTextDocument(event => {
            const editor = vs.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                updateColorDecorations(editor);
            }
        }),
    );

    // Apply decorations on startup for the current editor
    if (vs.window.activeTextEditor) {
        updateColorDecorations(vs.window.activeTextEditor);
    }
}
