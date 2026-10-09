/**
 * WorkBuddy 实时模型目录。
 *
 * 网关自己的 /v3/config 才是权威：每个模型的真实上下文上限、输出上限、是否接受图片、
 * 以及可用的思考档位都在这里，不做任何按模型名猜测。/v1/models 在这条线路上是 404，
 * 所以**不能**走通用发现。
 *
 * 目录不是快变数据，且重启后第一个选择器不该等网络，因此读取顺序是：
 * 内存缓存 → 上次成功快照 → 网络；失败时保留上一次快照而不是清空。
 *
 * **未登录或网关不可达时目录为空**，此时模型清单、上下文窗口、输出上限与思考档位都由
 * fallbackModels.ts 的内置表回答。因此本模块的每次查询都是「实时缓存优先 → 内置表兜底」，
 * 而不是把缓存当成唯一来源。
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
import {
    builtinWorkBuddyModelsForRegion,
    resolveWorkBuddyModelEntry,
    withUnpublishedWorkBuddyModels,
} from './fallbackModels';

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
    /**
     * 服务该 id 的区域。
     *
     * 这是**路由事实**而不是偏好：向不服务某模型的一区发请求返回 400 code 11102。
     * 实时解析出的条目带上本次加载的区域（一次读取只问一个区）；内置表条目按实测标注。
     */
    regions: WorkBuddyRegion[];
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
            // 一次读取只问一个区，所以这条目录声明的服务区域就是本次加载的区域。
            regions: [region],
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
    const parsed = parseWorkBuddyConfigModels(await response.json().catch(() => undefined), options.region);
    if (parsed.length === 0) throw new Error('WorkBuddy model catalog named no models.');
    // 网关服务却不公布的模型（UNPUBLISHED_MODELS）在这里并入快照：可达的网关会用自己公布的
    // 清单替换内置表，不并的话 gpt-6-sol / gpt-6-luna / gemini-3.8-flash 会在目录加载完成的
    // 瞬间从选择器里消失。合并发生在快照上，因此后续所有查询看到的都是同一份清单。
    const models = withUnpublishedWorkBuddyModels(parsed, options.region);
    catalogCache = { at: Date.now(), region: options.region, models };
    return models;
}

/**
 * 解析一个 id 的能力：**实时目录缓存优先，内置表兜底**。
 *
 * 这是本模块唯一的解析入口，思考档位、默认档与输出上限都从它派生，因此不会出现「卡片按一份
 * 表显示、请求按另一份表校验」的错位。两个来源都不认识该 id 时返回 `undefined`：未知模型
 * 借用一个邻居的能力会把请求路由到 400 code 11150（档位）或 11102（跨区）。
 *
 * 实时目录里的条目已经带上了本次加载的区域，内置表条目按实测标注，所以返回的 `regions`
 * 在一处即可读到。
 */
export function resolveWorkBuddyCatalogEntry(model: string): WorkBuddyModelEntry | undefined {
    return resolveWorkBuddyModelEntry(model, catalogCache?.models);
}

/**
 * 某个模型在本区可用的思考档位；两个来源都不认识它时返回空数组。
 *
 * 调用方据此决定是否发送 reasoning_effort：不在该模型档位集合内的取值会被**忽略而
 * 不是发出去**（上游对不支持的档位返回 code 11150）。
 */
export function workBuddyEffortsFor(model: string): readonly string[] {
    return resolveWorkBuddyCatalogEntry(model)?.reasoningEfforts ?? [];
}

/**
 * 为一个请求选一个该模型真的接受的思考档位。
 *
 * 两个约束都是实测的：
 * - **不发 effort 时上游返回空的 `reasoning_content`**，即使模型是纯思考模型（实测 0 字符
 *   对比 130-215 字符），所以思考档位必须**物化**出来，不能留给默认值；
 * - 模型没有的档位是 `code 11150`，因此候选里不存在的取值会被丢弃而不是原样发出。
 *
 * 候选顺序是：用户显式选择 → 表声明的默认档。两者都不被接受时返回 undefined，交给调用方
 * 决定是否省略该字段。
 *
 * **未知模型返回 undefined 而不是把请求原样放行**：档位表来自网关，一个它没描述的 id 也就
 * 没有可校验的档位集合，把任意取值发出去正是 11150 的成因。实时目录命中时行为与本函数
 * 引入内置表之前一致（那时缓存未命中会直接 return requested，等于不校验）。
 */
export function workBuddyEffortForRequest(model: string, requested?: string): string | undefined {
    const entry = resolveWorkBuddyCatalogEntry(model);
    if (entry === undefined) return undefined;
    if (entry.reasoningEfforts.length === 0) return undefined;
    for (const candidate of [requested, entry.defaultReasoningEffort ?? undefined]) {
        if (candidate !== undefined && candidate !== null && entry.reasoningEfforts.includes(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * 某个模型在这个区实际服务的输出上限；两个来源都不认识它时返回 undefined。
 *
 * 用它替代通用上限：按模型名推断出的数字要么过早截断，要么高过服务真正接受的值。
 */
export function workBuddyMaxOutputTokens(model: string): number | undefined {
    return resolveWorkBuddyCatalogEntry(model)?.maxTokens;
}

/** 全部区域。区域未知时的并集就是按它们各取一次。 */
const WORKBUDDY_REGIONS: readonly WorkBuddyRegion[] = ['cn', 'intl'];

/**
 * 设置卡片要展示的模型清单与窗口来源。
 *
 * 这是「实时目录优先、内置表兜底、未公布模型并入」三条规则唯一的落地处：
 *
 * - 实时目录命中时用它，并把网关服务却不公布的模型并入
 *   （`withUnpublishedWorkBuddyModels`），否则这些模型会在目录加载的瞬间从选择器里消失；
 * - 目录为空（未登录 / 网关不可达）时退回**内置表按区域过滤**，而不是空清单——空清单会让
 *   模型下拉没有任何选项，用户连自己能调用哪个模型都看不到；
 * - `region` 为 `undefined` 表示区域未知，此时按**两区并集**给出。两区清单不是包含关系，
 *   只给一区会让另一区的账号在登录前看不到自己唯一能用的模型。
 *
 * 一旦区域确定（凭据在手），必须按该区域过滤：跨区发模型会被网关以 400 code 11102 拒绝。
 */
export function workBuddyCatalogForSettings(
    region?: WorkBuddyRegion,
): { models: readonly WorkBuddyModelEntry[]; source: 'live' | 'builtin' } {
    if (region !== undefined && catalogCache?.region === region && catalogCache.models.length > 0) {
        return { models: withUnpublishedWorkBuddyModels(catalogCache.models, region), source: 'live' };
    }
    // 区域未知时并集只在**没有实时目录**时使用：它可能把跨区模型塞进下拉，而一次
    // 400 code 11102 就是由此而来。
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
    return { models, source: 'builtin' };
}
