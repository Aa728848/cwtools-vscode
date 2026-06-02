/**
 * CWTools AI Module — Runner Tool Scheduler V2
 * 
 * Handles write-tool locks, superseded write check, and cross-platform
 * write target file path extraction. Implements hierarchical semaphore-based
 * concurrency limits for LSP, Network, and Global-Exclusive tool execution.
 */

import * as path from 'path';
import { getTopicStorageDir } from '../workspacePaths';
import { ToolConcurrencyClass } from '../types';

export const SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS = new Set<string>(['write_file']);

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
                    paths.push(process.platform === 'win32' ? path.resolve(trimmed) : trimmed.replace(/\//g, '\\'));
                } else if (isPosixAbs) {
                    paths.push(path.resolve(trimmed));
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
        case 'edit_pdx_block':
        case 'git_ops':
            add(args.file);
            break;
        case 'multi_replace_file_content':
            add(args.TargetFile);
            break;
        case 'replace_lines':
        case 'write_localisation':
            add(args.filePath);
            break;
        case 'apply_patch': {
            const patch = typeof args.patch === 'string' ? args.patch : '';
            for (const line of patch.split(/\r?\n/)) {
                const match = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
                if (!match) continue;
                const raw = match[1]!.trim();
                if (!raw || raw === '/dev/null') continue;
                add(raw.replace(/^"|"$/g, ''));
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
                paths.push(path.join(getTopicStorageDir(topicId || 'default', workspaceRoot), 'design_blueprint.md'));
            }
            break;
        case 'save_workflow':
            if (workspaceRoot) {
                const id = workflowId(args.id, args.title);
                if (id) paths.push(path.join(workspaceRoot, '.cwtools-ai', 'workflows', `${id}.md`));
            }
            break;
    }

    return [...new Set(paths)];
}

export class ToolSchedulerV2 {
    private static instance: ToolSchedulerV2 | undefined;

    // Concurrency Limit Semaphores
    private activeLspCount = 0;
    private lspQueue: (() => void)[] = [];
    private readonly MAX_LSP_CONCURRENCY = 4;

    private activeNetworkCount = 0;
    private networkQueue: (() => void)[] = [];
    private readonly MAX_NETWORK_CONCURRENCY = 2;

    // Global exclusive lock
    private globalLocked = false;
    private globalQueue: (() => void)[] = [];

    private constructor() {}

    public static getInstance(): ToolSchedulerV2 {
        if (!ToolSchedulerV2.instance) {
            ToolSchedulerV2.instance = new ToolSchedulerV2();
        }
        return ToolSchedulerV2.instance;
    }

    /**
     * Acquires the necessary concurrency permits based on the ToolConcurrencyClass.
     * Resolves when the lock is acquired. Returns a release function.
     */
    public async acquireLock(concurrencyClass: ToolConcurrencyClass): Promise<() => void> {
        if (concurrencyClass === 'parallel' || concurrencyClass === 'per-file-write') {
            // No global rate limit, safe to invoke instantly
            return () => {};
        }

        if (concurrencyClass === 'lsp-limited') {
            await this.waitLspPermit();
            return () => this.releaseLspPermit();
        }

        if (concurrencyClass === 'network-limited') {
            await this.waitNetworkPermit();
            return () => this.releaseNetworkPermit();
        }

        // global-exclusive and interactive get global exclusive lock
        await this.acquireGlobalLock();
        return () => this.releaseGlobalLock();
    }

    private waitLspPermit(): Promise<void> {
        if (this.activeLspCount < this.MAX_LSP_CONCURRENCY && !this.globalLocked) {
            this.activeLspCount++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.lspQueue.push(resolve);
        });
    }

    private releaseLspPermit(): void {
        this.activeLspCount--;
        this.processNextLsp();
    }

    private processNextLsp(): void {
        if (this.globalLocked) return;
        if (this.activeLspCount < this.MAX_LSP_CONCURRENCY && this.lspQueue.length > 0) {
            const resolve = this.lspQueue.shift();
            if (resolve) {
                this.activeLspCount++;
                resolve();
            }
        }
    }

    private waitNetworkPermit(): Promise<void> {
        if (this.activeNetworkCount < this.MAX_NETWORK_CONCURRENCY && !this.globalLocked) {
            this.activeNetworkCount++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.networkQueue.push(resolve);
        });
    }

    private releaseNetworkPermit(): void {
        this.activeNetworkCount--;
        this.processNextNetwork();
    }

    private processNextNetwork(): void {
        if (this.globalLocked) return;
        if (this.activeNetworkCount < this.MAX_NETWORK_CONCURRENCY && this.networkQueue.length > 0) {
            const resolve = this.networkQueue.shift();
            if (resolve) {
                this.activeNetworkCount++;
                resolve();
            }
        }
    }

    private acquireGlobalLock(): Promise<void> {
        if (
            !this.globalLocked &&
            this.activeLspCount === 0 &&
            this.activeNetworkCount === 0
        ) {
            this.globalLocked = true;
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.globalQueue.push(resolve);
        });
    }

    private releaseGlobalLock(): void {
        this.globalLocked = false;
        this.processNextGlobal();
    }

    private processNextGlobal(): void {
        if (this.globalQueue.length > 0) {
            const resolve = this.globalQueue.shift();
            if (resolve) {
                this.globalLocked = true;
                resolve();
            }
        } else {
            // Wake up queued tasks
            while (this.activeLspCount < this.MAX_LSP_CONCURRENCY && this.lspQueue.length > 0) {
                this.processNextLsp();
            }
            while (this.activeNetworkCount < this.MAX_NETWORK_CONCURRENCY && this.networkQueue.length > 0) {
                this.processNextNetwork();
            }
        }
    }
}

export const toolScheduler = ToolSchedulerV2.getInstance();
