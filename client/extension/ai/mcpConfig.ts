import * as fs from 'fs';
import * as path from 'path';
import type { MCPServerConfig } from './types';
import { getCwtoolsHomeDir } from './homeConfig';

/**
 * File-based MCP server configuration, aligned with the user-level config
 * conventions of Kimi Code / Claude Code:
 *
 *   user level    ~/.cwtools/mcp.json
 *   project level <workspaceRoot>/.cwtools/mcp.json   (untrusted repo input)
 *
 * File format (Claude style):
 *   { "mcpServers": { "<name>": { "type"?: "stdio"|"sse", "command"?: string,
 *     "args"?: string[], "env"?: Record<string,string>, "url"?: string,
 *     "capabilityDomain"?: "general"|"paradox"|"both" } } }
 *
 * The files are untrusted input: every entry is validated and narrowed at this
 * boundary, invalid entries are skipped with a collected warning, and the
 * loaders never throw.
 */

export type McpServerConfigSource = 'settings' | 'home' | 'project';

/** An MCPServerConfig annotated with the configuration layer it came from. */
export type SourcedMCPServerConfig = MCPServerConfig & { source: McpServerConfigSource };

export interface McpServerFileConfigs {
    home: MCPServerConfig[];
    project: MCPServerConfig[];
    warnings: string[];
    homeFilePath: string;
    projectFilePath?: string;
    /**
     * mtime+size fingerprint of both files. Changes whenever either file is
     * written, so callers can key their own caches on it.
     */
    version: string;
}

const SERVER_NAME_PATTERN = /^[\w.-]{1,64}$/;
const CACHE_LIMIT = 8;

interface FileStamp {
    mtimeMs: number;
    size: number;
}

function statFile(filePath: string): FileStamp | undefined {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
    } catch {
        return undefined;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeArgs(value: unknown, serverLabel: string, warnings: string[]): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        warnings.push(`MCP server '${serverLabel}': 'args' must be an array of strings; field ignored.`);
        return undefined;
    }
    const args: string[] = [];
    let dropped = 0;
    for (const item of value) {
        if (typeof item === 'string') args.push(item);
        else dropped++;
    }
    if (dropped > 0) {
        warnings.push(`MCP server '${serverLabel}': dropped ${dropped} non-string 'args' element(s).`);
    }
    return args;
}

function sanitizeEnv(value: unknown, serverLabel: string, warnings: string[]): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
        warnings.push(`MCP server '${serverLabel}': 'env' must be an object of string values; field ignored.`);
        return undefined;
    }
    const env: Record<string, string> = {};
    let dropped = 0;
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') env[key] = item;
        else dropped++;
    }
    if (dropped > 0) {
        warnings.push(`MCP server '${serverLabel}': dropped ${dropped} non-string 'env' value(s).`);
    }
    return env;
}

function sanitizeServerEntry(
    name: unknown,
    raw: unknown,
    fileLabel: string,
    warnings: string[],
): MCPServerConfig | undefined {
    if (typeof name !== 'string' || !SERVER_NAME_PATTERN.test(name)) {
        warnings.push(`${fileLabel}: skipped server with invalid name ${JSON.stringify(name)} (expected ${SERVER_NAME_PATTERN}).`);
        return undefined;
    }
    if (!isPlainObject(raw)) {
        warnings.push(`${fileLabel}: skipped server '${name}' — entry must be an object.`);
        return undefined;
    }

    // Transport: explicit 'stdio' | 'sse'; when omitted, infer from `url`
    // (Claude-compatible default is stdio).
    let type: 'stdio' | 'sse';
    if (raw.type === undefined) {
        type = typeof raw.url === 'string' ? 'sse' : 'stdio';
    } else if (raw.type === 'stdio' || raw.type === 'sse') {
        type = raw.type;
    } else {
        warnings.push(`${fileLabel}: skipped server '${name}' — 'type' must be 'stdio' or 'sse'.`);
        return undefined;
    }

    const config: MCPServerConfig = { name, type, capabilityDomain: 'both' };

    if (raw.capabilityDomain !== undefined) {
        if (raw.capabilityDomain === 'paradox' || raw.capabilityDomain === 'general' || raw.capabilityDomain === 'both') {
            config.capabilityDomain = raw.capabilityDomain;
        } else {
            warnings.push(`${fileLabel}: server '${name}' has invalid capabilityDomain ${JSON.stringify(raw.capabilityDomain)}; defaulted to 'both'.`);
        }
    }

    if (type === 'stdio') {
        if (typeof raw.command !== 'string' || raw.command.trim() === '') {
            warnings.push(`${fileLabel}: skipped stdio server '${name}' — 'command' (non-empty string) is required.`);
            return undefined;
        }
        config.command = raw.command;
        const args = sanitizeArgs(raw.args, name, warnings);
        if (args !== undefined) config.args = args;
        const env = sanitizeEnv(raw.env, name, warnings);
        if (env !== undefined) config.env = env;
    } else {
        if (typeof raw.url !== 'string' || raw.url.trim() === '') {
            warnings.push(`${fileLabel}: skipped sse server '${name}' — 'url' (string) is required.`);
            return undefined;
        }
        try {
            const parsed = new URL(raw.url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                warnings.push(`${fileLabel}: skipped sse server '${name}' — 'url' must use http/https.`);
                return undefined;
            }
        } catch {
            warnings.push(`${fileLabel}: skipped sse server '${name}' — 'url' is not a valid URL.`);
            return undefined;
        }
        config.url = raw.url;
    }

    return config;
}

function parseMcpServerFile(filePath: string, fileLabel: string, warnings: string[]): MCPServerConfig[] {
    let rawText: string;
    try {
        rawText = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        warnings.push(`${fileLabel}: cannot read ${filePath} (${e instanceof Error ? e.message : String(e)}).`);
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText.replace(/^\uFEFF/, ''));
    } catch (e) {
        warnings.push(`${fileLabel}: invalid JSON in ${filePath} (${e instanceof Error ? e.message : String(e)}).`);
        return [];
    }

    if (!isPlainObject(parsed)) {
        warnings.push(`${fileLabel}: root of ${filePath} must be an object.`);
        return [];
    }
    if (!isPlainObject(parsed.mcpServers)) {
        warnings.push(`${fileLabel}: 'mcpServers' in ${filePath} must be an object.`);
        return [];
    }

    const servers: MCPServerConfig[] = [];
    for (const [name, raw] of Object.entries(parsed.mcpServers)) {
        const entry = sanitizeServerEntry(name, raw, fileLabel, warnings);
        if (entry) servers.push(entry);
    }
    return servers;
}

const fileConfigCache = new Map<string, { version: string; result: McpServerFileConfigs }>();

/**
 * Load and validate the home (`~/.cwtools/mcp.json`) and project
 * (`<workspaceRoot>/.cwtools/mcp.json`) MCP server files. Results are cached
 * per workspace root and invalidated by file mtime+size, so repeat calls cost
 * two `statSync`s.
 */
export function loadMcpServerFileConfigs(workspaceRoot?: string): McpServerFileConfigs {
    const homeFilePath = path.join(getCwtoolsHomeDir(), 'mcp.json');
    const projectFilePath = workspaceRoot ? path.join(workspaceRoot, '.cwtools', 'mcp.json') : undefined;

    const homeStamp = statFile(homeFilePath);
    const projectStamp = projectFilePath ? statFile(projectFilePath) : undefined;
    const version = [
        `${homeFilePath}:${homeStamp ? `${homeStamp.mtimeMs}:${homeStamp.size}` : 'absent'}`,
        `${projectFilePath ?? ''}:${projectStamp ? `${projectStamp.mtimeMs}:${projectStamp.size}` : 'absent'}`,
    ].join('|');

    const cacheKey = workspaceRoot ?? '';
    const cached = fileConfigCache.get(cacheKey);
    if (cached && cached.version === version) return cached.result;

    const warnings: string[] = [];
    const result: McpServerFileConfigs = {
        home: homeStamp ? parseMcpServerFile(homeFilePath, 'user mcp.json', warnings) : [],
        project: projectFilePath && projectStamp ? parseMcpServerFile(projectFilePath, 'project mcp.json', warnings) : [],
        warnings,
        homeFilePath,
        projectFilePath,
        version,
    };

    fileConfigCache.delete(cacheKey);
    fileConfigCache.set(cacheKey, { version, result });
    while (fileConfigCache.size > CACHE_LIMIT) {
        const oldest = fileConfigCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        fileConfigCache.delete(oldest);
    }
    return result;
}

/** Test hook: drop cached file parses so a test can observe fresh reads. */
export function clearMcpServerFileConfigCache(): void {
    fileConfigCache.clear();
}

/**
 * Merge server configs from the three layers. On a name clash the later layer
 * wins wholesale (no field-level merge): settings < home < project. Every
 * result entry is annotated with the layer it came from.
 *
 * Settings entries pass through untouched (they keep their existing
 * capabilityDomain-required semantics); file entries were already validated
 * and defaulted by loadMcpServerFileConfigs.
 */
export function mergeMcpServerConfigs(
    vscodeServers: readonly MCPServerConfig[],
    homeServers: readonly MCPServerConfig[],
    projectServers: readonly MCPServerConfig[],
): SourcedMCPServerConfig[] {
    const merged = new Map<string, SourcedMCPServerConfig>();
    const putAll = (servers: readonly MCPServerConfig[], source: McpServerConfigSource): void => {
        for (const server of servers) {
            if (!server || typeof server.name !== 'string' || server.name === '') continue;
            merged.set(server.name, { ...server, source });
        }
    };
    putAll(vscodeServers, 'settings');
    putAll(homeServers, 'home');
    putAll(projectServers, 'project');
    return [...merged.values()];
}

/** Narrow the source annotation on a merged (or plain) server config. */
export function mcpServerSource(server: MCPServerConfig): McpServerConfigSource {
    const source = (server as SourcedMCPServerConfig).source;
    return source === 'home' || source === 'project' ? source : 'settings';
}
