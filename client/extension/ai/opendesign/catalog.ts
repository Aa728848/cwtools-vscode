/**
 * OpenDesign 模型目录解析、在线发现与推理能力映射。
 *
 * 元数据优先级（字段级合并）：
 * - 在线列表（AMR 控制面 `/api/v1/models` > 网关 `/v1/models`）补齐窗口、模态与新上架模型；
 * - 内置 41 条公开价目与能力表 `OPENDESIGN_MODEL_CATALOG` 提供稳定展示名、思考档位与上下文下界；
 * - 兜底使用 `OPENDESIGN_DEFAULT_CONTEXT_WINDOW`（128k）与 `OPENDESIGN_DEFAULT_EFFORTS`（low/medium/high）。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { ModelReasoningCapability, ReasoningEffort } from '../types';
import {
    OPENDESIGN_AMR_API_BASE,
    OPENDESIGN_CATALOG_CACHE_TTL_MS,
    OPENDESIGN_DEFAULT_BASE_URL,
    OPENDESIGN_DEFAULT_CONTEXT_WINDOW,
    OPENDESIGN_DEFAULT_EFFORTS,
    OPENDESIGN_DEFAULT_MAX_TOKENS,
    OPENDESIGN_DEFAULT_MODELS,
    OPENDESIGN_DISCOVERY_TIMEOUT_MS,
    OPENDESIGN_MODEL_CATALOG,
    openDesignCatalogEntry,
    type OpenDesignCatalogModel,
    type OpenDesignDiscoveredModel,
    type OpenDesignModelInfo,
} from './types';

export type { OpenDesignCatalogModel, OpenDesignModelInfo };

const MAX_CATALOG_CACHE_ENTRIES = 20;
const SEAM_MODALITIES = new Set(['text', 'image']);
const VALID_REASONING_EFFORTS = new Set<ReasoningEffort>([
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

interface CachedOpenDesignCatalog {
    models: OpenDesignCatalogModel[];
    fetchedAt: number;
}

const catalogCache = new Map<string, CachedOpenDesignCatalog>();

function cacheKeyOf(endpoint: string, identity: string): string {
    return `${endpoint.trim().replace(/\/+$/, '')}\u0000${identity}`;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return undefined;
}

function pickPositiveInteger(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
        if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
            const parsed = Number(value.trim());
            if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
        }
    }
    return undefined;
}

function pickStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
    for (const key of keys) {
        const value = record[key];
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
            return (value as string[]).map(item => item.trim()).filter(Boolean);
        }
    }
    return undefined;
}

/** 归一化模型 id（去掉 `vela/` / `public_model_` 前缀与分隔符）用于对齐 AMR 与网关 id 拼写差异。 */
export function canonicalOpenDesignModelKey(id: string): string {
    const withoutPrefix = id.trim().replace(/^vela\//i, '').replace(/^public_model_/i, '');
    return withoutPrefix.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function catalogEntryOf(raw: unknown): { id: string; meta: OpenDesignDiscoveredModel } | undefined {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') return undefined;
    const metadata = isRecord(raw.metadata) ? raw.metadata : {};
    const limit = isRecord(raw.limit) ? raw.limit : {};
    const modalities = isRecord(raw.modalities) ? raw.modalities : {};
    const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
    const meta: OpenDesignDiscoveredModel = {};

    const name = pickString(raw, ['name', 'display_name', 'displayName', 'label']);
    if (name !== undefined) meta.name = name;

    const contextWindow = pickPositiveInteger(raw, [
        'context_window', 'contextWindow', 'contextWindowTokens', 'context_window_tokens', 'contextLength', 'context_length',
    ])
        ?? pickPositiveInteger(metadata, ['contextWindowTokens', 'context_window_tokens', 'contextLength', 'context_length'])
        ?? pickPositiveInteger(limit, ['context']);
    if (contextWindow !== undefined) meta.contextWindow = contextWindow;

    const maxTokens = pickPositiveInteger(raw, [
        'max_tokens', 'maxTokens', 'max_output_tokens', 'maxOutputTokens', 'max_completion_tokens', 'maxCompletionTokens',
    ])
        ?? pickPositiveInteger(metadata, ['maxOutputTokens', 'max_output_tokens', 'maxTokens'])
        ?? pickPositiveInteger(limit, ['output']);
    if (maxTokens !== undefined) meta.maxTokens = maxTokens;

    const input = pickStringArray(raw, ['inputModalities', 'input_modalities'])
        ?? pickStringArray(modalities, ['input'])
        ?? pickStringArray(capabilities, ['input'])
        ?? pickStringArray(raw, ['input']);
    if (input !== undefined && input.length > 0) meta.input = input;
    if (meta.input === undefined
        && (raw.supportsVision === true || raw.supports_vision === true || raw.vision === true)) {
        meta.input = ['text', 'image'];
    }

    const efforts = pickStringArray(raw, ['efforts', 'reasoningEfforts', 'reasoning_efforts', 'reasoningLevels'])
        ?? pickStringArray(metadata, ['efforts', 'reasoningEfforts', 'reasoning_efforts']);
    if (efforts !== undefined && efforts.length > 0) meta.efforts = efforts;
    if (typeof raw.reasoning === 'boolean') meta.reasoning = raw.reasoning;
    else if (raw.supports_reasoning === false || raw.supportsReasoning === false) meta.reasoning = false;
    return { id: raw.id.trim(), meta };
}

/** 解析网关或控制面 `/models` 列表。 */
export function parseOpenDesignModelsPayload(
    payload: unknown,
    knownIds: readonly string[] = OPENDESIGN_DEFAULT_MODELS,
): { ids: string[]; catalog: Record<string, OpenDesignDiscoveredModel> } {
    const byKey = new Map(knownIds.map(id => [canonicalOpenDesignModelKey(id), id]));
    const rows = isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload) ? payload : [];
    const ids: string[] = [];
    const catalog: Record<string, OpenDesignDiscoveredModel> = {};
    for (const row of rows) {
        const entry = catalogEntryOf(row);
        if (entry === undefined) continue;
        const id = byKey.get(canonicalOpenDesignModelKey(entry.id)) ?? entry.id;
        if (!ids.includes(id)) ids.push(id);
        if (Object.keys(entry.meta).length > 0) {
            catalog[id] = { ...(catalog[id] ?? {}), ...entry.meta };
        }
    }
    return { ids, catalog };
}

/** 从网关 `/models` 拉取当前 Key 可见模型（可选同时结合控制面 `/models` 丰富上下文窗口）。 */
export async function fetchOpenDesignCatalog(options: {
    runtimeKey: string;
    controlKey?: string;
    baseUrl?: string;
    amrApiBase?: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    identity?: string;
    forceRefresh?: boolean;
}): Promise<OpenDesignCatalogModel[]> {
    const fetchFn = options.fetchFn ?? fetch;
    const baseUrl = (options.baseUrl ?? OPENDESIGN_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    const amrBase = (options.amrApiBase ?? OPENDESIGN_AMR_API_BASE).trim().replace(/\/+$/, '');
    const key = cacheKeyOf(baseUrl, options.identity ?? options.runtimeKey.slice(0, 12));

    const cached = catalogCache.get(key);
    if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < OPENDESIGN_CATALOG_CACHE_TTL_MS) {
        return cached.models;
    }

    const withSignal = (timeoutMs: number): AbortSignal =>
        options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

    let gatewayParsed: { ids: string[]; catalog: Record<string, OpenDesignDiscoveredModel> } | undefined;
    try {
        const response = await fetchFn(`${baseUrl}/models`, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${options.runtimeKey}` },
            signal: withSignal(OPENDESIGN_DISCOVERY_TIMEOUT_MS),
        });
        if (response.ok) {
            const json: unknown = await response.json().catch(() => undefined);
            gatewayParsed = parseOpenDesignModelsPayload(json);
        }
    } catch {
        // 网关探测失败不抛错，允许控制面或本地兜底接管。
    }

    let controlParsed: { ids: string[]; catalog: Record<string, OpenDesignDiscoveredModel> } | undefined;
    if (options.controlKey) {
        try {
            const response = await fetchFn(`${amrBase}/models`, {
                headers: { Accept: 'application/json', Authorization: `Bearer ${options.controlKey}` },
                signal: withSignal(OPENDESIGN_DISCOVERY_TIMEOUT_MS),
            });
            if (response.ok) {
                const json: unknown = await response.json().catch(() => undefined);
                controlParsed = parseOpenDesignModelsPayload(json);
            }
        } catch {
            // 控制面目录不可达不影响正常对话与列表。
        }
    }

    const combinedIds = new Set<string>(gatewayParsed?.ids ?? controlParsed?.ids ?? []);
    if (combinedIds.size === 0) {
        return cached?.models ?? [];
    }

    const merged: OpenDesignCatalogModel[] = [];
    for (const id of combinedIds) {
        merged.push({
            id,
            ...(controlParsed?.catalog[id] ?? {}),
            ...(gatewayParsed?.catalog[id] ?? {}),
        });
    }

    if (catalogCache.has(key)) catalogCache.delete(key);
    catalogCache.set(key, { models: merged, fetchedAt: Date.now() });
    if (catalogCache.size > MAX_CATALOG_CACHE_ENTRIES) {
        const oldest = catalogCache.keys().next().value;
        if (oldest !== undefined) catalogCache.delete(oldest);
    }
    return merged;
}

/** 读取最近缓存过的发现目录（不触发网络）。 */
export function getCachedOpenDesignModels(): OpenDesignCatalogModel[] {
    let latest: CachedOpenDesignCatalog | undefined;
    for (const entry of catalogCache.values()) {
        if (!latest || entry.fetchedAt > latest.fetchedAt) latest = entry;
    }
    return latest?.models ?? [];
}

/** 仅限单元测试清理目录缓存。 */
export function clearOpenDesignCatalogCache(): void {
    catalogCache.clear();
}

export function resolveOpenDesignOutputBudget(
    budget: number | undefined,
    ceiling: number | undefined,
    contextWindow: number,
): number {
    const wanted = Number.isFinite(budget) && (budget ?? 0) > 0 ? budget : undefined;
    const most = Number.isFinite(ceiling) && (ceiling ?? 0) > 0 ? ceiling : undefined;
    const chosen = wanted === undefined ? most : most === undefined ? wanted : Math.min(wanted, most);
    const resolved = chosen ?? OPENDESIGN_DEFAULT_MAX_TOKENS;
    const half = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow / 2) : undefined;
    return half === undefined ? resolved : Math.min(resolved, half);
}

/** 合并本地公开表与最近发现目录，产出单个模型的完整描述。 */
export function resolveOpenDesignModelInfo(
    model: string,
    synced: readonly OpenDesignCatalogModel[] = getCachedOpenDesignModels(),
): OpenDesignModelInfo {
    const entry = synced.find(item => item.id === model);
    const shipped = openDesignCatalogEntry(model);
    const contextWindow = entry?.contextWindow ?? shipped?.contextWindow ?? OPENDESIGN_DEFAULT_CONTEXT_WINDOW;
    const maxTokens = resolveOpenDesignOutputBudget(OPENDESIGN_DEFAULT_MAX_TOKENS, entry?.maxTokens ?? shipped?.maxTokens, contextWindow);
    const reasoning = entry?.reasoning ?? shipped?.reasoning ?? true;
    const publishedEfforts = Array.isArray(entry?.efforts) && entry.efforts.length > 0 ? entry.efforts : undefined;
    const efforts = publishedEfforts
        ?? (shipped?.efforts !== undefined && shipped.efforts.length > 0 ? [...shipped.efforts] : OPENDESIGN_DEFAULT_EFFORTS);
    const defaultEffort = reasoning && shipped?.defaultEffort && efforts.includes(shipped.defaultEffort)
        ? shipped.defaultEffort
        : undefined;
    const declaredInput = Array.isArray(entry?.input) && entry.input.length > 0
        ? entry.input
        : (shipped?.input ?? ['text']);
    const input = declaredInput.filter(item => SEAM_MODALITIES.has(item));

    return {
        id: model,
        displayName: entry?.name?.trim() || shipped?.name || model,
        contextWindow,
        maxTokens,
        reasoning,
        efforts: reasoning ? efforts : [],
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        input: input.length > 0 ? input : ['text'],
        ...(shipped?.pricing === undefined ? {} : { pricing: shipped.pricing }),
    };
}

/** 将 OpenDesign 模型能力映射到扩展统一的 `ModelReasoningCapability`。 */
export function openDesignReasoningCapability(
    model: string,
    synced: readonly OpenDesignCatalogModel[] = getCachedOpenDesignModels(),
): ModelReasoningCapability {
    const info = resolveOpenDesignModelInfo(model, synced);
    if (!info.reasoning || info.efforts.length === 0) {
        return { kind: 'none', options: [], defaultValue: 'high' };
    }
    const validOptions = info.efforts.filter((item): item is ReasoningEffort =>
        VALID_REASONING_EFFORTS.has(item as ReasoningEffort));
    if (validOptions.length === 0) {
        return { kind: 'none', options: [], defaultValue: 'high' };
    }
    const preferredDefault = info.defaultEffort && validOptions.includes(info.defaultEffort as ReasoningEffort)
        ? (info.defaultEffort as ReasoningEffort)
        : validOptions.includes('high')
            ? 'high'
            : validOptions[validOptions.length - 1]!;
    return {
        kind: validOptions.length === 1 ? 'fixed' : 'effort',
        options: validOptions,
        defaultValue: preferredDefault,
    };
}

/** 判断静态表 + 缓存中哪个 OpenDesign 模型接受图片输入。 */
export function openDesignSupportsVision(
    model: string,
    synced: readonly OpenDesignCatalogModel[] = getCachedOpenDesignModels(),
): boolean {
    const info = resolveOpenDesignModelInfo(model, synced);
    return info.input.includes('image');
}

/** 默认可见的模型 id 列表（用于设置页初始列表及合并网关返回）。 */
export function defaultOpenDesignModelIds(): string[] {
    return [...OPENDESIGN_DEFAULT_MODELS];
}

export function isKnownOpenDesignModel(model: string): boolean {
    return model in OPENDESIGN_MODEL_CATALOG;
}
