/**
 * Kimi Code 的实时模型目录。
 *
 * `GET {coding}/v1/models` 是「这个账号现在能调什么」的权威：它说出这个套餐解锁了哪些模型、
 * 各自的上下文窗口、可选档位与能力。随包发出的静态表只是**兜底**——它无法知道发布之后新增的
 * 模型，也无法知道某个账号的套餐实际锁住了哪些。
 *
 * 目录按账号缓存：不同套餐看到的模型集合不同，用一个账号的目录回答另一个账号的选择器会
 * 凭空多出或少出模型。
 */

import { isRecord } from '../../../shared/protocolValidation';
import { BUILTIN_PROVIDERS } from '../providers/models/defaults';

/** 目录在本地复用多久之后才再次询问服务端。 */
const CATALOG_TTL_MS = 30 * 60 * 1000;
/** 单次目录请求的网络预算；慢端点不能拖住选择器渲染。 */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** 单次响应的条目上限，避免异常响应撑爆内存与选择器。 */
const MAX_CATALOG_ENTRIES = 200;

/** 服务给不再提供的模型打上的生命周期标记。 */
const RETIRED_MODEL_STATUSES = new Set(['deprecated', 'alpha', 'retired']);

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = asNumber(record[key]);
        if (value !== undefined) return value;
    }
    return undefined;
}

/** 目录里的一个模型。 */
export interface KimiCodeCatalogModel {
    id: string;
    name: string;
    contextWindow: number;
    reasoningEfforts: string[];
    defaultReasoningEffort: string | null;
    inputModalities: Array<'text' | 'image' | 'video'>;
    /**
     * 三态：服务可能断言开、断言关，或者**什么都不说**。
     *
     * 把「关」折叠成「没有」会让一次明确的否认与沉默无法区分，静态兜底于是重新打开一个
     * 服务刚刚关掉的能力。
     */
    supportsToolUse?: boolean;
}

/**
 * 解析一条目录。
 *
 * 已退役的别名被**丢弃**而不是继续提供：选它会在请求时失败，而留着它会让取代它的新模型
 * 消失在选择器后面。没有正数上下文长度的条目同样丢弃——零容量的模型不是模型。
 */
export function parseKimiCatalog(payload: unknown): KimiCodeCatalogModel[] {
    const root = isRecord(payload) ? payload : {};
    const list = Array.isArray(payload) ? payload : Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : [];
    const models: KimiCodeCatalogModel[] = [];
    for (const item of list.slice(0, MAX_CATALOG_ENTRIES)) {
        if (!isRecord(item)) continue;
        const id = asString(item.id);
        if (id === undefined) continue;
        const status = asString(item.status)?.toLowerCase();
        if (status !== undefined && RETIRED_MODEL_STATUSES.has(status)) continue;
        const contextWindow = firstNumber(item, ['context_length', 'contextLength']);
        if (contextWindow === undefined || contextWindow <= 0) continue;
        const efforts = isRecord(item.think_efforts) ? item.think_efforts : isRecord(item.thinkEfforts) ? item.thinkEfforts : {};
        const declared = Array.isArray(efforts.valid_efforts)
            ? efforts.valid_efforts
            : Array.isArray(efforts.validEfforts) ? efforts.validEfforts : [];
        const reasoningEfforts = declared.filter((entry): entry is string => typeof entry === 'string');
        const modalities: Array<'text' | 'image' | 'video'> = ['text'];
        if (item.supports_image_in === true || item.supportsImageIn === true) modalities.push('image');
        if (item.supports_video_in === true || item.supportsVideoIn === true) modalities.push('video');
        const toolUse = item.supports_tool_use ?? item.supportsToolUse;
        models.push({
            id,
            name: asString(item.display_name) ?? asString(item.displayName) ?? id,
            contextWindow,
            reasoningEfforts,
            defaultReasoningEffort: asString(efforts.default_effort) ?? asString(efforts.defaultEffort) ?? null,
            inputModalities: modalities,
            ...(typeof toolUse === 'boolean' ? { supportsToolUse: toolUse } : {}),
        });
    }
    return models;
}

let catalogCache: { at: number; models: readonly KimiCodeCatalogModel[]; accountKey: string } | null = null;
let inFlight: { accountKey: string; promise: Promise<readonly KimiCodeCatalogModel[]> } | null = null;

/** 丢弃内存中的目录，让下一次加载重新访问服务端。 */
export function clearCachedKimiCatalog(): void {
    catalogCache = null;
    inFlight = null;
}

/** 当前持有的目录；首次加载前为 undefined。 */
export function getCachedKimiCatalog(): readonly KimiCodeCatalogModel[] | undefined {
    return catalogCache?.models;
}

/**
 * 随包发出的兜底表。
 *
 * 它只说「有哪些模型」，因此窗口与档位用线路的声明值；真正的权威是实时目录。
 */
function shippedModels(): KimiCodeCatalogModel[] {
    const provider = BUILTIN_PROVIDERS['kimi-code-plan'];
    const window = provider?.maxContextTokens ?? 262_144;
    return (provider?.models ?? []).map(id => ({
        id,
        name: id,
        contextWindow: window,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'] as Array<'text' | 'image' | 'video'>,
        supportsToolUse: provider?.supportsToolUse ?? true,
    }));
}

export interface KimiCatalogLoadOptions {
    /** 区域对应的 coding 基址。 */
    codingBase: string;
    headers: Record<string, string>;
    accountKey: string;
    fetchFn?: typeof fetch;
    force?: boolean;
}

/**
 * 读取本账号的目录。
 *
 * 失败时用**当前持有的**目录作答，而不是清空：一份读不到的目录不该让选择器变空，那比
 * 暂时显示旧数字更难诊断。
 */
export function loadKimiCatalog(options: KimiCatalogLoadOptions): Promise<readonly KimiCodeCatalogModel[]> {
    const key = options.accountKey;
    if (options.force !== true) {
        const cached = catalogCache;
        if (cached !== null && cached.accountKey === key && Date.now() - cached.at < CATALOG_TTL_MS) {
            return Promise.resolve(cached.models);
        }
    }
    if (inFlight !== null && inFlight.accountKey === key) return inFlight.promise;
    const promise = performLoad(options).then(
        models => {
            if (inFlight?.accountKey === key) inFlight = null;
            return models;
        },
        () => {
            if (inFlight?.accountKey === key) inFlight = null;
            return catalogCache?.accountKey === key ? catalogCache.models : shippedModels();
        },
    );
    inFlight = { accountKey: key, promise };
    return promise;
}

async function performLoad(options: KimiCatalogLoadOptions): Promise<readonly KimiCodeCatalogModel[]> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = options.codingBase.replace(/\/+$/, '');
    const response = await fetchFn(base + '/v1/models', {
        headers: { ...options.headers, accept: 'application/json' },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('Kimi Code model listing failed (' + response.status + ').');
    const payload: unknown = await response.json().catch(() => undefined);
    const listing = parseKimiCatalog(payload);
    if (listing.length === 0) throw new Error('Kimi Code model listing named no models this line understands.');
    catalogCache = { at: Date.now(), models: listing, accountKey: options.accountKey };
    return listing;
}
