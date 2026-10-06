/**
 * 订阅线路账号的额度用量视图。
 *
 * 凭据永不越过 Webview 边界，额度是**非机密**的账号事实，因此可以随号池摘要一起送到卡片。
 * 结构刻意做得极窄：一组可画的仪表（已用比例、上下限文本、重置时刻）加一个失败原因，
 * 而不是把各路上游的原始账单负载透传出去。
 */

import { isRecord } from './protocolValidation';

/**
 * 我方自产仪表的固定标识。
 *
 * 上游给的套餐名是**数据**，直接原样显示；我方自己命名的仪表（「计费周期」这类）则只送
 * 这个键，由 Webview 按当前语言取词——把中文串塞进协议会让语言在 Extension Host 里被定死。
 */
export type SubscriptionQuotaMeterKey = 'cycle' | 'package';

/** 一个可画的额度仪表。 */
export interface SubscriptionQuotaMeter {
    id: string;
    /** 上游给出的名称（例如套餐名）；与 labelKey 二选一。 */
    label?: string;
    /** 我方命名的仪表；由 Webview 本地化。 */
    labelKey?: SubscriptionQuotaMeterKey;
    /** 已用比例 [0,1]。 */
    usedPercent?: number;
    /** 剩余比例 [0,1]。 */
    remainingPercent?: number;
    used?: string;
    limit?: string;
    /** Unix 毫秒重置时刻。 */
    resetsAt?: number;
}

/** 一个账号的额度快照。 */
export interface SubscriptionAccountQuota {
    meters: SubscriptionQuotaMeter[];
    /** 读取失败的原因；由 Webview 按语言包装后显示。 */
    failed?: boolean;
    /** 读取时刻（Unix 毫秒）。 */
    fetchedAt: number;
}

function optionalPercent(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.min(1, value));
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 60) : undefined;
}

function optionalInstant(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseMeterKey(value: unknown): SubscriptionQuotaMeterKey | undefined {
    return value === 'cycle' || value === 'package' ? value : undefined;
}

function parseMeter(value: unknown): SubscriptionQuotaMeter | undefined {
    if (!isRecord(value)) return undefined;
    const id = optionalString(value.id);
    if (id === undefined) return undefined;
    const label = optionalString(value.label);
    const labelKey = parseMeterKey(value.labelKey);
    // A meter with neither a name nor a known key would draw an unlabelled bar.
    if (label === undefined && labelKey === undefined) return undefined;
    const usedPercent = optionalPercent(value.usedPercent);
    const remainingPercent = optionalPercent(value.remainingPercent);
    const used = optionalString(value.used);
    const limit = optionalString(value.limit);
    const resetsAt = optionalInstant(value.resetsAt);
    return {
        id,
        ...(label === undefined ? {} : { label }),
        ...(labelKey === undefined ? {} : { labelKey }),
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(remainingPercent === undefined ? {} : { remainingPercent }),
        ...(used === undefined ? {} : { used }),
        ...(limit === undefined ? {} : { limit }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
    };
}

/**
 * 校验一份额度快照。
 *
 * 与号池摘要走同一条边界纪律：外部数据先收窄再使用。没有仪表的快照仍然有效——它表达的是
 * 「这条线路有额度概念，但此刻读不到」。
 */
export function parseSubscriptionAccountQuota(value: unknown): SubscriptionAccountQuota | undefined {
    if (!isRecord(value)) return undefined;
    const fetchedAt = optionalInstant(value.fetchedAt);
    if (fetchedAt === undefined) return undefined;
    const meters: SubscriptionQuotaMeter[] = [];
    if (Array.isArray(value.meters)) {
        for (const entry of value.meters) {
            const meter = parseMeter(entry);
            if (meter !== undefined) meters.push(meter);
        }
    }
    return {
        meters,
        ...(value.failed === true ? { failed: true } : {}),
        fetchedAt,
    };
}
