import * as fs from 'fs';
import * as path from 'path';
import type {
    AgentMode,
    ProjectProfile,
    QueryProjectProfileArgs,
    QueryProjectProfileResult,
} from './types';
import { getAllProfiles } from '../gameProfiles';

export const PROJECT_PROFILE_RELATIVE_PATH = path.join('.cwtools', 'project', 'profile.json');
const MAX_PROJECT_PROFILE_BYTES = 2 * 1024 * 1024;
const PROFILE_WORKSPACE_KINDS = new Set(['paradox_mod', 'extension_source', 'mixed', 'generic']);
const PROFILE_GAME_CONFIDENCE = new Set(['high', 'medium', 'low']);
const PROFILE_AGENT_MODES = new Set([
    'build', 'plan', 'explore', 'general', 'utility', 'review', 'gui_expert',
    'script_reviewer', 'loc_translator', 'loc_writer', 'orchestrator', 'script',
]);
const PROFILE_LSP_STATES = new Set(['unknown', 'ready', 'not_ready']);
const PROFILE_INDEX_STATES = new Set(['unknown', 'ready', 'partial', 'indexing', 'idle', 'unavailable']);
const PROFILE_VANILLA_STATES = new Set(['unknown', 'configured', 'missing']);
const NAMESPACE_ORIGINS = new Set(['workspace_owned', 'vanilla_override', 'compatibility', 'external']);

export function getProjectProfilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, PROJECT_PROFILE_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
    return isRecord(value) && Object.values(value).every(isStringArray);
}

function normalizeLegacyProjectProfile(value: unknown): unknown {
    if (!isRecord(value)
        || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
        || !isRecord(value.game)
        || typeof value.game.id !== 'string') return value;
    const game = value.game;
    const localisation = value.localisation === undefined ? {} : value.localisation;
    const identifiers = value.identifiers === undefined ? {} : value.identifiers;
    const routing = value.routing === undefined ? {} : value.routing;
    const validation = value.validation === undefined ? {} : value.validation;
    if (!isRecord(localisation)
        || !isRecord(identifiers)
        || !isRecord(routing)
        || !isRecord(validation)) return value;
    const normalized = {
        ...value,
        schemaVersion: value.schemaVersion === 1 ? 2 : 2,
        legacyProfile: value.schemaVersion === 1 ? true : undefined,
        generatedAt: value.generatedAt ?? '',
        workspaceRoot: value.workspaceRoot ?? '',
        workspaceKind: value.workspaceKind ?? 'generic',
        projectName: value.projectName ?? '',
        game: {
            ...game,
            displayName: game.displayName ?? game.id,
            confidence: game.confidence ?? 'low',
            evidence: game.evidence ?? [],
        },
        modInfo: isRecord(value.modInfo)
            ? {
                name: value.modInfo.name,
                version: value.modInfo.version,
                tags: Array.isArray(value.modInfo.tags) ? value.modInfo.tags : undefined,
                supportedVersion: value.modInfo.supportedVersion,
                remoteFileId: value.modInfo.remoteFileId,
                dependencies: Array.isArray(value.modInfo.dependencies) ? value.modInfo.dependencies : undefined,
            }
            : value.modInfo,
        compatibility: isRecord(value.compatibility) ? value.compatibility : {
            supportedVersion: isRecord(value.modInfo) ? value.modInfo.supportedVersion : undefined,
            declaredDependencies: isRecord(value.modInfo) && Array.isArray(value.modInfo.dependencies)
                ? value.modInfo.dependencies.filter((item): item is string => typeof item === 'string').map(name => ({ name, source: 'descriptor.mod' }))
                : [],
            possibleSoftDependencies: [],
            dependencyRoots: [],
            loadOrder: {
                source: 'descriptor_only', confidence: 'partial', orderedLayers: ['vanilla', 'workspace'],
                warnings: ['Launcher dependency roots and active load order were not present in this legacy profile.'],
            },
            coverage: { unresolvedIdInference: 'not_available', truncated: false },
        },
        keyDirectories: value.keyDirectories ?? [],
        localisation: {
            ...localisation,
            roots: localisation.roots ?? [],
            languages: localisation.languages ?? [],
            encoding: localisation.encoding ?? 'unknown',
            sampleFiles: localisation.sampleFiles ?? [],
        },
        identifiers: {
            ...identifiers,
            namespaces: identifiers.namespaces ?? [],
            variablePrefixes: identifiers.variablePrefixes ?? [],
            byType: identifiers.byType ?? {},
        },
        routing: {
            ...routing,
            recommendedWorkflowByIntent: routing.recommendedWorkflowByIntent ?? [],
            preferredReadTools: routing.preferredReadTools ?? [],
            avoidPatterns: routing.avoidPatterns ?? [],
        },
        validation: {
            ...validation,
            lspReady: validation.lspReady ?? 'unknown',
            indexStatus: validation.indexStatus ?? 'unknown',
            vanillaCache: validation.vanillaCache ?? 'unknown',
        },
        promptCards: value.promptCards ?? {},
        efficiencyHints: value.efficiencyHints ?? [],
    };
    return normalized;
}

/** Validate the generated profile before it reaches prompts, LSP, or MCP paths. */
export function isProjectProfile(value: unknown): value is ProjectProfile {
    if (!isRecord(value)
        || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
        || typeof value.generatedAt !== 'string'
        || typeof value.workspaceRoot !== 'string'
        || !PROFILE_WORKSPACE_KINDS.has(String(value.workspaceKind))
        || typeof value.projectName !== 'string'
        || !isRecord(value.game)
        || typeof value.game.id !== 'string'
        || typeof value.game.displayName !== 'string'
        || !PROFILE_GAME_CONFIDENCE.has(String(value.game.confidence))
        || !isStringArray(value.game.evidence)
        || !Array.isArray(value.keyDirectories)
        || !isRecord(value.localisation)
        || !isStringArray(value.localisation.roots)
        || !isStringArray(value.localisation.languages)
        || typeof value.localisation.encoding !== 'string'
        || !isStringArray(value.localisation.sampleFiles)
        || !isRecord(value.identifiers)
        || !isStringArray(value.identifiers.namespaces)
        || (value.identifiers.namespaceDetails !== undefined
            && (!Array.isArray(value.identifiers.namespaceDetails)
                || !value.identifiers.namespaceDetails.every(item => isRecord(item)
                    && typeof item.name === 'string'
                    && NAMESPACE_ORIGINS.has(String(item.origin))
                    && isStringArray(item.files)
                    && typeof item.evidence === 'string')))
        || !isStringArray(value.identifiers.variablePrefixes)
        || !isStringArrayRecord(value.identifiers.byType)
        || !isRecord(value.routing)
        || !Array.isArray(value.routing.recommendedWorkflowByIntent)
        || !isStringArray(value.routing.preferredReadTools)
        || !isStringArray(value.routing.avoidPatterns)
        || !isRecord(value.validation)
        || !PROFILE_LSP_STATES.has(String(value.validation.lspReady))
        || !PROFILE_INDEX_STATES.has(String(value.validation.indexStatus))
        || !PROFILE_VANILLA_STATES.has(String(value.validation.vanillaCache))
        || !isRecord(value.promptCards)
        || !Object.values(value.promptCards).every(item => typeof item === 'string')
        || !isStringArray(value.efficiencyHints)) {
        return false;
    }
    if (!value.keyDirectories.every(directory =>
        isRecord(directory)
        && typeof directory.key === 'string'
        && typeof directory.path === 'string'
        && typeof directory.exists === 'boolean'
        && (directory.fileCount === undefined
            || (typeof directory.fileCount === 'number' && Number.isFinite(directory.fileCount) && directory.fileCount >= 0)))) {
        return false;
    }
    if (!value.routing.recommendedWorkflowByIntent.every(route =>
        isRecord(route)
        && typeof route.intent === 'string'
        && typeof route.workflowId === 'string'
        && PROFILE_AGENT_MODES.has(String(route.mode))
        && typeof route.reason === 'string')) {
        return false;
    }
    if (value.modInfo !== undefined
        && (!isRecord(value.modInfo)
            || (value.modInfo.name !== undefined && typeof value.modInfo.name !== 'string')
            || (value.modInfo.version !== undefined && typeof value.modInfo.version !== 'string')
            || (value.modInfo.tags !== undefined && !isStringArray(value.modInfo.tags))
            || (value.modInfo.supportedVersion !== undefined && typeof value.modInfo.supportedVersion !== 'string')
            || (value.modInfo.remoteFileId !== undefined && typeof value.modInfo.remoteFileId !== 'string')
            || (value.modInfo.dependencies !== undefined && !isStringArray(value.modInfo.dependencies)))) {
        return false;
    }
    if (value.compatibility !== undefined) {
        if (!isRecord(value.compatibility)
            || !Array.isArray(value.compatibility.declaredDependencies)
            || !value.compatibility.declaredDependencies.every(item => isRecord(item) && typeof item.name === 'string' && typeof item.source === 'string')
            || !Array.isArray(value.compatibility.possibleSoftDependencies)
            || !value.compatibility.possibleSoftDependencies.every(item => isRecord(item)
                && typeof item.idOrPrefix === 'string'
                && typeof item.evidence === 'string'
                && item.confidence === 'heuristic'
                && (item.sources === undefined || (isStringArray(item.sources) && item.sources.every(source => ['placeholder', 'ignored_diagnostic', 'definition_stack', 'unresolved_id'].includes(source))))
                && (item.sampleIds === undefined || isStringArray(item.sampleIds)))
            || !Array.isArray(value.compatibility.dependencyRoots)
            || !value.compatibility.dependencyRoots.every(item => isRecord(item) && typeof item.name === 'string' && (item.root === undefined || typeof item.root === 'string') && (item.status === 'resolved' || item.status === 'unresolved') && typeof item.source === 'string')
            || !isRecord(value.compatibility.loadOrder)
            || (value.compatibility.loadOrder.source !== 'descriptor_only' && value.compatibility.loadOrder.source !== 'launcher_or_lsp')
            || (value.compatibility.loadOrder.confidence !== 'partial' && value.compatibility.loadOrder.confidence !== 'active')
            || !isStringArray(value.compatibility.loadOrder.orderedLayers)
            || !isStringArray(value.compatibility.loadOrder.warnings)
            || !isRecord(value.compatibility.coverage)
            || (value.compatibility.coverage.unresolvedIdInference !== 'not_available' && value.compatibility.coverage.unresolvedIdInference !== 'available')
            || typeof value.compatibility.coverage.truncated !== 'boolean'
            || (value.compatibility.coverage.evidenceSources !== undefined && !isStringArray(value.compatibility.coverage.evidenceSources))
            || (value.compatibility.coverage.unavailableSources !== undefined && !isStringArray(value.compatibility.coverage.unavailableSources))) return false;
    }
    for (const key of ['scriptedTriggers', 'scriptedEffects', 'events', 'onActions', 'staticModifiers']) {
        const legacyValue = value.identifiers[key];
        if (legacyValue !== undefined && !isStringArray(legacyValue)) return false;
    }
    return true;
}

function readProjectProfileFile(profilePath: string): ProjectProfile | null {
    try {
        const stat = fs.statSync(profilePath);
        if (!stat.isFile() || stat.size > MAX_PROJECT_PROFILE_BYTES) return null;
        const parsed = normalizeLegacyProjectProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')) as unknown);
        return isProjectProfile(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function readProjectProfile(workspaceRoot: string): ProjectProfile | null {
    const profilePath = getProjectProfilePath(workspaceRoot);
    if (fs.existsSync(profilePath)) {
        return readProjectProfileFile(profilePath);
    }
    const legacyPath = path.join(workspaceRoot, '.cwtools-ai', 'project', 'profile.json');
    if (fs.existsSync(legacyPath)) {
        return readProjectProfileFile(legacyPath);
    }
    return null;
}

export function writeProjectProfile(workspaceRoot: string, profile: ProjectProfile): string {
    const profilePath = getProjectProfilePath(workspaceRoot);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    return profilePath;
}

export function buildProjectProfile(workspaceRoot: string): ProjectProfile {
    const root = path.resolve(workspaceRoot);
    const descriptor = readDescriptor(root);
    const projectName = descriptor.name || path.basename(root);
    const hasExtensionSource = fs.existsSync(path.join(root, 'package.json'))
        && fs.existsSync(path.join(root, 'client', 'extension'));
    const hasModSignals = !!descriptor.exists
        || fs.existsSync(path.join(root, 'events'))
        || fs.existsSync(path.join(root, 'common'))
        || fs.existsSync(path.join(root, 'localisation'))
        || fs.existsSync(path.join(root, 'localization'));
    const workspaceKind: ProjectProfile['workspaceKind'] = hasExtensionSource && hasModSignals
        ? 'mixed'
        : hasExtensionSource
            ? 'extension_source'
            : hasModSignals
                ? 'paradox_mod'
                : 'generic';

    const keyDirectories = hasModSignals ? discoverKeyDirectories(root) : [];
    // Prioritize semantic boundary files before the generic directory sample:
    // large mods can otherwise exhaust the cap in alphabetically early common/
    // folders before events or compatibility placeholders are seen.
    const prioritizedScriptFiles = [
        ...collectFiles(path.join(root, 'events'), 320, ['.txt']),
        ...collectFiles(path.join(root, 'common', 'scripted_triggers'), 160, ['.txt']),
        ...collectFiles(path.join(root, 'common', 'scripted_effects'), 80, ['.txt']),
    ];
    const scriptFiles = [
        ...prioritizedScriptFiles,
        ...keyDirectories.flatMap(directory => collectFiles(path.join(root, directory.path), 80, ['.txt'])),
    ]
        .filter((file, index, files) => files.indexOf(file) === index)
        .slice(0, 800);
    const namespaceDetails = collectNamespaceDetails(root, scriptFiles);
    const namespaces = namespaceDetails.map(item => item.name);
    const softDependencies = collectSoftDependencies(root, scriptFiles);
    const variablePrefixes = collectVariablePrefixes(scriptFiles);
    const localisation = detectLocalisation(root);
    const game = detectGame(root, descriptor, keyDirectories.map(d => d.path));
    const vanillaCache = detectVanillaCache(root);
    const warnings = [...localisation.warnings, ...(descriptor.warnings ?? [])];
    const preferredReadTools = [
        'query_project_profile',
        'query_project_knowledge',
        'explore_pdx_project',
        'query_cwt_schema',
        'query_workspace_index',
        'query_localisation_index',
        'query_definition_by_name',
        'get_pdx_block',
        'document_symbols',
        'get_file_context',
    ];

    const profileBase: Omit<ProjectProfile, 'promptCards' | 'efficiencyHints'> = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        workspaceRoot: root,
        workspaceKind,
        projectName,
        game,
        modInfo: descriptor.exists ? {
            name: descriptor.name,
            version: descriptor.version,
            tags: descriptor.tags,
            supportedVersion: descriptor.supportedVersion,
            remoteFileId: descriptor.remoteFileId,
            dependencies: descriptor.dependencies,
        } : undefined,
        compatibility: {
            supportedVersion: descriptor.supportedVersion,
            declaredDependencies: (descriptor.dependencies ?? []).map(name => ({ name, source: 'descriptor.mod dependencies' })),
            possibleSoftDependencies: softDependencies,
            dependencyRoots: (descriptor.dependencies ?? []).map(name => ({
                name,
                status: 'unresolved' as const,
                source: 'descriptor.mod declares a display name but not a filesystem root',
            })),
            loadOrder: {
                source: 'descriptor_only',
                confidence: 'partial',
                orderedLayers: ['vanilla', ...(descriptor.dependencies ?? []).map(name => `dependency:${name}`), 'workspace'],
                warnings: descriptor.dependencies?.length
                    ? ['Descriptor dependency order is declarative evidence only; confirm the active launcher/LSP load order before resolving overrides.']
                    : ['No declared dependencies were found; optional soft dependencies still require unresolved-ID evidence.'],
            },
            coverage: {
                unresolvedIdInference: softDependencies.some(item => item.sources?.includes('ignored_diagnostic')) ? 'available' : 'not_available',
                truncated: scriptFiles.length >= 800,
                evidenceSources: Array.from(new Set(softDependencies.flatMap(item => item.sources ?? []))).sort(),
                unavailableSources: ['definition_stack (requires deep CWTools knowledge export)'],
            },
        },
        keyDirectories,
        localisation: {
            roots: localisation.roots,
            languages: localisation.languages,
            defaultLanguage: localisation.defaultLanguage,
            encoding: localisation.encoding,
            encodingByLanguage: localisation.encodingByLanguage,
            sampleFiles: localisation.sampleFiles,
        },
        identifiers: {
            namespaces,
            namespaceDetails,
            variablePrefixes,
            byType: {},
        },
        routing: {
            recommendedWorkflowByIntent: [
                {
                    intent: 'Fix CWTools diagnostics',
                    workflowId: 'diagnostic-fix',
                    mode: 'build',
                    reason: 'Starts from get_diagnostics and verifies zero real errors after edits.',
                },
                {
                    intent: 'Generate missing localisation',
                    workflowId: 'loc-generation',
                    mode: 'build',
                    reason: 'Uses write_localisation and the detected language/encoding profile.',
                },
                {
                    intent: 'Design event chains',
                    workflowId: 'event-chain-design',
                    mode: 'plan',
                    reason: 'Studies vanilla archetypes and writes a reusable design blueprint.',
                },
                {
                    intent: 'Review rules or cache updates',
                    workflowId: 'rules-sync-review',
                    mode: 'review',
                    reason: 'Triages diagnostics after CWTools rule updates.',
                },
                {
                    intent: 'Fix sprite or sound references',
                    workflowId: 'asset-wiring',
                    mode: 'build',
                    reason: 'Uses verified project/vanilla asset candidates instead of guessed IDs.',
                },
            ],
            preferredReadTools,
            avoidPatterns: [
                'Do not broad grep before checking query_project_profile, explore_pdx_project, and query_workspace_index.',
                'Do not invent PDX identifiers, localisation keys, GFX names, or sound names.',
                'Do not write localisation through generic write tools; use write_localisation.',
            ],
        },
        validation: {
            lspReady: 'unknown',
            indexStatus: 'unknown',
            vanillaCache: vanillaCache.state,
            vanillaCacheEvidence: vanillaCache.evidence,
        },
        warnings,
    };

    const promptCards = buildPromptCards(profileBase);
    const efficiencyHints = [
        'Call query_project_profile(section="summary") before broad workspace scans.',
        'Use query_cwt_schema or get_completion_at before inventing common/ entity fields or block shapes.',
        'Use query_project_knowledge for complex cross-subsystem work, then explore_pdx_project/query_workspace_index/query_definition_by_name for live exact evidence.',
        'Use mode-specific prompt cards from the profile instead of injecting full project files.',
        'Keep CWTOOLS.md for human-edited rules; use profile.json for machine routing facts.',
    ];

    return {
        ...profileBase,
        promptCards,
        efficiencyHints,
    };
}

export function queryProjectProfile(workspaceRoot: string, args: QueryProjectProfileArgs = {}): QueryProjectProfileResult {
    const profilePath = getProjectProfilePath(workspaceRoot);
    try {
        const profile = readProjectProfile(workspaceRoot);
        if (!profile) {
            const legacyPath = path.join(workspaceRoot, '.cwtools-ai', 'project', 'profile.json');
            if (fs.existsSync(profilePath) || fs.existsSync(legacyPath)) {
                return {
                    status: 'error',
                    profilePath,
                    error: 'Project profile is malformed, unreadable, or exceeds the 2 MiB size limit. Run /init to regenerate it.',
                };
            }
            return {
                status: 'missing',
                profilePath,
                _hint: 'Run /init to generate .cwtools/project/profile.json, then retry query_project_profile.',
            };
        }
        const section = args.section ?? 'summary';
        const promptCard = args.mode ? getPromptCardForMode(profile, args.mode) : undefined;
        if (section === 'all') {
            return { status: 'ready', profilePath, generatedAt: profile.generatedAt, section, profile, promptCard };
        }
        const data = selectProfileSection(profile, section);
        return {
            status: 'ready',
            profilePath,
            generatedAt: profile.generatedAt,
            section,
            summary: buildProfileSummary(profile),
            data,
            promptCard,
            _hint: 'Use section="routing", "localisation", "identifiers", or mode-specific promptCard for targeted context.',
        };
    } catch (e) {
        return {
            status: 'error',
            profilePath,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

export function getPromptCardForMode(profile: ProjectProfile, mode: AgentMode | 'asset'): string {
    if (mode === 'loc_translator' || mode === 'loc_writer') return profile.promptCards.loc_writer ?? profile.promptCards.build ?? '';
    if (mode === 'gui_expert') return profile.promptCards.asset ?? profile.promptCards.build ?? '';
    if (mode === 'script_reviewer') return profile.promptCards.review ?? '';
    return profile.promptCards[mode] ?? profile.promptCards.build ?? '';
}

export function buildProfileSummary(profile: ProjectProfile): string {
    const dirs = keyDirectoryLines(profile).slice(0, 8).join(', ') || 'none';
    const namespaces = profile.identifiers.namespaces.slice(0, 8).join(', ') || 'none';
    const languages = profile.localisation.languages.join(', ') || 'unknown';
    const supportedVersion = profile.modInfo?.supportedVersion ? ` (${profile.modInfo.supportedVersion})` : '';
    return [
        `Project: ${profile.projectName}`,
        `Kind: ${profile.workspaceKind}`,
        `Game: ${profile.game.displayName}${supportedVersion}`,
        `Key dirs: ${dirs}`,
        `Namespaces: ${namespaces}`,
        `Localisation: ${languages} (${profile.localisation.encoding})`,
    ].join('\n');
}

/** High-value Stellaris subsystems shown first, then remaining dirs by file count. */
const HIGH_VALUE_SUBSYSTEMS = [
    'common/inline_scripts',
    'common/scripted_effects',
    'common/scripted_triggers',
    'common/scripted_values',
    'events',
    'common/on_actions',
    'common/situations',
    'common/megastructures',
    'interface',
    'common/special_projects',
    'common/event_chains',
    'common/technologies',
    'common/component_templates',
    'common/section_templates',
    'common/ship_sizes',
    'gfx',
    'sound',
];

/** Sort existing key directories: high-value subsystems first, then by file count. */
function keyDirectoryLines(profile: Pick<ProjectProfile, 'keyDirectories'>): string[] {
    const existing = profile.keyDirectories.filter(dir => dir.exists);
    const subsystemRank = (pathValue: string): number => {
        const index = HIGH_VALUE_SUBSYSTEMS.indexOf(pathValue);
        return index < 0 ? HIGH_VALUE_SUBSYSTEMS.length : index;
    };
    return existing
        .slice()
        .sort((a, b) => subsystemRank(a.path) - subsystemRank(b.path) || (b.fileCount ?? 0) - (a.fileCount ?? 0) || a.path.localeCompare(b.path))
        .map(dir => dir.path);
}

function selectProfileSection(profile: ProjectProfile, section: NonNullable<QueryProjectProfileArgs['section']>): unknown {
    switch (section) {
        case 'routing': return profile.routing;
        case 'directories': return profile.keyDirectories;
        case 'localisation': return profile.localisation;
        case 'identifiers': return profile.identifiers;
        case 'validation': return profile.validation;
        case 'compatibility': return {
            ...(profile.compatibility ?? {}),
            supportedVersion: profile.compatibility?.supportedVersion ?? profile.modInfo?.supportedVersion,
            remoteFileId: profile.modInfo?.remoteFileId,
            dependencies: profile.modInfo?.dependencies ?? [],
            vanillaCache: profile.validation.vanillaCache,
            vanillaCacheEvidence: profile.validation.vanillaCacheEvidence,
            game: profile.game,
        };
        case 'promptCards': return profile.promptCards;
        case 'summary':
        default:
            return {
                workspaceKind: profile.workspaceKind,
                projectName: profile.projectName,
                game: profile.game,
                supportedVersion: profile.modInfo?.supportedVersion,
                generatedAt: profile.generatedAt,
                freshness: profile.freshness,
                warnings: profile.warnings ?? [],
                efficiencyHints: profile.efficiencyHints,
            };
    }
}

function buildPromptCards(profile: Omit<ProjectProfile, 'promptCards' | 'efficiencyHints'>): ProjectProfile['promptCards'] {
    const namespaces = profile.identifiers.namespaces.slice(0, 12).join(', ') || 'none detected';
    const languages = profile.localisation.languages.join(', ') || 'unknown';
    const encoding = profile.localisation.encoding;
    const keyDirs = keyDirectoryLines(profile).slice(0, 10).join(', ') || 'none detected';
    return {
        build: [
            'Build mode project card:',
            `- Workspace kind: ${profile.workspaceKind}; game: ${profile.game.displayName}.`,
            `- Key directories: ${keyDirs}.`,
            `- Namespaces: ${namespaces}.`,
            '- Before editing known IDs, prefer explore_pdx_project/query_workspace_index/query_definition_by_name/get_pdx_block.',
            '- After edits, run get_diagnostics on changed files.',
        ].join('\n'),
        plan: [
            'Plan mode project card:',
            '- For complex pipelines, query_project_knowledge must establish project patterns, vanilla archetypes, topology, override evidence, and unresolved facts before blueprint approval.',
            `- Study existing patterns in: ${keyDirs}.`,
            '- Enumerate current TypeDefs and project-graph dependency families before designing a complex pipeline; record selected and rejected families in the blueprint.',
            '- Use exact vanilla archetypes before inventing cross-type calls or scope flows.',
            `- Existing namespaces: ${namespaces}. Allocate IDs deliberately and record them in the blueprint.`,
            '- Prefer write_design_blueprint for implementation-ready plans.',
        ].join('\n'),
        explore: [
            'Explore mode project card:',
            '- Start with query_project_profile, then explore_pdx_project for a bounded semantic graph.',
            '- Use broad scans only after indexed lookups fail or when the user asks for a full audit.',
        ].join('\n'),
        review: [
            'Review mode project card:',
            '- Collect diagnostics first, group by rule/category, then inspect representative files.',
            '- Treat cache/rules-sync issues separately from real script defects.',
            '- Verify suspicious missing IDs through at least two independent indexed sources.',
        ].join('\n'),
        utility: [
            'Utility mode project card:',
            '- Use project profile facts for paths and routing before running shell commands.',
            '- Prefer existing repository scripts and keep generated helpers in the topic scratch directory.',
        ].join('\n'),
        loc_writer: [
            'Localisation mode project card:',
            `- Languages: ${languages}.`,
            `- Encoding: ${encoding}.`,
            '- Use write_localisation for YML writes; do not patch localisation files with generic write tools.',
            '- Query query_localisation_index before creating keys.',
        ].join('\n'),
        asset: [
            'Asset mode project card:',
            '- Use find_sprite_candidates/find_sound_candidates with searchContext="both" before replacing asset references.',
            '- Never invent GFX_* or sound names; use verified project or vanilla definitions.',
            '- Check interface, gfx, and sound directories from the profile before scanning everything.',
        ].join('\n'),
        orchestrator: [
            'General Multi-Agent project card:',
            '- Dispatch sub-agents with plannedFiles when known.',
            '- Put shared interfaces, file ownership, and decisions on the blackboard.',
            '- Utility writers may run scoped formatting, build, and test commands through the parent policy engine; explore, plan, and review roles stay read-only.',
        ].join('\n'),
        script: [
            'Paradox Multi-Agent project card:',
            '- Use dynamic workflow waves: preflight, read fanout, classify, write batches, verify, summarize.',
            '- Start with project profile, workspace index, diagnostics, scope/rule queries, and asset candidates.',
            '- Dispatch up to 8 concise read-heavy tasks, but keep write waves narrow and always set plannedFiles.',
            '- Use reviewer/diagnostics verification after every write wave before summarizing.',
        ].join('\n'),
    };
}

function readDescriptor(root: string): {
    exists: boolean;
    name?: string;
    version?: string;
    tags?: string[];
    supportedVersion?: string;
    remoteFileId?: string;
    dependencies?: string[];
    warnings?: string[];
} {
    const descriptorPath = path.join(root, 'descriptor.mod');
    if (!fs.existsSync(descriptorPath)) return { exists: false };
    let content: string;
    try {
        content = fs.readFileSync(descriptorPath, 'utf8');
    } catch {
        return { exists: true, warnings: ['descriptor.mod is not readable; treating it as absent.'] };
    }
    const warnings: string[] = [];
    const name = content.match(/^name\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const version = content.match(/^version\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const supportedVersion = content.match(/^supported_version\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const remoteFileId = content.match(/^remote_file_id\s*=\s*"?(\d+)"?/m)?.[1]?.trim();
    const tagsBlock = content.match(/^tags\s*=\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
    const tags = Array.from(tagsBlock.matchAll(/"([^"]+)"/g)).map(match => match[1]).filter((tag): tag is string => !!tag);
    const dependenciesBlock = content.match(/^dependencies\s*=\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
    const dependencies = Array.from(dependenciesBlock.matchAll(/"([^"]+)"/g))
        .map(match => match[1])
        .filter((value): value is string => !!value)
        .filter((value, index, values) => values.indexOf(value) === index);
    if (content.includes('supported_version') && !supportedVersion) warnings.push('descriptor.mod declares supported_version but it could not be parsed.');
    if (content.includes('remote_file_id') && !remoteFileId) warnings.push('descriptor.mod declares remote_file_id but it could not be parsed.');
    if (content.includes('dependencies') && dependencies.length === 0) warnings.push('descriptor.mod declares dependencies but none could be parsed.');
    return { exists: true, name, version, tags, supportedVersion, remoteFileId, dependencies, warnings };
}

function detectGame(
    root: string,
    descriptor: { tags?: string[] },
    directoryEvidence: string[],
): ProjectProfile['game'] {
    const tagText = (descriptor.tags ?? []).join(' ').toLowerCase();
    const rootLower = root.toLowerCase();
    for (const profile of getAllProfiles()) {
        const markers = [profile.id, profile.displayName, profile.install.steamFolderName]
            .map(value => value.trim().toLowerCase())
            .filter(value => value.length > 2);
        const tagMarker = markers.find(marker => tagText.includes(marker));
        if (tagMarker) {
            return {
                id: profile.id,
                displayName: profile.displayName,
                confidence: 'high',
                evidence: [`registered profile marker '${tagMarker}' found in descriptor tags`],
            };
        }
        const pathMarker = markers.find(marker => rootLower.includes(marker));
        if (pathMarker) {
            return {
                id: profile.id,
                displayName: profile.displayName,
                confidence: 'medium',
                evidence: [`registered profile marker '${pathMarker}' found in workspace path`],
            };
        }
    }
    if (directoryEvidence.length > 0) {
        return { id: 'paradox', displayName: 'Paradox Script', confidence: 'low', evidence: ['PDX content directories detected; exact game remains an LSP/profile fact'] };
    }
    return { id: 'unknown', displayName: 'Unknown', confidence: 'low', evidence: ['No Paradox game marker detected'] };
}

interface LocalisationDetectionResult {
    roots: string[];
    languages: string[];
    defaultLanguage?: string;
    encoding: string;
    encodingByLanguage?: Record<string, string>;
    sampleFiles: string[];
    warnings: string[];
}

/** Normalize a language directory/file name to its `l_<tag>` form when possible. */
function normalizeLanguageTag(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    // Match the final `l_<tag>` segment; a negative lookahead stops greedy
    // consumption across another `l_` marker (e.g. `my_l_cool_l_simp_chinese`).
    const fromName = trimmed.match(/(?:^|_)(l_(?:(?!(?:\b|_)l_)[a-z_])+)(?:\.yml)?$/i)?.[1]?.toLowerCase();
    if (fromName) return fromName;
    const directoryTag = trimmed.match(/^(?:l_)?[a-z][a-z_]*$/i);
    if (directoryTag) {
        const raw = directoryTag[0].toLowerCase();
        return raw.startsWith('l_') ? raw : `l_${raw}`;
    }
    return undefined;
}

/** Read the declared language header of a localisation file (e.g. `l_english:`). */
function readLocalisationHeader(filePath: string): { language?: string; bom: boolean; readable: boolean } {
    try {
        const buf = fs.readFileSync(filePath);
        const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        const text = buf.toString('utf8', bom ? 3 : 0);
        const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
        const header = firstLine.match(/^\s*(l_[a-z_]+)\s*:/i)?.[1]?.toLowerCase();
        return { language: header, bom, readable: true };
    } catch {
        return { bom: false, readable: false };
    }
}

function detectLocalisation(root: string): LocalisationDetectionResult {
    const roots = ['localisation', 'localization'].filter(rel => fs.existsSync(path.join(root, rel)));
    const warnings: string[] = [];
    const languageFiles = new Map<string, string[]>();
    const languageDirectories = new Set<string>();

    for (const rel of roots) {
        const base = path.join(root, rel);
        // 1. Collect every first-level language directory name.
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(base, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            continue;
        }
        for (const entry of entries) {
            const language = normalizeLanguageTag(entry.name);
            if (!language) continue;
            languageDirectories.add(language);
            // Sample up to three files per language so mixed BOM within one
            // language can be detected instead of being majority-voted away.
            const files = collectFiles(path.join(base, entry.name), 4, ['.yml'])
                .filter(file => path.dirname(file) === path.join(base, entry.name));
            for (const file of files.slice(0, 3)) {
                const bucket = languageFiles.get(language) ?? [];
                bucket.push(file);
                languageFiles.set(language, bucket);
            }
        }
        // 2. Fall back to file-name sampling inside the root.
        if (languageFiles.size === 0) {
            const rootFiles = collectFiles(base, 12, ['.yml'])
                .filter(file => path.dirname(file) === base);
            for (const file of rootFiles) {
                const language = normalizeLanguageTag(path.basename(file));
                if (!language) continue;
                const bucket = languageFiles.get(language) ?? [];
                bucket.push(file);
                languageFiles.set(language, bucket);
            }
        }
    }

    const languages = Array.from(new Set([...languageDirectories, ...languageFiles.keys()])).sort();
    const sampleFiles = Array.from(languageFiles.values()).flat().map(file => toRelative(root, file)).sort();
    const samples = languages
        .map(language => ({
            language,
            files: languageFiles.get(language) ?? [],
        }))
        .filter(sample => sample.files.length > 0)
        .flatMap(sample => sample.files.map(file => {
            const header = readLocalisationHeader(file);
            if (header.readable && header.language && header.language !== sample.language) {
                warnings.push(`Localisation file ${toRelative(root, file)} declares header '${header.language}' but sits under a '${sample.language}' name.`);
            }
            if (!header.readable) {
                warnings.push(`Localisation sample ${toRelative(root, file)} could not be read.`);
            }
            return { language: sample.language, file, ...header };
        }));

    // 3. Per-language encoding; mixed BOM inside one language becomes a warning
    //    instead of being silently resolved by majority vote.
    const encodingByLanguage: Record<string, string> = {};
    const languageBomCounts = new Map<string, { bom: number; noBom: number }>();
    for (const sample of samples) {
        const counts = languageBomCounts.get(sample.language) ?? { bom: 0, noBom: 0 };
        if (sample.bom) counts.bom++; else counts.noBom++;
        languageBomCounts.set(sample.language, counts);
    }
    for (const [language, counts] of languageBomCounts) {
        const total = counts.bom + counts.noBom;
        if (total === 0) continue;
        encodingByLanguage[language] = counts.bom >= counts.noBom ? 'UTF-8 with BOM' : 'UTF-8 without BOM';
        if (counts.bom > 0 && counts.noBom > 0) {
            warnings.push(`Localisation language ${language} mixes BOM and non-BOM files (${counts.bom} BOM / ${counts.noBom} non-BOM); per-language encoding reflects the majority.`);
        }
    }
    let bomCount = 0;
    let noBomCount = 0;
    for (const sample of samples) {
        if (sample.bom) bomCount++; else noBomCount++;
    }
    const dominantEncoding = bomCount + noBomCount > 0
        ? (bomCount >= noBomCount ? 'UTF-8 with BOM' : 'UTF-8 without BOM')
        : 'unknown';
    let defaultLanguage: string | undefined;
    if (languages.length === 1) {
        defaultLanguage = languages[0];
    } else if (languageBomCounts.size > 0) {
        const totals = [...languageBomCounts.entries()]
            .map(([language, counts]) => ({ language, total: counts.bom + counts.noBom }))
            .sort((a, b) => b.total - a.total || a.language.localeCompare(b.language));
        const top = totals[0];
        const second = totals[1];
        if (top && (!second || top.total > second.total)) defaultLanguage = top.language;
    }

    return {
        roots,
        languages,
        defaultLanguage,
        encoding: dominantEncoding,
        encodingByLanguage: Object.keys(encodingByLanguage).length > 0 ? encodingByLanguage : undefined,
        sampleFiles,
        warnings,
    };
}

function detectVanillaCache(root: string): { state: ProjectProfile['validation']['vanillaCache']; evidence?: string } {
    // A bare `.cwtools` directory is not proof of a usable vanilla cache: verify
    // that a serialized cache file or a vanilla data folder is actually present.
    const candidates = [
        path.join(root, '.cwtools'),
        path.join(root, '.cwtools-ai'),
    ];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const cacheFiles = collectFiles(candidate, 8, ['.cwb']);
        if (cacheFiles.length > 0) {
            return { state: 'configured', evidence: toRelative(root, cacheFiles[0]!) };
        }
        const vanillaDir = path.join(candidate, 'vanilla');
        if (fs.existsSync(vanillaDir)) {
            const vanillaEntries = collectFiles(vanillaDir, 8, ['.txt', '.yml', '.json']);
            if (vanillaEntries.length > 0) {
                return { state: 'configured', evidence: toRelative(root, vanillaEntries[0]!) };
            }
        }
        const cacheMetadata = path.join(candidate, 'cache.json');
        if (fs.existsSync(cacheMetadata)) {
            return { state: 'configured', evidence: toRelative(root, cacheMetadata) };
        }
        return { state: 'missing', evidence: `${toRelative(root, candidate)} exists but contains no readable vanilla cache` };
    }
    return { state: 'unknown' };
}

function discoverKeyDirectories(root: string): ProjectProfile['keyDirectories'] {
    const supportedExtensions = ['.txt', '.gui', '.gfx', '.asset', '.entity', '.yml'];
    const excluded = new Set(['node_modules', 'bin', 'obj', 'release', 'out', 'dist', 'artifacts', 'submodules']);
    const relativePaths = new Set<string>();
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name.toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
    let commonHasSubdirectories = false;
    for (const entry of entries) {
        const absolute = path.join(root, entry.name);
        if (collectFiles(absolute, 1, supportedExtensions).length === 0) continue;
        relativePaths.add(entry.name);
        if (entry.name.toLowerCase() !== 'common') continue;
        try {
            const childDirectories = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
            for (const child of childDirectories) {
                if (!child.isDirectory() || child.name.startsWith('.')) continue;
                const childPath = path.join(absolute, child.name);
                if (collectFiles(childPath, 1, supportedExtensions).length > 0) {
                    relativePaths.add(path.join(entry.name, child.name));
                    commonHasSubdirectories = true;
                }
            }
        } catch {
            // A concurrently removed directory is simply absent from the quick profile.
        }
    }
    return [...relativePaths]
        .sort((a, b) => a.localeCompare(b))
        .map(relativePath => {
            const absolute = path.join(root, relativePath);
            // When `common` is split into subdirectories, count only its direct
            // files so parent and children are not double-counted.
            const fileCount = commonHasSubdirectories && relativePath === 'common'
                ? countDirectFiles(absolute, supportedExtensions)
                : collectFiles(absolute, 400, supportedExtensions).length;
            return {
                key: relativePath.replace(/\\/g, '/'),
                path: relativePath.replace(/\\/g, '/'),
                exists: true,
                fileCount,
            };
        });
}

/** Count files directly inside a directory without descending into subdirectories. */
function countDirectFiles(dir: string, extensions: string[]): number {
    const allowed = new Set(extensions.map(ext => ext.toLowerCase()));
    let count = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && !entry.name.startsWith('.') && allowed.has(path.extname(entry.name).toLowerCase())) count++;
        }
    } catch {
        // Unreadable directory contributes zero direct files.
    }
    return count;
}

function collectFiles(dir: string, maxCount: number, extensions?: string[]): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return results;
    const stack = [dir];
    const allowed = extensions ? new Set(extensions.map(ext => ext.toLowerCase())) : undefined;
    while (stack.length > 0 && results.length < maxCount) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (results.length >= maxCount) break;
            if (entry.name.startsWith('.')) continue;
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!['node_modules', 'bin', 'obj', 'release'].includes(entry.name)) stack.push(abs);
            } else if (!allowed || allowed.has(path.extname(entry.name).toLowerCase())) {
                results.push(abs);
            }
        }
    }
    return results;
}

function collectNamespaceDetails(root: string, files: string[]): NonNullable<ProjectProfile['identifiers']['namespaceDetails']> {
    const occurrences = new Map<string, Set<string>>();
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const match of content.matchAll(/^namespace\s*=\s*"?([\w.:-]+)"?/gm)) {
                if (!match[1]) continue;
                const bucket = occurrences.get(match[1]) ?? new Set<string>();
                bucket.add(toRelative(root, file));
                occurrences.set(match[1], bucket);
            }
        } catch {
            // Ignore unreadable samples.
        }
    }
    return [...occurrences.entries()]
        .map(([name, foundFiles]) => {
            const filesForNamespace = [...foundFiles].sort();
            const normalizedPaths = filesForNamespace.map(file => file.toLowerCase());
            let origin: NonNullable<ProjectProfile['identifiers']['namespaceDetails']>[number]['origin'] = 'workspace_owned';
            let evidence = 'Namespace is declared in ordinary workspace event files.';
            if (normalizedPaths.some(file => /(?:^|\/)(?:compat(?:ibility)?|patch(?:es)?|placeholder|optional)(?:\/|_|\.|$)/.test(file))) {
                origin = 'compatibility';
                evidence = 'Namespace is declared under a compatibility, patch, optional, or placeholder path.';
            } else if (normalizedPaths.some(file => /(?:^|\/)(?:override|overrides|overwrite|replace)(?:\/|_|\.|$)/.test(file))) {
                origin = 'vanilla_override';
                evidence = 'Namespace is declared under an explicit override/overwrite path.';
            } else if (normalizedPaths.every(file => /(?:^|\/)(?:external|dependency|vendor)(?:\/|_|\.|$)/.test(file))) {
                origin = 'external';
                evidence = 'Namespace is declared only under an external, dependency, or vendor path.';
            }
            return { name, origin, files: filesForNamespace.slice(0, 12), evidence };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Merge evidence that is available only after the coherent CWTools knowledge
 * export. This keeps quick /init scanning cheap while still classifying
 * definition-stack overrides and unresolved external identifiers. */
export function mergeDeepCompatibilityEvidence(
    profile: ProjectProfile,
    evidence: { unresolved?: Array<Record<string, unknown>>; definitionStacks?: Array<Record<string, unknown>> },
): void {
    if (!profile.compatibility) return;
    const merged = new Map(profile.compatibility.possibleSoftDependencies.map(item => [item.idOrPrefix, {
        ...item,
        sources: new Set(item.sources ?? []),
        sampleIds: new Set(item.sampleIds ?? []),
    }]));
    const workspaceNamespaces = new Set(profile.identifiers.namespaces.map(value => value.toLowerCase()));
    const stringsIn = (value: unknown, depth = 0): string[] => {
        if (depth > 4) return [];
        if (typeof value === 'string') return [value];
        if (Array.isArray(value)) return value.flatMap(item => stringsIn(item, depth + 1));
        if (isRecord(value)) return Object.values(value).flatMap(item => stringsIn(item, depth + 1));
        return [];
    };
    const add = (raw: string, source: 'definition_stack' | 'unresolved_id', sample: string) => {
        const prefix = dependencyPrefix(raw);
        if (!prefix || (source === 'unresolved_id' && workspaceNamespaces.has(prefix))) return;
        const current = merged.get(prefix) ?? {
            idOrPrefix: prefix,
            evidence: '',
            confidence: 'heuristic' as const,
            sources: new Set<SoftDependencySource>(),
            sampleIds: new Set<string>(),
        };
        current.sources.add(source);
        if (current.sampleIds.size < 8) current.sampleIds.add(sample.slice(0, 200));
        merged.set(prefix, current);
    };
    for (const unresolved of evidence.unresolved ?? []) {
        for (const value of stringsIn(unresolved).filter(value => /^[A-Za-z][A-Za-z0-9_.:-]{2,}$/.test(value))) add(value, 'unresolved_id', value);
    }
    for (const stack of evidence.definitionStacks ?? []) {
        const values = stringsIn(stack);
        const serialized = JSON.stringify(stack).toLowerCase();
        for (const value of values.filter(value => /^[A-Za-z][A-Za-z0-9_.:-]{2,}$/.test(value))) add(value, 'definition_stack', value);
        profile.identifiers.namespaceDetails = profile.identifiers.namespaceDetails?.map(namespace => {
            const ownsStack = values.some(value => value.toLowerCase() === namespace.name.toLowerCase() || value.toLowerCase().startsWith(`${namespace.name.toLowerCase()}.`));
            if (!ownsStack) return namespace;
            if (serialized.includes('workspace') && serialized.includes('vanilla')) {
                return { ...namespace, origin: 'vanilla_override' as const, evidence: 'CWTools definition stack contains both workspace and vanilla layers.' };
            }
            if (serialized.includes('dependency') || serialized.includes('external')) {
                return { ...namespace, origin: 'compatibility' as const, evidence: 'CWTools definition stack links this namespace to a dependency/external layer.' };
            }
            return namespace;
        });
    }
    profile.compatibility.possibleSoftDependencies = [...merged.values()]
        .map(item => {
            const sources = [...item.sources].sort();
            const sampleIds = [...item.sampleIds].sort();
            return { ...item, sources, sampleIds, evidence: `${sources.join(' + ')} evidence: ${sampleIds.slice(0, 3).join('; ')}` };
        })
        .sort((a, b) => b.sources.length - a.sources.length || a.idOrPrefix.localeCompare(b.idOrPrefix))
        .slice(0, 120);
    const deepSources = [
        ...(evidence.unresolved?.length ? ['unresolved_id'] : []),
        ...(evidence.definitionStacks?.length ? ['definition_stack'] : []),
    ];
    profile.compatibility.coverage = {
        ...profile.compatibility.coverage,
        unresolvedIdInference: evidence.unresolved ? 'available' : profile.compatibility.coverage.unresolvedIdInference,
        evidenceSources: Array.from(new Set([...(profile.compatibility.coverage.evidenceSources ?? []), ...deepSources])).sort(),
        unavailableSources: evidence.definitionStacks ? [] : ['definition_stack'],
    };
}

type SoftDependencySource = NonNullable<NonNullable<ProjectProfile['compatibility']>['possibleSoftDependencies'][number]['sources']>[number];

function dependencyPrefix(value: string): string | undefined {
    const cleaned = value.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    const match = cleaned.match(/^([a-z][a-z0-9]{1,15})(?:[_:.-]|$)/)?.[1];
    if (!match || ['is', 'has', 'can', 'set', 'get', 'remove', 'clear', 'country', 'planet', 'ship', 'leader', 'authority', 'technology', 'static'].includes(match)) return undefined;
    return match;
}

/** Infer optional compatibility layers from explicit project-owned evidence only. */
function collectSoftDependencies(root: string, scriptFiles: string[]): NonNullable<ProjectProfile['compatibility']>['possibleSoftDependencies'] {
    const evidence = new Map<string, { sources: Set<SoftDependencySource>; samples: Set<string> }>();
    const add = (candidate: string, source: SoftDependencySource, sample: string) => {
        const prefix = dependencyPrefix(candidate);
        if (!prefix) return;
        const bucket = evidence.get(prefix) ?? { sources: new Set<SoftDependencySource>(), samples: new Set<string>() };
        bucket.sources.add(source);
        if (bucket.samples.size < 8) bucket.samples.add(sample);
        evidence.set(prefix, bucket);
    };

    for (const file of scriptFiles) {
        const relative = toRelative(root, file);
        if (!/(?:placeholder|compat|patch)/i.test(relative)) continue;
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const marker of content.matchAll(/^\s*#.*?\|([A-Za-z0-9_/-]{2,80})\|/gm)) {
                for (const token of (marker[1] ?? '').split(/[\/|_-]+/)) add(token, 'placeholder', `${relative}: ${marker[1]}`);
            }
            for (const definition of content.matchAll(/^\s*([A-Za-z][A-Za-z0-9_.:-]{2,})\s*=\s*\{/gm)) {
                if (definition[1]) add(definition[1], 'placeholder', `${relative}: ${definition[1]}`);
            }
        } catch {
            // Unreadable compatibility sample contributes no evidence.
        }
    }

    const settingsPath = path.join(root, '.vscode', 'settings.json');
    try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(raw) as unknown;
        if (isRecord(settings)) {
            const ignored = settings['stellarisLanguageServices.ai.ignoredDiagnostics'];
            if (isStringArray(ignored)) {
                for (const item of ignored) add(item, 'ignored_diagnostic', `.vscode/settings.json: ${item.slice(0, 120)}`);
            }
        }
    } catch {
        // Settings may be JSONC or absent; quick profile remains deterministic.
    }

    return [...evidence.entries()]
        .filter(([, item]) => item.sources.has('placeholder') || item.sources.has('ignored_diagnostic'))
        .map(([idOrPrefix, item]) => {
            const sources = [...item.sources].sort();
            const sampleIds = [...item.samples].sort();
            return {
                idOrPrefix,
                evidence: `${sources.join(' + ')} evidence: ${sampleIds.slice(0, 3).join('; ')}`,
                confidence: 'heuristic' as const,
                sources,
                sampleIds,
            };
        })
        .sort((a, b) => b.sources.length - a.sources.length || a.idOrPrefix.localeCompare(b.idOrPrefix))
        .slice(0, 80);
}

function collectVariablePrefixes(files: string[]): string[] {
    const prefixes = new Set<string>();
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const match of content.matchAll(/@([A-Za-z_][\w]*)/g)) {
                const prefix = match[1]?.split('_')[0];
                if (prefix && prefix.length > 1) prefixes.add(`@${prefix}_`);
                if (prefixes.size >= 30) return [...prefixes].sort();
            }
        } catch {
            // Ignore unreadable samples.
        }
    }
    return [...prefixes].sort();
}

function toRelative(root: string, file: string): string {
    return path.relative(root, file).replace(/\\/g, '/');
}
