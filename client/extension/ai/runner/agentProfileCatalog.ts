import type {
    AdmissionDecision,
    AgentAuthorization,
    AgentRuntimeDomain,
    AgentSchedulingState,
    AgentToolName,
} from '../types';
import { TOOL_REGISTRY } from '../tools/registry';

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

function matchesPattern(name: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return name === pattern;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(name);
}

function validateProfile(profile: RuntimeAgentProfile): boolean {
    return !!profile
        && typeof profile.name === 'string'
        && profile.name.trim().length > 0
        && typeof profile.description === 'string'
        && AUTHORITY_RANK[profile.authorizationCeiling] !== undefined;
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
                const profiles = (await source.load()).filter(validateProfile);
                this.sourceProfiles.set(source.id, profiles.map(profile => ({ ...profile })));
                this.sourceErrors.delete(source.id);
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
        const allow = profile.tools ?? ['*'];
        const deny = profile.disallowedTools ?? [];
        const activated: string[] = registered.filter(name =>
            allow.some(pattern => matchesPattern(name, pattern))
            && !deny.some(pattern => matchesPattern(name, pattern)));
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
