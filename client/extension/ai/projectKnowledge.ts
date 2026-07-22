import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { getCacheSettingKey, getGameIdForVanillaCacheFile, getVanillaCacheFileName } from '../gameProfiles';
import type { IndexService } from '../indexing/indexService';
import { isPathInsideOrEqual } from '../pathScope';
import { ErrorReporter } from './errorReporter';
import { readProjectProfile } from './projectProfile';
import { migrateLegacyAiStorageRoot } from './workspacePaths';
import type {
    ProjectProfile,
    QueryProjectKnowledgeArgs,
    QueryProjectKnowledgeResult,
} from './types';

export const PROJECT_KNOWLEDGE_SCHEMA_VERSION = 2;
export const PROJECT_KNOWLEDGE_RELATIVE_DIR = path.join('.cwtools', 'project', 'knowledge');

export interface ProjectKnowledgeManifest {
    schemaVersion: 1 | 2;
    generatedAt: string;
    generationMode: 'full' | 'incremental';
    status: 'ready' | 'partial' | 'stale' | 'loading' | 'unavailable' | 'error';
    game: string;
    graphVersion?: number;
    projectRoots: string[];
    domains: string[];
    counts: {
        definitions: number;
        availableDefinitions?: number;
        workspaceDefinitions: number;
        vanillaDefinitions: number;
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
    warnings: string[];
    staleReasons: string[];
    artifacts: string[];
    database?: {
        path: string;
        format: 'sqlite';
        schemaVersion: 2;
    };
}

interface LspKnowledgeSnapshot {
    ok: boolean;
    status: ProjectKnowledgeManifest['status'];
    source?: string;
    schemaVersion?: number;
    game?: string;
    generatedAtUnixMs?: number;
    graphVersion?: number;
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
    warnings?: string[];
    error?: string;
}

export interface GenerateProjectKnowledgeOptions {
    mode?: 'full' | 'incremental';
    changedFiles?: string[];
    domains?: string[];
}

const RELEVANT_EXTENSIONS = new Set(['.txt', '.gfx', '.asset', '.gui', '.yml', '.cwt', '.mod']);
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

function legacyKnowledgeRoot(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.cwtools-ai', 'project', 'knowledge');
}

function knowledgeRoot(workspaceRoot: string): string {
    const primary = primaryKnowledgeRoot(workspaceRoot);
    const legacy = legacyKnowledgeRoot(workspaceRoot);
    if (fs.existsSync(path.join(primary, 'manifest.json'))) return primary;
    if (fs.existsSync(path.join(legacy, 'manifest.json'))) return legacy;
    return primary;
}

function ensurePrimaryKnowledgeRoot(workspaceRoot: string): string {
    const primary = primaryKnowledgeRoot(workspaceRoot);
    migrateLegacyAiStorageRoot(workspaceRoot);
    return primary;
}

function existingProjectKnowledgeManifestPath(workspaceRoot: string): string {
    return path.join(knowledgeRoot(workspaceRoot), 'manifest.json');
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

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
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
                facts.push(`${normalizePath(path.relative(root, fullPath))}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
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

const LEGACY_KNOWLEDGE_ARTIFACTS = [
    'snapshot.json',
    'topology.json',
    'definition-stacks.json',
    'override-map.json',
    'unresolved.json',
];

function removeLegacyKnowledgeArtifacts(root: string): void {
    for (const directory of ['capabilities', 'archetypes']) {
        try { fs.rmSync(path.join(root, directory), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const artifact of LEGACY_KNOWLEDGE_ARTIFACTS) {
        try { fs.rmSync(path.join(root, artifact), { force: true }); } catch { /* ignore */ }
    }
}

async function requestLspKnowledgeSnapshot(
    workspaceRoot: string,
    options: GenerateProjectKnowledgeOptions,
): Promise<LspKnowledgeSnapshot> {
    const result = await vs.commands.executeCommand<LspKnowledgeSnapshot>(
        'cwtools.ai.exportProjectKnowledge',
        {
            domains: options.domains ?? [],
            changedFiles: options.changedFiles ?? [],
            maxDefinitions: 100000,
            maxTopologyFiles: 1200,
            maxEdges: 8000,
            archetypesPerDomain: 8,
            databasePath: getProjectKnowledgeDatabasePath(workspaceRoot),
            generationMode: options.mode ?? 'full',
        },
    );
    if (!result || result.ok !== true) {
        throw new Error(result?.error || 'CWTools project knowledge export is unavailable.');
    }
    return result;
}

export async function generateProjectKnowledge(
    workspaceRoot: string,
    profile: ProjectProfile,
    options: GenerateProjectKnowledgeOptions = {},
): Promise<ProjectKnowledgeManifest> {
    const root = ensurePrimaryKnowledgeRoot(workspaceRoot);
    fs.mkdirSync(root, { recursive: true });
    const snapshot = await requestLspKnowledgeSnapshot(workspaceRoot, options);
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
        generatedAt: new Date(snapshot.generatedAtUnixMs ?? Date.now()).toISOString(),
        generationMode: snapshot.generationMode ?? 'full',
        status: snapshot.status,
        game: gameId,
        graphVersion: snapshot.graphVersion,
        projectRoots,
        domains,
        counts,
        fingerprints: {
            project: computeProjectKnowledgeFingerprint(workspaceRoot, projectRoots),
            vanilla: computeVanillaFingerprint(gameId),
            rules: computeRulesFingerprint(gameId, snapshot.graphVersion),
        },
        freshness: snapshot.freshness,
        warnings: snapshot.warnings ?? [],
        staleReasons: [],
        artifacts: ['knowledge.sqlite'],
        database: {
            path: 'knowledge.sqlite',
            format: 'sqlite',
            schemaVersion: 2,
        },
    };
    // The database is atomically replaced by the server. Publish the compact
    // manifest only after it exists, then remove V1 files so a failed migration
    // always leaves the previous knowledge pack recoverable.
    writeJson(getProjectKnowledgeManifestPath(workspaceRoot), manifest);
    removeLegacyKnowledgeArtifacts(root);
    return manifest;
}

export function writeUnavailableProjectKnowledge(
    workspaceRoot: string,
    profile: ProjectProfile,
    reason: string,
): ProjectKnowledgeManifest {
    const root = ensurePrimaryKnowledgeRoot(workspaceRoot);
    fs.mkdirSync(root, { recursive: true });
    const generatedAt = new Date().toISOString();
    const gameId = profile.game.id || 'unknown';

    const manifest: ProjectKnowledgeManifest = {
        schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
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
        artifacts: fs.existsSync(getProjectKnowledgeDatabasePath(workspaceRoot)) ? ['knowledge.sqlite'] : [],
        database: {
            path: 'knowledge.sqlite',
            format: 'sqlite',
            schemaVersion: 2,
        },
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
    if (manifest.schemaVersion !== PROJECT_KNOWLEDGE_SCHEMA_VERSION) reasons.push('schema_version_changed');
    if (computeProjectKnowledgeFingerprint(workspaceRoot, manifest.projectRoots) !== manifest.fingerprints.project) reasons.push('workspace_files_changed');
    if (computeVanillaFingerprint(manifest.game) !== manifest.fingerprints.vanilla) reasons.push('vanilla_changed');
    if (computeRulesFingerprint(manifest.game, manifest.graphVersion) !== manifest.fingerprints.rules) reasons.push('rules_changed');
    return Array.from(new Set(reasons));
}

export function markProjectKnowledgeStale(workspaceRoot: string, reasons: string[]): void {
    const manifest = readProjectKnowledgeManifest(workspaceRoot);
    if (!manifest) return;
    manifest.status = 'stale';
    manifest.staleReasons = Array.from(new Set([...(manifest.staleReasons ?? []), ...reasons]));
    const primary = path.join(ensurePrimaryKnowledgeRoot(workspaceRoot), 'manifest.json');
    writeJson(primary, manifest);
}

function tokenizeQuery(args: QueryProjectKnowledgeArgs): string[] {
    return [args.intent ?? '', ...(args.identifiers ?? []), ...(args.entityTypes ?? [])]
        .join(' ')
        .toLowerCase()
        .match(/[@a-z0-9_.:-]{2,}/g)
        ?.slice(0, 30) ?? [];
}

function scoreEvidence(record: Record<string, unknown>, tokens: string[]): number {
    if (tokens.length === 0) return 1;
    const text = stableStringify(record).toLowerCase();
    return tokens.reduce((score, token) => score + (text.includes(token) ? (text.includes(`"id":"${token}`) ? 20 : 3) : 0), 0);
}

function queryLegacyProjectKnowledge(workspaceRoot: string, args: QueryProjectKnowledgeArgs = {}): QueryProjectKnowledgeResult {
    const manifest = readProjectKnowledgeManifest(workspaceRoot);
    if (!manifest) {
        return {
            status: 'missing',
            manifestPath: existingProjectKnowledgeManifestPath(workspaceRoot),
            domains: [],
            evidence: [],
            unresolved: [],
            _hint: 'Run /init and wait for the deep knowledge phase to complete.',
        };
    }
    const staleReasons = currentStaleReasons(workspaceRoot, manifest);
    const requestedDomains = (args.domains?.length ? args.domains : manifest.domains)
        .map(value => value.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12);
    const tokens = tokenizeQuery(args);
    const evidence: Array<Record<string, unknown>> = [];
    const capabilities: Array<Record<string, unknown>> = [];
    const limit = Math.max(1, Math.min(Number(args.limit ?? 80) || 80, 300));

    for (const domain of requestedDomains) {
        const capability = readJson<Record<string, unknown>>(path.join(knowledgeRoot(workspaceRoot), 'capabilities', `${domain}.json`));
        if (!capability) continue;
        capabilities.push({
            domain,
            summary: capability.summary,
            evidencePolicy: capability.evidencePolicy,
        });
        const candidates: Array<Record<string, unknown>> = [];
        if (Array.isArray(capability.definitions)) candidates.push(...capability.definitions as Array<Record<string, unknown>>);
        if (args.includeProjectPatterns !== false && Array.isArray(capability.projectExamples)) candidates.push(...capability.projectExamples as Array<Record<string, unknown>>);
        if (args.includeVanillaArchetypes !== false && Array.isArray(capability.vanillaArchetypes)) candidates.push(...capability.vanillaArchetypes as Array<Record<string, unknown>>);
        if (args.includeTopology !== false && capability.topology && typeof capability.topology === 'object') {
            const topology = capability.topology as Record<string, unknown>;
            if (Array.isArray(topology.edges)) candidates.push(...topology.edges as Array<Record<string, unknown>>);
        }
        evidence.push(...candidates
            .map(item => ({ item, score: scoreEvidence(item, tokens), domain }))
            .filter(item => tokens.length === 0 || item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(5, Math.ceil(limit / requestedDomains.length)))
            .map(({ item, score, domain: itemDomain }) => ({ domain: itemDomain, score, ...item })));
    }

    const unresolvedFile = readJson<{ entries?: Array<Record<string, unknown>> }>(path.join(knowledgeRoot(workspaceRoot), 'unresolved.json'));
    const unresolved = args.includeUnresolved === false ? [] : (unresolvedFile?.entries ?? []).slice(0, 100);
    return {
        status: staleReasons.length > 0 || manifest.status !== 'ready' ? 'stale' : 'ready',
        manifestPath: existingProjectKnowledgeManifestPath(workspaceRoot),
        generatedAt: manifest.generatedAt,
        game: manifest.game,
        graphVersion: manifest.graphVersion,
        staleReasons,
        domains: requestedDomains,
        capabilities,
        evidence: evidence.slice(0, limit),
        unresolved,
        requiredNextChecks: [
            'Use query_cwt_schema/query_rules/query_scope for legality before writing.',
            'Use query_override_modes for every target directory with vanilla definitions.',
            'Read exact project/vanilla blocks referenced by evidence before approving a complex blueprint.',
        ],
        _hint: staleReasons.length > 0
            ? 'Knowledge is stale. The background watcher will refresh it when the LSP is ready; rerun /init for an immediate full rebuild.'
            : 'Treat this as retrieval evidence. Exact CWT/LSP checks remain authoritative.',
    };
}

export async function queryProjectKnowledge(
    workspaceRoot: string,
    args: QueryProjectKnowledgeArgs = {},
): Promise<QueryProjectKnowledgeResult> {
    const manifest = readProjectKnowledgeManifest(workspaceRoot);
    if (!manifest || manifest.schemaVersion === 1) {
        return queryLegacyProjectKnowledge(workspaceRoot, args);
    }

    const root = knowledgeRoot(workspaceRoot);
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
            staleReasons,
            domains: Array.isArray(result.domains) ? result.domains.filter((item): item is string => typeof item === 'string') : [],
            capabilities: Array.isArray(result.capabilities) ? result.capabilities as Array<Record<string, unknown>> : [],
            evidence: Array.isArray(result.evidence) ? result.evidence as Array<Record<string, unknown>> : [],
            unresolved: Array.isArray(result.unresolved) ? result.unresolved as Array<Record<string, unknown>> : [],
            eventGraph: result.eventGraph && typeof result.eventGraph === 'object'
                ? result.eventGraph as QueryProjectKnowledgeResult['eventGraph']
                : { nodes: [], edges: [], logic: [] },
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
    return `<project-knowledge>\n# PROJECT KNOWLEDGE PACK\nStatus: ${staleReasons.length > 0 ? 'stale' : manifest.status}\nGame: ${manifest.game}\nGenerated: ${manifest.generatedAt}\nGraph version: ${manifest.graphVersion ?? 'unknown'}\nStorage: ${manifest.schemaVersion >= 2 ? 'manifest + SQLite V2' : 'legacy JSON V1'}\nDomains: ${manifest.domains.join(', ') || 'none'}\nDefinitions: ${manifest.counts.workspaceDefinitions ?? 0} workspace + ${manifest.counts.vanillaDefinitions ?? 0} vanilla; topology: ${manifest.counts.topologyFiles} files / ${manifest.counts.topologyEdges} edges; typed graph: ${manifest.counts.eventNodes ?? 0} entry nodes / ${manifest.counts.eventEdges ?? 0} structural edges / ${manifest.counts.eventLogic ?? 0} logic facts\n${staleReasons.length > 0 ? `Stale reasons: ${staleReasons.join(', ')}\n` : ''}For complex cross-subsystem planning, call query_project_knowledge before write_design_blueprint. Enumerate the involved TypeDefs and dependency families from the current semantic catalog, then load their project/vanilla patterns, typed topology, unresolved facts, and relevant graph slices. A blueprint must cite exact evidence and must not present unresolved critical facts as settled.\n</project-knowledge>\n`;
}

function hasPendingRefresh(state: PendingRootRefresh): boolean {
    return state.changedFiles.size > 0 || state.fullRefresh;
}

function scheduleRootRefresh(workspaceRoot: string, indexService: IndexService | undefined, delayMs = 1800): void {
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
    state.inFlight = (async () => {
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
        try {
            await generateProjectKnowledge(workspaceRoot, profile, {
                mode: fullRefresh ? 'full' : 'incremental',
                changedFiles: files,
            });
        } catch (error) {
            markProjectKnowledgeStale(workspaceRoot, ['background_refresh_failed']);
            ErrorReporter.debug('ProjectKnowledge', 'Background knowledge refresh failed', error);
        }
    })().finally(() => {
        state.inFlight = undefined;
        if (hasPendingRefresh(state) || pendingVanillaIndexAll || pendingVanillaIndexGames.size > 0) {
            scheduleRootRefresh(state.workspaceRoot, indexService, 500);
        } else if (!state.timer) {
            pendingRootRefreshes.delete(workspaceRootKey(state.workspaceRoot));
        }
    });
    return state.inFlight;
}

export function registerProjectKnowledgeWatcher(context: vs.ExtensionContext, indexService?: IndexService): void {
    if (watcherRegistration) return;
    vanillaCacheDirectory = path.join(context.globalStorageUri.fsPath, '.cwtools');
    fs.mkdirSync(vanillaCacheDirectory, { recursive: true });
    const watcher = vs.workspace.createFileSystemWatcher('**/*.{txt,gfx,asset,gui,yml,cwt,mod}');
    const schedule = (uri: vs.Uri) => {
        const workspaceFolder = vs.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) return;
        const relative = normalizePath(path.relative(workspaceFolder.uri.fsPath, uri.fsPath));
        if (!relative || relative.startsWith('.cwtools/') || relative.startsWith('.cwtools-ai/') || relative.startsWith('.git/') || relative.startsWith('node_modules/')) return;
        const ownerRoot = findKnowledgeOwnerRoot(workspaceFolder.uri.fsPath);
        if (!ownerRoot) return;
        const state = pendingRootRefresh(ownerRoot);
        state.changedFiles.add(path.resolve(uri.fsPath));
        state.staleReasons.add('workspace_files_changed');
        scheduleRootRefresh(ownerRoot, indexService);
    };
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
    watcherRegistration = watcher;
    const configWatcher = vs.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('stellarisLanguageServices.cache')
            && !event.affectsConfiguration('stellarisLanguageServices.rules_version')
            && !event.affectsConfiguration('stellarisLanguageServices.rules_folder')
            && !event.affectsConfiguration('stellarisLanguageServices.rules_remote_url')) return;
        pendingVanillaIndexAll = true;
        for (const folder of vs.workspace.workspaceFolders ?? []) {
            const workspaceRoot = folder.uri.fsPath;
            if (!readProjectKnowledgeManifest(workspaceRoot)) continue;
            const state = pendingRootRefresh(workspaceRoot);
            state.fullRefresh = true;
            state.staleReasons.add('rules_or_vanilla_configuration_changed');
            markProjectKnowledgeStale(workspaceRoot, ['rules_or_vanilla_configuration_changed']);
            scheduleRootRefresh(workspaceRoot, indexService);
        }
    });
    const cwbWatcher = vs.workspace.createFileSystemWatcher(new vs.RelativePattern(vs.Uri.file(vanillaCacheDirectory), '*.cwb'));
    const scheduleVanillaCacheRefresh = (uri: vs.Uri) => {
        const gameId = getGameIdForVanillaCacheFile(path.basename(uri.fsPath));
        if (!gameId) return;
        pendingVanillaIndexGames.add(gameId);
        let scheduled = false;
        for (const folder of vs.workspace.workspaceFolders ?? []) {
            const workspaceRoot = folder.uri.fsPath;
            const manifest = readProjectKnowledgeManifest(workspaceRoot);
            if (manifest?.game !== gameId) continue;
            const state = pendingRootRefresh(workspaceRoot);
            state.fullRefresh = true;
            state.staleReasons.add('vanilla_cache_changed');
            markProjectKnowledgeStale(workspaceRoot, ['vanilla_cache_changed']);
            scheduleRootRefresh(workspaceRoot, indexService);
            scheduled = true;
        }
        const fallbackRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!scheduled && fallbackRoot) scheduleRootRefresh(fallbackRoot, indexService);
    };
    cwbWatcher.onDidChange(scheduleVanillaCacheRefresh);
    cwbWatcher.onDidCreate(scheduleVanillaCacheRefresh);
    cwbWatcher.onDidDelete(scheduleVanillaCacheRefresh);
    const focusWatcher = vs.window.onDidChangeWindowState(state => {
        if (!state.focused) return;
        for (const folder of vs.workspace.workspaceFolders ?? []) {
            const workspaceRoot = folder.uri.fsPath;
            const manifest = readProjectKnowledgeManifest(workspaceRoot);
            const reasons = manifest ? currentStaleReasons(workspaceRoot, manifest) : [];
            if (!manifest || reasons.length === 0) continue;
            const pending = pendingRootRefresh(workspaceRoot);
            pending.fullRefresh = true;
            for (const reason of reasons) pending.staleReasons.add(reason);
            if (reasons.includes('vanilla_changed')) pendingVanillaIndexAll = true;
            scheduleRootRefresh(workspaceRoot, indexService);
        }
    });
    context.subscriptions.push(watcher, cwbWatcher, configWatcher, focusWatcher, new vs.Disposable(() => {
        watcherRegistration = undefined;
        for (const state of pendingRootRefreshes.values()) {
            if (state.timer) clearTimeout(state.timer);
        }
        pendingRootRefreshes.clear();
        pendingVanillaIndexAll = false;
        pendingVanillaIndexGames.clear();
        vanillaCacheDirectory = undefined;
    }));
}
