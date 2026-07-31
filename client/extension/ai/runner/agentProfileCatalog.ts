import type {
    AdmissionDecision,
    AgentAuthorization,
    AgentRuntimeDomain,
    AgentSchedulingState,
    AgentToolName,
} from '../types';
import { TOOL_REGISTRY } from '../tools/registry';
import { evaluateEffectiveToolPolicy, matchesToolPattern } from './effectiveToolPolicy';

export interface AgentSummaryPolicy {
    minCharacters: number;
    requiredSections: Array<'summary' | 'changedFiles' | 'verification' | 'unresolved'>;
    retries: number;
}

export interface RuntimeAgentProfile {
    name: string;
    description: string;
    /** Profile-local operating instructions injected after the stable base prompt. */
    instructions?: string;
    domain?: AgentRuntimeDomain;
    authorizationCeiling: AgentAuthorization;
    tools?: string[];
    disallowedTools?: string[];
    subagents?: string[];
    modelPreference?: 'primary' | 'secondary';
    summaryPolicy?: AgentSummaryPolicy;
    override?: boolean;
}

export interface AgentProfileSource {
    id: string;
    priority: number;
    fatal?: boolean;
    load(): Promise<RuntimeAgentProfile[]>;
    watch?(onChange: () => void): { dispose(): void };
}

export interface AgentProfileCatalogSnapshot {
    revision: number;
    profiles: RuntimeAgentProfile[];
    sources: Array<{ id: string; priority: number; profileCount: number; error?: string }>;
}

const AUTHORITY_RANK: Record<AgentAuthorization, number> = {
    read_only: 0,
    plan_write_only: 1,
    workspace_write: 2,
};

const BUILTIN_PROFILES: RuntimeAgentProfile[] = [
    {
        name: 'general-agent',
        description: 'General workspace Agent with progressively disclosed tools.',
        domain: 'general',
        authorizationCeiling: 'workspace_write',
        tools: ['*'],
        subagents: ['utility', 'explore', 'plan', 'review'],
    },
    {
        name: 'paradox-agent',
        description: 'Paradox/CWTools Agent with semantic and workspace capabilities.',
        domain: 'paradox',
        authorizationCeiling: 'workspace_write',
        tools: ['*'],
        subagents: ['build', 'explore', 'plan', 'review', 'loc_writer', 'gui_expert'],
    },
    {
        name: 'explore',
        description: 'Read-only repository and semantic exploration.',
        authorizationCeiling: 'read_only',
        tools: ['select_tools', 'read_file', 'list_directory', 'glob_files', 'grep', 'query_*', 'search_*', 'get_*', 'web_*'],
        disallowedTools: ['write_*', 'edit_file', 'replace_lines', 'run_command', 'git_ops', 'dispatch_agents'],
        summaryPolicy: {
            minCharacters: 160,
            requiredSections: ['summary', 'unresolved'],
            retries: 1,
        },
    },
    {
        name: 'reviewer',
        description: 'Read-only verification and review Agent.',
        authorizationCeiling: 'read_only',
        tools: ['select_tools', 'read_file', 'glob_files', 'grep', 'query_*', 'get_*', 'validate_*', 'compare_*', 'git_ops'],
        disallowedTools: ['write_*', 'edit_file', 'replace_lines', 'dispatch_agents'],
        summaryPolicy: {
            minCharacters: 200,
            requiredSections: ['summary', 'verification', 'unresolved'],
            retries: 1,
        },
    },
    {
        name: 'general-coder',
        description: 'General implementation sub-Agent.',
        domain: 'general',
        authorizationCeiling: 'workspace_write',
        tools: ['*'],
        summaryPolicy: {
            minCharacters: 240,
            requiredSections: ['summary', 'changedFiles', 'verification', 'unresolved'],
            retries: 1,
        },
    },
    {
        name: 'paradox-coder',
        description: 'Paradox implementation sub-Agent.',
        domain: 'paradox',
        authorizationCeiling: 'workspace_write',
        tools: ['*'],
        summaryPolicy: {
            minCharacters: 240,
            requiredSections: ['summary', 'changedFiles', 'verification', 'unresolved'],
            retries: 1,
        },
    },
];

function profileValidationError(profile: RuntimeAgentProfile): string | undefined {
    if (!profile || typeof profile.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(profile.name)) {
        return 'profile name must match [a-zA-Z0-9_.-] and be at most 80 characters';
    }
    if (typeof profile.description !== 'string' || profile.description.trim().length === 0 || profile.description.length > 1_000) {
        return `${profile.name}: description must contain 1-1000 characters`;
    }
    if (profile.instructions !== undefined && (typeof profile.instructions !== 'string' || profile.instructions.length > 32_000)) {
        return `${profile.name}: instructions exceed 32000 characters`;
    }
    if (profile.domain !== undefined && profile.domain !== 'general' && profile.domain !== 'paradox') {
        return `${profile.name}: invalid capability domain`;
    }
    if (AUTHORITY_RANK[profile.authorizationCeiling] === undefined) {
        return `${profile.name}: invalid authorization ceiling`;
    }
    for (const patterns of [profile.tools, profile.disallowedTools]) {
        if (patterns === undefined) continue;
        if (!Array.isArray(patterns) || patterns.length > 256) return `${profile.name}: invalid tool-pattern list`;
        for (const pattern of patterns) {
            if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 120
                || ![...TOOL_REGISTRY.keys()].some(name => matchesToolPattern(name, pattern))) {
                return `${profile.name}: tool pattern "${String(pattern)}" matches no registered tool`;
            }
        }
    }
    if (profile.subagents !== undefined
        && (!Array.isArray(profile.subagents)
            || profile.subagents.length > 32
            || profile.subagents.some(role => typeof role !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(role)))) {
        return `${profile.name}: invalid subagent list`;
    }
    if (profile.modelPreference !== undefined
        && profile.modelPreference !== 'primary'
        && profile.modelPreference !== 'secondary') {
        return `${profile.name}: invalid model preference`;
    }
    if (profile.override !== undefined && typeof profile.override !== 'boolean') {
        return `${profile.name}: override must be boolean`;
    }
    const summary = profile.summaryPolicy;
    if (summary
        && (!Number.isInteger(summary.minCharacters)
            || summary.minCharacters < 0
            || summary.minCharacters > 100_000
            || !Number.isInteger(summary.retries)
            || summary.retries < 0
            || summary.retries > 3
            || !Array.isArray(summary.requiredSections)
            || summary.requiredSections.some(section =>
                section !== 'summary'
                && section !== 'changedFiles'
                && section !== 'verification'
                && section !== 'unresolved'))) {
        return `${profile.name}: invalid summary policy`;
    }
    return undefined;
}

export class AgentProfileCatalog {
    private readonly sources = new Map<string, AgentProfileSource>();
    private readonly sourceProfiles = new Map<string, RuntimeAgentProfile[]>();
    private merged = new Map<string, RuntimeAgentProfile>();
    private readonly listeners = new Set<(sourceId: string) => void>();
    private readonly sourceErrors = new Map<string, string>();
    private readonly watchers = new Map<string, { dispose(): void }>();
    private reloadTimer: NodeJS.Timeout | undefined;
    private revisionValue = 0;
    private reloadQueue: Promise<void> = Promise.resolve();

    constructor(builtins: readonly RuntimeAgentProfile[] = BUILTIN_PROFILES) {
        this.sourceProfiles.set('builtin', builtins.map(profile => ({ ...profile })));
        this.remerge();
    }

    registerSource(source: AgentProfileSource): () => void {
        if (this.sources.has(source.id)) throw new Error(`Agent profile source "${source.id}" is already registered.`);
        this.sources.set(source.id, source);
        if (this.watchers.size > 0) this.watchSource(source);
        return () => {
            this.watchers.get(source.id)?.dispose();
            this.watchers.delete(source.id);
            this.sources.delete(source.id);
            this.sourceProfiles.delete(source.id);
            this.sourceErrors.delete(source.id);
            this.remerge();
        };
    }

    reload(): Promise<void> {
        const current = this.reloadQueue.then(() => this.reloadInternal());
        this.reloadQueue = current.catch(() => {});
        return current;
    }

    private async reloadInternal(): Promise<void> {
        const ordered = [...this.sources.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
        for (const source of ordered) {
            try {
                const loadedProfiles = await source.load();
                const invalid = loadedProfiles
                    .map(profileValidationError)
                    .filter((message): message is string => !!message);
                const profiles = loadedProfiles.filter(profile => !profileValidationError(profile));
                this.sourceProfiles.set(source.id, profiles.map(profile => ({ ...profile })));
                if (invalid.length > 0) {
                    this.sourceErrors.set(source.id, invalid.slice(0, 3).join('; '));
                } else {
                    this.sourceErrors.delete(source.id);
                }
                this.remerge();
                for (const listener of this.listeners) listener(source.id);
            } catch (error) {
                this.sourceErrors.set(source.id, error instanceof Error ? error.message : String(error));
                this.revisionValue += 1;
                for (const listener of this.listeners) listener(source.id);
                if (source.fatal) throw error;
            }
        }
    }

    get(name: string): RuntimeAgentProfile | undefined {
        const profile = this.merged.get(name);
        return profile ? { ...profile } : undefined;
    }

    list(): RuntimeAgentProfile[] {
        return [...this.merged.values()].map(profile => ({ ...profile }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    resolve(admission: AdmissionDecision): RuntimeAgentProfile {
        const readOnly = admission.authorization === 'read_only';
        const name = readOnly
            ? (admission.initialPhase === 'verify' ? 'reviewer' : 'explore')
            : admission.domainProfile === 'paradox' ? 'paradox-agent' : 'general-agent';
        return this.get(name) ?? this.get(admission.domainProfile === 'paradox' ? 'paradox-agent' : 'general-agent')!;
    }

    subscribe(listener: (sourceId: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Start source watchers once. Reloads are debounced and become visible on the next turn. */
    startWatching(): void {
        if (this.watchers.size > 0) return;
        for (const source of this.sources.values()) this.watchSource(source);
    }

    snapshot(): AgentProfileCatalogSnapshot {
        return {
            revision: this.revisionValue,
            profiles: this.list(),
            sources: [...this.sources.values()]
                .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
                .map(source => ({
                    id: source.id,
                    priority: source.priority,
                    profileCount: this.sourceProfiles.get(source.id)?.length ?? 0,
                    error: this.sourceErrors.get(source.id),
                })),
        };
    }

    dispose(): void {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = undefined;
        for (const watcher of this.watchers.values()) watcher.dispose();
        this.watchers.clear();
    }

    private watchSource(source: AgentProfileSource): void {
        if (!source.watch || this.watchers.has(source.id)) return;
        this.watchers.set(source.id, source.watch(() => {
            if (this.reloadTimer) clearTimeout(this.reloadTimer);
            this.reloadTimer = setTimeout(() => {
                this.reloadTimer = undefined;
                void this.reload();
            }, 150);
        }));
    }

    private remerge(): void {
        const merged = new Map<string, RuntimeAgentProfile>();
        for (const profile of this.sourceProfiles.get('builtin') ?? []) merged.set(profile.name, profile);
        const orderedSources = [...this.sources.values()]
            .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
        for (const source of orderedSources) {
            for (const profile of this.sourceProfiles.get(source.id) ?? []) {
                if (merged.has(profile.name) && profile.override !== true) continue;
                const existing = merged.get(profile.name);
                // A profile may narrow a domain-specific built-in but must never
                // turn the user's selected capability domain into another one.
                if (existing?.domain && profile.domain && existing.domain !== profile.domain) {
                    const message = `${profile.name}: override cannot change domain ${existing.domain} to ${profile.domain}`;
                    const current = this.sourceErrors.get(source.id);
                    if (!current?.includes(message)) this.sourceErrors.set(source.id, current ? `${current}; ${message}` : message);
                    continue;
                }
                merged.set(profile.name, profile);
            }
        }
        this.merged = merged;
        this.revisionValue += 1;
    }
}

export interface ToolActivationSnapshot {
    profileName: string;
    registered: string[];
    activated: string[];
    disclosed: string[];
    authorization: AgentAuthorization;
}

export class ToolActivationService {
    private snapshotValue: ToolActivationSnapshot = {
        profileName: 'unbound',
        registered: [],
        activated: [],
        disclosed: [],
        authorization: 'read_only',
    };

    activate(
        profile: RuntimeAgentProfile,
        scheduling: AgentSchedulingState,
        disclosed: readonly string[] = [],
    ): ToolActivationSnapshot {
        const ceiling = AUTHORITY_RANK[profile.authorizationCeiling];
        const authorization = AUTHORITY_RANK[scheduling.authorization] <= ceiling
            ? scheduling.authorization
            : profile.authorizationCeiling;
        const registered: string[] = [...TOOL_REGISTRY.keys()].sort();
        const effectiveMode = scheduling.dispatch !== 'single'
            ? scheduling.domainProfile === 'general' ? 'orchestrator' : 'script'
            : authorization === 'read_only'
                ? scheduling.phase === 'verify' || profile.name === 'reviewer' ? 'review' : 'explore'
                : authorization === 'plan_write_only' || scheduling.phase === 'plan'
                    ? 'plan'
                    : scheduling.domainProfile === 'general' ? 'utility' : 'build';
        const activated: string[] = registered.filter(name =>
            evaluateEffectiveToolPolicy(name, {
                mode: effectiveMode,
                domain: scheduling.domainProfile,
                authorization,
                profile,
            }).allowed);
        this.snapshotValue = {
            profileName: profile.name,
            registered,
            activated,
            disclosed: [...new Set(disclosed.filter(name => activated.includes(name)))].sort(),
            authorization,
        };
        return this.snapshot();
    }

    isActivated(name: AgentToolName | string): boolean {
        return this.snapshotValue.activated.includes(name);
    }

    snapshot(): ToolActivationSnapshot {
        return {
            ...this.snapshotValue,
            registered: [...this.snapshotValue.registered],
            activated: [...this.snapshotValue.activated],
            disclosed: [...this.snapshotValue.disclosed],
        };
    }
}

export const agentProfileCatalog = new AgentProfileCatalog();
