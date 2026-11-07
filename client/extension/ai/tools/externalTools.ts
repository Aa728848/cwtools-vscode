/**
 * External Tool Handler — web fetch, web search, diagnostic whitelist helpers,
 * TODO list management, and media asset conversion/deployment.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TodoItem, TodoWriteResult } from '../types';
import { ScopedTodoStore } from './scopedTodoStore';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import {
    escapeRegExp,
    isPathInsideOrEqual,
    resolveWorkspacePathInput,
    sanitizePathInput,
} from '../workspaceSandbox';
import {
    WebAccessService,
    type WebAccessConfig,
    type WebAccessMode,
    type WebSearchContextSize,
    type WebSearchProvider,
} from './webAccess';

export { escapeRegExp, isPathInsideOrEqual, sanitizePathInput };

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties ExternalToolHandler reads from the executor. */
export interface ExternalToolContext {
    readonly workspaceRoot: string;
    /** Resolve search-provider credentials from VS Code SecretStorage. */
    getWebSearchApiKey?: (provider: Exclude<WebSearchProvider, 'auto' | 'duckduckgo' | 'searxng'>) => Promise<string | undefined>;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class ExternalToolHandler {
    private readonly todoStore = new ScopedTodoStore();
    private readonly webAccess: WebAccessService;

    constructor(private ctx: ExternalToolContext) {
        this.webAccess = new WebAccessService({
            getConfig: () => this.getWebAccessConfig(),
            getApiKey: provider => this.ctx.getWebSearchApiKey?.(provider) ?? Promise.resolve(undefined),
        });
    }

    private getWebAccessConfig(): WebAccessConfig {
        const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web');
        const providers = new Set<WebSearchProvider>(['auto', 'openai', 'brave', 'exa', 'tavily', 'serper', 'serpapi', 'searxng', 'duckduckgo']);
        const modes = new Set<WebAccessMode>(['disabled', 'indexed', 'live']);
        const contextSizes = new Set<WebSearchContextSize>(['low', 'medium', 'high']);
        const provider = cfg.get<string>('provider', 'auto') as WebSearchProvider;
        const mode = cfg.get<string>('mode', 'indexed') as WebAccessMode;
        const contextSize = cfg.get<string>('contextSize', 'medium') as WebSearchContextSize;
        const fallbackProviders = cfg.get<string[]>('fallbackProviders', [])
            .filter((value): value is WebSearchProvider => providers.has(value as WebSearchProvider));
        return {
            mode: modes.has(mode) ? mode : 'indexed',
            provider: providers.has(provider) ? provider : 'auto',
            fallbackProviders,
            contextSize: contextSizes.has(contextSize) ? contextSize : 'medium',
            allowedDomains: cfg.get<string[]>('allowedDomains', []),
            blockedDomains: cfg.get<string[]>('blockedDomains', []),
            country: cfg.get<string>('country', '').trim() || undefined,
            searxngEndpoint: cfg.get<string>('searxngEndpoint', '').trim() || undefined,
            openaiModel: cfg.get<string>('openaiModel', '').trim() || undefined,
            cacheTtlMs: cfg.get<number>('cacheTtlMs', 300_000),
            allowSyntheticProxyAddresses: cfg.get<boolean>('allowSyntheticProxyAddresses', false),
        };
    }

    private isWithinAnyWorkspace(candidate: string): boolean {
        return resolveWorkspacePathInput(candidate, this.ctx.workspaceRoot).isWithinAnyWorkspace;
    }

    private resolveWorkspacePath(inputPath: string): string {
        return resolveWorkspacePathInput(inputPath, this.ctx.workspaceRoot).resolved;
    }

    async todoWrite(args: { todos: TodoItem[] }, context?: import('../types').AgentToolContext): Promise<TodoWriteResult> {
        console.time('todoWrite_exec');
        const agentId = context?.runnerOptions?.agentId;
        const currentTodos = this.todoStore.set(args.todos, agentId);
        const onTodoUpdate = context?.onTodoUpdate;
        if (onTodoUpdate) {
            onTodoUpdate(currentTodos, {
                agentId,
                threadId: context?.runnerOptions?.threadId,
                runId: context?.runnerOptions?.runRecord?.runId ?? context?.runEventSink?.runId,
            });
        }
        console.timeEnd('todoWrite_exec');
        return {
            success: true,
            todoCount: currentTodos.length,
        };
    }

    getTodos(agentId?: string): TodoItem[] { return this.todoStore.get(agentId); }
    restoreTodos(todos: readonly TodoItem[], agentId?: string): void {
        this.todoStore.set(todos, agentId);
    }
    clearTodos(agentId?: string): void { this.todoStore.clear(agentId); }

    // ─── removeIgnoredDiagnostic ──────────────────────────────────────────────

    async removeIgnoredDiagnostic(args: { diagnosticKey: string; reason: string }): Promise<{ success: boolean; message: string; terminalOutcome?: import('../types').ToolTerminalOutcome }> {
        try {
            const config = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
            const ignored = config.get<string[]>('ignoredDiagnostics', []);
            const updated = ignored.filter(k => k !== args.diagnosticKey);
            await config.update('ignoredDiagnostics', updated, vs.ConfigurationTarget.Workspace);
            return { success: true, message: 'Diagnostic key successfully removed from whitelist.' };
        } catch (e) {
            return { success: false, message: `Failed to update settings: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    // ─── getIgnoredDiagnostics ────────────────────────────────────────────────

    async getIgnoredDiagnostics(): Promise<{
        success: boolean;
        ignoredKeys: string[];
        count: number;
        audit?: Array<{
            key: string;
            category: 'exact_id' | 'message_fragment' | 'type_name' | 'broad_pattern' | 'unmatched';
            stillHits: boolean;
            matchCount: number;
        }>;
    }> {
        try {
            const ignored = vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string[]>('ignoredDiagnostics', []);
            const allDiags: Array<{ code: string; message: string; source: string }> = [];
            for (const [, diags] of vs.languages.getDiagnostics()) {
                for (const d of diags) {
                    const code = typeof d.code === 'object' && d.code !== null
                        ? String((d.code as { value?: unknown }).value ?? '')
                        : String(d.code ?? '');
                    allDiags.push({ code, message: d.message, source: String(d.source ?? '') });
                }
            }
            const audit = ignored.map(key => {
                const trimmed = key.trim();
                let category: 'exact_id' | 'message_fragment' | 'type_name' | 'broad_pattern' | 'unmatched' = 'unmatched';
                const lowerKey = trimmed.toLowerCase();
                const broad = /^[a-z0-9_ -]+$/i.test(trimmed)
                    && !trimmed.includes(':')
                    && trimmed.split(/[\s_-]+/).filter(Boolean).length <= 2;
                const exactHits = allDiags.filter(d => d.code.toLowerCase() === lowerKey);
                const fragmentHits = allDiags.filter(d => d.message.toLowerCase().includes(lowerKey) || d.source.toLowerCase().includes(lowerKey));
                const matchCount = exactHits.length + fragmentHits.length;
                category = trimmed.includes(':') && exactHits.length > 0
                    ? 'exact_id'
                    : broad && matchCount === 0
                        ? 'broad_pattern'
                        : broad
                            ? 'broad_pattern'
                            : fragmentHits.length > 0
                                ? 'message_fragment'
                                : matchCount > 0
                                    ? 'type_name'
                                    : 'unmatched';
                return {
                    key: trimmed,
                    category,
                    stillHits: matchCount > 0,
                    matchCount,
                };
            });
            return { success: true, count: ignored.length, ignoredKeys: ignored, audit };
        } catch {
            return { success: false, count: 0, ignoredKeys: [] };
        }
    }

    // ─── Web access ─────────────────────────────────────────────────────────

    async webOpen(args: import('./webAccess').WebOpenArgs, context?: import('../types').AgentToolContext): Promise<Record<string, unknown>> {
        return this.webAccess.open(args, context?.runnerOptions?.abortSignal);
    }

    async webSearch(args: import('./webAccess').WebSearchArgs, context?: import('../types').AgentToolContext): Promise<import('./webAccess').WebSearchResult> {
        return this.webAccess.search(args, context?.runnerOptions?.abortSignal);
    }

    webFind(args: import('./webAccess').WebFindArgs): Record<string, unknown> {
        return this.webAccess.find(args);
    }

    resolveWebReference(ref: string): string {
        return this.webAccess.resolveReference(ref);
    }

    /** Ensure the topic-scoped media output directory exists and return its path. */
    private async getMediaOutputDir(context?: import('../types').AgentToolContext): Promise<string> {
        const topicId = context?.runnerOptions?.topicId ?? 'session';
        const mediaDir = path.join(getPrivateTopicStorageDir(topicId, this.ctx.workspaceRoot), 'media');
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir, { recursive: true });
        }
        return mediaDir;
    }

    /** Pure local command executor for secure format conversion tools (ImageMagick/ffmpeg) */
    private async execLocalCommand(
        command: string,
        timeoutMs: number = 60000,
        context?: import('../types').AgentToolContext
    ): Promise<{ success: boolean; stdout: string; stderr: string; message: string }> {
        const onStep = context?.onStep;
        const abortSignal = context?.runnerOptions?.abortSignal;
        const label = '[Local Convert]';
        onStep?.({
            type: 'thinking',
            content: `${label} Executing: ${command.substring(0, 200)}...`,
            timestamp: Date.now(),
        });

        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            const { stdout, stderr } = await execAsync(command, {
                timeout: timeoutMs,
                cwd: this.ctx.workspaceRoot,
                signal: abortSignal,
                maxBuffer: 10 * 1024 * 1024,
            });

            onStep?.({
                type: 'thinking',
                content: `${label} Completed: ${stdout.trim().substring(0, 300)}`,
                timestamp: Date.now(),
            });

            return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), message: 'OK' };
        } catch (err) {
            const e = err as Error & { stdout?: string; stderr?: string; code?: string };
            const errMsg = e instanceof Error ? e.message : String(err);
            const stdout = typeof e.stdout === 'string' ? e.stdout.trim() : '';
            const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : errMsg;
            const reason = abortSignal?.reason;
            const abortedByTimeout = reason instanceof Error && reason.name === 'TimeoutError';
            const aborted = abortSignal?.aborted || e.name === 'AbortError' || /aborted/i.test(errMsg);
            const message = abortedByTimeout
                ? `Local conversion timed out after ${Math.round(timeoutMs / 1000)}s`
                : aborted
                    ? 'Local conversion was cancelled'
                    : `Execution failed: ${errMsg}`;
            return { success: false, stdout, stderr: stderr || errMsg, message };
        }
    }

    // ─── Media Asset Conversion Tools ────────────────────────────────────

    /** Cached result of ImageMagick availability check (null = not checked yet) */
    private imageMagickAvailable: boolean | null = null;
    /** Cached result of ffmpeg availability check (null = not checked yet) */
    private ffmpegAvailable: boolean | null = null;

    /** Resolve the ImageMagick binary path (custom setting or default 'magick'). */
    private getImageMagickBin(): string {
        return vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string>('imageMagickPath') || 'magick';
    }

    /** Resolve the ffmpeg binary path (custom setting or default 'ffmpeg'). */
    private getFfmpegBin(): string {
        return vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string>('ffmpegPath') || 'ffmpeg';
    }

    /** Check if ImageMagick is installed and accessible. Caches result for the session. */
    private async ensureImageMagickAvailable(): Promise<boolean> {
        if (this.imageMagickAvailable !== null) return this.imageMagickAvailable;
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            await execAsync(`${this.getImageMagickBin()} --version`, { timeout: 10000 });
            this.imageMagickAvailable = true;
        } catch {
            this.imageMagickAvailable = false;
        }
        return this.imageMagickAvailable;
    }

    /** Check if ffmpeg is installed and accessible. Caches result for the session. */
    private async ensureFfmpegAvailable(): Promise<boolean> {
        if (this.ffmpegAvailable !== null) return this.ffmpegAvailable;
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            await execAsync(`${this.getFfmpegBin()} -version`, { timeout: 10000 });
            this.ffmpegAvailable = true;
        } catch {
            this.ffmpegAvailable = false;
        }
        return this.ffmpegAvailable;
    }

    // ─── convert_image_to_dds ───────────────────────────────────────────

    async convertImageToDds(args: {
        sourcePath: string;
        outputDir?: string;
        compression?: 'dxt5' | 'dxt1' | 'dxt3' | 'none';
        generateMipmaps?: boolean;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; outputFile?: string }> {
        if (!(await this.ensureImageMagickAvailable())) {
            return {
                success: false,
                message: `ImageMagick is not installed or not found at "${this.getImageMagickBin()}". Please install ImageMagick (https://imagemagick.org/) and ensure it is in your PATH, or set the custom path in stellarisLanguageServices.ai.imageMagickPath.`,
            };
        }

        const sourcePath = this.resolveWorkspacePath(args.sourcePath);
        if (!this.isWithinAnyWorkspace(sourcePath)) {
            return { success: false, message: `Source file must be within the workspace: ${args.sourcePath}` };
        }

        if (!fs.existsSync(sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Resolve output directory
        const outDir = args.outputDir
            ? this.resolveWorkspacePath(args.outputDir)
            : path.dirname(sourcePath);
        if (!this.isWithinAnyWorkspace(outDir)) {
            return { success: false, message: `Output directory must be within the workspace: ${args.outputDir}` };
        }
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // Build output filename: same basename, .dds extension
        const baseName = path.basename(sourcePath, path.extname(sourcePath));
        const outFile = path.join(outDir, `${baseName}.dds`);

        // Build ImageMagick command
        const magickBin = this.getImageMagickBin();
        const compression = args.compression ?? 'dxt5';
        const mipmaps = args.generateMipmaps === true; // default false

        // ImageMagick DDS defines
        let ddsDefines = '';
        if (compression === 'dxt5') {
            ddsDefines = '-define dds:compression=dxt5';
        } else if (compression === 'dxt1') {
            ddsDefines = '-define dds:compression=dxt1';
        } else if (compression === 'dxt3') {
            ddsDefines = '-define dds:compression=dxt3';
        } else {
            ddsDefines = '-define dds:compression=none';
        }
        if (mipmaps) {
            ddsDefines += ' -define dds:mipmaps=true';
        } else {
            ddsDefines += ' -define dds:mipmaps=0';
        }

        const cmd = `${magickBin} convert "${sourcePath}" ${ddsDefines} "${outFile}"`;

        const result = await this.execLocalCommand(cmd, 60000, context);
        if (!result.success) {
            return { success: false, message: `ImageMagick conversion failed: ${result.stderr || result.message}` };
        }

        if (!fs.existsSync(outFile)) {
            return { success: false, message: `Conversion completed but output file not found: ${outFile}` };
        }

        return {
            success: true,
            message: `Image converted to DDS (${compression}, mipmaps=${mipmaps}): ${outFile}`,
            outputFile: outFile,
        };
    }

    // ─── convert_audio ──────────────────────────────────────────────────

    async convertAudio(args: {
        sourcePath: string;
        outputDir?: string;
        targetFormat: 'ogg' | 'wav';
        sampleRate?: number;
        channels?: number;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; outputFile?: string }> {
        if (!(await this.ensureFfmpegAvailable())) {
            return {
                success: false,
                message: `ffmpeg is not installed or not found at "${this.getFfmpegBin()}". Please install ffmpeg (https://ffmpeg.org/) and ensure it is in your PATH, or set the custom path in stellarisLanguageServices.ai.ffmpegPath.`,
            };
        }

        const sourcePath = this.resolveWorkspacePath(args.sourcePath);
        if (!this.isWithinAnyWorkspace(sourcePath)) {
            return { success: false, message: `Source file must be within the workspace: ${args.sourcePath}` };
        }

        if (!fs.existsSync(sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Resolve output directory
        const outDir = args.outputDir
            ? this.resolveWorkspacePath(args.outputDir)
            : path.dirname(sourcePath);
        if (!this.isWithinAnyWorkspace(outDir)) {
            return { success: false, message: `Output directory must be within the workspace: ${args.outputDir}` };
        }
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const baseName = path.basename(sourcePath, path.extname(sourcePath));
        const outFile = path.join(outDir, `${baseName}.${args.targetFormat}`);
        const ffmpegBin = this.getFfmpegBin();

        // Build ffmpeg command based on target format
        let cmd: string;
        if (args.targetFormat === 'ogg') {
            // Vorbis encoding, quality 4 (~128kbps)
            cmd = `${ffmpegBin} -y -i "${sourcePath}" -c:a libvorbis -q:a 4`;
        } else {
            // WAV: 16-bit PCM, default 44100 Hz
            const sr = args.sampleRate ?? 44100;
            cmd = `${ffmpegBin} -y -i "${sourcePath}" -acodec pcm_s16le -ar ${sr}`;
        }

        // Optional sample rate override for OGG
        if (args.targetFormat === 'ogg' && args.sampleRate) {
            cmd += ` -ar ${args.sampleRate}`;
        }

        // Optional channel override
        if (args.channels) {
            cmd += ` -ac ${args.channels}`;
        }

        cmd += ` "${outFile}"`;

        const result = await this.execLocalCommand(cmd, 60000, context);
        if (!result.success) {
            return { success: false, message: `ffmpeg conversion failed: ${result.stderr || result.message}` };
        }

        if (!fs.existsSync(outFile)) {
            return { success: false, message: `Conversion completed but output file not found: ${outFile}` };
        }

        return {
            success: true,
            message: `Audio converted to ${args.targetFormat.toUpperCase()}: ${outFile}`,
            outputFile: outFile,
        };
    }

    // ─── deploy_mod_asset ───────────────────────────────────────────────

    async deployModAsset(args: {
        sourcePath: string;
        targetRelativePath: string;
        overwrite?: boolean;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; finalPath?: string; writtenFiles?: string[]; terminalOutcome?: import('../types').ToolTerminalOutcome }> {
        const sourcePath = this.resolveWorkspacePath(args.sourcePath);
        if (!this.isWithinAnyWorkspace(sourcePath)) {
            return { success: false, message: `Source file must be within the workspace: ${args.sourcePath}` };
        }
        if (!fs.existsSync(sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Compute absolute target path
        const targetPath = this.resolveWorkspacePath(args.targetRelativePath);
        if (!this.isWithinAnyWorkspace(targetPath)) {
            return { success: false, message: `Target path must be within the workspace: ${args.targetRelativePath}` };
        }
        const targetDir = path.dirname(targetPath);

        // Check overwrite safety
        if (fs.existsSync(targetPath) && !args.overwrite) {
            return {
                success: false,
                message: `Target file already exists: ${targetPath}. Set overwrite=true to replace it.`,
            };
        }

        try {
            // Ensure target directory exists
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // Snapshot for retract system (before writing)
            const previousContent = fs.existsSync(targetPath)
                ? fs.readFileSync(targetPath).toString('base64')
                : null;
            (context?.onBeforeFileWrite ?? context?.runnerOptions?.onBeforeFileWrite)?.(targetPath, previousContent);

            // Copy the file
            fs.copyFileSync(sourcePath, targetPath);

            const onStep = context?.onStep;
            onStep?.({
                type: 'thinking',
                content: `[Deploy] ${path.basename(sourcePath)} → ${args.targetRelativePath}`,
                timestamp: Date.now(),
            });

            return {
                success: true,
                message: `Asset deployed: ${args.targetRelativePath}`,
                finalPath: targetPath,
                writtenFiles: [targetPath],
            };
        } catch (e) {
            return {
                success: false,
                message: `Failed to deploy asset: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }
}
