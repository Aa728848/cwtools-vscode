/**
 * WorkBuddy / CodeBuddy 实时模型目录加载与能力查询。
 *
 * 网关的 `/v3/config` 是模型能力、服务窗口、输出上限、思考阶梯与分区倍率的权威来源
 * （同一主机的 `/v1/models` 会返回 404）；实时目录未就绪或未登录时由 `fallbackModels.ts`
 * 兜底。所有实时目录结果均按地区（`cn` / `intl`）严格隔离并按厂商版本聚类排序。
 */

import { isRecord } from '../../../shared/protocolValidation';
import {
    WORKBUDDY_CATALOG_CACHE_TTL_MS,
    WORKBUDDY_CONFIG_PATH,
    WORKBUDDY_DEFAULT_MAX_TOKENS,
    WORKBUDDY_DISCOVERY_TIMEOUT_MS,
    WORKBUDDY_STANDARD_EFFORTS,
    convergeWorkBuddyEffort,
    parseWorkBuddyCreditMultiplier,
    type WorkBuddyModelCredits,
    type WorkBuddyModelEntry,
    type WorkBuddyRegion,
} from './types';
import {
    DEFAULT_VISIBLE_MODEL_IDS,
    builtinWorkBuddyModelsForRegion,
    groupWorkBuddyModelsByVendor,
    resolveWorkBuddyModelEntry,
    withUnpublishedWorkBuddyModels,
} from './fallbackModels';

export type { WorkBuddyModelEntry };
export { DEFAULT_VISIBLE_MODEL_IDS };

function asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value.replace(/[,\s]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

/**
 * 解析 `/v3/config` 负载中的模型列表；跳过文生图/图生图模型（tags 含 image）。
 */
export function parseWorkBuddyConfigModels(payload: unknown, region: WorkBuddyRegion): WorkBuddyModelEntry[] {
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root.data) ? root.data : root;
    const list = Array.isArray(data.models) ? data.models : [];

    const models: WorkBuddyModelEntry[] = [];
    for (const item of list) {
        if (!isRecord(item)) continue;
        const id = asString(item.id);
        if (id === undefined) continue;
        if (Array.isArray(item.tags) && item.tags.some(tag => String(tag).includes('image'))) continue;

        const maxContextWindow = asNumber(item.maxAllowedSize) ?? asNumber(item.maxInputTokens);
        if (maxContextWindow === undefined) continue;

        const reasoning = isRecord(item.reasoning) ? item.reasoning : {};
        const declared = Array.isArray(reasoning.supportedEfforts)
            ? reasoning.supportedEfforts.filter((effort): effort is string => typeof effort === 'string')
            : [];
        const single = asString(reasoning.effort);
        const efforts = declared.length > 0
            ? declared
            : (single === undefined ? [] : [...WORKBUDDY_STANDARD_EFFORTS]);
        const declaredDefault = asString(reasoning.defaultEffort) ?? single ?? null;
        const modelDefault = declaredDefault === null || efforts.includes(declaredDefault)
            ? declaredDefault
            : convergeWorkBuddyEffort(declaredDefault, efforts);

        const contextWindowConfig = isRecord(item.contextWindow) ? item.contextWindow : {};
        const servedDefault = asNumber(contextWindowConfig.defaultLength);
        const multiplier = parseWorkBuddyCreditMultiplier(item.credits);

        models.push({
            id,
            name: asString(item.name) ?? id,
            contextWindow: servedDefault ?? maxContextWindow,
            maxContextWindow,
            maxTokens: asNumber(item.maxOutputTokens) ?? WORKBUDDY_DEFAULT_MAX_TOKENS,
            regions: [region],
            ...(multiplier === null ? {} : { credits: { [region]: multiplier } }),
            supportsImage: item.supportsImages === true,
            reasoningEfforts: efforts,
            defaultReasoningEffort: modelDefault,
            canDisableThinking: reasoning.canDisableThinking === true,
            description: asString(item.descriptionZh) ?? asString(item.descriptionEn) ?? '',
        });
    }
    return models;
}

/** 从目录生成 `modelId -> 默认服务上下文长度` 映射表。 */
export function workBuddyContextWindows(models: readonly WorkBuddyModelEntry[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const model of models) {
        if (model.contextWindow > 0) result[model.id] = model.contextWindow;
    }
    return result;
}

interface CatalogCache {
    at: number;
    region: WorkBuddyRegion;
    models: readonly WorkBuddyModelEntry[];
}

let catalogCache: CatalogCache | null = null;
let catalogInFlight: { region: WorkBuddyRegion; promise: Promise<readonly WorkBuddyModelEntry[]> } | null = null;
let catalogCacheEpoch = 0;

/** 清空内存中的 WorkBuddy 目录缓存（切换账号或测试重置用）。 */
export function clearCachedWorkBuddyCatalog(): void {
    catalogCacheEpoch += 1;
    catalogCache = null;
    catalogInFlight = null;
}

/** 获取当前已缓存目录；未命中前返回 undefined。 */
export function getCachedWorkBuddyCatalog(): readonly WorkBuddyModelEntry[] | undefined {
    return catalogCache?.models;
}

export interface WorkBuddyCatalogLoadOptions {
    backend: string;
    region: WorkBuddyRegion;
    headers: Record<string, string>;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** 跳过缓存 TTL 直接强制刷新。 */
    force?: boolean;
}

/**
 * 加载并缓存所属区域的 `/v3/config` 实时目录；请求失败时优雅保留上一次区域快照。
 */
export function loadWorkBuddyCatalog(options: WorkBuddyCatalogLoadOptions): Promise<readonly WorkBuddyModelEntry[]> {
    if (options.force !== true
        && catalogCache !== null
        && catalogCache.region === options.region
        && Date.now() - catalogCache.at < WORKBUDDY_CATALOG_CACHE_TTL_MS) {
        return Promise.resolve(catalogCache.models);
    }
    if (catalogInFlight !== null && catalogInFlight.region === options.region) {
        return catalogInFlight.promise;
    }

    const epoch = catalogCacheEpoch;
    const promise = performCatalogLoad(options, epoch).then(
        models => {
            if (catalogInFlight?.region === options.region && catalogInFlight?.promise === promise) {
                catalogInFlight = null;
            }
            return models;
        },
        () => {
            if (catalogInFlight?.region === options.region && catalogInFlight?.promise === promise) {
                catalogInFlight = null;
            }
            return catalogCache?.region === options.region ? catalogCache.models : [];
        },
    );
    catalogInFlight = { region: options.region, promise };
    return promise;
}

async function performCatalogLoad(
    options: WorkBuddyCatalogLoadOptions,
    epoch: number,
): Promise<readonly WorkBuddyModelEntry[]> {
    const fetchFn = options.fetchFn ?? fetch;
    const timeout = AbortSignal.timeout(WORKBUDDY_DISCOVERY_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const base = options.backend.replace(/\/+$/, '');
    const response = await fetchFn(`${base}${WORKBUDDY_CONFIG_PATH}`, {
        headers: { ...options.headers, accept: 'application/json' },
        signal,
    });
    if (!response.ok) {
        throw new Error(`WorkBuddy model catalog failed: ${response.status}`);
    }
    const parsed = parseWorkBuddyConfigModels(await response.json().catch(() => undefined), options.region);
    if (parsed.length === 0) {
        throw new Error('WorkBuddy model catalog named no models.');
    }
    const models = groupWorkBuddyModelsByVendor(withUnpublishedWorkBuddyModels(parsed, options.region));
    if (epoch === catalogCacheEpoch) {
        catalogCache = { at: Date.now(), region: options.region, models };
    }
    return models;
}

/** 在实时缓存和 49 条内置表中解析单个模型元数据。 */
export function resolveWorkBuddyCatalogEntry(model: string): WorkBuddyModelEntry | undefined {
    return resolveWorkBuddyModelEntry(model, catalogCache?.models);
}

/**
 * 查询模型在设置器里可选的思考档位。
 * 当模型声明允许关闭思考（`canDisableThinking: true`）时在头部附带 `'none'`。
 */
export function workBuddyEffortsFor(model: string): readonly string[] {
    const entry = resolveWorkBuddyCatalogEntry(model);
    if (!entry) return [];
    if (!entry.canDisableThinking || entry.reasoningEfforts.length === 0) {
        return entry.reasoningEfforts;
    }
    return entry.reasoningEfforts.includes('none')
        ? entry.reasoningEfforts
        : ['none', ...entry.reasoningEfforts];
}

/**
 * 解析实际随请求发送的思考档位；不允许发送未纳入该模型阶梯的档位以防触发 `code 11150`。
 */
export function workBuddyEffortForRequest(model: string, requested?: string): string | undefined {
    const entry = resolveWorkBuddyCatalogEntry(model);
    if (!entry || entry.reasoningEfforts.length === 0) return undefined;
    if (requested === 'none' && entry.canDisableThinking) return 'none';
    for (const candidate of [requested, entry.defaultReasoningEffort ?? undefined]) {
        if (candidate !== undefined && candidate !== null && entry.reasoningEfforts.includes(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/** 读取模型支持的输出上限。 */
export function workBuddyMaxOutputTokens(model: string): number | undefined {
    return resolveWorkBuddyCatalogEntry(model)?.maxTokens;
}

/** 查询模型是否接收图像输入。 */
export function workBuddySupportsVision(model: string): boolean {
    return resolveWorkBuddyCatalogEntry(model)?.supportsImage === true;
}

/** 读取模型的分区积分消耗倍率。 */
export function workBuddyModelCredits(model: string): WorkBuddyModelCredits {
    return resolveWorkBuddyCatalogEntry(model)?.credits ?? {};
}

const WORKBUDDY_REGIONS: readonly WorkBuddyRegion[] = ['cn', 'intl'];

/**
 * 获取供设置卡片与默认配置解析的模型列表（按地区隔离、实时目录优先）。
 */
export function workBuddyCatalogForSettings(
    region?: WorkBuddyRegion,
): { models: readonly WorkBuddyModelEntry[]; source: 'live' | 'builtin' } {
    if (region !== undefined && catalogCache?.region === region && catalogCache.models.length > 0) {
        return {
            models: groupWorkBuddyModelsByVendor(withUnpublishedWorkBuddyModels(catalogCache.models, region)),
            source: 'live',
        };
    }
    const regions = region === undefined ? WORKBUDDY_REGIONS : [region];
    const seen = new Set<string>();
    const models: WorkBuddyModelEntry[] = [];
    for (const candidate of regions) {
        for (const model of builtinWorkBuddyModelsForRegion(candidate)) {
            if (seen.has(model.id)) continue;
            seen.add(model.id);
            models.push(model);
        }
    }
    return { models: groupWorkBuddyModelsByVendor(models), source: 'builtin' };
}
