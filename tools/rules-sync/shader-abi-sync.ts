import * as fs from 'fs';
import * as path from 'path';

type JsonRecord = Record<string, unknown>;

const CATALOG_SCHEMA = 'cwtools/shader-abi-catalog/v1';
const AUDIT_SCHEMA = 'cwtools/shader-abi-audit/v1';
const INVENTORY_SCHEMA = 'cwtools/shader-abi-inventory/v1';
const EVIDENCE = new Set(['manual_runtime_test', 'executable_observation', 'official_vanilla_contract']);
const RENAME_POLICIES = new Set(['forbidden', 'allowed']);
const REVIEW_STAGES = [
    'vanilla_shader_inventory',
    'textual_call_sites',
    'renderer_contracts',
    'executable_or_runtime',
] as const;

interface InventoryEffect {
    name: string;
    shaderFile: string;
}

interface ParsedInventory {
    raw: JsonRecord;
    game: string;
    gameVersion: string;
    candidateUniverse: JsonRecord;
    gameIdentity: JsonRecord;
    executableStringScan: JsonRecord;
    effects: InventoryEffect[];
}

interface CatalogEntry {
    game: string;
    game_version: string;
    entry_kind: 'effect';
    name: string;
    shader_file?: string;
    evidence: 'manual_runtime_test' | 'executable_observation' | 'official_vanilla_contract';
    rename_policy: 'forbidden' | 'allowed';
    notes?: string;
}

export interface ShaderAbiUpgradeResult {
    report: JsonRecord;
    draftCatalog: JsonRecord;
    draftAudit: JsonRecord;
}

export interface ShaderAbiUpgradeInput {
    inventory: unknown;
    existingCatalog: unknown;
    existingAudit?: unknown;
    reviewedCatalog?: unknown;
    reviewedAudit?: unknown;
}

function asRecord(value: unknown, context: string): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${context} must be a JSON object.`);
    }
    return value as JsonRecord;
}

function requiredString(record: JsonRecord, name: string, context: string): string {
    const value = record[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${context}.${name} must be a non-empty string.`);
    return value.trim();
}

function requiredInteger(record: JsonRecord, name: string, context: string): number {
    const value = record[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${context}.${name} must be a non-negative integer.`);
    }
    return value;
}

function normalizeLogicalPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function parseInventory(value: unknown): ParsedInventory {
    const raw = asRecord(value, 'inventory');
    if (raw._schema !== INVENTORY_SCHEMA) throw new Error(`inventory._schema must be ${INVENTORY_SCHEMA}.`);
    const game = requiredString(raw, 'game', 'inventory').toLowerCase();
    const gameVersion = requiredString(raw, 'game_version', 'inventory');
    const candidateUniverse = asRecord(raw.candidate_universe, 'inventory.candidate_universe');
    const gameIdentity = asRecord(raw.game_identity, 'inventory.game_identity');
    const executableStringScan = asRecord(raw.executable_string_scan, 'inventory.executable_string_scan');
    for (const count of ['source_files', 'shader_files', 'effect_declarations', 'unique_effect_names']) {
        requiredInteger(candidateUniverse, count, 'inventory.candidate_universe');
    }
    for (const hash of ['inventory_sha256', 'declaration_inventory_sha256']) {
        const value = requiredString(candidateUniverse, hash, 'inventory.candidate_universe');
        if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`inventory.candidate_universe.${hash} must be SHA256.`);
    }
    const effects = Array.isArray(raw.effects) ? raw.effects.map((item, index) => {
        const effect = asRecord(item, `inventory.effects[${index}]`);
        return {
            name: requiredString(effect, 'name', `inventory.effects[${index}]`),
            shaderFile: normalizeLogicalPath(requiredString(effect, 'shader_file', `inventory.effects[${index}]`)),
        };
    }) : (() => { throw new Error('inventory.effects must be an array.'); })();
    if (effects.length !== candidateUniverse.effect_declarations) {
        throw new Error(`inventory.effects count ${effects.length} does not match candidate_universe.effect_declarations ${candidateUniverse.effect_declarations}.`);
    }
    return { raw, game, gameVersion, candidateUniverse, gameIdentity, executableStringScan, effects };
}

function catalogIdentity(entry: CatalogEntry): string {
    return `${entry.name.toLowerCase()}|${normalizeLogicalPath(entry.shader_file ?? '')}`;
}

function parseCatalog(value: unknown, inventory: ParsedInventory, context: string): CatalogEntry[] {
    const catalog = asRecord(value, context);
    if (catalog._schema !== CATALOG_SCHEMA) throw new Error(`${context}._schema must be ${CATALOG_SCHEMA}.`);
    if (requiredString(catalog, 'game', context).toLowerCase() !== inventory.game) {
        throw new Error(`${context}.game must match inventory.game.`);
    }
    if (requiredString(catalog, 'game_version', context) !== inventory.gameVersion) {
        throw new Error(`${context}.game_version must be ${inventory.gameVersion}.`);
    }
    if (!Array.isArray(catalog.entries)) throw new Error(`${context}.entries must be an array.`);
    const knownEffects = new Set(inventory.effects.map(effect => effect.name.toLowerCase()));
    const knownDeclarations = new Set(inventory.effects.map(effect => `${effect.name.toLowerCase()}|${effect.shaderFile}`));
    const seen = new Set<string>();
    return catalog.entries.map((item, index) => {
        const entry = asRecord(item, `${context}.entries[${index}]`);
        const game = requiredString(entry, 'game', `${context}.entries[${index}]`).toLowerCase();
        const gameVersion = requiredString(entry, 'game_version', `${context}.entries[${index}]`);
        const entryKind = requiredString(entry, 'entry_kind', `${context}.entries[${index}]`).toLowerCase();
        const name = requiredString(entry, 'name', `${context}.entries[${index}]`);
        const evidence = requiredString(entry, 'evidence', `${context}.entries[${index}]`).toLowerCase();
        const renamePolicy = requiredString(entry, 'rename_policy', `${context}.entries[${index}]`).toLowerCase();
        const shaderFile = typeof entry.shader_file === 'string' && entry.shader_file.trim()
            ? entry.shader_file.replace(/\\/g, '/').replace(/^\/+/, '')
            : undefined;
        if (game !== inventory.game || gameVersion !== inventory.gameVersion) {
            throw new Error(`${context}.entries[${index}] must target ${inventory.game} ${inventory.gameVersion}.`);
        }
        if (entryKind !== 'effect') throw new Error(`${context}.entries[${index}].entry_kind must be effect.`);
        if (!EVIDENCE.has(evidence)) throw new Error(`${context}.entries[${index}].evidence is not reviewed evidence.`);
        if (!RENAME_POLICIES.has(renamePolicy)) throw new Error(`${context}.entries[${index}].rename_policy must be forbidden or allowed.`);
        const declarationIdentity = `${name.toLowerCase()}|${normalizeLogicalPath(shaderFile ?? '')}`;
        if (shaderFile ? !knownDeclarations.has(declarationIdentity) : !knownEffects.has(name.toLowerCase())) {
            throw new Error(`${context}.entries[${index}] does not match an Effect declaration in the scanned corpus.`);
        }
        if (seen.has(declarationIdentity)) throw new Error(`${context}.entries[${index}] duplicates ${declarationIdentity}.`);
        seen.add(declarationIdentity);
        const parsed: CatalogEntry = {
            game,
            game_version: gameVersion,
            entry_kind: 'effect',
            name,
            ...(shaderFile ? { shader_file: shaderFile } : {}),
            evidence: evidence as CatalogEntry['evidence'],
            rename_policy: renamePolicy as CatalogEntry['rename_policy'],
            ...(typeof entry.notes === 'string' && entry.notes.trim() ? { notes: entry.notes.trim() } : {}),
        };
        return parsed;
    }).sort((left, right) => catalogIdentity(left).localeCompare(catalogIdentity(right)));
}

function existingSnapshotIsCurrent(inventory: ParsedInventory, existingAudit: unknown): boolean {
    if (!existingAudit || typeof existingAudit !== 'object' || Array.isArray(existingAudit)) return false;
    const audit = existingAudit as JsonRecord;
    if (audit._schema !== AUDIT_SCHEMA || audit.game_version !== inventory.gameVersion) return false;
    const universe = audit.candidate_universe;
    const identity = audit.game_identity;
    if (!universe || typeof universe !== 'object' || Array.isArray(universe)
        || !identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
    const oldUniverse = universe as JsonRecord;
    const oldIdentity = identity as JsonRecord;
    return oldUniverse.inventory_sha256 === inventory.candidateUniverse.inventory_sha256
        && oldUniverse.declaration_inventory_sha256 === inventory.candidateUniverse.declaration_inventory_sha256
        && oldIdentity.executable_sha256 === inventory.gameIdentity.executable_sha256;
}

function makeCatalog(inventory: ParsedInventory, entries: CatalogEntry[]): JsonRecord {
    return {
        _schema: CATALOG_SCHEMA,
        game: inventory.game,
        game_version: inventory.gameVersion,
        review_policy: 'Every entry requires reviewed runtime/executable/official evidence. Never promote an Effect merely because no textual caller was found.',
        entries,
    };
}

function makeDraftAudit(inventory: ParsedInventory, entries: CatalogEntry[], current: boolean): JsonRecord {
    const asciiHits = requiredInteger(inventory.executableStringScan, 'ascii_hits', 'inventory.executable_string_scan');
    const utf16Hits = requiredInteger(inventory.executableStringScan, 'utf16le_hits', 'inventory.executable_string_scan');
    return {
        _schema: AUDIT_SCHEMA,
        game: inventory.game,
        game_version: inventory.gameVersion,
        review_status: current ? 'complete' : 'in_progress',
        automatic_promotion: false,
        candidate_universe: { ...inventory.candidateUniverse, source_directory: 'gfx/FX' },
        game_identity: inventory.gameIdentity,
        executable_string_scan: inventory.executableStringScan,
        confirmed_engine_entries: entries.map(catalogIdentity).sort(),
        evidence_reviews: [
            {
                stage: 'vanilla_shader_inventory',
                status: 'reviewed',
                result: `${inventory.candidateUniverse.effect_declarations} Effect declarations (${inventory.candidateUniverse.unique_effect_names} case-insensitive names) were parsed by PdxShaderRuntime.`,
            },
            {
                stage: 'textual_call_sites',
                status: current ? 'reviewed' : 'needs_review',
                result: current ? 'Retained from the unchanged reviewed corpus.' : 'Re-run textual caller extraction and review added, removed, and changed calls.',
            },
            {
                stage: 'renderer_contracts',
                status: current ? 'reviewed' : 'needs_review',
                result: current ? 'Retained from the unchanged reviewed corpus.' : 'Revalidate interface effectFile coverage and every versioned renderer subtype contract.',
            },
            {
                stage: 'executable_or_runtime',
                status: current ? 'no_qualifying_evidence' : 'needs_review',
                result: `${asciiHits} ASCII and ${utf16Hits} UTF-16LE Effect-name matches are candidates only; review runtime, disassembly, or official evidence per entry.`,
            },
        ],
        excluded_evidence: [
            { signal: 'no_textual_caller', reason: 'Absence of a data caller is not proof of an executable call.' },
            { signal: 'effect_file_selection', reason: 'A renderer selecting a file does not prove every Effect in that file.' },
            { signal: 'unreviewed_executable_string', reason: 'A string occurrence without a reviewed call path or runtime observation cannot establish ABI reachability.' },
        ],
        notes: current
            ? 'The scanned corpus and executable match the completed audit; existing reviewed entries were retained.'
            : 'Upgrade draft only. Complete all four evidence reviews and supply reviewed catalog/audit files before --apply.',
    };
}

function validateReviewedAudit(value: unknown, inventory: ParsedInventory, entries: CatalogEntry[]): JsonRecord {
    const audit = asRecord(value, 'reviewedAudit');
    if (audit._schema !== AUDIT_SCHEMA) throw new Error(`reviewedAudit._schema must be ${AUDIT_SCHEMA}.`);
    if (audit.game !== inventory.game || audit.game_version !== inventory.gameVersion) {
        throw new Error('reviewedAudit game/version must match the inventory.');
    }
    if (audit.review_status !== 'complete') throw new Error('reviewedAudit.review_status must be complete before apply.');
    if (audit.automatic_promotion !== false) throw new Error('reviewedAudit.automatic_promotion must be false.');
    const universe = asRecord(audit.candidate_universe, 'reviewedAudit.candidate_universe');
    for (const field of ['source_files', 'shader_files', 'effect_declarations', 'unique_effect_names', 'inventory_sha256', 'declaration_inventory_sha256']) {
        if (universe[field] !== inventory.candidateUniverse[field]) {
            throw new Error(`reviewedAudit.candidate_universe.${field} does not match the fresh inventory.`);
        }
    }
    const identity = asRecord(audit.game_identity, 'reviewedAudit.game_identity');
    for (const field of ['launcher_settings_sha256', 'executable_size', 'executable_sha256']) {
        if (identity[field] !== inventory.gameIdentity[field]) throw new Error(`reviewedAudit.game_identity.${field} does not match the fresh inventory.`);
    }
    const confirmed = Array.isArray(audit.confirmed_engine_entries)
        ? audit.confirmed_engine_entries.filter((item): item is string => typeof item === 'string').map(item => item.toLowerCase()).sort()
        : [];
    const expected = entries.map(catalogIdentity).sort();
    if (JSON.stringify(confirmed) !== JSON.stringify(expected)) {
        throw new Error('reviewedAudit.confirmed_engine_entries must exactly match the reviewed catalog.');
    }
    if (!Array.isArray(audit.evidence_reviews)) throw new Error('reviewedAudit.evidence_reviews must be an array.');
    const reviews = new Map<string, JsonRecord>();
    audit.evidence_reviews.forEach((item, index) => {
        const review = asRecord(item, `reviewedAudit.evidence_reviews[${index}]`);
        reviews.set(requiredString(review, 'stage', `reviewedAudit.evidence_reviews[${index}]`), review);
    });
    for (const stage of REVIEW_STAGES) {
        const review = reviews.get(stage);
        if (!review) throw new Error(`reviewedAudit is missing evidence review stage ${stage}.`);
        const status = requiredString(review, 'status', `reviewedAudit.${stage}`);
        if (['needs_review', 'in_progress', 'pending'].includes(status)) {
            throw new Error(`reviewedAudit stage ${stage} is not complete.`);
        }
        requiredString(review, 'result', `reviewedAudit.${stage}`);
    }
    return audit;
}

function validateRendererContractsForApply(value: unknown, inventory: ParsedInventory): void {
    const root = asRecord(value, 'rendererContracts');
    if (!Array.isArray(root.contracts) || root.contracts.length === 0) {
        throw new Error('rendererContracts.contracts must be a non-empty array before apply.');
    }
    const declarations = new Set(inventory.effects.map(effect => `${effect.name.toLowerCase()}|${effect.shaderFile}`));
    const seen = new Set<string>();
    root.contracts.forEach((item, index) => {
        const contract = asRecord(item, `rendererContracts.contracts[${index}]`);
        if (requiredString(contract, 'game', `rendererContracts.contracts[${index}]`).toLowerCase() !== inventory.game
            || requiredString(contract, 'game_version', `rendererContracts.contracts[${index}]`) !== inventory.gameVersion) {
            throw new Error(`rendererContracts.contracts[${index}] must be re-reviewed for ${inventory.gameVersion}.`);
        }
        const subtype = requiredString(contract, 'renderer_subtype', `rendererContracts.contracts[${index}]`).toLowerCase();
        const shaderFile = normalizeLogicalPath(requiredString(contract, 'shader_file', `rendererContracts.contracts[${index}]`));
        const key = `${subtype}|${shaderFile}`;
        if (seen.has(key)) throw new Error(`rendererContracts.contracts[${index}] duplicates ${key}.`);
        seen.add(key);
        if (!Array.isArray(contract.effects) || contract.effects.length === 0) {
            throw new Error(`rendererContracts.contracts[${index}].effects must be a non-empty array.`);
        }
        contract.effects.forEach((effect, effectIndex) => {
            if (typeof effect !== 'string' || !effect.trim()
                || !declarations.has(`${effect.toLowerCase()}|${shaderFile}`)) {
                throw new Error(`rendererContracts.contracts[${index}].effects[${effectIndex}] is not declared in ${shaderFile}.`);
            }
        });
        requiredString(contract, 'evidence', `rendererContracts.contracts[${index}]`);
    });
}

export function buildShaderAbiUpgrade(input: ShaderAbiUpgradeInput): ShaderAbiUpgradeResult {
    const inventory = parseInventory(input.inventory);
    const snapshotCurrent = existingSnapshotIsCurrent(inventory, input.existingAudit);
    let entries: CatalogEntry[];
    let entrySource: 'reviewed_catalog' | 'unchanged_snapshot' | 'empty_upgrade_draft';
    if (input.reviewedCatalog !== undefined) {
        entries = parseCatalog(input.reviewedCatalog, inventory, 'reviewedCatalog');
        entrySource = 'reviewed_catalog';
    } else if (snapshotCurrent) {
        entries = parseCatalog(input.existingCatalog, inventory, 'existingCatalog');
        entrySource = 'unchanged_snapshot';
    } else {
        entries = [];
        entrySource = 'empty_upgrade_draft';
    }
    const draftCatalog = makeCatalog(inventory, entries);
    const draftAudit = input.reviewedAudit !== undefined
        ? validateReviewedAudit(input.reviewedAudit, inventory, entries)
        : makeDraftAudit(inventory, entries, snapshotCurrent);
    const existingCatalogRecord = asRecord(input.existingCatalog, 'existingCatalog');
    const previousEntries = Array.isArray(existingCatalogRecord.entries) ? existingCatalogRecord.entries.length : 0;
    const report: JsonRecord = {
        _schema: 'cwtools/shader-abi-upgrade-report/v1',
        game: inventory.game,
        from_version: typeof existingCatalogRecord.game_version === 'string' ? existingCatalogRecord.game_version : 'unknown',
        to_version: inventory.gameVersion,
        snapshot_current: snapshotCurrent,
        entry_source: entrySource,
        automatic_promotion: false,
        previous_catalog_entries: previousEntries,
        draft_catalog_entries: entries.length,
        entries_requiring_review: entrySource === 'empty_upgrade_draft' ? previousEntries : 0,
        review_status: draftAudit.review_status,
        inventory_sha256: inventory.candidateUniverse.inventory_sha256,
        declaration_inventory_sha256: inventory.candidateUniverse.declaration_inventory_sha256,
        executable_sha256: inventory.gameIdentity.executable_sha256,
        warnings: entrySource === 'empty_upgrade_draft' && previousEntries > 0
            ? ['Previous ABI entries were not copied across an unreviewed corpus/EXE version boundary.']
            : [],
    };
    return { report, draftCatalog, draftAudit };
}

function readJson(file: string): unknown {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function parseArgs(argv: string[]) {
    const value = (name: string) => {
        const index = argv.indexOf(name);
        return index >= 0 && argv[index + 1] ? path.resolve(argv[index + 1]!) : undefined;
    };
    return {
        inventory: value('--inventory'),
        config: value('--config'),
        output: value('--output'),
        reviewedCatalog: value('--reviewed-catalog'),
        reviewedAudit: value('--reviewed-audit'),
        apply: argv.includes('--apply'),
    };
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (!args.inventory || !args.config || !args.output) {
        throw new Error('Usage: shader-abi-sync.ts --inventory <scan.json> --config <configDir> --output <outDir> [--reviewed-catalog <file> --reviewed-audit <file> --apply]');
    }
    if (args.apply && (!args.reviewedCatalog || !args.reviewedAudit)) {
        throw new Error('--apply requires both --reviewed-catalog and --reviewed-audit. Drafts are never applied as trusted ABI evidence.');
    }
    const catalogPath = path.join(args.config, 'shader', 'abi-catalog.json');
    const auditPath = path.join(args.config, 'shader', 'abi-audit.json');
    const inventoryValue = readJson(args.inventory);
    if (args.apply) {
        validateRendererContractsForApply(
            readJson(path.join(args.config, 'shader', 'renderer-contracts.json')),
            parseInventory(inventoryValue),
        );
    }
    const result = buildShaderAbiUpgrade({
        inventory: inventoryValue,
        existingCatalog: readJson(catalogPath),
        existingAudit: fs.existsSync(auditPath) ? readJson(auditPath) : undefined,
        reviewedCatalog: args.reviewedCatalog ? readJson(args.reviewedCatalog) : undefined,
        reviewedAudit: args.reviewedAudit ? readJson(args.reviewedAudit) : undefined,
    });
    writeJson(path.join(args.output, 'shader-abi-upgrade-report.json'), result.report);
    writeJson(path.join(args.output, 'abi-catalog.draft.json'), result.draftCatalog);
    writeJson(path.join(args.output, 'abi-audit.draft.json'), result.draftAudit);
    if (args.apply) {
        writeJson(catalogPath, result.draftCatalog);
        writeJson(auditPath, result.draftAudit);
        console.log(`[shader-abi-sync] applied reviewed catalog and audit to ${path.join(args.config, 'shader')}`);
    }
    console.log(`[shader-abi-sync] report=${path.join(args.output, 'shader-abi-upgrade-report.json')}`);
    console.log(`[shader-abi-sync] reviewStatus=${String(result.report.review_status)} entries=${String(result.report.draft_catalog_entries)}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[shader-abi-sync] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
