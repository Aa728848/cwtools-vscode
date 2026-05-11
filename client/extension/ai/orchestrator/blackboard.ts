/**
 * Eddy CWTool Code — 增强版黑板系统
 *
 * 替代原有 sharedMemory (Map<string, {value: string}>)，提供：
 * - 类型化条目（file_snapshot / scope_info / entity_registry 等）
 * - 乐观锁写入（CAS — Compare-And-Swap）
 * - 前缀订阅（watch 机制）
 * - 分区容量管理 + LRU 驱逐
 * - 可序列化用于检查点
 */

import type {
    BlackboardEntry,
    BlackboardEntryType,
    BlackboardWriteResult,
    SerializedBlackboard,
} from './types';

/** 订阅回调的取消句柄 */
export interface BlackboardDisposable {
    dispose(): void;
}

/** 黑板配置 */
interface BlackboardConfig {
    /** 全局区最大条目数 */
    globalCapacity: number;
    /** 每 Agent 分区最大条目数 */
    perAgentCapacity: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: BlackboardConfig = {
    globalCapacity: 500,
    perAgentCapacity: 200,
};

/**
 * 增强版黑板 — 多 Agent 间的共享知识存储。
 *
 * 设计要点：
 * 1. 读操作永远非阻塞（直接 Map.get）
 * 2. 写操作支持乐观锁 CAS，避免覆盖冲突
 * 3. 支持前缀订阅，Agent 可监听特定 key 前缀的变更
 * 4. 按 authorAgentId 分区管理容量
 */
export class Blackboard {
    /** 主存储 */
    private entries = new Map<string, BlackboardEntry>();
    /** 前缀订阅表 */
    private watchers = new Map<string, Set<(entry: BlackboardEntry) => void>>();
    /** 配置 */
    private config: BlackboardConfig;

    constructor(config?: Partial<BlackboardConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ─── 读操作 ──────────────────────────────────────────────────────────────

    /** 读取一个条目 */
    read(key: string): BlackboardEntry | undefined {
        return this.entries.get(key);
    }

    /** 读取一个条目的值（便捷方法） */
    readValue(key: string): string | undefined {
        return this.entries.get(key)?.value;
    }

    /** 按类型查询所有条目 */
    queryByType(type: BlackboardEntryType): BlackboardEntry[] {
        const results: BlackboardEntry[] = [];
        for (const entry of this.entries.values()) {
            if (entry.type === type) results.push(entry);
        }
        return results;
    }

    /** 按 key 前缀查询 */
    queryByPrefix(prefix: string): BlackboardEntry[] {
        const results: BlackboardEntry[] = [];
        for (const [key, entry] of this.entries) {
            if (key.startsWith(prefix)) results.push(entry);
        }
        return results;
    }

    /** 获取实体注册表（entityId → creatorAgentId） */
    getEntityRegistry(): Map<string, string> {
        const registry = new Map<string, string>();
        for (const entry of this.entries.values()) {
            if (entry.type === 'entity_registry') {
                registry.set(entry.key, entry.authorAgentId);
            }
        }
        return registry;
    }

    /** 模糊搜索（key 或 value 包含查询串） */
    search(query: string, limit = 50): BlackboardEntry[] {
        const qLower = query.toLowerCase();
        const results: BlackboardEntry[] = [];
        for (const entry of this.entries.values()) {
            if (results.length >= limit) break;
            if (entry.key.toLowerCase().includes(qLower) ||
                entry.value.toLowerCase().includes(qLower)) {
                results.push(entry);
            }
        }
        return results;
    }

    /** 当前总条目数 */
    get size(): number {
        return this.entries.size;
    }

    // ─── 写操作（乐观锁） ────────────────────────────────────────────────────

    /**
     * 写入一个条目。
     *
     * @param key 条目键
     * @param value 条目值
     * @param type 数据类型标签
     * @param agentId 写入者 Agent ID
     * @param expectedVersion 可选 — 预期的当前版本号（CAS），不匹配则写入失败
     * @returns 写入结果
     */
    write(
        key: string,
        value: string,
        type: BlackboardEntryType,
        agentId: string,
        expectedVersion?: number,
    ): BlackboardWriteResult {
        const existing = this.entries.get(key);

        // CAS 检查：如果提供了预期版本号，且与实际不匹配，则拒绝写入
        if (expectedVersion !== undefined && existing) {
            if (existing.version !== expectedVersion) {
                return {
                    success: false,
                    conflict: `版本冲突: 预期 v${expectedVersion}，实际 v${existing.version}（由 ${existing.authorAgentId} 在 ${new Date(existing.timestamp).toISOString()} 写入）`,
                };
            }
        }

        const newVersion = existing ? existing.version + 1 : 1;
        const entry: BlackboardEntry = {
            key,
            value,
            type,
            version: newVersion,
            authorAgentId: agentId,
            timestamp: Date.now(),
        };

        this.entries.set(key, entry);

        // 容量管理：驱逐超限条目
        this.evictIfNeeded(agentId);

        // 通知订阅者
        this.notifyWatchers(key, entry);

        return { success: true, newVersion };
    }

    /**
     * 删除一个条目。
     * @returns 是否成功删除
     */
    delete(key: string): boolean {
        return this.entries.delete(key);
    }

    /** 清除指定 Agent 的所有条目 */
    clearAgent(agentId: string): number {
        let removed = 0;
        for (const [key, entry] of this.entries) {
            if (entry.authorAgentId === agentId) {
                this.entries.delete(key);
                removed++;
            }
        }
        return removed;
    }

    /** 清除全部条目 */
    clear(): void {
        this.entries.clear();
    }

    // ─── 订阅机制 ────────────────────────────────────────────────────────────

    /**
     * 监听指定 key 前缀的变更。
     *
     * @param prefix key 前缀（如 "entity:" 匹配所有以 "entity:" 开头的 key）
     * @param callback 变更回调
     * @returns 取消订阅的句柄
     */
    watch(prefix: string, callback: (entry: BlackboardEntry) => void): BlackboardDisposable {
        let callbacks = this.watchers.get(prefix);
        if (!callbacks) {
            callbacks = new Set();
            this.watchers.set(prefix, callbacks);
        }
        callbacks.add(callback);

        return {
            dispose: () => {
                callbacks!.delete(callback);
                if (callbacks!.size === 0) {
                    this.watchers.delete(prefix);
                }
            },
        };
    }

    /** 通知所有匹配前缀的订阅者 */
    private notifyWatchers(key: string, entry: BlackboardEntry): void {
        for (const [prefix, callbacks] of this.watchers) {
            if (key.startsWith(prefix)) {
                for (const cb of callbacks) {
                    try { cb(entry); } catch { /* 订阅者异常不影响写入 */ }
                }
            }
        }
    }

    // ─── 容量管理 ─────────────────────────────────────────────────────────────

    /** 驱逐超限条目（按分区管理） */
    private evictIfNeeded(currentAgentId: string): void {
        // 1. 检查该 Agent 的分区容量
        const agentEntries: Array<[string, BlackboardEntry]> = [];
        for (const [key, entry] of this.entries) {
            if (entry.authorAgentId === currentAgentId) {
                agentEntries.push([key, entry]);
            }
        }
        if (agentEntries.length > this.config.perAgentCapacity) {
            // 按时间排序，驱逐最旧的
            agentEntries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toEvict = agentEntries.length - this.config.perAgentCapacity;
            for (let i = 0; i < toEvict; i++) {
                this.entries.delete(agentEntries[i]![0]);
            }
        }

        // 2. 检查全局容量
        if (this.entries.size > this.config.globalCapacity) {
            // 全局驱逐：按时间排序，驱逐最旧的
            const all = [...this.entries.entries()]
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toEvict = this.entries.size - this.config.globalCapacity;
            for (let i = 0; i < toEvict; i++) {
                this.entries.delete(all[i]![0]);
            }
        }
    }

    // ─── 序列化 / 反序列化 ───────────────────────────────────────────────────

    /** 序列化为检查点快照 */
    snapshot(): SerializedBlackboard {
        return {
            entries: [...this.entries.entries()],
            timestamp: Date.now(),
        };
    }

    /** 从检查点快照恢复 */
    restore(data: SerializedBlackboard): void {
        this.entries.clear();
        for (const [key, entry] of data.entries) {
            this.entries.set(key, entry);
        }
    }

    // ─── 兼容层（适配旧 sharedMemory API） ──────────────────────────────────

    /**
     * 兼容旧的 set_memory 工具调用。
     * 将纯 KV 写入映射为 free_text 类型的 Blackboard 条目。
     */
    legacySet(key: string, value: string): void {
        this.write(key, value, 'free_text', '__legacy__');
    }

    /**
     * 兼容旧的 get_memory 工具调用。
     */
    legacyGet(key: string): { found: boolean; value?: string } {
        const entry = this.entries.get(key);
        return entry ? { found: true, value: entry.value } : { found: false };
    }

    /**
     * 兼容旧的 search_memory 工具调用。
     */
    legacySearch(query: string): { found: boolean; count: number; matches: Array<{ key: string; preview: string }> } {
        const entries = this.search(query);
        const matches = entries.map(e => {
            let preview = e.value;
            if (preview.length > 150) preview = preview.substring(0, 150) + '...';
            return { key: e.key, preview };
        });
        return { found: matches.length > 0, count: matches.length, matches };
    }
}
