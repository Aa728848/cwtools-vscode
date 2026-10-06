/**
 * ChatGPT Codex 订阅模型目录。
 *
 * 订阅后端发布的目录才是「这个账号现在能调什么」的权威：它给出每个模型的
 * 真实上下文窗口、可用推理档位与输出详细程度。`oauthService.ts` 里的内置表
 * 是**兜底**：首次登录前、以及目录请求失败时由它作答。
 *
 * 目录按账号缓存：不同套餐看到的模型集合不同，用一个账号的目录回答另一个
 * 账号的选择器会凭空多出（或少出）模型。
 */

import { isRecord } from '../../../shared/protocolValidation';
import { CODEX_CHATGPT_MODELS } from './oauthService';

/** 官方 Codex CLI 发送的客户端版本；该端点要求此参数。 */
export const CODEX_CLIENT_VERSION = '0.99.0';

/**
 * 订阅侧的实时模型清单。
 *
 * 与公开的 `/v1/models` 不同，这个端点按**订阅权益**作答：本套餐可调用的模型、
 * 它们的真实上下文窗口，以及每个模型接受的推理档位。
 */
export const CODEX_MODELS_URL =
    `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;

/**
 * 订阅后端的 beta 闸门。
 *
 * 该后端以 beta 标志提供，官方 Codex CLI 一直发送这个头。缺它时请求面不同：
 * 当前后端宽容，但这正是上游收紧后会变成 400/403 的那一行。
 */
export const CODEX_OPENAI_BETA = 'responses=experimental';

/** 后端在响应头回传的本轮续接状态（同一轮的下一次请求原样回送）。 */
export const CODEX_TURN_STATE_HEADER = 'x-codex-turn-state';

/** 目录在本地复用多久之后才再次询问服务端。 */
const CATALOG_TTL_MS = 15 * 60_000;
/** 单次目录请求的网络预算；慢端点不能拖住选择器渲染。 */
const DISCOVERY_TIMEOUT_MS = 15_000;
/** 单次目录响应的条目上限，避免异常响应撑爆内存与选择器。 */
const MAX_CATALOG_ENTRIES = 500;

/**
 * 目录未声明 `default_verbosity` 时的保守取值。
 *
 * 官方客户端每轮都发送目录里的 `default_verbosity`（当前全部为 `low`）。
 * 整个不发 `text` 字段会让服务端套用隐含的 `medium`——一个从未打开过该设置
 * 的用户，会拿到比官方客户端更啰嗦、也更贵的回答。
 */
export const CODEX_DEFAULT_OUTPUT_VERBOSITY = 'low';

/** 一个模型在目录里的样子。 */
export interface CodexCatalogEntry {
    id: string;
    name: string;
    /** 目录声明的上下文窗口；未声明为 null。 */
    contextWindow: number | null;
    inputModalities: Array<'text' | 'image'>;
    /** 目录声明的推理档位；未声明时缺省，由调用方回落到内置表。 */
    reasoningEfforts?: string[];
    defaultReasoningEffort?: string | null;
    /** 目录是否声明了该模型的默认输出详细程度（即该模型接受 `text.verbosity`）。 */
    supportsVerbosity: boolean;
    defaultVerbosity: string | null;
}

/** 目录快照的持久化端口；由 Extension Host 提供实现（globalState / 文件）。 */
export interface CodexCatalogSnapshotStore {
    read(): Promise<unknown>;
    write(value: unknown): Promise<void>;
}

export interface CodexCatalogLoadOptions {
    fetchFn?: typeof fetch;
    headers: Record<string, string>;
    signal?: AbortSignal;
    /** 跳过缓存，重新询问服务端。 */
    force?: boolean;
    /** 账号身份；用于隔离不同套餐的目录。 */
    accountKey: string;
    snapshot?: CodexCatalogSnapshotStore;
}

interface CatalogCache {
    at: number;
    models: readonly CodexCatalogEntry[];
    key: string;
    /** false 表示这批条目是内置表在替代一次失败的请求。 */
    live: boolean;
}

let catalogCache: CatalogCache | null = null;
let catalogInFlight: { key: string; promise: Promise<readonly CodexCatalogEntry[]> } | null = null;
let snapshotRehydrated: Promise<void> | null = null;

/** 丢弃内存中的目录，让下一次加载重新访问服务端。 */
export function clearCachedCodexCatalog(): void {
    catalogCache = null;
    catalogInFlight = null;
    snapshotRehydrated = null;
}

/** 当前持有的目录；首次加载前为 undefined。 */
export function getCachedCodexCatalog(): readonly CodexCatalogEntry[] | undefined {
    return catalogCache?.models;
}

/** 当前持有的目录是否只是内置表在替代一次失败的请求。 */
export function isCodexCatalogFallback(): boolean {
    return catalogCache !== null && !catalogCache.live;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseModalities(value: unknown): Array<'text' | 'image'> | null {
    if (!Array.isArray(value)) return null;
    const out: Array<'text' | 'image'> = [];
    for (const item of value) {
        const name = asString(item);
        if (name === 'text' || name === 'image') out.push(name);
    }
    return out.length > 0 ? out : null;
}

/**
 * 目录声明的推理档位，按声明顺序保留。
 *
 * 后端把每个档位写成 `{ "effort": "high" }`；裸字符串同样接受，因为那是野外
 * 出现过的另一种写法。
 */
function parseEfforts(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
        const effort = asString(item) ?? asString(asRecord(item)?.effort);
        if (effort !== undefined && !out.includes(effort)) out.push(effort);
    }
    return out.length > 0 ? out : null;
}

/**
 * 某个目录 slug 是否是可以拿来对话的模型。
 *
 * 订阅目录里会混进**代码评审**专用 slug（`codex-auto-review`）。它出现在目录里只是因为
 * 该套餐拥有这条额度线，它不是一个对话模型：把它放进模型选择器会得到一个永远不可用的
 * 选项。因此评审类 slug 一律排除。
 *
 * 排除后目录可能变空。那**不是**「这个账号没有模型」，而是这份目录回答不了选择器——某些
 * 套餐的目录只带评审 slug 而不带任何对话模型。此时由内置表作答（见 getAccountStatus）。
 */
export function isCodexChatModelSlug(slug: string): boolean {
    return !/auto[-_]?review|[-_]review$|^review$/.test(slug.toLowerCase());
}

/**
 * 单个目录条目。
 *
 * 只读取后端确实声明的字段。从未见过的模型 id 也会产生条目——目录是「账号能
 * 调什么」的权威——但它没有声明的能力一律回落保守值，而不是猜测。
 */
function parseCatalogEntry(value: unknown): CodexCatalogEntry[] {
    const record = asRecord(value);
    if (record === undefined) return [];
    const id = asString(record.slug) ?? asString(record.id);
    if (id === undefined) return [];
    // 评审类 slug 不是对话模型，混入选择器只会得到一个不可用的选项。
    if (!isCodexChatModelSlug(id)) return [];
    const contextWindow = asNumber(record.context_window) ?? asNumber(record.contextWindow);
    const modalities = parseModalities(record.input_modalities);
    const efforts = parseEfforts(record.supported_reasoning_levels);
    const defaultVerbosity = asString(record.default_verbosity) ?? asString(record.defaultVerbosity);
    const shipped = CODEX_CHATGPT_MODELS.includes(id as typeof CODEX_CHATGPT_MODELS[number]);
    return [{
        id,
        name: asString(record.display_name) ?? asString(record.displayName) ?? id,
        contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : null,
        // 未声明模态：已知模型沿用内置表答案，其余按纯文本——两者中更窄的那个，
        // 不会把一个做不到的能力说成成立。
        inputModalities: modalities ?? (shipped ? ['text', 'image'] : ['text']),
        // undefined 而非 null：缺省表示「目录没有声明」，解析器须回落到内置表。
        ...(efforts !== null ? { reasoningEfforts: efforts } : {}),
        defaultReasoningEffort: asString(record.default_reasoning_level) ?? asString(record.defaultReasoningLevel) ?? null,
        // 只采信目录的显式声明；内置表覆盖的模型按官方客户端的既有行为视为支持。
        supportsVerbosity: defaultVerbosity !== undefined || shipped,
        defaultVerbosity: defaultVerbosity ?? (shipped ? CODEX_DEFAULT_OUTPUT_VERBOSITY : null),
    }];
}

/**
 * 读取目录响应。
 *
 * 文档形状是 `{ models: [...] }`，但裸数组同样接受，以免后端把信封拍平时
 * 被读成空目录。
 */
export function parseCodexCatalog(payload: unknown): CodexCatalogEntry[] {
    const record = asRecord(payload);
    const models = Array.isArray(payload) ? payload : record?.models;
    if (!Array.isArray(models)) return [];
    return models.slice(0, MAX_CATALOG_ENTRIES).flatMap(parseCatalogEntry);
}

/** 从持久化快照还原目录条目；形状不合法时返回 undefined。 */
export function parseCodexCatalogSnapshot(value: unknown): CodexCatalogEntry[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const models = value.slice(0, MAX_CATALOG_ENTRIES).flatMap(parseCatalogEntry);
    return models.length > 0 ? models : undefined;
}

/**
 * 读取本账号当前可调用的模型目录。
 *
 * 单飞且按账号隔离：Host 在为每个 Provider 构建选择器时会解析全部模型，没有
 * 单飞就会变成每个模型一次往返。
 */
export function loadCodexCatalog(options: CodexCatalogLoadOptions): Promise<readonly CodexCatalogEntry[]> {
    const key = options.accountKey;
    if (options.force !== true) {
        const cached = catalogCache;
        if (cached !== null && cached.key === key && Date.now() - cached.at < CATALOG_TTL_MS) {
            return Promise.resolve(cached.models);
        }
    }
    if (catalogInFlight !== null && catalogInFlight.key === key) return catalogInFlight.promise;

    const promise = performCatalogLoad(options).then(
        models => {
            if (catalogInFlight?.key === key) catalogInFlight = null;
            return models;
        },
        (error: unknown) => {
            if (catalogInFlight?.key === key) catalogInFlight = null;
            throw error;
        },
    );
    catalogInFlight = { key, promise };
    return promise;
}

async function performCatalogLoad(options: CodexCatalogLoadOptions): Promise<readonly CodexCatalogEntry[]> {
    const key = options.accountKey;
    const fetchFn = options.fetchFn ?? fetch;

    // 每个进程只从快照水合一次，让重启后的第一个选择器先读磁盘而不是等网络。
    if (options.snapshot !== undefined) {
        snapshotRehydrated ??= rehydrateSnapshot(options.snapshot, key);
        await snapshotRehydrated;
    }

    const cached = catalogCache;
    if (options.force !== true
        && cached !== null && cached.key === key && Date.now() - cached.at < CATALOG_TTL_MS) {
        return cached.models;
    }

    let models: readonly CodexCatalogEntry[];
    let live = false;
    try {
        const timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
        const signal = options.signal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal;
        const response = await fetchFn(CODEX_MODELS_URL, {
            method: 'GET',
            headers: { ...options.headers, accept: 'application/json' },
            signal,
        });
        if (!response.ok) throw new Error(`Codex model listing failed (${response.status}).`);
        const payload: unknown = await response.json().catch(() => undefined);
        const listing = parseCodexCatalog(payload);
        if (listing.length === 0) throw new Error('Codex model listing named no models this line understands.');
        models = listing;
        live = true;
        // 只持久化实时目录：一次失败的调用不得用内置表覆盖好的快照。
        void options.snapshot?.write([...models]).catch(() => undefined);
    } catch {
        // 失败的调用用当前已持有的目录作答；它可能是空的，调用方读作「用内置表」。
        models = getCachedCodexCatalog() ?? [];
        live = false;
    }
    catalogCache = { at: Date.now(), models, key, live };
    return models;
}

/** 尽力而为：快照缺失或损坏只会让缓存保持冷的，调用方随即发起网络请求。 */
async function rehydrateSnapshot(store: CodexCatalogSnapshotStore, key: string): Promise<void> {
    const snapshot = await store.read().catch(() => undefined);
    const models = parseCodexCatalogSnapshot(snapshot);
    if (models === undefined) return;
    if (catalogCache !== null) return;
    catalogCache = { at: Date.now(), models, key, live: true };
}

/**
 * 内置表覆盖的模型在目录不可用时的默认输出详细程度。
 *
 * 只有内置表确实列出的模型才返回取值：目录里没有记录的模型不猜，避免把一个
 * 模型可能拒收的字段强加给它。
 */
export function codexDefaultOutputVerbosity(model: string): string | undefined {
    if (!model) return undefined;
    const cached = catalogCache?.models.find(entry => entry.id === model);
    if (cached !== undefined) {
        return cached.supportsVerbosity
            ? (cached.defaultVerbosity ?? CODEX_DEFAULT_OUTPUT_VERBOSITY)
            : undefined;
    }
    return CODEX_CHATGPT_MODELS.includes(model as typeof CODEX_CHATGPT_MODELS[number])
        ? CODEX_DEFAULT_OUTPUT_VERBOSITY
        : undefined;
}
