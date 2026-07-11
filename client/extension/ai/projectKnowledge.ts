import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { getCacheSettingKey } from '../gameProfiles';
import { ErrorReporter } from './errorReporter';
import type {
    ProjectProfile,
    QueryProjectKnowledgeArgs,
    QueryProjectKnowledgeResult,
} from './types';

export const PROJECT_KNOWLEDGE_SCHEMA_VERSION = 2;
export const PROJECT_KNOWLEDGE_RELATIVE_DIR = path.join('.cwtools-ai', 'project', 'knowledge');

export interface ProjectKnowledgeManifest {
    schemaVersion: 1 | 2;
    generatedAt: string;
    generationMode: 'full' | 'incremental';
    status: 'ready' | 'stale' | 'loading' | 'unavailable' | 'error';
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
const EXCLUDED_DIRECTORIES = new Set(['.git', '.cwtools-ai', 'node_modules', 'release', 'artifacts', 'dist', 'out']);
const DOMAIN_NAMES = ['events', 'on_actions', 'special_projects', 'archaeology', 'situations', 'technology', 'ships', 'scripted_logic', 'assets', 'localisation', 'other'];
let watcherRegistration: vs.Disposable | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const pendingChangedFiles = new Set<string>();
let refreshInFlight: Promise<void> | undefined;
let pendingFullRefresh = false;

function knowledgeRoot(workspaceRoot: string): string {
    return path.join(workspaceRoot, PROJECT_KNOWLEDGE_RELATIVE_DIR);
}

export function getProjectKnowledgeManifestPath(workspaceRoot: string): string {
    return path.join(knowledgeRoot(workspaceRoot), 'manifest.json');
}

export function getProjectKnowledgeDatabasePath(workspaceRoot: string): string {
    return path.join(knowledgeRoot(workspaceRoot), 'knowledge.sqlite');
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

export function computeProjectKnowledgeFingerprint(workspaceRoot: string): string {
    return hashParts(collectRelevantFileFacts(workspaceRoot));
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
    return hashParts([
        normalizePath(vanillaPath),
        pathStatFact(vanillaPath),
        pathStatFact(path.join(vanillaPath, 'common')),
        pathStatFact(path.join(vanillaPath, 'events')),
        pathStatFact(path.join(vanillaPath, 'checksum_manifest.txt')),
        pathStatFact(path.join(parent, 'checksum_manifest.txt')),
        pathStatFact(path.join(vanillaPath, 'launcher-settings.json')),
    ]);
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

function domainForPath(filePath: string): string {
    const value = normalizePath(filePath).toLowerCase();
    if (value.includes('/on_actions/')) return 'on_actions';
    if (value.includes('/special_projects/')) return 'special_projects';
    if (value.includes('archaeolog')) return 'archaeology';
    if (value.includes('/situations/')) return 'situations';
    if (value.includes('/technology/') || value.includes('/technologies/')) return 'technology';
    if (/\/(ship_sizes|component_templates|section_templates|starbase_)/.test(value)) return 'ships';
    if (/\/(scripted_effects|scripted_triggers|script_values|scripted_variables)\//.test(value)) return 'scripted_logic';
    if (value.includes('/events/')) return 'events';
    if (/\/(interface|gfx|sound|music)\//.test(value) || /\.(gfx|asset|gui)$/.test(value)) return 'assets';
    if (/\/(localisation|localisation_synced|localization)\//.test(value) || value.endsWith('.yml')) return 'localisation';
    const segments = value.split('/').filter(Boolean);
    const commonIndex = segments.indexOf('common');
    if (commonIndex >= 0 && commonIndex + 1 < segments.length) return segments[commonIndex + 1]!.replace(/-/g, '_');
    if (segments.includes('map') || segments.includes('map_data')) return 'map';
    return 'other';
}

function domainsForChangedFiles(files: string[]): string[] {
    return Array.from(new Set(files.map(domainForPath)));
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
    const root = knowledgeRoot(workspaceRoot);
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

    const manifest: ProjectKnowledgeManifest = {
        schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
        generatedAt: new Date(snapshot.generatedAtUnixMs ?? Date.now()).toISOString(),
        generationMode: snapshot.generationMode ?? 'full',
        status: snapshot.status,
        game: gameId,
        graphVersion: snapshot.graphVersion,
        projectRoots: snapshot.projectRoots ?? [workspaceRoot],
        domains,
        counts,
        fingerprints: {
            project: computeProjectKnowledgeFingerprint(workspaceRoot),
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
    const root = knowledgeRoot(workspaceRoot);
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
        domains: [...DOMAIN_NAMES],
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
    return readJson<ProjectKnowledgeManifest>(getProjectKnowledgeManifestPath(workspaceRoot));
}

function currentStaleReasons(workspaceRoot: string, manifest: ProjectKnowledgeManifest): string[] {
    const reasons = [...(manifest.staleReasons ?? [])];
    if (manifest.schemaVersion !== PROJECT_KNOWLEDGE_SCHEMA_VERSION) reasons.push('schema_version_changed');
    if (computeProjectKnowledgeFingerprint(workspaceRoot) !== manifest.fingerprints.project) reasons.push('workspace_files_changed');
    if (computeVanillaFingerprint(manifest.game) !== manifest.fingerprints.vanilla) reasons.push('vanilla_changed');
    if (computeRulesFingerprint(manifest.game, manifest.graphVersion) !== manifest.fingerprints.rules) reasons.push('rules_changed');
    return Array.from(new Set(reasons));
}

export function markProjectKnowledgeStale(workspaceRoot: string, reasons: string[]): void {
    const manifest = readProjectKnowledgeManifest(workspaceRoot);
    if (!manifest) return;
    manifest.status = 'stale';
    manifest.staleReasons = Array.from(new Set([...(manifest.staleReasons ?? []), ...reasons]));
    writeJson(getProjectKnowledgeManifestPath(workspaceRoot), manifest);
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
            manifestPath: getProjectKnowledgeManifestPath(workspaceRoot),
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
        manifestPath: getProjectKnowledgeManifestPath(workspaceRoot),
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

    const manifestPath = getProjectKnowledgeManifestPath(workspaceRoot);
    const databasePath = path.resolve(knowledgeRoot(workspaceRoot), manifest.database?.path ?? 'knowledge.sqlite');
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
        return {
            status: staleReasons.length > 0 || resultStatus !== 'ready' ? 'stale' : 'ready',
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
            _hint: staleReasons.length > 0
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
    return `<project-knowledge>\n# PROJECT KNOWLEDGE PACK\nStatus: ${staleReasons.length > 0 ? 'stale' : manifest.status}\nGame: ${manifest.game}\nGenerated: ${manifest.generatedAt}\nGraph version: ${manifest.graphVersion ?? 'unknown'}\nStorage: ${manifest.schemaVersion >= 2 ? 'manifest + SQLite V2' : 'legacy JSON V1'}\nDomains: ${manifest.domains.join(', ') || 'none'}\nDefinitions: ${manifest.counts.workspaceDefinitions ?? 0} workspace + ${manifest.counts.vanillaDefinitions ?? 0} vanilla; topology: ${manifest.counts.topologyFiles} files / ${manifest.counts.topologyEdges} edges; events: ${manifest.counts.eventNodes ?? 0} nodes / ${manifest.counts.eventEdges ?? 0} structural edges / ${manifest.counts.eventLogic ?? 0} logic facts\n${staleReasons.length > 0 ? `Stale reasons: ${staleReasons.join(', ')}\n` : ''}For complex cross-subsystem planning, call query_project_knowledge before write_design_blueprint. Load all involved domains, project/vanilla patterns, topology, unresolved facts, and the event graph. Verify event calls and entries together with flag, technology, variable, phase, and scope-bridge logic. A blueprint must cite exact evidence and must not present unresolved critical facts as settled.\n</project-knowledge>\n`;
}

async function refreshFromWatcher(workspaceRoot: string): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    const files = Array.from(pendingChangedFiles);
    pendingChangedFiles.clear();
    const fullRefresh = pendingFullRefresh;
    pendingFullRefresh = false;
    refreshInFlight = (async () => {
        const manifest = readProjectKnowledgeManifest(workspaceRoot);
        if (!manifest) return;
        const profilePath = path.join(workspaceRoot, '.cwtools-ai', 'project', 'profile.json');
        const profile = readJson<ProjectProfile>(profilePath);
        if (!profile) return;
        markProjectKnowledgeStale(workspaceRoot, ['workspace_files_changed']);
        try {
            await generateProjectKnowledge(workspaceRoot, profile, {
                mode: fullRefresh ? 'full' : 'incremental',
                changedFiles: files,
                domains: fullRefresh ? undefined : domainsForChangedFiles(files),
            });
        } catch (error) {
            markProjectKnowledgeStale(workspaceRoot, ['background_refresh_failed']);
            ErrorReporter.debug('ProjectKnowledge', 'Background knowledge refresh failed', error);
        }
    })().finally(() => {
        refreshInFlight = undefined;
        if ((pendingChangedFiles.size > 0 || pendingFullRefresh) && !refreshTimer) {
            refreshTimer = setTimeout(() => {
                refreshTimer = undefined;
                void refreshFromWatcher(workspaceRoot);
            }, 500);
        }
    });
    return refreshInFlight;
}

export function registerProjectKnowledgeWatcher(context: vs.ExtensionContext): void {
    if (watcherRegistration) return;
    const watcher = vs.workspace.createFileSystemWatcher('**/*.{txt,gfx,asset,gui,yml,cwt,mod}');
    const schedule = (uri: vs.Uri) => {
        const workspaceFolder = vs.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) return;
        const relative = normalizePath(path.relative(workspaceFolder.uri.fsPath, uri.fsPath));
        if (!relative || relative.startsWith('.cwtools-ai/') || relative.startsWith('.git/') || relative.startsWith('node_modules/')) return;
        pendingChangedFiles.add(uri.fsPath);
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refreshFromWatcher(workspaceFolder.uri.fsPath);
        }, 1800);
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
        const workspaceRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot || !readProjectKnowledgeManifest(workspaceRoot)) return;
        pendingFullRefresh = true;
        markProjectKnowledgeStale(workspaceRoot, ['rules_or_vanilla_configuration_changed']);
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refreshFromWatcher(workspaceRoot);
        }, 1800);
    });
    const focusWatcher = vs.window.onDidChangeWindowState(state => {
        if (!state.focused) return;
        const workspaceRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const manifest = workspaceRoot ? readProjectKnowledgeManifest(workspaceRoot) : undefined;
        if (!workspaceRoot || !manifest || currentStaleReasons(workspaceRoot, manifest).length === 0) return;
        pendingFullRefresh = true;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refreshFromWatcher(workspaceRoot);
        }, 1800);
    });
    context.subscriptions.push(watcher, configWatcher, focusWatcher, new vs.Disposable(() => {
        watcherRegistration = undefined;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = undefined;
        pendingChangedFiles.clear();
        pendingFullRefresh = false;
    }));
}
