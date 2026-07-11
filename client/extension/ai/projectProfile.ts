import * as fs from 'fs';
import * as path from 'path';
import type {
    AgentMode,
    ProjectProfile,
    QueryProjectProfileArgs,
    QueryProjectProfileResult,
} from './types';

export const PROJECT_PROFILE_RELATIVE_PATH = path.join('.cwtools-ai', 'project', 'profile.json');

const SCRIPT_DIR_KEYS = [
    ['events', 'events'],
    ['common', 'common'],
    ['scripted_triggers', path.join('common', 'scripted_triggers')],
    ['scripted_effects', path.join('common', 'scripted_effects')],
    ['scripted_variables', path.join('common', 'scripted_variables')],
    ['on_actions', path.join('common', 'on_actions')],
    ['static_modifiers', path.join('common', 'static_modifiers')],
    ['interface', 'interface'],
    ['gfx', 'gfx'],
    ['sound', 'sound'],
    ['localisation', 'localisation'],
    ['localization', 'localization'],
] as const;

export function getProjectProfilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, PROJECT_PROFILE_RELATIVE_PATH);
}

export function readProjectProfile(workspaceRoot: string): ProjectProfile | null {
    const profilePath = getProjectProfilePath(workspaceRoot);
    if (!fs.existsSync(profilePath)) return null;
    const raw = fs.readFileSync(profilePath, 'utf8');
    const parsed = JSON.parse(raw) as ProjectProfile;
    return parsed?.schemaVersion === 1 ? parsed : null;
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

    const keyDirectories = SCRIPT_DIR_KEYS.map(([key, relPath]) => {
        const abs = path.join(root, relPath);
        const exists = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
        return {
            key,
            path: relPath.replace(/\\/g, '/'),
            exists,
            fileCount: exists ? collectFiles(abs, 400).length : 0,
        };
    });

    const eventFiles = collectFiles(path.join(root, 'events'), 80, ['.txt']);
    const namespaces = collectNamespaces(eventFiles);
    const variableIds = sampleIds(path.join(root, 'common', 'scripted_variables'), 30);
    const variablePrefixes = Array.from(new Set(variableIds
        .map(id => id.replace(/^@/, '').split('_')[0])
        .filter((prefix): prefix is string => !!prefix && prefix.length > 1)
        .map(prefix => `@${prefix}_`)));
    const localisation = detectLocalisation(root);
    const game = detectGame(root, descriptor, keyDirectories.map(d => d.path));
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
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        workspaceRoot: root,
        workspaceKind,
        projectName,
        game,
        modInfo: descriptor.exists ? {
            name: descriptor.name,
            version: descriptor.version,
            tags: descriptor.tags,
        } : undefined,
        keyDirectories,
        localisation,
        identifiers: {
            namespaces,
            variablePrefixes,
            scriptedTriggers: sampleIds(path.join(root, 'common', 'scripted_triggers'), 30),
            scriptedEffects: sampleIds(path.join(root, 'common', 'scripted_effects'), 30),
            events: sampleEventIds(eventFiles, 25),
            onActions: sampleIds(path.join(root, 'common', 'on_actions'), 15),
            staticModifiers: sampleIds(path.join(root, 'common', 'static_modifiers'), 15),
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
            vanillaCache: detectVanillaCache(root),
        },
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

export function extractCustomRules(existingContent: string | null | undefined): string {
    if (!existingContent) return '';
    const match = existingContent.match(/## Custom Rules\n([\s\S]*)/);
    if (!match) return '';
    const custom = match[1]?.trimEnd() ?? '';
    return custom.includes('<!-- Add your project-specific rules here') ? '' : custom;
}

export function renderProjectRulesMarkdown(profile: ProjectProfile, customRules = ''): string {
    const namespaces = profile.identifiers.namespaces.slice(0, 20);
    const keyDirs = profile.keyDirectories
        .filter(dir => dir.exists)
        .map(dir => `- \`${dir.path}\`${dir.fileCount !== undefined ? ` (${dir.fileCount} files sampled)` : ''}`);
    const lines = [
        `# CWTools Agent Project Rules - ${profile.projectName}`,
        '',
        `> Generated by \`/init\` on ${profile.generatedAt.split('T')[0]}.`,
        `> Machine-readable profile: \`${PROJECT_PROFILE_RELATIVE_PATH.replace(/\\/g, '/')}\`.`,
        '',
        '## Mod Info',
        `- **Workspace Kind**: ${profile.workspaceKind}`,
        `- **Game**: ${profile.game.displayName} (${profile.game.confidence} confidence)`,
        profile.modInfo?.name ? `- **Name**: ${profile.modInfo.name}` : '',
        profile.modInfo?.version ? `- **Version**: ${profile.modInfo.version}` : '',
        profile.modInfo?.tags?.length ? `- **Tags**: ${profile.modInfo.tags.join(', ')}` : '',
        '',
        '## Agent Routing',
        '- Start with `query_project_profile` for project facts and workflow routing.',
        '- Prefer the /init knowledge pack and CWT/indexed tools before raw scans: `query_project_knowledge`, `explore_pdx_project`, `query_cwt_schema`, `get_completion_at`, `query_workspace_index`, `query_localisation_index`, `query_definition_by_name`, `get_pdx_block`.',
        '- Use the recommended workflow when the task matches diagnostics, localisation, event-chain design, rules review, or asset wiring.',
        '',
        '## Project Structure',
        keyDirs.length ? keyDirs.join('\n') : '- No Paradox mod directories detected during `/init`.',
        '',
        '## Known Identifiers',
        namespaces.length ? `### Event Namespaces\n${namespaces.map(ns => `- \`${ns}\``).join('\n')}` : '### Event Namespaces\n- None detected.',
        profile.identifiers.variablePrefixes.length
            ? `\n### Variable Prefixes\n${profile.identifiers.variablePrefixes.map(prefix => `- \`${prefix}\``).join('\n')}`
            : '',
        '',
        '## Agent Guidelines',
        profile.localisation.languages.length
            ? `- Localisation languages: ${profile.localisation.languages.join(', ')}. Use \`write_localisation\` for YML writes.`
            : '- No localisation languages detected; verify target language before creating keys.',
        profile.localisation.encoding !== 'unknown'
            ? `- Localisation encoding: ${profile.localisation.encoding}. Preserve this convention.`
            : '- Localisation encoding unknown; inspect an existing file before writing localisation.',
        namespaces.length ? '- Reuse detected namespaces unless the user explicitly asks for a new namespace.' : '',
        '- Treat CWT/LSP schema as the first legality source. If a CWT rule has semantic comments or docs, prefer those semantics; if it is structural only, confirm usage from vanilla or mature project examples before editing.',
        '- Treat profile facts as routing hints; verify concrete IDs with indexed tools before editing.',
        '',
        '## Mode Cards',
        renderModeCards(profile),
        '',
        '## Custom Rules',
        customRules || '<!-- Add your project-specific rules here. This section survives /init re-runs. -->',
        '',
    ];
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function queryProjectProfile(workspaceRoot: string, args: QueryProjectProfileArgs = {}): QueryProjectProfileResult {
    const profilePath = getProjectProfilePath(workspaceRoot);
    try {
        const profile = readProjectProfile(workspaceRoot);
        if (!profile) {
            return {
                status: 'missing',
                profilePath,
                _hint: 'Run /init to generate .cwtools-ai/project/profile.json, then retry query_project_profile.',
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
    const dirs = profile.keyDirectories.filter(dir => dir.exists).map(dir => dir.path).slice(0, 8).join(', ') || 'none';
    const namespaces = profile.identifiers.namespaces.slice(0, 8).join(', ') || 'none';
    const languages = profile.localisation.languages.join(', ') || 'unknown';
    return [
        `Project: ${profile.projectName}`,
        `Kind: ${profile.workspaceKind}`,
        `Game: ${profile.game.displayName}`,
        `Key dirs: ${dirs}`,
        `Namespaces: ${namespaces}`,
        `Localisation: ${languages} (${profile.localisation.encoding})`,
    ].join('\n');
}

function selectProfileSection(profile: ProjectProfile, section: NonNullable<QueryProjectProfileArgs['section']>): unknown {
    switch (section) {
        case 'routing': return profile.routing;
        case 'directories': return profile.keyDirectories;
        case 'localisation': return profile.localisation;
        case 'identifiers': return profile.identifiers;
        case 'validation': return profile.validation;
        case 'promptCards': return profile.promptCards;
        case 'summary':
        default:
            return {
                workspaceKind: profile.workspaceKind,
                projectName: profile.projectName,
                game: profile.game,
                generatedAt: profile.generatedAt,
                efficiencyHints: profile.efficiencyHints,
            };
    }
}

function buildPromptCards(profile: Omit<ProjectProfile, 'promptCards' | 'efficiencyHints'>): ProjectProfile['promptCards'] {
    const namespaces = profile.identifiers.namespaces.slice(0, 12).join(', ') || 'none detected';
    const languages = profile.localisation.languages.join(', ') || 'unknown';
    const encoding = profile.localisation.encoding;
    const keyDirs = profile.keyDirectories.filter(dir => dir.exists).map(dir => dir.path).slice(0, 10).join(', ') || 'none detected';
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
            '- Inventory common/ directories before designing complex event chains; record selected and rejected subsystem candidates in the blueprint.',
            '- Use vanilla archetypes before inventing event chains or scope flows.',
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
            'Orchestrator mode project card:',
            '- Dispatch sub-agents with plannedFiles when known.',
            '- Put shared IDs, namespaces, and decisions on the blackboard.',
            '- Keep sub-agents on structured read/edit tools; command/git work stays with the main agent.',
        ].join('\n'),
        script: [
            'Script mode project card:',
            '- Use dynamic workflow waves: preflight, read fanout, classify, write batches, verify, summarize.',
            '- Start with project profile, workspace index, diagnostics, scope/rule queries, and asset candidates.',
            '- Dispatch up to 8 concise read-heavy tasks, but keep write waves narrow and always set plannedFiles.',
            '- Use reviewer/diagnostics verification after every write wave before summarizing.',
        ].join('\n'),
    };
}

function renderModeCards(profile: ProjectProfile): string {
    const order: Array<AgentMode | 'asset'> = ['build', 'plan', 'explore', 'review', 'loc_writer', 'asset', 'orchestrator', 'script'];
    return order
        .map(mode => {
            const card = getPromptCardForMode(profile, mode);
            return card ? `### ${mode}\n${card}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function readDescriptor(root: string): { exists: boolean; name?: string; version?: string; tags?: string[] } {
    const descriptorPath = path.join(root, 'descriptor.mod');
    if (!fs.existsSync(descriptorPath)) return { exists: false };
    const content = fs.readFileSync(descriptorPath, 'utf8');
    const name = content.match(/^name\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const version = content.match(/^version\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const tagsBlock = content.match(/^tags\s*=\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
    const tags = Array.from(tagsBlock.matchAll(/"([^"]+)"/g)).map(match => match[1]).filter((tag): tag is string => !!tag);
    return { exists: true, name, version, tags };
}

function detectGame(
    root: string,
    descriptor: { tags?: string[] },
    directoryEvidence: string[],
): ProjectProfile['game'] {
    const evidence: string[] = [];
    const tagText = (descriptor.tags ?? []).join(' ').toLowerCase();
    const rootLower = root.toLowerCase();
    if (tagText.includes('stellaris') || rootLower.includes('stellaris') || fs.existsSync(path.join(root, 'submodules', 'cwtools-stellaris-config'))) {
        evidence.push('stellaris tag/path/config detected');
        return { id: 'stellaris', displayName: 'Stellaris', confidence: 'high', evidence };
    }
    if (directoryEvidence.some(dir => /solar_system|technology|megastructure|pop/i.test(dir))) {
        evidence.push('Stellaris-like directories detected');
        return { id: 'stellaris', displayName: 'Stellaris', confidence: 'medium', evidence };
    }
    if (directoryEvidence.some(dir => ['events', 'common', 'localisation', 'localization'].includes(dir))) {
        evidence.push('Paradox script directories detected');
        return { id: 'paradox', displayName: 'Paradox Script', confidence: 'low', evidence };
    }
    return { id: 'unknown', displayName: 'Unknown', confidence: 'low', evidence: ['No Paradox game marker detected'] };
}

function detectLocalisation(root: string): ProjectProfile['localisation'] {
    const roots = ['localisation', 'localization'].filter(rel => fs.existsSync(path.join(root, rel)));
    const sampleFiles = roots.flatMap(rel => collectFiles(path.join(root, rel), 12, ['.yml']).map(file => toRelative(root, file)));
    const languages = Array.from(new Set(sampleFiles.map(file => {
        const base = path.basename(file);
        const lang = base.match(/(?:\b|_)l_((?:(?!(?:\b|_)l_)[a-z_])+)\.yml$/i)?.[1]
            ?? file.split(/[\\/]/).find(part => /^l?_[a-z_]+$/i.test(part));
        if (!lang) return undefined;
        return lang.startsWith('l_') ? lang : `l_${lang}`;
    }).filter((value): value is string => !!value))).sort();
    return {
        roots,
        languages,
        encoding: detectEncoding(sampleFiles.map(file => path.join(root, file))),
        sampleFiles,
    };
}

function detectEncoding(files: string[]): string {
    let bom = 0;
    let noBom = 0;
    for (const file of files.slice(0, 10)) {
        try {
            const buf = fs.readFileSync(file);
            if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom++;
            else noBom++;
        } catch {
            // Ignore unreadable samples.
        }
    }
    if (bom === 0 && noBom === 0) return 'unknown';
    return bom >= noBom ? 'UTF-8 with BOM' : 'UTF-8 without BOM';
}

function detectVanillaCache(root: string): ProjectProfile['validation']['vanillaCache'] {
    const candidates = [
        path.join(root, '.cwtools-ai'),
        path.join(root, 'submodules', 'cwtools-stellaris-config'),
    ];
    return candidates.some(candidate => fs.existsSync(candidate)) ? 'configured' : 'unknown';
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
            entries = fs.readdirSync(current, { withFileTypes: true });
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

function collectNamespaces(files: string[]): string[] {
    const namespaces = new Set<string>();
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const match of content.matchAll(/^namespace\s*=\s*"?([\w.:-]+)"?/gm)) {
                if (match[1]) namespaces.add(match[1]);
            }
        } catch {
            // Ignore unreadable samples.
        }
    }
    return Array.from(namespaces).sort();
}

function sampleIds(dir: string, maxCount: number): string[] {
    const ids: string[] = [];
    for (const file of collectFiles(dir, 40, ['.txt'])) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const match of content.matchAll(/^([@\w][\w.:-]*)\s*=/gm)) {
                const id = match[1]?.trim();
                if (id && id.length > 2 && !ids.includes(id)) ids.push(id);
                if (ids.length >= maxCount) return ids;
            }
        } catch {
            // Ignore unreadable samples.
        }
    }
    return ids;
}

function sampleEventIds(files: string[], maxCount: number): string[] {
    const ids: string[] = [];
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const match of content.matchAll(/\bid\s*=\s*"?([\w.:-]+)"?/g)) {
                const id = match[1]?.trim();
                if (id && id.includes('.') && !ids.includes(id)) ids.push(id);
                if (ids.length >= maxCount) return ids;
            }
        } catch {
            // Ignore unreadable samples.
        }
    }
    return ids;
}

function toRelative(root: string, file: string): string {
    return path.relative(root, file).replace(/\\/g, '/');
}
