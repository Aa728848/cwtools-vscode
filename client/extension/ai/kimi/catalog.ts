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
import {
    isReasoningEffort,
    REASONING_EFFORT_VALUES,
    type ModelReasoningCapability,
    type ReasoningEffort,
} from '../types';
import { getModelContextTokens } from '../providers/models/capabilities';
import { BUILTIN_PROVIDERS } from '../providers/models/defaults';

/** 目录在本地复用多久之后才再次询问服务端。 */
const CATALOG_TTL_MS = 30 * 60 * 1000;
/** 单次目录请求的网络预算；慢端点不能拖住选择器渲染。 */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** 单次响应的条目上限，避免异常响应撑爆内存与选择器。 */
const MAX_CATALOG_ENTRIES = 200;

/** 服务给不再提供的模型打上的生命周期标记。 */
const RETIRED_MODEL_STATUSES = new Set(['deprecated', 'alpha', 'retired']);

/**
 * 思考的三态声明。
 *
 * `only` 每个档位都在思考且服务端拒绝关闭，`no` 完全不具备思考，`both` 可开可关。
 * 缺席**不等于** `both`：沉默只是没说，把沉默读成「可以关」会给一个只思考的模型
 * 发出 service 会拒的请求。
 */
export type KimiThinkingType = 'only' | 'no' | 'both';

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
    /**
     * 提示词能填到多深，与总窗口分开记账。
     *
     * 一个模型可以有 1M 总窗口却只接受更短的提示词；按总窗口预算提示词会在该压缩的地方
     * 被服务端拒掉。只在 `0 < input < context` 时记录——等于或超过窗口的「上限」不是上限。
     */
    maxInputTokens?: number;
    /** 目录对思考的声明，缺席表示没声明。 */
    thinkingType?: KimiThinkingType;
}

/** 读三态思考声明；不认识的值按「没声明」处理。 */
function parseThinkingType(record: Record<string, unknown>): KimiThinkingType | undefined {
    const raw = asString(record.supports_thinking_type) ?? asString(record.supportsThinkingType);
    return raw === 'only' || raw === 'no' || raw === 'both' ? raw : undefined;
}

/**
 * 官方 `reasoning_options` 的档位。
 *
 * 形如 `{ type: 'effort', values: [...] }` 的条目给出可选档位，开关键（`toggle`/`off`）
 * 表示思考可以被关掉，也就是 harness 里的 `none`。只有开关键、没有任何档位的条目
 * 不发明阶梯，按「没声明档位」返回。
 */
function effortsFromReasoningOptions(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const levels = new Set<string>();
    let switchable = false;
    for (const option of value) {
        if (!isRecord(option)) continue;
        const type = asString(option.type)?.toLowerCase();
        if (type === 'toggle' || type === 'off') switchable = true;
        if (type !== 'effort' || !Array.isArray(option.values)) continue;
        for (const entry of option.values) {
            const level = asString(entry);
            if (level !== undefined) levels.add(level);
        }
    }
    if (levels.size === 0) return undefined;
    if (switchable) levels.add('none');
    return [...levels];
}

/**
 * 用三态声明反修档位表。
 *
 * 声明放在最后应用，因为它能推翻表本身：服务端会一边发着含 `none` 的 `valid_efforts`、
 * 一边声明 `only`，此时表已经过时，而声明是服务端用来取代旧字段的那一句。
 */
function applyThinkingType(efforts: readonly string[], thinkingType: KimiThinkingType | undefined): string[] {
    if (thinkingType === 'no') return [];
    if (thinkingType === 'only') return efforts.filter(effort => effort !== 'none');
    return [...efforts];
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
        // 窗口既可能写在顶层，也可能包在 `limit`/`limits` 信封里；两种都认，
        // 免得一个写法变化就让整份目录被当作零容量丢掉。
        const limits = isRecord(item.limit) ? item.limit : isRecord(item.limits) ? item.limits : undefined;
        const contextWindow = firstNumber(item, ['context_length', 'contextLength'])
            ?? (limits === undefined ? undefined : firstNumber(limits, ['context']));
        if (contextWindow === undefined || contextWindow <= 0) continue;
        const declaredInput = (limits === undefined ? undefined : firstNumber(limits, ['input']))
            ?? firstNumber(item, ['max_input_tokens', 'maxInputTokens']);
        const maxInputTokens = declaredInput !== undefined && declaredInput > 0 && declaredInput < contextWindow
            ? declaredInput
            : undefined;
        const thinkingType = parseThinkingType(item);
        const thinkEfforts = isRecord(item.think_efforts) ? item.think_efforts : isRecord(item.thinkEfforts) ? item.thinkEfforts : {};
        const rawOptions = item.reasoning_options ?? item.reasoningOptions;
        const declared = Array.isArray(thinkEfforts.valid_efforts)
            ? thinkEfforts.valid_efforts
            : Array.isArray(thinkEfforts.validEfforts) ? thinkEfforts.validEfforts : [];
        const fromThinkEfforts = declared.filter((entry): entry is string => typeof entry === 'string');
        const fromOptions = effortsFromReasoningOptions(rawOptions);
        // 两条线路各说一种字段：编码订阅发 `think_efforts`，开放平台发 `reasoning_options`。
        // 同时出现时以前者为准（它是既有口径），三态声明之后统一反修。
        const reasoningEfforts = applyThinkingType(
            fromThinkEfforts.length > 0 ? fromThinkEfforts : (fromOptions ?? []),
            thinkingType,
        );
        // 默认档位既可能写在 `think_efforts` 里，也可能写在顶层：阶梯由
        // `reasoning_options` 提供时，顶层是它唯一的落点。
        const declaredDefault = asString(thinkEfforts.default_effort)
            ?? asString(thinkEfforts.defaultEffort)
            ?? asString(item.default_effort)
            ?? asString(item.defaultEffort);
        // 默认档位若不在修正后的档位表里就丢弃：留着它，第一次依赖它的回合就会被拒。
        const defaultReasoningEffort = declaredDefault !== undefined && reasoningEfforts.includes(declaredDefault)
            ? declaredDefault
            : null;
        const modalities: Array<'text' | 'image' | 'video'> = ['text'];
        if (item.supports_image_in === true || item.supportsImageIn === true) modalities.push('image');
        if (item.supports_video_in === true || item.supportsVideoIn === true) modalities.push('video');
        const toolUse = item.supports_tool_use ?? item.supportsToolUse;
        models.push({
            id,
            name: asString(item.display_name) ?? asString(item.displayName) ?? id,
            contextWindow,
            reasoningEfforts,
            defaultReasoningEffort,
            inputModalities: modalities,
            ...(typeof toolUse === 'boolean' ? { supportsToolUse: toolUse } : {}),
            ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
            ...(thinkingType === undefined ? {} : { thinkingType }),
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

/** 随包兜底表里逐模型的声明；缺席的模型只说「存在」，档位留给静态表。 */
const SHIPPED_KIMI_CODE_METADATA: Readonly<Record<string, {
    reasoningEfforts: readonly string[];
    defaultReasoningEffort: string | null;
    inputModalities: ReadonlyArray<'text' | 'image' | 'video'>;
    thinkingType?: KimiThinkingType;
}>> = {
    'k3': {
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        inputModalities: ['text', 'image'],
        thinkingType: 'only',
    },
    'k3-256k': {
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        inputModalities: ['text', 'image'],
        thinkingType: 'only',
    },
    'k3.1-pro': {
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'max',
        inputModalities: ['text', 'image', 'video'],
        thinkingType: 'only',
    },
    'k3.1-pro-highspeed': {
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'max',
        inputModalities: ['text', 'image', 'video'],
        thinkingType: 'only',
    },
};

/**
 * 随包发出的兜底表。
 *
 * 窗口与输出**逐模型**取：这条线路上的模型窗口并不相同（256K 与 1M 并存），
 * 把 `provider.maxContextTokens` 平摊给每个模型会让 256K 的模型被当成 1M，
 * 于是本该压缩的会话拖到被服务端整条拒掉。
 *
 * 档位只写官方表明确说过的模型；表里没有的（例如 `kimi-for-coding` 别名）
 * 留空，让静态推理表作答——沉默不是「没有档位」。
 */
function shippedModels(): KimiCodeCatalogModel[] {
    const provider = BUILTIN_PROVIDERS['kimi-code-plan'];
    if (provider === undefined) return [];
    return (provider.models ?? []).map(id => {
        const declared = SHIPPED_KIMI_CODE_METADATA[id];
        const contextWindow = getModelContextTokens(id, 'kimi-code-plan')
            || provider.maxContextTokens
            || 262_144;
        return {
            id,
            name: id,
            contextWindow,
            reasoningEfforts: [...(declared?.reasoningEfforts ?? [])],
            defaultReasoningEffort: declared?.defaultReasoningEffort ?? null,
            inputModalities: [...(declared?.inputModalities ?? ['text', 'image'])] as Array<'text' | 'image' | 'video'>,
            supportsToolUse: provider.supportsToolUse ?? true,
            ...(declared?.thinkingType === undefined ? {} : { thinkingType: declared.thinkingType }),
        };
    });
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

/**
 * 目录里可供选择的模型 id，顺序与服务端一致。
 *
 * 目录为空时返回 undefined，让调用方回落到随包清单：一份读不到的目录不该让选择器变空。
 */
export function kimiCatalogModelIds(catalog: readonly KimiCodeCatalogModel[]): string[] | undefined {
    if (catalog.length === 0) return undefined;
    return catalog.map(model => model.id);
}

/**
 * 有效默认模型。
 *
 * 线路声明的默认值只在该账号目录真的提供它时才算数，否则回落到目录第一项：把一个这个
 * 套餐并不提供的 id 当默认值，第一次请求就会失败。
 */
export function kimiCatalogDefaultModel(
    catalog: readonly KimiCodeCatalogModel[],
    shippedDefault: string,
): string {
    if (catalog.length === 0) return shippedDefault;
    if (catalog.some(model => model.id === shippedDefault)) return shippedDefault;
    return catalog[0]!.id;
}

/** 按 harness 的固定顺序排列档位，并丢掉不认识的取值。 */
function orderedEfforts(values: readonly string[]): ReasoningEffort[] {
    const present = new Set(values);
    return REASONING_EFFORT_VALUES.filter(effort => present.has(effort));
}

/**
 * 挑一个默认档位：目录声明 > 该模型的静态默认 > `high` > 第一个可用档位。
 *
 * 静态默认这一环不能省：目录只说有哪些档位、不说默认值是常态，而官方默认值往往就是
 * 最高档（K3.1 的 `max`）。一律预置 `high` 会把这份官方默认悄悄降级。
 */
function pickCatalogDefault(
    options: readonly ReasoningEffort[],
    declared: string | null,
    inherited: ReasoningEffort | undefined,
): ReasoningEffort {
    if (declared !== null && (options as readonly string[]).includes(declared)) return declared as ReasoningEffort;
    if (inherited !== undefined && options.includes(inherited)) return inherited;
    const enabled = options.filter(effort => effort !== 'none');
    if (enabled.includes('high')) return 'high';
    return enabled[0] ?? options[0]!;
}

/**
 * 目录模型在设置页里的思考档位。
 *
 * 只有目录真的说出档位、或者真的断言「不思考」时才作答。空阶梯不是「没有档位」的证据：
 * 从一张空表推出 fixed/toggle 的 `high` 是凭空造出来的能力，上游可能直接拒绝。所以除了
 * 显式 `no`，空阶梯一律返回 undefined，让调用方保留静态兜底——未知模型自然落到静态的
 * NO_REASONING，而不是带着猜出来的 `high` 发请求。
 *
 * `staticCapability` 是该模型的静态答案，只在目录缺默认档位时用来继承默认值。
 */
export function kimiCatalogReasoningCapability(
    model: KimiCodeCatalogModel,
    staticCapability?: ModelReasoningCapability,
): ModelReasoningCapability | undefined {
    // 显式无思考：共享形状里的 none。不返回 undefined——那会让静态表重新打开思考。
    if (model.thinkingType === 'no') return { kind: 'none', options: ['none'], defaultValue: 'none' };
    const options = orderedEfforts(model.reasoningEfforts).filter(isReasoningEffort);
    // 空阶梯（显式空数组或随包表的沉默）不产生档位：不给上游发明 fixed/toggle。
    if (options.length === 0) return undefined;
    const defaultValue = pickCatalogDefault(options, model.defaultReasoningEffort, staticCapability?.defaultValue);
    const enabled = options.filter(effort => effort !== 'none');
    const kind: ModelReasoningCapability['kind'] = enabled.length === 0
        ? 'toggle'
        : enabled.length === 1
            ? (options.includes('none') ? 'toggle' : 'fixed')
            : 'effort';
    return { kind, options, defaultValue };
}

/**
 * 设置页与请求归一化共用的优先级：目录/动态表先说话，静态表只在它沉默时作答。
 *
 * 未知的动态模型同样走这条线——静态表对它只会给出 `NO_REASONING`，直接采用会把一个
 * 目录刚刚声明为「始终思考」的模型错配成「完全无思考」。
 */
export function preferDeclaredReasoningCapability(
    declared: Readonly<Record<string, ModelReasoningCapability>> | undefined,
    key: string,
    staticCapability: ModelReasoningCapability,
): ModelReasoningCapability {
    return declared?.[key] ?? staticCapability;
}

/**
 * 提示词与压缩预算：输入上限与总窗口取小。
 *
 * 输入上限既不是总窗口也不是输出上限——它只说「提示词超过这里就会被拒」。拿它改总窗口会
 * 把一个 1M 模型显示成 256K；拿它当输出上限会砍掉模型本来就能生成的 token。所以它只在
 * 预算这一处生效。
 */
export function kimiCatalogContextBudget(model: KimiCodeCatalogModel): number {
    const input = model.maxInputTokens;
    if (input !== undefined && input > 0 && input < model.contextWindow) return input;
    return model.contextWindow;
}
