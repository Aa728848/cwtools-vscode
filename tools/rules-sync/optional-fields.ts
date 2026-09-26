import * as fs from 'fs';
import * as path from 'path';

// Script documentation is the single source of truth for which trigger/effect
// fields are optional: Paradox annotates them inline, e.g.
//   pop_group = <target> (if not specified, check total number)
//   num_buildings = { ... category = <any(default)/unity> ... }
// A CWT alias field defaults to cardinality 1..1, so a field the documentation
// marks optional but the rule still requires reports a false
// "Missing <field>, expecting at least 1" (CW242) for every legal usage that
// omits it.
//
// This module detects that drift from the documentation instead of hard-coding
// field names, so newly annotated fields are caught by a rules refresh.

export type DocRuleKind = 'trigger' | 'effect';

export interface OptionalFieldFinding {
    kind: DocRuleKind;
    /** Alias name, for example num_pops_assigned_to_job. */
    rule: string;
    /** Field the documentation marks optional. */
    field: string;
    /** Declared cardinality, or '<default 1..1>' when the field declares none. */
    declaredCardinality: string;
    /** Documentation text that marks the field optional. */
    evidence: string;
    /** Rules file declaring the field (absolute path). */
    file: string;
    /** 1-based line of the field declaration inside the rules file. */
    line: number;
}

export interface OptionalFieldAudit {
    /** Fields the documentation marks optional while the rules still require them. */
    findings: OptionalFieldFinding[];
    /** Documented optional fields that no alias variant models at all. */
    unmodeled: Array<{ kind: DocRuleKind; rule: string; field: string; evidence: string }>;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_.\\-]*';
const DOC_HEADER = new RegExp('^(' + IDENT + ')\\s+-\\s+');
const CARDINALITY = /^~?(\d+)\.\.(\d+|inf)$/i;
// Inline markers Paradox uses to say "this field may be omitted".
const OPTIONAL_HINT = /\(optional|if not specified|if omitted|\(default|default:|default\s*=|defaults to|default\)/i;

const SCRIPT_DOC_BASENAMES: Record<string, { file: string; kind: DocRuleKind }> = {
    'trigger_docs.log': { file: 'triggers.cwt', kind: 'trigger' },
    'effect_docs.log': { file: 'effects.cwt', kind: 'effect' },
};

export function readNormalizedLines(filePath: string): string[] {
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').split('\n');
}

/** Remove a trailing comment marker, ignoring markers inside quotes. */
export function stripLineComment(line: string): string {
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

/**
 * Fields documented inside the usage block of one script-documentation entry.
 * Only depth-1 keys of the first "= { ... }" block are considered, and scope
 * references such as "<target (optional)>" are skipped so the marker stays
 * attached to the field it documents rather than to a nested name.
 */
export function documentedOptionalFields(body: string): Map<string, string> {
    const fields = new Map<string, string>();
    const open = body.indexOf('{');
    if (open < 0) return fields;

    const starts: Array<{ name: string; at: number }> = [];
    let depth = 0;
    let parens = 0;
    let angles = 0;
    let quote: string | undefined;
    for (let i = open; i < body.length; i++) {
        const ch = body[i]!;
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = undefined;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '(') {
            parens++;
            continue;
        }
        if (ch === ')') {
            parens = Math.max(0, parens - 1);
            continue;
        }
        if (ch === '<' && /[A-Za-z_]/.test(body[i + 1] ?? '')) {
            angles++;
            continue;
        }
        if (ch === '>' && angles > 0) {
            angles--;
            continue;
        }
        if (angles > 0) continue;
        if (ch === '{') {
            depth++;
            continue;
        }
        if (ch === '}') {
            depth--;
            if (depth <= 0) break;
            continue;
        }
        if (depth !== 1 || parens !== 0) continue;
        const previous = i > 0 ? body[i - 1]! : '\n';
        if (/[A-Za-z0-9_.]/.test(previous)) continue;
        const match = new RegExp('^(' + IDENT + ')\\s*(=|<=|>=|<|>)').exec(body.slice(i));
        if (!match) continue;
        starts.push({ name: match[1]!, at: i });
        i += match[1]!.length - 1;
    }

    for (let index = 0; index < starts.length; index++) {
        const start = starts[index]!;
        const end = index + 1 < starts.length ? starts[index + 1]!.at : body.length;
        const segment = body.slice(start.at, end).replace(/\s+/g, ' ').trim();
        const equals = segment.indexOf('=');
        const value = segment.slice(equals >= 0 ? equals + 1 : 0);
        if (!OPTIONAL_HINT.test(value)) continue;
        if (!fields.has(start.name)) fields.set(start.name, segment.slice(0, 160));
    }
    return fields;
}

/** Script-documentation entries mapped to the optional fields each one documents. */
export function parseDocumentedOptionalFields(lines: string[]): Map<string, Map<string, string>> {
    const rules = new Map<string, Map<string, string>>();
    for (let i = 0; i < lines.length; i++) {
        const header = DOC_HEADER.exec(lines[i] ?? '');
        if (!header) continue;
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && !DOC_HEADER.test(lines[j] ?? '')) {
            const trimmed = (lines[j] ?? '').trim();
            if (!/^Supported (Scopes|Targets):/i.test(trimmed)) body.push(lines[j] ?? '');
            j++;
        }
        const optional = documentedOptionalFields(body.join('\n'));
        if (optional.size > 0) rules.set(header[1]!, optional);
        i = j - 1;
    }
    return rules;
}

interface AliasFieldDeclaration {
    /** Declared cardinality; undefined when the field declares none (default 1..1). */
    cardinality?: string;
    line: number;
}

export interface AliasVariant {
    name: string;
    fields: Map<string, AliasFieldDeclaration>;
}

/**
 * Every "alias[kind:name] = { ... }" block, kept as separate variants: each
 * variant is validated independently, so optionality must hold per variant.
 */
export function parseAliasVariants(lines: string[], kind: DocRuleKind): AliasVariant[] {
    const variants: AliasVariant[] = [];
    const header = new RegExp('^\\s*alias\\[' + kind + ':(' + IDENT + ')\\]\\s*=\\s*\\{');
    const field = new RegExp('^(' + IDENT + ')\\s*(=|<=|>=|<|>)');
    for (let i = 0; i < lines.length; i++) {
        const match = header.exec(stripLineComment(lines[i] ?? ''));
        if (!match) continue;
        const fields = new Map<string, AliasFieldDeclaration>();
        let depth = 1;
        for (let j = i + 1; j < lines.length; j++) {
            const trimmed = (lines[j] ?? '').trim();
            if (depth === 1 && trimmed && !trimmed.startsWith('#')) {
                const declared = field.exec(trimmed);
                if (declared && !fields.has(declared[1]!)) {
                    fields.set(declared[1]!, { cardinality: cardinalityBefore(lines, j, i), line: j + 1 });
                }
            }
            const stripped = stripLineComment(lines[j] ?? '');
            depth += (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;
            if (depth <= 0) break;
        }
        variants.push({ name: match[1]!, fields });
    }
    return variants;
}

function cardinalityBefore(lines: string[], fieldLine: number, blockStart: number): string | undefined {
    for (let i = fieldLine - 1; i > blockStart; i--) {
        const trimmed = (lines[i] ?? '').trim();
        const match = /^##\s*cardinality\s*=\s*(\S+)/.exec(trimmed);
        if (match) return match[1];
        if (trimmed !== '' && !trimmed.startsWith('#')) break;
    }
    return undefined;
}

/** True when the declared cardinality forbids omitting the field. */
export function isRequiredCardinality(cardinality: string | undefined): boolean {
    if (!cardinality) return true;
    const match = CARDINALITY.exec(cardinality);
    if (!match) return true;
    return Number(match[1]) >= 1;
}

/**
 * Compare documented optional fields against the maintained CWT rules for one
 * script-documentation file (for example trigger_docs.log + triggers.cwt).
 */
export function auditDocFile(configDir: string, logFileName: string, rulesFileName?: string): OptionalFieldAudit {
    const mapping = SCRIPT_DOC_BASENAMES[logFileName.toLowerCase()];
    const kind = mapping?.kind ?? 'trigger';
    const rulesFile = rulesFileName ?? mapping?.file ?? 'triggers.cwt';
    const logPath = path.join(configDir, 'logs', logFileName);
    const rulesPath = path.join(configDir, rulesFile);
    const audit: OptionalFieldAudit = { findings: [], unmodeled: [] };
    if (!fs.existsSync(logPath) || !fs.existsSync(rulesPath)) return audit;

    const documented = parseDocumentedOptionalFields(readNormalizedLines(logPath));
    const variants = parseAliasVariants(readNormalizedLines(rulesPath), kind);
    const modeled = new Set<string>();

    for (const variant of variants) {
        const optional = documented.get(variant.name);
        if (!optional) continue;
        for (const [field, evidence] of optional) {
            const declaration = variant.fields.get(field);
            if (!declaration) continue;
            modeled.add(variant.name + '.' + field);
            if (!isRequiredCardinality(declaration.cardinality)) continue;
            audit.findings.push({
                kind,
                rule: variant.name,
                field,
                declaredCardinality: declaration.cardinality ?? '<default 1..1>',
                evidence,
                file: rulesPath,
                line: declaration.line,
            });
        }
    }

    for (const [rule, optional] of documented) {
        if (!variants.some(variant => variant.name === rule)) continue;
        for (const [field, evidence] of optional) {
            if (modeled.has(rule + '.' + field)) continue;
            audit.unmodeled.push({ kind, rule, field, evidence });
        }
    }

    audit.findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.field.localeCompare(b.field));
    audit.unmodeled.sort((a, b) => a.rule.localeCompare(b.rule) || a.field.localeCompare(b.field));
    return audit;
}

/** Audit every script-documentation file present in a rules config directory. */
export function auditOptionalFields(configDir: string): OptionalFieldAudit {
    const merged: OptionalFieldAudit = { findings: [], unmodeled: [] };
    for (const logFileName of Object.keys(SCRIPT_DOC_BASENAMES)) {
        const audit = auditDocFile(configDir, logFileName);
        merged.findings.push(...audit.findings);
        merged.unmodeled.push(...audit.unmodeled);
    }
    return merged;
}

export function formatOptionalFieldReport(audit: OptionalFieldAudit): string {
    const lines: string[] = [];
    for (const finding of audit.findings) {
        lines.push(
            finding.file + ':' + finding.line + ' ' + finding.kind + ':' + finding.rule + '.' + finding.field +
            ' declares cardinality ' + finding.declaredCardinality +
            ' but the documentation marks it optional: ' + finding.evidence,
        );
    }
    for (const entry of audit.unmodeled) {
        lines.push(
            entry.kind + ':' + entry.rule + '.' + entry.field +
            ' is documented optional but no alias variant models it: ' + entry.evidence,
        );
    }
    return lines.join('\n');
}

function parseArgs(argv: string[]): { config: string; ci: boolean } {
    const get = (name: string, fallback = '') => {
        const index = argv.indexOf(name);
        return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
    };
    return { config: get('--config'), ci: argv.includes('--ci') };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.config) {
        console.error('Usage: npx ts-node tools/rules-sync/optional-fields.ts --config <configDir> [--ci]');
        process.exit(1);
    }
    const audit = auditOptionalFields(args.config);
    const report = formatOptionalFieldReport(audit);
    if (report) console.log(report);
    console.log('[optional-fields] documented-but-required=' + audit.findings.length +
        ' documented-but-unmodeled=' + audit.unmodeled.length);
    if (args.ci && audit.findings.length > 0) process.exitCode = 2;
}

if (require.main === module) main();
