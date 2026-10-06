/**
 * Command Code 实时模型目录。
 *
 * `/provider/v1/models` 是**公开**端点：登录前就能读，因此它可以在第一次签入
 * 之前就填好设置卡片里的上下文窗口默认值。每个模型的 `context_length` 是厂商
 * 公布的窗口，比内置表准确，也与逐模型覆盖共存（覆盖优先）。
 *
 * 目录不是快变数据，所以失败时保留上一次快照，而不是把选择器清空。
 */

import { isRecord } from '../../../shared/protocolValidation';

export const COMMANDCODE_MODELS_PATH = '/provider/v1/models';
/** 目录在本地复用多久之后才再次询问服务端。 */
export const COMMANDCODE_CATALOG_TTL_MS = 30 * 60_000;
/** 单次目录请求的网络预算。 */
export const COMMANDCODE_DISCOVERY_TIMEOUT_MS = 15_000;
/** 单次目录响应的条目上限，避免异常响应撑爆内存。 */
const MAX_CATALOG_ENTRIES = 2000;

/** 目录里的一个模型。 */
export interface CommandCodeCatalogModel {
    id: string;
    name: string;
    /** 厂商公布的上下文窗口；未公布为 undefined。 */
    contextWindow?: number;
    /** 该模型应答的线路；目录未声明时 undefined，由调用方按模型名回落。 */
    supportedEndpoints?: string[];
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = asNumber(record[key]);
        if (value !== undefined) return value;
    }
    return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = asString(record[key]);
        if (value !== undefined) return value;
    }
    return undefined;
}

function firstStringArray(record: Record<string, unknown>, keys: string[]): string[] | undefined {
    for (const key of keys) {
        const value = record[key];
        if (!Array.isArray(value)) continue;
        const items = value.map(asString).filter((item): item is string => item !== undefined);
        if (items.length > 0) return items;
    }
    return undefined;
}

/** 解析公开的 `/provider/v1/models` 负载。 */
export function parseCommandCodeCatalog(payload: unknown): CommandCodeCatalogModel[] {
    const root = isRecord(payload) ? payload : undefined;
    const list = root && Array.isArray(root.data)
        ? root.data
        : Array.isArray(payload)
            ? payload
            : [];
    const models: CommandCodeCatalogModel[] = [];
    for (const entry of list.slice(0, MAX_CATALOG_ENTRIES)) {
        if (!isRecord(entry)) continue;
        const id = firstString(entry, ['id', 'model', 'name']);
        if (id === undefined) continue;
        const contextWindow = firstNumber(entry, ['context_length', 'contextLength', 'context_window', 'contextWindow']);
        const supportedEndpoints = firstStringArray(entry, ['supported_endpoints', 'supportedEndpoints']);
        models.push({
            id,
            name: firstString(entry, ['displayName', 'name']) ?? id,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(supportedEndpoints !== undefined ? { supportedEndpoints } : {}),
        });
    }
    return models;
}

/** 从已解析的目录提取「模型 id → 上下文窗口」，供 DSH 的压缩与溢出判断使用。 */
export function commandCodeContextWindows(models: readonly CommandCodeCatalogModel[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const model of models) {
        if (model.contextWindow !== undefined) result[model.id] = model.contextWindow;
    }
    return result;
}

interface CatalogCache {
    at: number;
    models: readonly CommandCodeCatalogModel[];
}

let catalogCache: CatalogCache | null = null;
let catalogInFlight: Promise<readonly CommandCodeCatalogModel[]> | null = null;

/** 丢弃内存中的目录，让下一次加载重新访问服务端。 */
export function clearCachedCommandCodeCatalog(): void {
    catalogCache = null;
    catalogInFlight = null;
}

/** 当前持有的目录；首次加载前为 undefined。 */
export function getCachedCommandCodeCatalog(): readonly CommandCodeCatalogModel[] | undefined {
    return catalogCache?.models;
}

export interface CommandCodeCatalogLoadOptions {
    baseUrl: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** 跳过缓存，重新询问服务端。 */
    force?: boolean;
}

/**
 * 读取实时目录。
 *
 * 失败时返回上一次快照（可能为空），而不是抛错：目录只用于填默认值，读不到
 * 就继续用内置表，不该让设置页打不开。
 */
export function loadCommandCodeCatalog(options: CommandCodeCatalogLoadOptions): Promise<readonly CommandCodeCatalogModel[]> {
    if (options.force !== true
        && catalogCache !== null && Date.now() - catalogCache.at < COMMANDCODE_CATALOG_TTL_MS) {
        return Promise.resolve(catalogCache.models);
    }
    if (catalogInFlight !== null) return catalogInFlight;

    const promise = performCatalogLoad(options).then(
        models => { catalogInFlight = null; return models; },
        () => { catalogInFlight = null; return getCachedCommandCodeCatalog() ?? []; },
    );
    catalogInFlight = promise;
    return promise;
}

async function performCatalogLoad(options: CommandCodeCatalogLoadOptions): Promise<readonly CommandCodeCatalogModel[]> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = options.baseUrl.replace(/\/+$/, '');
    const timeoutSignal = AbortSignal.timeout(COMMANDCODE_DISCOVERY_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchFn(`${base}${COMMANDCODE_MODELS_PATH}`, {
        headers: { accept: 'application/json' },
        signal,
    });
    if (!response.ok) throw new Error(`Command Code model catalog failed: ${response.status}`);
    const models = parseCommandCodeCatalog(await response.json().catch(() => undefined));
    if (models.length === 0) throw new Error('Command Code model catalog named no models.');
    catalogCache = { at: Date.now(), models };
    return models;
}
