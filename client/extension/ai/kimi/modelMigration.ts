/**
 * Kimi K2.5 退役后的**有效配置**迁移。
 *
 * 内置选项里移除 K2.5 之后，用户设置与 `~/.cwtools/agent-models.json` 里仍然留着
 * `kimi-k2.5`。那个 id 仍会被原样发出去，但服务端已不再提供，用户只会看到一次无法
 * 解释的失败。因此迁移放在**读取有效配置**的位置：纯函数、只在内存里替换、不写盘，
 * 老配置立刻落到 K3.1，而设置文件本身仍由用户决定何时改写。
 *
 * 只认 `provider === 'kimi'`（唯一提供过 K2.5 的线路）与精确 id；自定义 id、其它线路
 * 与其它模型一概不动。
 */

import type { ReasoningEffort } from '../types';

/** 已从内置选项移除的 model id → 取代它的 id。 */
export const KIMI_RETIRED_MODEL_IDS: Readonly<Record<string, string>> = {
    'kimi-k2.5': 'kimi-k3.1-pro',
};

/**
 * K3.1 家族的精确 id 形状。
 *
 * 两条线路的拼写不同（开放平台 `kimi-k3.1-pro`，订阅线路 `k3.1-pro`），所以
 * `kimi-` 前缀可选。K3 与 K2 家族不匹配：`k3` 后面必须是 `.1-pro`。
 */
export const KIMI_K31_FAMILY_MODEL_RE = /(?:^|\/)(?:kimi-)?k3[.]1-pro(?:-highspeed)?$/;

/** 曾提供 K2.5、并承载 K3.1 的两条 Kimi 线路。 */
const KIMI_PROVIDER_IDS = ['kimi', 'kimi-code-plan'] as const;

function normalizeProviderId(providerId: string | undefined): string {
    return providerId?.trim().toLowerCase() ?? '';
}

/** 去掉 UI 的 `(1M)` 之类的尾注并小写，与 providers.ts 的 modelName 同形。 */
function normalizedModelId(model: string): string {
    return model.trim().replace(/\s*\([^)]*\)$/, '').toLowerCase();
}

/** 该 id 是否属于 K3.1 家族（含 `-highspeed`），不看线路。 */
export function isKimiK31Model(model: string): boolean {
    return KIMI_K31_FAMILY_MODEL_RE.test(normalizedModelId(model));
}

/** 该 id 是否属于这两条 Kimi 线路。 */
export function isKimiProviderId(providerId: string | undefined): boolean {
    const provider = normalizeProviderId(providerId);
    return (KIMI_PROVIDER_IDS as readonly string[]).includes(provider);
}

/** 线路 + id 都落在 K3.1 家族上；K3.1 的请求形状只按这个判断生效。 */
export function isKimiK31ProviderModel(providerId: string | undefined, model: string): boolean {
    return isKimiProviderId(providerId) && isKimiK31Model(model);
}

/**
 * 把一个已退役的 Kimi model id 换成它的取代者。
 *
 * 只在 `provider === 'kimi'` 时生效：同一串 `kimi-k2.5` 出现在网关或自定义线路上是
 * 用户自己的选择，不该被改写。
 */
export function migrateKimiModelId(providerId: string | undefined, model: string): string {
    if (normalizeProviderId(providerId) !== 'kimi') return model;
    const replacement = KIMI_RETIRED_MODEL_IDS[normalizedModelId(model)];
    return replacement ?? model;
}

/**
 * 迁移后仍合法的 effort。
 *
 * K3.1 始终思考，`none` 没有线上表达：把它落到最低档 `low`，而不是让通用归一化把
 * 它读成家族默认的 `max`（那正好是用户想要的相反方向）。其余兼容档位原样保留。
 */
export function migrateKimiReasoningEffort(
    providerId: string | undefined,
    model: string,
    effort: ReasoningEffort,
): ReasoningEffort {
    if (!isKimiK31ProviderModel(providerId, model)) return effort;
    return effort === 'none' ? 'low' : effort;
}
