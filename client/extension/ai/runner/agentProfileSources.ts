import * as fs from 'fs';
import * as path from 'path';
import type { AgentAuthorization, AgentRuntimeDomain } from '../types';
import type { AgentProfileSource, RuntimeAgentProfile } from './agentProfileCatalog';

const AUTHORIZATIONS = new Set<AgentAuthorization>(['read_only', 'plan_write_only', 'workspace_write']);
const DOMAINS = new Set<AgentRuntimeDomain>(['general', 'paradox']);

function scalar(value: string): string | boolean | number {
    const trimmed = value.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed.replace(/^['"]|['"]$/g, '');
}

function list(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed.slice(1, -1).split(',').map(item => String(scalar(item))).filter(Boolean);
    }
    return trimmed.split(',').map(item => String(scalar(item))).filter(Boolean);
}

function parseAgentMarkdown(content: string, fallbackName: string): RuntimeAgentProfile | undefined {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(content);
    if (!match) return undefined;
    const frontmatter = new Map<string, string>();
    const frontmatterLists = new Map<string, string[]>();
    let activeList: string | undefined;
    for (const line of match[1]!.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (/^\s*-\s+/.test(line) && activeList) {
            frontmatterLists.get(activeList)!.push(String(scalar(line.replace(/^\s*-\s+/, ''))));
            continue;
        }
        if (separator <= 0) {
            activeList = undefined;
            continue;
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        frontmatter.set(key, value);
        activeList = value ? undefined : key;
        if (activeList) frontmatterLists.set(activeList, []);
    }
    const readList = (key: string): string[] | undefined =>
        frontmatterLists.get(key) ?? (frontmatter.has(key) ? list(frontmatter.get(key)!) : undefined);
    const authorization = String(scalar(frontmatter.get('authorization') ?? 'read_only')) as AgentAuthorization;
    const domainValue = frontmatter.get('domain');
    const domain = domainValue ? String(scalar(domainValue)) as AgentRuntimeDomain : undefined;
    if (!AUTHORIZATIONS.has(authorization) || (domain !== undefined && !DOMAINS.has(domain))) return undefined;
    return {
        name: String(scalar(frontmatter.get('name') ?? fallbackName)),
        description: String(scalar(frontmatter.get('description') ?? match[2]!.trim().slice(0, 500) ?? fallbackName)),
        instructions: match[2]!.trim().slice(0, 32_000) || undefined,
        domain,
        authorizationCeiling: authorization,
        tools: readList('tools'),
        disallowedTools: readList('disallowedTools'),
        subagents: readList('subagents'),
        modelPreference: frontmatter.get('modelPreference') === 'secondary' ? 'secondary' : 'primary',
        override: scalar(frontmatter.get('override') ?? 'false') === true,
        summaryPolicy: frontmatter.has('summaryMinCharacters') ? {
            minCharacters: Math.max(0, Number(scalar(frontmatter.get('summaryMinCharacters')!)) || 0),
            requiredSections: (readList('summaryRequiredSections') ?? [])
                .filter((value): value is 'summary' | 'changedFiles' | 'verification' | 'unresolved' =>
                    value === 'summary' || value === 'changedFiles' || value === 'verification' || value === 'unresolved'),
            retries: Math.max(0, Math.min(3, Number(scalar(frontmatter.get('summaryRetries') ?? '1')) || 0)),
        } : undefined,
    };
}

/** File-backed profile source. Each direct child AGENT.md is one isolated profile. */
export function createDirectoryAgentProfileSource(
    id: string,
    directory: string,
    priority: number,
): AgentProfileSource {
    return {
        id,
        priority,
        async load() {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(directory, { withFileTypes: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw error;
            }
            const files = entries
                .filter(entry => entry.isDirectory() || (entry.isFile() && /^agent(?:\.[^.]+)?\.md$/i.test(entry.name)))
                .map(entry => entry.isDirectory()
                    ? path.join(directory, entry.name, 'AGENT.md')
                    : path.join(directory, entry.name))
                .sort((a, b) => a.localeCompare(b));
            const profiles: RuntimeAgentProfile[] = [];
            for (const file of files) {
                try {
                    const parsed = parseAgentMarkdown(
                        await fs.promises.readFile(file, 'utf8'),
                        path.basename(path.dirname(file)),
                    );
                    if (parsed) profiles.push(parsed);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            return profiles;
        },
        watch(onChange) {
            let watcher: fs.FSWatcher | undefined;
            let watchRoot = directory;
            while (!fs.existsSync(watchRoot) && path.dirname(watchRoot) !== watchRoot) {
                watchRoot = path.dirname(watchRoot);
            }
            try {
                watcher = fs.watch(watchRoot, { recursive: true }, (_event, filename) => {
                    const changedPath = filename ? path.resolve(watchRoot, String(filename)) : watchRoot;
                    if (changedPath.startsWith(path.resolve(directory))
                        || path.resolve(directory).startsWith(changedPath)) onChange();
                });
            } catch {
                try {
                    watcher = fs.watch(watchRoot, () => onChange());
                } catch {
                    // A missing optional profile root is retried on the next explicit catalog reload.
                }
            }
            watcher?.unref();
            return { dispose: () => watcher?.close() };
        },
    };
}
