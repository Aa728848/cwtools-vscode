import * as fs from 'fs';
import * as path from 'path';

type RuleKind = 'effect' | 'trigger' | 'modifier' | 'scope' | 'localisation_command';
type Confidence = 'high' | 'medium' | 'low';

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
}

const IDENT = '[A-Za-z_][A-Za-z0-9_\\.\\-]*';
const UNKNOWN_PATTERN = new RegExp(`\\b(?:unknown|unrecognized)\\s+(effect|trigger|modifier|scope)[:\\s]+["']?(${IDENT})["']?`, 'gi');
const NOT_KNOWN_PATTERN = new RegExp(`["']?(${IDENT})["']?\\s+is\\s+not\\s+a\\s+(?:known|valid)\\s+(effect|trigger|modifier)`, 'gi');
const CWTOOLS_PATTERN = new RegExp(`Unexpected\\s+(${IDENT})\\s+(effect|trigger)`, 'gi');

function readLines(filePath: string): string[] {
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').split('\n');
}

function listInputFiles(inputPath: string): string[] {
    if (!fs.existsSync(inputPath)) return [];
    const stat = fs.statSync(inputPath);
    if (stat.isFile()) return [inputPath];
    return fs.readdirSync(inputPath)
        .filter(name => /\.(log|txt)$/i.test(name))
        .map(name => path.join(inputPath, name));
}

function splitScopes(value: string): string[] {
    return value.trim().split(/\s+/).filter(Boolean);
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
    if (!existing.description && rule.description) existing.description = rule.description;
    if (existing.confidence !== 'high' && rule.confidence === 'high') existing.confidence = 'high';
    existing.needsManualReview = existing.needsManualReview || rule.needsManualReview;
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

function parseTriggerDocs(filePath: string, lines: string[], map: Map<string, GeneratedRule>) {
    const source = path.basename(filePath);
    const titleLine = lines.findIndex(line => /TRIGGER DOCUMENTATION/i.test(line));
    if (titleLine < 0) return;

    for (let i = titleLine + 1; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const nameMatch = line.match(new RegExp(`^(${IDENT})\\s+-\\s+(.+)$`));
        if (!nameMatch) continue;

        const name = nameMatch[1]!;
        const description = nameMatch[2]!.trim();
        let supportedScopes: string[] = [];
        let usage = '';
        let j = i + 1;
        while (j < lines.length && !(lines[j] ?? '').match(new RegExp(`^(${IDENT})\\s+-\\s+`))) {
            const inner = lines[j] ?? '';
            const scopeMatch = inner.match(/^Supported Scopes:\s*(.+)$/i);
            if (scopeMatch) supportedScopes = splitScopes(scopeMatch[1]!);
            else if (inner.trim()) usage += `${inner.trim()}\n`;
            j++;
        }
        addRule(map, {
            name,
            kind: 'trigger',
            scopes: supportedScopes,
            targetScopes: [],
            parameters: inferParameters(usage),
            description,
            source,
            sourceLine: i + 1,
            confidence: supportedScopes.length > 0 ? 'high' : 'medium',
            needsManualReview: supportedScopes.length === 0,
        });
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
        });
    }
}

function inferParameters(usage: string): Array<{ name: string; type: string }> {
    const params = new Map<string, string>();
    for (const match of usage.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*<([^>]+)>/g)) {
        params.set(match[1]!, match[2]!.trim());
    }
    return Array.from(params, ([name, type]) => ({ name, type }));
}

function buildRules(inputFiles: string[], game: string, version: string): RulesGenerated {
    const map = new Map<string, GeneratedRule>();
    for (const file of inputFiles) {
        const lines = readLines(file);
        parseUnknowns(file, lines, map);
        parseTriggerDocs(file, lines, map);
        parseModifiers(file, lines, map);
        parseScopes(file, lines, map);
        parseLocalisationCommands(file, lines, map);
    }
    const allRules = Array.from(map.values()).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const byKind = (kind: RuleKind) => allRules.filter(rule => rule.kind === kind);
    return {
        game,
        version,
        generatedAt: new Date().toISOString(),
        sources: inputFiles.map(file => path.resolve(file)),
        effects: byKind('effect'),
        triggers: byKind('trigger'),
        modifiers: byKind('modifier'),
        scopes: byKind('scope'),
        localisationCommands: byKind('localisation_command'),
    };
}

function writeCwt(outDir: string, rules: RulesGenerated) {
    const generatedDir = path.join(outDir, 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    writeFileIfChanged(path.join(generatedDir, 'effects.generated.cwt'), renderAliasRules('effect', rules.effects));
    writeFileIfChanged(path.join(generatedDir, 'triggers.generated.cwt'), renderAliasRules('trigger', rules.triggers));
    writeFileIfChanged(path.join(generatedDir, 'modifiers.generated.cwt'), renderModifierRules(rules.modifiers));
    writeFileIfChanged(path.join(generatedDir, 'scopes.generated.cwt'), renderScopeRules(rules.scopes));
    writeFileIfChanged(path.join(generatedDir, 'localisation_commands.generated.cwt'), renderLocalisationRules(rules.localisationCommands));
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
        lines.push(`\t# TODO: verify parameters and nested ${kind}s`);
        lines.push('}');
        lines.push('');
    }
    lines.push(`# </auto-generated:${kind}s>\n`);
    return lines.join('\n');
}

function renderModifierRules(rules: GeneratedRule[]): string {
    const lines = [header('modifiers')];
    for (const rule of rules) {
        lines.push(`### ${rule.description || 'Generated modifier'}`);
        if (rule.needsManualReview) lines.push('## needs_manual_review = yes');
        lines.push(`alias[modifier:${rule.name}] = float`);
        lines.push('');
    }
    lines.push('# </auto-generated:modifiers>\n');
    return lines.join('\n');
}

function renderScopeRules(rules: GeneratedRule[]): string {
    const lines = [header('scopes')];
    for (const rule of rules) {
        if (rule.targetScopes[0]) lines.push(`## push_scope = ${rule.targetScopes[0]}`);
        lines.push(`### ${rule.description || 'Generated scope change'}`);
        if (rule.scopes.length) lines.push(`## supported_scopes = ${rule.scopes.join(' ')}`);
        if (rule.needsManualReview) lines.push('## needs_manual_review = yes');
        lines.push(`alias[trigger:${rule.name}] = { alias_name[trigger] = alias_match_left[trigger] }`);
        lines.push(`alias[effect:${rule.name}] = { alias_name[effect] = alias_match_left[effect] }`);
        lines.push('');
    }
    lines.push('# </auto-generated:scopes>\n');
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

function writeFileIfChanged(filePath: string, content: string) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8') === content) return;
    fs.writeFileSync(filePath, content, 'utf-8');
}

function parseArgs(argv: string[]) {
    const input = argv[0];
    const getArg = (name: string, fallback = '') => {
        const idx = argv.indexOf(name);
        return idx >= 0 && argv[idx + 1] ? argv[idx + 1]! : fallback;
    };
    return {
        input,
        outDir: getArg('--output', input ? path.join(path.dirname(input), 'rules-generated') : 'rules-generated'),
        game: getArg('--game', 'stellaris'),
        version: getArg('--version', 'unknown'),
        emitCwt: argv.includes('--emit-cwt'),
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.input) {
        console.error('Usage: npx ts-node tools/rules-sync/parse-log.ts <logFileOrDir> [--output <outDir>] [--game stellaris] [--version x.y.z] [--emit-cwt]');
        process.exit(1);
    }
    const files = listInputFiles(args.input);
    if (files.length === 0) {
        console.error(`No .log/.txt files found at ${args.input}`);
        process.exit(1);
    }
    fs.mkdirSync(args.outDir, { recursive: true });
    const rules = buildRules(files, args.game, args.version);
    writeFileIfChanged(path.join(args.outDir, 'rules.generated.json'), JSON.stringify(rules, null, 2) + '\n');
    if (args.emitCwt) writeCwt(args.outDir, rules);
    console.log(`Generated ${path.join(args.outDir, 'rules.generated.json')}`);
    console.log(`effects=${rules.effects.length} triggers=${rules.triggers.length} modifiers=${rules.modifiers.length} scopes=${rules.scopes.length} localisationCommands=${rules.localisationCommands.length}`);
}

main();
