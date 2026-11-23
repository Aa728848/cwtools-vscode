import * as fs from 'fs';
import * as path from 'path';

// Reverse-direction audit for config/common/*.cwt: finds top-level rule fields
// that no longer appear in vanilla common/<folder>/ scripts, official README
// comments, or inline_scripts, and cross-checks them against the Stellaris
// executable so engine-removed or renamed fields (such as 4.0's removal of
// district is_capped_by_modifier / pop_category demotion_time / ship_size
// possible_starbase) surface during rules sync instead of silently passing.

export type StaleFieldStatus = 'removed_from_engine' | 'unused_in_vanilla';

export interface StaleFieldFinding {
    /** Relative to configDir, e.g. common/districts.cwt. */
    file: string;
    line: number;
    typeName: string;
    folder: string;
    field: string;
    kind: 'leaf' | 'block';
    status: StaleFieldStatus;
}

export interface StaleFieldSummary {
    cwtFilesScanned: number;
    fieldsChecked: number;
    annotatedDeprecated: number;
    removedFromEngine: number;
    unusedInVanilla: number;
    executableScanned: boolean;
    executablePath: string;
}

export interface StaleFieldAuditReport {
    configDir: string;
    vanillaCommonDir: string;
    findings: StaleFieldFinding[];
    summary: StaleFieldSummary;
}

const SKIPPED_COMMON_FOLDERS = new Set([
    'defines',
    'unchecked_defines',
    'on_actions',
    'game_rules',
]);

const CWT_GRAMMAR_KEYS = new Set([
    'subtype',
    'alias_name',
    'single_alias_right',
    'scalar',
    'localisation',
    'localisation_synced',
    'int',
    'float',
    'bool',
    'value',
    'enum',
    'value_set',
    'scope',
]);

function toPosix(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function readNormalizedText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

function walkFiles(dir: string, suffix: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name.toLowerCase() !== '.git') results.push(...walkFiles(fullPath, suffix));
        } else if (entry.name.toLowerCase().endsWith(suffix)) {
            results.push(fullPath);
        }
    }
    return results.sort((a, b) => a.localeCompare(b));
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

function normalizeCommonFolder(raw: string): string {
    return raw.replace(/\\/g, '/').replace(/^game\/common\//i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
}

export interface DeclaredCwtField {
    file: string;
    line: number;
    typeName: string;
    folder: string;
    field: string;
    kind: 'leaf' | 'block';
    deprecated: boolean;
}

/**
 * Extract top-level named fields from common/*.cwt type rule blocks, tracking
 * whether each field is already annotated with `## error_if_only_match`.
 * Types marked `type_per_file = yes` (e.g. defines, diplo_phrases) are skipped
 * because their top-level keys are definition names rather than fields.
 */
export function extractCwtCommonTypeFields(cwtContent: string, relFile: string): DeclaredCwtField[] {
    const lines = cwtContent.split(/\r?\n/);
    const typeFolders = new Map<string, string>();
    const typePerFile = new Set<string>();

    // Pass 1: map type[NAME] -> common folder and detect type_per_file.
    let inTypes = false;
    let typesDepth = 0;
    let curType = '';
    for (const rawLine of lines) {
        const line = stripLineComment(rawLine);
        if (!inTypes) {
            if (/^\s*types\s*=\s*\{/.test(line)) {
                inTypes = true;
                typesDepth = countBraceDelta(line);
            }
            continue;
        }
        if (typesDepth === 1) {
            const tm = line.match(/^\s*type\[([A-Za-z_][A-Za-z0-9_.\-]*)\]\s*=\s*\{/);
            if (tm) curType = tm[1]!.toLowerCase();
        }
        if (curType) {
            const pm = line.match(/path\s*=\s*"game\/common\/([^"]+)"/);
            if (pm && !typeFolders.has(curType)) {
                typeFolders.set(curType, normalizeCommonFolder(pm[1]!));
            }
            if (/(?:^|\s)type_per_file\s*=\s*yes\b/i.test(line)) {
                typePerFile.add(curType);
            }
        }
        typesDepth += countBraceDelta(line);
        if (typesDepth <= 1) curType = '';
        if (typesDepth <= 0) {
            inTypes = false;
            typesDepth = 0;
        }
    }

    // Pass 2: collect depth-1 named fields inside each non-type_per_file type block.
    const byKey = new Map<string, DeclaredCwtField>();
    let depth = 0;
    let activeType = '';
    let inDeclBlock = false;
    let pendingDeprecated = false;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i] ?? '';
        const trimmed = rawLine.trim();

        if (depth === 1 && activeType && !inDeclBlock) {
            if (/^##\s*error_if_only_match\s*=/.test(trimmed)) {
                pendingDeprecated = true;
            }
        }

        const line = stripLineComment(rawLine);
        if (depth === 0) {
            activeType = '';
            pendingDeprecated = false;
            if (/^\s*(types|enums|values)\s*==?\s*\{/.test(line)) {
                inDeclBlock = true;
            } else {
                inDeclBlock = false;
                const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.\-]*)\s*==?\s*\{/);
                if (m) {
                    const candidate = m[1]!.toLowerCase();
                    if (typeFolders.has(candidate) && !typePerFile.has(candidate)) {
                        activeType = candidate;
                    }
                }
            }
        } else if (depth === 1 && activeType && !inDeclBlock) {
            const fm = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]+)\s*==?\s*(\{)?/);
            if (fm) {
                const field = fm[1]!.toLowerCase();
                const kind: 'leaf' | 'block' = fm[2] ? 'block' : 'leaf';
                const folder = typeFolders.get(activeType)!;
                if (!CWT_GRAMMAR_KEYS.has(field) && !SKIPPED_COMMON_FOLDERS.has(folder)) {
                    const dedupeKey = `${activeType}::${field}`;
                    const existing = byKey.get(dedupeKey);
                    if (!existing) {
                        byKey.set(dedupeKey, {
                            file: relFile,
                            line: i + 1,
                            typeName: activeType,
                            folder,
                            field,
                            kind,
                            deprecated: pendingDeprecated,
                        });
                    } else if (!pendingDeprecated) {
                        // Only treat a field as deprecated if every overload is marked deprecated.
                        existing.deprecated = false;
                    }
                }
                pendingDeprecated = false;
            } else if (line.trim() !== '') {
                pendingDeprecated = false;
            }
        }

        depth += countBraceDelta(rawLine);
        if (depth <= 0) {
            depth = 0;
            activeType = '';
            inDeclBlock = false;
            pendingDeprecated = false;
        }
    }

    return Array.from(byKey.values());
}

/**
 * Scan a binary buffer for ASCII identifier tokens bounded by non-identifier
 * bytes. Using non-identifier boundaries instead of NUL-only boundaries avoids
 * skipping adjacent strings and captures dotted engine keys such as
 * `.set.custom_portraits`.
 */
export function extractExecutableIdentifiers(buffer: Buffer): Set<string> {
    const idents = new Set<string>();
    const isIdent = (b: number) =>
        (b >= 97 && b <= 122) || (b >= 65 && b <= 90) || (b >= 48 && b <= 57) || b === 95;
    const isAlpha = (b: number) =>
        (b >= 97 && b <= 122) || (b >= 65 && b <= 90);

    let start = -1;
    for (let i = 0; i <= buffer.length; i++) {
        const b = i < buffer.length ? buffer[i]! : 0;
        if (isIdent(b)) {
            if (start < 0) start = i;
        } else {
            if (start >= 0) {
                const len = i - start;
                if (len >= 2 && len <= 64 && isAlpha(buffer[start]!)) {
                    idents.add(buffer.toString('ascii', start, i).toLowerCase());
                }
                start = -1;
            }
        }
    }
    return idents;
}

export function resolveStellarisExecutable(gamePathOrExe: string): string {
    if (!gamePathOrExe || !fs.existsSync(gamePathOrExe)) return '';
    const stat = fs.statSync(gamePathOrExe);
    if (stat.isFile()) return gamePathOrExe;
    const candidates = [
        path.join(gamePathOrExe, 'stellaris.exe'),
        path.join(gamePathOrExe, 'stellaris'),
        path.join(gamePathOrExe, 'stellaris.app', 'Contents', 'MacOS', 'stellaris'),
    ];
    return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? '';
}

function collectVanillaTokens(vanillaCommonDir: string): {
    byFolder: Map<string, Set<string>>;
    inlineScripts: Set<string>;
} {
    const byFolder = new Map<string, Set<string>>();
    const inlineScripts = new Set<string>();

    for (const file of walkFiles(vanillaCommonDir, '.txt')) {
        const relPath = toPosix(path.relative(vanillaCommonDir, file));
        const folder = normalizeCommonFolder(path.dirname(relPath));
        const isDoc = /readme|documentation|example|how_to/i.test(path.basename(file));
        const set = byFolder.get(folder) ?? new Set<string>();
        byFolder.set(folder, set);

        const isInline = folder === 'inline_scripts' || folder.startsWith('inline_scripts/');
        for (const rawLine of readNormalizedText(file).split('\n')) {
            const clean = isDoc ? rawLine : stripLineComment(rawLine);
            for (const match of clean.matchAll(/\b([A-Za-z_][A-Za-z0-9_]+)\b/g)) {
                const token = match[1]!.toLowerCase();
                set.add(token);
                if (!isDoc && isInline) inlineScripts.add(token);
            }
        }
    }

    return { byFolder, inlineScripts };
}

export function auditStaleFields(
    vanillaCommonDir: string,
    configDir: string,
    gamePathOrExe = '',
): StaleFieldAuditReport {
    const configCommonDir = path.join(configDir, 'common');
    const cwtFiles = walkFiles(configCommonDir, '.cwt');
    const declared: DeclaredCwtField[] = [];
    for (const file of cwtFiles) {
        const relFile = toPosix(path.relative(configDir, file));
        declared.push(...extractCwtCommonTypeFields(readNormalizedText(file), relFile));
    }

    const { byFolder, inlineScripts } = collectVanillaTokens(vanillaCommonDir);
    const exePath = resolveStellarisExecutable(gamePathOrExe || path.dirname(vanillaCommonDir));
    const exeIdents = exePath ? extractExecutableIdentifiers(fs.readFileSync(exePath)) : null;

    const folderHasToken = (folder: string, token: string): boolean => {
        for (const [vanillaFolder, tokens] of byFolder) {
            if ((vanillaFolder === folder || vanillaFolder.startsWith(`${folder}/`)) && tokens.has(token)) {
                return true;
            }
        }
        return false;
    };

    const findings: StaleFieldFinding[] = [];
    let annotatedDeprecated = 0;
    let removedFromEngine = 0;
    let unusedInVanilla = 0;

    for (const item of declared) {
        if (item.deprecated) {
            annotatedDeprecated++;
            continue;
        }
        if (folderHasToken(item.folder, item.field) || inlineScripts.has(item.field)) {
            continue;
        }
        const status: StaleFieldStatus = exeIdents && !exeIdents.has(item.field)
            ? 'removed_from_engine'
            : 'unused_in_vanilla';
        if (status === 'removed_from_engine') removedFromEngine++;
        else unusedInVanilla++;

        findings.push({
            file: item.file,
            line: item.line,
            typeName: item.typeName,
            folder: item.folder,
            field: item.field,
            kind: item.kind,
            status,
        });
    }

    findings.sort((a, b) =>
        (a.status === b.status ? 0 : a.status === 'removed_from_engine' ? -1 : 1)
        || a.folder.localeCompare(b.folder)
        || a.file.localeCompare(b.file)
        || a.field.localeCompare(b.field),
    );

    return {
        configDir,
        vanillaCommonDir,
        findings,
        summary: {
            cwtFilesScanned: cwtFiles.length,
            fieldsChecked: declared.length,
            annotatedDeprecated,
            removedFromEngine,
            unusedInVanilla,
            executableScanned: Boolean(exeIdents),
            executablePath: exePath,
        },
    };
}

function parseCliArgs(argv: string[]) {
    const getArg = (flag: string, fallback = '') => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] ? path.resolve(argv[idx + 1]!) : fallback;
    };
    return {
        vanillaCommon: getArg('--vanilla-common'),
        config: getArg('--config'),
        gamePath: getArg('--game-path'),
        ci: argv.includes('--ci'),
    };
}

function main() {
    const args = parseCliArgs(process.argv.slice(2));
    if (!args.vanillaCommon || !args.config) {
        console.error('Usage: npx ts-node tools/rules-sync/stale-fields.ts --vanilla-common <dir> --config <configDir> [--game-path <dir>] [--ci]');
        process.exit(1);
    }

    const report = auditStaleFields(args.vanillaCommon, args.config, args.gamePath);
    const s = report.summary;
    console.log(
        `[stale-fields] files=${s.cwtFilesScanned} checked=${s.fieldsChecked} annotated_deprecated=${s.annotatedDeprecated} removed_from_engine=${s.removedFromEngine} unused_in_vanilla=${s.unusedInVanilla} exe=${s.executableScanned ? 'yes' : 'no'}`,
    );
    for (const f of report.findings) {
        if (f.status === 'removed_from_engine') {
            console.log(`  [removed from engine] ${f.file}:${f.line} [${f.folder}] ${f.field} (${f.kind})`);
        }
    }
    if (args.ci && s.removedFromEngine > 0) process.exit(2);
}

if (require.main === module) main();

