/**
 * Codex 订阅后端的「本轮续接状态」。
 *
 * 后端在每个响应的 `x-codex-turn-state` 头里回传一个不透明令牌，并期望同一轮
 * 的下一次请求原样回送——它据此续接该轮，而不是把整段历史重新读一遍。官方
 * CLI 就是这么做的。
 *
 * 三条纪律，缺一条就会变成猜测：
 * - **作用域恰好一轮**：官方客户端为每轮新建会话，并写明跨轮复用该令牌违反
 *   客户端/服务端契约、会造成路由错误。因此没有可靠的人类轮次标识时，宁可
 *   不回送（代价只是一次完整重发），也不跨请求复用。
 * - **后端不再下发就立即停止回送**：一个不再发送该头的后端已经不再承认它，
 *   重放过期值就是猜测。
 * - **账号作用域**：令牌由签发它的账号所有，签名者变化时丢弃而不是发给另一个
 *   账号。令牌不落盘、不日志、不进设置。
 */

import { CODEX_TURN_STATE_HEADER } from './modelCatalog';

/** 一个被跟踪的轮次状态。 */
export interface CodexTurnStateEntry {
    value: string;
    /** 签发该令牌的认证身份摘要；身份变化时该条目被丢弃。 */
    owner: string;
}

/** 长驻 Host 会服务大量会话与轮次，且没有任何信号表明它们结束，所以容量有界。 */
export const MAX_TRACKED_TURN_STATES = 256;

/**
 * 有界的轮次状态表。
 *
 * 条目是纯优化：未命中只意味着一次完整重发，永远不会影响正确性。
 */
export class CodexTurnStateTracker {
    private readonly entries = new Map<string, CodexTurnStateEntry>();

    constructor(private readonly maxEntries: number = MAX_TRACKED_TURN_STATES) {}

    /** 记录响应携带的续接状态；响应未携带（或为空）时清除该轮已有的值。 */
    remember(turnKey: string, response: { headers?: { get(name: string): string | null } | undefined }, owner: string): void {
        const raw = response.headers?.get(CODEX_TURN_STATE_HEADER);
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!value) {
            this.entries.delete(turnKey);
            return;
        }
        // 重新插入已有键必须刷新其年龄，所以先删后写。
        this.entries.delete(turnKey);
        this.entries.set(turnKey, { value, owner });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) break;
            this.entries.delete(oldest.value);
        }
    }

    /**
     * 本轮可以回送的续接状态，或 undefined。
     *
     * 由另一个认证身份签发的令牌会被丢弃而不是发出：它至多是给错机器的路由提示，
     * 最坏情况是重放该账号从未签发的状态。丢弃只损失一次完整重发。
     */
    take(turnKey: string, owner: string): string | undefined {
        const entry = this.entries.get(turnKey);
        if (entry === undefined) return undefined;
        if (entry.owner !== owner) {
            this.entries.delete(turnKey);
            return undefined;
        }
        return entry.value;
    }

    forget(turnKey: string): void {
        this.entries.delete(turnKey);
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}
