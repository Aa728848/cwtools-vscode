import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ScopeContractFolder = 'on_actions' | 'game_rules';
export type ScopeContractStatus = 'missing' | 'mismatch' | 'unresolved';

export interface ScopeEnvironment {
    this?: string;
    root?: string;
    from: string[];
}

export interface ScopeContract {
    name: string;
    folder: ScopeContractFolder;
    scope: ScopeEnvironment;
    source: string;
    sourceLine: number;
    evidence: string[];
    contentHash: string;
    sourceKind: 'vanilla_comment';
    confidence: 'high' | 'medium';
    unresolved: string[];
}

export interface CwtScopeContract {
    name: string;
    folder: ScopeContractFolder;
    scope: ScopeEnvironment;
    source: string;
    sourceLine: number;
}

export interface ScopeContractFinding {
    status: ScopeContractStatus;
    name: string;
    folder: ScopeContractFolder;
    source: string;
    sourceLine: number;
    expected?: ScopeEnvironment;
    actual?: ScopeEnvironment;
    differences?: string[];
    evidence: string[];
    confidence: 'high' | 'medium';
}

export interface ScopeContractReport {
    gameVersion: string;
    contracts: ScopeContract[];
    findings: ScopeContractFinding[];
    summary: {
        extracted: number;
        highConfidence: number;
        missing: number;
        mismatch: number;
        unresolved: number;
    };
}

interface CommentLine {
    line: number;
    text: string;
}

const FOLDERS: ScopeContractFolder[] = ['on_actions', 'game_rules'];
const FIELD_NAME_PATTERN = String.raw`root\s*(?:\/|,)\s*this|this\s*(?:\/|,)\s*root|scope|this|root|from(?:(?:\s*from)|from){0,3}`;
const CWT_FIELD_PATTERN = /\b(this|root|fromfromfromfrom|fromfromfrom|fromfrom|from)\s*=\s*"?([A-Za-z_][A-Za-z0-9_.-]*)"?/gi;

const SCOPE_SYNONYMS = new Map<string, string>([
    ['empire', 'country'],
    ['nation', 'country'],
    ['galactic object', 'system'],
    ['solar system', 'system'],
    ['astral rift', 'astral_rift'],
    ['pop group', 'pop_group'],
    ['pop faction', 'pop_faction'],
    ['archaeological site', 'archaeological_site'],
    ['ambient object', 'ambient_object'],
    ['cosmic storm', 'cosmic_storm'],
]);

// Vanilla comments frequently name a participant's role rather than its
// engine scope. Keep these mappings explicit and evidence-driven instead of
// guessing from arbitrary prose.
const ROLE_SCOPE_SYNONYMS = new Map<string, string>([
    ['imperium leader country', 'country'],
    ['opponent war leader', 'country'],
    ['winner warleader', 'country'],
    ['loser warleader', 'country'],
    ['main attacker', 'country'],
    ['main defender', 'country'],
    ['main winner', 'country'],
    ['main ally', 'country'],
    ['federation leader', 'country'],
    ['joining member', 'country'],
    ['leaving member', 'country'],
    ['operation target', 'country'],
    ['released vassal', 'country'],
    ['subjects overlord', 'country'],
    ['target of the truce', 'country'],
    ['target if valid', 'country'],
    ['previous ruler', 'leader'],
    ['biggest fleet bombarding', 'fleet'],
    ['claimer', 'country'],
    ['winner', 'country'],
    ['loser', 'country'],
    ['subject', 'country'],
    ['overlord', 'country'],
    ['receiver', 'country'],
    ['sender', 'country'],
    ['instigator', 'country'],
    ['victim', 'country'],
    ['proposer', 'country'],
    ['vetoer', 'country'],
    ['actor', 'country'],
    ['recipient', 'country'],
    ['bombarder', 'country'],
    ['opponent', 'army'],
    ['station', 'ship'],
    ['heir', 'leader'],
    ['storm', 'cosmic_storm'],
    ['arkship', 'carrier'],
]);

const POLYMORPHIC_SCOPE_COMBINATIONS = new Map<string, string>([
    ['planet|ship', 'carrier'],
    ['astral_rift|planet', 'planet_astral_rift'],
    ['megastructure|planet|starbase', 'repairable_orbital'],
    ['astral_rift|megastructure|planet|starbase', 'orbital_location'],
    ['fleet|planet', 'planet_fleet'],
]);
const POLYMORPHIC_SCOPE_NAMES = new Set(POLYMORPHIC_SCOPE_COMBINATIONS.values());

export function scanScopeContracts(vanillaCommonDir: string, configDir: string): ScopeContractReport {
    const aliases = loadScopeAliases(path.join(configDir, 'scopes.cwt'));
    const contracts: ScopeContract[] = [];
    const cwtContracts = new Map<string, CwtScopeContract>();

    for (const folder of FOLDERS) {
        const vanillaDir = path.join(vanillaCommonDir, folder);
        if (fs.existsSync(vanillaDir)) {
            for (const file of walkFiles(vanillaDir, candidate => candidate.toLowerCase().endsWith('.txt'))) {
                const source = toPosix(path.relative(vanillaCommonDir, file));
                contracts.push(...extractScopeContractsFromText(fs.readFileSync(file, 'utf-8'), source, folder, aliases));
            }
        }

        const cwtFile = path.join(configDir, 'common', `${folder}.cwt`);
        if (fs.existsSync(cwtFile)) {
            const source = toPosix(path.relative(configDir, cwtFile));
            for (const contract of parseCwtScopeContracts(fs.readFileSync(cwtFile, 'utf-8'), source, folder, aliases)) {
                cwtContracts.set(contractKey(folder, contract.name), contract);
            }
        }
    }

    contracts.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
    const findings = compareScopeContracts(contracts, cwtContracts);
    return {
        gameVersion: detectGameVersion(vanillaCommonDir),
        contracts,
        findings,
        summary: {
            extracted: contracts.length,
            highConfidence: contracts.filter(contract => contract.confidence === 'high').length,
            missing: findings.filter(finding => finding.status === 'missing').length,
            mismatch: findings.filter(finding => finding.status === 'mismatch').length,
            unresolved: findings.filter(finding => finding.status === 'unresolved').length,
        },
    };
}

function detectGameVersion(vanillaCommonDir: string): string {
    try {
        const settingsFile = path.join(path.dirname(vanillaCommonDir), 'launcher-settings.json');
        if (!fs.existsSync(settingsFile)) return '';
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { rawVersion?: string; version?: string };
        return settings.rawVersion || settings.version || '';
    } catch {
        return '';
    }
}

export function extractScopeContractsFromText(
    content: string,
    source: string,
    folder: ScopeContractFolder,
    aliases: ReadonlyMap<string, string>,
): ScopeContract[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const contracts: ScopeContract[] = [];
    let depth = 0;
    let pendingComments: CommentLine[] = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        const script = stripScriptComment(line);

        if (depth === 0) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) {
                pendingComments.push({ line: index + 1, text: trimmed.replace(/^#+\s*/, '').trim() });
            } else {
                const definition = script.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*\{/);
                if (definition) {
                    const parsed = contractFromComments(definition[1]!, folder, source, index + 1, pendingComments, aliases);
                    if (parsed) contracts.push(parsed);
                    pendingComments = [];
                } else if (trimmed !== '') {
                    pendingComments = [];
                }
            }
        }

        depth += countBraceDelta(script);
        if (depth < 0) depth = 0;
    }

    return contracts;
}

export function parseCwtScopeContracts(
    content: string,
    source: string,
    folder: ScopeContractFolder,
    aliases: ReadonlyMap<string, string> = new Map(),
): CwtScopeContract[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const contracts: CwtScopeContract[] = [];
    let pendingName = '';
    let pendingScope: ScopeEnvironment | undefined;
    let pendingLine = 0;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        const filter = line.match(/^\s*##\s*type_key_filter\s*=\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*$/);
        if (filter) {
            pendingName = filter[1]!;
            pendingScope = undefined;
            pendingLine = index + 1;
            continue;
        }

        const replace = line.match(/^\s*##\s*replace_scope\s*=\s*\{(.*)\}\s*$/);
        if (pendingName && replace) {
            pendingScope = parseCwtEnvironment(replace[1]!, aliases);
            pendingLine = index + 1;
            continue;
        }

        const subtype = line.match(/^\s*subtype\[([A-Za-z_][A-Za-z0-9_.-]*)\]\s*=\s*\{/);
        if (!subtype) continue;
        if (pendingName && subtype[1]!.toLowerCase() === pendingName.toLowerCase() && pendingScope) {
            contracts.push({
                name: pendingName,
                folder,
                scope: pendingScope,
                source,
                sourceLine: pendingLine,
            });
        }
        pendingName = '';
        pendingScope = undefined;
        pendingLine = 0;
    }

    return contracts;
}

export function compareScopeContracts(
    contracts: ScopeContract[],
    cwtContracts: ReadonlyMap<string, CwtScopeContract>,
): ScopeContractFinding[] {
    const findings: ScopeContractFinding[] = [];
    for (const contract of contracts) {
        if (contract.unresolved.length) {
            findings.push({
                status: 'unresolved',
                name: contract.name,
                folder: contract.folder,
                source: contract.source,
                sourceLine: contract.sourceLine,
                expected: contract.scope,
                differences: contract.unresolved,
                evidence: contract.evidence,
                confidence: contract.confidence,
            });
        }

        if (contract.confidence !== 'high') continue;
        const actual = cwtContracts.get(contractKey(contract.folder, contract.name));
        if (!actual) {
            findings.push({
                status: 'missing',
                name: contract.name,
                folder: contract.folder,
                source: contract.source,
                sourceLine: contract.sourceLine,
                expected: contract.scope,
                evidence: contract.evidence,
                confidence: contract.confidence,
            });
            continue;
        }

        const differences = compareEnvironments(contract.scope, actual.scope);
        if (differences.length) {
            findings.push({
                status: 'mismatch',
                name: contract.name,
                folder: contract.folder,
                source: contract.source,
                sourceLine: contract.sourceLine,
                expected: contract.scope,
                actual: actual.scope,
                differences,
                evidence: contract.evidence,
                confidence: contract.confidence,
            });
        }
    }
    return findings;
}

export function renderReplaceScope(scope: ScopeEnvironment): string {
    const fields: string[] = [];
    if (scope.this) fields.push(`this = ${scope.this}`);
    if (scope.root) fields.push(`root = ${scope.root}`);
    scope.from.forEach((value, index) => fields.push(`${'from'.repeat(index + 1)} = ${value}`));
    return `## replace_scope = { ${fields.join(' ')} }`;
}

export function addMissingCwtScopeContracts(
    content: string,
    folder: ScopeContractFolder,
    contracts: ScopeContract[],
    options: { aliases?: ReadonlyMap<string, string>; replaceConflicts?: boolean } = {},
): { content: string; added: string[] } {
    const existing = new Map<string, CwtScopeContract>();
    for (const contract of parseCwtScopeContracts(content, `${folder}.cwt`, folder, options.aliases)) {
        existing.set(contractKey(folder, contract.name), contract);
    }
    const candidates = new Map<string, { contract: ScopeContract; scope: ScopeEnvironment; replace: boolean }>();
    for (const contract of contracts) {
        if (contract.folder !== folder || contract.confidence !== 'high') continue;
        const actual = existing.get(contractKey(folder, contract.name));
        if (!actual) {
            candidates.set(contract.name.toLowerCase(), { contract, scope: contract.scope, replace: false });
            continue;
        }
        if (options.replaceConflicts && compareEnvironments(contract.scope, actual.scope).length) {
            candidates.set(contract.name.toLowerCase(), { contract, scope: contract.scope, replace: true });
            continue;
        }
        const augmented = augmentEnvironment(contract.scope, actual.scope);
        if (augmented) candidates.set(contract.name.toLowerCase(), { contract, scope: augmented, replace: true });
    }
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const output: string[] = [];
    const added: string[] = [];
    let pendingReplacement: { contract: ScopeContract; scope: ScopeEnvironment; replace: boolean } | undefined;

    for (const line of lines) {
        if (pendingReplacement?.replace && /^\s*##\s*replace_scope\s*=/.test(line)) {
            const indent = line.match(/^(\s*)/)?.[1] ?? '';
            output.push(`${indent}${renderReplaceScope(pendingReplacement.scope)}`);
            added.push(pendingReplacement.contract.name);
            pendingReplacement = undefined;
            continue;
        }
        output.push(line);
        const filter = line.match(/^(\s*)##\s*type_key_filter\s*=\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*$/);
        if (!filter) {
            if (pendingReplacement && !/^\s*(?:#.*)?$/.test(line)) pendingReplacement = undefined;
            continue;
        }
        const candidate = candidates.get(filter[2]!.toLowerCase());
        if (!candidate) {
            pendingReplacement = undefined;
            continue;
        }
        if (candidate.replace) {
            pendingReplacement = candidate;
        } else {
            output.push(`${filter[1]}${renderReplaceScope(candidate.scope)}`);
            added.push(candidate.contract.name);
            pendingReplacement = undefined;
        }
    }

    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    return { content: output.join(newline), added };
}

function augmentEnvironment(expected: ScopeEnvironment, actual: ScopeEnvironment): ScopeEnvironment | undefined {
    if (expected.this && actual.this && expected.this !== actual.this) return undefined;
    if (expected.root && actual.root && expected.root !== actual.root) return undefined;
    for (let index = 0; index < expected.from.length; index++) {
        if (actual.from[index] && expected.from[index] !== actual.from[index]) return undefined;
    }

    const merged: ScopeEnvironment = {
        this: actual.this ?? expected.this,
        root: actual.root ?? expected.root,
        from: [...actual.from],
    };
    expected.from.forEach((value, index) => {
        if (!merged.from[index]) merged.from[index] = value;
    });
    return compareEnvironments(expected, actual).some(difference => difference.includes('(missing)')) ? merged : undefined;
}

export function loadScopeAliases(scopesFile: string): Map<string, string> {
    const aliases = new Map<string, string>();
    if (!fs.existsSync(scopesFile)) return aliases;
    const content = fs.readFileSync(scopesFile, 'utf-8');
    const definitions = content.matchAll(
        /(?:^|\r?\n)\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_.-]*))\s*=\s*\{\s*aliases\s*=\s*\{([^}]*)\}/gi,
    );
    for (const match of definitions) {
        const displayName = match[1] ?? match[2]!;
        const values = Array.from(match[3]!.matchAll(/"([^"]+)"|([A-Za-z_][A-Za-z0-9_.-]*)/g))
            .map(value => (value[1] ?? value[2]!).toLowerCase());
        if (!values.length) continue;
        const display = normalizePhrase(displayName);
        const canonical = values.find(value => normalizePhrase(value) === display)
            ?? values.find(value => value.includes('_'))
            ?? values[0]!;
        for (const value of values) {
            const normalized = normalizePhrase(value);
            aliases.set(normalized, canonical);
            aliases.set(normalized.replace(/\s+/g, ''), canonical);
        }
        aliases.set(display, canonical);
        aliases.set(display.replace(/\s+/g, ''), canonical);
    }
    aliases.set('country', 'country');
    aliases.set('planet', 'planet');
    aliases.set('colony', 'colony');
    aliases.set('ship', 'ship');
    aliases.set('fleet', 'fleet');
    aliases.set('system', 'system');
    aliases.set('any', 'any');
    aliases.set('all', 'any');
    aliases.set('no scope', 'any');
    aliases.set('none', 'any');
    for (const [phrase, value] of SCOPE_SYNONYMS) {
        const normalized = normalizePhrase(phrase);
        aliases.set(normalized, value);
        aliases.set(normalized.replace(/\s+/g, ''), value);
    }
    return aliases;
}

function contractFromComments(
    name: string,
    folder: ScopeContractFolder,
    source: string,
    definitionLine: number,
    comments: CommentLine[],
    aliases: ReadonlyMap<string, string>,
): ScopeContract | undefined {
    const scope: ScopeEnvironment = { from: [] };
    const evidence: string[] = [];
    const unresolved: string[] = [];
    const froms = new Map<number, string>();

    for (const comment of comments) {
        // Find assignments anywhere in a prose comment. This handles lines such
        // as "Arkship spawned. THIS = target system, FROM = arkship fleet" and
        // preserves commas that are part of a role description.
        const assignmentPattern = new RegExp(`(${FIELD_NAME_PATTERN})\\s*(?:=|:)\\s*`, 'gi');
        const assignments = Array.from(comment.text.matchAll(assignmentPattern));
        let matchedComment = false;
        for (let assignmentIndex = 0; assignmentIndex < assignments.length; assignmentIndex++) {
            const match = assignments[assignmentIndex]!;
            matchedComment = true;
            const rawField = match[1]!.toLowerCase().replace(/\s+/g, '');
            const valueStart = match.index! + match[0].length;
            const valueEnd = assignments[assignmentIndex + 1]?.index ?? comment.text.length;
            const rawValue = comment.text
                .slice(valueStart, valueEnd)
                .replace(/\s+#.*$/, '')
                .replace(/[,;]\s*$/, '')
                .trim();
            if (!rawValue) continue;
            const resolved = normalizeScopeDescription(rawValue, aliases);
            if (!resolved) {
                unresolved.push(`line ${comment.line}: cannot normalize ${match[1]!.trim()} = ${rawValue}`);
                continue;
            }

            if (rawField === 'scope' || rawField === 'root/this' || rawField === 'this/root' || rawField === 'root,this' || rawField === 'this,root') {
                assignScopeField(scope, 'this', resolved, comment.line, unresolved);
                assignScopeField(scope, 'root', resolved, comment.line, unresolved);
            } else if (rawField === 'this' || rawField === 'root') {
                assignScopeField(scope, rawField, resolved, comment.line, unresolved);
            } else if (rawField.startsWith('from')) {
                const index = rawField.length / 4 - 1;
                const existing = froms.get(index);
                if (existing && existing !== resolved) unresolved.push(`line ${comment.line}: conflicting ${rawField} scopes ${existing} and ${resolved}`);
                else froms.set(index, resolved);
            }
        }
        if (matchedComment) evidence.push(`# ${comment.text}`);
    }

    if (!evidence.length) return undefined;
    const maxFrom = froms.size ? Math.max(...froms.keys()) : -1;
    for (let index = 0; index <= maxFrom; index++) {
        // A documented FROMFROM... with omitted intermediate levels still has
        // that exact stack depth. Preserve it with Any placeholders rather than
        // collapsing the deeper entry to FROM.
        scope.from.push(froms.get(index) ?? 'any');
    }

    const hasResolvedScope = !!scope.this || !!scope.root || scope.from.length > 0;
    if (!hasResolvedScope && !unresolved.length) return undefined;
    const contentHash = crypto.createHash('sha256').update(`${name}\n${evidence.join('\n')}`).digest('hex');
    return {
        name,
        folder,
        scope,
        source,
        sourceLine: definitionLine,
        evidence,
        contentHash,
        sourceKind: 'vanilla_comment',
        confidence: unresolved.length ? 'medium' : 'high',
        unresolved,
    };
}

function normalizeScopeDescription(value: string, aliases: ReadonlyMap<string, string>): string | undefined {
    const hasAlternativeConnector = /\b(?:or|and\s*\/\s*or)\b|[/|]/i.test(value);
    const explicitTypeLabel = value.match(/^\s*([A-Za-z_][A-Za-z0-9_ -]*)\s*:/);
    if (explicitTypeLabel) {
        const label = normalizePhrase(explicitTypeLabel[1]!);
        const explicit = aliases.get(label) ?? aliases.get(label.replace(/\s+/g, ''));
        if (explicit) return explicit;
    }
    let phrase = normalizePhrase(value)
        .replace(/^(?:the|a|an|every|each)\s+/, '')
        .replace(/\bscope\b/g, ' ')
        .replace(/[^a-z0-9_\- ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!phrase || /^(?:invalid|n\/a)\b/.test(phrase)) return undefined;
    const orderedRoles = Array.from(ROLE_SCOPE_SYNONYMS.entries()).sort(([a], [b]) => b.length - a.length);
    for (const [description, scope] of orderedRoles) {
        if (phrase === description) return scope;
    }
    if (phrase.startsWith('biggest fleet bombarding ')) return 'fleet';
    const orderedAliases = Array.from(aliases.entries()).sort(([a], [b]) => b.length - a.length);
    const mentioned = new Set<string>();
    for (const [candidate, scope] of orderedAliases) {
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!POLYMORPHIC_SCOPE_NAMES.has(scope) && new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(phrase)) {
            mentioned.add(scope);
        }
    }
    const isOwnershipRole = /\b(?:owner|controller)\b/.test(phrase);
    if (isOwnershipRole) mentioned.add('country');
    // An explicit alternative such as "planet OR astral rift" or
    // "planet/starbase/megastructure" is a polymorphic contract. Do not select
    // the first type merely because the description starts with it. Synonymous
    // alternatives ("galactic object/solar system") still resolve safely.
    if (hasAlternativeConnector && mentioned.size > 1) {
        return POLYMORPHIC_SCOPE_COMBINATIONS.get(Array.from(mentioned).sort().join('|'));
    }
    // In Stellaris, ownership and control roles resolve to a country even when
    // the described object is a planet, fleet, ship, or army.
    if (isOwnershipRole) return 'country';
    for (const [candidate, scope] of orderedAliases) {
        if (phrase === candidate || phrase.startsWith(`${candidate} `)) return scope;
    }
    phrase = phrase.replace(/^(?:the|a|an)\s+/, '');
    const exact = aliases.get(phrase);
    if (exact) return exact;

    // Descriptive comments often add an adjective or role after naming the
    // actual type ("victim country", "country, attacker"). Resolve only when
    // the whole phrase contains one distinct known scope.
    if (/\b(?:ruler|capital)\s+of\b/.test(phrase)) return undefined;
    return mentioned.size === 1 ? mentioned.values().next().value : undefined;
}

function assignScopeField(
    scope: ScopeEnvironment,
    field: 'this' | 'root',
    value: string,
    line: number,
    unresolved: string[],
) {
    const existing = scope[field];
    if (existing && existing !== value) unresolved.push(`line ${line}: conflicting ${field} scopes ${existing} and ${value}`);
    else scope[field] = value;
}

function parseCwtEnvironment(body: string, aliases: ReadonlyMap<string, string>): ScopeEnvironment {
    const scope: ScopeEnvironment = { from: [] };
    const froms = new Map<number, string>();
    CWT_FIELD_PATTERN.lastIndex = 0;
    for (let match = CWT_FIELD_PATTERN.exec(body); match; match = CWT_FIELD_PATTERN.exec(body)) {
        const field = match[1]!.toLowerCase();
        const rawValue = match[2]!.toLowerCase();
        const normalized = normalizePhrase(rawValue);
        const value = aliases.get(normalized) ?? aliases.get(normalized.replace(/\s+/g, '')) ?? rawValue;
        if (field === 'this' || field === 'root') scope[field] = value;
        else froms.set(field.length / 4 - 1, value);
    }
    const maxFrom = froms.size ? Math.max(...froms.keys()) : -1;
    for (let index = 0; index <= maxFrom; index++) {
        const value = froms.get(index);
        if (value) scope.from.push(value);
    }
    return scope;
}

function compareEnvironments(expected: ScopeEnvironment, actual: ScopeEnvironment): string[] {
    const differences: string[] = [];
    if (expected.this && expected.this !== actual.this) differences.push(`this: expected ${expected.this}, got ${actual.this ?? '(missing)'}`);
    if (expected.root && expected.root !== actual.root) differences.push(`root: expected ${expected.root}, got ${actual.root ?? '(missing)'}`);
    expected.from.forEach((value, index) => {
        if (value !== actual.from[index]) differences.push(`${'from'.repeat(index + 1)}: expected ${value}, got ${actual.from[index] ?? '(missing)'}`);
    });
    return differences;
}

function stripScriptComment(line: string): string {
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index]!;
        if (char === '"' && !escaped) quoted = !quoted;
        if (char === '#' && !quoted) return line.slice(0, index);
        escaped = char === '\\' && !escaped;
        if (char !== '\\') escaped = false;
    }
    return line;
}

function countBraceDelta(line: string): number {
    let delta = 0;
    let quoted = false;
    let escaped = false;
    for (const char of line) {
        if (char === '"' && !escaped) quoted = !quoted;
        if (!quoted && char === '{') delta++;
        if (!quoted && char === '}') delta--;
        escaped = char === '\\' && !escaped;
        if (char !== '\\') escaped = false;
    }
    return delta;
}

function walkFiles(input: string, predicate: (file: string) => boolean): string[] {
    if (!fs.existsSync(input)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
        const full = path.join(input, entry.name);
        if (entry.isDirectory()) results.push(...walkFiles(full, predicate));
        else if (predicate(full)) results.push(full);
    }
    return results.sort();
}

function normalizePhrase(value: string): string {
    return value.toLowerCase().replace(/["'`]/g, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function contractKey(folder: ScopeContractFolder, name: string): string {
    return `${folder}:${name.toLowerCase()}`;
}

function toPosix(value: string): string {
    return value.replace(/\\/g, '/');
}
