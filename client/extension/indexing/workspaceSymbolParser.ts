import { matchPdxDefinitionType, type PdxDefinitionType } from '../../shared/pdxSemanticCatalog';

export type WorkspaceSymbolSource = 'script' | 'asset' | 'gui';
export type WorkspaceSymbolOrigin = 'workspace' | 'vanilla';

export interface WorkspaceSymbolEntry {
    name: string;
    kind: string;
    file: string;
    line: number;
    source: WorkspaceSymbolSource;
    container?: string;
    category?: string;
    origin?: WorkspaceSymbolOrigin;
    references?: WorkspaceSymbolReference[];
    guiFacts?: {
        offCanvas: boolean;
        position?: { x?: number; y?: number; expression?: string };
        localisationKeys: string[];
        customGuiReferences: string[];
        effectReferences: string[];
        spriteReferences: string[];
    };
    scriptFacts?: {
        stateAccesses: Array<{ operation: 'read' | 'set' | 'write' | 'clear' | 'save'; subject: string; scope: string; line: number }>;
        localisationKeys: string[];
        eventReferences: string[];
        callCandidates: string[];
    };
    updatedAt?: number;
    fileVersion?: number;
}

export interface WorkspaceSymbolReference {
    file: string;
    line: number;
    context: string;
    /** Parsed property/target for asset and GUI relationships. */
    property?: string;
    target?: string;
}

export interface WorkspaceSymbolQuery {
    name?: string;
    kind?: string;
    category?: string;
    source?: WorkspaceSymbolSource;
    origin?: WorkspaceSymbolOrigin | 'both';
    directory?: string;
    prefix?: boolean;
    exact?: boolean;
    includeReferences?: boolean;
    limit?: number;
}

export interface WorkspaceSymbolParseOptions {
    updatedAt?: number;
    fileVersion?: number;
    origin?: WorkspaceSymbolOrigin;
    maxReferencesPerSymbol?: number;
    /** Active CWTools TypeDefs supplied by the LSP semantic catalog. */
    definitionTypes?: readonly PdxDefinitionType[];
}

interface OpenBlock {
    name: string;
    kind: string;
    source: WorkspaceSymbolSource;
    references?: WorkspaceSymbolReference[];
    entry?: WorkspaceSymbolEntry;
    nameField?: string;
    category?: string;
}

const SCRIPT_EXTENSIONS = new Set(['.txt']);
const NAMED_BLOCK_EXTENSIONS = new Set(['.gfx', '.asset', '.gui']);

export function isWorkspaceSymbolFile(filePath: string): boolean {
    const ext = getExtension(filePath);
    return SCRIPT_EXTENSIONS.has(ext) || NAMED_BLOCK_EXTENSIONS.has(ext);
}

export function parseWorkspaceSymbols(
    content: string,
    filePath: string,
    options: WorkspaceSymbolParseOptions = {}
): WorkspaceSymbolEntry[] {
    const ext = getExtension(filePath);
    let entries: WorkspaceSymbolEntry[];
    if (SCRIPT_EXTENSIONS.has(ext)) {
        entries = parseScriptSymbols(content, filePath, options.definitionTypes ?? []);
    } else if (NAMED_BLOCK_EXTENSIONS.has(ext)) {
        entries = parseNamedBlockSymbols(
            content,
            filePath,
            ext === '.gui' ? 'gui' : 'asset',
            options.maxReferencesPerSymbol !== 0,
            options.definitionTypes ?? [],
        );
    } else {
        return [];
    }
    applyEntryMetadata(entries, options);
    if (options.maxReferencesPerSymbol === 0) {
        for (const entry of entries) entry.references = undefined;
    } else {
        attachReferences(entries, content, filePath, options.maxReferencesPerSymbol ?? 20);
    }
    return entries;
}

export function addSymbolsToIndex(
    index: Map<string, WorkspaceSymbolEntry[]>,
    entries: WorkspaceSymbolEntry[]
): void {
    for (const entry of entries) {
        const key = entry.name.toLowerCase();
        const bucket = index.get(key) ?? [];
        bucket.push(entry);
        index.set(key, bucket);
    }
}

export function sortedWorkspaceSymbolNames(index: Map<string, WorkspaceSymbolEntry[]>): string[] {
    return Array.from(index.keys()).sort((a, b) => a.localeCompare(b));
}

export function removeFileFromSymbolIndex(index: Map<string, WorkspaceSymbolEntry[]>, filePath: string): void {
    const normalizedFile = normalizePath(filePath);
    for (const [name, entries] of index.entries()) {
        const remaining = entries.filter(entry => normalizePath(entry.file) !== normalizedFile);
        if (remaining.length > 0) {
            index.set(name, remaining);
        } else {
            index.delete(name);
        }
    }
}

export function queryWorkspaceSymbolIndex(
    index: Map<string, WorkspaceSymbolEntry[]>,
    query: WorkspaceSymbolQuery,
    sortedNames?: readonly string[],
): WorkspaceSymbolEntry[] {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 50) || 50, 200));
    const name = (query.name ?? '').trim();
    const kind = (query.kind ?? '').trim().toLowerCase();
    const category = (query.category ?? '').trim().toLowerCase();
    const source = query.source;
    const origin = query.origin && query.origin !== 'both' ? query.origin : undefined;
    const directory = query.directory ? normalizePath(query.directory).toLowerCase().replace(/^\/+|\/+$/g, '') : '';

    const nameLower = name.toLowerCase();
    const results: WorkspaceSymbolEntry[] = [];

    let buckets: Iterable<WorkspaceSymbolEntry[]>;
    if (name && query.exact) {
        buckets = [index.get(nameLower) ?? []];
    } else if (nameLower && query.prefix) {
        const names = sortedNames ?? sortedWorkspaceSymbolNames(index);
        const start = lowerBound(names, nameLower);
        const prefixBuckets: WorkspaceSymbolEntry[][] = [];
        for (let i = start; i < names.length; i++) {
            const key = names[i]!;
            if (!key.startsWith(nameLower)) break;
            const bucket = index.get(key);
            if (bucket) prefixBuckets.push(bucket);
        }
        buckets = prefixBuckets;
    } else {
        buckets = index.values();
    }

    for (const entries of buckets) {
        for (const entry of entries) {
            if (nameLower) {
                const entryName = entry.name.toLowerCase();
                if (query.exact && entryName !== nameLower) continue;
                if (query.prefix && !entryName.startsWith(nameLower)) continue;
                if (!query.exact && !query.prefix && !entryName.includes(nameLower)) continue;
            }
            if (kind && entry.kind.toLowerCase() !== kind) continue;
            if (category && (entry.category ?? '').toLowerCase() !== category) continue;
            if (source && entry.source !== source) continue;
            if (origin && (entry.origin ?? 'workspace') !== origin) continue;
            if (directory && !normalizePath(entry.file).toLowerCase().includes(`/${directory}/`)) continue;
            results.push(query.includeReferences ? entry : { ...entry, references: undefined });
            if (results.length >= limit) return results;
        }
    }

    return results;
}

/** Count matching symbol rows without allocating an unbounded result array. */
export function countWorkspaceSymbolIndex(
    index: Map<string, WorkspaceSymbolEntry[]>,
    query: WorkspaceSymbolQuery,
): number {
    const name = (query.name ?? '').trim().toLowerCase();
    const kind = (query.kind ?? '').trim().toLowerCase();
    const category = (query.category ?? '').trim().toLowerCase();
    const origin = query.origin && query.origin !== 'both' ? query.origin : undefined;
    const directory = query.directory ? normalizePath(query.directory).toLowerCase().replace(/^\/+|\/+$/g, '') : '';
    let count = 0;
    for (const entries of index.values()) for (const entry of entries) {
        const entryName = entry.name.toLowerCase();
        if (name && (query.exact ? entryName !== name : query.prefix ? !entryName.startsWith(name) : !entryName.includes(name))) continue;
        if (kind && entry.kind.toLowerCase() !== kind) continue;
        if (category && (entry.category ?? '').toLowerCase() !== category) continue;
        if (query.source && entry.source !== query.source) continue;
        if (origin && (entry.origin ?? 'workspace') !== origin) continue;
        if (directory && !normalizePath(entry.file).toLowerCase().includes(`/${directory}/`)) continue;
        count++;
    }
    return count;
}

export function populateWorkspaceSymbolReferences(
    entries: WorkspaceSymbolEntry[],
    fileContents: Map<string, string>,
    maxReferencesPerSymbol = 20,
): void {
    if (maxReferencesPerSymbol <= 0 || entries.length === 0 || fileContents.size === 0) return;
    for (const entry of entries) {
        entry.references = mergeReferences(
            entry.references,
            collectReferencesForEntry(entry, fileContents, maxReferencesPerSymbol),
            maxReferencesPerSymbol,
        );
    }
}

function applyEntryMetadata(entries: WorkspaceSymbolEntry[], options: WorkspaceSymbolParseOptions): void {
    if (options.updatedAt === undefined && options.fileVersion === undefined && options.origin === undefined) return;
    for (const entry of entries) {
        if (options.updatedAt !== undefined) entry.updatedAt = options.updatedAt;
        if (options.fileVersion !== undefined) entry.fileVersion = options.fileVersion;
        if (options.origin !== undefined) entry.origin = options.origin;
    }
}

export function rebuildWorkspaceSymbolReferences(
    index: Map<string, WorkspaceSymbolEntry[]>,
    fileContents: Map<string, string>,
    maxReferencesPerSymbol = 20
): void {
    if (maxReferencesPerSymbol <= 0) return;
    for (const entries of index.values()) {
        for (const entry of entries) {
            entry.references = mergeReferences(
                entry.references,
                collectReferencesForEntry(entry, fileContents, maxReferencesPerSymbol),
                maxReferencesPerSymbol
            );
        }
    }
}

function attachReferences(
    entries: WorkspaceSymbolEntry[],
    content: string,
    filePath: string,
    maxReferencesPerSymbol: number
): void {
    if (entries.length === 0 || maxReferencesPerSymbol <= 0) return;
    const fileContents = new Map<string, string>([[filePath, content]]);
    for (const entry of entries) {
        const refs = collectReferencesForEntry(entry, fileContents, maxReferencesPerSymbol);
        entry.references = mergeReferences(entry.references, refs, maxReferencesPerSymbol);
    }
}

function mergeReferences(
    existing: WorkspaceSymbolReference[] | undefined,
    additions: WorkspaceSymbolReference[],
    maxReferences: number
): WorkspaceSymbolReference[] | undefined {
    const merged: WorkspaceSymbolReference[] = [];
    const seen = new Set<string>();
    for (const ref of [...(existing ?? []), ...additions]) {
        const key = `${normalizePath(ref.file)}:${ref.line}:${ref.context}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(ref);
        if (merged.length >= maxReferences) break;
    }
    return merged.length > 0 ? merged : undefined;
}

function collectReferencesForEntry(
    entry: WorkspaceSymbolEntry,
    fileContents: Map<string, string>,
    maxReferencesPerSymbol: number
): WorkspaceSymbolReference[] {
    const refs: WorkspaceSymbolReference[] = [];
    if (maxReferencesPerSymbol <= 0) return refs;
    const definitionFile = normalizePath(entry.file);
    const pattern = buildIdentifierRegex(entry.name);
    for (const [filePath, content] of fileContents.entries()) {
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && refs.length < maxReferencesPerSymbol; i++) {
            if (normalizePath(filePath) === definitionFile && i + 1 === entry.line) continue;
            const stripped = stripComment(lines[i] ?? '');
            pattern.lastIndex = 0;
            if (!pattern.test(stripped)) continue;
            refs.push({
                file: filePath,
                line: i + 1,
                context: stripped.trim().slice(0, 240),
            });
        }
        if (refs.length >= maxReferencesPerSymbol) break;
    }
    return refs;
}

function buildIdentifierRegex(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_.:-])${escaped}([^A-Za-z0-9_.:-]|$)`, 'i');
}

function lowerBound(values: readonly string[], target: string): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + ((high - low) >> 1);
        if (values[middle]!.localeCompare(target) < 0) low = middle + 1;
        else high = middle;
    }
    return low;
}

function parseScriptSymbols(
    content: string,
    filePath: string,
    definitionTypes: readonly PdxDefinitionType[],
): WorkspaceSymbolEntry[] {
    const entries: WorkspaceSymbolEntry[] = [];
    const lines = content.split(/\r?\n/);
    let depth = 0;
    let openBlock: OpenBlock | undefined;
    const normalizedFile = normalizePath(filePath);
    const updateScriptFacts = (entry: WorkspaceSymbolEntry | undefined, rawLine: string, lineNumber: number): void => {
        if (!entry) return;
        const facts = entry.scriptFacts ?? { stateAccesses: [], localisationKeys: [], eventReferences: [], callCandidates: [] };
        const assignment = /^\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(.*)$/.exec(rawLine);
        const key = assignment?.[1]?.toLowerCase();
        const rhs = assignment?.[2] ?? '';
        if (key) {
            let operation: 'read' | 'set' | 'write' | 'clear' | 'save' | undefined;
            if (key.startsWith('save_') && key.includes('event_target')) operation = 'save';
            else if (key.startsWith('set_') && (key.includes('variable') || key.endsWith('_flag'))) operation = 'set';
            else if (key.startsWith('change_') && key.includes('variable')) operation = 'write';
            else if ((key.startsWith('remove_') || key.startsWith('clear_')) && /(variable|flag|event_target)/.test(key)) operation = 'clear';
            else if ((key.startsWith('has_') || key.startsWith('check_') || key.startsWith('is_')) && /(variable|flag|event_target)/.test(key)) operation = 'read';
            if (operation) {
                const subject = /\b(?:which|name|flag|id|target)\s*=\s*"?([A-Za-z_][A-Za-z0-9_.:@$-]*)"?/i.exec(rhs)?.[1]
                    ?? /^"?([A-Za-z_][A-Za-z0-9_.:@$-]*)"?/.exec(rhs.trim())?.[1];
                if (subject && facts.stateAccesses.length < 40
                    && !facts.stateAccesses.some(item => item.operation === operation && item.subject === subject && item.line === lineNumber)) {
                    const scope = key.includes('global_event_target') ? 'global'
                        : key.includes('event_target') ? 'local_event'
                            : ['country', 'planet', 'fleet', 'ship', 'system'].find(candidate => key.includes(candidate)) ?? 'current_scope';
                    facts.stateAccesses.push({ operation, subject, scope, line: lineNumber });
                }
            }
            if (/^(?:title|desc|text|tooltip|name|custom_tooltip)$/.test(key)) {
                const loc = /^"?([A-Za-z_][A-Za-z0-9_.:@$-]*)"?/.exec(rhs.trim())?.[1];
                if (loc && !facts.localisationKeys.includes(loc) && facts.localisationKeys.length < 40) facts.localisationKeys.push(loc);
            }
            const eventTarget = key.endsWith('_event') || key === 'fire_on_action'
                ? /\bid\s*=\s*"?([A-Za-z_][A-Za-z0-9_.:@$-]*)"?/i.exec(rhs)?.[1]
                    ?? /^"?([A-Za-z_][A-Za-z0-9_.:@$-]*)"?/.exec(rhs.trim())?.[1]
                : undefined;
            if (eventTarget && !facts.eventReferences.includes(eventTarget) && facts.eventReferences.length < 40) facts.eventReferences.push(eventTarget);
            const genericFields = new Set(['id', 'key', 'name', 'title', 'desc', 'text', 'tooltip', 'trigger', 'limit', 'effect', 'if', 'else', 'else_if', 'random', 'random_list']);
            if (!operation && !key.endsWith('_event') && !genericFields.has(key)
                && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(key)
                && !facts.callCandidates.includes(key) && facts.callCandidates.length < 60) facts.callCandidates.push(key);
        }
        entry.scriptFacts = facts;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i] ?? '');
        const beforeDepth = depth;

        const namespaceMatch = beforeDepth === 0
            ? line.match(/^\s*namespace\s*=\s*"?([A-Za-z0-9_.:-]+)"?/)
            : null;
        if (namespaceMatch?.[1]) {
            entries.push({
                name: namespaceMatch[1],
                kind: 'namespace',
                file: filePath,
                line: i + 1,
                source: 'script',
            });
        }

        const topBlockMatch = beforeDepth === 0
            ? line.match(/^\s*([A-Za-z0-9_.:-]+)\s*=\s*\{/)
            : null;
        if (topBlockMatch?.[1]) {
            const blockName = topBlockMatch[1];
            const classification = inferScriptClassification(normalizedFile, blockName, definitionTypes);
            const kind = classification.kind;
            openBlock = {
                name: blockName,
                kind,
                source: 'script',
                nameField: classification.nameField,
                category: classification.category,
            };
            if (!classification.nameField) {
                const entry: WorkspaceSymbolEntry = {
                    name: blockName,
                    kind,
                    file: filePath,
                    line: i + 1,
                    source: 'script',
                    category: classification.category,
                };
                entries.push(entry);
                openBlock.entry = entry;
            }
        } else if (openBlock?.nameField && beforeDepth === 1) {
            const escapedField = openBlock.nameField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const identityMatch = line.match(new RegExp(`^\\s*${escapedField}\\s*=\\s*"?([A-Za-z0-9_.:-]+)"?`, 'i'));
            if (identityMatch?.[1]) {
                const entry: WorkspaceSymbolEntry = {
                    name: identityMatch[1],
                    kind: openBlock.kind,
                    file: filePath,
                    line: i + 1,
                    source: 'script',
                    container: openBlock.name,
                    category: openBlock.category,
                };
                entries.push(entry);
                openBlock.entry = entry;
            }
        }

        updateScriptFacts(openBlock?.entry, line, i + 1);

        depth += countBracesOutsideStrings(line);
        if (openBlock && depth <= 0) {
            openBlock = undefined;
            depth = Math.max(0, depth);
        }
    }

    return entries;
}

function parseNamedBlockSymbols(
    content: string,
    filePath: string,
    source: WorkspaceSymbolSource,
    collectPropertyReferences: boolean,
    definitionTypes: readonly PdxDefinitionType[],
): WorkspaceSymbolEntry[] {
    const entries: WorkspaceSymbolEntry[] = [];
    const lines = content.split(/\r?\n/);
    // A stack of open named blocks. Each frame remembers its block metadata,
    // the depth at which it opened, and whether a name was already emitted.
    const blockStack: Array<{
        block: OpenBlock;
        openDepth: number;
        named: boolean;
    }> = [];
    const normalizedFile = normalizePath(filePath);

    const updateGuiFacts = (entry: WorkspaceSymbolEntry | undefined, rawLine: string): void => {
        if (!entry || source !== 'gui') return;
        const facts = entry.guiFacts ?? {
            offCanvas: false,
            localisationKeys: [],
            customGuiReferences: [],
            effectReferences: [],
            spriteReferences: [],
        };
        const position = /\bposition\s*=\s*(?:\{[^}]*\bx\s*=\s*(-?\d+)[^}]*\by\s*=\s*(-?\d+)[^}]*\}|([@A-Za-z_][A-Za-z0-9_@.-]*))/i.exec(rawLine);
        if (position) {
            const x = position[1] === undefined ? undefined : Number(position[1]);
            const y = position[2] === undefined ? undefined : Number(position[2]);
            const expression = position[3];
            facts.position = { x, y, expression };
            facts.offCanvas = (!!x && Math.abs(x) > 5000) || (!!y && Math.abs(y) > 5000)
                || !!expression && /invisible|off.?canvas|hidden/i.test(expression);
        }
        for (const match of rawLine.matchAll(/\b(?:text|title|desc|tooltip|buttonText|buttonTooltip)\s*=\s*"?([A-Za-z_][A-Za-z0-9_.:@$-]*)"?/gi)) {
            if (match[1] && !facts.localisationKeys.includes(match[1])) facts.localisationKeys.push(match[1]);
        }
        for (const [pattern, target] of [
            [/\bcustom_gui\s*=\s*"?([A-Za-z_][A-Za-z0-9_.:@-]*)"?/gi, facts.customGuiReferences],
            [/\beffect\s*=\s*"?([A-Za-z_][A-Za-z0-9_.:@-]*)"?/gi, facts.effectReferences],
            [/\b(?:sprite|quadTextureSprite)\s*=\s*"?([A-Za-z_][A-Za-z0-9_.:@-]*)"?/gi, facts.spriteReferences],
        ] as Array<[RegExp, string[]]>) {
            for (const match of rawLine.matchAll(pattern)) if (match[1] && !target.includes(match[1])) target.push(match[1]);
        }
        entry.guiFacts = facts;
    };

    const addEntry = (block: OpenBlock, rawName: string, line: number): void => {
        const entry: WorkspaceSymbolEntry = {
            name: rawName,
            kind: block.kind,
            file: filePath,
            line,
            source,
            container: block.name,
            category: source === 'gui' ? 'gui' : 'asset',
            references: block.references?.slice(0, 12),
        };
        block.entry = entry;
        updateGuiFacts(entry, '');
        entries.push(entry);
    };

    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i] ?? '');
        const beforeDepth = depth;

        // Nested named control: any `name = {` (or typed `nameField = {`) at any
        // depth inside a gui/asset file opens a new block frame. GUI controls
        // are recursive (containers nest), so this must not stop at depth 1.
        const blockMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*\{/);
        if (blockMatch?.[1]) {
            const blockName = blockMatch[1];
            const definition = matchPdxDefinitionType(definitionTypes, normalizedFile, blockName);
            const nameField = definition?.nameField ?? 'name';
            const isTypedContainer = source === 'gui'
                ? isGuiContainerBlock(blockName)
                : isAssetContainerBlock(blockName);
            // Heuristic: a block whose own key looks like a definition name
            // (e.g. `kuat_icon = { type = iconType ... }`) is a nested control
            // even without a TypeDef; skip pure field wrappers.
            const looksNamed = blockName.endsWith('Type')
                || /^[a-z0-9_]+$/.test(blockName) && !isFieldWrapperKey(blockName);
            const opensIndexableBlock = isTypedContainer || looksNamed;
            if (opensIndexableBlock) {
                const kind = definition?.name
                    ?? (source === 'gui' && (blockName === 'effectButtonType' || blockName === 'effectButton' || blockName === 'buttonType')
                        ? 'effectButtonType'
                        : source === 'gui' ? inferGuiKind(blockName) : inferAssetKind(blockName));
                blockStack.push({
                    block: {
                        name: blockName,
                        kind,
                        source,
                        references: [],
                        nameField,
                    },
                    openDepth: beforeDepth,
                    named: false,
                });
                const inlineContent = line.slice(blockMatch[0].length);
                const inlineName = findScalarAssignment(inlineContent, nameField);
                if (inlineName && blockStack.length > 0) {
                    addEntry(blockStack[blockStack.length - 1]!.block, inlineName, i + 1);
                    blockStack[blockStack.length - 1]!.named = true;
                    // Single-line nested effectButtonType keeps its effect and
                    // sprite references even when everything sits on one line.
                    const inlineButton = source === 'gui'
                        ? parseGuiEffectButton(inlineContent, blockName)
                        : undefined;
                    const inlineEntry = blockStack[blockStack.length - 1]!.block.entry;
                    if (inlineButton && inlineEntry) {
                        inlineEntry.references = [
                            { file: filePath, line: i + 1, context: `effect = ${inlineButton.effect}`, property: 'effect', target: inlineButton.effect },
                            ...(inlineButton.sprite ? [{ file: filePath, line: i + 1, context: `sprite = ${inlineButton.sprite}`, property: 'sprite', target: inlineButton.sprite }] : []),
                        ];
                    }
                    updateGuiFacts(inlineEntry, inlineContent);
                }
            } else if (blockStack.length > 0) {
                // Field wrappers such as `position = { ... }` belong to the
                // nearest named control; they are not nested GUI definitions.
                updateGuiFacts(blockStack[blockStack.length - 1]!.block.entry, line);
            }
        } else if (blockStack.length > 0) {
            const top = blockStack[blockStack.length - 1]!;
            const assetRef = collectPropertyReferences ? toAssetPropertyReference(line, filePath, i + 1) : undefined;
            if (assetRef && top.block.references) {
                top.block.references.push(assetRef);
                if (top.block.entry) {
                    top.block.entry.references = top.block.references.slice(0, 12);
                }
            }
            updateGuiFacts(top.block.entry, line);
            // Single-line nested effectButtonType keeps its identity:
            // `effectButtonType = { name = btn_x effect = button_effect_x sprite = GFX_x }`
            const effectButton = source === 'gui' ? parseGuiEffectButton(line, top.block.name) : undefined;
            if (effectButton) {
                top.block.entry = {
                    name: effectButton.name,
                    kind: 'effectButtonType',
                    file: filePath,
                    line: i + 1,
                    source: 'gui',
                    container: top.block.name,
                    category: 'gui',
                    references: [
                        { file: filePath, line: i + 1, context: `effect = ${effectButton.effect}`, property: 'effect', target: effectButton.effect },
                        ...(effectButton.sprite ? [{ file: filePath, line: i + 1, context: `sprite = ${effectButton.sprite}`, property: 'sprite', target: effectButton.sprite }] : []),
                    ],
                };
                entries.push(top.block.entry);
                updateGuiFacts(top.block.entry, line);
                top.named = true;
            } else {
                const rawName = findScalarAssignment(line, top.block.nameField ?? 'name');
                if (rawName && !top.named) {
                    addEntry(top.block, rawName, i + 1);
                    top.named = true;
                }
            }
        }

        depth += countBracesOutsideStrings(line);
        // Close every frame whose block ended on this line.
        while (blockStack.length > 0 && depth <= blockStack[blockStack.length - 1]!.openDepth) {
            blockStack.pop();
        }
        depth = Math.max(0, depth);
    }

    return entries;
}

/** GUI container blocks that may hold nested named controls. */
function isGuiContainerBlock(blockName: string): boolean {
    return blockName.endsWith('Type') || blockName === 'container' || blockName === 'listbox';
}

/** Asset container blocks that may hold nested named entries. */
function isAssetContainerBlock(blockName: string): boolean {
    return blockName === 'entity' || blockName === 'pdxmesh' || blockName === 'animation';
}

/** Field-wrapper keys that are not themselves named definitions. */
function isFieldWrapperKey(blockName: string): boolean {
    return ['trigger', 'effect', 'name', 'icon', 'background', 'text', 'format', 'size', 'position', 'border', 'sprite', 'quadTextureSprite'].includes(blockName);
}

interface GuiEffectButtonInfo {
    name: string;
    effect: string;
    sprite?: string;
}

/** Parse a single-line effect button, including Stellaris' quadTextureSprite form. */
function parseGuiEffectButton(line: string, blockName: string): GuiEffectButtonInfo | undefined {
    if (blockName !== 'effectButtonType' && blockName !== 'buttonType' && blockName !== 'effectButton') return undefined;
    const name = findScalarAssignment(line, 'name');
    const effect = findScalarAssignment(line, 'effect');
    if (!name || !effect) return undefined;
    const sprite = findScalarAssignment(line, 'sprite') ?? findScalarAssignment(line, 'quadTextureSprite');
    return { name, effect, sprite };
}

function findScalarAssignment(line: string, fieldName: string): string | undefined {
    const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(
        `(?:^|[\\s{])${escapedField}\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|([^\\s{}#]+))`,
        'i',
    ).exec(line);
    const value = (match?.[1] ?? match?.[2])?.trim();
    return value || undefined;
}

function toAssetPropertyReference(line: string, filePath: string, lineNumber: number): WorkspaceSymbolReference | undefined {
    const match = /^\s*(texturefile|file|files?|mesh|animation|material|shader|entity|sound|effect|sprite|quadTextureSprite|noOfFrames)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s{}#]+))/i.exec(line);
    if (!match?.[1]) return undefined;
    return {
        file: filePath,
        line: lineNumber,
        context: line.trim().slice(0, 240),
        property: match[1].toLowerCase(),
        target: (match[2] ?? match[3] ?? '').trim(),
    };
}

function inferScriptClassification(
    normalizedFile: string,
    blockName: string,
    definitionTypes: readonly PdxDefinitionType[],
): { kind: string; category: string; nameField?: string } {
    const definition = matchPdxDefinitionType(definitionTypes, normalizedFile, blockName);
    if (definition) {
        return { kind: definition.name, category: 'game_entity', nameField: definition.nameField };
    }
    return { kind: 'pdx_block', category: 'script' };
}

function inferAssetKind(blockName: string): string {
    switch (blockName) {
        case 'spriteType':
        case 'corneredTileSpriteType':
            return 'sprite';
        case 'sound':
        case 'music':
            return 'sound';
        case 'entity':
        case 'pdxmesh':
        case 'animation':
            return 'asset';
        default:
            return blockName;
    }
}

function inferGuiKind(blockName: string): string {
    if (blockName.endsWith('Type')) return 'gui';
    return blockName;
}

function getExtension(filePath: string): string {
    const match = filePath.toLowerCase().match(/\.[^.\\/]+$/);
    return match?.[0] ?? '';
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function stripComment(line: string): string {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== '\\') {
            inString = !inString;
        }
        if (ch === '#' && !inString) {
            return line.slice(0, i);
        }
    }
    return line;
}

function countBracesOutsideStrings(line: string): number {
    let delta = 0;
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== '\\') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') delta++;
        if (ch === '}') delta--;
    }
    return delta;
}
