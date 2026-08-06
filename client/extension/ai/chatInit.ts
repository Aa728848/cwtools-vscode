/**
 * Eddy CWTool Code - /init command.
 *
 * Builds a compact human rules file plus a machine-readable project profile.
 * The profile is used by PromptBuilder and query_project_profile to reduce
 * repeated workspace exploration during future agent runs.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { HostMessage } from './types';
import { UI, aiText } from './messages';
import {
    generateProjectKnowledge,
    getProjectKnowledgeManifestPath,
    writeUnavailableProjectKnowledge,
} from './projectKnowledge';
import { getKnownProfileByLanguageId } from '../gameProfiles';
import { ErrorReporter } from './errorReporter';
import type { IndexService } from '../indexing/indexService';
import { getWorkspaceSymbolCachePath } from '../indexing/workspaceSymbolCache';
import {
    buildProjectProfile,
    extractCustomRules,
    getProjectProfilePath,
    renderProjectRulesMarkdown,
    writeProjectProfile,
} from './projectProfile';

type PostMessageFn = (msg: HostMessage) => void;
type RecordSnapshotFn = (filePath: string) => void;
type InitProgress = vs.Progress<{ message?: string; increment?: number }>;

export interface InitGenerationResult {
    success: boolean;
    degraded?: boolean;
    rulesPath?: string;
    profilePath?: string;
    knowledgeManifestPath?: string;
    workspaceIndexPath?: string;
    message?: string;
}

function isDeepKnowledgeReady(status: unknown): boolean {
    if (!status || typeof status !== 'object') return false;
    const record = status as Record<string, unknown>;
    const loading = record.loading && typeof record.loading === 'object'
        ? record.loading as Record<string, unknown>
        : undefined;
    const pending = Array.isArray(record.pendingGlobalKinds) ? record.pendingGlobalKinds : [];
    return record.ok === true
        && record.inProgress !== true
        && record.validationInProgress !== true
        && record.loadingInProgress !== true
        && loading?.inProgress !== true
        && pending.length === 0;
}

async function waitForDeepKnowledgeReadiness(progress?: InitProgress): Promise<void> {
    if (typeof vs.commands?.executeCommand !== 'function') return;
    const startedAt = Date.now();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        progress?.report({
            message: aiText(
                `Waiting for the CWTools game model... ${Math.floor((Date.now() - startedAt) / 1000)}s`,
                `正在等待 CWTools 游戏模型... ${Math.floor((Date.now() - startedAt) / 1000)} 秒`,
            ),
        });
        try {
            const status = await vs.commands.executeCommand('cwtools.ai.getValidationStatus');
            if (isDeepKnowledgeReady(status)) return;
        } catch {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function generateDeepKnowledgeWithRetry(root: string, profile: import('./types').ProjectProfile, progress?: InitProgress) {
    await waitForDeepKnowledgeReadiness(progress);
    const delays = [0, 2000, 5000];
    let lastError: unknown;
    let lastManifest: Awaited<ReturnType<typeof generateProjectKnowledge>> | undefined;
    for (let attempt = 0; attempt < delays.length; attempt++) {
        const delay = delays[attempt]!;
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        progress?.report({
            message: aiText(
                `Exporting project + vanilla knowledge (${attempt + 1}/${delays.length})...`,
                `正在导出项目与原版知识（${attempt + 1}/${delays.length}）...`,
            ),
        });
        try {
            const manifest = await generateProjectKnowledge(root, profile, {
                mode: 'full',
                complete: true,
                requireReady: true,
            });
            lastManifest = manifest;
            // A partial snapshot is deterministic for a fixed model and export
            // mode. Retrying it repeats the same full scan without any
            // chance of improving coverage. Only transient loading/stale states
            // should proceed to the next attempt.
            if (manifest.status === 'ready' || manifest.status === 'partial') return manifest;
        } catch (error) {
            lastError = error;
        }
    }
    if (lastManifest) return lastManifest;
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Knowledge export failed'));
}

/**
 * Generate project rules and the machine-readable Agent project profile.
 */
async function generateInitFileCore(
    postMessage: PostMessageFn,
    recordFileSnapshot: RecordSnapshotFn,
    progress: InitProgress,
    indexService?: IndexService,
): Promise<InitGenerationResult> {
    const folders = vs.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vs.window.showWarningMessage(UI.NO_WORKSPACE_INIT);
        return { success: false, message: UI.NO_WORKSPACE_INIT };
    }

    const root = folders[0]!.uri.fsPath;
    progress.report({
        message: aiText(
            'Scanning workspace and generating the project profile...',
            '正在扫描工作区并生成项目画像...',
        ),
    });
    postMessage({
        type: 'agentStep',
        step: {
            type: 'thinking',
            content: aiText(
                'Scanning workspace and building the Agent project profile...',
                '正在扫描工作区并构建 Agent 项目画像...',
            ),
            timestamp: Date.now(),
        },
    });

    try {
        const rulesPath = path.join(root, 'CWTOOLS.md');
        const profilePath = getProjectProfilePath(root);
        const existingRules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
        const customRules = extractCustomRules(existingRules);

        const profile = buildProjectProfile(root);

        recordFileSnapshot(profilePath);
        writeProjectProfile(root, profile);
        recordFileSnapshot(rulesPath);
        fs.writeFileSync(rulesPath, renderProjectRulesMarkdown(profile, customRules), 'utf8');

        const workspaceIndexPath = getWorkspaceSymbolCachePath(root);
        if (indexService) {
            progress.report({
                message: aiText(
                    'Building the persistent workspace symbol index...',
                    '正在构建持久化工作区符号索引...',
                ),
            });
            postMessage({
                type: 'agentStep',
                step: {
                    type: 'thinking',
                    content: aiText(
                        `Building the incremental workspace symbol database -> ${workspaceIndexPath}`,
                        `正在构建增量工作区符号数据库 -> ${workspaceIndexPath}`,
                    ),
                    timestamp: Date.now(),
                },
            });
            await indexService.ensureWorkspaceSymbolsReady({ includeVanilla: false });
            // Fill a bounded per-kind identifier summary from the shared index so
            // profile routing no longer depends on an empty byType.
            const typeSummary = indexService.workspaceSymbolTypeSummary();
            profile.identifiers.byType = typeSummary.byType;
            profile.identifiers.byTypeCounts = typeSummary.byTypeCounts;
            if (Object.keys(typeSummary.byType).length === 0 && profile.identifiers.namespaces.length === 0) {
                ErrorReporter.debug('ChatInit', 'Workspace symbol index built without typed entries; profile byType stays empty.');
            }
        }

        progress.report({
            message: aiText(
                'Waiting for the CWTools model before deep export...',
                '正在等待 CWTools 模型并准备深层导出...',
            ),
        });
        postMessage({
            type: 'agentStep',
            step: {
                type: 'thinking',
                content: aiText(
                    'Waiting for the CWTools game model and exporting project + vanilla semantic knowledge...',
                    '正在等待 CWTools 游戏模型，并导出当前项目与原版游戏的语义知识...',
                ),
                timestamp: Date.now(),
            },
        });

        let deepKnowledgeError: string | undefined;
        let deepKnowledgeWarning: string | undefined;
        try {
            const manifest = await generateDeepKnowledgeWithRetry(root, profile, progress);
            profile.game.id = manifest.game || profile.game.id;
            profile.game.displayName = getKnownProfileByLanguageId(manifest.game)?.displayName ?? profile.game.displayName;
            profile.game.confidence = manifest.game && manifest.game !== 'paradox' ? 'high' : profile.game.confidence;
            profile.game.evidence = Array.from(new Set([...profile.game.evidence, 'active CWTools LSP game model']));
            profile.validation.lspReady = manifest.status === 'ready' || manifest.status === 'partial' ? 'ready' : 'not_ready';
            profile.validation.vanillaCache = manifest.counts.vanillaDefinitions > 0 ? 'configured' : 'missing';
            profile.freshness = {
                knowledgeStatus: manifest.status === 'ready'
                    ? 'ready'
                    : manifest.status === 'partial'
                        ? 'partial'
                        : 'stale',
                knowledgeGeneratedAt: manifest.generatedAt,
                staleReasons: manifest.staleReasons ?? [],
            };
            if (manifest.status === 'partial') {
                deepKnowledgeWarning = 'Deep project knowledge was exported with partial coverage.';
            } else if (manifest.status !== 'ready') {
                deepKnowledgeError = `Deep project knowledge export remained ${manifest.status} after retries.`;
            }
        } catch (error) {
            deepKnowledgeError = error instanceof Error ? error.message : String(error);
            ErrorReporter.warn('ChatInit', 'Deep project knowledge export was unavailable; wrote a recoverable knowledge pack.', error);
            profile.validation.lspReady = 'not_ready';
            profile.freshness = { knowledgeStatus: 'unavailable', staleReasons: ['lsp_export_unavailable'] };
            writeUnavailableProjectKnowledge(root, profile, deepKnowledgeError);
        }
        progress.report({
            message: aiText(
                'Publishing the knowledge database and project rules...',
                '正在发布知识数据库和项目规则...',
            ),
        });
        writeProjectProfile(root, profile);

        fs.writeFileSync(rulesPath, renderProjectRulesMarkdown(profile, customRules), 'utf8');

        const doc = await vs.workspace.openTextDocument(vs.Uri.file(rulesPath));
        await vs.window.showTextDocument(doc, { preview: false });

        postMessage({
            type: 'agentStep',
            step: {
                type: 'validation',
                content: deepKnowledgeError
                    ? aiText(
                        `Generated CWTOOLS.md, Agent profile, and a recoverable knowledge pack. Deep LSP export is pending: ${deepKnowledgeError}`,
                        `已生成 CWTOOLS.md、Agent 项目画像和可恢复知识包。LSP 深层导出仍待完成：${deepKnowledgeError}`,
                    )
                    : deepKnowledgeWarning
                    ? aiText(
                        `Generated CWTOOLS.md, Agent profile, workspace symbol index, and a partial semantic knowledge pack -> ${getProjectKnowledgeManifestPath(root)}`,
                        `已生成 CWTOOLS.md、Agent 项目画像、工作区符号索引和部分覆盖的语义知识包 -> ${getProjectKnowledgeManifestPath(root)}`,
                    )
                    : aiText(
                        `Generated CWTOOLS.md, Agent profile, workspace symbol index, and semantic knowledge pack -> ${getProjectKnowledgeManifestPath(root)}`,
                        `已生成 CWTOOLS.md、Agent 项目画像、工作区符号索引和语义知识包 -> ${getProjectKnowledgeManifestPath(root)}`,
                    ),
                timestamp: Date.now(),
            },
        });

        if (deepKnowledgeError) {
            vs.window.showWarningMessage(aiText(
                `Eddy CWTool Code: base /init artifacts were generated for ${path.basename(root)}; deep LSP knowledge will retry when ready.`,
                `Eddy CWTool Code：已为 ${path.basename(root)} 生成 /init 基础产物；LSP 就绪后将重试深层知识导出。`,
            ));
        } else if (deepKnowledgeWarning) {
            vs.window.showWarningMessage(aiText(
                `Eddy CWTool Code: generated a partial project + vanilla knowledge pack for ${path.basename(root)}; see manifest warnings for coverage details.`,
                `Eddy CWTool Code：已为 ${path.basename(root)} 生成部分覆盖的项目与原版知识包；覆盖详情请查看 manifest 警告。`,
            ));
        } else {
            vs.window.showInformationMessage(aiText(
                `Eddy CWTool Code: generated project + vanilla knowledge for ${path.basename(root)}`,
                `Eddy CWTool Code：已为 ${path.basename(root)} 生成项目与原版知识包`,
            ));
        }
        return {
            success: true,
            degraded: !!deepKnowledgeError || !!deepKnowledgeWarning,
            rulesPath,
            profilePath,
            knowledgeManifestPath: getProjectKnowledgeManifestPath(root),
            workspaceIndexPath: indexService ? workspaceIndexPath : undefined,
            message: deepKnowledgeError ?? deepKnowledgeWarning,
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        postMessage({
            type: 'agentStep',
            step: { type: 'error', content: `/init failed: ${message}`, timestamp: Date.now() },
        });
        return { success: false, message };
    }
}

/**
 * Generate project rules and the machine-readable Agent project profile.
 * ProgressLocation.Window renders the long-running /init phase in VS Code's
 * lower-left status area until the knowledge database has been published.
 */
export async function generateInitFile(
    postMessage: PostMessageFn,
    recordFileSnapshot: RecordSnapshotFn,
    indexService?: IndexService,
): Promise<InitGenerationResult> {
    const run = (progress: InitProgress) => generateInitFileCore(postMessage, recordFileSnapshot, progress, indexService);
    if (typeof vs.window.withProgress === 'function' && vs.ProgressLocation?.Window !== undefined) {
        return vs.window.withProgress(
            {
                location: vs.ProgressLocation.Window,
                title: aiText(
                    'Eddy CWTool Code: Building project knowledge',
                    'Eddy CWTool Code：正在构建项目知识',
                ),
                cancellable: false,
            },
            run,
        );
    }
    return run({ report: () => undefined });
}
