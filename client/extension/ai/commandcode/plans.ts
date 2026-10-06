/**
 * Command Code 的订阅套餐。
 *
 * 逐条转录自官方 CLI 自带的套餐表——那是 `planId` 字符串**唯一**有人类可读名字的地方。
 * `/alpha/whoami` 对套餐只字未提，`/alpha/billing/subscriptions` 只给出机器 id
 * （`individual-goat`），因此卡片显示原始 id 等于什么都不显示。
 */

/** 一个订阅套餐，以及 CLI 给它分配的月度额度。 */
export interface CommandCodePlan {
    id: string;
    /** CLI 渲染的展示名，例如 `GOAT`。 */
    name: string;
    /** 该套餐授予的月度额度。 */
    monthlyCredits: number;
}

/**
 * 全部套餐，**长 id 在前**。
 *
 * 顺序有意义：服务端会追加后缀（`individual-pro-v1`），而不同套餐之间共用前缀
 * （`individual-pro` 同时是 `individual-pro-v1` 和 `individual-provider` 的前缀），所以必须
 * 先试最长的 id，否则 `individual-provider` 会被解析成 `Pro`。
 */
export const COMMAND_CODE_PLANS: readonly CommandCodePlan[] = [
    { id: 'individual-provider', name: 'Provider', monthlyCredits: 15 },
    { id: 'individual-pro-v1', name: 'Pro', monthlyCredits: 80 },
    { id: 'individual-goat', name: 'GOAT', monthlyCredits: 70 },
    { id: 'individual-ultra', name: 'Ultra', monthlyCredits: 300 },
    { id: 'individual-max', name: 'Max', monthlyCredits: 150 },
    { id: 'individual-pro', name: 'Pro', monthlyCredits: 30 },
    { id: 'individual-go', name: 'Go', monthlyCredits: 10 },
    { id: 'teams-pro', name: 'Teams Pro', monthlyCredits: 40 },
];

/**
 * 把一个 `planId` 解析成套餐。
 *
 * 服务端在大小写与分隔符上并不一致，因此先归一再比较，而且比较方式就是 CLI 用的前缀测试。
 *
 * @returns 匹配的套餐；id 缺失或无法识别时返回 null。
 */
export function resolveCommandCodePlan(planId: string | null | undefined): CommandCodePlan | null {
    if (planId === null || planId === undefined) return null;
    const normalized = planId.trim().toLowerCase().replace(/_/g, '-');
    if (normalized === '') return null;
    return COMMAND_CODE_PLANS.find(plan => normalized.startsWith(plan.id)) ?? null;
}

/** 一个套餐 id 的展示名；无法识别时回落原始 id，因此什么都不隐藏。 */
export function commandCodePlanLabel(planId: string | null | undefined): string | null {
    if (planId === null || planId === undefined || planId.trim() === '') return null;
    return resolveCommandCodePlan(planId)?.name ?? planId;
}
