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

// Pattern to match §X...§! or §X...end-of-value
const colorPattern = /§([RGBYWHETLMSPr!])/g;

// Pattern to match $REF$ references
const refPattern = /\$([A-Za-z_][A-Za-z0-9_.:]*)\$/g;

/**
 * Cached localization map — rebuilt incrementally on document/file changes.
 */
const documentLocCache = new Map<string, Map<string, { value: string; uri: vs.Uri; line: number }>>();
let initialScanPromise: Promise<void> | null = null;

// Cached flat map to avoid rebuilding on every hover/definition request
let cachedFlatMap: Map<string, { value: string; uri: vs.Uri; line: number }> | null = null;
let flatMapDirty = true;

function parseYmlContent(uri: vs.Uri, text: string) {
    const fileLocs = new Map<string, { value: string; uri: vs.Uri; line: number }>();
    const locPattern = /^\s*([a-zA-Z0-9_.:-]+)\s*:\d*\s*"(.*)"\s*$/;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const match = locPattern.exec(lines[i]!);
        if (match) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            fileLocs.set(match[1]!, { value: match[2]!, uri, line: i });
        }
    }
    documentLocCache.set(uri.toString(), fileLocs);
    flatMapDirty = true;
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

    if (!flatMapDirty && cachedFlatMap) return cachedFlatMap;

    const flatMap = new Map<string, { value: string; uri: vs.Uri; line: number }>();
    for (const fileLocs of documentLocCache.values()) {
        for (const [k, v] of fileLocs.entries()) {
            flatMap.set(k, v);
        }
    }
    cachedFlatMap = flatMap;
    flatMapDirty = false;
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const line = lines[lineIdx]!;

        // Find all color markers in this line
        const markers: { code: string; offset: number }[] = [];
        let match: RegExpExecArray | null;
        const linePattern = /§([RGBYWHETLMSPr!])/g;

        while ((match = linePattern.exec(line)) !== null) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const code = '\u00A7' + match[1]!;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            markers.push({ code, offset: match.index! });

            // Mark the §X itself as dim
            markerRanges.push({
                range: new vs.Range(lineIdx, match.index, lineIdx, match.index + 2),
            });
        }

        // Apply color ranges between markers
        for (let i = 0; i < markers.length; i++) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const marker = markers[i]!;
            if (marker.code === '\u00A7!') continue; // Reset marker, skip

            const startOffset = marker.offset + 2; // After \u00A7X
            const endOffset = i + 1 < markers.length
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
    async provideHover(document: vs.TextDocument, position: vs.Position): Promise<vs.Hover | null> {
        const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_][A-Za-z0-9_.:-]*\$/);
        if (!range) return null;

        const word = document.getText(range);
        const refName = word.replace(/^\$|\$$/g, '');

        const locMap = await getLocMap();
        const entry = locMap.get(refName);
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
 * 脚本文件中本地化 key 的定义跳转
 * 支持 title = "xxx" / name = xxx / desc = xxx 等引用格式
 */
class ScriptLocDefinitionProvider implements vs.DefinitionProvider {
    async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
        // 尝试匹配带引号和不带引号的字符串值
        const range =
            document.getWordRangeAtPosition(position, /"([A-Za-z_][A-Za-z0-9_.:-]+)"/) ||
            document.getWordRangeAtPosition(position, /\b([A-Za-z_][A-Za-z0-9_.:-]+)\b/);
        if (!range) return null;

        let word = document.getText(range).replace(/^"|"$/g, '');
        // 跳过明显非本地化 key 的情况（纯数字、yes/no、常见关键字等）
        if (/^\d+$/.test(word) || /^(yes|no|none|root|prev|from|this|event_target|owner|capital_scope)$/i.test(word)) return null;

        const locMap = await getLocMap();
        const entry = locMap.get(word);
        if (!entry) return null;

        return new vs.Location(entry.uri, new vs.Position(entry.line, 0));
    }
}


/**
 * 注册所有本地化增强功能
 */
export function registerLocalizationFeatures(context: vs.ExtensionContext): void {
    // 注册 .yml 文件内 $REF$ 引用的 hover 和定义跳转
    const ymlSelector: vs.DocumentSelector = { scheme: 'file', pattern: '**/*.yml' };

    // 游戏脚本语言选择器 — 用于脚本文件中 loc key 的跳转
    const gameLanguages = ['stellaris', 'hoi4', 'eu4', 'ck2', 'imperator', 'vic2', 'vic3', 'ck3', 'eu5', 'paradox'];
    const scriptSelector: vs.DocumentSelector = gameLanguages.map(lang => ({ scheme: 'file', language: lang }));

    context.subscriptions.push(
        // .yml 文件内部的 $REF$ 引用
        vs.languages.registerHoverProvider(ymlSelector, new LocRefHoverProvider()),
        vs.languages.registerDefinitionProvider(ymlSelector, new LocRefDefinitionProvider()),
        // 脚本文件中 loc key 的 Ctrl+Click 跳转
        // 注意：不注册 ScriptLocHoverProvider，因为 F# CWTools 后端已经通过
        // lochoverFromInfo 提供了脚本文件中 loc key 的本地化悬浮预览，
        // 重复注册会导致 hover 弹窗中翻译文本出现两次。
        vs.languages.registerDefinitionProvider(scriptSelector, new ScriptLocDefinitionProvider()),
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
            if (/localisation[^/\\]*[\/\\].*\.yml$/.test(event.document.fileName)) {
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
    const watcher = vs.workspace.createFileSystemWatcher('**/{localisation,localisation_synced,localization}/**/*.yml');
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
        flatMapDirty = true;
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
