import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

type RuleKind = 'effect' | 'trigger' | 'modifier' | 'scope' | 'localisation_command' | 'common_definition';
type Confidence = 'high' | 'medium' | 'low';
type SourceKind = 'log' | 'common' | 'cwt' | 'mixed';

interface GeneratedRule {
    name: string;
    kind: RuleKind;
    scopes: string[];
    targetScopes: string[];
    parameters: Array<{ name: string; type: string }>;
    description: string;
    source: string;
    sourceLine: number;
    confidence: Confidence;
    needsManualReview: boolean;
    occurrences?: number;
    category?: string;
    sourceKind?: SourceKind;
    logicalPath?: string;
    contentHash?: string;
    blockKind?: string;
}

interface RulesGenerated {
    game: string;
    version: string;
    generatedAt: string;
    sources: string[];
    effects: GeneratedRule[];
    triggers: GeneratedRule[];
    modifiers: GeneratedRule[];
    scopes: GeneratedRule[];
    localisationCommands: GeneratedRule[];
    commonDefinitions: GeneratedRule[];
}

interface CommonInputFile {
    filePath: string;
    root: string;
    sourceKind: 'common' | 'cwt';
}

interface ParsedBlock {
    rawKey: string;
    key: string;
    operator: string;
    text: string;
    sourceLine: number;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_\\.\\-]*';
const UNKNOWN_PATTERN = new RegExp(`\\b(?:unknown|unrecognized)\\s+(effect|trigger|modifier|scope)[:\\s]+["']?(${IDENT})["']?`, 'gi');
const NOT_KNOWN_PATTERN = new RegExp(`["']?(${IDENT})["']?\\s+is\\s+not\\s+a\\s+(?:known|valid)\\s+(effect|trigger|modifier)`, 'gi');
const CWTOOLS_PATTERN = new RegExp(`Unexpected\\s+(${IDENT})\\s+(effect|trigger)`, 'gi');
const TOP_LEVEL_CWT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_.-]*|alias\[(?:effect|trigger|modifier):[A-Za-z_][A-Za-z0-9_.-]*\])\s*(=|==)\s*/;
const TOP_LEVEL_PDX_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(=|==)\s*/;
const TYPE_PATTERN = /^\s*(type\[[A-Za-z_][A-Za-z0-9_.-]*\])\s*=\s*/;
const SCRIPT_COMMON_CONTENT_FOLDERS = new Set([
    'scripted_effects',
    'scripted_triggers',
    'scripted_modifiers',
    'scripted_variables',
    'script_values',
    'static_modifiers',
]);

function readText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

function readLines(filePath: string): string[] {
    return readText(filePath).split('\n');
}

function walkFiles(inputPath: string, predicate: (filePath: string) => boolean): string[] {
    if (!fs.existsSync(inputPath)) return [];
    const stat = fs.statSync(inputPath);
    if (stat.isFile()) return predicate(inputPath) ? [inputPath] : [];

    const results: string[] = [];
    for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
        const fullPath = path.join(inputPath, entry.name);
        if (entry.isDirectory()) {
            if (!shouldSkipDirectory(entry.name)) results.push(...walkFiles(fullPath, predicate));
        } else if (predicate(fullPath)) {
            results.push(fullPath);
        }
    }
    return results;
}

function shouldSkipDirectory(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === '.git'
        || lower === 'node_modules'
        || lower === 'rules-generated'
        || lower === 'generated-sync'
        || lower === '.codex-smoke';
}

function listLogInputFiles(inputPath: string | undefined): string[] {
    if (!inputPath) return [];
    return walkFiles(inputPath, file => /\.(log|txt)$/i.test(file));
}

function listCommonInputFiles(commonInputs: string[]): CommonInputFile[] {
    const seen = new Map<string, CommonInputFile>();
    for (const root of commonInputs) {
        for (const filePath of walkFiles(root, file => /\.(txt|cwt)$/i.test(file))) {
            const resolved = path.resolve(filePath);
            const ext = path.extname(filePath).toLowerCase();
            seen.set(resolved, {
                filePath,
                root,
                sourceKind: ext === '.cwt' ? 'cwt' : 'common',
            });
        }
    }
    return Array.from(seen.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function splitScopes(value: string): string[] {
    return value.trim().split(/\s+/).filter(Boolean);
}

function mergeSourceKind(existing: SourceKind | undefined, incoming: SourceKind | undefined): SourceKind | undefined {
    if (!existing) return incoming;
    if (!incoming || existing === incoming) return existing;
    return 'mixed';
}

function confidenceRank(confidence: Confidence): number {
    switch (confidence) {
        case 'high': return 3;
        case 'medium': return 2;
        case 'low': return 1;
    }
}

function addRule(map: Map<string, GeneratedRule>, rule: GeneratedRule) {
    const key = `${rule.kind}:${rule.name.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
        map.set(key, rule);
        return;
    }

    existing.occurrences = (existing.occurrences ?? 1) + (rule.occurrences ?? 1);
    existing.scopes = Array.from(new Set([...existing.scopes, ...rule.scopes]));
    existing.targetScopes = Array.from(new Set([...existing.targetScopes, ...rule.targetScopes]));
    existing.parameters = mergeParameters(existing.parameters, rule.parameters);
    existing.sourceKind = mergeSourceKind(existing.sourceKind, rule.sourceKind);
    if (!existing.description && rule.description) existing.description = rule.description;
    if (confidenceRank(rule.confidence) > confidenceRank(existing.confidence)) existing.confidence = rule.confidence;
    existing.needsManualReview = existing.needsManualReview || rule.needsManualReview;
    if (!existing.category && rule.category) existing.category = rule.category;
    if (!existing.logicalPath && rule.logicalPath) existing.logicalPath = rule.logicalPath;
    if (!existing.contentHash && rule.contentHash) existing.contentHash = rule.contentHash;
    if (!existing.blockKind && rule.blockKind) existing.blockKind = rule.blockKind;
}

function mergeParameters(left: Array<{ name: string; type: string }>, right: Array<{ name: string; type: string }>): Array<{ name: string; type: string }> {
    const map = new Map<string, string>();
    for (const param of left) map.set(param.name, param.type);
    for (const param of right) {
        if (!map.has(param.name)) map.set(param.name, param.type);
    }
    return Array.from(map, ([name, type]) => ({ name, type }));
}

function parseUnknowns(filePath: string, lines: string[], map: Map<string, GeneratedRule>) {
    const source = path.basename(filePath);
    const addUnknown = (name: string, rawKind: string, lineIndex: number, lineText: string) => {
        const kind = rawKind.toLowerCase() as RuleKind;
        if (!['effect', 'trigger', 'modifier', 'scope'].includes(kind)) return;
        addRule(map, {
            name: name.toLowerCase(),
            kind,
            scopes: [],
            targetScopes: [],
            parameters: [],
            description: lineText.trim().slice(0, 240),
            source,
            sourceLine: lineIndex + 1,
            confidence: 'low',
            needsManualReview: true,
            occurrences: 1,
            sourceKind: 'log',
        });
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        UNKNOWN_PATTERN.lastIndex = 0;
        NOT_KNOWN_PATTERN.lastIndex = 0;
        CWTOOLS_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = UNKNOWN_PATTERN.exec(line))) addUnknown(match[2]!, match[1]!, i, line);
        while ((match = NOT_KNOWN_PATTERN.exec(line))) addUnknown(match[1]!, match[2]!, i, line);
        while ((match = CWTOOLS_PATTERN.exec(line))) addUnknown(match[1]!, match[2]!, i, line);
    }
}

function parseScriptDocs(filePath: string, lines: string[], map: Map<string, GeneratedRule>) {
    parseScriptDocSections(filePath, lines, map, 'effect', /EFFECT DOCUMENTATION/i);
    parseScriptDocSections(filePath, lines, map, 'trigger', /TRIGGER DOCUMENTATION/i);
}

function parseScriptDocSections(filePath: string, lines: string[], map: Map<string, GeneratedRule>, kind: Extract<RuleKind, 'effect' | 'trigger'>, titlePattern: RegExp) {
    const source = path.basename(filePath);
    for (let titleLine = 0; titleLine < lines.length; titleLine++) {
        if (!titlePattern.test(lines[titleLine] ?? '')) continue;
        const endLine = findNextDocumentationHeader(lines, titleLine + 1);
        parseScriptDocSection(source, lines, map, kind, titleLine + 1, endLine);
    }
}

function findNextDocumentationHeader(lines: string[], start: number): number {
    for (let i = start; i < lines.length; i++) {
        if (/==\s*[A-Z_ ]+\s+DOCUMENTATION\s*==/i.test(lines[i] ?? '')) return i;
    }
    return lines.length;
}

function parseScriptDocSection(source: string, lines: string[], map: Map<string, GeneratedRule>, kind: Extract<RuleKind, 'effect' | 'trigger'>, startLine: number, endLine: number) {
    for (let i = startLine; i < endLine; i++) {
        const line = lines[i] ?? '';
        const nameMatch = line.match(new RegExp(`^(${IDENT})\\s+-\\s+(.+)$`));
        if (!nameMatch) continue;

        const name = nameMatch[1]!;
        const description = nameMatch[2]!.trim();
        let supportedScopes: string[] = [];
        let usage = '';
        let j = i + 1;
        while (j < endLine && !(lines[j] ?? '').match(new RegExp(`^(${IDENT})\\s+-\\s+`))) {
            const inner = lines[j] ?? '';
            const scopeMatch = inner.match(/^Supported Scopes:\s*(.+)$/i);
            if (scopeMatch) supportedScopes = splitScopes(scopeMatch[1]!);
            else if (inner.trim()) usage += `${inner.trim()}\n`;
            j++;
        }
        addRule(map, {
            name,
            kind,
            scopes: supportedScopes,
            targetScopes: [],
            parameters: inferParameters(usage),
            description,
            source,
            sourceLine: i + 1,
            confidence: supportedScopes.length > 0 ? 'high' : 'medium',
            needsManualReview: supportedScopes.length === 0,
            sourceKind: 'log',
        });
        i = j - 1;
    }
}

function parseModifiers(filePath: string, lines: string[], map: Map<string, GeneratedRule>) {
    const source = path.basename(filePath);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const match = line.match(new RegExp(`^-\\s+(${IDENT}),\\s+Category:\\s+(.+)$`, 'i'));
        if (!match) continue;
        addRule(map, {
            name: match[1]!,
            kind: 'modifier',
            scopes: [],
            targetScopes: [],
            parameters: [{ name: 'value', type: 'float' }],
            description: `Category: ${match[2]!.trim()}`,
            source,
            sourceLine: i + 1,
            confidence: 'high',
            needsManualReview: false,
            category: match[2]!.trim(),
            sourceKind: 'log',
        });
    }
}

function parseScopes(filePath: string, lines: string[], map: Map<string, GeneratedRule>) {
    const source = path.basename(filePath);
    const titleLine = lines.findIndex(line => /SCOPE DOCUMENTATION/i.test(line));
    if (titleLine < 0) return;
    for (let i = titleLine + 1; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const nameMatch = line.match(new RegExp(`^(${IDENT})\\s+-\\s+(.+)$`));
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
        addRule(map, {
            name: nameMatch[1]!,
            kind: 'scope',
            scopes: supportedScopes,
            targetScopes: outputScope ? [outputScope] : [],
            parameters: [],
            description: nameMatch[2]!.trim(),
            source,
            sourceLine: i + 1,
            confidence: outputScope ? 'high' : 'medium',
            needsManualReview: !outputScope,
            sourceKind: 'log',
        });
    }
}

function parseLocalisationCommands(filePath: string, lines: string[], map: Map<string, GeneratedRule>) {
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
        addRule(map, {
            name: line,
            kind: 'localisation_command',
            scopes: currentScope ? [currentScope] : [],
            targetScopes: section === 'promotions' ? ['scope'] : [],
            parameters: [],
            description: `${section} for ${currentScope}`,
            source,
            sourceLine: i + 1,
            confidence: 'medium',
            needsManualReview: false,
            sourceKind: 'log',
        });
    }
}

function parseCommonFile(input: CommonInputFile, map: Map<string, GeneratedRule>) {
    const content = readText(input.filePath);
    const relPath = toPosix(path.relative(input.root, input.filePath)) || path.basename(input.filePath);
    const blockKind = inferBlockKind(input, relPath);
    if (input.sourceKind === 'common' && shouldSkipCommonContentFolder(blockKind)) return;

    if (input.sourceKind === 'cwt') {
        for (const block of extractBlocks(content, TOP_LEVEL_CWT_PATTERN, true)) {
            if (block.rawKey === 'types') continue;
            addCommonBlockRule(input, relPath, block, map);
        }
        for (const block of extractBlocks(content, TYPE_PATTERN, false)) {
            addCommonBlockRule(input, relPath, block, map);
        }
        return;
    }

    for (const block of extractBlocks(content, TOP_LEVEL_PDX_PATTERN, true)) {
        if (block.rawKey === 'namespace') continue;
        addCommonBlockRule(input, relPath, block, map);
    }
}

function addCommonBlockRule(input: CommonInputFile, relPath: string, block: ParsedBlock, map: Map<string, GeneratedRule>) {
    const alias = parseAliasKey(block.rawKey);
    const blockKind = inferBlockKind(input, relPath);
    const kind = inferCommonRuleKind();
    const logicalPath = `${relPath}#${block.rawKey}`;
    const hash = hashDefinition(block.text);
    const commonDefinitionName = alias
        ? `alias:${alias.kind}:${alias.name}`
        : block.rawKey.startsWith('type[')
        ? `type:${block.key}`
        : `${blockKind}:${block.key}`;
    const name = commonDefinitionName;
    const cwtDefinition = input.sourceKind === 'cwt';
    const description = cwtDefinition
        ? `${block.rawKey.startsWith('alias[') ? 'CWT alias' : 'CWT definition'} from ${relPath}`
        : `Common ${blockKind} block from ${relPath}`;

    addRule(map, {
        name,
        kind,
        scopes: [],
        targetScopes: [],
        parameters: [],
        description,
        source: relPath,
        sourceLine: block.sourceLine,
        confidence: cwtDefinition ? 'high' : 'medium',
        needsManualReview: true,
        sourceKind: input.sourceKind,
        logicalPath,
        contentHash: hash,
        blockKind,
    });
}

function inferCommonRuleKind(): RuleKind {
    return 'common_definition';
}

function shouldSkipCommonContentFolder(blockKind: string): boolean {
    return SCRIPT_COMMON_CONTENT_FOLDERS.has(blockKind.toLowerCase());
}

function inferBlockKind(input: CommonInputFile, relPath: string): string {
    const parts = relPath.split('/').filter(Boolean);
    const lowerParts = parts.map(part => part.toLowerCase());
    const commonIndex = lowerParts.lastIndexOf('common');
    if (commonIndex >= 0 && parts[commonIndex + 1]) return parts[commonIndex + 1]!.toLowerCase();
    if (input.sourceKind === 'cwt' && parts.length === 1) return path.basename(parts[0]!, path.extname(parts[0]!)).toLowerCase();
    if (parts.length > 1) return parts[0]!.toLowerCase();
    return path.basename(path.dirname(input.filePath)).toLowerCase();
}

function parseAliasKey(rawKey: string): { kind: Extract<RuleKind, 'effect' | 'trigger' | 'modifier'>; name: string } | undefined {
    const match = rawKey.match(/^alias\[(effect|trigger|modifier):([A-Za-z_][A-Za-z0-9_.-]*)\]$/);
    if (!match) return undefined;
    return { kind: match[1] as Extract<RuleKind, 'effect' | 'trigger' | 'modifier'>, name: match[2]! };
}

function extractBlocks(content: string, pattern: RegExp, topLevelOnly: boolean): ParsedBlock[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const blocks: ParsedBlock[] = [];
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const stripped = stripLineComment(line);
        const match = stripped.match(pattern);
        if (match && (!topLevelOnly || depth === 0)) {
            const rawKey = match[1]!;
            const operator = match[2] ?? '=';
            const startDepth = depth;
            const captured = [line];
            let blockDepth = depth + countBraceDelta(line);
            let hasBrace = stripped.includes('{') || stripped.includes('}');
            let end = i;
            while (hasBrace && blockDepth > startDepth && end + 1 < lines.length) {
                end++;
                const nextLine = lines[end] ?? '';
                captured.push(nextLine);
                blockDepth += countBraceDelta(nextLine);
            }
            blocks.push({
                rawKey,
                key: normalizeBlockKey(rawKey),
                operator,
                text: captured.join('\n'),
                sourceLine: i + 1,
            });
            depth = Math.max(0, blockDepth);
            i = end;
            continue;
        }

        depth += countBraceDelta(line);
        if (depth < 0) depth = 0;
    }

    return blocks;
}

function normalizeBlockKey(rawKey: string): string {
    const alias = parseAliasKey(rawKey);
    if (alias) return alias.name;
    const typeMatch = rawKey.match(/^type\[([A-Za-z_][A-Za-z0-9_.-]*)\]$/);
    if (typeMatch) return typeMatch[1]!;
    return rawKey;
}

function stripLineComment(line: string): string {
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
            if (ch === '\\') {
                i++;
            } else if (ch === quote) {
                quote = undefined;
            }
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
            if (ch === '\\') {
                i++;
            } else if (ch === quote) {
                quote = undefined;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '{') {
            delta++;
        } else if (ch === '}') {
            delta--;
        }
    }
    return delta;
}

function hashDefinition(text: string): string {
    return crypto.createHash('sha256').update(normalizeDefinitionText(text)).digest('hex').slice(0, 16);
}

function normalizeDefinitionText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => stripLineComment(line).trim())
        .filter(Boolean)
        .join('\n');
}

function toPosix(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function inferParameters(usage: string): Array<{ name: string; type: string }> {
    const params = new Map<string, string>();
    for (const match of usage.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*<([^>]+)>/g)) {
        params.set(match[1]!, match[2]!.trim());
    }
    for (const match of usage.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)) {
        const name = match[1]!;
        if (!params.has(name)) params.set(name, 'scalar');
    }
    return Array.from(params, ([name, type]) => ({ name, type }));
}

function buildRules(logFiles: string[], commonFiles: CommonInputFile[], game: string, version: string): RulesGenerated {
    const map = new Map<string, GeneratedRule>();
    for (const file of logFiles) {
        const lines = readLines(file);
        parseUnknowns(file, lines, map);
        parseScriptDocs(file, lines, map);
        parseModifiers(file, lines, map);
        parseScopes(file, lines, map);
        parseLocalisationCommands(file, lines, map);
    }
    for (const file of commonFiles) {
        parseCommonFile(file, map);
    }

    const allRules = Array.from(map.values()).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const byKind = (kind: RuleKind) => allRules.filter(rule => rule.kind === kind);
    return {
        game,
        version,
        generatedAt: new Date().toISOString(),
        sources: [
            ...logFiles.map(file => path.resolve(file)),
            ...commonFiles.map(file => path.resolve(file.filePath)),
        ],
        effects: byKind('effect'),
        triggers: byKind('trigger'),
        modifiers: byKind('modifier'),
        scopes: byKind('scope'),
        localisationCommands: byKind('localisation_command'),
        commonDefinitions: byKind('common_definition'),
    };
}

function writeCwt(outDir: string, rules: RulesGenerated) {
    const generatedDir = path.join(outDir, 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    writeFileIfChanged(path.join(generatedDir, 'effects.generated.cwt'), renderAliasRules('effect', renderableRules(rules.effects)));
    writeFileIfChanged(path.join(generatedDir, 'triggers.generated.cwt'), renderAliasRules('trigger', renderableRules(rules.triggers)));
    writeFileIfChanged(path.join(generatedDir, 'localisation_commands.generated.cwt'), renderLocalisationRules(rules.localisationCommands));
    writeFileIfChanged(path.join(generatedDir, 'common_definitions.inventory.cwt'), renderCommonDefinitionInventory(rules.commonDefinitions));
}

function renderableRules<T extends GeneratedRule>(rules: T[]): T[] {
    return rules.filter(rule => rule.sourceKind !== 'cwt');
}

function header(kind: string): string {
    return `# <auto-generated:${kind}>\n# Generated by tools/rules-sync/parse-log.ts. Review before merging into stable CWT.\n\n`;
}

function renderAliasRules(kind: 'effect' | 'trigger', rules: GeneratedRule[]): string {
    const lines = [header(`${kind}s`)];
    for (const rule of rules) {
        lines.push(`### ${rule.description || `Generated ${kind}`}`);
        if (rule.scopes.length) lines.push(`## supported_scopes = ${rule.scopes.join(' ')}`);
        if (rule.needsManualReview) lines.push('## needs_manual_review = yes');
        lines.push(`alias[${kind}:${rule.name}] = {`);
        if (rule.parameters.length) {
            for (const param of rule.parameters) lines.push(`\t## parameter ${param.name}: ${param.type}`);
        }
        lines.push(`\t# TODO: verify parameters and nested ${kind}s`);
        lines.push('}');
        lines.push('');
    }
    lines.push(`# </auto-generated:${kind}s>\n`);
    return lines.join('\n');
}

function renderLocalisationRules(rules: GeneratedRule[]): string {
    const lines = [header('localisation_commands')];
    for (const rule of rules) {
        lines.push(`## ${rule.description}`);
        lines.push(`# ${rule.scopes.join('.')}.${rule.name}`);
    }
    lines.push('\n# </auto-generated:localisation_commands>\n');
    return lines.join('\n');
}

function renderCommonDefinitionInventory(rules: GeneratedRule[]): string {
    const lines = [header('common_definitions')];
    for (const rule of rules) {
        lines.push(`### ${rule.name}`);
        lines.push(`## source = ${rule.source}:${rule.sourceLine}`);
        if (rule.logicalPath) lines.push(`## logical_path = ${rule.logicalPath}`);
        if (rule.contentHash) lines.push(`## content_hash = ${rule.contentHash}`);
        lines.push('# TODO: review this common definition block and update the matching stable CWT file if needed.');
        lines.push('');
    }
    lines.push('# </auto-generated:common_definitions>\n');
    return lines.join('\n');
}

function writeFileIfChanged(filePath: string, content: string) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8') === content) return;
    fs.writeFileSync(filePath, content, 'utf-8');
}

function parseArgs(argv: string[]) {
    let input = '';
    let outDir = '';
    let game = 'stellaris';
    let version = 'unknown';
    const commonInputs: string[] = [];
    let emitCwt = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        switch (arg) {
            case '--output':
                outDir = argv[++i] ?? '';
                break;
            case '--game':
                game = argv[++i] ?? game;
                break;
            case '--version':
                version = argv[++i] ?? version;
                break;
            case '--common':
                commonInputs.push(argv[++i] ?? '');
                break;
            case '--emit-cwt':
                emitCwt = true;
                break;
            default:
                if (!arg.startsWith('--') && !input) input = arg;
                break;
        }
    }

    const fallbackBase = input || commonInputs[0] || 'rules-generated';
    return {
        input,
        commonInputs: commonInputs.filter(Boolean),
        outDir: outDir || path.join(path.dirname(fallbackBase), 'rules-generated'),
        game,
        version,
        emitCwt,
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.input && args.commonInputs.length === 0) {
        console.error('Usage: npx ts-node tools/rules-sync/parse-log.ts [logFileOrDir] [--common <commonDirOrFile> ...] [--output <outDir>] [--game stellaris] [--version x.y.z] [--emit-cwt]');
        process.exit(1);
    }
    const logFiles = listLogInputFiles(args.input);
    const commonFiles = listCommonInputFiles(args.commonInputs);
    if (logFiles.length + commonFiles.length === 0) {
        console.error(`No supported input files found. logs=${args.input || '<none>'} common=${args.commonInputs.join(',') || '<none>'}`);
        process.exit(1);
    }
    fs.mkdirSync(args.outDir, { recursive: true });
    const rules = buildRules(logFiles, commonFiles, args.game, args.version);
    writeFileIfChanged(path.join(args.outDir, 'rules.generated.json'), JSON.stringify(rules, null, 2) + '\n');
    if (args.emitCwt) writeCwt(args.outDir, rules);
    console.log(`Generated ${path.join(args.outDir, 'rules.generated.json')}`);
    console.log(`effects=${rules.effects.length} triggers=${rules.triggers.length} modifiers=${rules.modifiers.length} scopes=${rules.scopes.length} localisationCommands=${rules.localisationCommands.length} commonDefinitions=${rules.commonDefinitions.length}`);
}

main();
