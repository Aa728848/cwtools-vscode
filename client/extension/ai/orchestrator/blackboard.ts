/** 
* Eddy CWTool Code — enhanced blackboard system 
* 
* Replaces the original sharedMemory (Map<string, {value: string}>) and provides: 
* - typed entries (file_snapshot/scope_info/entity_registry etc.) 
* - Optimistic locking for writing (CAS — Compare-And-Swap) 
* - prefix subscription (watch mechanism) 
* - Partition capacity management + LRU eviction 
* - serializable for checkpointing 
*/

import type {
    BlackboardEntry,
    BlackboardEntryType,
    BlackboardWriteResult,
    SerializedBlackboard,
} from './types';
import { runLedger, RunLedger } from '../runner/runLedger';

/** Cancellation handle of subscription callback */
export interface BlackboardDisposable {
    dispose(): void;
}

/** Blackboard configuration */
interface BlackboardConfig {
    /** Maximum number of entries in the global zone */
    globalCapacity: number;
    /** Maximum number of entries per Agent partition */
    perAgentCapacity: number;
}

/**Default configuration */
const DEFAULT_CONFIG: BlackboardConfig = {
    globalCapacity: 500,
    perAgentCapacity: 200,
};

/** 
* Enhanced Blackboard - Shared knowledge storage among multiple Agents. 
* 
*Design points: 
* 1. Read operations are always non-blocking (direct Map.get) 
* 2. Write operations support optimistic locking CAS to avoid overwriting conflicts 
* 3. Supports prefix subscription, Agent can monitor changes in specific key prefixes 
* 4. Manage capacity by authorAgentId partition 
*/
export class Blackboard {
    /** Main storage */
    private entries = new Map<string, BlackboardEntry>();
    /** Prefix subscription table */
    private watchers = new Map<string, Set<(entry: BlackboardEntry) => void>>();
    /** Configuration */
    private config: BlackboardConfig;

    constructor(config?: Partial<BlackboardConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ─── Read operation ────────────────────────────────────────────────────────

    /** Read an entry */
    read(key: string): BlackboardEntry | undefined {
        const entry = this.entries.get(key);
        const latestRunId = RunLedger.getLatestActiveRunId();
        if (latestRunId && entry) {
            runLedger.appendEvent(latestRunId, 'blackboard_read', {
                key,
                type: entry.type,
                version: entry.version,
                authorAgentId: entry.authorAgentId
            }).catch(() => {});
        }
        return entry;
    }

    /** Read the value of an entry (convenience method) */
    readValue(key: string): string | undefined {
        const entry = this.read(key);
        return entry?.value;
    }

    /** Query all entries by type */
    queryByType(type: BlackboardEntryType): BlackboardEntry[] {
        const results: BlackboardEntry[] = [];
        for (const entry of this.entries.values()) {
            if (entry.type === type) results.push(entry);
        }
        return results;
    }

    /** Query by key prefix */
    queryByPrefix(prefix: string): BlackboardEntry[] {
        const results: BlackboardEntry[] = [];
        for (const [key, entry] of this.entries) {
            if (key.startsWith(prefix)) results.push(entry);
        }
        return results;
    }

    /** Get the entity registry (entityId → creatorAgentId) */
    getEntityRegistry(): Map<string, string> {
        const registry = new Map<string, string>();
        for (const entry of this.entries.values()) {
            if (entry.type === 'entity_registry') {
                registry.set(entry.key, entry.authorAgentId);
            }
        }
        return registry;
    }

    /** Fuzzy search (key or value contains query string) */
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

    /** Current total number of entries */
    get size(): number {
        return this.entries.size;
    }

    // ─── Write operation (optimistic locking) ────────────────────────────────────────────────

    /** 
* Write an entry. 
* 
* @param key entry key 
* @param value entry value 
* @param type data type tag 
* @param agentId Writer Agent ID 
* @param expectedVersion optional — the expected current version number (CAS), if it does not match, the write will fail 
* @returns write results 
*/
    write(
        key: string,
        value: string,
        type: BlackboardEntryType,
        agentId: string,
        expectedVersion?: number,
    ): BlackboardWriteResult {
        const existing = this.entries.get(key);

        // CAS check: if an expected version number is provided and it doesn't match the actual one, reject the write
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

        // Capacity management: evict over-limit entries
        this.evictIfNeeded(agentId);

        // Notify subscribers
        this.notifyWatchers(key, entry);

        // 🌟 记录黑板写入事件至 Ledger
        const latestRunId = RunLedger.getLatestActiveRunId();
        if (latestRunId) {
            runLedger.appendEvent(latestRunId, 'blackboard_write', {
                key,
                type,
                version: newVersion,
                authorAgentId: agentId,
                valuePreview: value.length > 200 ? value.substring(0, 200) + '...' : value
            }).catch(() => {});
        }

        return { success: true, newVersion };
    }

    /** 
* Delete an entry. 
* @returns Whether the deletion was successful 
*/
    delete(key: string): boolean {
        return this.entries.delete(key);
    }

    /** Clear all entries of the specified Agent */
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

    /** Clear all entries */
    clear(): void {
        this.entries.clear();
    }

    // ───Subscription mechanism ───────────────────────────────────────────────────────

    /** 
* Monitor changes to the specified key prefix. 
* 
* @param prefix key prefix (such as "entity:" matches all keys starting with "entity:") 
* @param callback change callback 
* @returns Unsubscription handle 
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

    /** Notify all subscribers matching the prefix */
    private notifyWatchers(key: string, entry: BlackboardEntry): void {
        for (const [prefix, callbacks] of this.watchers) {
            if (key.startsWith(prefix)) {
                for (const cb of callbacks) {
                    try { cb(entry); } catch { /* Subscriber exception does not affect writing */ }
                }
            }
        }
    }

    // ─── Capacity Management ────────────────────────────────────────────────────────

    /** Evict over-limit entries (managed by partition) */
    private evictIfNeeded(currentAgentId: string): void {
        // 1. Check the partition capacity of the Agent
        const agentEntries: Array<[string, BlackboardEntry]> = [];
        for (const [key, entry] of this.entries) {
            if (entry.authorAgentId === currentAgentId) {
                agentEntries.push([key, entry]);
            }
        }
        if (agentEntries.length > this.config.perAgentCapacity) {
            // Sort by time, evict the oldest
            agentEntries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toEvict = agentEntries.length - this.config.perAgentCapacity;
            for (let i = 0; i < toEvict; i++) {
                this.entries.delete(agentEntries[i]![0]);
            }
        }

        // 2. Check global capacity
        if (this.entries.size > this.config.globalCapacity) {
            // Global eviction: sort by time, evict the oldest
            const all = [...this.entries.entries()]
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toEvict = this.entries.size - this.config.globalCapacity;
            for (let i = 0; i < toEvict; i++) {
                this.entries.delete(all[i]![0]);
            }
        }
    }

    // ─── Serialization / Deserialization ────────────────────────────────────────────────

    /** Serialize to checkpoint snapshot */
    snapshot(): SerializedBlackboard {
        return {
            entries: [...this.entries.entries()],
            timestamp: Date.now(),
        };
    }

    /** Restore from checkpoint snapshot */
    restore(data: SerializedBlackboard): void {
        this.entries.clear();
        for (const [key, entry] of data.entries) {
            this.entries.set(key, entry);
        }
    }

    // ─── Compatibility layer (adapted to the old sharedMemory API) ──────────────────────────────────

    /** 
* Compatible with old set_memory tool calls. 
* Write pure KV to a Blackboard entry mapped to type free_text. 
*/
    legacySet(key: string, value: string): void {
        this.write(key, value, 'free_text', '__legacy__');
    }

    /** 
* Compatible with old get_memory tool calls. 
*/
    legacyGet(key: string): { found: boolean; value?: string } {
        const entry = this.entries.get(key);
        return entry ? { found: true, value: entry.value } : { found: false };
    }

    /** 
* Compatible with old search_memory tool calls. 
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
