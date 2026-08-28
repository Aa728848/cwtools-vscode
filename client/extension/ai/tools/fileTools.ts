/**
 * File Tool Handler - read, write, edit, patch, and directory operations.
 *
 * Includes the OpenCode Replacer Suite (8 fuzzy-match strategies) ported from
 * opencode/packages/opencode/src/tool/edit.ts.
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { parsePdx, PdxNode } from '../../guiParser';
import { tokenize, TokenType } from '../../pdxTokenizer';
import type { ValidationError } from '../types';
import { getCachedFile, setCachedFile } from '../fileCache';
import { getToolResultBudget } from '../contextBudget';
import { fuzzyReplace, stripLineNumberPrefixes, previewMatch, unicodeNormalize } from './replacerSuite';
import {
    GUARDED_ERROR_CLASSES,
    ReplacerError,
    replacerKindToErrorClass,
    signatureKey,
    hashAnchor,
    type EditErrorClass,
    type FailureSignature,
} from './editFailure';
import { diagnosticMetadata } from './diagnosticMetadata';
import { diagnosticCodeString } from '../../diagnosticI18n';
import { getPrivateTopicStorageDir, canonicalPathKey } from '../workspacePaths';
import { isPlanModeCardArtifactFile } from '../planModeGuard';
import { isPathInsideOrEqual } from '../../pathScope';
import {
    isSecuritySandboxDisabled,
    resolveReadablePathInput,
    resolveWorkspacePathInput,
    type WorkspacePathResolution,
} from '../workspaceSandbox';
import { GRAPHICS_EXTS, matchesExt } from '../../fileExtensions';
import { getLocalisationTransactionTargets } from '../runner/toolScheduler';
import {
    createDiagnosticSnapshot,
    diffDiagnosticSnapshots,
    type DiagnosticDelta,
    type DiagnosticSnapshot,
    type DiagnosticStatus,
} from '../runner/diagnosticSnapshot';

// - Shared file-system helpers -

/** Recursively find files with a given extension under `dir`. */
export function findFiles(dir: string, ext: string, maxFiles = 500): string[] {
    const results: string[] = [];
    try { walkDir(dir, ext, results, maxFiles); } catch { /* skip */ }
    return results;
}

function walkDir(dir: string, ext: string, results: string[], maxFiles: number): void {
    if (results.length >= maxFiles) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (results.length >= maxFiles) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                walkDir(fullPath, ext, results, maxFiles);
            }
        } else if (matchesExt(entry.name, ext)) {
            results.push(fullPath);
        }
    }
}

// - Context type -

/** Structural type for the properties FileToolHandler reads from the executor. */
export interface FileToolContext {
    readonly workspaceRoot: string;
    fileWriteMode: 'confirm' | 'auto';
    onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    onAutoWritten?: (file: string, isNewFile: boolean) => void;
    vfsOverlay?: Map<string, string>;
    vfsLocks?: Map<string, Promise<void>>;
    /** Step callback for real-time UI events (Fallback, overwritten by AgentToolContext) */
    onStep?: (step: import('../types').AgentStep) => void;
    /** Optional: Get LSP LanguageClient for diagnostic freshness query */
    client?: import('vscode-languageclient/node').LanguageClient;
}

// - Handler class -

export class FileToolHandler {
    /** Per-file edit failure counter - escalates errors for all file types */
    private editFailCount = new Map<string, number>();

    /**
     * Anchor-aware repeated write-failure guard (P0 design 1). Keyed by
     * signatureKey({scopeId, tool, pathKey, anchorHash, errorClass}); values
     * count consecutive failures of the SAME anchor. Clearing is preview-first
     * and evidence-based: a signature only dies when the side-effect-free
     * preview proves the anchor now succeeds (replace_lines self-correction
     * often changes line numbers with the file content untouched, so a
     * content-hash precondition would false-block it). Sub-agents share this
     * executor, so the scopeId in every key keeps sibling budgets isolated.
     */
    private failureSignatures = new Map<string, { count: number }>();
    private static readonly ANCHOR_GUARD_MAX_SIGNATURES = 256;
    private static readonly ANCHOR_GUARD_BLOCK_THRESHOLD = 2;

    constructor(private ctx: FileToolContext) { }

    /** Canonical file key shared by locks, counters and guard signatures. */
    private pathKey(filePath: string): string {
        return canonicalPathKey(filePath, this.ctx.workspaceRoot);
    }

    private scopeOf(context?: import('../types').AgentToolContext): string {
        return context?.scopeId ?? 'top';
    }

    /**
     * Normalize an anchor the same way the replacer/guards do before matching
     * (line-number prefixes, line endings, unicode), so the guard signature is
     * stable across formatting-equivalent intents.
     */
    private normalizeAnchorText(raw: string): string {
        const stripped = stripLineNumberPrefixes(raw) ?? raw;
        return unicodeNormalize(this.convertLineEnding(this.normalizeLineEndings(stripped), '\n'));
    }

    /**
     * Pre-execution anchor-guard check. Returns a block message when this
     * exact anchor failed >= threshold times and a side-effect-free preview
     * shows it still cannot succeed. Clears the signature (evidence-based)
     * when the file changed and the anchor is satisfiable again.
     */
    private checkAnchorGuard(
        base: Omit<FailureSignature, 'errorClass'>,
        filePath: string,
        preview: () => EditErrorClass | null,
    ): string | null {
        const trackedKeys = [...GUARDED_ERROR_CLASSES].map(errorClass => ({
            errorClass,
            key: signatureKey({ ...base, errorClass }),
        }));
        if (!trackedKeys.some(({ key }) =>
            (this.failureSignatures.get(key)?.count ?? 0) >= FileToolHandler.ANCHOR_GUARD_BLOCK_THRESHOLD)) {
            return null;
        }

        const currentErrorClass = preview();
        if (currentErrorClass === null) {
            for (const { key } of trackedKeys) this.failureSignatures.delete(key);
            return null;
        }
        if (!GUARDED_ERROR_CLASSES.has(currentErrorClass)) return null;

        const key = signatureKey({ ...base, errorClass: currentErrorClass });
        const state = this.failureSignatures.get(key);
        if (!state || state.count < FileToolHandler.ANCHOR_GUARD_BLOCK_THRESHOLD) return null;
        const basename = path.basename(filePath);
        return `edit BLOCKED by anchor guard for ${basename}: this exact edit (same file + same anchor) already failed ${state.count} times with ${currentErrorClass} and the anchor still cannot succeed. Do NOT retry it unchanged. MANDATORY: call read_file on this file to see its CURRENT content, then choose a different anchor (or fresh line numbers for replace_lines). If the section was already modified as intended, move on instead of re-applying.`;
    }

    /** Record one consecutive failure of the same anchor (bounded LRU). */
    private recordAnchorFailure(
        base: Omit<FailureSignature, 'errorClass'>,
        errorClass: EditErrorClass,
    ): void {
        if (!GUARDED_ERROR_CLASSES.has(errorClass)) return;
        const key = signatureKey({ ...base, errorClass });
        const prev = this.failureSignatures.get(key);
        if (prev) this.failureSignatures.delete(key); // refresh LRU position
        this.failureSignatures.set(key, { count: (prev?.count ?? 0) + 1 });
        while (this.failureSignatures.size > FileToolHandler.ANCHOR_GUARD_MAX_SIGNATURES) {
            const oldest = this.failureSignatures.keys().next().value;
            if (oldest === undefined) break;
            this.failureSignatures.delete(oldest);
        }
    }

    /**
     * Build tiered escalation hints based on per-file edit failure count.
     * - YML files -> always redirect to write_localisation
     * - Other files -> gentle hint at 3+, budget exhaustion at 5+
     */
    private buildEditEscalationHint(filePath: string, failCount: number): string {
        const basename = path.basename(filePath);
        if (matchesExt(filePath, '.yml') && this.isLocalisationPath(filePath)) {
            return `\n\nWarning: YML BLOCKED (failure #${failCount}): You MUST NOT use generic edit tools (edit_file/write_file/replace_lines) for .yml files. Use write_localisation(filePath, language, entries) instead - it handles encoding, formatting, and insertion correctly.`;
        }
        if (failCount >= 5) {
            return `\n\nStop: EDIT BUDGET EXHAUSTED for ${basename} (${failCount} failures). STOP editing this file. Add \`# TODO\` comments for remaining issues and move on to other files.`;
        }
        if (failCount >= 3) {
            return `\n\nWarning: ${basename} has failed ${failCount} edits. MANDATORY: call \`read_file("${filePath}")\` to get the EXACT current content before your next edit attempt. Your oldString does not match the file.`;
        }
        return '';
    }

    private recordEditFailure(filePath: string): string {
        const key = this.pathKey(filePath);
        const failCount = (this.editFailCount.get(key) || 0) + 1;
        this.editFailCount.set(key, failCount);
        return this.buildEditEscalationHint(filePath, failCount);
    }

    /**
     * Top-level runs reset everything; a sub-agent scope resets only its own
     * guard signatures (sub-agents share this executor with the parent run).
     */
    resetEditFailureTracking(scopeId?: string): void {
        if (!scopeId) {
            this.editFailCount.clear();
            this.failureSignatures.clear();
            return;
        }
        for (const key of [...this.failureSignatures.keys()]) {
            if (key.startsWith(`${scopeId}\u0000`)) this.failureSignatures.delete(key);
        }
    }

    private async executeWithLock<T>(filePath: string, operation: () => Promise<T> | T): Promise<T> {
        if (!this.ctx.vfsLocks) return operation();

        // Canonical lock key: relative/absolute/case aliases of the same file
        // share one lock instead of acquiring independent ones.
        const lockKey = this.pathKey(filePath);
        const prevLock = this.ctx.vfsLocks.get(lockKey) || Promise.resolve();
        let release!: () => void;
        const newLock = new Promise<void>(resolve => release = resolve);

        this.ctx.vfsLocks.set(lockKey, prevLock.then(() => newLock));
        await prevLock;

        try {
            return await operation();
        } finally {
            release();
        }
    }

    private abortError(signal?: AbortSignal): Error {
        const reason = signal?.reason;
        if (reason instanceof Error) return reason;
        const error = new Error(reason ? String(reason) : 'AbortError');
        error.name = 'AbortError';
        return error;
    }

    private async withAbortAndTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        timeoutMessage: string,
        signal?: AbortSignal,
    ): Promise<T> {
        if (signal?.aborted) throw this.abortError(signal);
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const markSettled = (): boolean => {
                if (settled) return false;
                settled = true;
                if (timeoutId) clearTimeout(timeoutId);
                if (onAbort && signal) signal.removeEventListener('abort', onAbort);
                return true;
            };
            const resolveOnce = (value: T) => {
                if (!markSettled()) return;
                resolve(value);
            };
            const rejectOnce = (error: Error) => {
                if (!markSettled()) return;
                reject(error);
            };
            const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
                const error = new Error(timeoutMessage);
                error.name = 'TimeoutError';
                rejectOnce(error);
            }, timeoutMs);
            const onAbort = () => rejectOnce(this.abortError(signal));
            signal?.addEventListener('abort', onAbort, { once: true });
            promise.then(
                value => resolveOnce(value),
                error => rejectOnce(error instanceof Error ? error : new Error(String(error))),
            );
        });
    }

    private shouldBypassWriteConfirmation(args: unknown, context?: import('../types').AgentToolContext): boolean {
        const record = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
        return record._autoApply === true
            || context?.runnerOptions?.forceAutoApplyWrites === true
            || context?.runnerOptions?.useSlimPrompt === true;
    }

    private normalizeAgentWorkspacePath(filePath: string, context?: import('../types').AgentToolContext): string {
        const topicId = context?.runnerOptions?.topicId;
        if (!topicId) return filePath;

        const normalized = filePath.trim().replace(/\\/g, '/');
        const match = normalized.match(/^\.cwtools(?:\/(.*))?$/i);
        if (!match) return filePath;

        const safeTopicId = topicId.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const rest = (match[1] ?? '').split('/').filter(Boolean);
        if (rest[0]?.toLowerCase() === safeTopicId.toLowerCase()) {
            return filePath;
        }

        return path.posix.join('.cwtools', safeTopicId, ...rest);
    }

    private normalizeAgentWorkspaceWritePath(filePath: string, context?: import('../types').AgentToolContext): string {
        return this.normalizeAgentWorkspacePath(filePath, context);
    }

    private resolveWorkspacePath(filePath: string, context?: import('../types').AgentToolContext): WorkspacePathResolution {
        const normalizedInput = this.normalizeAgentWorkspacePath(filePath, context);
        return resolveWorkspacePathInput(normalizedInput, this.ctx.workspaceRoot);
    }

    private resolveCurrentTopicArtifact(filePath: string, context?: import('../types').AgentToolContext): string | undefined {
        const topicId = context?.runnerOptions?.topicId;
        if (!topicId) return undefined;
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(this.ctx.workspaceRoot, filePath);
        const topicRoot = path.resolve(getPrivateTopicStorageDir(topicId, this.ctx.workspaceRoot));
        if (!isPathInsideOrEqual(resolved, topicRoot)) return undefined;
        return isPlanModeCardArtifactFile(resolved, this.ctx.workspaceRoot, topicId) ? resolved : undefined;
    }

    private resolveAndAssertInWorkspace(filePath: string, context?: import('../types').AgentToolContext): string {
        const resolution = this.resolveWorkspacePath(filePath, context);
        if (isSecuritySandboxDisabled() || resolution.isWithinAnyWorkspace) {
            return resolution.resolved;
        }
        const topicArtifact = this.resolveCurrentTopicArtifact(filePath, context);
        if (topicArtifact) return topicArtifact;
        throw new Error(`Access denied: Path '${filePath}' is outside the workspace root.`);
    }

    private resolveAndAssertReadable(filePath: string, context?: import('../types').AgentToolContext): string {
        const normalizedInput = this.normalizeAgentWorkspacePath(filePath, context);
        const resolution = resolveReadablePathInput(normalizedInput, this.ctx.workspaceRoot);
        if (isSecuritySandboxDisabled() || resolution.isWithinReadableRoot) {
            return resolution.resolved;
        }
        const topicArtifact = this.resolveCurrentTopicArtifact(filePath, context);
        if (topicArtifact) return topicArtifact;
        throw new Error(`Access denied: Path '${filePath}' is outside the workspace and configured game directories.`);
    }

    private async requestPermissionWithAbort(
        id: string,
        tool: string,
        description: string,
        context?: import('../types').AgentToolContext,
        command?: string
    ): Promise<boolean> {
        const onPermissionRequest = context?.onPermissionRequest;
        if (!onPermissionRequest) return false;

        const abortSignal = context?.runnerOptions?.abortSignal;
        if (abortSignal?.aborted) return false;
        if (!abortSignal) {
            return onPermissionRequest(id, tool, description, command, context);
        }

        let onAbort: (() => void) | undefined;
        const abortDeny = new Promise<boolean>((resolve) => {
            onAbort = () => resolve(false);
            abortSignal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([
                onPermissionRequest(id, tool, description, command, context),
                abortDeny,
            ]);
        } finally {
            if (onAbort) abortSignal.removeEventListener('abort', onAbort);
        }
    }

    private async confirmPendingWrite(
        filePath: string,
        newContent: string,
        messageId: string,
        context?: import('../types').AgentToolContext
    ): Promise<boolean> {
        const onPendingWrite = this.ctx.onPendingWrite;
        if (!onPendingWrite) return false;

        const abortSignal = context?.runnerOptions?.abortSignal;
        if (abortSignal?.aborted) return false;
        if (!abortSignal) {
            return onPendingWrite(filePath, newContent, messageId);
        }

        let onAbort: (() => void) | undefined;
        const abortDeny = new Promise<boolean>((resolve) => {
            onAbort = () => resolve(false);
            abortSignal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([
                onPendingWrite(filePath, newContent, messageId),
                abortDeny,
            ]);
        } finally {
            if (onAbort) abortSignal.removeEventListener('abort', onAbort);
        }
    }

    private shouldBypassReadTrackerCheck(filePath: string): boolean {
        const segments = filePath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
        // 1. All writes under the canonical .cwtools folder
        if (segments.includes('.cwtools')) {
            return true;
        }
        // 2. Common command scripts and helper script suffixes
        const ext = path.extname(filePath).toLowerCase();
        const COMMAND_TEMP_SCRIPT_EXTENSIONS = new Set([
            '.bat', '.cmd', '.cjs', '.js', '.mjs', '.ps1', '.py', '.sh',
        ]);
        if (COMMAND_TEMP_SCRIPT_EXTENSIONS.has(ext)) {
            return true;
        }
        return false;
    }

    private async resolveAndAuthorizeWrite(filePath: string, toolName: string, context?: import('../types').AgentToolContext): Promise<string> {
        const resolution = this.resolveWorkspacePath(this.normalizeAgentWorkspaceWritePath(filePath, context), context);
        if (!isSecuritySandboxDisabled()) {
            if (!resolution.isWithinAnyWorkspace) {
                const topicArtifact = this.resolveCurrentTopicArtifact(filePath, context);
                if (topicArtifact) return topicArtifact;
                throw new Error(`Access denied: Path '${filePath}' is outside the workspace root.`);
            }
            if (resolution.scope === 'workspace') {
                const allowed = await this.requestPermissionWithAbort(
                    `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    toolName,
                    `[ESCALATION] AI requests permission to modify another workspace root: ${resolution.resolved}`,
                    context ? { ...context, escalation: true } : context,
                    resolution.resolved
                );
                if (!allowed) {
                    throw new Error(`Access denied: User denied cross-workspace write for '${resolution.resolved}'.`);
                }
            }
        }
        // ReadTracker write-gate safety interception (D1)
        const readTracker = (context?.agentRunner as any)?.readTracker;
        if (readTracker && !this.shouldBypassReadTrackerCheck(resolution.resolved)) {
            const check = readTracker.canWrite(resolution.resolved);
            if (!check.ok) {
                throw new Error(`ReadTracker Blocked: ${check.reason}. You must read the file context first using read_file. If you have already read it, the file might have been modified externally; please perform a fresh read_file to synchronize, and then retry your edit.`);
            }
        }
        return resolution.resolved;
    }

    private workspaceRelativePath(filePath: string): string {
        const resolution = resolveWorkspacePathInput(filePath, this.ctx.workspaceRoot);
        const root = resolution.workspaceFolder ?? this.ctx.workspaceRoot;
        return path.relative(root, resolution.resolved).replace(/\\/g, '/');
    }

    private isLocalisationPath(filePath: string): boolean {
        const relPath = this.workspaceRelativePath(filePath).toLowerCase();
        return relPath.startsWith('localisation/')
            || relPath.startsWith('localization/');
    }

    private rejectGenericYmlWrite(toolName: string, filePath: string): import('../types').WriteFileResult | null {
        if (!filePath.toLowerCase().endsWith('.yml') || !this.isLocalisationPath(filePath)) return null;

        return {
            success: false,
            message: `${toolName} refused to write a .yml localisation file. Use write_localisation with a real localisation path under localisation/ or localization/. Do not write localisation YAML into .cwtools scratch/topic folders.`,
        };
    }

    private validateLocalisationTarget(filePath: string): string | null {
        if (!filePath.toLowerCase().endsWith('.yml')) {
            return 'write_localisation only works with .yml files.';
        }
        if (!this.isLocalisationPath(filePath)) {
            return `write_localisation refused '${this.workspaceRelativePath(filePath)}'. Localisation files must be written under localisation/ or localization/, never under .cwtools scratch/topic folders.`;
        }
        return null;
    }

    private isPdxStructureGuardedPath(filePath: string, context?: import('../types').AgentToolContext): boolean {
        if (context?.runnerOptions?.schedulingState.domainProfile === 'general') return false;
        return ['.txt', '.gui', '.gfx', '.asset', '.entity'].includes(path.extname(filePath).toLowerCase());
    }

    /**
     * Files whose writes require semantic preflight. Shader files deliberately do
     * not use the PDX brace counter above: their mixed DSL/HLSL syntax is validated
     * by the authoritative shader frontend in the language server instead.
     */
    private isPdxSemanticGuardedPath(filePath: string, context?: import('../types').AgentToolContext): boolean {
        if (context?.runnerOptions?.schedulingState.domainProfile === 'general') return false;
        return ['.txt', '.gui', '.gfx', '.asset', '.entity', '.shader', '.fxh']
            .includes(path.extname(filePath).toLowerCase());
    }

    private inspectPdxBraceStructure(content: string): {
        balanced: boolean;
        openCount: number;
        closeCount: number;
        unmatchedOpenCount: number;
        firstExtraCloseLine?: number;
    } {
        let depth = 0;
        let openCount = 0;
        let closeCount = 0;
        let firstExtraCloseLine: number | undefined;

        for (const token of tokenize(content)) {
            if (token.type === TokenType.LBrace) {
                depth++;
                openCount++;
            } else if (token.type === TokenType.RBrace) {
                depth--;
                closeCount++;
                if (depth < 0 && firstExtraCloseLine === undefined) {
                    firstExtraCloseLine = token.line;
                }
            }
        }

        return {
            balanced: depth === 0 && firstExtraCloseLine === undefined,
            openCount,
            closeCount,
            unmatchedOpenCount: Math.max(depth, 0),
            firstExtraCloseLine,
        };
    }

    private rejectUnsafePdxStructureWrite(toolName: string, filePath: string, originalContent: string, newContent: string, context?: import('../types').AgentToolContext): string | null {
        if (!this.isPdxStructureGuardedPath(filePath, context) || originalContent === newContent) return null;

        const originalStructure = this.inspectPdxBraceStructure(originalContent);
        if (!originalStructure.balanced) {
            // Existing broken files still need to be repairable.
            return null;
        }

        const nextStructure = this.inspectPdxBraceStructure(newContent);
        if (nextStructure.balanced) return null;

        const problem = nextStructure.firstExtraCloseLine !== undefined
            ? `first unmatched "}" at line ${nextStructure.firstExtraCloseLine}`
            : `${nextStructure.unmatchedOpenCount} unmatched "{" brace(s) remain`;
        return `${toolName} refused to write ${path.basename(filePath)} because it would unbalance the PDX brace structure (${problem}; openings: ${nextStructure.openCount}, closings: ${nextStructure.closeCount}). Re-read the exact block/context and retry with the surrounding braces intact.`;
    }

    private async rejectPdxEvidenceWrite(
        toolName: string,
        filePath: string,
        originalContent: string,
        newContent: string,
        context?: import('../types').AgentToolContext,
    ): Promise<string | null> {
        if (!this.isPdxSemanticGuardedPath(filePath, context) || originalContent === newContent) return null;
        const preflight = context?.onBeforePdxWrite;
        if (!preflight) return null;
        try {
            const result = await preflight({ toolName, filePath, previousContent: originalContent, content: newContent });
            return result.allowed ? null : (result.message ?? `Semantic evidence gate blocked ${toolName}.`);
        } catch (error) {
            return `Semantic evidence verification failed before ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private readTextFile(filePath: string, context?: import('../types').AgentToolContext): { content: string; hasBom: boolean } {
        const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
        if (vfsOverlay && vfsOverlay.has(filePath)) {
            let content = vfsOverlay.get(filePath)!;
            const hasBom = content.charCodeAt(0) === 0xFEFF;
            if (hasBom) content = content.slice(1);
            return { content, hasBom };
        }
        if (!fs.existsSync(filePath)) return { content: '', hasBom: false };
        let content = fs.readFileSync(filePath, 'utf-8');
        const hasBom = content.charCodeAt(0) === 0xFEFF;
        if (hasBom) content = content.slice(1);
        return { content, hasBom };
    }

    private writeTextFile(filePath: string, content: string, hasBom: boolean, requestedEncoding?: string, context?: import('../types').AgentToolContext): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let shouldAddBom = hasBom;
        if (requestedEncoding) {
            shouldAddBom = requestedEncoding === 'utf8bom';
        } else if (matchesExt(filePath, '.yml') && this.isLocalisationPath(filePath)) {
            shouldAddBom = true;
        } else {
            shouldAddBom = false; // Fallback to no BOM for all other files if requestedEncoding is not set and hasBom is false for a new file.
            if (hasBom) shouldAddBom = true; // Preserve an existing BOM
        }

        const finalContent = shouldAddBom ? '\uFEFF' + content : content;
        const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
        if (vfsOverlay) {
            vfsOverlay.set(filePath, finalContent);
        } else {
            fs.writeFileSync(filePath, finalContent, 'utf-8');
        }
        const readTracker = (context?.agentRunner as any)?.readTracker;
        if (readTracker) { readTracker.markWritten(filePath); }
    }

    // - readFile -

    async readFile(args: { file: string; startLine?: number; endLine?: number; centerLine?: number; radius?: number }, context?: import('../types').AgentToolContext): Promise<import('../types').ReadFileResult> {
        try {
            const normalizedArgs = {
                ...args,
                startLine: args.startLine === 0 ? undefined : args.startLine,
                endLine: args.endLine === 0 ? undefined : args.endLine,
            };
            if (normalizedArgs.centerLine !== undefined) {
                if (!Number.isInteger(normalizedArgs.centerLine) || normalizedArgs.centerLine < 0) throw new Error('centerLine must be a non-negative 0-based integer.');
                if (normalizedArgs.startLine !== undefined || normalizedArgs.endLine !== undefined) throw new Error('centerLine is mutually exclusive with startLine/endLine.');
                const radius = Number.isInteger(normalizedArgs.radius) ? Math.max(0, Math.min(normalizedArgs.radius!, 150)) : 20;
                normalizedArgs.startLine = Math.max(1, normalizedArgs.centerLine + 1 - radius);
                normalizedArgs.endLine = normalizedArgs.centerLine + 1 + radius;
            }
            args = normalizedArgs;
            args.file = this.resolveAndAssertReadable(args.file, context);
            const paradoxDomain = context?.runnerOptions?.schedulingState.domainProfile !== 'general';
            const localisationFile = this.isLocalisationPath(args.file) && matchesExt(args.file, '.yml');
            const readTracker = (context?.agentRunner as any)?.readTracker;
            if (readTracker) { readTracker.markRead(args.file); }

            const ext = path.extname(args.file).toLowerCase();
            if (GRAPHICS_EXTS.includes(ext)) {
                return await this.readImageMetadata(args.file);
            }

            // - Cache: serve full-file reads from memory -
            if (!args.startLine && !args.endLine) {
                const cached = getCachedFile(args.file);
                if (cached !== null) {
                    const lines = cached.split('\n');
                    const totalLines = lines.length;
                    let threshold = 150;
                    if (paradoxDomain && localisationFile) {
                        threshold = 50;
                    }

                    if (totalLines > threshold) {
                        const headLines = lines.slice(0, 80);
                        const tailLines = lines.slice(-20);
                        const headContent = headLines.map((l, i) => `${1 + i} | ${l}`).join('\n');
                        const tailContent = tailLines.map((l, i) => `${totalLines - 19 + i} | ${l}`).join('\n');
                        
                        let gapInfo = `\n... [${totalLines - 100} lines omitted - use document_symbols to locate, then read_file for specifics] ...\n`;
                        let hint = `The file has ${totalLines} lines in total. The first 100 lines and the last 20 lines are displayed. Suggestion: call document_symbols("${args.file}") to get the structure, then use read_file(startLine, endLine) to read precisely (each time up to ${threshold} lines).`;

                        if (paradoxDomain && matchesExt(args.file, '.txt')) {
                            gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! DO NOT READ FULL FILE! Use document_symbols + get_pdx_block] ...\n`;
                            hint = `Warning: FILE TOO LARGE. The first 100 lines and last 20 are displayed. For PDX scripts (.txt), you MUST call document_symbols("${args.file}") to get the structure, then use get_pdx_block("${args.file}", symbol) to extract the specific block you need. DO NOT use read_file for large PDX scripts.`;
                        } else if (paradoxDomain && localisationFile) {
                            gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! YML IS TOO LARGE. Use grep] ...\n`;
                            hint = `Warning: YML TOO LARGE. You MUST NOT read entire localisation files. Use grep to find specific keys instead.`;
                        }

                        hint += paradoxDomain
                            ? ' Do not conclude that a key/ID is missing from this truncated view; use an authoritative indexed lookup before claiming absence.'
                            : ' Do not conclude that a symbol or file is absent from this truncated view; use grep or workspace symbols to verify.';

                        return {
                            content: headContent + gapInfo + tailContent,
                            totalLines,
                            truncated: true,
                            _hint: hint,
                        };
                    }
                    const numberedCached = lines.map((l, i) => `${1 + i} | ${l}`).join('\n');
                    return { content: numberedCached, totalLines, truncated: false };
                }
            }
            // -

            let threshold = 150;
            if (paradoxDomain && localisationFile) {
                threshold = 50;
            }

            // Single-pass streaming: count total lines AND extract the requested slice simultaneously.
            // When no range is specified, we need the full count to decide whether the file is too large.
            // When a range IS specified, we still need totalLines for the response metadata.
            const start = args.startLine ? Math.max(1, args.startLine) : 1;
            const requestedEnd = args.endLine ?? Infinity; // resolved after counting

            const slice: string[] = [];
            let totalLines = 0;
            let sliceFinished = false;

            try {
                const rl = readline.createInterface({
                    input: fs.createReadStream(args.file, { encoding: 'utf-8' }),
                    crlfDelay: Infinity,
                });
                for await (const line of rl) {
                    totalLines++;
                    if (!sliceFinished) {
                        if (totalLines >= start && totalLines <= requestedEnd) {
                            slice.push(line);
                        }
                        if (totalLines > requestedEnd) {
                            sliceFinished = true;
                            // If we also have startLine/endLine, we still need totalLines,
                            // so we continue counting. But if no endLine was given and file
                            // is small, we just collect everything anyway.
                        }
                    }
                }
            } catch (e) {
                return { content: `Error reading file:${String(e)}`, totalLines: 0, truncated: false };
            }

            // Cache the full content for potential re-reads within this loop
            try {
                const fullContent = (args.startLine !== undefined || args.endLine !== undefined)
                    ? null  // partial read - don't cache
                    : slice.join('\n');
                if (fullContent !== null) {
                    const stat = fs.statSync(args.file);
                    setCachedFile(args.file, fullContent, stat.mtimeMs);
                }
            } catch { /* stat may fail; skip cache */ }
            
            if (totalLines > threshold && !args.startLine && !args.endLine) {
                const headLines = slice.slice(0, 80);
                const tailLines = slice.slice(-20);
                const headContent = headLines.map((l, i) => `${1 + i} | ${l}`).join('\n');
                const tailContent = tailLines.map((l, i) => `${totalLines - 19 + i} | ${l}`).join('\n');
                let gapInfo = `\n... [${totalLines - 100} lines omitted - use document_symbols to locate, then read_file for specifics (max ${threshold} lines at a time)] ...\n`;
                let hint = `The file has ${totalLines} lines in total. The first 100 lines and the last 20 lines are displayed. Suggestion: call document_symbols("${args.file}") to get the structure, then use read_file(startLine, endLine) to read precisely (each time up to ${threshold} lines).`;

                if (paradoxDomain && matchesExt(args.file, '.txt')) {
                    gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! DO NOT READ FULL FILE! Use document_symbols + get_pdx_block] ...\n`;
                    hint = `Warning: FILE TOO LARGE. The first 100 lines and last 20 are displayed. For PDX scripts (.txt), you MUST call document_symbols("${args.file}") to get the structure, then use get_pdx_block("${args.file}", symbol) to extract the specific block you need. DO NOT use read_file for large PDX scripts.`;
                } else if (paradoxDomain && localisationFile) {
                    gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! YML IS TOO LARGE. Use grep] ...\n`;
                    hint = `Warning: YML TOO LARGE. You MUST NOT read entire localisation files. Use grep to find specific keys instead.`;
                }

                hint += paradoxDomain
                    ? ' Do not conclude that a key/ID is missing from this truncated view; use an authoritative indexed lookup before claiming absence.'
                    : ' Do not conclude that a symbol or file is absent from this truncated view; use grep or workspace symbols to verify.';

                return {
                    content: headContent + gapInfo + tailContent,
                    totalLines,
                    truncated: true,
                    _hint: hint,
                };
            }

            // Strip BOM from first line (readline doesn't strip it, but readTextFile/editFile do,
            // causing BOM mismatch when the AI copies text from read_file into edit_file's oldString)
            if (slice.length > 0 && slice[0]!.charCodeAt(0) === 0xFEFF) {
                slice[0] = slice[0]!.slice(1);
            }

            // Format with succinct line prefix (saves ~1 token per line vs "1234: ")
            const numbered = slice.map((l, i) => `${start + i} | ${l}`).join('\n');

            const MAX_READ_CHARS = getToolResultBudget(context?.runnerOptions?.maxContextTokens);
            const truncated = numbered.length > MAX_READ_CHARS;
            let resultContent: string;
            if (truncated) {
                // Truncate at line boundary to avoid broken last line
                const lines2 = numbered.split('\n');
                let charCount = 0;
                let lineCount = 0;
                for (const line of lines2) {
                    if (charCount + line.length + 1 > MAX_READ_CHARS) break;
                    charCount += line.length + 1;
                    lineCount++;
                }
                resultContent = lines2.slice(0, Math.max(1, lineCount)).join('\n');
            } else {
                resultContent = numbered;
            }

            const lastLineReturned = start + (truncated
                ? resultContent.split('\n').length - 1
                : slice.length - 1);

            return {
                content: truncated
                    ? resultContent + `\n[... truncated at ~${MAX_READ_CHARS} chars ...]`
                    : resultContent,
                totalLines,
                truncated,
                ...(truncated ? {
                    _hint: `Output truncated. Total lines: ${totalLines}. ` +
                        `Last displayed line: ~${lastLineReturned}. ` +
                        `To read the next section, call read_file with startLine=${lastLineReturned + 1}.`,
                } : {}),
            };
        } catch (e) {
            return { content: `Error reading file:${String(e)}`, totalLines: 0, truncated: false };
        }
    }

    private async readImageMetadata(filePath: string): Promise<any> {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const stat = await fs.promises.stat(filePath);
            const fileSize = stat.size;

            const metadata: any = { type: 'image_metadata', ext, fileSize };

            if (ext === '.dds') {
                const fd = await fs.promises.open(filePath, 'r');
                try {
                    const buf = Buffer.alloc(128);
                    await fd.read(buf, 0, 128, 0);
                    // DDS magic is 'DDS '
                    if (buf.toString('utf8', 0, 4) === 'DDS ') {
                        metadata.height = buf.readUInt32LE(12);
                        metadata.width = buf.readUInt32LE(16);
                        metadata.mipmaps = buf.readUInt32LE(28);
                        
                        // Pixel format starts at 76
                        const flags = buf.readUInt32LE(80);
                        const fourCC = buf.toString('utf8', 84, 88);
                        if (flags & 0x4) {
                            metadata.format = fourCC; // e.g. DXT1, DXT5, DX10
                        } else {
                            metadata.format = 'Uncompressed/RGB';
                        }
                    }
                } finally {
                    await fd.close();
                }
            } else if (ext === '.tga') {
                const fd = await fs.promises.open(filePath, 'r');
                try {
                    const buf = Buffer.alloc(18);
                    await fd.read(buf, 0, 18, 0);
                    metadata.width = buf.readUInt16LE(12);
                    metadata.height = buf.readUInt16LE(14);
                    const bpp = buf.readUInt8(16);
                    metadata.format = `TGA ${bpp}bpp`;
                } finally {
                    await fd.close();
                }
            } else {
                metadata.format = ext.replace('.', '').toUpperCase();
                metadata.hint = 'To view exact dimensions of png/jpg, use an image preview or node image-size library. Standard read gives only basic metadata.';
            }

            return {
                content: JSON.stringify(metadata, null, 2),
                totalLines: 1,
                truncated: false,
            };
        } catch (e: any) {
            return { content: `Error reading image metadata: ${e.message}`, totalLines: 0, truncated: false };
        }
    }

    // - writeFile -

    async writeFile(args: { file: string; content: string; encoding?: string }, context?: import('../types').AgentToolContext): Promise<import('../types').WriteFileResult> {
        return this.executeWithLock(args.file, async () => {
            try {
                args.file = await this.resolveAndAuthorizeWrite(args.file, 'write_file', context);
                const ymlReject = this.rejectGenericYmlWrite('write_file', args.file);
                if (ymlReject) return ymlReject;

                // Defensive: content copied verbatim from read_file output carries
                // `N | ` prefixes on every line — writing them would corrupt the file.
                args.content = stripLineNumberPrefixes(args.content) ?? args.content;

                // Security blocking has been removed: allowing AI to overwrite files directly
                const { content: originalContent, hasBom } = this.readTextFile(args.file, context);
                (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(args.file, originalContent);

                const pdxStructureReject = this.rejectUnsafePdxStructureWrite('write_file', args.file, originalContent, args.content, context);
                if (pdxStructureReject) {
                    return { success: false, message: pdxStructureReject };
                }
                const pdxEvidenceReject = await this.rejectPdxEvidenceWrite('write_file', args.file, originalContent, args.content, context);
                if (pdxEvidenceReject) {
                    return { success: false, message: pdxEvidenceReject };
                }

                const _diff = this.buildUnifiedDiff(args.file, originalContent ?? '', args.content);

                const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                    const messageId = `write_${crypto.randomUUID()}`;
                    const confirmed = await this.confirmPendingWrite(args.file, args.content, messageId, context);
                    if (!confirmed) {
                        return { success: false, message: 'User cancelled the write operation', terminalOutcome: 'user_cancelled' };
                    }
                } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                    const isNewFile = !fs.existsSync(args.file);
                    this.ctx.onAutoWritten(args.file, isNewFile);
                }

                const baselineState = await this.queryDiagnosticsFresh(args.file, context);
                const baselineSnapshot = this.diagnosticSnapshot(baselineState);
                const preWriteEpoch = baselineState?.epoch ?? 0;
                this.writeTextFile(args.file, args.content, hasBom, args.encoding, context);
                const freshResult = await this.getLspDiagnosticsForFileFresh(args.file, preWriteEpoch, context);
                const diagnosticSnapshot = this.diagnosticSnapshot(freshResult);
                const diagnosticDelta = this.diagnosticDelta(baselineSnapshot, diagnosticSnapshot);
                return {
                    success: true,
                    message: `File written: ${args.file}. Freshness: ${freshResult.freshness}`,
                    diagnostics: freshResult.diagnostics,
                    freshness: freshResult.freshness,
                    pendingGlobalKinds: freshResult.pendingGlobalKinds,
                    diagnosticSnapshot,
                    diagnosticDelta,
                };
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }
        });
    }


    async editFile(args: import('../types').EditFileArgs, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return { success: false, message: 'Error: missing or invalid "filePath".' };
        }
        if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') {
            return { success: false, message: 'Error: edit_file requires string oldString and newString.' };
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'edit_file', context);
                const ymlReject = this.rejectGenericYmlWrite('edit_file', args.filePath);
                if (ymlReject) return ymlReject as any;
            } catch (e) {
                return { success: false, message: String(e) };
            }

            const filePath = args.filePath;
            const fileExists = fs.existsSync(filePath);
            const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
            let newContent: string;
            let guardBase: Omit<FailureSignature, 'errorClass'> | null = null;

            try {
                if (args.oldString.length === 0) {
                    if (fileExists && originalContent.length > 0) {
                        const hint = this.recordEditFailure(filePath);
                        return { success: false, message: `edit_file refused an empty oldString for existing file ${path.basename(filePath)}. Use write_file for whole-file replacement or provide the exact text to replace.${hint}` };
                    }
                    newContent = args.newString;
                } else {
                    const oldText = this.convertLineEnding(this.normalizeLineEndings(args.oldString), this.detectLineEnding(originalContent));
                    const nextText = this.convertLineEnding(this.normalizeLineEndings(args.newString), this.detectLineEnding(originalContent));
                    if (args.replaceAll !== true) {
                        guardBase = {
                            scopeId: this.scopeOf(context),
                            tool: 'edit_file',
                            pathKey: this.pathKey(filePath),
                            anchorHash: hashAnchor(this.normalizeAnchorText(args.oldString)),
                        };
                        // Anchor guard: intercept the 3rd+ identical failing edit
                        // after a side-effect-free preview proves it still fails.
                        const blocked = this.checkAnchorGuard(guardBase, filePath, () => {
                            const match = previewMatch(originalContent, oldText);
                            if (match === 'matched') return null;
                            return match === 'ambiguous' ? 'anchor_ambiguous' : 'anchor_not_found';
                        });
                        if (blocked) {
                            return { success: false, message: blocked };
                        }
                    }
                    newContent = this.replace(originalContent, oldText, nextText, args.replaceAll === true);
                }
            } catch (e) {
                const hint = this.recordEditFailure(filePath);
                if (guardBase && e instanceof ReplacerError) {
                    this.recordAnchorFailure(guardBase, replacerKindToErrorClass(e.kind));
                }
                return { success: false, message: `edit_file failed for ${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}${hint}` };
            }

            if (newContent === originalContent) {
                return { success: true, message: `edit_file made no changes to ${path.basename(filePath)}.` };
            }

            const pdxStructureReject = this.rejectUnsafePdxStructureWrite('edit_file', filePath, originalContent, newContent, context);
            if (pdxStructureReject) {
                const hint = this.recordEditFailure(filePath);
                return { success: false, message: pdxStructureReject + hint };
            }
            const pdxEvidenceReject = await this.rejectPdxEvidenceWrite('edit_file', filePath, originalContent, newContent, context);
            if (pdxEvidenceReject) {
                return { success: false, message: pdxEvidenceReject };
            }

            const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);
            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                const confirmed = await this.confirmPendingWrite(filePath, newContent, `edit_${crypto.randomUUID()}`, context);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the edit_file operation', pendingDiff: diff, terminalOutcome: 'user_cancelled' };
                }
            } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                this.ctx.onAutoWritten(filePath, !fileExists);
            }

            const baselineState = await this.queryDiagnosticsFresh(filePath, context);
            const baselineSnapshot = this.diagnosticSnapshot(baselineState);
            const preWriteEpoch = baselineState?.epoch ?? 0;
            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, fileExists ? originalContent : null);
            try {
                this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }

            this.editFailCount.delete(this.pathKey(filePath));
            const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch, context);
            const diagnostics = freshResult.diagnostics;
            const diagnosticSnapshot = this.diagnosticSnapshot(freshResult);
            const diagnosticDelta = this.diagnosticDelta(baselineSnapshot, diagnosticSnapshot);
            const oldLineCount = originalContent.length === 0 ? 0 : originalContent.split(/\r?\n/).length;
            const newLineCount = newContent.length === 0 ? 0 : newContent.split(/\r?\n/).length;
            return {
                success: true,
                message: `edit_file: updated ${path.basename(filePath)}`,
                diff,
                diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
                diagnosticSnapshot,
                diagnosticDelta,
                stats: {
                    linesAdded: Math.max(0, newLineCount - oldLineCount),
                    linesRemoved: Math.max(0, oldLineCount - newLineCount),
                },
            };
        });
    }


    // - astMutate -

    async astMutate(args: import('../types').AstMutateArgs, context?: import('../types').AgentToolContext): Promise<import('../types').AstMutateResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return {
                success: false,
                message: 'Error: missing or invalid "filePath" parameter. Must provide an absolute file path.',
            } as any;
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'ast_mutate', context);
            } catch (e) {
                return { success: false, message: String(e) };
            }

            const filePath = args.filePath;
        const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
        (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent);

        let nodes: PdxNode[] = [];
        try {
            nodes = parsePdx(originalContent);
        } catch (e) {
            return { success: false, message: `AST parsing failed: ${e}` };
        }

        let currentLevel = nodes;
        let matchedNode: PdxNode | undefined;
        let parentContext = '';

        for (const target of args.targetPath) {
            const fuzzyMatch = currentLevel.find(n => {
                const kv = n.value !== undefined ? `${n.key}=${n.value}` : n.key;
                return kv.toLowerCase().includes(target.toLowerCase());
            });

            if (!fuzzyMatch) {
                const available = currentLevel.map(n => n.value !== undefined ? `${n.key}=${n.value}` : n.key).slice(0, 10).join(', ');
                return {
                    success: false,
                    message: `AST traversal failed. Could not find node matching '${target}' in ${parentContext || 'root'}. Available nodes: [${available}${currentLevel.length > 10 ? '...' : ''}]`
                };
            }

            matchedNode = fuzzyMatch;
            currentLevel = fuzzyMatch.children || [];
            parentContext = target;
        }

        if (!matchedNode) {
            return { success: false, message: 'AST traversal failed. Empty target path?' };
        }

        if ((args.action === 'append' || args.action === 'prepend') && matchedNode.endLine === undefined) {
             return { success: false, message: `AST node '${matchedNode.key}' is not a block. Cannot ${args.action}.` };
        }

        const lines = originalContent.split('\n');
        const startLineIdx = Math.max(0, matchedNode.line - 1);
        const endLineIdx = matchedNode.endLine ? Math.max(0, matchedNode.endLine - 1) : startLineIdx;

        // Intelligent indentation tracking
        const baseIndentMatch = (lines[startLineIdx] || '').match(/^[\s\t]*/);
        const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';
        const targetIndent = (args.action === 'append' || args.action === 'prepend') ? baseIndent + '\t' : baseIndent;
        const ending = originalContent.includes('\r\n') ? '\r\n' : '\n';
        
        const rawPayloadLines = args.payload ? args.payload.replace(/\r\n/g, '\n').split('\n') : [];
        const minIndent = rawPayloadLines.filter(l => l.trim().length > 0).reduce((min, l) => {
             const match = l.match(/^[\s\t]*/);
             return Math.min(min, match ? match[0].length : 0);
        }, Infinity);

        const payloadLines = rawPayloadLines.map(l => {
            if (l.trim().length === 0) return (ending === '\r\n' ? '\r' : '');
            const relativeLine = l.substring(minIndent === Infinity ? 0 : minIndent);
            return targetIndent + relativeLine + (ending === '\r\n' ? '\r' : '');
        });

        const newLines = [...lines];
        if (args.action === 'replace') {
            newLines.splice(startLineIdx, endLineIdx - startLineIdx + 1, ...payloadLines);
        } else if (args.action === 'delete') {
            newLines.splice(startLineIdx, endLineIdx - startLineIdx + 1);
        } else if (args.action === 'prepend') {
            newLines.splice(startLineIdx + 1, 0, ...payloadLines);
        } else if (args.action === 'append') {
            newLines.splice(endLineIdx, 0, ...payloadLines);
        }

        const newContent = newLines.join('\n');
        const pdxStructureReject = this.rejectUnsafePdxStructureWrite('ast_mutate', filePath, originalContent, newContent, context);
        if (pdxStructureReject) {
            return { success: false, message: pdxStructureReject };
        }
        const pdxEvidenceReject = await this.rejectPdxEvidenceWrite('ast_mutate', filePath, originalContent, newContent, context);
        if (pdxEvidenceReject) {
            return { success: false, message: pdxEvidenceReject };
        }
        const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context)) {
            const confirmed = await this.confirmPendingWrite(filePath, newContent, `ast_${Date.now()}`, context);
            if (!confirmed) {
                return { success: false, message: 'User cancelled the edit operation', pendingDiff: diff, terminalOutcome: 'user_cancelled' };
            }
        } else if (this.ctx.onAutoWritten) {
            this.ctx.onAutoWritten(filePath, false);
        }

        const preWriteEpoch = (await this.queryDiagnosticsFresh(filePath, context))?.epoch ?? 0;
        try {
            this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
        } catch (e) {
            return { success: false, message: `Write failed: ${String(e)}` };
        }

            const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch, context);
            const diagnostics = freshResult.diagnostics;
            return {
                success: true,
                nodeFound: true,
                message: `AST surgery successful (${args.action} on ${args.targetPath.join(' -> ')}). File updated: ${path.basename(filePath)}`,
                diff,
                diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
            };
        });
    }



    /**
     * Pure expected* safety-guard validation for replace_lines, shared by the
     * execution path and the anchor guard's side-effect-free preview.
     */
    private validateReplaceLineGuards(args: import('../types').ReplaceLinesArgs, normalizedCurrentRange: string): string[] {
        const guardErrors: string[] = [];
        if (typeof args.expectedContent === 'string') {
            // Models copy expectedContent straight from numbered read_file
            // output — strip `N | ` prefixes before comparing, otherwise the
            // guard fails spuriously and sends the model into a retry loop.
            const expectedRaw = stripLineNumberPrefixes(args.expectedContent) ?? args.expectedContent;
            const expected = this.convertLineEnding(this.normalizeLineEndings(expectedRaw), '\n');
            if (normalizedCurrentRange !== expected) {
                guardErrors.push('expectedContent did not match the current line range');
            }
        }
        if (typeof args.expectedHash === 'string' && args.expectedHash.trim()) {
            const actualHash = crypto.createHash('sha256').update(normalizedCurrentRange, 'utf8').digest('hex');
            if (actualHash.toLowerCase() !== args.expectedHash.trim().toLowerCase()) {
                guardErrors.push(`expectedHash did not match current line range (actual sha256: ${actualHash})`);
            }
        }
        if (typeof args.expectedStartText === 'string' && args.expectedStartText.trim()) {
            const expectedStartRaw = stripLineNumberPrefixes(args.expectedStartText) ?? args.expectedStartText;
            const expectedStart = this.convertLineEnding(this.normalizeLineEndings(expectedStartRaw), '\n').trimStart();
            if (!normalizedCurrentRange.trimStart().startsWith(expectedStart)) {
                guardErrors.push('expectedStartText did not match the current line range');
            }
        }
        if (typeof args.expectedEndText === 'string' && args.expectedEndText.trim()) {
            const expectedEndRaw = stripLineNumberPrefixes(args.expectedEndText) ?? args.expectedEndText;
            const expectedEnd = this.convertLineEnding(this.normalizeLineEndings(expectedEndRaw), '\n').trimEnd();
            if (!normalizedCurrentRange.trimEnd().endsWith(expectedEnd)) {
                guardErrors.push('expectedEndText did not match the current line range');
            }
        }
        return guardErrors;
    }

    async replaceLines(args: import('../types').ReplaceLinesArgs, context?: import('../types').AgentToolContext): Promise<import('../types').ReplaceLinesResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return { success: false, message: 'Error: missing or invalid "filePath".' };
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'replace_lines', context);
                const ymlReject = this.rejectGenericYmlWrite('replace_lines', args.filePath);
                if (ymlReject) return ymlReject as any;
            } catch (e) {
                return { success: false, message: String(e) };
            }

            const filePath = args.filePath;
            const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
            const lines = originalContent.split(/\r?\n/);
            const startLine = Math.trunc(args.startLine);
            const endLine = Math.trunc(args.endLine);

            if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
                return { success: false, message: 'replace_lines requires numeric startLine and endLine.' + this.recordEditFailure(filePath) };
            }
            if (startLine < 1 || endLine < startLine || endLine > lines.length) {
                return { success: false, message: `Invalid line range [${args.startLine}, ${args.endLine}] for file with ${lines.length} lines.` + this.recordEditFailure(filePath) };
            }

            const ending = this.detectLineEnding(originalContent);
            const currentRange = lines.slice(startLine - 1, endLine).join('\n');
            const normalizedCurrentRange = this.convertLineEnding(this.normalizeLineEndings(currentRange), '\n');

            // Anchor guard: the expected* guards ARE this tool's anchor; the
            // side-effect-free preview re-runs them (never fuzzyReplace).
            const anchorParts = [args.expectedContent, args.expectedHash, args.expectedStartText, args.expectedEndText]
                .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
            const replaceGuardBase: Omit<FailureSignature, 'errorClass'> = {
                scopeId: this.scopeOf(context),
                tool: 'replace_lines',
                pathKey: this.pathKey(filePath),
                anchorHash: hashAnchor(anchorParts.length > 0
                    ? this.normalizeAnchorText(anchorParts.join('\n'))
                    : `lines:${startLine}-${endLine}`),
            };
            const blocked = this.checkAnchorGuard(replaceGuardBase, filePath,
                () => this.validateReplaceLineGuards(args, normalizedCurrentRange).length === 0
                    ? null
                    : 'anchor_stale');
            if (blocked) {
                const blockedPreview = normalizedCurrentRange.split('\n').slice(0, 12).join('\n');
                return { success: false, message: blocked, currentContentPreview: blockedPreview };
            }

            const guardErrors = this.validateReplaceLineGuards(args, normalizedCurrentRange);
            if (guardErrors.length > 0) {
                this.recordAnchorFailure(replaceGuardBase, 'anchor_stale');
                const preview = normalizedCurrentRange.split('\n').slice(0, 12).join('\n');
                return {
                    success: false,
                    message: `replace_lines safety check failed for ${path.basename(filePath)} lines ${startLine}-${endLine}: ${guardErrors.join('; ')}. The file may have changed since the line numbers were chosen. Re-read the current context with read_file, then retry with updated line numbers and expectedContent.` + this.recordEditFailure(filePath),
                    currentContentPreview: preview,
                };
            }

            const newContentRaw = stripLineNumberPrefixes(args.newContent) ?? args.newContent;
            const replacement = this.convertLineEnding(this.normalizeLineEndings(newContentRaw), '\n');
            const replacementLines = replacement.length === 0 ? [] : replacement.split('\n');
            lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
            const newContent = lines.join(ending);

            if (newContent === originalContent) {
                return { success: true, message: `replace_lines made no changes to ${path.basename(filePath)}.` };
            }

            const pdxStructureReject = this.rejectUnsafePdxStructureWrite('replace_lines', filePath, originalContent, newContent, context);
            if (pdxStructureReject) {
                return { success: false, message: pdxStructureReject + this.recordEditFailure(filePath) };
            }
            const pdxEvidenceReject = await this.rejectPdxEvidenceWrite('replace_lines', filePath, originalContent, newContent, context);
            if (pdxEvidenceReject) {
                return { success: false, message: pdxEvidenceReject };
            }

            const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);
            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                const confirmed = await this.confirmPendingWrite(filePath, newContent, `replace_lines_${Date.now()}`, context);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the replace_lines operation', pendingDiff: diff, terminalOutcome: 'user_cancelled' };
                }
            } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                this.ctx.onAutoWritten(filePath, false);
            }

            const baselineState = await this.queryDiagnosticsFresh(filePath, context);
            const baselineSnapshot = this.diagnosticSnapshot(baselineState);
            const preWriteEpoch = baselineState?.epoch ?? 0;
            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent || null);
            try {
                this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }

            this.editFailCount.delete(this.pathKey(filePath));
            const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch, context);
            const diagnostics = freshResult.diagnostics;
            const diagnosticSnapshot = this.diagnosticSnapshot(freshResult);
            const diagnosticDelta = this.diagnosticDelta(baselineSnapshot, diagnosticSnapshot);
            let message = `replace_lines: replaced lines ${startLine}-${endLine} in ${path.basename(filePath)}`;
            const errorsDiags = diagnostics.filter((d: any) => d.severity === 'error');
            if (errorsDiags.length > 0) {
                message += `\n\nLSP detected ${errorsDiags.length} error(s) - please fix:\n` +
                    errorsDiags.slice(0, 5).map((e: any) => `  Line ${e.line + 1}: ${e.message}`).join('\n');
            }

            return {
                success: true,
                message,
                diff,
                diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
                diagnosticSnapshot,
                diagnosticDelta,
            };
        });
    }

    // - listDirectory -

    async listDirectory(args: { directory: string; recursive?: boolean }, context?: import('../types').AgentToolContext): Promise<import('../types').ListDirectoryResult> {
        try {
            const dirPath = this.resolveAndAssertReadable(args.directory, context);
            const limit = 200;

            if (!fs.existsSync(dirPath)) {
                return { entries: [], path: dirPath, truncated: false, hasMore: false, returnedCount: 0, limit };
            }

            const entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> = [];
            this.listDirRecursive(dirPath, dirPath, entries, args.recursive ?? false, 0, 3, limit + 1);
            const hasMore = entries.length > limit;

            return { entries: entries.slice(0, limit), path: dirPath, truncated: hasMore, hasMore, returnedCount: Math.min(entries.length, limit), limit };
        } catch (e) {
            return { entries: [], path: args.directory, truncated: false, hasMore: false, returnedCount: 0, limit: 200, error: e instanceof Error ? e.message : String(e) };
        }
    }

    private listDirRecursive(
        baseDir: string,
        currentDir: string,
        results: Array<{ name: string; type: 'file' | 'directory'; size?: number }>,
        recursive: boolean,
        depth: number,
        maxDepth: number,
        maxEntries = 200
    ): void {
        if (depth > maxDepth || results.length >= maxEntries) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxEntries) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const relPath = path.relative(baseDir, path.join(currentDir, entry.name)).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                results.push({ name: relPath + '/', type: 'directory' });
                if (recursive) {
                    this.listDirRecursive(baseDir, path.join(currentDir, entry.name), results, recursive, depth + 1, maxDepth, maxEntries);
                }
            } else {
                const stat = fs.statSync(path.join(currentDir, entry.name));
                results.push({ name: relPath, type: 'file', size: stat.size });
            }
        }
    }

    // - globFiles -

    async globFiles(args: { pattern: string; path?: string; limit?: number }, context?: import('../types').AgentToolContext): Promise<{ files: string[]; truncated: boolean; hasMore: boolean; returnedCount: number; limit: number; error?: string }> {
        try {
            const limit = Math.min(args.limit ?? 200, 500);
            const searchRoot = args.path ? this.resolveAndAssertReadable(args.path, context) : undefined;
            const include = searchRoot ? new vs.RelativePattern(searchRoot, args.pattern) : args.pattern;
            const exclude = searchRoot ? new vs.RelativePattern(searchRoot, '**/node_modules/**') : '**/node_modules/**';
            const uris = (await vs.workspace.findFiles(include, exclude, limit + 1))
                .filter(uri => !searchRoot || isPathInsideOrEqual(uri.fsPath, searchRoot));
            const hasMore = uris.length > limit;
            const files = uris.slice(0, limit).map(u => u.fsPath);
            return { files, truncated: hasMore, hasMore, returnedCount: files.length, limit };
        } catch (e) {
            return { files: [], truncated: false, hasMore: false, returnedCount: 0, limit: Math.min(args.limit ?? 200, 500), error: e instanceof Error ? e.message : String(e) };
        }
    }

// - getLspDiagnosticsForFile -

    /** Extract diagnostics from Problems panel and format */
    private static mapDiagnostics(uri: vs.Uri, excludeCwtools = false): ValidationError[] {
        return vs.languages.getDiagnostics(uri)
            .filter(d => !excludeCwtools || !/cwtools/i.test(d.source ?? ''))
            .map(d => {
            const metadata = diagnosticMetadata(d);
            return {
                code: diagnosticCodeString(d.code) ?? '',
                severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                    : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                        : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                message: d.message,
                line: d.range.start.line,
                column: d.range.start.character,
                category: metadata.category,
                repairHint: metadata.repairHint,
                expectedType: metadata.expectedType,
                actualType: metadata.actualType,
                scope: metadata.scope,
                symbol: metadata.symbol,
                confidence: metadata.confidence,
                metadataSource: metadata.metadataSource,
                data: metadata.data,
            } as ValidationError;
            });
    }


    private diagnosticSnapshot(
        state: { freshness: 'fresh' | 'pending' | 'stale'; epoch: number; diagnostics?: ValidationError[]; timedOut?: boolean } | null,
    ): DiagnosticSnapshot {
        const status: DiagnosticStatus = state?.freshness ?? 'unavailable';
        return createDiagnosticSnapshot(state?.diagnostics ?? [], {
            status,
            complete: status === 'fresh' && state?.timedOut !== true && Array.isArray(state?.diagnostics),
        });
    }

    private diagnosticDelta(
        before: DiagnosticSnapshot,
        after: DiagnosticSnapshot,
    ): DiagnosticDelta {
        return diffDiagnosticSnapshots(before, after);
    }

    /** 
* Query the LSP for the current diagnostic status of the file (return immediately, without blocking). 
* Returning null indicates that the LSP is unavailable. 
*/
    private async queryDiagnosticsFresh(filePath: string, context?: import('../types').AgentToolContext): Promise<{
        freshness: 'fresh' | 'pending' | 'stale';
        epoch: number;
        pendingGlobalKinds: string[];
        diagnostics?: ValidationError[];
    } | null> {
        if (context?.runnerOptions?.schedulingState.domainProfile === 'general') {
            return {
                freshness: 'fresh',
                epoch: Date.now(),
                pendingGlobalKinds: [],
                diagnostics: FileToolHandler.mapDiagnostics(vs.Uri.file(filePath), true),
            };
        }
        try {
            const client = (this.ctx as any).client;
            if (!client) return null;
            const uri = vs.Uri.file(filePath);
            const result = await this.withAbortAndTimeout(
                client.sendRequest('workspace/executeCommand', {
                    command: 'cwtools.ai.getDiagnosticsFresh',
                    arguments: [uri.toString()],
                }) as Promise<Record<string, unknown> | null>,
                1500,
                'Diagnostics freshness request timed out.',
                context?.runnerOptions?.abortSignal,
            );
            if (result && typeof result === 'object' && 'freshness' in result) {
                return {
                    freshness: String(result.freshness) as 'fresh' | 'pending' | 'stale',
                    epoch: typeof result.epoch === 'number' ? result.epoch : 0,
                    pendingGlobalKinds: Array.isArray(result.pendingGlobalKinds)
                        ? (result.pendingGlobalKinds as string[]) : [],
                    diagnostics: Array.isArray(result.diagnostics)
                        ? (result.diagnostics as ValidationError[]) : undefined,
                };
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            /* LSP is not available */
        }
        return null;
    }

    private async requestRevalidateFromDisk(filePath: string, context?: import('../types').AgentToolContext): Promise<boolean> {
        try {
            const client = (this.ctx as any).client;
            if (!client) return false;
            const uri = vs.Uri.file(filePath);
            const res = await this.withAbortAndTimeout(
                client.sendRequest('workspace/executeCommand', {
                    command: 'cwtools.ai.revalidateFiles',
                    arguments: [[uri.toString()]],
                }) as Promise<Record<string, unknown> | null>,
                1500,
                'Diagnostics revalidation request timed out.',
                context?.runnerOptions?.abortSignal,
            );
            return !!(res && typeof res === 'object' && res.ok === true);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            return false;
        }
    }

    /**
* The client side polls getDiagnosticsFresh and waits for epoch > minEpoch (i.e. the new lint has completed).
* Does not hold any server-side locks to avoid deadlocks. Wait at most timeoutMs (default 3000ms). 
* 
* @param minEpoch epoch value before writing, waiting for epoch > minEpoch means lint has processed this write 
*/
    async getLspDiagnosticsForFileFresh(filePath: string, minEpoch = 0, context?: import('../types').AgentToolContext): Promise<{
        diagnostics: ValidationError[];
        freshness: 'fresh' | 'pending' | 'stale';
        pendingGlobalKinds: string[];
        epoch: number;
        timedOut?: boolean;
    }> {
        if (context?.runnerOptions?.schedulingState.domainProfile === 'general') {
            const diagnostics = await this.getLspDiagnosticsForFile(filePath, context);
            return {
                diagnostics,
                freshness: 'fresh',
                pendingGlobalKinds: [],
                epoch: Date.now(),
                timedOut: false,
            };
        }
        const timeoutMs = 3000;
        const pollIntervalMs = 100;
        const uri = vs.Uri.file(filePath);
        const triggered = await this.requestRevalidateFromDisk(filePath, context);
        if (!triggered) {
            try { await vs.workspace.openTextDocument(uri); } catch { /* may already be open */ }
        }

        //Client-side polling getDiagnosticsFresh (returns immediately, does not hold a lock)
        let elapsed = 0;
        let lastState: {
            freshness: 'fresh' | 'pending' | 'stale';
            epoch: number;
            pendingGlobalKinds: string[];
            diagnostics?: ValidationError[];
        } | null = null;
        while (elapsed < timeoutMs) {
            lastState = await this.queryDiagnosticsFresh(filePath, context);
            if (lastState) {
                // Waiting conditions: epoch > minEpoch (indicating that the new lint has been completed), and freshness != stale
                if (lastState.epoch > minEpoch && lastState.freshness !== 'stale') {
                    return {
                        diagnostics: lastState.diagnostics ?? FileToolHandler.mapDiagnostics(uri),
                        freshness: lastState.freshness,
                        pendingGlobalKinds: lastState.pendingGlobalKinds,
                        epoch: lastState.epoch,
                        timedOut: false,
                    };
                }
            } else {
                break; // LSP is unavailable, go to fallback
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
            elapsed += pollIntervalMs;
        }

        // Timed out but LSP available - return current state + timedOut
        if (lastState) {
            return {
                diagnostics: lastState.diagnostics ?? FileToolHandler.mapDiagnostics(uri),
                freshness: lastState.freshness,
                pendingGlobalKinds: lastState.pendingGlobalKinds,
                epoch: lastState.epoch,
                timedOut: true,
            };
        }

        // Fallback: LSP is not available, use the old Problems panel to debounce and wait
        const diagnostics = await this.getLspDiagnosticsForFile(filePath);
        return {
            diagnostics,
            freshness: 'pending',
            pendingGlobalKinds: [],
            epoch: 0,
        };
    }

    /** Wait (up to 2s) for LSP to process a file, then return its diagnostics (fallback) */
    async getLspDiagnosticsForFile(filePath: string, context?: import('../types').AgentToolContext): Promise<ValidationError[]> {
        try {
            const uri = vs.Uri.file(filePath);
            try { await vs.workspace.openTextDocument(uri); } catch { /* may already be open */ }
            // P3 Fix: debounce diagnostic events - wait 300ms after last change
            // to avoid returning incomplete diagnostics from intermediate LSP states
            await this.withAbortAndTimeout(new Promise<void>((resolve) => {
                let settled = false;
                let debounce: ReturnType<typeof setTimeout> | null = null;
                // eslint-disable-next-line prefer-const -- deferred initialization
                let sub: vs.Disposable | undefined;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    if (debounce) clearTimeout(debounce);
                    clearTimeout(maxTimeout);
                    sub?.dispose();
                    resolve();
                };
                const maxTimeout = setTimeout(finish, 2000);
                sub = vs.languages.onDidChangeDiagnostics((e) => {
                    if (e.uris.some(u => u.fsPath === uri.fsPath)) {
                        if (debounce) clearTimeout(debounce);
                        debounce = setTimeout(finish, 300);
                    }
                });
            }), 2500, 'Diagnostics panel wait timed out.', context?.runnerOptions?.abortSignal);
            return vs.languages.getDiagnostics(uri)
                .filter(d => context?.runnerOptions?.schedulingState.domainProfile !== 'general' || !/cwtools/i.test(d.source ?? ''))
                .map(d => {
                const metadata = diagnosticMetadata(d);
                return {
                    code: diagnosticCodeString(d.code) ?? '',
                    severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                        : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                            : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                    message: d.message,
                    line: d.range.start.line,
                    column: d.range.start.character,
                    category: metadata.category,
                    repairHint: metadata.repairHint,
                    expectedType: metadata.expectedType,
                    actualType: metadata.actualType,
                    scope: metadata.scope,
                    symbol: metadata.symbol,
                    confidence: metadata.confidence,
                    metadataSource: metadata.metadataSource,
                    data: metadata.data,
                    } as ValidationError;
                });
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            return [];
        }
    }

    // - OpenCode Replacer Suite -
    // Ported from: opencode/packages/opencode/src/tool/edit.ts
    // Strategies extracted to ./replacerSuite.ts for testability.

    private normalizeLineEndings(text: string): string { return text.split('\r\n').join('\n'); }
    private detectLineEnding(text: string): '\n' | '\r\n' { return text.includes('\r\n') ? '\r\n' : '\n'; }
    private convertLineEnding(text: string, ending: '\n' | '\r\n'): string {
        return ending === '\n' ? text : text.split('\n').join('\r\n');
    }

    /** Main replace: delegates to fuzzyReplace (8 strategies, first match wins) */
    replace(content: string, oldString: string, newString: string, replaceAll: boolean): string {
        return fuzzyReplace(content, oldString, newString, replaceAll);
    }

    private buildUnifiedDiff(filePath: string, original: string, modified: string): string {
        const name = path.basename(filePath);
        const oL = original.split('\n'), mL = modified.split('\n');
        let diff = `--- ${name}\n+++ ${name}\n`, changed = 0;
        let i = 0, j = 0;
        while ((i < oL.length || j < mL.length) && changed < 80) {
            if (oL[i] === mL[j]) { i++; j++; }
            else { changed++; if (i < oL.length) { diff += `- ${oL[i++]}\n`; } if (j < mL.length) { diff += `+ ${mL[j++]}\n`; } }
        }
        return changed === 0 ? diff + '(no changes)\n' : diff;
    }

    // - write_localisation -

    async writeLocalisation(args: {
        filePath: string;
        language: string;
        entries: Array<{ key: string; value: string; number?: number; comment?: string }>;
        /** Explicit multi-file transaction: sibling language files to write in lockstep. */
        languages?: string[];
    }, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
        // Explicit multi-file transaction: validate every target first; if any
        // target is invalid, reject the whole transaction with no partial writes.
        const languages = Array.isArray(args.languages) && args.languages.length > 0
            ? args.languages.map(value => value.trim()).filter(Boolean)
            : [];
        if (languages.length > 0) {
            const rawTargets = getLocalisationTransactionTargets(args.filePath, languages);
            const targets: Array<{ languageTag: string; filePath: string }> = [];
            for (const target of rawTargets) {
                try {
                    const authorized = await this.resolveAndAuthorizeWrite(target.filePath, 'write_localisation', context);
                    targets.push({ ...target, filePath: authorized });
                } catch (error) {
                    // Authorization failures (read-before-write, scope, approval)
                    // are not path-shape failures. Preserve the real actionable
                    // reason and abort before snapshots or writes begin.
                    return {
                        success: false,
                        message: `write_localisation multi-file transaction authorization failed for ${target.languageTag}: ${error instanceof Error ? error.message : String(error)}. No files were written.`,
                    };
                }
            }
            const invalid = targets.filter(target => this.validateLocalisationTarget(target.filePath) !== null);
            if (invalid.length > 0) {
                return {
                    success: false,
                    message: `write_localisation multi-file transaction rejected: ${invalid.length} of ${targets.length} target language files are outside localisation/ or localization/ (${invalid.map(item => item.languageTag).join(', ')}). No files were written.`,
                };
            }
            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            const snapshots = new Map<string, { existed: boolean; content?: string }>();
            for (const target of targets) {
                if (vfsOverlay) {
                    snapshots.set(target.filePath, { existed: vfsOverlay.has(target.filePath), content: vfsOverlay.get(target.filePath) });
                } else if (fs.existsSync(target.filePath)) {
                    snapshots.set(target.filePath, { existed: true, content: await fs.promises.readFile(target.filePath, 'utf8') });
                } else {
                    snapshots.set(target.filePath, { existed: false });
                }
            }
            const results: string[] = [];
            const written: string[] = [];
            for (const target of targets) {
                written.push(target.filePath);
                const result = await this.writeSingleLocalisation({
                    filePath: target.filePath,
                    language: target.languageTag,
                    entries: args.entries,
                }, context);
                if (!result.success) {
                    const rollbackErrors: string[] = [];
                    for (const writtenPath of [...written].reverse()) {
                        const snapshot = snapshots.get(writtenPath)!;
                        try {
                            if (vfsOverlay) {
                                if (snapshot.existed) vfsOverlay.set(writtenPath, snapshot.content ?? '');
                                else vfsOverlay.delete(writtenPath);
                            } else if (snapshot.existed) {
                                await fs.promises.writeFile(writtenPath, snapshot.content ?? '', 'utf8');
                            } else if (fs.existsSync(writtenPath)) {
                                await fs.promises.unlink(writtenPath);
                            }
                        } catch (error) {
                            rollbackErrors.push(`${path.basename(writtenPath)}: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                    return {
                        success: false,
                        message: rollbackErrors.length === 0
                            ? `write_localisation multi-file transaction failed at ${target.languageTag}: ${result.message ?? 'unknown error'}. All earlier writes were rolled back.`
                            : `write_localisation multi-file transaction failed at ${target.languageTag}; rollback was incomplete: ${rollbackErrors.join('; ')}`,
                    };
                }
                results.push(`${target.languageTag}: ${result.message ?? 'ok'}`);
            }
            return { success: true, message: results.join(' | ') };
        }
        return this.writeSingleLocalisation(args, context);
    }

    private async writeSingleLocalisation(args: {
        filePath: string;
        language: string;
        entries: Array<{ key: string; value: string; number?: number; comment?: string }>;
    }, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
        return this.executeWithLock(args.filePath, async () => {
            try {
                const filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'write_localisation', context);
                const targetError = this.validateLocalisationTarget(filePath);
                if (targetError) {
                    return { success: false, message: targetError };
                }
                if (!args.entries || args.entries.length === 0) {
                    return { success: false, message: 'No entries provided.' };
                }

                const BOM = '\uFEFF';
                let lines: string[];
                let hasBom = true;
                let originalContent = '';
                const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;

                if (vfsOverlay && vfsOverlay.has(filePath)) {
                    const raw = vfsOverlay.get(filePath)!;
                    originalContent = raw;
                    hasBom = raw.charCodeAt(0) === 0xFEFF;
                    const clean = hasBom ? raw.slice(1) : raw;
                    lines = clean.split(/\r?\n/);
                } else if (fs.existsSync(filePath)) {
                    // Read existing file
                    const raw = await fs.promises.readFile(filePath, 'utf-8');
                    originalContent = raw;
                    hasBom = raw.startsWith(BOM);
                    const clean = hasBom ? raw.slice(1) : raw;
                    lines = clean.split(/\r?\n/);
                } else {
                    // Create new file with header
                    const lang = args.language || 'l_english';
                    lines = [`${lang}:`];
                    (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, null);
                }

                // Build a map of existing keys -> line index for O(1) lookup
                const keyLineMap = new Map<string, number>();
                const keyRegex = /^\s*([\w.-]+):\d*\s*"/;
                for (let i = 0; i < lines.length; i++) {
                    const m = lines[i]!.match(keyRegex);
                    if (m) keyLineMap.set(m[1]!, i);
                }

                // Process entries: update existing or append new
                const appendLines: string[] = [];
                let updated = 0, added = 0;

                for (const entry of args.entries) {
                    const num = entry.number ?? 0;
                    // Sanitize value for Stellaris yml format
                    // AI sends JSON \n -> 0x0A newline; or JSON \\n -> literal \n
                    // Stellaris needs literal \n (backslash+n) for in-game line breaks
                    const val = entry.value
                        .replace(/\r\n/g, String.raw`\n`)     // CRLF -> literal \n
                        .replace(/\n/g, String.raw`\n`)        // LF -> literal \n
                        .replace(/\r/g, '')                     // stray CR -> remove
                        .replace(/\t/g, String.raw`\t`)        // tab -> literal \t
                        .replace(/\u201C|\u201D/g, '"')         // smart quotes -> ASCII
                        .replace(/\u2018|\u2019/g, "'");        // smart apostrophes -> ASCII
                    const formattedLine = ` ${entry.key}:${num} "${val}"`;

                    if (keyLineMap.has(entry.key)) {
                        // Update existing key in-place
                        const lineIdx = keyLineMap.get(entry.key)!;
                        lines[lineIdx] = formattedLine;
                        updated++;
                    } else {
                        // Append: add section comment if provided
                        if (entry.comment) {
                            appendLines.push(` ${entry.comment}`);
                        }
                        appendLines.push(formattedLine);
                        added++;
                    }
                }

                // Append new entries at end of file
                if (appendLines.length > 0) {
                    // Remove trailing empty lines to prevent double-blank-line accumulation
                    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
                        lines.pop();
                    }
                    lines.push(...appendLines);
                }

                // Ensure file ends cleanly (remove trailing empty lines, add single newline)
                while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
                    lines.pop();
                }
                const finalContent = lines.join('\n') + '\n';
                const withBom = (hasBom ? BOM : '') + finalContent;

                if (fs.existsSync(filePath)) {
                    (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent);
                }

                // Confirm mode
                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                    const messageId = `writeloc_${crypto.randomUUID()}`;
                    const confirmed = await this.confirmPendingWrite(filePath, withBom, messageId, context);
                    if (!confirmed) {
                        return { success: false, message: 'User rejected localisation write.' };
                    }
                }

                const preWriteEpoch = (await this.queryDiagnosticsFresh(filePath, context))?.epoch ?? 0;

                // Write
                if (vfsOverlay) {
                    vfsOverlay.set(filePath, withBom);
                } else {
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    await fs.promises.writeFile(filePath, withBom, 'utf-8');
                }
                const readTracker = (context?.agentRunner as any)?.readTracker;
                if (readTracker) { readTracker.markWritten(filePath); }

                // Clear failure counter for this file since we succeeded
                this.editFailCount.delete(this.pathKey(filePath));

                const diff = this.buildUnifiedDiff(filePath, originalContent, withBom);

                // Get the diagnostic freshness after localized writing
                const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch, context);
                const diagnostics = freshResult.diagnostics;
                const finalKeySet = new Set<string>();
                for (const line of finalContent.split(/\r?\n/)) {
                    const m = line.match(keyRegex);
                    if (m) finalKeySet.add(m[1]!);
                }
                const localKeyIndexed = args.entries.every(entry => finalKeySet.has(entry.key));
                const fileSyntaxFresh = !diagnostics.some(d => d.severity === 'error' && /^CW001/.test(d.code));
                const globalLocalisationFresh = freshResult.freshness === 'fresh' && !freshResult.pendingGlobalKinds.includes('localisation');

                return {
                    success: true,
                    message: `Localisation updated: ${added} added, ${updated} updated. Total entries: ${args.entries.length}. Freshness: ${freshResult.freshness}`,
                    diff,
                    diagnostics,
                    freshness: freshResult.freshness,
                    pendingGlobalKinds: freshResult.pendingGlobalKinds,
                    fileSyntaxFresh,
                    localKeyIndexed,
                    globalLocalisationFresh,
                    stats: { linesAdded: added, linesRemoved: 0 },
                };
            } catch (e) {
                return { success: false, message: `write_localisation failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });
    }

    // - writeDesignBlueprint -

    async writeDesignBlueprint(input: import('../types').WriteDesignBlueprintArgs | { blueprint: import('../types').WriteDesignBlueprintArgs }, context?: import('../types').AgentToolContext): Promise<import('../types').WriteDesignBlueprintResult> {
        try {
            const rawArgs = 'blueprint' in input ? input.blueprint : input;
            const failBlueprint = (message: string): import('../types').WriteDesignBlueprintResult => ({
                success: false,
                approvalReady: false,
                message,
                filePath: '',
            });
            if (!String(rawArgs.title ?? '').trim()) {
                return failBlueprint('Design blueprint refused: title is required.');
            }
            if (!Array.isArray(rawArgs.unresolvedCritical)) {
                return failBlueprint('Design blueprint refused: unresolvedCritical must be an array. Use [] for an approval-ready plan or list exact blockers to save a draft.');
            }
            const unresolvedCritical = rawArgs.unresolvedCritical
                .map(item => String(item).trim())
                .filter(Boolean);
            const args = {
                ...rawArgs,
                title: String(rawArgs.title).trim(),
                entities: Array.isArray(rawArgs.entities) ? rawArgs.entities : [],
                commonDirectoryReview: Array.isArray(rawArgs.commonDirectoryReview) ? rawArgs.commonDirectoryReview : [],
                subsystemPlan: Array.isArray(rawArgs.subsystemPlan) ? rawArgs.subsystemPlan : [],
                triggerPlan: Array.isArray(rawArgs.triggerPlan) ? rawArgs.triggerPlan : [],
                branchingPlan: Array.isArray(rawArgs.branchingPlan) ? rawArgs.branchingPlan : [],
                rewardPlan: Array.isArray(rawArgs.rewardPlan) ? rawArgs.rewardPlan : [],
                cleanupPlan: Array.isArray(rawArgs.cleanupPlan) ? rawArgs.cleanupPlan : [],
                evidence: Array.isArray(rawArgs.evidence) ? rawArgs.evidence : [],
                dependencyOrder: Array.isArray(rawArgs.dependencyOrder) ? rawArgs.dependencyOrder : [],
                featureManifest: {
                    ...rawArgs.featureManifest,
                    objective: String(rawArgs.featureManifest?.objective ?? '').trim(),
                    entities: Array.isArray(rawArgs.featureManifest?.entities) ? rawArgs.featureManifest.entities : [],
                    requiredEdges: Array.isArray(rawArgs.featureManifest?.requiredEdges) ? rawArgs.featureManifest.requiredEdges : [],
                    acceptanceCriteria: Array.isArray(rawArgs.featureManifest?.acceptanceCriteria) ? rawArgs.featureManifest.acceptanceCriteria : [],
                },
                taskPlan: Array.isArray(rawArgs.taskPlan) ? rawArgs.taskPlan : [],
                unresolvedCritical,
            };
            const approvalReady = unresolvedCritical.length === 0;
            const hasItems = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0;
            if (approvalReady) {
                const requiredSections: Array<[string, unknown]> = [
                    ['entities', args.entities],
                    ['evidence', args.evidence],
                    ['featureManifest.entities', args.featureManifest.entities],
                    ['featureManifest.acceptanceCriteria', args.featureManifest.acceptanceCriteria],
                    ['taskPlan', args.taskPlan],
                ];
                const missingSections = requiredSections
                    .filter(([, value]) => !hasItems(value))
                    .map(([name]) => name);
                if (missingSections.length > 0) {
                    return failBlueprint(`Design blueprint refused: approval-ready plans still need: ${missingSections.join(', ')}. Add exact blockers to unresolvedCritical to save the current work as a draft instead.`);
                }
                if (!args.taskPlan.some(task => (task.plannedFiles?.length ?? 0) > 0)) {
                    return failBlueprint('Design blueprint refused: an approval-ready taskPlan must name at least one exact planned file.');
                }
            }

            if (approvalReady) {
            const manifest = args.featureManifest;
            if (!manifest.objective) {
                return failBlueprint('Design blueprint refused: featureManifest.objective is required.');
            }
            const manifestEntityIds = new Set(manifest.entities.map(entity => entity.id.trim()).filter(Boolean));
            const duplicateManifestEntities = manifest.entities
                .map(entity => `${entity.kind}:${entity.id}:${entity.operation}`.toLowerCase())
                .filter((key, index, all) => all.indexOf(key) !== index);
            if (duplicateManifestEntities.length > 0) {
                return failBlueprint(`Design blueprint refused: duplicate feature entity contracts: ${[...new Set(duplicateManifestEntities)].join(', ')}.`);
            }
            const invalidEdges = manifest.requiredEdges
                .filter(edge => !manifestEntityIds.has(edge.from) || !manifestEntityIds.has(edge.to))
                .map(edge => `${edge.from} --${edge.relation}--> ${edge.to}`);
            if (invalidEdges.length > 0) {
                return failBlueprint(`Design blueprint refused: every required edge endpoint must be declared in featureManifest.entities. Invalid edge(s): ${invalidEdges.join('; ')}.`);
            }
            const criterionIds = manifest.acceptanceCriteria.map(item => item.id.trim()).filter(Boolean);
            if (new Set(criterionIds).size !== criterionIds.length) {
                return failBlueprint('Design blueprint refused: acceptance criterion IDs must be unique.');
            }

            const taskIds = args.taskPlan.map(task => task.id.trim()).filter(Boolean);
            if (new Set(taskIds).size !== taskIds.length) {
                return failBlueprint('Design blueprint refused: taskPlan IDs must be non-empty and unique.');
            }
            const knownTaskIds = new Set(taskIds);
            const invalidTaskDependencies = args.taskPlan.flatMap(task =>
                task.dependencies.filter(dependency => !knownTaskIds.has(dependency)).map(dependency => `${task.id} -> ${dependency}`)
            );
            if (invalidTaskDependencies.length > 0) {
                return failBlueprint(`Design blueprint refused: taskPlan contains missing dependencies: ${invalidTaskDependencies.join(', ')}.`);
            }
            const taskById = new Map(args.taskPlan.map(task => [task.id, task]));
            const visitedTasks = new Set<string>();
            const activeTasks = new Set<string>();
            const visitTask = (taskId: string): boolean => {
                if (activeTasks.has(taskId)) return true;
                if (visitedTasks.has(taskId)) return false;
                visitedTasks.add(taskId);
                activeTasks.add(taskId);
                const cyclic = (taskById.get(taskId)?.dependencies ?? []).some(visitTask);
                activeTasks.delete(taskId);
                return cyclic;
            };
            if (taskIds.some(visitTask)) {
                return failBlueprint('Design blueprint refused: taskPlan contains a dependency cycle.');
            }
            const orphanLocTasks = args.taskPlan
                .filter(task => task.profileName === 'localization-writer'
                    && task.produces?.some(contract => contract.kind === 'localisation')
                    && !task.consumes?.some(contract => contract.kind !== 'localisation'))
                .map(task => task.id);
            if (orphanLocTasks.length > 0) {
                return failBlueprint(`Design blueprint refused: localisation tasks must consume their owning event/object entity: ${orphanLocTasks.join(', ')}.`);
            }
            const assignedContractKeys = new Set(args.taskPlan.flatMap(task => [
                ...(task.produces ?? []),
                ...(task.consumes ?? []),
            ]).map(contract => `${contract.kind}:${contract.id}:${contract.operation}`.toLowerCase()));
            const unassignedContracts = manifest.entities
                .filter(contract => contract.required !== false
                    && !assignedContractKeys.has(`${contract.kind}:${contract.id}:${contract.operation}`.toLowerCase()))
                .map(contract => `${contract.kind}:${contract.id}:${contract.operation}`);
            if (unassignedContracts.length > 0) {
                return failBlueprint(`Design blueprint refused: required feature contracts are not assigned to taskPlan nodes: ${unassignedContracts.join(', ')}.`);
            }
            const producersByEntity = new Map<string, string[]>();
            for (const task of args.taskPlan) {
                for (const contract of task.produces ?? []) {
                    const key = `${contract.kind}:${contract.id}`.toLowerCase();
                    producersByEntity.set(key, [...(producersByEntity.get(key) ?? []), task.id]);
                }
            }
            const missingDataFlowDependencies: string[] = [];
            const dependsOnTask = (taskId: string, dependencyId: string, seen = new Set<string>()): boolean => {
                if (seen.has(taskId)) return false;
                seen.add(taskId);
                return (taskById.get(taskId)?.dependencies ?? []).some(dependency =>
                    dependency === dependencyId || dependsOnTask(dependency, dependencyId, seen));
            };
            for (const task of args.taskPlan) {
                for (const contract of task.consumes ?? []) {
                    const producers = producersByEntity.get(`${contract.kind}:${contract.id}`.toLowerCase()) ?? [];
                    for (const producer of producers) {
                        if (producer !== task.id && !dependsOnTask(task.id, producer)) {
                            missingDataFlowDependencies.push(`${task.id} consumes ${contract.kind}:${contract.id} but does not depend on ${producer}`);
                        }
                    }
                }
            }
            if (missingDataFlowDependencies.length > 0) {
                return failBlueprint(`Design blueprint refused: task DAG does not encode entity data flow: ${missingDataFlowDependencies.join('; ')}.`);
            }

            const commonReview = args.commonDirectoryReview;
            const commonWithoutFindings = commonReview
                .filter(item => !String(item.findings ?? '').trim())
                .map(item => item.directory);
            if (commonWithoutFindings.length > 0) {
                return failBlueprint(`Design blueprint refused: commonDirectoryReview entries need concrete CWT/project/vanilla findings. Missing findings for: ${commonWithoutFindings.join(', ')}.`);
            }

            const entitiesMissingScope = args.entities
                .filter(entity => !String(entity.scopeContext ?? '').trim())
                .map(entity => entity.id);
            if (entitiesMissingScope.length > 0) {
                return failBlueprint(`Design blueprint refused: every entity needs a scopeContext, even if it is "definition/no runtime scope". Missing scopeContext for: ${entitiesMissingScope.join(', ')}.`);
            }

            const rewardWithoutImplementation = args.rewardPlan
                .filter(reward => !String(reward.directory ?? '').trim() || !String(reward.entityType ?? '').trim() || !String(reward.implementation ?? '').trim())
                .map(reward => reward.rewardId);
            if (rewardWithoutImplementation.length > 0) {
                return failBlueprint(`Design blueprint refused: every reward must name a concrete directory/entity type and implementation path. Incomplete reward(s): ${rewardWithoutImplementation.join(', ')}.`);
            }

            const cleanupWithoutMechanism = args.cleanupPlan
                .filter(item => !String(item.cleanup ?? '').trim())
                .map(item => item.target);
            if (cleanupWithoutMechanism.length > 0) {
                return failBlueprint(`Design blueprint refused: cleanupPlan entries need exact cleanup or closure mechanisms. Missing cleanup for: ${cleanupWithoutMechanism.join(', ')}.`);
            }

            const evidence = args.evidence;
            const evidenceText = evidence
                .map(item => `${item.sourceType} ${item.source} ${item.insight}`)
                .join('\n')
                .toLowerCase();
            const hasCwtEvidence = /(cwt|lsp|query_rules|query_scope|query_types|scope|rule)/.test(evidenceText);
            if (!hasCwtEvidence) {
                return failBlueprint('Design blueprint refused: evidence must include at least one CWT/LSP or typed-rule verification source.');
            }
            const complexBlueprint = args.entities.length >= 3 || args.subsystemPlan.length >= 2;
            if (complexBlueprint) {
                const evidenceKinds = evidence.map(item => `${item.sourceType} ${item.source}`.toLowerCase());
                const hasKnowledge = evidenceKinds.some(value => value.includes('project_knowledge') || value.includes('query_project_knowledge') || value.includes('.cwtools/project/knowledge'));
                const hasVanilla = evidenceKinds.some(value => value.includes('vanilla'));
                if (!hasKnowledge && !hasVanilla) {
                    return failBlueprint('Design blueprint refused: complex plans must cite current project knowledge or a bounded vanilla archetype.');
                }
            }
            }

            // Keep one canonical, topic-scoped plan artifact. The executable blueprint
            // contract is embedded in the Markdown instead of drifting into sidecar files.
            const topicId = context?.runnerOptions?.topicId || 'default';
            const blueprintDir = getPrivateTopicStorageDir(topicId, this.ctx.workspaceRoot);
            if (!fs.existsSync(blueprintDir)) fs.mkdirSync(blueprintDir, { recursive: true });
            const blueprintPath = path.join(blueprintDir, 'Implementation_Plan.md');
            const previousContent = fs.existsSync(blueprintPath) ? fs.readFileSync(blueprintPath, 'utf-8') : null;

            const lines: string[] = [];
            lines.push(`# Implementation Plan: ${args.title}`);
            lines.push('');
            lines.push(`> Auto-generated by AI Agent - Plan Mode`);
            lines.push(`> Generated: ${new Date().toISOString()}`);
            lines.push('');

            lines.push('## Blueprint Completeness Gate');
            lines.push('');
            const gate = (complete: boolean, label: string) => lines.push(`- [${complete ? 'x' : ' '}] ${label}`);
            gate(args.entities.length > 0, 'Entity topology is present');
            gate(args.evidence.length > 0, 'Semantic evidence is present');
            gate(args.featureManifest.entities.length > 0 && args.featureManifest.acceptanceCriteria.length > 0,
                'Feature manifest defines entity operations and acceptance criteria');
            gate(args.taskPlan.length > 0, 'Execution task plan is present');
            lines.push(approvalReady
                ? '- [x] No design-changing facts remain unresolved'
                : `- [ ] ${unresolvedCritical.length} design-changing fact(s) remain unresolved; approval handoff is withheld`);
            lines.push('');

            if (unresolvedCritical.length > 0) {
                lines.push('## Unresolved Critical Decisions');
                lines.push('');
                for (const unresolved of unresolvedCritical) lines.push(`- ${unresolved}`);
                lines.push('');
            }

            const cell = (value: unknown): string => {
                if (value === undefined || value === null || value === '') return '-';
                return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
            };
            const listCell = (values?: string[]): string => values && values.length > 0 ? values.map(cell).join(', ') : '-';

            // Common directory capability review
            if (args.commonDirectoryReview && args.commonDirectoryReview.length > 0) {
                lines.push('## Common Directory Capability Review');
                lines.push('');
                lines.push('| Directory | Role Considered | Candidate Types | Used | Rationale | Findings |');
                lines.push('|-----------|-----------------|-----------------|------|-----------|----------|');
                for (const item of args.commonDirectoryReview) {
                    lines.push(`| \`${cell(item.directory)}\` | ${cell(item.role)} | ${listCell(item.candidateTypes)} | ${item.selected ? 'yes' : 'no'} | ${cell(item.rationale)} | ${cell(item.findings)} |`);
                }
                lines.push('');
            }

            // Engine subsystem plan
            if (args.subsystemPlan && args.subsystemPlan.length > 0) {
                lines.push('## Engine Subsystem Plan');
                lines.push('');
                lines.push('| Layer | Common Directories | Entities | Requirement Source | Rationale |');
                lines.push('|-------|--------------------|----------|--------------------|-----------|');
                for (const item of args.subsystemPlan) {
                    lines.push(`| ${cell(item.layer)} | ${listCell(item.directories)} | ${listCell(item.entities)} | ${cell(item.requirementSource)} | ${cell(item.rationale)} |`);
                }
                lines.push('');
            }

            // Entity Topology Map
            lines.push('## Entity Topology (Cascading Trigger Pipeline)');
            lines.push('');
            lines.push('| # | Entity ID | Type | File | Triggered By | Fires | Scope Context |');
            lines.push('|---|-----------|------|------|-------------|-------|---------------|');
            for (let i = 0; i < args.entities.length; i++) {
                const e = args.entities[i]!;
                const fires = listCell(e.fires);
                const triggeredBy = cell(e.triggeredBy);
                const scope = cell(e.scopeContext);
                lines.push(`| ${i + 1} | \`${cell(e.id)}\` | ${cell(e.type)} | \`${cell(e.file)}\` | ${triggeredBy} | ${fires} | ${scope} |`);
            }
            lines.push('');

            // Trigger flow visualization
            lines.push('### Trigger Flow');
            lines.push('```');
            for (let i = 0; i < args.entities.length; i++) {
                const e = args.entities[i]!;
                const prefix = i === 0 ? '[START]' : '  ->';
                const scopeNote = e.scopeContext ? ` (${e.scopeContext})` : '';
                lines.push(`${prefix} [${e.type}] ${e.id}${scopeNote}`);
                if (e.fires && e.fires.length > 0) {
                    for (const target of e.fires) {
                        lines.push(`      +-- fires -> ${target}`);
                    }
                }
            }
            lines.push('```');
            lines.push('');

            lines.push('## Executable Feature Relationship Contract');
            lines.push('');
            lines.push(`**Objective:** ${cell(args.featureManifest.objective)}`);
            lines.push('');
            lines.push('### Entity Operations');
            lines.push('');
            lines.push('| Kind | Entity | Operation | Scope | Required |');
            lines.push('|------|--------|-----------|-------|----------|');
            for (const contract of args.featureManifest.entities ?? []) {
                lines.push(`| ${cell(contract.kind)} | \`${cell(contract.id)}\` | ${cell(contract.operation)} | ${cell(contract.scope)} | ${contract.required === false ? 'no' : 'yes'} |`);
            }
            lines.push('');
            lines.push('### Required Edges');
            lines.push('');
            lines.push('| From | Relation | To | Required |');
            lines.push('|------|----------|----|----------|');
            for (const edge of args.featureManifest.requiredEdges ?? []) {
                lines.push(`| \`${cell(edge.from)}\` | ${cell(edge.relation)} | \`${cell(edge.to)}\` | ${edge.required === false ? 'no' : 'yes'} |`);
            }
            lines.push('');
            if ((args.featureManifest.invariants?.length ?? 0) > 0) {
                lines.push('### Invariants');
                lines.push('');
                for (const invariant of args.featureManifest.invariants ?? []) lines.push(`- ${cell(invariant)}`);
                lines.push('');
            }
            lines.push('### Acceptance Criteria');
            lines.push('');
            lines.push('| ID | Type | Subject | Required | Description |');
            lines.push('|----|------|---------|----------|-------------|');
            for (const check of args.featureManifest.acceptanceCriteria ?? []) {
                lines.push(`| \`${cell(check.id)}\` | ${cell(check.type)} | \`${cell(check.subject)}\` | ${check.required === false ? 'no' : 'yes'} | ${cell(check.description)} |`);
            }
            lines.push('');

            lines.push(approvalReady
                ? '## Approved Multi-Agent Task DAG'
                : '## Draft Multi-Agent Task DAG');
            lines.push('');
            lines.push('| Task | Agent | Planned Files | Produces | Consumes | Dependencies | Acceptance Checks |');
            lines.push('|------|-------|---------------|----------|----------|--------------|-------------------|');
            const contractCell = (contracts?: import('../types').TaskEntityContract[]) =>
                contracts?.map(contract => `${contract.kind}:${contract.id}:${contract.operation}`).join(', ') || '-';
            for (const task of args.taskPlan) {
                lines.push(`| \`${cell(task.id)}\` | ${cell(task.profileName)} | ${listCell(task.plannedFiles)} | ${cell(contractCell(task.produces))} | ${cell(contractCell(task.consumes))} | ${listCell(task.dependencies)} | ${listCell(task.acceptanceChecks?.map(check => check.id))} |`);
            }
            lines.push('');

            // Trigger and pacing plan
            if (args.triggerPlan && args.triggerPlan.length > 0) {
                lines.push('## Trigger and Pacing Plan');
                lines.push('');
                lines.push('| Node | Mechanism | Scope Bridge | Timing | Rationale |');
                lines.push('|------|-----------|--------------|--------|-----------|');
                for (const item of args.triggerPlan) {
                    lines.push(`| \`${cell(item.nodeId)}\` | ${cell(item.mechanism)} | ${cell(item.scopeBridge)} | ${cell(item.timing)} | ${cell(item.rationale)} |`);
                }
                lines.push('');
            }

            // Branching and convergence plan
            if (args.branchingPlan && args.branchingPlan.length > 0) {
                lines.push('## Branching and Convergence Plan');
                lines.push('');
                lines.push('| Branch | Starts From | Choices | Converges At | Consequences |');
                lines.push('|--------|-------------|---------|--------------|--------------|');
                for (const item of args.branchingPlan) {
                    lines.push(`| \`${cell(item.branchId)}\` | \`${cell(item.fromEntity)}\` | ${listCell(item.choices)} | ${cell(item.convergence)} | ${cell(item.consequences)} |`);
                }
                lines.push('');
            }

            // Reward and outcome plan
            if (args.rewardPlan && args.rewardPlan.length > 0) {
                lines.push('## Reward and Outcome Plan');
                lines.push('');
                lines.push('| Reward | Directory | Entity Type | Player Value | Implementation | Balance Notes |');
                lines.push('|--------|-----------|-------------|--------------|----------------|---------------|');
                for (const item of args.rewardPlan) {
                    lines.push(`| \`${cell(item.rewardId)}\` | \`${cell(item.directory)}\` | ${cell(item.entityType)} | ${cell(item.playerValue)} | ${cell(item.implementation)} | ${cell(item.balanceNotes)} |`);
                }
                lines.push('');
            }

            // Event ID Allocation
            if (args.eventIdAllocation) {
                lines.push('## Event ID Allocation');
                lines.push('');
                lines.push(`- **Namespace**: \`${args.eventIdAllocation.namespace}\``);
                lines.push(`- **Ranges**: ${args.eventIdAllocation.ranges}`);
                lines.push('');
            }

            // Localisation Keys
            if (args.localisationKeys && args.localisationKeys.length > 0) {
                lines.push('## Localisation Key Prefixes');
                lines.push('');
                for (const key of args.localisationKeys) {
                    lines.push(`- \`${key}\``);
                }
                lines.push('');
            }

            // Dependency Order
            lines.push('## File Dependency Order (Write Sequence)');
            lines.push('');
            for (let i = 0; i < args.dependencyOrder.length; i++) {
                lines.push(`${i + 1}. \`${args.dependencyOrder[i]}\``);
            }
            lines.push('');

            // Cleanup and lifecycle closure plan
            if (args.cleanupPlan && args.cleanupPlan.length > 0) {
                lines.push('## Cleanup and Closure Plan');
                lines.push('');
                lines.push('| Target | Lifecycle | Cleanup Mechanism | Owner |');
                lines.push('|--------|-----------|-------------------|-------|');
                for (const item of args.cleanupPlan) {
                    lines.push(`| \`${cell(item.target)}\` | ${cell(item.lifecycle)} | ${cell(item.cleanup)} | ${cell(item.owner)} |`);
                }
                lines.push('');
            }

            // Evidence used to build the design
            if (args.evidence && args.evidence.length > 0) {
                lines.push('## Evidence Studied');
                lines.push('');
                lines.push('| Source Type | Source | Design Insight |');
                lines.push('|-------------|--------|----------------|');
                for (const item of args.evidence) {
                    lines.push(`| ${cell(item.sourceType)} | \`${cell(item.source)}\` | ${cell(item.insight)} |`);
                }
                lines.push('');
            }

            // Risk register
            if (args.riskRegister && args.riskRegister.length > 0) {
                lines.push('## Risk Register');
                lines.push('');
                for (const risk of args.riskRegister) {
                    lines.push(`- ${cell(risk)}`);
                }
                lines.push('');
            }

            // Notes
            if (args.notes) {
                lines.push('## Design Notes');
                lines.push('');
                lines.push(args.notes);
                lines.push('');
            }

            // Scope Chain Verification Checklist
            lines.push('## Scope Chain Verification Checklist');
            lines.push('');
            lines.push('Warning: Before Build phase, verify each entity\'s scope matches CWT rules:');
            lines.push('');
            // Entity-specific scope facts must come from active CWT/LSP, not this template.
            const entityTypes = Array.from(new Set(args.entities.map(e => e.type))).filter((type): type is string => !!type);
            if (entityTypes.length > 0) {
                lines.push(`- [ ] Verified scope contexts for entity type(s): ${entityTypes.join(', ')}`);
            }
            lines.push('- [ ] Verified trigger/event context with query_scope, query_rules, query_cwt_schema, completions, diagnostics, or a current-version archetype');
            lines.push('- [ ] Recorded evidence for every scope bridge and did not fill scope facts from static prompt memory');
            // Always add cross-scope persistence check without prescribing game-specific scope facts.
            lines.push('- [ ] Cross-scope references and persistence mechanisms are verified against active CWT/LSP evidence');
            lines.push('- [ ] All entity IDs are unique and follow project namespace conventions');
            lines.push('');

            const executableBlueprint = {
                schemaVersion: 2,
                generatedAt: new Date().toISOString(),
                ...args,
                unresolvedCritical,
            };
            lines.push('## Executable Plan Contract');
            lines.push('');
            const targetFiles = Array.from(new Set(args.taskPlan.flatMap(task => task.plannedFiles ?? [])));
            const operations = args.taskPlan.map(task => ({
                id: task.id,
                description: task.prompt,
                files: task.plannedFiles ?? [],
                dependsOn: task.dependencies,
            }));
            const verification = Array.from(new Set((args.featureManifest.acceptanceCriteria ?? []).map(check => check.description)));
            const risks = (args.riskRegister ?? []).map(risk => ({
                risk,
                mitigation: 'Verify the affected entity contracts and diagnostics before accepting the implementation.',
            }));
            const handoff = {
                version: 1,
                status: approvalReady ? 'ready' : 'draft',
                tier: 'blueprint',
                objective: args.featureManifest.objective || args.title,
                targetFiles,
                operations,
                verification,
                acceptanceCriteria: verification,
                risks: risks.length > 0 ? risks : [{
                    risk: 'Implementation may diverge from the approved entity and dependency contracts.',
                    mitigation: 'Dispatch the embedded task DAG verbatim and verify every required acceptance check.',
                }],
                rollback: targetFiles.length > 0
                    ? ['Revert the exact target files listed in this plan to their pre-execution contents.']
                    : [],
                unresolvedCritical,
                blueprint: executableBlueprint,
            };
            lines.push('```cwtools-plan');
            lines.push(JSON.stringify(handoff, null, 2));
            lines.push('```');
            lines.push('');
            if (!approvalReady) {
                lines.push('> Approval handoff is withheld until the unresolved critical decisions above are answered.');
                lines.push('');
            }

            const content = lines.join('\n');
            const beforeWrite = context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite;
            beforeWrite?.(blueprintPath, previousContent);
            fs.writeFileSync(blueprintPath, content, 'utf-8');

            return {
                success: true,
                approvalReady,
                message: approvalReady
                    ? `Unified Implementation Plan saved to ${blueprintPath}. It contains the human-readable design, approval handoff, and executable Multi-Agent contract.`
                    : `Blueprint draft saved to ${blueprintPath}. Resolve ${unresolvedCritical.length} critical decision(s), then write it again with unresolvedCritical: [] to create the approval handoff.`,
                filePath: blueprintPath,
                dataFilePath: blueprintPath,
                writtenFiles: [blueprintPath],
            };
        } catch (e) {
            return {
                success: false,
                approvalReady: false,
                message: `Failed to write design blueprint: ${e instanceof Error ? e.message : String(e)}`,
                filePath: '',
            };
        }
    }

    // - Git Operations -

    /**
     * Execute safe git operations: status, diff, checkout (revert file to HEAD).
     * Only works when the workspace has a git repository.
     */
    async gitOps(args: { action: 'status' | 'diff' | 'checkout'; file?: string }): Promise<{ success: boolean; message: string; output?: string; writtenFiles?: string[] }> {
        const { execFileSync } = await import('child_process');
        const wsRoot = this.ctx.workspaceRoot;

        // Check if git repo exists
        const gitDir = path.join(wsRoot, '.git');
        if (!fs.existsSync(gitDir)) {
            return { success: false, message: 'No git repository found in workspace root. git_ops requires the workspace to be a git repo.' };
        }

        const MAX_OUTPUT = 8000;

        try {
            switch (args.action) {
                case 'status': {
                    const raw = execFileSync('git', ['status', '--porcelain'], { cwd: wsRoot, encoding: 'utf-8', timeout: 15_000 });
                    const lines = raw.trim().split('\n').filter(Boolean);
                    if (lines.length === 0) {
                        return { success: true, message: 'Working tree clean - no modified files.', output: '' };
                    }
                    const output = lines.slice(0, 100).join('\n');
                    return {
                        success: true,
                        message: `${lines.length} modified file(s).`,
                        output: output.length > MAX_OUTPUT ? output.substring(0, MAX_OUTPUT) + '\n... (truncated)' : output,
                    };
                }
                case 'diff': {
                    if (!args.file) {
                        return { success: false, message: 'The "diff" action requires a "file" parameter.' };
                    }
                    const absPath = path.resolve(wsRoot, args.file);
                    const filePath = path.relative(wsRoot, absPath);
                    if (filePath.startsWith('..') || path.isAbsolute(filePath)) {
                        return { success: false, message: 'git diff file must stay inside the workspace.' };
                    }
                    const raw = execFileSync('git', ['diff', 'HEAD', '--', filePath], { cwd: wsRoot, encoding: 'utf-8', timeout: 15_000 });
                    if (!raw.trim()) {
                        return { success: true, message: `No changes detected for ${filePath}.`, output: '' };
                    }
                    return {
                        success: true,
                        message: `Diff for ${filePath}:`,
                        output: raw.length > MAX_OUTPUT ? raw.substring(0, MAX_OUTPUT) + '\n... (truncated)' : raw,
                    };
                }
                case 'checkout': {
                    if (!args.file) {
                        return { success: false, message: 'The "checkout" action requires a "file" parameter.' };
                    }
                    const absPath = path.isAbsolute(args.file) ? args.file : path.join(wsRoot, args.file);
                    const relPath = path.relative(wsRoot, absPath);
                    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
                        return { success: false, message: 'git checkout file must stay inside the workspace.' };
                    }

                    // Snapshot for retract support
                    if (fs.existsSync(absPath)) {
                        const prev = fs.readFileSync(absPath, 'utf-8');
                        this.ctx.onBeforeFileWrite?.(absPath, prev);
                    }

                    execFileSync('git', ['checkout', 'HEAD', '--', relPath], { cwd: wsRoot, encoding: 'utf-8', timeout: 15_000 });

                    // Reset edit failure counter since the file is now back to a known-good state
                    this.editFailCount.delete(this.pathKey(absPath));

                    return {
                        success: true,
                        message: `Successfully reverted ${relPath} to last committed state (HEAD).`,
                        writtenFiles: [absPath],
                    };
                }
                default:
                    return { success: false, message: `Unknown git action: "${args.action}". Supported: status, diff, checkout.` };
            }
        } catch (e) {
            return { success: false, message: `git ${args.action} failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }
}
