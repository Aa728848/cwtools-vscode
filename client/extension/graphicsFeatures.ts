/**
 * Graphics Enhancement Module
 * - DDS/TGA image hover preview using ddsDecoder
 * - GFX sprite definition jump (Ctrl+Click)
 * - Room name completion and definition jump
 */
import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { decodeDds, decodeTga, type DdsResult } from './ddsDecoder';

// ─── LRU Cache ──────────────────────────────────────────────────────────────

class LRUCache<K, V> {
    private readonly max: number;
    private readonly map = new Map<K, V>();
    constructor(max: number) { this.max = max; }

    get(key: K): V | undefined {
        const val = this.map.get(key);
        if (val !== undefined) {
            // refresh position
            this.map.delete(key);
            this.map.set(key, val);
        }
        return val;
    }

    set(key: K, val: V): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, val);
        if (this.map.size > this.max) {
            const oldest = this.map.keys().next().value!;
            this.map.delete(oldest);
        }
    }

    clear(): void { this.map.clear(); }
}

// ─── Shared Patterns ────────────────────────────────────────────────────────

/**
 * Match image file paths — both quoted and unquoted.
 * Group 1: quoted path (with quotes), Group 2: the path inside quotes
 * Group 3: unquoted path (after = sign or standalone)
 */
const IMAGE_PATH_QUOTED_RE = /["']([^"']+\.(?:dds|tga|png))["']/gi;
const IMAGE_PATH_UNQUOTED_RE = /=\s*([^\s"'{}#]+\.(?:dds|tga|png))\b/gi;

/** Match a word at the cursor that looks like GFX_xxx */
const GFX_PREFIX_RE = /GFX_[A-Za-z0-9_]+/;

/** Regex to identify `room = ` context (with optional quotes) */
const ROOM_ASSIGN_RE = /\broom\s*=\s*["']?([A-Za-z0-9_]*)["']?\s*$/;

// ─── Vanilla Game Path Helper ───────────────────────────────────────────────

/**
 * Get the Stellaris vanilla game installation path from user configuration.
 * Uses `cwtools.cache.stellaris` which is set via the "Select vanilla folder" prompt.
 * This mirrors the approach used by GuiPanel._getGamePath().
 */
function getGamePath(): string | null {
    const config = vs.workspace.getConfiguration('cwtools');
    const configPath = config.get<string>('cache.stellaris');
    if (configPath && fs.existsSync(configPath)) return configPath;
    return null;
}

/**
 * Collect all search roots: workspace folders + vanilla game path.
 * Mod workspace folders are prioritized (checked first), vanilla is fallback.
 */
function getSearchRoots(): string[] {
    const roots: string[] = [];
    for (const wf of vs.workspace.workspaceFolders ?? []) {
        roots.push(wf.uri.fsPath);
    }
    const gamePath = getGamePath();
    if (gamePath && !roots.includes(gamePath)) {
        roots.push(gamePath);
    }
    return roots;
}

// ─── Image Hover Provider ───────────────────────────────────────────────────

const imageCache = new LRUCache<string, DdsResult | null>(64);

/**
 * Provides hover image previews for .dds / .tga / .png paths.
 * Supports both quoted paths ("gfx/foo.dds") and unquoted paths (= gfx/foo.dds).
 */
class ImageHoverProvider implements vs.HoverProvider {
    provideHover(document: vs.TextDocument, position: vs.Position): vs.Hover | null {
        const lineText = document.lineAt(position).text;

        // Try quoted paths first
        const quotedRe = new RegExp(IMAGE_PATH_QUOTED_RE.source, 'gi');
        let match: RegExpExecArray | null;
        while ((match = quotedRe.exec(lineText)) !== null) {
            const start = match.index + 1; // skip opening quote
            const end = start + match[1]!.length;
            if (position.character >= start && position.character <= end) {
                const relativePath = match[1]!;
                const range = new vs.Range(position.line, start, position.line, end);
                return this.createHover(document, relativePath, range);
            }
        }

        // Try unquoted paths (e.g. texturefile = gfx/foo.dds)
        const unquotedRe = new RegExp(IMAGE_PATH_UNQUOTED_RE.source, 'gi');
        while ((match = unquotedRe.exec(lineText)) !== null) {
            // Group 1 is the path; find its position within the match
            const fullMatch = match[0]!;
            const pathStr = match[1]!;
            const pathStart = match.index + fullMatch.indexOf(pathStr);
            const pathEnd = pathStart + pathStr.length;
            if (position.character >= pathStart && position.character <= pathEnd) {
                const range = new vs.Range(position.line, pathStart, position.line, pathEnd);
                return this.createHover(document, pathStr, range);
            }
        }

        return null;
    }

    private createHover(document: vs.TextDocument, relativePath: string, range: vs.Range): vs.Hover | null {
        const fullPath = resolveAssetPath(document, relativePath);
        if (!fullPath || !fs.existsSync(fullPath)) return null;
        return createImageHover(fullPath, relativePath, range);
    }
}

// ─── GFX Sprite Index ───────────────────────────────────────────────────────

interface GfxEntry {
    name: string;
    uri: vs.Uri;
    line: number;
    /** The texture file path referenced by this sprite (e.g. "gfx/event_pictures/foo.dds") */
    texturefile?: string;
}

/** Maps GFX name (e.g. "GFX_ship_part_background") → definition location */
let gfxIndex: Map<string, GfxEntry> | null = null;
let gfxIndexDirty = true;
let gfxIndexBuildPromise: Promise<Map<string, GfxEntry>> | null = null;

/**
 * Parse a single .gfx file for sprite name definitions.
 * Block-aware: captures both `name` and `texturefile` within the same sprite block.
 */
function parseGfxFile(uri: vs.Uri, text: string): GfxEntry[] {
    const entries: GfxEntry[] = [];
    const nameRe = /\bname\s*=\s*["']?([A-Za-z0-9_]+)["']?/;
    const texRe = /\btexture[Ff]ile\s*=\s*["']?([^"'\s}]+)["']?/;
    const lines = text.split('\n');
    let depth = 0;
    let currentName: string | null = null;
    let currentNameLine = -1;
    let currentTex: string | undefined;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Skip commented lines
        if (line.trimStart().startsWith('#')) continue;

        const tm = texRe.exec(line);
        if (tm) {
            currentTex = tm[1]!;
        }

        const nm = nameRe.exec(line);
        if (nm) {
            // If we already have a pending name without closure, emit it first
            if (currentName) {
                entries.push({ name: currentName, uri, line: currentNameLine, texturefile: currentTex });
                currentTex = undefined; // clear for the new name
            }
            currentName = nm[1]!;
            currentNameLine = i;
        }

        // Track brace depth AFTER extracting values for this line
        for (const ch of line) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth <= 1 && currentName) {
                    // Closing a sprite block — emit the entry
                    entries.push({ name: currentName, uri, line: currentNameLine, texturefile: currentTex });
                    currentName = null;
                    currentTex = undefined;
                }
            }
        }
    }
    // Flush any remaining entry
    if (currentName) {
        entries.push({ name: currentName, uri, line: currentNameLine, texturefile: currentTex });
    }
    return entries;
}

/** Build the full GFX index from all .gfx files in the workspace + vanilla */
async function buildGfxIndex(): Promise<Map<string, GfxEntry>> {
    const map = new Map<string, GfxEntry>();

    // Scan workspace .gfx files via VS Code API
    const uris = await vs.workspace.findFiles('**/*.gfx');
    const batchSize = 30;
    for (let i = 0; i < uris.length; i += batchSize) {
        const batch = uris.slice(i, i + batchSize);
        await Promise.all(batch.map(async (uri) => {
            try {
                const data = await vs.workspace.fs.readFile(uri);
                const text = new TextDecoder('utf-8').decode(data);
                for (const entry of parseGfxFile(uri, text)) {
                    map.set(entry.name, entry);
                }
            } catch { /* skip */ }
        }));
    }

    // Also scan vanilla game directory for .gfx files (interface/ and gfx/ folders)
    const gamePath = getGamePath();
    if (gamePath) {
        const vanillaDirs = [
            path.join(gamePath, 'interface'),
            path.join(gamePath, 'gfx'),
        ];
        for (const dir of vanillaDirs) {
            await scanDirForGfx(dir, map, 500);
        }
    }

    return map;
}

/** Recursively scan a directory for .gfx files and add entries to the index */
async function scanDirForGfx(dir: string, map: Map<string, GfxEntry>, maxFiles: number): Promise<void> {
    if (map.size >= maxFiles) return;
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (map.size >= maxFiles) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await scanDirForGfx(full, map, maxFiles);
            } else if (entry.name.endsWith('.gfx')) {
                try {
                    const content = await fs.promises.readFile(full, 'utf-8');
                    const uri = vs.Uri.file(full);
                    for (const gfxEntry of parseGfxFile(uri, content)) {
                        // Workspace entries take priority — don't overwrite
                        if (!map.has(gfxEntry.name)) {
                            map.set(gfxEntry.name, gfxEntry);
                        }
                    }
                } catch { /* skip unreadable */ }
            }
        }
    } catch { /* skip inaccessible dir */ }
}

/** Get the GFX index, with promise-based deduplication to prevent concurrent rebuilds */
async function getGfxIndex(): Promise<Map<string, GfxEntry>> {
    if (gfxIndex && !gfxIndexDirty) {
        return gfxIndex;
    }
    // Deduplicate concurrent rebuild requests
    if (!gfxIndexBuildPromise) {
        gfxIndexBuildPromise = buildGfxIndex().then(result => {
            gfxIndex = result;
            gfxIndexDirty = false;
            gfxIndexBuildPromise = null;
            return result;
        });
    }
    return gfxIndexBuildPromise;
}

/**
 * GoToDefinition for GFX_xxx sprite names.
 * Ctrl+Click on "GFX_something" → jump to `name = "GFX_something"` in .gfx file.
 */
class GfxDefinitionProvider implements vs.DefinitionProvider {
    async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
        const wordRange = document.getWordRangeAtPosition(position, GFX_PREFIX_RE);
        if (!wordRange) return null;

        const word = document.getText(wordRange);
        const index = await getGfxIndex();
        const entry = index.get(word);
        if (!entry) return null;

        return new vs.Location(entry.uri, new vs.Position(entry.line, 0));
    }
}

/**
 * HoverProvider for GFX_xxx references (e.g. `picture = GFX_evt_em_war_3`).
 * Resolves the GFX name → texturefile → decoded image preview.
 */
class GfxHoverProvider implements vs.HoverProvider {
    async provideHover(document: vs.TextDocument, position: vs.Position): Promise<vs.Hover | null> {
        const wordRange = document.getWordRangeAtPosition(position, GFX_PREFIX_RE);
        if (!wordRange) return null;

        const lineText = document.lineAt(position).text;
        const beforeWord = wordRange.start.character > 0 ? lineText[wordRange.start.character - 1] : '';
        const afterWord = lineText.substring(wordRange.end.character);
        
        // Prevent duplicate hovers: if this word is part of a file path, ImageHoverProvider handles it.
        if (beforeWord === '/' || beforeWord === '\\' || 
            afterWord.startsWith('.dds') || afterWord.startsWith('.png') || afterWord.startsWith('.tga')) {
            return null;
        }

        const word = document.getText(wordRange);
        const index = await getGfxIndex();
        const entry = index.get(word);
        if (!entry?.texturefile) return null;

        // Resolve the texture file path
        const fullPath = resolveAssetPathRaw(entry.texturefile);
        if (!fullPath) return null;

        return createImageHover(fullPath, entry.texturefile, wordRange, word);
    }
}

// ─── Convention-Based Icon Hover ────────────────────────────────────────────

/**
 * Well-known Stellaris icon directory conventions.
 * Maps directory context keywords → icon search paths.
 * For a file in `common/buildings/`, an entity named `building_xxx` → `gfx/interface/icons/buildings/building_xxx.dds`.
 */
const ICON_SEARCH_DIRS = [
    'gfx/interface/icons/buildings',
    'gfx/interface/icons/technologies',
    'gfx/interface/icons/districts',
    'gfx/interface/icons/decisions',
    'gfx/interface/icons/deposits',
    'gfx/interface/icons/traits',
    'gfx/interface/icons/resources',
    'gfx/interface/icons/edicts',
    'gfx/interface/icons/modifiers',
    'gfx/interface/icons/ship_parts',
    'gfx/interface/icons/planet_modifiers',
    'gfx/interface/icons/jobs',
    'gfx/interface/icons/governments/civics',
    'gfx/interface/icons/governments/authorities',
    'gfx/portraits/city_sets',
    'gfx/event_pictures',
];

/**
 * HoverProvider for convention-based icon lookup.
 * When hovering on an entity name (e.g. `building_factory`), searches well-known
 * icon directories for a matching .dds file and shows a preview.
 */
class IconHoverProvider implements vs.HoverProvider {
    async provideHover(document: vs.TextDocument, position: vs.Position): Promise<vs.Hover | null> {
        // Match identifier-like words (must contain at least one underscore to avoid noise)
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]*/  );
        if (!wordRange) return null;

        const lineText = document.lineAt(position).text;
        const beforeWord = wordRange.start.character > 0 ? lineText[wordRange.start.character - 1] : '';
        const afterWord = lineText.substring(wordRange.end.character);
        
        // Prevent duplicate hovers: if this word is part of a file path, ImageHoverProvider handles it.
        if (beforeWord === '/' || beforeWord === '\\' || 
            afterWord.startsWith('.dds') || afterWord.startsWith('.png') || afterWord.startsWith('.tga')) {
            return null;
        }

        const word = document.getText(wordRange);
        if (word.length < 4) return null;

        const candidates = new Set<string>();
        candidates.add(`${word}.dds`);
        candidates.add(`${word}.png`);

        if (word.startsWith('GFX_')) {
            // Check if it's explicitly defined in a .gfx file first
            const index = await getGfxIndex();
            if (index.has(word)) {
                return null; // Defer to GfxHoverProvider
            }

            // Fallback for engine implicitly registered images (e.g. event pictures, traits)
            const noGfx = word.substring(4);
            candidates.add(`${noGfx}.dds`);
            candidates.add(`${noGfx}.png`);

            const match = /^GFX_(evt|trait|building|tech|relic|origin|ship_part|ap|situation)_?(.*)/.exec(word);
            if (match && match[2]) {
                candidates.add(`${match[2]}.dds`);
                candidates.add(`${match[1]}_${match[2]}.dds`);
            }
        }

        // Search convention-based icon paths
        for (const dir of ICON_SEARCH_DIRS) {
            for (const cand of candidates) {
                const relativePath = `${dir}/${cand}`;
                const fullPath = resolveAssetPathRaw(relativePath);
                if (fullPath) {
                    return createImageHover(fullPath, relativePath, wordRange, word);
                }
            }
        }
        return null;
    }
}

// ─── Room Completion & Definition ───────────────────────────────────────────

interface RoomEntry {
    /** The room name (DDS filename without extension, e.g. "city_room") */
    name: string;
    uri: vs.Uri;
}

let roomCache: RoomEntry[] | null = null;
let roomCacheDirty = true;
let roomCacheBuildPromise: Promise<RoomEntry[]> | null = null;

/** Scan gfx/portraits/city_sets/ for .dds files in both workspace and vanilla */
async function scanRooms(): Promise<RoomEntry[]> {
    const entries: RoomEntry[] = [];
    const seen = new Set<string>();

    // Workspace files
    const uris = await vs.workspace.findFiles('gfx/portraits/city_sets/**/*.dds');
    for (const uri of uris) {
        const base = path.basename(uri.fsPath, '.dds');
        if (!seen.has(base)) {
            seen.add(base);
            entries.push({ name: base, uri });
        }
    }

    // Vanilla game directory
    const gamePath = getGamePath();
    if (gamePath) {
        const citySetsDir = path.join(gamePath, 'gfx', 'portraits', 'city_sets');
        try {
            await scanDirForDds(citySetsDir, entries, seen);
        } catch { /* skip */ }
    }

    return entries;
}

/** Recursively scan a directory for .dds files */
async function scanDirForDds(dir: string, entries: RoomEntry[], seen: Set<string>): Promise<void> {
    try {
        const dirEntries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of dirEntries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await scanDirForDds(full, entries, seen);
            } else if (entry.name.endsWith('.dds')) {
                const base = path.basename(entry.name, '.dds');
                if (!seen.has(base)) {
                    seen.add(base);
                    entries.push({ name: base, uri: vs.Uri.file(full) });
                }
            }
        }
    } catch { /* skip inaccessible */ }
}

/** Get room entries with promise-based deduplication */
async function getRoomEntries(): Promise<RoomEntry[]> {
    if (roomCache && !roomCacheDirty) {
        return roomCache;
    }
    if (!roomCacheBuildPromise) {
        roomCacheBuildPromise = scanRooms().then(result => {
            roomCache = result;
            roomCacheDirty = false;
            roomCacheBuildPromise = null;
            return result;
        });
    }
    return roomCacheBuildPromise;
}

/**
 * CompletionProvider for `room = xxx` contexts.
 * Provides names of DDS files in gfx/portraits/city_sets/.
 */
class RoomCompletionProvider implements vs.CompletionItemProvider {
    async provideCompletionItems(
        document: vs.TextDocument,
        position: vs.Position,
    ): Promise<vs.CompletionItem[] | null> {
        // Check if cursor is in a `room = ` context
        const lineText = document.lineAt(position).text;
        const textBefore = lineText.substring(0, position.character);
        if (!ROOM_ASSIGN_RE.test(textBefore)) return null;

        const rooms = await getRoomEntries();
        return rooms.map(r => {
            const item = new vs.CompletionItem(r.name, vs.CompletionItemKind.Value);
            item.detail = `Room: ${path.basename(r.uri.fsPath)}`;
            item.documentation = `gfx/portraits/city_sets/${path.basename(r.uri.fsPath)}`;
            return item;
        });
    }
}

/**
 * GoToDefinition for room names.
 * Ctrl+Click on a room name (in `room = xxx` context) → jump to the .dds file.
 * Verifies cursor is positioned on the VALUE side of `room = `, not elsewhere on the line.
 */
class RoomDefinitionProvider implements vs.DefinitionProvider {
    async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
        const lineText = document.lineAt(position).text;

        // Match `room = value` and verify cursor is on the value part
        const roomMatch = /\broom\s*=\s*["']?([A-Za-z0-9_]+)["']?/.exec(lineText);
        if (!roomMatch) return null;

        // Calculate the span of the value (group 1) within the line
        const fullMatchStart = roomMatch.index;
        const valueInFullMatch = roomMatch[0]!.indexOf(roomMatch[1]!);
        const valueStart = fullMatchStart + valueInFullMatch;
        const valueEnd = valueStart + roomMatch[1]!.length;

        // Only trigger if cursor is within the value span
        if (position.character < valueStart || position.character > valueEnd) return null;

        const word = roomMatch[1]!;
        const rooms = await getRoomEntries();
        const entry = rooms.find(r => r.name === word);
        if (!entry) return null;

        return new vs.Location(entry.uri, new vs.Position(0, 0));
    }
}

// ─── Path Resolution Helpers ───────────────────────────────────────────────

/**
 * Resolve an asset relative path to an absolute filesystem path.
 * Searches: workspace folders → document directory → vanilla game path.
 */
function resolveAssetPath(document: vs.TextDocument, relativePath: string): string | null {
    const normalized = relativePath.replace(/\//g, path.sep);

    // Search all roots (workspace + vanilla)
    for (const root of getSearchRoots()) {
        const full = path.join(root, normalized);
        if (fs.existsSync(full)) return full;
    }

    // Try relative to the document itself (for files outside workspace)
    const fromDoc = path.join(path.dirname(document.uri.fsPath), normalized);
    if (fs.existsSync(fromDoc)) return fromDoc;

    return null;
}

/**
 * Resolve an asset relative path without a document context.
 * Searches: workspace folders → vanilla game path.
 */
function resolveAssetPathRaw(relativePath: string): string | null {
    const normalized = relativePath.replace(/\//g, path.sep);
    for (const root of getSearchRoots()) {
        const full = path.join(root, normalized);
        if (fs.existsSync(full)) return full;
    }
    return null;
}

// ─── Shared Image Hover Helper ─────────────────────────────────────────────

/**
 * Create a Hover with decoded image preview for DDS/TGA/PNG files.
 * Shared by GfxHoverProvider and IconHoverProvider.
 */
function createImageHover(
    fullPath: string,
    displayPath: string,
    range: vs.Range,
    label?: string,
): vs.Hover | null {
    const ext = path.extname(fullPath).toLowerCase();
    let result = imageCache.get(fullPath);

    if (result === undefined) {
        if (ext === '.dds') {
            result = decodeDds(fullPath);
        } else if (ext === '.tga') {
            result = decodeTga(fullPath);
        } else if (ext === '.png') {
            const uri = vs.Uri.file(fullPath);
            const md = new vs.MarkdownString();
            md.isTrusted = true;
            if (label) md.appendMarkdown(`**${label}**\n\n`);
            md.appendMarkdown(`![preview](${uri.toString()}|width=300)\n\n`);
            md.appendMarkdown(`*${displayPath}*`);
            return new vs.Hover(md, range);
        } else {
            return null;
        }

        // Fix: VS Code Markdown crashes on very long data URIs (>~30KB) with size modifiers.
        // Save to OS temp directory and use a file:// URI instead.
        if (result && result.dataUri.startsWith('data:image/png;base64,')) {
            try {
                const base64Data = result.dataUri.split(',')[1];
                if (base64Data && base64Data.length > 50000) { // ~37KB decoded
                    const buffer = Buffer.from(base64Data, 'base64');
                    const hash = crypto.createHash('md5').update(fullPath).digest('hex');
                    const tempPath = path.join(os.tmpdir(), `cwt_prev_${hash}.png`);
                    if (!fs.existsSync(tempPath)) {
                        fs.writeFileSync(tempPath, buffer);
                    }
                    result.dataUri = vs.Uri.file(tempPath).toString();
                }
            } catch (e) {
                console.warn('Failed to cache large hover image to disk', e);
            }
        }

        imageCache.set(fullPath, result);
    }

    if (!result) return null;

    // Calculate a display width that prevents upscaling small icons, but caps large images
    const displayWidth = Math.min(result.width, 400);

    const md = new vs.MarkdownString();
    md.isTrusted = true;
    if (label) md.appendMarkdown(`**${label}** (${result.width}×${result.height})\n\n`);
    else md.appendMarkdown(`**${path.basename(fullPath)}** (${result.width}×${result.height})\n\n`);
    md.appendMarkdown(`![preview](${result.dataUri}|width=${displayWidth})\n\n`);
    md.appendMarkdown(`*${displayPath}*`);
    return new vs.Hover(md, range);
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Clean up old temporary preview images (older than 24 hours) from the OS temp directory
 * to prevent disk space bloating over time.
 */
function cleanupOldTempFiles() {
    try {
        const tmp = os.tmpdir();
        const files = fs.readdirSync(tmp);
        const now = Date.now();
        for (const file of files) {
            if (file.startsWith('cwt_prev_') && file.endsWith('.png')) {
                const fullPath = path.join(tmp, file);
                const stat = fs.statSync(fullPath);
                // Delete if older than 24 hours
                if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
                    fs.unlinkSync(fullPath);
                }
            }
        }
    } catch (e) {
        console.warn('Failed to cleanup old temp hover files', e);
    }
}

export function registerGraphicsFeatures(context: vs.ExtensionContext): void {
    // Run background cleanup 5 seconds after activation
    setTimeout(cleanupOldTempFiles, 5000);

    const gameLanguages = ['stellaris', 'hoi4', 'eu4', 'ck2', 'imperator', 'vic2', 'vic3', 'ck3', 'eu5', 'paradox'];
    const gfxSelector: vs.DocumentSelector = [
        ...gameLanguages.map(lang => ({ scheme: 'file', language: lang })),
        { scheme: 'file', pattern: '**/*.gfx' },
        { scheme: 'file', pattern: '**/*.gui' },
        { scheme: 'file', pattern: '**/*.asset' },
    ];

    // 1. DDS/TGA image hover preview (file paths)
    context.subscriptions.push(
        vs.languages.registerHoverProvider(gfxSelector, new ImageHoverProvider()),
    );

    // 2. GFX sprite GoToDefinition + hover image preview
    context.subscriptions.push(
        vs.languages.registerDefinitionProvider(gfxSelector, new GfxDefinitionProvider()),
        vs.languages.registerHoverProvider(gfxSelector, new GfxHoverProvider()),
    );

    // 3. Convention-based icon hover preview (buildings, techs, etc.)
    context.subscriptions.push(
        vs.languages.registerHoverProvider(gfxSelector, new IconHoverProvider()),
    );

    // 4. Room completion + definition
    context.subscriptions.push(
        vs.languages.registerCompletionItemProvider(gfxSelector, new RoomCompletionProvider()),
        vs.languages.registerDefinitionProvider(gfxSelector, new RoomDefinitionProvider()),
    );

    // File system watchers for incremental updates
    const gfxWatcher = vs.workspace.createFileSystemWatcher('**/*.gfx');
    context.subscriptions.push(gfxWatcher);
    gfxWatcher.onDidChange(() => { gfxIndexDirty = true; });
    gfxWatcher.onDidCreate(() => { gfxIndexDirty = true; });
    gfxWatcher.onDidDelete(() => { gfxIndexDirty = true; });

    const roomWatcher = vs.workspace.createFileSystemWatcher('**/gfx/portraits/city_sets/**/*.dds');
    context.subscriptions.push(roomWatcher);
    roomWatcher.onDidChange(() => { roomCacheDirty = true; });
    roomWatcher.onDidCreate(() => { roomCacheDirty = true; });
    roomWatcher.onDidDelete(() => { roomCacheDirty = true; });

    // Clear image cache when workspace changes significantly
    const textWatcher = vs.workspace.onDidSaveTextDocument(doc => {
        if (doc.fileName.endsWith('.gfx')) {
            gfxIndexDirty = true;
        }
    });
    context.subscriptions.push(textWatcher);
}
