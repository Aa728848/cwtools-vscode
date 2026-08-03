import * as fs from 'fs';
import * as path from 'path';
import { scanScopeContracts, type ScopeContractReport } from './scope-contracts';

// Visual comparison report: fresh game script_documentation + vanilla common
// versus the rules config baseline (config/logs/* + CWT files).
// Read-only: never writes into the config; emits a self-contained HTML report.

export type RuleKind = 'effect' | 'trigger' | 'modifier' | 'scope' | 'localisation_command';

export interface DocRule {
    name: string;
    kind: RuleKind;
    scopes: string[];
    targetScopes: string[];
    category?: string;
    description: string;
    source: string;
    sourceLine: number;
}

export interface DiffChange {
    field: string;
    before: string;
    after: string;
}

export interface DiffEntry {
    name: string;
    description: string;
    scopes: string[];
    targetScopes: string[];
    category?: string;
    source: string;
    sourceLine: number;
    inCwt?: boolean;
    changes?: DiffChange[];
}

export interface KindDiff {
    kind: RuleKind;
    added: DiffEntry[];
    removed: DiffEntry[];
    changed: DiffEntry[];
    /** Generated-modifier families excluded from added/removed. */
    excluded?: ExcludedFamily[];
}

interface ExcludedFamily {
    template: string;
    count: number;
    example: string;
}

interface FieldFinding {
    field: string;
    count: number;
    example: string;
    exampleLine: number;
}

interface FolderFieldReport {
    folder: string;
    covered: boolean;
    cwtFiles: string[];
    definitionCount: number;
    newFields: FieldFinding[];
    maybeCovered: FieldFinding[];
    omittedNewFields?: number;
    /** Vanilla definitions missing a ## type_key_filter subtype (on_actions/game_rules). */
    missingSubtypes?: string[];
    /** cwt subtypes whose key no longer exists in vanilla (removed or renamed). */
    staleSubtypes?: Array<{ name: string; renameTo?: string }>;
}

interface ShaderAbiMergeInfo {
    fromVersion: string;
    toVersion: string;
    executableChanged: boolean;
    declarations: number;
    uniqueNames: number;
    carried: string[];
    added: string[];
    dropped: Array<{ name: string; shader_file?: string; reason: string }>;
    contractsKept: number;
    contractsSkipped: boolean;
    contractsDropped: Array<{ renderer_subtype?: string; shader_file?: string; reason: string }>;
    asciiHits: number;
    utf16Hits: number;
}

interface ReportData {
    generatedAt: string;
    gameVersion: string;
    docsDir: string;
    docsNewestMtime: string;
    baselineDir: string;
    configDir: string;
    vanillaCommonDir: string;
    diffs: KindDiff[];
    folders: FolderFieldReport[];
    scopeContracts: ScopeContractReport;
    shaderAbi: ShaderAbiMergeInfo | null;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_\\.\\-]*';
const TOP_LEVEL_PDX_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(=|==)\s*/;
const SCRIPT_COMMON_CONTENT_FOLDERS = new Set([
    'scripted_effects',
    'scripted_triggers',
    'scripted_modifiers',
    'scripted_variables',
    'script_values',
    'static_modifiers',
    'inline_scripts',
    'random_names',
    'name_lists',
]);
const KIND_LABELS: Record<RuleKind, string> = {
    trigger: '触发器 Triggers',
    effect: '效果 Effects',
    modifier: '修正 Modifiers',
    scope: '作用域 Scopes',
    localisation_command: '本地化命令 Loc Commands',
};
// Fields handled natively by the CWTools engine; they never appear as keys in
// the rules config, so reporting them as uncovered would always be noise.
// root/from/prev/this chains are engine scope navigation keys.
const ENGINE_FIELDS = new Set([
    'inline_script',
    'root', 'this', 'from', 'fromfrom', 'fromfromfrom', 'fromfromfromfrom',
    'prev', 'prevprev', 'prevprevprev', 'prevprevprevprev',
]);
// Folders with more new fields than this are treated as dynamic-content keys
// (e.g. diplo_phrases, species_names); only the top entries are listed.
const DYNAMIC_FIELD_LIMIT = 80;
const DYNAMIC_FIELD_KEEP = 40;
// Folders whose validation is built into CWTools and whose CWT files exist to
// enumerate vanilla definitions as completion subtypes (## type_key_filter).
// Field keys are not checked; instead vanilla definitions missing a subtype
// entry are reported.
const ENUMERATED_SUBTYPE_FOLDERS = new Set(['on_actions', 'game_rules']);

function readText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

function walkFiles(inputPath: string, predicate: (filePath: string) => boolean): string[] {
    if (!fs.existsSync(inputPath)) return [];
    const stat = fs.statSync(inputPath);
    if (stat.isFile()) return predicate(inputPath) ? [inputPath] : [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
        const fullPath = path.join(inputPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name.toLowerCase() !== '.git') results.push(...walkFiles(fullPath, predicate));
        } else if (predicate(fullPath)) {
            results.push(fullPath);
        }
    }
    return results;
}

function splitScopes(value: string): string[] {
    return value.trim().split(/\s+/).filter(Boolean);
}

function stripLineComment(line: string): string {
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = undefined;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '#') return line.slice(0, i);
    }
    return line;
}

function countBraceDelta(line: string): number {
    const stripped = stripLineComment(line);
    let quote: string | undefined;
    let delta = 0;
    for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i]!;
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = undefined;
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{') delta++;
        else if (ch === '}') delta--;
    }
    return delta;
}

// ---------- script_documentation parsing (same formats as parse-log.ts) ----------

function addDocRule(map: Map<string, DocRule>, rule: DocRule) {
    const key = `${rule.kind}:${rule.name.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
        map.set(key, rule);
        return;
    }
    existing.scopes = Array.from(new Set([...existing.scopes, ...rule.scopes]));
    existing.targetScopes = Array.from(new Set([...existing.targetScopes, ...rule.targetScopes]));
    if (!existing.description && rule.description) existing.description = rule.description;
    if (!existing.category && rule.category) existing.category = rule.category;
}

function parseScriptDocSections(filePath: string, lines: string[], map: Map<string, DocRule>, kind: Extract<RuleKind, 'effect' | 'trigger'>, titlePattern: RegExp) {
    const source = path.basename(filePath);
    for (let titleLine = 0; titleLine < lines.length; titleLine++) {
        if (!titlePattern.test(lines[titleLine] ?? '')) continue;
        const endLine = findNextDocumentationHeader(lines, titleLine + 1);
        for (let i = titleLine + 1; i < endLine; i++) {
            const line = lines[i] ?? '';
            const nameMatch = line.match(new RegExp(`^(${IDENT})\\s+-\\s+(.+)$`));
            if (!nameMatch) continue;
            let supportedScopes: string[] = [];
            let j = i + 1;
            while (j < endLine && !(lines[j] ?? '').match(new RegExp(`^(${IDENT})\\s+-\\s+`))) {
                const scopeMatch = (lines[j] ?? '').match(/^Supported Scopes:\s*(.+)$/i);
                if (scopeMatch) supportedScopes = splitScopes(scopeMatch[1]!);
                j++;
            }
            addDocRule(map, {
                name: nameMatch[1]!,
                kind,
                scopes: supportedScopes,
                targetScopes: [],
                description: nameMatch[2]!.trim(),
                source,
                sourceLine: i + 1,
            });
            i = j - 1;
        }
    }
}

function findNextDocumentationHeader(lines: string[], start: number): number {
    for (let i = start; i < lines.length; i++) {
        if (/==\s*[A-Z_ ]+\s+DOCUMENTATION\s*==/i.test(lines[i] ?? '')) return i;
    }
    return lines.length;
}

function parseModifiers(filePath: string, lines: string[], map: Map<string, DocRule>) {
    const source = path.basename(filePath);
    for (let i = 0; i < lines.length; i++) {
        const match = (lines[i] ?? '').match(new RegExp(`^-\\s+(${IDENT}),\\s+Category:\\s+(.+)$`, 'i'));
        if (!match) continue;
        addDocRule(map, {
            name: match[1]!,
            kind: 'modifier',
            scopes: [],
            targetScopes: [],
            category: match[2]!.trim(),
            description: '',
            source,
            sourceLine: i + 1,
        });
    }
}

function parseScopes(filePath: string, lines: string[], map: Map<string, DocRule>) {
    const source = path.basename(filePath);
    const titleLine = lines.findIndex(line => /SCOPE DOCUMENTATION/i.test(line));
    if (titleLine < 0) return;
    for (let i = titleLine + 1; i < lines.length; i++) {
        const nameMatch = (lines[i] ?? '').match(new RegExp(`^(${IDENT})\\s+-\\s+(.+)$`));
        if (!nameMatch) continue;
        let supportedScopes: string[] = [];
        let outputScope = '';
        let j = i + 1;
        while (j < lines.length && !(lines[j] ?? '').match(new RegExp(`^(${IDENT})\\s+-\\s+`))) {
            const inner = lines[j] ?? '';
            const scopeMatch = inner.match(/^Supported Scopes:\s*(.+)$/i);
            const outputMatch = inner.match(/^Output Scope:\s*(.+)$/i);
            if (scopeMatch) supportedScopes = splitScopes(scopeMatch[1]!);
            if (outputMatch) outputScope = outputMatch[1]!.trim();
            j++;
        }
        addDocRule(map, {
            name: nameMatch[1]!,
            kind: 'scope',
            scopes: supportedScopes,
            targetScopes: outputScope ? [outputScope] : [],
            description: nameMatch[2]!.trim(),
            source,
            sourceLine: i + 1,
        });
        i = j - 1;
    }
}

function parseLocalisationCommands(filePath: string, lines: string[], map: Map<string, DocRule>) {
    const source = path.basename(filePath);
    let currentScope = '';
    let section: 'none' | 'promotions' | 'properties' = 'none';
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? '').trim();
        const scopeMatch = line.match(/^--(.+)--$/);
        if (scopeMatch) {
            currentScope = scopeMatch[1]!.trim();
            section = 'none';
            continue;
        }
        if (/^Promotions:?$/i.test(line)) {
            section = 'promotions';
            continue;
        }
        if (/^Properties:?$/i.test(line)) {
            section = 'properties';
            continue;
        }
        if (!currentScope || section === 'none' || !line.match(new RegExp(`^${IDENT}$`))) continue;
        addDocRule(map, {
            name: line,
            kind: 'localisation_command',
            scopes: [currentScope],
            targetScopes: [],
            description: `${section} for ${currentScope}`,
            source,
            sourceLine: i + 1,
        });
    }
}

function parseDocsDir(dir: string): Map<string, DocRule> {
    const map = new Map<string, DocRule>();
    for (const file of walkFiles(dir, f => /\.(log|txt)$/i.test(f))) {
        if (/readme/i.test(path.basename(file))) continue;
        const lines = readText(file).split('\n');
        parseScriptDocSections(file, lines, map, 'effect', /EFFECT DOCUMENTATION/i);
        parseScriptDocSections(file, lines, map, 'trigger', /TRIGGER DOCUMENTATION/i);
        parseModifiers(file, lines, map);
        parseScopes(file, lines, map);
        parseLocalisationCommands(file, lines, map);
    }
    return map;
}

// ---------- CWT config scanning ----------

function walkCwtFiles(dir: string): string[] {
    return walkFiles(dir, f => f.endsWith('.cwt'));
}

function scanCwtAliasNames(configDir: string): Map<RuleKind, Set<string>> {
    const result = new Map<RuleKind, Set<string>>([
        ['effect', new Set<string>()],
        ['trigger', new Set<string>()],
        ['modifier', new Set<string>()],
    ]);
    for (const file of walkCwtFiles(configDir)) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const match of content.matchAll(/alias\[(effect|trigger|modifier):([A-Za-z_][A-Za-z0-9_.-]*)\]/g)) {
            result.get(match[1] as RuleKind)!.add(match[2]!.toLowerCase());
        }
    }
    return result;
}

interface CwtCommonCoverage {
    pathToFiles: Map<string, string[]>;
    fileVocabulary: Map<string, Set<string>>;
    /** alias group name -> raw member keys from alias[group:key] across the whole config. */
    aliasGroupKeys: Map<string, Set<string>>;
    /** cwt file -> alias groups it pulls in via alias_name[group]. */
    fileGroupRefs: Map<string, Set<string>>;
    /** enum name -> literal values, for expanding enum[...] member keys. */
    enumValues: Map<string, Set<string>>;
    /** type name -> common folder it loads from (type[NAME] = { path = ... }). */
    typeFolders: Map<string, string>;
    /** type names declared with type_per_file = yes. */
    typePerFile: Set<string>;
    /** cwt file -> type names referenced as <type> keys/values. */
    fileTypeRefs: Map<string, Set<string>>;
    wildcardKeyDepths: Map<string, Set<number>>;
    /** cwt file -> ## type_key_filter subtype names. */
    fileTypeKeyFilters: Map<string, Set<string>>;
    /** "planet_$_build_speed_mult"-style modifier generation patterns from type rules. */
    dollarPatterns: Set<string>;
}

function scanCwtCommonCoverage(configDir: string): CwtCommonCoverage {
    const pathToFiles = new Map<string, string[]>();
    const fileVocabulary = new Map<string, Set<string>>();
    const aliasGroupKeys = new Map<string, Set<string>>();
    const fileGroupRefs = new Map<string, Set<string>>();
    const enumValues = new Map<string, Set<string>>();
    const typeFolders = new Map<string, string>();
    const typePerFile = new Set<string>();
    const fileTypeRefs = new Map<string, Set<string>>();
    const wildcardKeyDepths = new Map<string, Set<number>>();
    const fileTypeKeyFilters = new Map<string, Set<string>>();
    const dollarPatterns = new Set<string>();
    for (const file of walkCwtFiles(configDir)) {
        const content = readText(file);
        const relFile = toPosix(path.relative(configDir, file));
        for (const match of content.matchAll(/path\s*=\s*"game\/common\/([^"]+)"/g)) {
            const folder = normalizeCommonPath(match[1]!);
            const list = pathToFiles.get(folder) ?? [];
            if (!list.includes(relFile)) list.push(relFile);
            pathToFiles.set(folder, list);
        }
        const stripped = content.split('\n').map(stripLineComment);
        const strippedText = stripped.join('\n');
        // Member key may itself contain one bracket pair, e.g. alias[modifier_rule:enum[complex_maths_enum]].
        for (const match of strippedText.matchAll(/alias\[([A-Za-z_][A-Za-z0-9_.\-]*):((?:[^\][]|\[[^\]]*\])+)\]/g)) {
            const group = match[1]!.toLowerCase();
            const keys = aliasGroupKeys.get(group) ?? new Set<string>();
            keys.add(match[2]!.trim());
            aliasGroupKeys.set(group, keys);
        }
        const refs = new Set<string>();
        for (const match of strippedText.matchAll(/alias_name\[([A-Za-z_][A-Za-z0-9_.\-]*)\]/g)) {
            refs.add(match[1]!.toLowerCase());
        }
        if (refs.size) fileGroupRefs.set(relFile, refs);
        const typeRefs = new Set<string>();
        for (const match of strippedText.matchAll(/<([A-Za-z_][A-Za-z0-9_.\-]*)>/g)) {
            typeRefs.add(match[1]!.split('.')[0]!.toLowerCase());
        }
        if (typeRefs.size) fileTypeRefs.set(relFile, typeRefs);
        collectEnumValues(stripped, enumValues);
        collectTypeFolders(stripped, typeFolders, typePerFile);
        collectWildcardKeyDepths(stripped, wildcardKeyDepths);
        // Modifier generation patterns: "planet_$_build_speed_mult" = Planets
        for (const match of strippedText.matchAll(/"([A-Za-z0-9_]*\$[A-Za-z0-9_$]*)"\s*==?|(?:^|[\s{])([A-Za-z0-9_]*\$[A-Za-z0-9_$]*)\s*==?/g)) {
            dollarPatterns.add((match[1] ?? match[2]!).toLowerCase());
        }
        // type_key_filter directives live in ## comments, so parse the raw lines.
        const filters = new Set<string>();
        for (const line of content.split('\n')) {
            const filterMatch = line.match(/^\s*##\s*type_key_filter\s*=\s*(.+)$/);
            if (!filterMatch) continue;
            const value = filterMatch[1]!.trim();
            const tokens = value.startsWith('{') ? value.replace(/[{}]/g, '') : value;
            for (const token of tokens.matchAll(/[A-Za-z_][A-Za-z0-9_.\-]*/g)) filters.add(token[0]!.toLowerCase());
        }
        if (filters.size) fileTypeKeyFilters.set(relFile, filters);
        const vocab = new Set<string>();
        for (const line of stripped) {
            for (const token of line.matchAll(/[A-Za-z_][A-Za-z0-9_.\-]*/g)) {
                vocab.add(token[0]!.toLowerCase());
            }
        }
        fileVocabulary.set(relFile, vocab);
    }
    return { pathToFiles, fileVocabulary, aliasGroupKeys, fileGroupRefs, enumValues, typeFolders, typePerFile, fileTypeRefs, wildcardKeyDepths, fileTypeKeyFilters, dollarPatterns };
}

function collectWildcardKeyDepths(strippedLines: string[], into: Map<string, Set<number>>) {
    let depth = 0;
    let currentRule = '';
    let inDeclarationBlock = false;
    for (const line of strippedLines) {
        if (depth === 0) {
            currentRule = '';
            if (/^\s*(types|enums)\s*==?\s*\{/.test(line)) {
                inDeclarationBlock = true;
            } else {
                const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.\-]*)\s*==?\s*\{/);
                if (match && !inDeclarationBlock) currentRule = match[1]!.toLowerCase();
            }
        } else if (currentRule && /^\s*(scalar|localisation)\s*==?(\s|$)/.test(line)) {
            const depths = into.get(currentRule) ?? new Set<number>();
            depths.add(depth);
            into.set(currentRule, depths);
        }
        depth += countBraceDelta(line);
        if (depth <= 0) {
            depth = 0;
            inDeclarationBlock = false;
            currentRule = '';
        }
    }
}

function collectTypeFolders(strippedLines: string[], typeFolders: Map<string, string>, typePerFile: Set<string>) {
    for (let i = 0; i < strippedLines.length; i++) {
        const line = strippedLines[i] ?? '';
        const match = line.match(/(?:^|\s)type\[([A-Za-z_][A-Za-z0-9_.\-]*)\]\s*=\s*\{/);
        if (!match) continue;
        const name = match[1]!.toLowerCase();
        let depth = countBraceDelta(line);
        let j = i;
        let rest = line.slice(line.indexOf('{') + 1);
        while (j < strippedLines.length && depth > 0) {
            const pathMatch = rest.match(/path\s*=\s*"game\/common\/([^"]+)"/);
            if (pathMatch && !typeFolders.has(name)) typeFolders.set(name, normalizeCommonPath(pathMatch[1]!));
            if (/(?:^|\s)type_per_file\s*=\s*yes\b/.test(rest)) typePerFile.add(name);
            j++;
            rest = strippedLines[j] ?? '';
            depth += countBraceDelta(rest);
        }
        i = j - 1 > i ? j - 1 : i;
    }
}

function collectEnumValues(strippedLines: string[], enums: Map<string, Set<string>>) {
    for (let i = 0; i < strippedLines.length; i++) {
        const line = strippedLines[i] ?? '';
        const match = line.match(/(?:^|\s)enum\[([A-Za-z_][A-Za-z0-9_.\-]*)\]\s*=\s*\{/);
        if (!match) continue;
        const name = match[1]!.toLowerCase();
        const values = enums.get(name) ?? new Set<string>();
        let depth = countBraceDelta(line);
        let j = i;
        let rest = line.slice(line.indexOf('{') + 1);
        while (j < strippedLines.length && depth > 0) {
            for (const token of rest.matchAll(/[A-Za-z_][A-Za-z0-9_.\-]*/g)) values.add(token[0]!.toLowerCase());
            j++;
            rest = strippedLines[j] ?? '';
            depth += countBraceDelta(rest);
        }
        if (values.size) enums.set(name, values);
        i = j - 1 > i ? j - 1 : i;
    }
}

/** Expand the member keys an alias group contributes at its expansion site. */
function expandGroupKeys(group: string, coverage: CwtCommonCoverage, into: Set<string>, resolveTypeRef?: (typeName: string, into: Set<string>) => void) {
    for (const rawKey of coverage.aliasGroupKeys.get(group) ?? []) {
        const enumRef = rawKey.match(/^enum\[([A-Za-z_][A-Za-z0-9_.\-]*)\]$/);
        if (enumRef) {
            for (const value of coverage.enumValues.get(enumRef[1]!.toLowerCase()) ?? []) into.add(value);
            continue;
        }
        const typeRef = rawKey.match(/^<([A-Za-z_][A-Za-z0-9_.\-]*)>$/);
        if (typeRef) {
            // e.g. alias[trigger:<scripted_trigger>] — members come from the vanilla scan.
            if (resolveTypeRef) resolveTypeRef(typeRef[1]!.split('.')[0]!.toLowerCase(), into);
            continue;
        }
        // Other dynamic keys (scalar, value[...]) cannot be enumerated here;
        // doc-derived dynamic names are handled by the maybeCovered bucket.
        if (/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(rawKey)) into.add(rawKey.toLowerCase());
    }
}

function normalizeCommonPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^game\/common\//i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
}

function toPosix(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

// ---------- vanilla common field-level scan ----------

interface FolderFieldStats {
    folder: string;
    definitionCount: number;
    fields: Map<string, { count: number; example: string; exampleLine: number }>;
    /** Top-level definition names, used to expand <type> key references. */
    defNames: Set<string>;
}

function scanVanillaCommonFields(commonDir: string): Map<string, FolderFieldStats> {
    const folders = new Map<string, FolderFieldStats>();
    for (const file of walkFiles(commonDir, f => f.endsWith('.txt'))) {
        const relPath = toPosix(path.relative(commonDir, file));
        const folder = normalizeCommonPath(path.dirname(relPath));
        if (!folder || folder === '.') continue;
        // Script-content folders are still scanned: their definition names feed
        // <scripted_trigger>/<scripted_effect>/... type expansion, but their
        // fields are free-form script and are never reported (see buildFolderReports).
        let stats = folders.get(folder);
        if (!stats) {
            stats = { folder, definitionCount: 0, fields: new Map(), defNames: new Set() };
            folders.set(folder, stats);
        }
        // component_tags files are bare token lists; the tags feed generated-
        // modifier templates (weapon_type_X_weapon_damage_mult etc.).
        if (folder.split('/')[0] === 'component_tags') {
            for (const line of readText(file).split('\n')) {
                const tag = stripLineComment(line).trim();
                if (/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(tag)) stats.defNames.add(tag.toLowerCase());
            }
            continue;
        }
        collectDefinitionFields(readText(file), relPath, stats);
    }
    return folders;
}

function isScriptContentFolder(folder: string): boolean {
    return SCRIPT_COMMON_CONTENT_FOLDERS.has(folder.split('/')[0]!);
}

function collectDefinitionFields(content: string, relPath: string, stats: FolderFieldStats) {
    const lines = content.split('\n');
    let depth = 0;
    let inDefinition = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const stripped = stripLineComment(line);
        if (depth === 0) {
            const match = stripped.match(TOP_LEVEL_PDX_PATTERN);
            if (match && match[1] !== 'namespace' && stripped.includes('{')) {
                // Top-level inline_script blocks are invocations carrying custom
                // parameters (script = ..., PARAM = ...), not definitions; their
                // keys must never count as rule fields.
                if (match[1]!.toLowerCase() === 'inline_script') {
                    inDefinition = false;
                } else {
                    stats.definitionCount++;
                    stats.defNames.add(match[1]!.toLowerCase());
                    inDefinition = true;
                }
            }
        } else if (depth === 1 && inDefinition) {
            const match = stripped.match(TOP_LEVEL_PDX_PATTERN);
            if (match) {
                const field = match[1]!.toLowerCase();
                const entry = stats.fields.get(field);
                if (entry) entry.count++;
                else stats.fields.set(field, { count: 1, example: relPath, exampleLine: i + 1 });
            }
        }
        depth += countBraceDelta(line);
        if (depth <= 0) {
            depth = 0;
            inDefinition = false;
        }
    }
}

/** Closest rename candidate by token Jaccard similarity (>= 0.5), e.g.
 *  can_planet_auto_migrate -> can_colony_auto_migrate. */
function closestName(name: string, candidates: string[]): string | undefined {
    const tokens = new Set(name.split('_'));
    let best: string | undefined;
    let bestScore = 0.5;
    for (const candidate of candidates) {
        const candidateTokens = new Set(candidate.split('_'));
        let shared = 0;
        for (const token of tokens) if (candidateTokens.has(token)) shared++;
        const score = shared / (tokens.size + candidateTokens.size - shared);
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}

function findCoveringCwtFiles(folder: string, coverage: CwtCommonCoverage): string[] {
    let probe = folder;
    while (probe) {
        const files = coverage.pathToFiles.get(probe);
        if (files && files.length) return files;
        const slash = probe.lastIndexOf('/');
        if (slash < 0) break;
        probe = probe.slice(0, slash);
    }
    return [];
}

// ---------- diffing ----------

function toDiffEntry(rule: DocRule, inCwt?: boolean): DiffEntry {
    return {
        name: rule.name,
        description: rule.description.slice(0, 240),
        scopes: rule.scopes,
        targetScopes: rule.targetScopes,
        category: rule.category,
        source: rule.source,
        sourceLine: rule.sourceLine,
        inCwt,
    };
}

function sameSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    const set = new Set(left.map(v => v.toLowerCase()));
    return right.every(v => set.has(v.toLowerCase()));
}

/** Trim a changed description pair to a compact window that still contains
 * the first difference. A plain fixed-length prefix slice makes long
 * descriptions whose change sits past the cut render as identical text. */
export function descriptionChangeWindow(before: string, after: string, max = 160): { before: string; after: string } {
    if (before.length <= max && after.length <= max) return { before, after };
    let firstDiff = 0;
    const shared = Math.min(before.length, after.length);
    while (firstDiff < shared && before[firstDiff] === after[firstDiff]) firstDiff++;
    const windowAround = (value: string): string => {
        const start = Math.max(0, Math.min(firstDiff - 40, value.length - max));
        const sliced = value.slice(start, start + max);
        return (start > 0 ? '…' : '') + sliced + (start + max < value.length ? '…' : '');
    };
    return { before: windowAround(before), after: windowAround(after) };
}

export function diffKind(kind: RuleKind, game: Map<string, DocRule>, baseline: Map<string, DocRule>, cwtNames: Map<RuleKind, Set<string>>): KindDiff {
    const added: DiffEntry[] = [];
    const removed: DiffEntry[] = [];
    const changed: DiffEntry[] = [];
    const cwtSet = cwtNames.get(kind);

    for (const [key, rule] of game) {
        if (rule.kind !== kind) continue;
        const old = baseline.get(key);
        if (!old) {
            added.push(toDiffEntry(rule, cwtSet ? cwtSet.has(rule.name.toLowerCase()) : undefined));
            continue;
        }
        const changes: DiffChange[] = [];
        if (!sameSet(old.scopes, rule.scopes)) {
            changes.push({ field: 'scopes', before: old.scopes.join(' ') || '(无)', after: rule.scopes.join(' ') || '(无)' });
        }
        if (!sameSet(old.targetScopes, rule.targetScopes)) {
            changes.push({ field: 'output scope', before: old.targetScopes.join(' ') || '(无)', after: rule.targetScopes.join(' ') || '(无)' });
        }
        if ((old.category ?? '') !== (rule.category ?? '')) {
            changes.push({ field: 'category', before: old.category ?? '(无)', after: rule.category ?? '(无)' });
        }
        const beforeDescription = old.description.trim();
        const afterDescription = rule.description.trim();
        if (beforeDescription !== afterDescription) {
            changes.push({ field: 'description', ...descriptionChangeWindow(beforeDescription, afterDescription) });
        }
        if (changes.length) changed.push({ ...toDiffEntry(rule), changes });
    }

    for (const [key, rule] of baseline) {
        if (rule.kind !== kind) continue;
        if (!game.has(key)) removed.push(toDiffEntry(rule, cwtNames.get(kind)?.has(rule.name.toLowerCase())));
    }

    const byName = (a: DiffEntry, b: DiffEntry) => a.name.localeCompare(b.name);
    added.sort(byName);
    removed.sort(byName);
    changed.sort(byName);
    return { kind, added, removed, changed };
}

// ---------- field-level report assembly ----------

function buildFolderReports(
    vanillaFolders: Map<string, FolderFieldStats>,
    coverage: CwtCommonCoverage,
    dynamicNames: Set<string>,
): FolderFieldReport[] {
    // Members of <type> key references come from the vanilla scan itself.
    const folderDefNames = new Map<string, Set<string>>();
    for (const stats of vanillaFolders.values()) folderDefNames.set(stats.folder, stats.defNames);
    const expandTypeRef = (typeName: string, into: Set<string>) => {
        const typeFolder = coverage.typeFolders.get(typeName);
        if (!typeFolder) return;
        for (const [folder, names] of folderDefNames) {
            if (folder === typeFolder || folder.startsWith(`${typeFolder}/`)) {
                for (const name of names) into.add(name);
            }
        }
    };

    const reports: FolderFieldReport[] = [];
    for (const stats of Array.from(vanillaFolders.values()).sort((a, b) => a.folder.localeCompare(b.folder))) {
        if (isScriptContentFolder(stats.folder)) continue;
        const cwtFiles = findCoveringCwtFiles(stats.folder, coverage);
        const covered = cwtFiles.length > 0;
        const vocab = new Set<string>();
        for (const file of cwtFiles) {
            for (const token of coverage.fileVocabulary.get(file) ?? []) vocab.add(token);
            for (const group of coverage.fileGroupRefs.get(file) ?? []) expandGroupKeys(group, coverage, vocab, expandTypeRef);
            for (const typeName of coverage.fileTypeRefs.get(file) ?? []) expandTypeRef(typeName, vocab);
        }
        let newFields: FieldFinding[] = [];
        const maybeCovered: FieldFinding[] = [];
        const wildcardKeys = Array.from(coverage.typeFolders.entries()).some(([typeName, typeFolder]) =>
            (stats.folder === typeFolder || stats.folder.startsWith(`${typeFolder}/`))
            && (coverage.wildcardKeyDepths.get(typeName)?.has(coverage.typePerFile.has(typeName) ? 2 : 1) ?? false));
        const enumerated = ENUMERATED_SUBTYPE_FOLDERS.has(stats.folder);
        if (covered && !wildcardKeys && !enumerated) {
            for (const [field, info] of stats.fields) {
                if (vocab.has(field) || ENGINE_FIELDS.has(field)) continue;
                const finding: FieldFinding = { field, count: info.count, example: info.example, exampleLine: info.exampleLine };
                if (dynamicNames.has(field)) maybeCovered.push(finding);
                else newFields.push(finding);
            }
        }
        let missingSubtypes: string[] = [];
        let staleSubtypes: Array<{ name: string; renameTo?: string }> = [];
        if (covered && enumerated) {
            const filters = new Set<string>();
            for (const file of cwtFiles) {
                for (const name of coverage.fileTypeKeyFilters.get(file) ?? []) filters.add(name);
            }
            missingSubtypes = Array.from(stats.defNames).filter(name => !filters.has(name)).sort();
            // The reverse direction catches removals and renames: a rename shows
            // up as one missing + one stale entry, paired by token similarity.
            staleSubtypes = Array.from(filters)
                .filter(name => !stats.defNames.has(name))
                .sort()
                .map(name => ({ name, renameTo: closestName(name, missingSubtypes) }));
        }
        const byCount = (a: FieldFinding, b: FieldFinding) => b.count - a.count || a.field.localeCompare(b.field);
        newFields.sort(byCount);
        maybeCovered.sort(byCount);
        let omittedNewFields = 0;
        if (newFields.length > DYNAMIC_FIELD_LIMIT) {
            omittedNewFields = newFields.length - DYNAMIC_FIELD_KEEP;
            newFields = newFields.slice(0, DYNAMIC_FIELD_KEEP);
        }
        if (!covered || newFields.length || maybeCovered.length || missingSubtypes.length || staleSubtypes.length) {
            reports.push({
                folder: stats.folder,
                covered,
                cwtFiles,
                definitionCount: stats.definitionCount,
                newFields,
                maybeCovered,
                omittedNewFields: omittedNewFields || undefined,
                missingSubtypes: missingSubtypes.length ? missingSubtypes : undefined,
                staleSubtypes: staleSubtypes.length ? staleSubtypes : undefined,
            });
        }
    }
    return reports;
}

// ---------- generated-modifier detection ----------

/**
 * Infer generation templates from the full game modifier list: replace up to
 * two definition-name spans (from the vanilla scan) with "$". Families with
 * enough members are treated as rule-generated (e.g. damage_vs_country_type_$_mult,
 * $_$_produces_mult, block_$) and excluded from the comparison.
 */
function inferGeneratedTemplates(allNames: string[], defNames: Set<string>, minFamily = 3): Set<string> {
    const counts = new Map<string, number>();
    for (const rawName of allNames) {
        const template = templateOf(rawName.toLowerCase(), defNames);
        if (template) counts.set(template, (counts.get(template) ?? 0) + 1);
    }
    const templates = new Set<string>();
    for (const [template, count] of counts) {
        if (count >= minFamily) templates.add(template);
    }
    return templates;
}

function templateOf(name: string, defNames: Set<string>): string | undefined {
    let tokens = name.split('_');
    let replaced = 0;
    for (let pass = 0; pass < 2; pass++) {
        let found = false;
        for (let len = tokens.length; len >= 1 && !found; len--) {
            for (let start = 0; start + len <= tokens.length; start++) {
                const span = tokens.slice(start, start + len);
                if (span.includes('$')) continue;
                if (!defNames.has(span.join('_'))) continue;
                tokens = [...tokens.slice(0, start), '$', ...tokens.slice(start + len)];
                replaced++;
                found = true;
                break;
            }
        }
        if (!found) break;
    }
    // A bare "$" (the whole name is a definition name) is not a family.
    if (!replaced || tokens.every(token => token === '$')) return undefined;
    return tokens.join('_');
}

function templateRegex(template: string): RegExp {
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\\\$/g, '.+')}$`);
}

function filterGeneratedModifiers(diff: KindDiff, templates: Set<string>, dollarPatterns: Set<string>, defNames: Set<string>) {
    const families = new Map<string, { regex?: RegExp; count: number; example: string }>();
    // cwt $ patterns always sweep by regex; inferred templates sweep by regex
    // only when specific enough (>= 2 literal tokens), so generic families like
    // "$_mult" cannot swallow genuinely new modifiers. Generic families still
    // match via definition-name anchoring below (which also keeps them precise),
    // and the regex sweep exists to catch mod-generated instances whose
    // definition names are not in the vanilla scan.
    for (const pattern of dollarPatterns) {
        families.set(pattern, { regex: templateRegex(pattern), count: 0, example: '' });
    }
    for (const template of templates) {
        const literalTokens = template.split('_').filter(token => token !== '$').length;
        families.set(template, { regex: literalTokens >= 2 ? templateRegex(template) : undefined, count: 0, example: '' });
    }
    const record = (key: string, entry: DiffEntry) => {
        const family = families.get(key)!;
        family.count++;
        if (!family.example) family.example = entry.name;
    };
    const sweep = (entries: DiffEntry[]): DiffEntry[] => {
        const kept: DiffEntry[] = [];
        for (const entry of entries) {
            const name = entry.name.toLowerCase();
            const anchored = templateOf(name, defNames);
            if (anchored && families.has(anchored)) {
                record(anchored, entry);
                continue;
            }
            let matched = false;
            for (const [key, family] of families) {
                if (!family.regex || !family.regex.test(name)) continue;
                record(key, entry);
                matched = true;
                break;
            }
            if (!matched) kept.push(entry);
        }
        return kept;
    };
    diff.added = sweep(diff.added);
    diff.removed = sweep(diff.removed);
    diff.excluded = Array.from(families.entries())
        .filter(([, family]) => family.count > 0)
        .map(([template, family]) => ({ template, count: family.count, example: family.example }))
        .sort((a, b) => b.count - a.count);
}

// ---------- meta ----------

function detectGameVersion(vanillaCommonDir: string): string {
    try {
        const settingsPath = path.join(path.dirname(vanillaCommonDir), 'launcher-settings.json');
        if (!fs.existsSync(settingsPath)) return '';
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { rawVersion?: string; version?: string };
        return settings.rawVersion || settings.version || '';
    } catch {
        return '';
    }
}

function readShaderAbiMergeReport(file: string): ShaderAbiMergeInfo | null {
    try {
        if (!file || !fs.existsSync(file)) return null;
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const report = raw as Record<string, unknown>;
        const child = (value: unknown): Record<string, unknown> =>
            value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const identity = child(report.game_identity);
        const declarations = child(report.declarations);
        const catalog = child(report.catalog);
        const contracts = child(report.renderer_contracts);
        const scan = child(report.executable_string_scan);
        const stringList = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
        const droppedList = <T extends Record<string, unknown>>(value: unknown): T[] =>
            Array.isArray(value) ? value.filter((item): item is T => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
        const numberValue = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
        return {
            fromVersion: typeof report.from_version === 'string' ? report.from_version : 'unknown',
            toVersion: typeof report.to_version === 'string' ? report.to_version : '',
            executableChanged: identity.executable_changed === true,
            declarations: numberValue(declarations.effect_declarations),
            uniqueNames: numberValue(declarations.unique_effect_names),
            carried: stringList(catalog.carried),
            added: stringList(catalog.added),
            dropped: droppedList(catalog.dropped),
            contractsKept: numberValue(contracts.kept),
            contractsSkipped: contracts.skipped === true,
            contractsDropped: droppedList(contracts.dropped),
            asciiHits: numberValue(scan.ascii_hits),
            utf16Hits: numberValue(scan.utf16le_hits),
        };
    } catch {
        return null;
    }
}

function newestMtime(dir: string): string {
    let newest = 0;
    for (const file of walkFiles(dir, f => /\.(log|txt)$/i.test(f))) {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime > newest) newest = mtime;
    }
    return newest ? new Date(newest).toISOString() : '';
}

// ---------- HTML ----------

function renderHtml(data: ReportData): string {
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Stellaris 规则同步对比报告</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f5f6f8; --card: #ffffff; --ink: #1f2328; --muted: #59636e; --line: #d9dee3;
  --add: #1a7f37; --add-bg: #dafbe1; --del: #cf222e; --del-bg: #ffebe9; --chg: #9a6700; --chg-bg: #fff8c5;
  --accent: #0969da; --tag-bg: #eef1f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1f24; --card: #24292f; --ink: #e6edf3; --muted: #9da7b1; --line: #3d444d;
    --add: #56d364; --add-bg: #1d3528; --del: #ff7b72; --del-bg: #3a2123; --chg: #e3b341; --chg-bg: #3a3220;
    --accent: #58a6ff; --tag-bg: #2d333b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.55 "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--ink); }
header { padding: 18px 28px 12px; }
header h1 { margin: 0 0 4px; font-size: 20px; }
header .meta { color: var(--muted); font-size: 12px; }
header .meta span { margin-right: 18px; }
.cards { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 28px 6px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; min-width: 118px; cursor: pointer; }
.card:hover { border-color: var(--accent); }
.card .num { font-size: 22px; font-weight: 600; }
.card .lbl { color: var(--muted); font-size: 12px; }
.card .num.add { color: var(--add); } .card .num.del { color: var(--del); } .card .num.chg { color: var(--chg); }
nav { display: flex; gap: 4px; padding: 10px 28px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
nav button { border: 1px solid var(--line); border-bottom: none; background: var(--card); color: var(--ink); padding: 7px 16px; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 13px; }
nav button.active { color: var(--accent); font-weight: 600; border-color: var(--accent); }
nav button .cnt { color: var(--muted); font-size: 11px; margin-left: 5px; }
main { padding: 16px 28px 48px; }
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.toolbar input[type=search] { flex: 0 1 340px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); }
.toolbar label { font-size: 13px; color: var(--muted); cursor: pointer; }
table { border-collapse: collapse; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 6px 12px; border-top: 1px solid var(--line); vertical-align: top; }
thead th { border-top: none; background: var(--tag-bg); font-size: 12px; color: var(--muted); position: sticky; top: 0; }
td.name { font-family: Consolas, monospace; white-space: nowrap; }
td .desc { color: var(--muted); }
.badge { display: inline-block; border-radius: 10px; padding: 0 8px; font-size: 11px; margin-left: 6px; vertical-align: 1px; }
.badge.add { background: var(--add-bg); color: var(--add); }
.badge.del { background: var(--del-bg); color: var(--del); }
.badge.chg { background: var(--chg-bg); color: var(--chg); }
.badge.cwt { background: var(--tag-bg); color: var(--muted); }
.tag { display: inline-block; background: var(--tag-bg); border-radius: 4px; padding: 0 6px; font-size: 11px; font-family: Consolas, monospace; margin: 1px 2px; }
.src { color: var(--muted); font-size: 11px; white-space: nowrap; }
.change b { font-weight: 600; }
.change .old { color: var(--del); text-decoration: line-through; }
.change .new { color: var(--add); }
details.folder { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; }
details.folder > summary { padding: 9px 14px; cursor: pointer; font-weight: 600; }
details.folder > summary .sub { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 10px; }
details.folder .body { padding: 0 14px 12px; }
details.inner > summary { color: var(--muted); font-size: 12px; cursor: pointer; padding: 6px 0; }
.more { margin: 10px 0; padding: 6px 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--accent); cursor: pointer; }
.empty { color: var(--muted); padding: 24px; text-align: center; }
h3.bucket { margin: 18px 0 8px; font-size: 14px; }
.uncovered { border-left: 3px solid var(--del); }
</style>
</head>
<body>
<header>
  <h1>Stellaris 规则同步对比报告</h1>
  <div class="meta" id="meta"></div>
</header>
<div class="cards" id="cards"></div>
<nav id="nav"></nav>
<main id="main"></main>
<script id="data" type="application/json">${json}</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const ROW_CAP = 400;
const KIND_LABELS = ${JSON.stringify(KIND_LABELS)};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function meta() {
  const m = document.getElementById('meta');
  const parts = [];
  if (DATA.gameVersion) parts.push('游戏版本 <b>' + esc(DATA.gameVersion) + '</b>');
  parts.push('文档导出时间 ' + esc((DATA.docsNewestMtime || '').slice(0, 16).replace('T', ' ') || '未知'));
  parts.push('报告生成 ' + esc(DATA.generatedAt.slice(0, 16).replace('T', ' ')));
  parts.push('基线 ' + esc(DATA.baselineDir));
  m.innerHTML = parts.map(p => '<span>' + p + '</span>').join('');
}

const tabs = [];
for (const diff of DATA.diffs) {
  tabs.push({ id: diff.kind, label: KIND_LABELS[diff.kind] || diff.kind, count: diff.added.length + diff.removed.length + diff.changed.length, render: () => renderDiff(diff) });
}
tabs.push({ id: 'fields', label: 'Common 字段级参数', count: DATA.folders.reduce((n, f) => n + f.newFields.length + (f.missingSubtypes || []).length + (f.staleSubtypes || []).length + (f.covered ? 0 : 1), 0), render: renderFolders });
tabs.push({ id: 'scope-contracts', label: 'Scope 契约', count: DATA.scopeContracts.findings.length, render: renderScopeContracts });
if (DATA.shaderAbi) {
  tabs.push({ id: 'shader-abi', label: 'Shader ABI', count: DATA.shaderAbi.added.length + DATA.shaderAbi.dropped.length + DATA.shaderAbi.contractsDropped.length, render: renderShaderAbi });
}

function cards() {
  const host = document.getElementById('cards');
  const items = [];
  for (const diff of DATA.diffs) {
    if (diff.added.length) items.push({ tab: diff.kind, cls: 'add', num: diff.added.length, lbl: (KIND_LABELS[diff.kind] || diff.kind).split(' ')[0] + ' 新增' });
    if (diff.removed.length) items.push({ tab: diff.kind, cls: 'del', num: diff.removed.length, lbl: (KIND_LABELS[diff.kind] || diff.kind).split(' ')[0] + ' 移除' });
    if (diff.changed.length) items.push({ tab: diff.kind, cls: 'chg', num: diff.changed.length, lbl: (KIND_LABELS[diff.kind] || diff.kind).split(' ')[0] + ' 变更' });
  }
  const uncovered = DATA.folders.filter(f => !f.covered).length;
  const fieldCount = DATA.folders.reduce((n, f) => n + f.newFields.length, 0);
  const subtypeCount = DATA.folders.reduce((n, f) => n + (f.missingSubtypes || []).length, 0);
  const staleCount = DATA.folders.reduce((n, f) => n + (f.staleSubtypes || []).length, 0);
  if (uncovered) items.push({ tab: 'fields', cls: 'del', num: uncovered, lbl: '未覆盖目录' });
  if (fieldCount) items.push({ tab: 'fields', cls: 'add', num: fieldCount, lbl: '新字段候选' });
  if (subtypeCount) items.push({ tab: 'fields', cls: 'chg', num: subtypeCount, lbl: '缺少 subtype 补全' });
  if (staleCount) items.push({ tab: 'fields', cls: 'del', num: staleCount, lbl: '陈旧 subtype' });
  const scopeSummary = DATA.scopeContracts.summary;
  if (scopeSummary.missing) items.push({ tab: 'scope-contracts', cls: 'add', num: scopeSummary.missing, lbl: 'Scope 元数据缺失' });
  if (scopeSummary.mismatch) items.push({ tab: 'scope-contracts', cls: 'chg', num: scopeSummary.mismatch, lbl: 'Scope 契约冲突' });
  if (scopeSummary.unresolved) items.push({ tab: 'scope-contracts', cls: 'del', num: scopeSummary.unresolved, lbl: 'Scope 注释待复核' });
  const abi = DATA.shaderAbi;
  if (abi) {
    if (abi.executableChanged) items.push({ tab: 'shader-abi', cls: 'chg', num: 'EXE', lbl: '引擎可执行文件已变化' });
    if (abi.added.length) items.push({ tab: 'shader-abi', cls: 'add', num: abi.added.length, lbl: 'Shader ABI 自动收录' });
    if (abi.dropped.length) items.push({ tab: 'shader-abi', cls: 'del', num: abi.dropped.length, lbl: 'Shader ABI 条目移除' });
    if (abi.contractsDropped.length) items.push({ tab: 'shader-abi', cls: 'del', num: abi.contractsDropped.length, lbl: '渲染器契约移除' });
  }
  host.innerHTML = items.map(i => '<div class="card" data-tab="' + i.tab + '"><div class="num ' + i.cls + '">' + i.num + '</div><div class="lbl">' + esc(i.lbl) + '</div></div>').join('')
    || '<div class="card"><div class="num add">0</div><div class="lbl">无差异，规则与游戏文档一致</div></div>';
  host.querySelectorAll('.card[data-tab]').forEach(el => el.addEventListener('click', () => activate(el.dataset.tab)));
}

function nav() {
  const host = document.getElementById('nav');
  host.innerHTML = tabs.map(t => '<button data-tab="' + t.id + '">' + esc(t.label) + '<span class="cnt">' + t.count + '</span></button>').join('');
  host.querySelectorAll('button').forEach(el => el.addEventListener('click', () => activate(el.dataset.tab)));
}

let active = '';
function activate(id) {
  active = id;
  document.querySelectorAll('nav button').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  const tab = tabs.find(t => t.id === id);
  const main = document.getElementById('main');
  main.innerHTML = '';
  if (tab) tab.render();
}

function entryRow(e, badge) {
  const tags = (e.scopes || []).map(s => '<span class="tag">' + esc(s) + '</span>').join('');
  const out = (e.targetScopes && e.targetScopes.length) ? ' → <span class="tag">' + esc(e.targetScopes.join(' ')) + '</span>' : '';
  const cat = e.category ? '<span class="tag">' + esc(e.category) + '</span>' : '';
  const cwt = e.inCwt ? '<span class="badge cwt">已有手写规则</span>' : '';
  let detail = '<span class="desc">' + esc(e.description) + '</span>';
  if (e.changes) {
    detail = e.changes.map(c => '<div class="change"><b>' + esc(c.field) + '</b>: <span class="old">' + esc(c.before) + '</span> → <span class="new">' + esc(c.after) + '</span></div>').join('');
  }
  return '<tr><td class="name">' + esc(e.name) + '<span class="badge ' + badge[0] + '">' + badge[1] + '</span>' + cwt + '</td>'
    + '<td>' + detail + '</td><td>' + cat + tags + out + '</td><td class="src">' + esc(e.source) + ':' + e.sourceLine + '</td></tr>';
}

function renderDiff(diff) {
  const main = document.getElementById('main');
  const wrap = document.createElement('div');
  const excluded = diff.excluded || [];
  const excludedTotal = excluded.reduce((n, f) => n + f.count, 0);
  wrap.innerHTML = '<div class="toolbar"><input type="search" placeholder="搜索名称 / 描述 / 分类…">'
    + '<label><input type="checkbox" data-b="added" checked> 新增 (' + diff.added.length + ')</label>'
    + '<label><input type="checkbox" data-b="removed" checked> 移除 (' + diff.removed.length + ')</label>'
    + '<label><input type="checkbox" data-b="changed" checked> 变更 (' + diff.changed.length + ')</label></div>'
    + (excludedTotal ? '<details class="inner" style="margin-bottom:10px"><summary>已排除 ' + excludedTotal + ' 个由规则动态生成的修正（' + excluded.length + ' 个模板，无需校对）</summary>'
      + '<table><thead><tr><th style="width:42%">生成模板</th><th style="width:12%">数量</th><th>示例</th></tr></thead><tbody>'
      + excluded.map(f => '<tr><td class="name">' + esc(f.template) + '</td><td>' + f.count + '</td><td class="name">' + esc(f.example) + '</td></tr>').join('')
      + '</tbody></table></details>' : '')
    + '<div class="list"></div>';
  main.appendChild(wrap);
  const listHost = wrap.querySelector('.list');
  const input = wrap.querySelector('input[type=search]');
  let cap = ROW_CAP;

  function rows() {
    const q = input.value.trim().toLowerCase();
    const buckets = [];
    for (const [name, badge] of [['added', ['add', '新增']], ['removed', ['del', '移除']], ['changed', ['chg', '变更']]]) {
      if (!wrap.querySelector('[data-b=' + name + ']').checked) continue;
      for (const e of diff[name]) {
        if (q && !(e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q) || (e.category || '').toLowerCase().includes(q))) continue;
        buckets.push(entryRow(e, badge));
      }
    }
    return buckets;
  }

  function paint() {
    const all = rows();
    if (!all.length) { listHost.innerHTML = '<div class="empty">没有匹配的条目</div>'; return; }
    const shown = all.slice(0, cap);
    listHost.innerHTML = '<table><thead><tr><th style="width:30%">名称</th><th>说明 / 变化</th><th style="width:22%">作用域 / 分类</th><th>来源</th></tr></thead><tbody>'
      + shown.join('') + '</tbody></table>'
      + (all.length > cap ? '<button class="more">显示其余 ' + (all.length - cap) + ' 条…</button>' : '');
    const more = listHost.querySelector('.more');
    if (more) more.addEventListener('click', () => { cap = Infinity; paint(); });
  }

  input.addEventListener('input', () => { cap = ROW_CAP; paint(); });
  wrap.querySelectorAll('.toolbar input[type=checkbox]').forEach(el => el.addEventListener('change', () => { cap = ROW_CAP; paint(); }));
  paint();
}

function fieldTable(fields) {
  return '<table><thead><tr><th style="width:34%">字段</th><th style="width:12%">出现次数</th><th>示例位置</th></tr></thead><tbody>'
    + fields.map(f => '<tr><td class="name">' + esc(f.field) + '</td><td>' + f.count + '</td><td class="src">' + esc(f.example) + ':' + f.exampleLine + '</td></tr>').join('')
    + '</tbody></table>';
}

function renderFolders() {
  const main = document.getElementById('main');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="toolbar"><input type="search" placeholder="搜索目录 / 字段…">'
    + '<label><input type="checkbox" data-f="uncovered" checked> 未覆盖目录</label>'
    + '<label><input type="checkbox" data-f="fields" checked> 有新字段的目录</label></div><div class="list"></div>';
  main.appendChild(wrap);
  const listHost = wrap.querySelector('.list');
  const input = wrap.querySelector('input[type=search]');

  function paint() {
    const q = input.value.trim().toLowerCase();
    const showUncovered = wrap.querySelector('[data-f=uncovered]').checked;
    const showFields = wrap.querySelector('[data-f=fields]').checked;
    const blocks = [];
    for (const f of DATA.folders) {
      if (!f.covered && !showUncovered) continue;
      if (f.covered && !showFields) continue;
      const fieldMatch = fl => fl.field.includes(q);
      const missing = f.missingSubtypes || [];
      const stale = f.staleSubtypes || [];
      if (q && !f.folder.includes(q) && !f.newFields.some(fieldMatch) && !f.maybeCovered.some(fieldMatch) && !missing.some(n => n.includes(q)) && !stale.some(s => s.name.includes(q))) continue;
      const newFields = q ? f.newFields.filter(fl => f.folder.includes(q) || fieldMatch(fl)) : f.newFields;
      const maybe = q ? f.maybeCovered.filter(fl => f.folder.includes(q) || fieldMatch(fl)) : f.maybeCovered;
      const missingShown = q ? missing.filter(n => f.folder.includes(q) || n.includes(q)) : missing;
      let body = '';
      if (!f.covered) {
        body = '<div class="body"><span class="desc">原版存在 ' + f.definitionCount + ' 个定义，但配置中没有任何 <span class="tag">path = "game/common/' + esc(f.folder) + '"</span> 规则。</span></div>';
      } else if (missing.length || stale.length) {
        body = '<div class="body">'
          + (missingShown.length ? '<div class="desc" style="padding:4px 0">以下 ' + missingShown.length + ' 个原版定义缺少 <span class="tag">## type_key_filter</span> subtype：</div>'
            + missingShown.map(n => '<span class="tag">' + esc(n) + '</span>').join('') : '')
          + (stale.length ? '<div class="desc" style="padding:8px 0 4px">以下 ' + stale.length + ' 个 cwt subtype 在原版中已不存在（已移除或改名，应清理）：</div>'
            + stale.map(s => '<div><span class="tag">' + esc(s.name) + '</span>' + (s.renameTo ? ' <span class="desc">→ 疑似改名为</span> <span class="tag">' + esc(s.renameTo) + '</span>' : ' <span class="badge del">已移除</span>') + '</div>').join('') : '')
          + '</div>';
      } else {
        body = '<div class="body">'
          + (newFields.length ? fieldTable(newFields) : '<span class="desc">无未知字段</span>')
          + (f.omittedNewFields ? '<div class="desc" style="padding:6px 0">… 另有 ' + f.omittedNewFields + ' 个低频字段未列出（该目录疑似使用动态内容键，规则可能需要 scalar 通配）</div>' : '')
          + (maybe.length ? '<details class="inner"><summary>可能由动态规则覆盖（与 modifier/trigger/effect/scope 同名）的字段 ' + maybe.length + ' 个</summary>' + fieldTable(maybe) + '</details>' : '')
          + '</div>';
      }
      const sub = !f.covered
        ? '<span class="badge del">未覆盖</span> 定义 ' + f.definitionCount + ' 个'
        : (missing.length || stale.length)
        ? '规则文件: ' + f.cwtFiles.map(esc).join(', ') + ' · 定义 ' + f.definitionCount + ' 个'
          + (missing.length ? ' · <span class="badge chg">缺少 subtype ' + missing.length + ' 个</span>' : '')
          + (stale.length ? ' · <span class="badge del">陈旧 subtype ' + stale.length + ' 个</span>' : '')
        : '规则文件: ' + f.cwtFiles.map(esc).join(', ') + ' · 定义 ' + f.definitionCount + ' 个 · 新字段 ' + (newFields.length + (f.omittedNewFields || 0));
      blocks.push('<details class="folder' + (f.covered ? '' : ' uncovered') + '"' + (q || !f.covered ? ' open' : '') + '><summary>common/' + esc(f.folder) + '<span class="sub">' + sub + '</span></summary>' + body + '</details>');
    }
    listHost.innerHTML = blocks.join('') || '<div class="empty">没有匹配的目录</div>';
  }

  input.addEventListener('input', paint);
  wrap.querySelectorAll('.toolbar input[type=checkbox]').forEach(el => el.addEventListener('change', paint));
  paint();
}

function scopeEnvironment(env) {
  if (!env) return '';
  const fields = [];
  if (env.this) fields.push('THIS=' + env.this);
  if (env.root) fields.push('ROOT=' + env.root);
  (env.from || []).forEach((scope, index) => fields.push('FROM'.repeat(index + 1) + '=' + scope));
  return fields.map(field => '<span class="tag">' + esc(field) + '</span>').join('');
}

function renderScopeContracts() {
  const main = document.getElementById('main');
  const wrap = document.createElement('div');
  const summary = DATA.scopeContracts.summary;
  wrap.innerHTML = '<div class="toolbar"><input type="search" placeholder="搜索定义 / scope / 来源…">'
    + '<label><input type="checkbox" data-s="missing" checked> 缺失 (' + summary.missing + ')</label>'
    + '<label><input type="checkbox" data-s="mismatch" checked> 冲突 (' + summary.mismatch + ')</label>'
    + '<label><input type="checkbox" data-s="unresolved" checked> 待复核 (' + summary.unresolved + ')</label></div>'
    + '<div class="desc" style="margin-bottom:10px">已提取 ' + summary.extracted + ' 条注释契约，其中高置信度 ' + summary.highConfidence
    + ' 条。只有高置信度且无现有 CWT 契约的条目可自动补全；描述性或冲突注释保留为人工复核。</div><div class="list"></div>';
  main.appendChild(wrap);
  const listHost = wrap.querySelector('.list');
  const input = wrap.querySelector('input[type=search]');

  function paint() {
    const q = input.value.trim().toLowerCase();
    const enabled = new Set(Array.from(wrap.querySelectorAll('[data-s]:checked')).map(el => el.dataset.s));
    const findings = DATA.scopeContracts.findings.filter(finding => {
      if (!enabled.has(finding.status)) return false;
      const haystack = [finding.name, finding.folder, finding.source, ...(finding.evidence || []), ...(finding.differences || [])].join(' ').toLowerCase();
      return !q || haystack.includes(q);
    });
    if (!findings.length) {
      listHost.innerHTML = '<div class="empty">没有匹配的 Scope 契约项</div>';
      return;
    }
    const labels = { missing: ['add', '缺失'], mismatch: ['chg', '冲突'], unresolved: ['del', '待复核'] };
    listHost.innerHTML = '<table><thead><tr><th style="width:24%">定义</th><th style="width:28%">期望 / 当前</th><th>证据 / 差异</th><th>来源</th></tr></thead><tbody>'
      + findings.map(finding => {
        const badge = labels[finding.status];
        const expected = scopeEnvironment(finding.expected);
        const actual = finding.actual ? '<div class="desc">CWT: ' + scopeEnvironment(finding.actual) + '</div>' : '';
        const details = [...(finding.differences || []), ...(finding.evidence || [])].map(line => '<div class="desc">' + esc(line) + '</div>').join('');
        return '<tr><td class="name">' + esc(finding.name) + '<span class="badge ' + badge[0] + '">' + badge[1] + '</span><div class="desc">common/' + esc(finding.folder) + '</div></td>'
          + '<td>' + expected + actual + '</td><td>' + details + '</td><td class="src">' + esc(finding.source) + ':' + finding.sourceLine + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  input.addEventListener('input', paint);
  wrap.querySelectorAll('[data-s]').forEach(el => el.addEventListener('change', paint));
  paint();
}

function renderShaderAbi() {
  const main = document.getElementById('main');
  const abi = DATA.shaderAbi;
  const wrap = document.createElement('div');
  const ABI_CAP = 400;
  const idParts = id => String(id).split('|');
  const idTable = (ids, badge) => {
    const shown = ids.slice(0, ABI_CAP);
    return '<table><thead><tr><th style="width:34%">Effect</th><th>Shader 文件</th></tr></thead><tbody>'
      + shown.map(id => {
        const parts = idParts(id);
        return '<tr><td class="name">' + esc(parts[0]) + (badge ? '<span class="badge ' + badge[0] + '">' + badge[1] + '</span>' : '') + '</td><td class="src">' + esc(parts[1] || '') + '</td></tr>';
      }).join('') + '</tbody></table>'
      + (ids.length > ABI_CAP ? '<div class="desc" style="padding:6px 0">… 仅显示前 ' + ABI_CAP + ' 条，共 ' + ids.length + ' 条（完整列表见 shader-abi-merge-report.json）</div>' : '');
  };
  const dropTable = rows => '<table><thead><tr><th style="width:26%">名称</th><th style="width:26%">Shader 文件</th><th>原因</th></tr></thead><tbody>'
    + rows.map(row => '<tr><td class="name">' + esc(row.name || row.renderer_subtype || '?') + '<span class="badge del">移除</span></td><td class="src">' + esc(row.shader_file || '') + '</td><td class="desc">' + esc(row.reason || '') + '</td></tr>').join('')
    + '</tbody></table>';
  wrap.innerHTML = '<div class="desc" style="margin-bottom:12px">'
    + 'Shader ABI 已随报告<b>自动合并</b>（无人工审核）写入 <span class="tag">config/shader/</span>：版本 ' + esc(abi.fromVersion) + ' → ' + esc(abi.toVersion)
    + ' · Effect 声明 ' + abi.declarations + '（唯一名称 ' + abi.uniqueNames + '）'
    + ' · 引擎 EXE ' + (abi.executableChanged ? '<span class="badge chg">已变化</span>' : '<span class="badge cwt">未变化</span>')
    + ' · 字符串扫描 ASCII ' + abi.asciiHits + ' / UTF-16 ' + abi.utf16Hits + '（仅候选信号）'
    + '</div>'
    + (abi.dropped.length ? '<details class="folder uncovered" open><summary>移除的 ABI 条目 ' + abi.dropped.length + '<span class="sub">声明已不存在，不再结转</span></summary><div class="body">' + dropTable(abi.dropped) + '</div></details>' : '')
    + (abi.contractsDropped.length ? '<details class="folder uncovered" open><summary>移除的渲染器契约 ' + abi.contractsDropped.length + '<span class="sub">Effect 在新语料中已不存在</span></summary><div class="body">' + dropTable(abi.contractsDropped) + '</div></details>' : '')
    + '<details class="folder"' + (abi.added.length && abi.added.length <= 40 ? ' open' : '') + '><summary>自动收录的 ABI 条目 ' + abi.added.length + '<span class="sub">evidence = automatic_inventory，rename_policy = forbidden</span></summary><div class="body">' + idTable(abi.added, ['add', '新增']) + '</div></details>'
    + '<details class="folder"><summary>结转的已审核条目 ' + abi.carried.length + '<span class="sub">保留原 evidence，版本已升级</span></summary><div class="body">' + (abi.carried.length ? idTable(abi.carried, null) : '<span class="desc">无</span>') + '</div></details>'
    + '<div class="desc" style="margin-top:8px">渲染器契约：保留 ' + abi.contractsKept + ' 条' + (abi.contractsSkipped ? '（未找到现有契约文件，已跳过）' : '') + '，移除 ' + abi.contractsDropped.length + ' 条。</div>';
  main.appendChild(wrap);
}

meta();
cards();
nav();
activate(tabs.find(t => t.count > 0)?.id || tabs[0].id);
</script>
</body>
</html>
`;
}

// ---------- main ----------

function parseArgs(argv: string[]) {
    const getArg = (name: string, fallback = '') => {
        const idx = argv.indexOf(name);
        return idx >= 0 && argv[idx + 1] ? path.resolve(argv[idx + 1]!) : fallback;
    };
    return {
        docs: getArg('--docs'),
        config: getArg('--config'),
        vanillaCommon: getArg('--vanilla-common'),
        shaderAbi: getArg('--shader-abi'),
        outDir: getArg('--output', path.resolve('rules-report')),
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.docs || !args.config) {
        console.error('Usage: npx ts-node tools/rules-sync/report.ts --docs <scriptDocsDir> --config <configDir> [--vanilla-common <dir>] [--shader-abi <mergeReport.json>] [--output <outDir>]');
        process.exit(1);
    }
    const baselineDir = path.join(args.config, 'logs');
    if (!fs.existsSync(baselineDir)) {
        console.error(`Baseline logs directory not found in config: ${baselineDir}`);
        process.exit(1);
    }

    const game = parseDocsDir(args.docs);
    const baseline = parseDocsDir(baselineDir);
    const cwtNames = scanCwtAliasNames(args.config);
    const kinds: RuleKind[] = ['trigger', 'effect', 'modifier', 'scope', 'localisation_command'];
    const diffs = kinds.map(kind => diffKind(kind, game, baseline, cwtNames));

    let folders: FolderFieldReport[] = [];
    if (args.vanillaCommon && fs.existsSync(args.vanillaCommon)) {
        const coverage = scanCwtCommonCoverage(args.config);
        const vanillaFolders = scanVanillaCommonFields(args.vanillaCommon);
        const dynamicNames = new Set<string>();
        for (const rule of game.values()) {
            if (rule.kind === 'modifier' || rule.kind === 'trigger' || rule.kind === 'effect') dynamicNames.add(rule.name.toLowerCase());
            // Scope links (owner, capital_scope, ...) are valid keys via engine scope navigation.
            if (rule.kind === 'scope') dynamicNames.add(rule.name.toLowerCase());
        }
        folders = buildFolderReports(vanillaFolders, coverage, dynamicNames);

        // Rule-generated modifiers (cwt "...$..." patterns and per-definition
        // families inferred from vanilla definition names) are auto-covered;
        // exclude them from the modifier comparison.
        const defNamesUnion = new Set<string>();
        for (const stats of vanillaFolders.values()) {
            for (const name of stats.defNames) defNamesUnion.add(name);
        }
        const allModifierNames = Array.from(game.values())
            .filter(rule => rule.kind === 'modifier')
            .map(rule => rule.name);
        const templates = inferGeneratedTemplates(allModifierNames, defNamesUnion);
        const modifierDiff = diffs.find(diff => diff.kind === 'modifier');
        if (modifierDiff) filterGeneratedModifiers(modifierDiff, templates, coverage.dollarPatterns, defNamesUnion);
    }

    const data: ReportData = {
        generatedAt: new Date().toISOString(),
        gameVersion: args.vanillaCommon ? detectGameVersion(args.vanillaCommon) : '',
        docsDir: args.docs,
        docsNewestMtime: newestMtime(args.docs),
        baselineDir,
        configDir: args.config,
        vanillaCommonDir: args.vanillaCommon,
        diffs,
        folders,
        scopeContracts: args.vanillaCommon && fs.existsSync(args.vanillaCommon)
            ? scanScopeContracts(args.vanillaCommon, args.config)
            : { gameVersion: '', contracts: [], findings: [], summary: { extracted: 0, highConfidence: 0, missing: 0, mismatch: 0, unresolved: 0 } },
        shaderAbi: args.shaderAbi ? readShaderAbiMergeReport(args.shaderAbi) : null,
    };

    fs.mkdirSync(args.outDir, { recursive: true });
    const htmlPath = path.join(args.outDir, 'rules-sync-report.html');
    const jsonPath = path.join(args.outDir, 'rules-sync-report.json');
    fs.writeFileSync(htmlPath, renderHtml(data), 'utf-8');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');

    for (const diff of diffs) {
        console.log(`[report] ${diff.kind}: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
    }
    console.log(`[report] folders with findings: ${folders.length}`);
    console.log(`[report] scope contracts: extracted=${data.scopeContracts.summary.extracted} high=${data.scopeContracts.summary.highConfidence} missing=${data.scopeContracts.summary.missing} mismatch=${data.scopeContracts.summary.mismatch} unresolved=${data.scopeContracts.summary.unresolved}`);
    if (data.shaderAbi) {
        const abi = data.shaderAbi;
        console.log(`[report] shader-abi: ${abi.fromVersion} -> ${abi.toVersion}, catalog carried=${abi.carried.length} added=${abi.added.length} dropped=${abi.dropped.length}, contracts kept=${abi.contractsKept} dropped=${abi.contractsDropped.length}`);
    }
    console.log(`Report: ${htmlPath}`);
}

if (require.main === module) main();
