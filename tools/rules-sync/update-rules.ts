import * as fs from 'fs';
import * as path from 'path';

type RuleKind = 'effect' | 'trigger' | 'modifier' | 'scope' | 'localisation_command' | 'common_definition';
type GeneratableRuleKind = Exclude<RuleKind, 'localisation_command' | 'common_definition'>;
type SourceKind = 'log' | 'common' | 'cwt' | 'mixed';
type ReportAction =
    | 'added'
    | 'skipped_existing'
    | 'conflict'
    | 'manual_review'
    | 'definition_added'
    | 'definition_changed'
    | 'definition_removed';

interface GeneratedRule {
    name: string;
    kind: RuleKind;
    scopes: string[];
    targetScopes: string[];
    parameters: Array<{ name: string; type: string }>;
    description: string;
    source: string;
    sourceLine: number;
    confidence: 'high' | 'medium' | 'low';
    needsManualReview: boolean;
    sourceKind?: SourceKind;
    logicalPath?: string;
    contentHash?: string;
    blockKind?: string;
}

interface RulesGenerated {
    effects?: GeneratedRule[];
    triggers?: GeneratedRule[];
    modifiers?: GeneratedRule[];
    scopes?: GeneratedRule[];
    localisationCommands?: GeneratedRule[];
    commonDefinitions?: GeneratedRule[];
}

interface ReportEntry {
    kind: RuleKind;
    name: string;
    action: ReportAction;
    targetFile?: string;
    reason?: string;
    source?: string;
    sourceLine?: number;
    logicalPath?: string;
    contentHash?: string;
    previousHash?: string;
}

interface UpdateReport {
    checkedAt: string;
    checkOnly: boolean;
    generatedJson: string;
    previousGeneratedJson?: string;
    existingRulesDir: string;
    summary: Record<string, number>;
    entries: ReportEntry[];
}

const KIND_FILES: Record<GeneratableRuleKind, string> = {
    effect: 'effects.generated.cwt',
    trigger: 'triggers.generated.cwt',
    modifier: 'modifiers.generated.cwt',
    scope: 'scopes.generated.cwt',
};

function walkCwtFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...walkCwtFiles(fullPath));
        else if (entry.name.endsWith('.cwt')) results.push(fullPath);
    }
    return results;
}

function scanExistingRules(dir: string): Map<string, string[]> {
    const existing = new Map<string, string[]>();
    const add = (kind: RuleKind, name: string, file: string) => {
        const key = `${kind}:${name.toLowerCase()}`;
        const list = existing.get(key) ?? [];
        list.push(file);
        existing.set(key, list);
    };
    for (const file of walkCwtFiles(dir)) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const match of content.matchAll(/alias\[(effect|trigger|modifier):([A-Za-z_][A-Za-z0-9_.-]*)\]/g)) {
            add(match[1] as RuleKind, match[2]!, file);
        }
        if (file.toLowerCase().includes('modifier')) {
            for (const match of content.matchAll(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*\{/gm)) {
                add('modifier', match[1]!, file);
            }
        }
    }
    return existing;
}

function loadRules(filePath: string): RulesGenerated {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RulesGenerated;
}

function safeRules(rules: GeneratedRule[] | undefined): GeneratedRule[] {
    return Array.isArray(rules) ? rules : [];
}

function candidateRules(rules: RulesGenerated): GeneratedRule[] {
    return [
        ...safeRules(rules.effects),
        ...safeRules(rules.triggers),
        ...safeRules(rules.modifiers),
        ...safeRules(rules.scopes),
        ...safeRules(rules.localisationCommands),
    ];
}

function traceableRules(rules: RulesGenerated): GeneratedRule[] {
    return [
        ...candidateRules(rules),
        ...safeRules(rules.commonDefinitions),
    ].filter(rule => !!rule.contentHash);
}

function renderRule(rule: GeneratedRule): string {
    const review = rule.needsManualReview ? '\n## needs_manual_review = yes' : '';
    const scopes = rule.scopes.length ? `\n## supported_scopes = ${rule.scopes.join(' ')}` : '';
    switch (rule.kind) {
        case 'effect':
        case 'trigger': {
            const parameters = rule.parameters.length
                ? `\n${rule.parameters.map(param => `\t## parameter ${param.name}: ${param.type}`).join('\n')}`
                : '';
            return `### ${rule.description || `Generated ${rule.kind}`}${scopes}${review}\nalias[${rule.kind}:${rule.name}] = {${parameters}\n\t# TODO: verify generated parameters\n}`;
        }
        case 'modifier':
            return `### ${rule.description || 'Generated modifier'}${review}\nalias[modifier:${rule.name}] = float`;
        case 'scope': {
            const push = rule.targetScopes[0] ? `## push_scope = ${rule.targetScopes[0]}\n` : '';
            return `${push}### ${rule.description || 'Generated scope change'}${scopes}${review}\nalias[trigger:${rule.name}] = { alias_name[trigger] = alias_match_left[trigger] }\nalias[effect:${rule.name}] = { alias_name[effect] = alias_match_left[effect] }`;
        }
        case 'localisation_command':
            return `## ${rule.description}\n# ${rule.scopes.join('.')}.${rule.name}`;
        case 'common_definition':
            return `### ${rule.description || 'Common definition inventory'}\n# ${rule.logicalPath ?? rule.name}`;
    }
}

function ensureHeader(filePath: string, kind: RuleKind) {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# <auto-generated:${kind}s>\n# Generated by tools/rules-sync/update-rules.ts. Review before merging into stable CWT.\n\n`, 'utf-8');
}

function appendRule(filePath: string, kind: GeneratableRuleKind, rule: GeneratedRule) {
    ensureHeader(filePath, kind);
    fs.appendFileSync(filePath, `${renderRule(rule)}\n\n`, 'utf-8');
}

function createReport(generatedJson: string, existingRulesDir: string, checkOnly: boolean, previousGeneratedJson?: string): UpdateReport {
    return {
        checkedAt: new Date().toISOString(),
        checkOnly,
        generatedJson: path.resolve(generatedJson),
        previousGeneratedJson: previousGeneratedJson ? path.resolve(previousGeneratedJson) : undefined,
        existingRulesDir: path.resolve(existingRulesDir),
        summary: {
            added: 0,
            skipped_existing: 0,
            conflict: 0,
            manual_review: 0,
            definition_added: 0,
            definition_changed: 0,
            definition_removed: 0,
        },
        entries: [],
    };
}

function record(report: UpdateReport, entry: ReportEntry) {
    report.entries.push(entry);
    report.summary[entry.action] = (report.summary[entry.action] ?? 0) + 1;
}

function traceKey(rule: GeneratedRule): string {
    const pathKey = rule.logicalPath || `${rule.source}:${rule.name}`;
    return `${rule.kind}:${pathKey.toLowerCase()}`;
}

function indexTraceableRules(rules: RulesGenerated): Map<string, GeneratedRule> {
    const index = new Map<string, GeneratedRule>();
    for (const rule of traceableRules(rules)) index.set(traceKey(rule), rule);
    return index;
}

function recordDefinitionChanges(report: UpdateReport, previousRules: RulesGenerated | undefined, currentRules: RulesGenerated) {
    if (!previousRules) return;

    const previous = indexTraceableRules(previousRules);
    const current = indexTraceableRules(currentRules);
    for (const [key, rule] of current) {
        const oldRule = previous.get(key);
        if (!oldRule) {
            record(report, definitionEntry(rule, 'definition_added', 'New common/CWT definition block discovered.'));
        } else if (oldRule.contentHash !== rule.contentHash) {
            record(report, {
                ...definitionEntry(rule, 'definition_changed', 'Definition block signature changed.'),
                previousHash: oldRule.contentHash,
            });
        }
    }

    for (const [key, rule] of previous) {
        if (!current.has(key)) {
            record(report, definitionEntry(rule, 'definition_removed', 'Definition block disappeared from the current common/CWT scan.'));
        }
    }
}

function definitionEntry(rule: GeneratedRule, action: Extract<ReportAction, 'definition_added' | 'definition_changed' | 'definition_removed'>, reason: string): ReportEntry {
    return {
        kind: rule.kind,
        name: rule.name,
        action,
        reason,
        source: rule.source,
        sourceLine: rule.sourceLine,
        logicalPath: rule.logicalPath,
        contentHash: rule.contentHash,
    };
}

function isGeneratedFile(file: string): boolean {
    return file.replace(/\\/g, '/').includes('/generated/');
}

function run(generatedJson: string, existingRulesDir: string, outDir: string, checkOnly: boolean, previousGeneratedJson?: string): UpdateReport {
    const rules = loadRules(generatedJson);
    const previousRules = previousGeneratedJson ? loadRules(previousGeneratedJson) : undefined;
    const existing = scanExistingRules(existingRulesDir);
    const report = createReport(generatedJson, existingRulesDir, checkOnly, previousGeneratedJson);
    const generatedDir = path.join(outDir, 'generated');

    recordDefinitionChanges(report, previousRules, rules);

    for (const rule of candidateRules(rules)) {
        if (rule.kind === 'common_definition') continue;
        if (rule.sourceKind === 'cwt') continue;

        if (rule.kind === 'localisation_command') {
            record(report, {
                kind: rule.kind,
                name: rule.name,
                action: 'manual_review',
                reason: 'Localisation command loader integration is manual for now.',
                source: rule.source,
                sourceLine: rule.sourceLine,
                logicalPath: rule.logicalPath,
            });
            continue;
        }

        const targetName = KIND_FILES[rule.kind];
        if (!targetName) continue;

        const existingFiles = existing.get(`${rule.kind}:${rule.name.toLowerCase()}`) ?? [];
        if (existingFiles.length > 0) {
            const hasManualRule = existingFiles.some(file => !isGeneratedFile(file));
            const reason = hasManualRule
                ? 'Manual CWT rule already exists; kept manual rule.'
                : 'Generated rule already exists.';
            record(report, {
                kind: rule.kind,
                name: rule.name,
                action: hasManualRule ? 'conflict' : 'skipped_existing',
                reason,
                source: rule.source,
                sourceLine: rule.sourceLine,
                logicalPath: rule.logicalPath,
                contentHash: rule.contentHash,
            });
            continue;
        }
        if (rule.needsManualReview || rule.confidence === 'low') {
            record(report, {
                kind: rule.kind,
                name: rule.name,
                action: 'manual_review',
                reason: `confidence=${rule.confidence}`,
                source: rule.source,
                sourceLine: rule.sourceLine,
                logicalPath: rule.logicalPath,
                contentHash: rule.contentHash,
            });
            continue;
        }
        const targetFile = path.join(generatedDir, targetName);
        record(report, {
            kind: rule.kind,
            name: rule.name,
            action: 'added',
            targetFile,
            source: rule.source,
            sourceLine: rule.sourceLine,
            logicalPath: rule.logicalPath,
            contentHash: rule.contentHash,
        });
        if (!checkOnly) appendRule(targetFile, rule.kind, rule);
    }

    return report;
}

function parseArgs(argv: string[]) {
    const generatedJson = argv[0];
    const existingRulesDir = argv[1];
    const getArg = (name: string, fallback = '') => {
        const idx = argv.indexOf(name);
        return idx >= 0 && argv[idx + 1] ? argv[idx + 1]! : fallback;
    };
    return {
        generatedJson,
        existingRulesDir,
        outDir: getArg('--output', existingRulesDir ? path.join(existingRulesDir, 'generated-sync') : 'generated-sync'),
        previousGeneratedJson: getArg('--previous', ''),
        checkOnly: argv.includes('--check'),
    };
}

function hasCheckDrift(report: UpdateReport): boolean {
    return ['added', 'definition_added', 'definition_changed', 'definition_removed']
        .some(action => (report.summary[action] ?? 0) > 0);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.generatedJson || !args.existingRulesDir) {
        console.error('Usage: npx ts-node tools/rules-sync/update-rules.ts <rules.generated.json> <existingRulesDir> [--output <outDir>] [--previous <previousRulesJson>] [--check]');
        process.exit(1);
    }
    fs.mkdirSync(args.outDir, { recursive: true });
    const report = run(args.generatedJson, args.existingRulesDir, args.outDir, args.checkOnly, args.previousGeneratedJson || undefined);
    const reportPath = path.join(args.outDir, args.checkOnly ? 'rules-sync-check-report.json' : 'rules-sync-update-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    console.log(`Report: ${reportPath}`);
    console.log(JSON.stringify(report.summary));
    if (args.checkOnly && hasCheckDrift(report)) process.exitCode = 2;
}

main();
