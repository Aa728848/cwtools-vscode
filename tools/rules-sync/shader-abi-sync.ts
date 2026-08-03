import * as fs from 'fs';
import * as path from 'path';

type JsonRecord = Record<string, unknown>;

const CATALOG_SCHEMA = 'cwtools/shader-abi-catalog/v1';
const AUDIT_SCHEMA = 'cwtools/shader-abi-audit/v1';
const INVENTORY_SCHEMA = 'cwtools/shader-abi-inventory/v1';
const MERGE_REPORT_SCHEMA = 'cwtools/shader-abi-merge-report/v1';
const AUTO_EVIDENCE = 'automatic_inventory';
const AUTO_NOTE = 'Auto-registered from the gfx/FX inventory scan; not reviewed engine evidence.';
const CATALOG_REVIEW_POLICY = 'Entries are auto-registered from the gfx/FX inventory scan with automatic_inventory evidence and classify as engine entry points. Manually reviewed entries keep their original evidence across version upgrades while their declaration still exists.';
const EVIDENCE = new Set(['manual_runtime_test', 'executable_observation', 'official_vanilla_contract', AUTO_EVIDENCE]);
const RENAME_POLICIES = new Set(['forbidden', 'allowed']);

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
    evidence: string;
    rename_policy: string;
    notes?: string;
}

interface DroppedCatalogEntry {
    name: string;
    shader_file?: string;
    reason: string;
}

interface DroppedRendererContract {
    renderer_subtype?: string;
    shader_file?: string;
    reason: string;
}

export interface ShaderAbiAutoMergeInput {
    inventory: unknown;
    existingCatalog?: unknown;
    existingAudit?: unknown;
    existingRendererContracts?: unknown;
}

export interface ShaderAbiAutoMergeResult {
    catalog: JsonRecord;
    audit: JsonRecord;
    rendererContracts?: JsonRecord;
    mergeReport: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown, context: string): JsonRecord {
    if (!isRecord(value)) {
        throw new Error(`${context} must be a JSON object.`);
    }
    return value;
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
        const hashValue = requiredString(candidateUniverse, hash, 'inventory.candidate_universe');
        if (!/^[0-9a-f]{64}$/i.test(hashValue)) throw new Error(`inventory.candidate_universe.${hash} must be SHA256.`);
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

function parseExistingCatalogEntries(value: unknown): CatalogEntry[] {
    if (!isRecord(value) || !Array.isArray(value.entries)) return [];
    const entries: CatalogEntry[] = [];
    value.entries.forEach(item => {
        if (!isRecord(item)) return;
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!name) return;
        const evidence = typeof item.evidence === 'string' && EVIDENCE.has(item.evidence.toLowerCase())
            ? item.evidence.toLowerCase()
            : AUTO_EVIDENCE;
        const renamePolicy = typeof item.rename_policy === 'string' && RENAME_POLICIES.has(item.rename_policy.toLowerCase())
            ? item.rename_policy.toLowerCase()
            : 'forbidden';
        const shaderFile = typeof item.shader_file === 'string' && item.shader_file.trim()
            ? normalizeLogicalPath(item.shader_file)
            : undefined;
        entries.push({
            game: typeof item.game === 'string' ? item.game.toLowerCase() : 'stellaris',
            game_version: typeof item.game_version === 'string' ? item.game_version : '',
            entry_kind: 'effect',
            name,
            ...(shaderFile ? { shader_file: shaderFile } : {}),
            evidence,
            rename_policy: renamePolicy,
            ...(typeof item.notes === 'string' && item.notes.trim() ? { notes: item.notes.trim() } : {}),
        });
    });
    return entries;
}

function previousExecutableSha256(value: unknown): string | null {
    if (!isRecord(value) || !isRecord(value.game_identity)) return null;
    const hash = value.game_identity.executable_sha256;
    return typeof hash === 'string' && hash.trim() ? hash.trim().toLowerCase() : null;
}

function mergeRendererContracts(
    value: unknown,
    inventory: ParsedInventory,
    declarationIdentities: Set<string>,
): { document?: JsonRecord; kept: number; dropped: DroppedRendererContract[] } {
    if (!isRecord(value) || !Array.isArray(value.contracts)) {
        return { document: undefined, kept: 0, dropped: [] };
    }
    const schema = typeof value._schema === 'string' && value._schema.trim() ? value._schema : 'cwtools/sprite-renderer-contracts v1';
    const keptContracts: unknown[] = [];
    const dropped: DroppedRendererContract[] = [];
    const seen = new Set<string>();
    value.contracts.forEach(item => {
        if (!isRecord(item)
            || typeof item.renderer_subtype !== 'string' || !item.renderer_subtype.trim()
            || typeof item.shader_file !== 'string' || !item.shader_file.trim()
            || !Array.isArray(item.effects) || item.effects.length === 0
            || item.effects.some(effect => typeof effect !== 'string' || !effect.trim())) {
            dropped.push({ reason: 'Malformed renderer contract entry.' });
            return;
        }
        const subtype = item.renderer_subtype.trim();
        const shaderFile = normalizeLogicalPath(item.shader_file);
        const key = `${subtype.toLowerCase()}|${shaderFile}`;
        if (seen.has(key)) {
            dropped.push({ renderer_subtype: subtype, shader_file: shaderFile, reason: 'Duplicate renderer contract.' });
            return;
        }
        seen.add(key);
        const missing = (item.effects as unknown[])
            .map(effect => String(effect).trim())
            .filter(effect => !declarationIdentities.has(`${effect.toLowerCase()}|${shaderFile}`));
        if (missing.length > 0) {
            dropped.push({
                renderer_subtype: subtype,
                shader_file: shaderFile,
                reason: `Effects not declared in ${shaderFile}: ${missing.join(', ')}.`,
            });
            return;
        }
        keptContracts.push({ ...item, game: inventory.game, game_version: inventory.gameVersion });
    });
    return {
        document: { _schema: schema, contracts: keptContracts },
        kept: keptContracts.length,
        dropped,
    };
}

export function buildShaderAbiAutoMerge(input: ShaderAbiAutoMergeInput): ShaderAbiAutoMergeResult {
    const inventory = parseInventory(input.inventory);
    const declarationIdentities = new Set(inventory.effects.map(effect => `${effect.name.toLowerCase()}|${effect.shaderFile}`));
    const declarationNames = new Set(inventory.effects.map(effect => effect.name.toLowerCase()));

    const existingCatalogRecord = isRecord(input.existingCatalog) ? input.existingCatalog : {};
    const fromVersion = typeof existingCatalogRecord.game_version === 'string' ? existingCatalogRecord.game_version : 'unknown';
    const existingEntries = parseExistingCatalogEntries(input.existingCatalog);

    const carried: CatalogEntry[] = [];
    const droppedEntries: DroppedCatalogEntry[] = [];
    const coveredIdentities = new Set<string>();
    const coveredNames = new Set<string>();
    for (const entry of existingEntries) {
        const identity = catalogIdentity(entry);
        const matches = entry.shader_file
            ? declarationIdentities.has(identity)
            : declarationNames.has(entry.name.toLowerCase());
        const drop = (reason: string) => droppedEntries.push({
            name: entry.name,
            ...(entry.shader_file ? { shader_file: entry.shader_file } : {}),
            reason,
        });
        if (!matches) {
            drop('No matching Effect declaration in the scanned corpus.');
            continue;
        }
        if (coveredIdentities.has(identity)) {
            drop('Duplicate catalog entry.');
            continue;
        }
        if (entry.shader_file) coveredIdentities.add(identity);
        else coveredNames.add(entry.name.toLowerCase());
        carried.push({ ...entry, game: inventory.game, game_version: inventory.gameVersion });
    }

    const added: CatalogEntry[] = [];
    const addedIdentities = new Set<string>();
    for (const effect of inventory.effects) {
        const identity = `${effect.name.toLowerCase()}|${effect.shaderFile}`;
        if (coveredIdentities.has(identity) || coveredNames.has(effect.name.toLowerCase()) || addedIdentities.has(identity)) continue;
        addedIdentities.add(identity);
        added.push({
            game: inventory.game,
            game_version: inventory.gameVersion,
            entry_kind: 'effect',
            name: effect.name,
            shader_file: effect.shaderFile,
            evidence: AUTO_EVIDENCE,
            rename_policy: 'forbidden',
            notes: AUTO_NOTE,
        });
    }

    const entries = [...carried, ...added].sort((left, right) => catalogIdentity(left).localeCompare(catalogIdentity(right)));
    const confirmedIdentities = entries.map(catalogIdentity).sort();

    const contracts = mergeRendererContracts(input.existingRendererContracts, inventory, declarationIdentities);

    const asciiHits = requiredInteger(inventory.executableStringScan, 'ascii_hits', 'inventory.executable_string_scan');
    const utf16Hits = requiredInteger(inventory.executableStringScan, 'utf16le_hits', 'inventory.executable_string_scan');

    const catalog: JsonRecord = {
        _schema: CATALOG_SCHEMA,
        game: inventory.game,
        game_version: inventory.gameVersion,
        review_policy: CATALOG_REVIEW_POLICY,
        entries,
    };

    const audit: JsonRecord = {
        _schema: AUDIT_SCHEMA,
        game: inventory.game,
        game_version: inventory.gameVersion,
        review_status: 'complete',
        automatic_promotion: false,
        candidate_universe: { ...inventory.candidateUniverse, source_directory: 'gfx/FX' },
        game_identity: inventory.gameIdentity,
        executable_string_scan: inventory.executableStringScan,
        confirmed_engine_entries: confirmedIdentities,
        evidence_reviews: [
            {
                stage: 'vanilla_shader_inventory',
                status: 'reviewed',
                result: `${inventory.candidateUniverse.effect_declarations} Effect declarations (${inventory.candidateUniverse.unique_effect_names} case-insensitive names) were parsed by PdxShaderRuntime.`,
            },
            {
                stage: 'textual_call_sites',
                status: 'no_qualifying_evidence',
                result: 'The automatic merge does not extract textual call sites; carried entries were revalidated only against declaration identities.',
            },
            {
                stage: 'renderer_contracts',
                status: 'reviewed',
                result: `${contracts.kept} renderer contracts re-validated against the fresh declaration inventory; ${contracts.dropped.length} removed.`,
            },
            {
                stage: 'executable_or_runtime',
                status: 'no_qualifying_evidence',
                result: `${asciiHits} ASCII and ${utf16Hits} UTF-16LE Effect-name matches are candidate signals only; automatic_inventory entries are not reviewed engine evidence.`,
            },
        ],
        notes: 'Automatically merged by stellaris-rules-sync report mode from a fresh shader-abi inventory; no manual review was performed.',
    };

    const previousExe = previousExecutableSha256(input.existingAudit);
    const currentExe = typeof inventory.gameIdentity.executable_sha256 === 'string'
        ? String(inventory.gameIdentity.executable_sha256).toLowerCase()
        : null;

    const mergeReport: JsonRecord = {
        _schema: MERGE_REPORT_SCHEMA,
        game: inventory.game,
        from_version: fromVersion,
        to_version: inventory.gameVersion,
        automatic_merge: true,
        game_identity: {
            previous_executable_sha256: previousExe,
            executable_sha256: currentExe,
            executable_changed: previousExe !== null && currentExe !== null && previousExe !== currentExe,
        },
        declarations: {
            effect_declarations: inventory.candidateUniverse.effect_declarations,
            unique_effect_names: inventory.candidateUniverse.unique_effect_names,
            inventory_sha256: inventory.candidateUniverse.inventory_sha256,
            declaration_inventory_sha256: inventory.candidateUniverse.declaration_inventory_sha256,
        },
        catalog: {
            total_entries: entries.length,
            carried: carried.map(catalogIdentity).sort(),
            added: added.map(catalogIdentity).sort(),
            dropped: droppedEntries,
        },
        renderer_contracts: {
            skipped: contracts.document === undefined,
            kept: contracts.kept,
            dropped: contracts.dropped,
        },
        executable_string_scan: {
            ascii_hits: asciiHits,
            utf16le_hits: utf16Hits,
        },
    };

    return { catalog, audit, rendererContracts: contracts.document, mergeReport };
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
    };
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (!args.inventory || !args.config || !args.output) {
        throw new Error('Usage: shader-abi-sync.ts --inventory <scan.json> --config <configDir> --output <outDir>');
    }
    const shaderDir = path.join(args.config, 'shader');
    const catalogPath = path.join(shaderDir, 'abi-catalog.json');
    const auditPath = path.join(shaderDir, 'abi-audit.json');
    const contractsPath = path.join(shaderDir, 'renderer-contracts.json');

    const result = buildShaderAbiAutoMerge({
        inventory: readJson(args.inventory),
        existingCatalog: fs.existsSync(catalogPath) ? readJson(catalogPath) : undefined,
        existingAudit: fs.existsSync(auditPath) ? readJson(auditPath) : undefined,
        existingRendererContracts: fs.existsSync(contractsPath) ? readJson(contractsPath) : undefined,
    });

    const backupDir = path.join(args.output, 'previous');
    for (const file of [catalogPath, auditPath, contractsPath]) {
        if (fs.existsSync(file)) {
            fs.mkdirSync(backupDir, { recursive: true });
            fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
        }
    }

    writeJson(catalogPath, result.catalog);
    writeJson(auditPath, result.audit);
    if (result.rendererContracts) writeJson(contractsPath, result.rendererContracts);
    const reportPath = path.join(args.output, 'shader-abi-merge-report.json');
    writeJson(reportPath, result.mergeReport);

    const catalogReport = result.mergeReport.catalog as JsonRecord;
    console.log(`[shader-abi-sync] auto-merged ${String(result.mergeReport.from_version)} -> ${String(result.mergeReport.to_version)}: entries=${String(catalogReport.total_entries)} carried=${(catalogReport.carried as unknown[]).length} added=${(catalogReport.added as unknown[]).length} dropped=${(catalogReport.dropped as unknown[]).length}`);
    console.log(`[shader-abi-sync] applied to ${shaderDir}`);
    console.log(`[shader-abi-sync] report=${reportPath}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[shader-abi-sync] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
