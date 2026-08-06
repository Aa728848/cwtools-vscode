/**
 * CWTools AI Module — Runner Tool Scheduler V2
 * 
 * Handles write-tool locks, superseded write check, and cross-platform
 * write target file path extraction. Implements hierarchical semaphore-based
 * concurrency limits for LSP, Network, and Global-Exclusive tool execution.
 */

import * as path from 'path';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import { ToolConcurrencyClass } from '../types';

export const SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS = new Set<string>(['write_file']);

/** Resolve sibling localisation files, including Stellaris' per-language directories. */
export function getLocalisationTransactionTargets(filePath: string, languages: readonly string[]): Array<{ languageTag: string; filePath: string }> {
    const parent = path.dirname(filePath);
    const parentName = path.basename(parent).toLowerCase();
    const grandParent = path.dirname(parent);
    const grandParentName = path.basename(grandParent).toLowerCase();
    const hasLanguageDirectory = grandParentName === 'localisation' || grandParentName === 'localization';
    const baseName = path.basename(filePath).replace(/\.yml$/i, '').replace(/_l_[a-z_]+$/i, '');
    const seen = new Set<string>();
    const targets: Array<{ languageTag: string; filePath: string }> = [];
    for (const rawLanguage of languages) {
        const normalized = rawLanguage.trim().toLowerCase().replace(/^l_/, '');
        if (!normalized || !/^[a-z][a-z_]*$/.test(normalized)) continue;
        const languageTag = `l_${normalized}`;
        if (seen.has(languageTag)) continue;
        seen.add(languageTag);
        const targetDir = hasLanguageDirectory && parentName !== 'localisation' && parentName !== 'localization'
            ? path.join(grandParent, normalized)
            : parent;
        targets.push({ languageTag, filePath: path.join(targetDir, `${baseName}_${languageTag}.yml`) });
    }
    return targets;
}

type SchedulerQueueKind = 'lsp' | 'network' | 'global';

interface SchedulerWaiter {
    resolve: () => void;
    reject: (reason?: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export function getAgentToolTargetFiles(
    toolName: string,
    args: Record<string, unknown>,
    workspaceRoot?: string,
    topicId?: string
): string[] {
    const paths: string[] = [];
    const add = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            const trimmed = value.trim();
            if (workspaceRoot) {
                const isWinAbs = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
                const isPosixAbs = trimmed.startsWith('/');
                if (isWinAbs) {
                    paths.push(path.win32.resolve(trimmed));
                } else if (isPosixAbs) {
                    paths.push(path.resolve(trimmed));
                } else if (/^[a-zA-Z]:[\\/]/.test(workspaceRoot) || workspaceRoot.startsWith('\\\\')) {
                    paths.push(path.win32.resolve(workspaceRoot, trimmed));
                } else {
                    paths.push(path.resolve(workspaceRoot, trimmed));
                }
            } else {
                paths.push(trimmed);
            }
        }
    };
    const workflowId = (value: unknown, fallback: unknown): string | undefined => {
        const source = String(value || fallback || '').trim().toLowerCase();
        return source
            .replace(/[^a-z0-9_.-]+/g, '-')
            .replace(/^[.-]+|[.-]+$/g, '')
            .slice(0, 80);
    };

    switch (toolName) {
        case 'write_file':
        case 'git_ops':
            add(args.file);
            break;
        case 'edit_file':
            add(args.filePath);
            break;
        case 'read_file':
        case 'get_pdx_block':
        case 'get_file_context':
        case 'get_completion_at':
        case 'go_to_definition':
        case 'find_references':
        case 'hover_symbol':
        case 'rename_symbol':
            add(args.file);
            break;
        case 'replace_lines':
            add(args.filePath);
            break;
        case 'write_localisation': {
            const languages = Array.isArray(args.languages)
                ? args.languages.filter((value): value is string => typeof value === 'string')
                : [];
            if (languages.length > 0 && typeof args.filePath === 'string') {
                for (const target of getLocalisationTransactionTargets(args.filePath, languages)) add(target.filePath);
            } else {
                add(args.filePath);
            }
            break;
        }
        case 'deploy_mod_asset':
            if (workspaceRoot && typeof args.targetRelativePath === 'string') {
                paths.push(path.resolve(workspaceRoot, args.targetRelativePath));
            } else {
                add(args.targetRelativePath);
            }
            break;
        case 'write_design_blueprint':
            if (workspaceRoot) {
                const blueprintDir = getPrivateTopicStorageDir(topicId || 'default', workspaceRoot);
                paths.push(path.join(blueprintDir, 'design_blueprint.md'));
                paths.push(path.join(blueprintDir, 'design_blueprint.json'));
            }
            break;
        case 'save_workflow':
            if (workspaceRoot) {
                const id = workflowId(args.id, args.title);
                if (id) paths.push(path.join(workspaceRoot, '.cwtools', 'workflows', `${id}.md`));
            }
            break;
    }

    return [...new Set(paths)];
}

export class ToolSchedulerV2 {
    private static instance: ToolSchedulerV2 | undefined;

    // Concurrency Limit Semaphores
    private activeLspCount = 0;
    private lspQueue: SchedulerWaiter[] = [];
    private readonly MAX_LSP_CONCURRENCY = 4;

    private activeNetworkCount = 0;
    private networkQueue: SchedulerWaiter[] = [];
    private readonly MAX_NETWORK_CONCURRENCY = 2;

    // Global exclusive lock
    private globalLocked = false;
    private globalQueue: SchedulerWaiter[] = [];

    private constructor() {}

    public static getInstance(): ToolSchedulerV2 {
        if (!ToolSchedulerV2.instance) {
            ToolSchedulerV2.instance = new ToolSchedulerV2();
        }
        return ToolSchedulerV2.instance;
    }

    public static createForTesting(): ToolSchedulerV2 {
        return new ToolSchedulerV2();
    }

    /**
     * Acquires the necessary concurrency permits based on the ToolConcurrencyClass.
     * Resolves when the lock is acquired. Returns a release function.
     */
    public async acquireLock(concurrencyClass: ToolConcurrencyClass, abortSignal?: AbortSignal): Promise<() => void> {
        if (abortSignal?.aborted) {
            return Promise.reject(this.getAbortReason(abortSignal));
        }

        if (concurrencyClass === 'parallel' || concurrencyClass === 'per-file-write') {
            // No global rate limit, safe to invoke instantly
            return () => {};
        }

        if (concurrencyClass === 'lsp-limited') {
            await this.waitLspPermit(abortSignal);
            return () => this.releaseLspPermit();
        }

        if (concurrencyClass === 'network-limited') {
            await this.waitNetworkPermit(abortSignal);
            return () => this.releaseNetworkPermit();
        }

        // global-exclusive and interactive get global exclusive lock
        await this.acquireGlobalLock(abortSignal);
        return () => this.releaseGlobalLock();
    }

    private waitLspPermit(abortSignal?: AbortSignal): Promise<void> {
        if (this.canStartLimitedWork(this.activeLspCount, this.MAX_LSP_CONCURRENCY)) {
            this.activeLspCount++;
            return Promise.resolve();
        }
        return this.enqueueWaiter(this.lspQueue, 'lsp', abortSignal);
    }

    private releaseLspPermit(): void {
        this.activeLspCount = Math.max(0, this.activeLspCount - 1);
        this.scheduleNext();
    }

    private waitNetworkPermit(abortSignal?: AbortSignal): Promise<void> {
        if (this.canStartLimitedWork(this.activeNetworkCount, this.MAX_NETWORK_CONCURRENCY)) {
            this.activeNetworkCount++;
            return Promise.resolve();
        }
        return this.enqueueWaiter(this.networkQueue, 'network', abortSignal);
    }

    private releaseNetworkPermit(): void {
        this.activeNetworkCount = Math.max(0, this.activeNetworkCount - 1);
        this.scheduleNext();
    }

    private acquireGlobalLock(abortSignal?: AbortSignal): Promise<void> {
        if (this.canStartGlobalWork()) {
            this.globalLocked = true;
            return Promise.resolve();
        }
        return this.enqueueWaiter(this.globalQueue, 'global', abortSignal);
    }

    private releaseGlobalLock(): void {
        this.globalLocked = false;
        this.scheduleNext();
    }

    private canStartGlobalWork(): boolean {
        return !this.globalLocked && this.activeLspCount === 0 && this.activeNetworkCount === 0;
    }

    private canStartLimitedWork(activeCount: number, maxCount: number): boolean {
        return activeCount < maxCount && !this.globalLocked && this.globalQueue.length === 0;
    }

    private enqueueWaiter(queue: SchedulerWaiter[], kind: SchedulerQueueKind, abortSignal?: AbortSignal): Promise<void> {
        if (abortSignal?.aborted) {
            return Promise.reject(this.getAbortReason(abortSignal));
        }

        return new Promise<void>((resolve, reject) => {
            const waiter: SchedulerWaiter = { resolve, reject, signal: abortSignal };
            waiter.onAbort = () => {
                this.removeWaiter(kind, waiter);
                reject(this.getAbortReason(abortSignal));
                this.scheduleNext();
            };
            if (abortSignal) {
                abortSignal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            queue.push(waiter);
        });
    }

    private getAbortReason(abortSignal?: AbortSignal): Error {
        const reason = abortSignal?.reason;
        const error = new Error(reason instanceof Error
            ? reason.message
            : typeof reason === 'string'
                ? reason
                : 'Scheduler wait aborted');
        error.name = 'AbortError';
        return error;
    }

    private removeWaiter(kind: SchedulerQueueKind, waiter: SchedulerWaiter): void {
        const queue = kind === 'lsp'
            ? this.lspQueue
            : kind === 'network'
                ? this.networkQueue
                : this.globalQueue;
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
    }

    private resolveWaiter(waiter: SchedulerWaiter): void {
        if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        waiter.resolve();
    }

    private scheduleNext(): void {
        if (this.globalLocked) return;

        if (this.globalQueue.length > 0) {
            if (!this.canStartGlobalWork()) return;
            const waiter = this.globalQueue.shift();
            if (waiter) {
                this.globalLocked = true;
                this.resolveWaiter(waiter);
            }
            return;
        }

        while (this.canStartLimitedWork(this.activeLspCount, this.MAX_LSP_CONCURRENCY) && this.lspQueue.length > 0) {
            const waiter = this.lspQueue.shift();
            if (waiter) {
                this.activeLspCount++;
                this.resolveWaiter(waiter);
            }
        }

        while (this.canStartLimitedWork(this.activeNetworkCount, this.MAX_NETWORK_CONCURRENCY) && this.networkQueue.length > 0) {
            const waiter = this.networkQueue.shift();
            if (waiter) {
                this.activeNetworkCount++;
                this.resolveWaiter(waiter);
            }
        }
    }
}

export const toolScheduler = ToolSchedulerV2.getInstance();
