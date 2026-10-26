import * as fs from 'fs';
import * as path from 'path';
import type { AIProviderConfig, CustomApiFormat } from './types';
import { BUILTIN_PROVIDERS } from './providers/models/defaults';
import { getCwtoolsHomeDir } from './homeConfig';
import { migrateKimiModelId } from './kimi/modelMigration';

/**
 * User-level provider routes and sub-agent model assignments, aligned with the
 * user-level config conventions of Kimi Code / Claude Code:
 *
 *   ~/.cwtools/providers.json    — extra provider routes (endpoint + models)
 *   ~/.cwtools/agent-models.json — per-profile sub-agent model assignments
 *
 * File formats:
 *   { "providers": { "<id>": { "name"?: string, "endpoint": string,
 *     "models": string[], "defaultModel"?: string,
 *     "apiFormat"?: CustomApiFormat, "apiKeyEnv"?: string,
 *     "requiresApiKey"?: boolean, "supportsVision"?: boolean,
 *     "maxContextTokens"?: number } } }
 *   { "agentModels": { "<role>": { "provider": string, "model": string } } }
 *
 * The files are untrusted input: every entry is validated and narrowed at this
 * boundary, invalid entries are skipped with a collected warning, and the
 * loaders never throw. `apiKeyEnv` names an environment variable; the key
 * itself is never stored in the file.
 *
 * Like mcpConfig.ts this module stays free of the `vscode` import so unit
 * tests can load it directly.
 */

export type HomeProviderConfig = AIProviderConfig & { source: 'home'; apiKeyEnv?: string };

export interface HomeProviderFileConfigs {
    providers: Record<string, HomeProviderConfig>;
    warnings: string[];
    filePath: string;
    /** mtime+size fingerprint; changes whenever the file is written. */
    version: string;
}

export interface HomeAgentModelFileConfigs {
    agentModels: Record<string, { provider: string; model: string }>;
    warnings: string[];
    filePath: string;
    version: string;
}

export type AgentModelSource = 'settings' | 'home';

/** A per-role model assignment annotated with the configuration layer it came from. */
export type SourcedAgentModelAssignment = { provider: string; model: string; source: AgentModelSource };

const PROVIDER_ID_PATTERN = /^[\w.-]{1,64}$/;
const ROLE_NAME_PATTERN = /^[\w.-]{1,64}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const API_FORMATS: readonly CustomApiFormat[] = [
    'openai-chat-completions',
    'openai-responses',
    'anthropic-messages',
    'gemini-generate-content',
];
const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
const MAX_CONTEXT_TOKENS_CEILING = 16_000_000;

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

function readJsonFile(filePath: string, fileLabel: string, warnings: string[]): Record<string, unknown> | undefined {
    let rawText: string;
    try {
        rawText = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        warnings.push(`${fileLabel}: cannot read ${filePath} (${e instanceof Error ? e.message : String(e)}).`);
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText.replace(/^\uFEFF/, ''));
    } catch (e) {
        warnings.push(`${fileLabel}: invalid JSON in ${filePath} (${e instanceof Error ? e.message : String(e)}).`);
        return undefined;
    }
    if (!isPlainObject(parsed)) {
        warnings.push(`${fileLabel}: root of ${filePath} must be an object.`);
        return undefined;
    }
    return parsed;
}

// ─── providers.json ──────────────────────────────────────────────────────────

function sanitizeModels(value: unknown, id: string, fileLabel: string, warnings: string[]): string[] | undefined {
    if (!Array.isArray(value)) {
        warnings.push(`${fileLabel}: skipped provider '${id}' — 'models' must be an array of strings.`);
        return undefined;
    }
    const models: string[] = [];
    let dropped = 0;
    for (const item of value) {
        if (typeof item === 'string' && item.trim()) models.push(item.trim());
        else dropped++;
    }
    if (dropped > 0) {
        warnings.push(`${fileLabel}: provider '${id}': dropped ${dropped} non-string 'models' element(s).`);
    }
    return models;
}

function sanitizeProviderEntry(
    id: unknown,
    raw: unknown,
    fileLabel: string,
    warnings: string[],
): HomeProviderConfig | undefined {
    if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
        warnings.push(`${fileLabel}: skipped provider with invalid id ${JSON.stringify(id)} (expected ${PROVIDER_ID_PATTERN}).`);
        return undefined;
    }
    // Home entries extend the route table; they never redefine a built-in line.
    if (id in BUILTIN_PROVIDERS) {
        warnings.push(`${fileLabel}: skipped provider '${id}' — id collides with a built-in provider; home entries cannot override built-ins.`);
        return undefined;
    }
    if (!isPlainObject(raw)) {
        warnings.push(`${fileLabel}: skipped provider '${id}' — entry must be an object.`);
        return undefined;
    }

    if (typeof raw.endpoint !== 'string' || raw.endpoint.trim() === '') {
        warnings.push(`${fileLabel}: skipped provider '${id}' — 'endpoint' (non-empty string) is required.`);
        return undefined;
    }
    const endpoint = raw.endpoint.trim().replace(/\/+$/, '');
    try {
        const parsed = new URL(endpoint);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            warnings.push(`${fileLabel}: skipped provider '${id}' — 'endpoint' must use http/https.`);
            return undefined;
        }
    } catch {
        warnings.push(`${fileLabel}: skipped provider '${id}' — 'endpoint' is not a valid URL.`);
        return undefined;
    }

    const models = sanitizeModels(raw.models, id, fileLabel, warnings);
    if (models === undefined) return undefined;

    let apiFormat: CustomApiFormat = 'openai-chat-completions';
    if (raw.apiFormat !== undefined) {
        if (typeof raw.apiFormat === 'string' && (API_FORMATS as readonly string[]).includes(raw.apiFormat)) {
            apiFormat = raw.apiFormat as CustomApiFormat;
        } else {
            warnings.push(`${fileLabel}: provider '${id}' has invalid apiFormat ${JSON.stringify(raw.apiFormat)}; defaulted to 'openai-chat-completions'.`);
        }
    }

    let apiKeyEnv: string | undefined;
    if (raw.apiKeyEnv !== undefined) {
        if (typeof raw.apiKeyEnv === 'string' && ENV_NAME_PATTERN.test(raw.apiKeyEnv)) {
            apiKeyEnv = raw.apiKeyEnv;
        } else {
            warnings.push(`${fileLabel}: provider '${id}' has invalid apiKeyEnv ${JSON.stringify(raw.apiKeyEnv)} (expected ${ENV_NAME_PATTERN}); field ignored.`);
        }
    }

    let requiresApiKey = true;
    if (raw.requiresApiKey !== undefined) {
        if (typeof raw.requiresApiKey === 'boolean') requiresApiKey = raw.requiresApiKey;
        else warnings.push(`${fileLabel}: provider '${id}' has non-boolean requiresApiKey; defaulted to true.`);
    }

    let supportsVision = false;
    if (raw.supportsVision !== undefined) {
        if (typeof raw.supportsVision === 'boolean') supportsVision = raw.supportsVision;
        else warnings.push(`${fileLabel}: provider '${id}' has non-boolean supportsVision; defaulted to false.`);
    }

    let maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS;
    if (raw.maxContextTokens !== undefined) {
        if (typeof raw.maxContextTokens === 'number' && Number.isFinite(raw.maxContextTokens)
            && raw.maxContextTokens > 0 && raw.maxContextTokens <= MAX_CONTEXT_TOKENS_CEILING) {
            maxContextTokens = Math.floor(raw.maxContextTokens);
        } else {
            warnings.push(`${fileLabel}: provider '${id}' has invalid maxContextTokens ${JSON.stringify(raw.maxContextTokens)}; defaulted to ${DEFAULT_MAX_CONTEXT_TOKENS}.`);
        }
    }

    const defaultModel = typeof raw.defaultModel === 'string' && raw.defaultModel.trim()
        ? raw.defaultModel.trim()
        : (models[0] ?? '');
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
    // anthropic-messages / gemini-generate-content are not OpenAI-shaped wires;
    // mirror the built-in claude/antigravity entries for those formats.
    const openAiWire = apiFormat === 'openai-chat-completions' || apiFormat === 'openai-responses';

    const config: HomeProviderConfig = {
        id,
        name,
        endpoint,
        defaultModel,
        models,
        supportsToolUse: true,
        requiresApiKey,
        supportsStreaming: true,
        maxContextTokens,
        isOpenAICompatible: openAiWire,
        toolCallStyle: 'openai',
        supportsFIM: false,
        supportsVision,
        apiFormatHint: apiFormat,
        source: 'home',
    };
    if (apiKeyEnv !== undefined) config.apiKeyEnv = apiKeyEnv;
    return config;
}

let providerFileCache: { version: string; result: HomeProviderFileConfigs } | undefined;

/**
 * Load and validate `~/.cwtools/providers.json`. The result is cached and
 * invalidated by file mtime+size, so repeat calls cost one `statSync`.
 */
export function loadHomeProviderConfigs(): HomeProviderFileConfigs {
    const filePath = path.join(getCwtoolsHomeDir(), 'providers.json');
    const stamp = statFile(filePath);
    const version = `${filePath}:${stamp ? `${stamp.mtimeMs}:${stamp.size}` : 'absent'}`;
    if (providerFileCache && providerFileCache.version === version) return providerFileCache.result;

    const warnings: string[] = [];
    const providers: Record<string, HomeProviderConfig> = {};
    if (stamp) {
        const root = readJsonFile(filePath, 'user providers.json', warnings);
        if (root !== undefined) {
            if (!isPlainObject(root.providers)) {
                warnings.push(`user providers.json: 'providers' in ${filePath} must be an object.`);
            } else {
                for (const [id, raw] of Object.entries(root.providers)) {
                    const entry = sanitizeProviderEntry(id, raw, 'user providers.json', warnings);
                    if (entry) providers[entry.id] = entry;
                }
            }
        }
    }

    const result: HomeProviderFileConfigs = { providers, warnings, filePath, version };
    providerFileCache = { version, result };
    return result;
}

/** All valid home providers, keyed by id. Empty when the file is absent or invalid. */
export function getHomeProviders(): Record<string, HomeProviderConfig> {
    return loadHomeProviderConfigs().providers;
}

/** Whether the id names a provider declared in ~/.cwtools/providers.json. */
export function isHomeProviderId(id: string): boolean {
    return id in getHomeProviders();
}

/**
 * The file-declared endpoint for a home provider, or '' for built-ins. Home
 * endpoints live in the file; the per-provider `providerEndpoints` settings
 * map never carries them.
 */
export function getHomeProviderEndpoint(id: string): string {
    return getHomeProviders()[id]?.endpoint ?? '';
}

/** The environment variable a home provider names as its credential source. */
export function getHomeProviderApiKeyEnv(id: string): string | undefined {
    return getHomeProviders()[id]?.apiKeyEnv;
}

// ─── agent-models.json ───────────────────────────────────────────────────────

function sanitizeAgentModelEntry(
    role: unknown,
    raw: unknown,
    fileLabel: string,
    warnings: string[],
): { role: string; provider: string; model: string } | undefined {
    if (typeof role !== 'string' || !ROLE_NAME_PATTERN.test(role)) {
        warnings.push(`${fileLabel}: skipped agent model with invalid role ${JSON.stringify(role)} (expected ${ROLE_NAME_PATTERN}).`);
        return undefined;
    }
    if (!isPlainObject(raw)) {
        warnings.push(`${fileLabel}: skipped agent model '${role}' — entry must be an object.`);
        return undefined;
    }
    if (typeof raw.provider !== 'string' || raw.provider.trim() === '' || raw.provider.trim().length > 64) {
        warnings.push(`${fileLabel}: skipped agent model '${role}' — 'provider' must be a non-empty provider id of at most 64 characters.`);
        return undefined;
    }
    if (typeof raw.model !== 'string' || raw.model.trim() === '' || raw.model.trim().length > 120) {
        warnings.push(`${fileLabel}: skipped agent model '${role}' — 'model' must be a non-empty model id of at most 120 characters.`);
        return undefined;
    }
    const provider = raw.provider.trim();
    const model = raw.model.trim();
    // '__inherit__' is a UI sentinel; a file entry must name concrete values.
    if (provider === '__inherit__' || model === '__inherit__') {
        warnings.push(`${fileLabel}: skipped agent model '${role}' — '__inherit__' is not meaningful in a file; omit the role instead.`);
        return undefined;
    }
    if (!(provider in BUILTIN_PROVIDERS) && !(provider in getHomeProviders())) {
        warnings.push(`${fileLabel}: agent model '${role}' references unknown provider '${provider}' (not built-in, not in providers.json).`);
    }
    return { role, provider, model };
}

let agentModelFileCache: { version: string; result: HomeAgentModelFileConfigs } | undefined;

/**
 * Load and validate `~/.cwtools/agent-models.json`. Cached by file mtime+size,
 * so repeat calls cost one `statSync`.
 */
export function loadHomeAgentModelOverrides(): HomeAgentModelFileConfigs {
    const filePath = path.join(getCwtoolsHomeDir(), 'agent-models.json');
    const stamp = statFile(filePath);
    const version = `${filePath}:${stamp ? `${stamp.mtimeMs}:${stamp.size}` : 'absent'}`;
    if (agentModelFileCache && agentModelFileCache.version === version) return agentModelFileCache.result;

    const warnings: string[] = [];
    const agentModels: Record<string, { provider: string; model: string }> = {};
    if (stamp) {
        const root = readJsonFile(filePath, 'user agent-models.json', warnings);
        if (root !== undefined) {
            if (!isPlainObject(root.agentModels)) {
                warnings.push(`user agent-models.json: 'agentModels' in ${filePath} must be an object.`);
            } else {
                for (const [role, raw] of Object.entries(root.agentModels)) {
                    const entry = sanitizeAgentModelEntry(role, raw, 'user agent-models.json', warnings);
                    if (entry) agentModels[entry.role] = { provider: entry.provider, model: entry.model };
                }
            }
        }
    }

    const result: HomeAgentModelFileConfigs = { agentModels, warnings, filePath, version };
    agentModelFileCache = { version, result };
    return result;
}

/**
 * Merge per-role model assignments: VS Code settings is the base layer, the
 * home file overrides same-named roles wholesale (settings < home), mirroring
 * mergeMcpServerConfigs. Every entry is annotated with its source layer.
 */
export function mergeAgentModelOverrides(
    settingsModels: Record<string, { provider: string; model: string }> | undefined,
    homeModels: Record<string, { provider: string; model: string }>,
): Record<string, SourcedAgentModelAssignment> {
    const merged: Record<string, SourcedAgentModelAssignment> = {};
    if (settingsModels) {
        for (const [role, value] of Object.entries(settingsModels)) {
            if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') continue;
            merged[role] = { provider: value.provider, model: value.model, source: 'settings' };
        }
    }
    for (const [role, value] of Object.entries(homeModels)) {
        merged[role] = { provider: value.provider, model: value.model, source: 'home' };
    }
    return merged;
}

/**
 * Effective sub-agent model assignments: the VS Code
 * `orchestrator.agentModels` setting overridden by `~/.cwtools/agent-models.json`.
 * Returns undefined when neither layer assigns any role.
 */
export function getAgentModelOverrides(
    settingsModels: Record<string, { provider: string; model: string }> | undefined,
): Record<string, SourcedAgentModelAssignment> | undefined {
    const merged = mergeAgentModelOverrides(settingsModels, loadHomeAgentModelOverrides().agentModels);
    // A retired Kimi id can survive in either layer. The assignment is migrated on the way
    // out — a pure substitution with no write-back — so the orchestrator never dispatches a
    // model the service no longer serves, and neither file nor the settings are touched.
    for (const [role, assignment] of Object.entries(merged)) {
        const model = migrateKimiModelId(assignment.provider, assignment.model);
        if (model !== assignment.model) merged[role] = { ...assignment, model };
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Test hook: drop cached file parses so a test can observe fresh reads. */
export function clearProviderConfigCache(): void {
    providerFileCache = undefined;
    agentModelFileCache = undefined;
}
