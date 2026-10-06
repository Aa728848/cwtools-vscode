/**
 * WorkBuddy 实时模型目录。
 *
 * 网关自己的 /v3/config 才是权威：每个模型的真实上下文上限、输出上限、是否接受图片、
 * 以及可用的思考档位都在这里，不做任何按模型名猜测。/v1/models 在这条线路上是 404，
 * 所以**不能**走通用发现。
 *
 * 目录不是快变数据，且重启后第一个选择器不该等网络，因此读取顺序是：
 * 内存缓存 → 上次成功快照 → 网络；失败时保留上一次快照而不是清空。
 */

import { isRecord } from '../../../shared/protocolValidation';
import {
    WORKBUDDY_CATALOG_CACHE_TTL_MS,
    WORKBUDDY_DISCOVERY_TIMEOUT_MS,
    WORKBUDDY_CONFIG_PATH,
    WORKBUDDY_STANDARD_EFFORTS,
    convergeWorkBuddyEffort,
    type WorkBuddyRegion,
} from './types';

/** 目录里的一个模型。 */
export interface WorkBuddyModelEntry {
    id: string;
    name: string;
    /**
     * 目录声明的**默认服务**上下文长度。
     *
     * 本线路不发送显式长度参数，所以 DSH 的压缩与溢出判断必须按这个数字算，而不是
     * 按模型上限——否则请求会越过后端实际接受的窗口。
     */
    contextWindow: number;
    /** 模型允许的最大上下文。 */
    maxContextWindow: number;
    maxTokens: number;
    supportsImage: boolean;
    reasoningEfforts: string[];
    defaultReasoningEffort: string | null;
    canDisableThinking: boolean;
    description: string;
}

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
 * 解析一个 /v3/config 负载的模型表。
 *
 * 每个条目直接携带本线路需要的事实，因此不从模型名推断任何东西。图片生成工具
 * （tags 里含 image）被跳过：它们不是对话模型，也没有上下文窗口。
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
        // 网关以两种形状公布思考档位：
        //   { supportedEfforts: [...], defaultEffort: 'x' } -> 显式档位表
        //   { effort: 'x' }                                 -> 只有默认值
        // 第二种既不是单档表，也不等于可以开放本线路能叫出名字的每一档。实测
        // deepseek-v4.1-flash 只报 effort: 'high'，而它接受 low/high/max 并把其余取值
        // 收敛到最近档；按默认值开放全部档位会往选择器里塞模型没有的档位。
        const declared = Array.isArray(reasoning.supportedEfforts)
            ? reasoning.supportedEfforts.filter((effort): effort is string => typeof effort === 'string')
            : [];
        const single = asString(reasoning.effort);
        const efforts = declared.length > 0
            ? declared
            : (single === undefined ? [] : [...WORKBUDDY_STANDARD_EFFORTS]);
        // 目录给出的默认档可能落在档位表之外，这种值收敛到最近档，否则默认档被判不支持
        // 而丢弃，退化成「请求不带 reasoning_effort」——上游会因此返回空的 reasoning_content。
        const declaredDefault = asString(reasoning.defaultEffort) ?? single ?? null;
        const modelDefault = declaredDefault === null || efforts.includes(declaredDefault)
            ? declaredDefault
            : convergeWorkBuddyEffort(declaredDefault, efforts);

        // 网关把「默认服务的长度」与「模型允许的上限」分开报。
        const contextWindowConfig = isRecord(item.contextWindow) ? item.contextWindow : {};
        const servedDefault = asNumber(contextWindowConfig.defaultLength);

        models.push({
            id,
            name: asString(item.name) ?? id,
            contextWindow: servedDefault ?? maxContextWindow,
            maxContextWindow,
            maxTokens: asNumber(item.maxOutputTokens) ?? 32768,
            supportsImage: item.supportsImages === true,
            reasoningEfforts: efforts,
            defaultReasoningEffort: modelDefault,
            canDisableThinking: reasoning.canDisableThinking === true,
            description: asString(item.descriptionZh) ?? asString(item.descriptionEn) ?? '',
        });
    }
    return models;
}

/** 从已解析的目录提取「模型 id → 上下文窗口」。 */
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

/** 丢弃内存中的目录，让下一次加载重新访问网关。 */
export function clearCachedWorkBuddyCatalog(): void {
    catalogCache = null;
    catalogInFlight = null;
}

/** 当前持有的目录；首次加载前为 undefined。 */
export function getCachedWorkBuddyCatalog(): readonly WorkBuddyModelEntry[] | undefined {
    return catalogCache?.models;
}

export interface WorkBuddyCatalogLoadOptions {
    backend: string;
    region: WorkBuddyRegion;
    headers: Record<string, string>;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** 跳过缓存，重新询问网关。 */
    force?: boolean;
}

/**
 * 读取本账号所在区域的实时目录。
 *
 * **按区域隔离**：两个区服务的模型清单不同，把模型发到不服务它的区会返回 400
 * code 11102，所以一个区的目录不能回答另一个区。
 *
 * 失败时返回该区域上一次快照（可能为空）而不是抛错：目录只用于填默认值，读不到就继续
 * 用内置表，不该让设置页打不开。
 */
export function loadWorkBuddyCatalog(options: WorkBuddyCatalogLoadOptions): Promise<readonly WorkBuddyModelEntry[]> {
    if (options.force !== true
        && catalogCache !== null && catalogCache.region === options.region
        && Date.now() - catalogCache.at < WORKBUDDY_CATALOG_CACHE_TTL_MS) {
        return Promise.resolve(catalogCache.models);
    }
    if (catalogInFlight !== null && catalogInFlight.region === options.region) return catalogInFlight.promise;

    const promise = performCatalogLoad(options).then(
        models => {
            if (catalogInFlight?.region === options.region) catalogInFlight = null;
            return models;
        },
        () => {
            if (catalogInFlight?.region === options.region) catalogInFlight = null;
            return catalogCache?.region === options.region ? catalogCache.models : [];
        },
    );
    catalogInFlight = { region: options.region, promise };
    return promise;
}

async function performCatalogLoad(options: WorkBuddyCatalogLoadOptions): Promise<readonly WorkBuddyModelEntry[]> {
    const fetchFn = options.fetchFn ?? fetch;
    const timeoutSignal = AbortSignal.timeout(WORKBUDDY_DISCOVERY_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const base = options.backend.replace(/\/+$/, '');
    const response = await fetchFn(base + WORKBUDDY_CONFIG_PATH, {
        headers: { ...options.headers, accept: 'application/json' },
        signal,
    });
    if (!response.ok) throw new Error('WorkBuddy model catalog failed: ' + response.status);
    const models = parseWorkBuddyConfigModels(await response.json().catch(() => undefined), options.region);
    if (models.length === 0) throw new Error('WorkBuddy model catalog named no models.');
    catalogCache = { at: Date.now(), region: options.region, models };
    return models;
}

/**
 * 某个模型在本区可用的思考档位；未在目录中时返回空数组。
 *
 * 调用方据此决定是否发送 reasoning_effort：不在该模型档位集合内的取值会被**忽略而
 * 不是发出去**（上游对不支持的档位返回 code 11150）。
 */
export function workBuddyEffortsFor(model: string): readonly string[] {
    return catalogCache?.models.find(entry => entry.id === model)?.reasoningEfforts ?? [];
}


/**
 * 为一个请求选一个该模型真的接受的思考档位。
 *
 * 两个约束都是实测的：
 * - **不发 effort 时上游返回空的 `reasoning_content`**，即使模型是纯思考模型（实测 0 字符
 *   对比 130-215 字符），所以思考档位必须**物化**出来，不能留给默认值；
 * - 模型没有的档位是 `code 11150`，因此候选里不存在的取值会被丢弃而不是原样发出。
 *
 * 候选顺序是：用户显式选择 → 目录声明的默认档。两者都不被接受时返回 undefined，交给调用方
 * 决定是否省略该字段。
 */
export function workBuddyEffortForRequest(model: string, requested?: string): string | undefined {
    const entry = catalogCache?.models.find(candidate => candidate.id === model);
    if (entry === undefined) return requested;
    if (entry.reasoningEfforts.length === 0) return undefined;
    for (const candidate of [requested, entry.defaultReasoningEffort ?? undefined]) {
        if (candidate !== undefined && candidate !== null && entry.reasoningEfforts.includes(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
/**
 * 某个模型在这个区实际服务的输出上限；目录未给出时返回 undefined。
 *
 * 用它替代通用上限：按模型名推断出的数字要么过早截断，要么高过服务真正接受的值。
 */
export function workBuddyMaxOutputTokens(model: string): number | undefined {
    return catalogCache?.models.find(entry => entry.id === model)?.maxTokens;
}
