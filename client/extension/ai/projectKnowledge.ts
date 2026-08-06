import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { getCacheSettingKey, getGameIdForVanillaCacheFile, getVanillaCacheFileName } from '../gameProfiles';
import type { IndexService } from '../indexing/indexService';
import { isPathInsideOrEqual } from '../pathScope';
import { ErrorReporter } from './errorReporter';
import { aiText } from './messages';
import { readProjectProfile } from './projectProfile';
import type {
    ProjectProfile,
    QueryProjectKnowledgeArgs,
    QueryProjectKnowledgeResult,
} from './types';

export const PROJECT_KNOWLEDGE_SCHEMA_VERSION = 7;
export const PROJECT_KNOWLEDGE_CAPABILITY_VERSIONS = Object.freeze({
    inlineGraph: 2,
    stateFlow: 3,
    overrideResolution: 2,
    interfaceGraph: 2,
    localisationAudit: 3,
    pdxFlow: 3,
});
export const PROJECT_KNOWLEDGE_RELATIVE_DIR = path.join('.cwtools', 'project', 'knowledge');

export interface ProjectKnowledgeManifest {
    schemaVersion: 7;
    capabilityVersions: Record<keyof typeof PROJECT_KNOWLEDGE_CAPABILITY_VERSIONS, number>;
    capabilityStatus: Record<keyof typeof PROJECT_KNOWLEDGE_CAPABILITY_VERSIONS, 'ready' | 'legacy' | 'unavailable'>;
    generatedAt: string;
    generationMode: 'full' | 'incremental';
    status: 'ready' | 'partial' | 'stale' | 'loading' | 'unavailable' | 'error';
    game: string;
    graphVersion?: number;
    /** True when the database was produced without definition/topology snapshot caps. */
    completeExport?: boolean;
    projectRoots: string[];
    domains: string[];
    counts: {
        definitions: number;
        availableDefinitions?: number;
        workspaceDefinitions: number;
        workspaceDeclaredDefinitions?: number;
        workspaceSyntheticDefinitions?: number;
        dependencyDefinitions?: number;
        vanillaDefinitions: number;
        curatedDefinitions?: number;
        declaredDefinitions?: number;
        syntheticDefinitions?: number;
        derivedDefinitions?: number;
        lineZeroDefinitions?: number;
        definitionStacks: number;
        topologyFiles: number;
        topologyEdges: number;
        eventNodes?: number;
        eventEdges?: number;
        eventLogic?: number;
    };
    fingerprints: {
        project: string;
        vanilla: string;
        rules: string;
    };
    freshness?: Record<string, unknown>;
    /** Deterministic export benchmark (provenance counts, line-0, ratios, size). */
    baseline?: Record<string, unknown>;
    /** Unified coverage contract (considered/indexed/truncated/staleReasons). */
    coverage?: Record<string, unknown>;
    warnings: string[];
    staleReasons: string[];
    artifacts: string[];
    database?: {
        path: string;
        format: 'sqlite';
        schemaVersion: 7;
    };
}

interface LspKnowledgeSnapshot {
    ok: boolean;
    status: ProjectKnowledgeManifest['status'];
    source?: string;
    schemaVersion?: number;
    capabilityVersions?: Partial<Record<keyof typeof PROJECT_KNOWLEDGE_CAPABILITY_VERSIONS, number>>;
    capabilityStatus?: Partial<Record<keyof typeof PROJECT_KNOWLEDGE_CAPABILITY_VERSIONS, 'ready' | 'legacy' | 'unavailable'>>;
    game?: string;
    generatedAtUnixMs?: number;
    graphVersion?: number;
    completeExport?: boolean;
    projectRoots?: string[];
    databasePath?: string;
    generationMode?: 'full' | 'incremental';
    counts?: ProjectKnowledgeManifest['counts'];
    definitions?: Array<Record<string, unknown>>;
    typeSummaries?: Array<Record<string, unknown>>;
    definitionStacks?: Array<Record<string, unknown>>;
    domains?: Array<Record<string, unknown>>;
    topology?: {
        files?: Array<Record<string, unknown>>;
        edges?: Array<Record<string, unknown>>;
        truncated?: boolean;
    };
    overrideModes?: Array<Record<string, unknown>>;
    overrideModeInfo?: Array<Record<string, unknown>>;
    freshness?: Record<string, unknown>;
    baseline?: Record<string, unknown>;
    coverage?: Record<string, unknown>;
    warnings?: string[];
    error?: string;
}

interface LspValidationStatus {
    ok?: boolean;
    inProgress?: boolean;
    pendingGlobalKinds?: unknown;
    modelReadyForKnowledgeExport?: unknown;
    loading?: unknown;
}

export class ProjectKnowledgeModelNotReadyError extends Error {}

export interface GenerateProjectKnowledgeOptions {
    mode?: 'full' | 'incremental';
    changedFiles?: string[];
    domains?: string[];
    /** Export every definition and topology fact instead of applying bounded snapshot limits. */
    complete?: boolean;
    /** Refuse to scan/write while the LSP model still has transient refresh work. */
    requireReady?: boolean;
}

const RELEVANT_EXTENSIONS = new Set(['.txt', '.gfx', '.asset', '.gui', '.yml', '.cwt', '.mod', '.shader', '.fxh']);
const GRAPH_WIDE_EXTENSIONS = new Set(['.gfx', '.asset', '.gui', '.cwt', '.mod', '.shader', '.fxh']);
const EXCLUDED_DIRECTORIES = new Set(['.git', '.cwtools', '.cwtools-ai', 'node_modules', 'release', 'artifacts', 'dist', 'out']);
let watcherRegistration: vs.Disposable | undefined;
interface PendingRootRefresh {
    workspaceRoot: string;
    changedFiles: Set<string>;
    staleReasons: Set<string>;
    fullRefresh: boolean;
    timer?: ReturnType<typeof setTimeout>;
    inFlight?: Promise<void>;
}
const pendingRootRefreshes = new Map<string, PendingRootRefresh>();
let pendingVanillaIndexAll = false;
const pendingVanillaIndexGames = new Set<string>();
let vanillaCacheDirectory: string | undefined;

function workspaceRootKey(workspaceRoot: string): string {
    const resolved = path.resolve(workspaceRoot);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pendingRootRefresh(workspaceRoot: string): PendingRootRefresh {
    const key = workspaceRootKey(workspaceRoot);
    let state = pendingRootRefreshes.get(key);
    if (!state) {
        state = {
            workspaceRoot: path.resolve(workspaceRoot),
            changedFiles: new Set<string>(),
            staleReasons: new Set<string>(),
            fullRefresh: false,
        };
        pendingRootRefreshes.set(key, state);
    }
    return state;
}

function findKnowledgeOwnerRoot(sourceWorkspaceRoot: string): string | undefined {
    const sourceKey = workspaceRootKey(sourceWorkspaceRoot);
    for (const folder of vs.workspace.workspaceFolders ?? []) {
        const candidateRoot = folder.uri.fsPath;
        const manifest = readProjectKnowledgeManifest(candidateRoot);
        if (!manifest) continue;
        const projectRoots = manifest.projectRoots?.length ? manifest.projectRoots : [candidateRoot];
        if (projectRoots.some(root => workspaceRootKey(root) === sourceKey)) return candidateRoot;
    }
    return undefined;
}

function primaryKnowledgeRoot(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.cwtools', 'project', 'knowledge');
}

function existingProjectKnowledgeManifestPath(workspaceRoot: string): string {
    return path.join(primaryKnowledgeRoot(workspaceRoot), 'manifest.json');
}

export function getProjectKnowledgeManifestPath(workspaceRoot: string): string {
    return path.join(primaryKnowledgeRoot(workspaceRoot), 'manifest.json');
}

export function getProjectKnowledgeDatabasePath(workspaceRoot: string): string {
    return path.join(primaryKnowledgeRoot(workspaceRoot), 'knowledge.sqlite');
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/');
}

function hashParts(parts: string[]): string {
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function collectRelevantFileFacts(root: string, maxFiles = 10000): string[] {
    const facts: string[] = [];
    const stack = [root];
    while (stack.length > 0 && facts.length < maxFiles) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (facts.length >= maxFiles) break;
            if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile() || !RELEVANT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            try {
                const stat = fs.statSync(fullPath);
                // Keep the filesystem's sub-millisecond precision. Flooring made
                // same-size Shader edits within one millisecond invisible to the
                // project-knowledge freshness check.
                facts.push(`${normalizePath(path.relative(root, fullPath))}:${stat.size}:${stat.mtimeMs}`);
            } catch {
                // Ignore files that disappeared during fingerprinting.
            }
        }
    }
    return facts.sort();
}

export function computeProjectKnowledgeFingerprint(workspaceRoot: string, projectRoots: string[] = [workspaceRoot]): string {
    const roots = Array.from(new Set(projectRoots.map(root => path.resolve(root)))).sort((a, b) => a.localeCompare(b));
    if (roots.length === 1 && workspaceRootKey(roots[0]!) === workspaceRootKey(workspaceRoot)) {
        return hashParts(collectRelevantFileFacts(workspaceRoot));
    }
    return hashParts(roots.flatMap(root => [normalizePath(root), ...collectRelevantFileFacts(root)]));
}

function pathStatFact(target: string): string {
    try {
        const stat = fs.statSync(target);
        return `${normalizePath(target)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
        return `${normalizePath(target)}:missing`;
    }
}

function computeVanillaFingerprint(gameId: string): string {
    if (!gameId || gameId === 'unknown' || gameId === 'paradox') return hashParts(['unconfigured']);
    const config = vs.workspace.getConfiguration('stellarisLanguageServices');
    const vanillaPath = config.get<string>(getCacheSettingKey(gameId), '')?.trim() ?? '';
    if (!vanillaPath) return hashParts(['missing']);
    const parent = path.dirname(vanillaPath);
    const cacheFileName = getVanillaCacheFileName(gameId);
    const serializedCache = cacheFileName && vanillaCacheDirectory
        ? path.join(vanillaCacheDirectory, cacheFileName)
        : '';
    return hashParts([
        normalizePath(vanillaPath),
        pathStatFact(vanillaPath),
        ...collectVanillaRootFacts(vanillaPath),
        pathStatFact(path.join(vanillaPath, 'checksum_manifest.txt')),
        pathStatFact(path.join(parent, 'checksum_manifest.txt')),
        pathStatFact(path.join(vanillaPath, 'launcher-settings.json')),
        serializedCache ? pathStatFact(serializedCache) : 'cwb:unconfigured',
    ]);
}

function collectVanillaRootFacts(vanillaPath: string, limit = 256): string[] {
    try {
        return fs.readdirSync(vanillaPath, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, limit)
            .map(entry => pathStatFact(path.join(vanillaPath, entry.name)));
    } catch {
        return ['vanilla-root:unreadable'];
    }
}

function computeRulesFingerprint(gameId: string, graphVersion?: number): string {
    const config = vs.workspace.getConfiguration('stellarisLanguageServices');
    return hashParts([
        gameId,
        String(config.get<string>('rules_version', 'latest')),
        String(config.get<string>('rules_folder', '')),
        String(config.get<string>('rules_remote_url', '')),
        String(graphVersion ?? ''),
    ]);
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
        fs.renameSync(tempPath, filePath);
    } catch {
        try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
        fs.renameSync(tempPath, filePath);
    }
}

function readJson<T>(filePath: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

function stringField(record: Record<string, unknown>, key: string): string {
    return typeof record[key] === 'string' ? String(record[key]) : '';
}

const NON_CURRENT_KNOWLEDGE_ARTIFACTS = [
    'snapshot.json',
    'topology.json',
    'definition-stacks.json',
    'override-map.json',
    'unresolved.json',
];

function removeNonCurrentKnowledgeArtifacts(root: string): void {
    for (const directory of ['capabilities', 'archetypes']) {
        try { fs.rmSync(path.join(root, directory), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const artifact of NON_CURRENT_KNOWLEDGE_ARTIFACTS) {
        try { fs.rmSync(path.join(root, artifact), { force: true }); } catch { /* ignore */ }
    }
}

async function requestLspKnowledgeSnapshot(
    workspaceRoot: string,
    gameId: string,
    options: GenerateProjectKnowledgeOptions,
): Promise<LspKnowledgeSnapshot> {
    const configuredVanillaRoot = gameId && gameId !== 'unknown' && gameId !== 'paradox'
        ? vs.workspace.getConfiguration('stellarisLanguageServices').get<string>(getCacheSettingKey(gameId), '')?.trim()
        : '';
    const result = await vs.commands.executeCommand<LspKnowledgeSnapshot>(
        'cwtools.ai.exportProjectKnowledge',
        {
            domains: options.domains ?? [],
            changedFiles: options.changedFiles ?? [],
            maxDefinitions: 100000,
            maxTopologyFiles: 1200,
            maxEdges: 8000,
            archetypesPerDomain: 8,
            completeExport: options.complete === true,
            requireReady: options.requireReady === true,
            databasePath: getProjectKnowledgeDatabasePath(workspaceRoot),
            workspaceRoot: path.resolve(workspaceRoot),
            vanillaRoot: configuredVanillaRoot ? path.resolve(configuredVanillaRoot) : undefined,
            generationMode: options.mode ?? 'full',
        },
    );
    if (!result || result.ok !== true) {
        if (result?.status === 'loading' || result?.status === 'stale') {
            throw new ProjectKnowledgeModelNotReadyError(
                result.error || `CWTools project knowledge export is waiting for the ${result.status} model to become ready.`,
            );
        }
        throw new Error(result?.error || 'CWTools project knowledge export is unavailable.');
    }
    if (Number(result.schemaVersion) !== PROJECT_KNOWLEDGE_SCHEMA_VERSION) {
        throw new Error(
            `CWTools returned obsolete project knowledge schema V${Number(result.schemaVersion) || 0}; current V${PROJECT_KNOWLEDGE_SCHEMA_VERSION} is required.`,
        );
    }
    return result;
}

export async function generateProjectKnowledge(
    workspaceRoot: string,
    profile: ProjectProfile,
    options: GenerateProjectKnowledgeOptions = {},
): Promise<ProjectKnowledgeManifest> {
    const root = primaryKnowledgeRoot(workspaceRoot);
    fs.mkdirSync(root, { recursive: true });
    const snapshot = await requestLspKnowledgeSnapshot(workspaceRoot, profile.game.id, options);
    const databasePath = getProjectKnowledgeDatabasePath(workspaceRoot);
    if (!fs.existsSync(databasePath)) {
        throw new Error('CWTools reported a successful export but knowledge.sqlite was not created.');
    }
    const gameId = snapshot.game || profile.game.id;
    const domains = Array.from(new Set((snapshot.domains ?? [])
        .map(item => stringField(item, 'id'))
        .filter(Boolean))).sort();
    const counts = snapshot.counts ?? {
        definitions: 0,
        workspaceDefinitions: 0,
        vanillaDefinitions: 0,
        definitionStacks: 0,
        topologyFiles: 0,
        topologyEdges: 0,
        eventNodes: 0,
        eventEdges: 0,
        eventLogic: 0,
    };

    const projectRoots = snapshot.projectRoots ?? [workspaceRoot];
    const manifest: ProjectKnowledgeManifest = {
        schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
        capabilityVersions: { ...PROJECT_KNOWLEDGE_CAPABILITY_VERSIONS, ...snapshot.capabilityVersions },
        capabilityStatus: {
            inlineGraph: 'unavailable', stateFlow: 'unavailable', overrideResolution: 'unavailable',
            interfaceGraph: 'unavailable', localisationAudit: 'unavailable', pdxFlow: 'unavailable',
            ...snapshot.capabilityStatus,
        },
        generatedAt: new Date(snapshot.generatedAtUnixMs ?? Date.now()).toISOString(),
        generationMode: snapshot.generationMode ?? 'full',
        status: snapshot.status,
        game: gameId,
        graphVersion: snapshot.graphVersion,
        completeExport: snapshot.completeExport === true,
        projectRoots,
        domains,
        counts,
        fingerprints: {
            project: computeProjectKnowledgeFingerprint(workspaceRoot, projectRoots),
            vanilla: computeVanillaFingerprint(gameId),
            rules: computeRulesFingerprint(gameId, snapshot.graphVersion),
        },
        freshness: snapshot.freshness,
        baseline: snapshot.baseline,
        coverage: snapshot.coverage,
        warnings: snapshot.warnings ?? [],
        staleReasons: [],
        artifacts: ['knowledge.sqlite'],
        database: {
            path: 'knowledge.sqlite',
            format: 'sqlite',
            schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
        },
    };
    // The database is atomically replaced by the server. Publish the compact
    // manifest only after it exists, then remove V1 files so a failed migration
    // always leaves the previous knowledge pack recoverable.
    writeJson(getProjectKnowledgeManifestPath(workspaceRoot), manifest);
    removeNonCurrentKnowledgeArtifacts(root);
    return manifest;
}

export function writeUnavailableProjectKnowledge(
    workspaceRoot: string,
    profile: ProjectProfile,
    reason: string,
): ProjectKnowledgeManifest {
    const root = primaryKnowledgeRoot(workspaceRoot);
    fs.mkdirSync(root, { recursive: true });
    const generatedAt = new Date().toISOString();
    const gameId = profile.game.id || 'unknown';
    const existingManifest = readProjectKnowledgeManifest(workspaceRoot);
    const hasCurrentDatabase = fs.existsSync(getProjectKnowledgeDatabasePath(workspaceRoot))
        && Number(existingManifest?.schemaVersion) === PROJECT_KNOWLEDGE_SCHEMA_VERSION
        && Number(existingManifest?.database?.schemaVersion) === PROJECT_KNOWLEDGE_SCHEMA_VERSION;

    const manifest: ProjectKnowledgeManifest = {
        schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
        capabilityVersions: { ...PROJECT_KNOWLEDGE_CAPABILITY_VERSIONS },
        capabilityStatus: {
            inlineGraph: 'unavailable', stateFlow: 'unavailable', overrideResolution: 'unavailable',
            interfaceGraph: 'unavailable', localisationAudit: 'unavailable', pdxFlow: 'unavailable',
        },
        generatedAt,
        generationMode: 'full',
        status: 'unavailable',
        game: gameId,
        projectRoots: [workspaceRoot],
        domains: [],
        counts: {
            definitions: 0,
            workspaceDefinitions: 0,
            vanillaDefinitions: 0,
            definitionStacks: 0,
            topologyFiles: 0,
            topologyEdges: 0,
        },
        fingerprints: {
            project: computeProjectKnowledgeFingerprint(workspaceRoot),
            vanilla: computeVanillaFingerprint(gameId),
            rules: computeRulesFingerprint(gameId),
        },
        warnings: [reason],
        staleReasons: ['lsp_export_unavailable'],
        artifacts: hasCurrentDatabase ? ['knowledge.sqlite'] : [],
        database: hasCurrentDatabase ? {
            path: 'knowledge.sqlite',
            format: 'sqlite',
            schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
        } : undefined,
    };
    writeJson(getProjectKnowledgeManifestPath(workspaceRoot), manifest);
    return manifest;
}

export function readProjectKnowledgeManifest(workspaceRoot: string): ProjectKnowledgeManifest | undefined {
    const manifestPath = existingProjectKnowledgeManifestPath(workspaceRoot);
    if (fs.existsSync(manifestPath)) return readJson<ProjectKnowledgeManifest>(manifestPath);
    return undefined;
}

function currentStaleReasons(workspaceRoot: string, manifest: ProjectKnowledgeManifest): string[] {
    const reasons = [...(manifest.staleReasons ?? [])];
    if (manifest.status !== 'ready' && manifest.status !== 'partial') reasons.push(`knowledge_${manifest.status}`);
    if (Number(manifest.schemaVersion) !== PROJECT_KNOWLEDGE_SCHEMA_VERSION
        || Number(manifest.database?.schemaVersion) !== PROJECT_KNOWLEDGE_SCHEMA_VERSION) {
        reasons.push('schema_version_changed');
        return Array.from(new Set(reasons));
    }
    if (computeProjectKnowledgeFingerprint(workspaceRoot, manifest.projectRoots) !== manifest.fingerprints.project) reasons.push('workspace_files_changed');
    if (computeVanillaFingerprint(manifest.game) !== manifest.fingerprints.vanilla) reasons.push('vanilla_changed');
    if (computeRulesFingerprint(manifest.game, manifest.graphVersion) !== manifest.fingerprints.rules) reasons.push('rules_changed');
    return Array.from(new Set(reasons));
}

export function markProjectKnowledgeStale(workspaceRoot: string, reasons: string[]): void {
    const manifest = readProjectKnowledgeManifest(workspaceRoot);
    if (!manifest) return;
    const staleReasons = Array.from(new Set([...(manifest.staleReasons ?? []), ...reasons]));
    if (manifest.status === 'stale' && staleReasons.length === (manifest.staleReasons ?? []).length) return;
    manifest.status = 'stale';
    manifest.staleReasons = staleReasons;
    const primary = path.join(primaryKnowledgeRoot(workspaceRoot), 'manifest.json');
    writeJson(primary, manifest);
}

export async function queryProjectKnowledge(
    workspaceRoot: string,
    args: QueryProjectKnowledgeArgs = {},
): Promise<QueryProjectKnowledgeResult> {
    const manifest = readProjectKnowledgeManifest(workspaceRoot);
    if (!manifest) {
        return {
            status: 'missing',
            manifestPath: existingProjectKnowledgeManifestPath(workspaceRoot),
            domains: [],
            evidence: [],
            unresolved: [],
            _hint: 'Run /init and wait for the current project knowledge database to be built.',
        };
    }
    if (Number(manifest.schemaVersion) !== PROJECT_KNOWLEDGE_SCHEMA_VERSION
        || Number(manifest.database?.schemaVersion) !== PROJECT_KNOWLEDGE_SCHEMA_VERSION) {
        return {
            status: 'stale',
            manifestPath: existingProjectKnowledgeManifestPath(workspaceRoot),
            generatedAt: manifest.generatedAt,
            game: manifest.game,
            graphVersion: manifest.graphVersion,
            staleReasons: ['schema_version_obsolete'],
            rebuildRequired: true,
            foundSchemaVersion: Number(manifest.database?.schemaVersion ?? manifest.schemaVersion) || 0,
            currentSchemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
            domains: [],
            evidence: [],
            unresolved: [],
            error: `Project knowledge schema is obsolete. Rebuild it with the current V${PROJECT_KNOWLEDGE_SCHEMA_VERSION} extension.`,
            _hint: 'Run /init or reopen the project and wait for the automatic full rebuild. Old database schemas are not queried.',
        };
    }

    const root = primaryKnowledgeRoot(workspaceRoot);
    const manifestPath = path.join(root, 'manifest.json');
    const configuredDatabasePath = typeof manifest.database?.path === 'string' && manifest.database.path.trim()
        ? manifest.database.path
        : 'knowledge.sqlite';
    const databasePath = path.resolve(root, configuredDatabasePath);
    if (!isPathInsideOrEqual(databasePath, root)) {
        return {
            status: 'error',
            manifestPath,
            generatedAt: manifest.generatedAt,
            game: manifest.game,
            graphVersion: manifest.graphVersion,
            staleReasons: ['invalid_database_path'],
            domains: [],
            evidence: [],
            unresolved: [],
            eventGraph: { nodes: [], edges: [], logic: [] },
            error: 'Project knowledge database path escapes the knowledge directory.',
        };
    }
    if (!fs.existsSync(databasePath)) {
        return {
            status: 'error',
            manifestPath,
            generatedAt: manifest.generatedAt,
            game: manifest.game,
            graphVersion: manifest.graphVersion,
            staleReasons: ['knowledge_database_missing'],
            domains: [],
            evidence: [],
            unresolved: [],
            eventGraph: { nodes: [], edges: [], logic: [] },
            error: 'knowledge.sqlite is missing. Rerun /init to rebuild the project knowledge database.',
        };
    }

    const staleReasons = currentStaleReasons(workspaceRoot, manifest);
    try {
        const result = await vs.commands.executeCommand<Record<string, unknown>>(
            'cwtools.ai.queryProjectKnowledgeDb',
            {
                databasePath,
                ...args,
                includeEventGraph: args.includeEventGraph !== false,
            },
        );
        if (!result || result.ok !== true) {
            const message = typeof result?.error === 'string' ? result.error : 'CWTools project knowledge query failed.';
            throw new Error(message);
        }
        const resultStatus = String(result.status ?? manifest.status);
        const status: QueryProjectKnowledgeResult['status'] = staleReasons.length > 0
            ? 'stale'
            : resultStatus === 'partial' || manifest.status === 'partial'
                ? 'partial'
                : resultStatus === 'ready' && manifest.status === 'ready'
                    ? 'ready'
                    : 'stale';
        return {
            status,
            manifestPath,
            generatedAt: typeof result.generatedAt === 'string' ? result.generatedAt : manifest.generatedAt,
            game: typeof result.game === 'string' ? result.game : manifest.game,
            graphVersion: typeof result.graphVersion === 'number' ? result.graphVersion : manifest.graphVersion,
            retrieval: result.retrieval && typeof result.retrieval === 'object'
                ? result.retrieval as QueryProjectKnowledgeResult['retrieval']
                : undefined,
            coverage: result.coverage && typeof result.coverage === 'object'
                ? result.coverage as QueryProjectKnowledgeResult['coverage']
                : undefined,
            staleReasons,
            domains: Array.isArray(result.domains) ? result.domains.filter((item): item is string => typeof item === 'string') : [],
            capabilities: Array.isArray(result.capabilities) ? result.capabilities as Array<Record<string, unknown>> : [],
            evidence: Array.isArray(result.evidence) ? result.evidence as Array<Record<string, unknown>> : [],
            unresolved: Array.isArray(result.unresolved) ? result.unresolved as Array<Record<string, unknown>> : [],
            eventGraph: result.eventGraph && typeof result.eventGraph === 'object'
                ? result.eventGraph as QueryProjectKnowledgeResult['eventGraph']
                : { nodes: [], edges: [], logic: [] },
            inlineGraph: result.inlineGraph && typeof result.inlineGraph === 'object'
                ? result.inlineGraph as QueryProjectKnowledgeResult['inlineGraph']
                : undefined,
            definitionStacks: Array.isArray(result.definitionStacks)
                ? result.definitionStacks as Array<Record<string, unknown>>
                : [],
            requiredNextChecks: Array.isArray(result.requiredNextChecks)
                ? result.requiredNextChecks.filter((item): item is string => typeof item === 'string')
                : [],
            _hint: status === 'partial'
                ? 'Knowledge topology is partial because export limits were reached. Use targeted CWT/LSP queries before treating missing relationships as absent.'
                : staleReasons.length > 0
                ? 'Knowledge is stale. The background watcher will refresh it when the LSP is ready; rerun /init for an immediate rebuild.'
                : 'The SQLite knowledge graph is retrieval evidence. Exact CWT/LSP legality checks remain authoritative.',
        };
    } catch (error) {
        return {
            status: 'error',
            manifestPath,
            generatedAt: manifest.generatedAt,
            game: manifest.game,
            graphVersion: manifest.graphVersion,
            staleReasons: Array.from(new Set([...staleReasons, 'knowledge_query_failed'])),
            domains: [],
            evidence: [],
            unresolved: [],
            eventGraph: { nodes: [], edges: [], logic: [] },
            error: error instanceof Error ? error.message : String(error),
            _hint: 'Keep the CWTools language server running and retry; rerun /init if the database is stale or damaged.',
        };
    }
}

export function buildProjectKnowledgePrompt(workspaceRoot: string): string {
    const manifest = readProjectKnowledgeManifest(workspaceRoot);
    if (!manifest) return '';
    const staleReasons = manifest.staleReasons ?? [];
    const eventLogic = manifest.counts.eventLogic ?? 0;
    const stateFlowWarning = eventLogic === 0
        ? '\nWARNING: eventLogic=0 means no directed state facts (variables/flags/event targets) are indexed. If the design depends on state flow, do NOT treat an empty unresolvedCritical as settled: call query_project_knowledge with the involved IDs, or analyze_pdx_flow, and record any missing state evidence as unresolved before approval.'
        : '';
    const syntheticDetail = manifest.counts.workspaceSyntheticDefinitions
        ? `, ${manifest.counts.workspaceSyntheticDefinitions} synthetic`
        : '';
    return `<project-knowledge>\n# PROJECT KNOWLEDGE PACK\nStatus: ${staleReasons.length > 0 ? 'stale' : manifest.status}\nGame: ${manifest.game}\nGenerated: ${manifest.generatedAt}\nGraph version: ${manifest.graphVersion ?? 'unknown'}\nStorage: manifest + current SQLite V${PROJECT_KNOWLEDGE_SCHEMA_VERSION}\nDomains: ${manifest.domains.join(', ') || 'none'}\nDefinitions: ${manifest.counts.workspaceDefinitions ?? 0} workspace (${manifest.counts.workspaceDeclaredDefinitions ?? 'unknown'} declared${syntheticDetail}) + ${manifest.counts.vanillaDefinitions ?? 0} vanilla + ${manifest.counts.dependencyDefinitions ?? 0} dependency + ${manifest.counts.curatedDefinitions ?? 0} curated; topology: ${manifest.counts.topologyFiles} files / ${manifest.counts.topologyEdges} edges; typed graph: ${manifest.counts.eventNodes ?? 0} event nodes / ${manifest.counts.eventEdges ?? 0} directed edges / ${eventLogic} logic facts${stateFlowWarning}\n${staleReasons.length > 0 ? `Stale reasons: ${staleReasons.join(', ')}\n` : ''}Event IDs, numeric/source order, and missing incoming edges are never entry or causality evidence. For complex cross-subsystem planning, call query_project_knowledge before write_design_blueprint. Enumerate the involved TypeDefs and dependency families from the current semantic catalog, then load their project/vanilla patterns, typed topology, unresolved facts, and relevant graph slices. A blueprint must cite exact directed evidence and must not present unresolved critical facts as settled.\n</project-knowledge>\n`;
}

const FULL_REFRESH_STALE_REASONS = new Set([
    'workspace_files_changed',
    'schema_version_changed',
    'vanilla_changed',
    'vanilla_cache_changed',
    'rules_changed',
    'rules_or_vanilla_configuration_changed',
    'graph_wide_inputs_changed',
    'lsp_export_unavailable',
    'knowledge_loading',
    'knowledge_unavailable',
    'knowledge_error',
]);

/** Only durable model/cache changes justify an automatic full export after LSP startup. */
export function shouldResumeFullProjectKnowledgeRefresh(reasons: readonly string[]): boolean {
    return reasons.some(reason => FULL_REFRESH_STALE_REASONS.has(reason));
}

async function withProjectKnowledgeRefreshProgress<T>(
    workspaceRoot: string,
    fullRefresh: boolean,
    task: (progress?: vs.Progress<{ message?: string }>) => Promise<T>,
): Promise<T> {
    const workspaceName = path.basename(workspaceRoot);
    const title = fullRefresh
        ? aiText(
            `CWTools: Refreshing full project knowledge for ${workspaceName}`,
            `CWTools：正在为 ${workspaceName} 全量刷新项目知识`,
        )
        : aiText(
            `CWTools: Refreshing project knowledge for ${workspaceName}`,
            `CWTools：正在为 ${workspaceName} 增量刷新项目知识`,
        );
    const progressLocation = vs.ProgressLocation?.Window;
    if (typeof vs.window.withProgress === 'function' && progressLocation !== undefined) {
        return vs.window.withProgress(
            {
                location: progressLocation,
                title,
                cancellable: false,
            },
            async progress => {
                progress.report({
                    message: fullRefresh
                        ? aiText('Rebuilding the knowledge database...', '正在重建项目知识数据库...')
                        : aiText('Waiting for the CWTools model to become ready...', '正在等待 CWTools 模型完成更新...'),
                });
                return task(progress);
            },
        );
    }

    const status = vs.window.setStatusBarMessage?.(`$(sync~spin) ${title}`);
    try {
        return await task();
    } finally {
        status?.dispose();
    }
}

const INCREMENTAL_REFRESH_DEBOUNCE_MS = 150;
const INCREMENTAL_FOLLOW_UP_DELAY_MS = 50;
const MODEL_READY_POLL_INITIAL_MS = 100;

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function isProjectKnowledgeModelReady(value: unknown): boolean | undefined {
    const status = recordValue(value) as LspValidationStatus | undefined;
    if (!status || status.ok !== true) return undefined;
    if (typeof status.modelReadyForKnowledgeExport === 'boolean') {
        return status.modelReadyForKnowledgeExport;
    }
    const loading = recordValue(status.loading);
    const pendingGlobalKinds = Array.isArray(status.pendingGlobalKinds)
        ? status.pendingGlobalKinds
        : [];
    return status.inProgress !== true
        && loading?.inProgress !== true
        && pendingGlobalKinds.length === 0;
}

async function isProjectKnowledgeModelReadyNow(): Promise<boolean> {
    try {
        const status = await vs.commands.executeCommand<unknown>('cwtools.ai.getValidationStatus');
        const ready = isProjectKnowledgeModelReady(status);
        // Older or temporarily unavailable servers remain guarded by the
        // authoritative requireReady check on the export command.
        return ready !== false;
    } catch (error) {
        ErrorReporter.debug('ProjectKnowledge', 'Validation readiness probe failed; deferring to export guard', error);
        return true;
    }
}

function scheduleRootRefresh(workspaceRoot: string, indexService: IndexService | undefined, delayMs = INCREMENTAL_REFRESH_DEBOUNCE_MS): void {
    const state = pendingRootRefresh(workspaceRoot);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        state.timer = undefined;
        void refreshFromWatcher(state.workspaceRoot, indexService);
    }, delayMs);
}

async function refreshFromWatcher(workspaceRoot: string, indexService?: IndexService): Promise<void> {
    const state = pendingRootRefresh(workspaceRoot);
    if (state.inFlight) return state.inFlight;
    let retryAfterModelReady = false;
    let fullRefreshAttempted = false;
    state.inFlight = (async () => {
        if (!await isProjectKnowledgeModelReadyNow()) {
            // Do not keep a Window progress notification alive throughout
            // startup validation. Retain the coalesced files and retry after
            // the model becomes ready; only the actual export owns progress.
            retryAfterModelReady = true;
            return;
        }
        const fullRefreshForProgress = state.fullRefresh;
        await withProjectKnowledgeRefreshProgress(workspaceRoot, fullRefreshForProgress, async progress => {
            const files = Array.from(state.changedFiles);
            state.changedFiles.clear();
            const fullRefresh = state.fullRefresh;
            state.fullRefresh = false;
            const refreshAllVanilla = pendingVanillaIndexAll;
            pendingVanillaIndexAll = false;
            const vanillaGames = Array.from(pendingVanillaIndexGames);
            pendingVanillaIndexGames.clear();
            const staleReasons = Array.from(state.staleReasons);
            state.staleReasons.clear();

            if (indexService && (refreshAllVanilla || vanillaGames.length > 0)) {
                try {
                    await indexService.refreshVanillaSymbols(refreshAllVanilla ? undefined : vanillaGames);
                } catch (error) {
                    ErrorReporter.debug('ProjectKnowledge', 'Vanilla symbol cache refresh failed', error);
                }
            }
            if (!fullRefresh && files.length === 0) return;
            const manifest = readProjectKnowledgeManifest(workspaceRoot);
            if (!manifest) return;
            const profile = readProjectProfile(workspaceRoot);
            if (!profile) return;
            markProjectKnowledgeStale(workspaceRoot, staleReasons.length > 0 ? staleReasons : ['workspace_files_changed']);
            progress?.report({
                message: fullRefresh
                    ? aiText('Rebuilding the knowledge database...', '正在重建项目知识数据库...')
                    : aiText('Updating changed project files...', '正在更新发生变化的项目文件...'),
            });
            try {
                fullRefreshAttempted = fullRefresh;
                await generateProjectKnowledge(workspaceRoot, profile, {
                    mode: fullRefresh ? 'full' : 'incremental',
                    changedFiles: files,
                    complete: manifest.completeExport === true || manifest.status === 'unavailable',
                    requireReady: true,
                });
            } catch (error) {
                if (error instanceof ProjectKnowledgeModelNotReadyError) {
                    for (const file of files) state.changedFiles.add(file);
                    for (const reason of staleReasons) state.staleReasons.add(reason);
                    if (fullRefresh) state.fullRefresh = true;
                    retryAfterModelReady = true;
                    ErrorReporter.debug('ProjectKnowledge', 'Model changed during knowledge refresh; queued files retained for retry');
                    return;
                }
                markProjectKnowledgeStale(workspaceRoot, ['background_refresh_failed']);
                ErrorReporter.debug('ProjectKnowledge', 'Background knowledge refresh failed', error);
            }
        });
    })().finally(() => {
        state.inFlight = undefined;
        if (fullRefreshAttempted && state.changedFiles.size > 0) {
            // The full export used the model snapshot from before these edits.
            // Preserve the deduplicated paths for one lightweight incremental tail.
            state.staleReasons.add('workspace_files_changed');
            markProjectKnowledgeStale(state.workspaceRoot, ['workspace_files_changed']);
        }
        const needsAutomaticFollowUp =
            state.changedFiles.size > 0
            || state.fullRefresh
            || pendingVanillaIndexAll
            || pendingVanillaIndexGames.size > 0;
        const stateKey = workspaceRootKey(state.workspaceRoot);
        if (pendingRootRefreshes.get(stateKey) !== state) return;
        if (needsAutomaticFollowUp) {
            scheduleRootRefresh(
                state.workspaceRoot,
                indexService,
                retryAfterModelReady ? MODEL_READY_POLL_INITIAL_MS : INCREMENTAL_FOLLOW_UP_DELAY_MS,
            );
        } else if (!state.timer) {
            pendingRootRefreshes.delete(stateKey);
        }
    });
    return state.inFlight;
}

/** Resume durable knowledge refresh work that was interrupted by a required window reload. */
export function resumeStaleProjectKnowledgeRefreshes(
    indexService?: IndexService,
    options: { refreshVanillaIndex?: boolean } = {},
): void {
    for (const folder of vs.workspace.workspaceFolders ?? []) {
        const workspaceRoot = folder.uri.fsPath;
        const manifest = readProjectKnowledgeManifest(workspaceRoot);
        if (!manifest) continue;
        const reasons = currentStaleReasons(workspaceRoot, manifest);
        if (reasons.length === 0) continue;
        if (!shouldResumeFullProjectKnowledgeRefresh(reasons)) continue;
        const state = pendingRootRefresh(workspaceRoot);
        state.fullRefresh = true;
        for (const reason of reasons) state.staleReasons.add(reason);
        if (options.refreshVanillaIndex && reasons.includes('vanilla_changed')) pendingVanillaIndexAll = true;
        scheduleRootRefresh(workspaceRoot, indexService, 250);
    }
}

export function registerProjectKnowledgeWatcher(context: vs.ExtensionContext, indexService?: IndexService): void {
    if (watcherRegistration) return;
    vanillaCacheDirectory = path.join(context.globalStorageUri.fsPath, '.cwtools');
    fs.mkdirSync(vanillaCacheDirectory, { recursive: true });
    const savedDocumentHashes = new Map<string, string>();
    const rememberSavedDocument = (document: vs.TextDocument): void => {
        if (document.uri.scheme !== 'file') return;
        savedDocumentHashes.set(workspaceRootKey(document.uri.fsPath), hashParts([document.getText()]));
    };
    for (const document of vs.workspace.textDocuments) rememberSavedDocument(document);
    const watcher = vs.workspace.createFileSystemWatcher('**/*.{txt,gfx,asset,gui,yml,cwt,mod,shader,fxh}');
    const schedule = (uri: vs.Uri) => {
        const workspaceFolder = vs.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) return;
        const relative = normalizePath(path.relative(workspaceFolder.uri.fsPath, uri.fsPath));
        if (!relative || relative.startsWith('.cwtools/') || relative.startsWith('.cwtools-ai/') || relative.startsWith('.git/') || relative.startsWith('node_modules/')) return;
        const ownerRoot = findKnowledgeOwnerRoot(workspaceFolder.uri.fsPath);
        if (!ownerRoot) return;
        const graphWideChange = GRAPH_WIDE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
        markProjectKnowledgeStale(ownerRoot, graphWideChange
            ? ['workspace_files_changed', 'graph_wide_inputs_changed']
            : ['workspace_files_changed']);
        if (graphWideChange) return;
        const state = pendingRootRefresh(ownerRoot);
        state.changedFiles.add(path.resolve(uri.fsPath));
        state.staleReasons.add('workspace_files_changed');
        scheduleRootRefresh(ownerRoot, indexService);
    };
    watcher.onDidChange(uri => {
        const key = workspaceRootKey(uri.fsPath);
        const isOpenDocument = vs.workspace.textDocuments.some(document =>
            document.uri.scheme === 'file' && workspaceRootKey(document.uri.fsPath) === key);
        // Open documents are handled by onDidSaveTextDocument below. The file
        // watcher also fires for Ctrl+S with no content changes and must not
        // enqueue a duplicate project-knowledge refresh.
        if (!isOpenDocument) schedule(uri);
    });
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
    watcherRegistration = watcher;
    const openDocumentWatcher = vs.workspace.onDidOpenTextDocument(rememberSavedDocument);
    const saveDocumentWatcher = vs.workspace.onDidSaveTextDocument(document => {
        if (document.uri.scheme !== 'file') return;
        const key = workspaceRootKey(document.uri.fsPath);
        const nextHash = hashParts([document.getText()]);
        const previousHash = savedDocumentHashes.get(key);
        savedDocumentHashes.set(key, nextHash);
        if (previousHash !== nextHash) schedule(document.uri);
    });
    const closeDocumentWatcher = vs.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme === 'file') savedDocumentHashes.delete(workspaceRootKey(document.uri.fsPath));
    });
    const configWatcher = vs.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('stellarisLanguageServices.cache')
            && !event.affectsConfiguration('stellarisLanguageServices.rules_version')
            && !event.affectsConfiguration('stellarisLanguageServices.rules_folder')
            && !event.affectsConfiguration('stellarisLanguageServices.rules_remote_url')) return;
        for (const folder of vs.workspace.workspaceFolders ?? []) {
            const workspaceRoot = folder.uri.fsPath;
            if (!readProjectKnowledgeManifest(workspaceRoot)) continue;
            markProjectKnowledgeStale(workspaceRoot, ['rules_or_vanilla_configuration_changed']);
        }
    });
    const cwbWatcher = vs.workspace.createFileSystemWatcher(new vs.RelativePattern(vs.Uri.file(vanillaCacheDirectory), '*.cwb'));
    const scheduleVanillaCacheRefresh = (uri: vs.Uri) => {
        const gameId = getGameIdForVanillaCacheFile(path.basename(uri.fsPath));
        if (!gameId) return;
        for (const folder of vs.workspace.workspaceFolders ?? []) {
            const workspaceRoot = folder.uri.fsPath;
            const manifest = readProjectKnowledgeManifest(workspaceRoot);
            if (manifest?.game !== gameId) continue;
            markProjectKnowledgeStale(workspaceRoot, ['vanilla_cache_changed']);
        }
    };
    cwbWatcher.onDidChange(scheduleVanillaCacheRefresh);
    cwbWatcher.onDidCreate(scheduleVanillaCacheRefresh);
    cwbWatcher.onDidDelete(scheduleVanillaCacheRefresh);
    context.subscriptions.push(
        watcher,
        cwbWatcher,
        configWatcher,
        openDocumentWatcher,
        saveDocumentWatcher,
        closeDocumentWatcher,
        new vs.Disposable(() => {
            watcherRegistration = undefined;
            for (const state of pendingRootRefreshes.values()) {
                if (state.timer) clearTimeout(state.timer);
            }
            pendingRootRefreshes.clear();
            pendingVanillaIndexAll = false;
            pendingVanillaIndexGames.clear();
            vanillaCacheDirectory = undefined;
            savedDocumentHashes.clear();
        }),
    );
}
