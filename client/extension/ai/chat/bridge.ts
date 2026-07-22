/**
 * CWTools AI Module — WebView Communication Bridge
 * 
 * Handles routing of incoming UI requests from the frontend sandbox Webview
 * into appropriate AIChatPanelProvider host-side operations.
 */

import * as vs from 'vscode';
import * as path from 'path';
import type { WebViewMessage } from '../types';
import type { AIChatPanelProvider } from '../chatPanel';
import { ErrorReporter } from '../errorReporter';
import { SOURCE, aiText } from '../messages';
import { isAgentMode, isAgentProfileSelection, profileForUserDomain } from '../agentProfile';

export async function routeWebviewMessage(
    provider: AIChatPanelProvider,
    msg: WebViewMessage,
    sourceSurface: 'chat' | 'manager' = 'chat'
): Promise<void> {
    switch (msg.type) {
        case 'sendMessage':
            await provider.handleComposerSubmission(msg.text, {
                images: msg.images,
                attachedFiles: msg.attachedFiles,
                agentProfile: isAgentProfileSelection(msg.agentProfile) ? msg.agentProfile : undefined,
            });
            break;
        case 'steerGeneration':
            await provider.handleComposerSubmission(msg.text, { images: msg.images });
            break;
        case 'sendMessageWithReference': {
            await provider.handleComposerSubmission(msg.text, {
                images: msg.images,
                contexts: msg.contexts,
                agentProfile: isAgentProfileSelection(msg.agentProfile) ? msg.agentProfile : undefined,
            });
            break;
        }
        case 'editAndResendMessage':
            await provider.editAndResendMessage(msg.messageIndex, msg.text, msg.images, msg.contexts);
            break;
        case 'openContextReference':
            await provider.contextReferences.openReference(msg.context);
            break;
        case 'insertCode':
            await provider.insertCodeWithDiff(msg.code);
            break;
        case 'copyCode':
            await vs.env.clipboard.writeText(msg.code);
            vs.window.showInformationMessage(aiText('Code copied to clipboard.', '代码已复制到剪贴板'));
            break;
        case 'resumeGeneration':
        case 'regenerate':
            await provider.regenerateLastResponse();
            break;
        case 'newTopic':
            provider.startNewTopic();
            break;
        case 'loadTopic':
            void provider.loadTopic(msg.topicId);
            break;
        case 'deleteTopic':
            provider.deleteTopic(msg.topicId);
            break;
        case 'renameTopic':
            provider.topicManager.renameTopic(msg.topicId, msg.title);
            break;
        case 'forkTopic':
            provider.forkTopic(msg.topicId, msg.messageIndex);
            break;
        case 'archiveTopic':
            provider.archiveTopic(msg.topicId);
            break;
        case 'pinTopic':
            provider.topicManager.setPinned(msg.topicId, msg.pinned);
            provider.sendManagerSnapshot();
            break;
        case 'setTopicWorkspace':
            provider.topicManager.setWorkspace(msg.topicId, msg.workspaceId, msg.workspaceLabel);
            provider.sendManagerSnapshot();
            break;
        case 'setShowArchived':
            provider.topicManager.setShowArchived(msg.show);
            break;
        case 'configureProvider':
        case 'openSettings':
            await provider.settingsManager.openSettingsPage(sourceSurface);
            await provider.settingsManager.getSkillsList();
            break;
        case 'saveSettings':
            await provider.settingsManager.saveSettings(msg.settings, sourceSurface);
            break;
        case 'detectOllamaModels':
            await provider.settingsManager.detectOllamaModels(msg.endpoint);
            break;
        case 'fetchApiModels':
            await provider.settingsManager.fetchApiModels(msg.providerId, msg.endpoint, msg.apiKey, msg.customApiFormat);
            break;
        case 'deleteApiKey':
            await provider.settingsManager.deleteApiKey(msg.providerId, sourceSurface);
            break;
        case 'testConnection':
            await provider.settingsManager.testConnection(msg.settings);
            break;
        case 'codexLogin':
            await provider.settingsManager.loginCodex();
            break;
        case 'codexRefreshAccount':
            await provider.settingsManager.refreshCodexAccount();
            break;
        case 'codexLogout':
            await provider.settingsManager.logoutCodex();
            break;
        case 'deleteDynamicModel':
            await provider.settingsManager.deleteDynamicModel(msg.providerId, msg.modelId);
            break;
        case 'installSkill':
            await provider.settingsManager.installSkill(msg.source);
            break;
        case 'deleteSkill':
            await provider.settingsManager.deleteSkill(msg.skill);
            break;
        case 'cancelGeneration':
            provider.cancelGeneration();
            break;
        case 'switchMode':
            if (isAgentMode(msg.mode)) provider.switchMode(msg.mode);
            else ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Rejected invalid Agent mode from Webview.');
            break;
        case 'switchAgentProfile':
            if (isAgentProfileSelection(msg.profile)) provider.switchAgentProfile(profileForUserDomain(msg.profile.domain));
            else ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Rejected invalid Agent profile from Webview.');
            break;
        case 'switchWorkflow':
            provider.switchWorkflow(msg.workflowId);
            break;
        case 'openAgentManager':
            await provider.openAgentManager();
            break;
        case 'retractMessage':
            await provider.retractMessage(msg.messageIndex);
            break;
        case 'confirmWriteFile':
            provider.postMessage({ type: 'floatingCardResolved', card: 'write', id: msg.messageId });
            void provider.resolveWriteConfirmation(msg.messageId, true);
            break;
        case 'cancelWriteFile':
            provider.postMessage({ type: 'floatingCardResolved', card: 'write', id: msg.messageId });
            void provider.resolveWriteConfirmation(msg.messageId, false);
            break;
        case 'approveTransaction':
            provider.postMessage({ type: 'floatingCardResolved', card: 'transaction', id: msg.txId });
            void provider.agentRunner.commitTransaction(msg.txId);
            break;
        case 'rejectTransaction':
            provider.postMessage({ type: 'floatingCardResolved', card: 'transaction', id: msg.txId });
            provider.agentRunner.discardTransaction(msg.txId);
            break;
        case 'quickChangeModel':
            await provider.settingsManager.quickChangeModel(msg.model);
            break;
        case 'quickChangeReasoningEffort':
            await provider.settingsManager.quickChangeReasoningEffort(msg.effort);
            break;
        case 'quickChangeWriteMode':
            await provider.settingsManager.quickChangeWriteMode(msg.mode);
            break;
        case 'slashCommand':
            await provider.handleComposerSubmission(msg.command);
            break;
        case 'permissionResponse':
            provider.postMessage({ type: 'floatingCardResolved', card: 'permission', id: msg.permissionId });
            provider.resolvePermissionRequest(
                msg.permissionId,
                msg.decision ?? (msg.alwaysAllow && msg.allowed === true ? 'acceptForSession' : msg.allowed === true ? 'accept' : 'decline'),
            );
            break;
        case 'openPlanFile': {
            const planPath = provider.resolveArtifactFilePath(msg.filePath);
            if (planPath) {
                void vs.commands.executeCommand('markdown.showPreview', vs.Uri.file(planPath));
            } else {
                vs.window.showWarningMessage(aiText(
                    `Could not find plan file: ${path.basename(msg.filePath)}`,
                    `无法找到计划文件: ${path.basename(msg.filePath)}`,
                ));
            }
            break;
        }
        case 'openArtifact':
            await provider.openArtifact(msg.artifactId, msg.file);
            break;
        case 'openRunResult':
            await provider.openRunResult(msg.filePath);
            break;
        case 'cleanupRunArtifacts':
            await provider.cleanupRunArtifacts(msg.maxAgeDays, msg.maxFiles);
            break;
        case 'submitPlanAnnotations': {
            provider.markLatestInteractiveCardApproved(['plan_card', 'blueprint_card']);
            provider.postMessage({ type: 'floatingCardResolved', card: 'plan' });
            provider.postMessage({ type: 'floatingCardResolved', card: 'blueprint' });
            let contextStr = '';
            if (msg.annotations && msg.annotations.length > 0) {
                contextStr = `\n\n${aiText('User annotations:', '用户批注:')}\n` + msg.annotations.map((a: { section: string; note: string }) => `- ${a.section}: ${a.note}`).join('\n');
            }

            const executionMode = provider.getApprovedPlanExecutionMode();
            provider.switchWorkflow(null);
            provider.switchMode(executionMode, false, false);
            provider.beginApprovedPlanExecution();
            const approvedArtifacts = provider.getApprovedPlanArtifactContext();
            const prompt = aiText(
                'Approved. The approved Implementation Plan is design-complete and is the final design authority. Enter Write/Execute now: do not re-enter discovery/design, regenerate a blueprint, reinterpret the architecture, or request approval again. If an Approved blueprintFile is listed below, call `dispatch_agents` with that exact `blueprintFile`; its featureManifest and taskPlan are canonical. Otherwise read the Approved Implementation Plan and mechanically dispatch its exact task DAG, files, contracts, dependencies, and acceptance criteria without adding design decisions. After implementation and verification finish, write a self-contained `walkthrough.md` into the Agent Workspace Dir describing changed files, validation, outcomes, and remaining limitations. This completes the approved Plan → Execute → Walkthrough lifecycle and lets the host render the report card.',
                '同意执行。已批准的 Implementation Plan 已完成全部设计，并且是最终设计依据。现在直接进入写入/执行：不得重新进入发现或设计阶段，不得重新生成蓝图、重新解释架构或再次请求批准。如果下方列出了 Approved blueprintFile，请使用该精确路径调用 `dispatch_agents`；其中的 featureManifest 和 taskPlan 是唯一执行契约。否则读取 Approved Implementation Plan，严格按其中的任务 DAG、文件、契约、依赖和验收条件机械地形成调度参数，不得增加新的设计决策。实现和验证完成后，必须在 Agent Workspace Dir 中写入自包含的 `walkthrough.md`，说明修改文件、验证、结果和剩余限制，以完成已批准的“计划 → 执行 → 汇报”闭环，并由宿主渲染汇报卡。',
            ) + (approvedArtifacts ? `\n\n${approvedArtifacts}` : '') + contextStr;
            await provider.handleUserMessage(prompt, undefined, undefined, true, true);
            break;
        }
        case 'revisePlanWithAnnotations': {
            provider.postMessage({ type: 'floatingCardResolved', card: 'plan' });
            provider.postMessage({ type: 'floatingCardResolved', card: 'blueprint' });
            let reviseContext = '';
            if (msg.annotations && msg.annotations.length > 0) {
                reviseContext = `\n\n${aiText('Annotations for the parts that need revision:', '需要修改的地方批注如下:')}\n` + msg.annotations.map((a: { section: string; note: string }) => `- ${a.section}: ${a.note}`).join('\n');
            }
            const revisePrompt = aiText(
                'Please revise the existing execution plan based on my annotations. If the task has a design blueprint, call write_design_blueprint again so both design_blueprint.md and the executable design_blueprint.json contract are updated before requesting approval again.',
                '请根据我的批注修改现有执行计划。如果任务包含设计蓝图，必须再次调用 write_design_blueprint，同时更新 design_blueprint.md 和可执行的 design_blueprint.json 契约，然后再请求批准。',
            ) + reviseContext;
            await provider.handleUserMessage(revisePrompt, undefined, undefined, true, true);
            break;
        }
        case 'reviseWalkthroughWithAnnotations': {
            provider.postMessage({ type: 'floatingCardResolved', card: 'walkthrough' });
            let reviseWtContext = '';
            if (msg.annotations && msg.annotations.length > 0) {
                reviseWtContext = `\n\n${aiText('My annotations/requirements for the report sections that need revision:', '针对报告中需要修改的地方，我的批注（要求）如下:')}\n` + msg.annotations.map((a: { section: string; note: string }) => aiText(
                    `### Section\n${a.section}\n**Requirement**: ${a.note}`,
                    `### 针对片段：\n${a.section}\n**要求**：${a.note}`,
                )).join('\n\n');
            }
            const reviseWtPrompt = aiText(
                'Please revise the walkthrough based on my annotations and output a new walkthrough.md report.',
                '请根据我的批注，重新修改并输出一份新的 walkthrough.md 报告。',
            ) + reviseWtContext;
            await provider.handleUserMessage(reviseWtPrompt, undefined, undefined, true, true);
            break;
        }
        case 'approveWalkthrough':
            provider.markLatestInteractiveCardApproved(['walkthrough_card']);
            provider.postMessage({ type: 'floatingCardResolved', card: 'walkthrough' });
            if (provider.session.previousMode && provider.session.previousMode !== provider.session.currentMode) {
                provider.switchMode(provider.session.previousMode);
            }
            break;
        case 'searchTopics':
            provider.topicManager.handleSearchTopics(msg.query);
            break;
        case 'exportTopic':
            await provider.topicManager.exportTopicAsMarkdown(msg.topicId);
            break;
        case 'exportTopicJson':
            await provider.topicManager.exportTopicAsJson(msg.topicId);
            break;
        case 'importTopic':
            {
                const msgs = await provider.topicManager.importTopicFromJson(msg.data);
                if (msgs) provider.conversationMessages = msgs;
            }
            break;
        case 'requestFileList':
            provider.sendWorkspaceFileList();
            break;
        case 'requestManagerSnapshot':
            provider.sendManagerSnapshot();
            break;
        case 'ready':
            provider.restoreViewState(sourceSurface, true);
            provider.sendManagerSnapshot();
            break;
        case 'requestMentionSearch': {
            try {
                provider.postMessage({ type: 'mentionSearchResults', results: await provider.contextReferences.search(msg.query) });
            } catch (e) {
                ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Mention search failed', e);
                provider.postMessage({ type: 'mentionSearchResults', results: [] });
            }
            break;
        }
        case 'requestUsageStats':
            provider.postMessage({ type: 'usageStats', stats: provider.usageTracker.getStats() });
            break;
        case 'promptClearUsageStats': {
            const confirmClear = aiText('Clear stats', '确定清空');
            const cancelClear = aiText('Cancel', '取消');
            vs.window.showWarningMessage(
                aiText('Clear all token usage statistics? This cannot be undone.', '确定要清空所有 Token 消耗统计吗？此操作不可逆转。'),
                confirmClear,
                cancelClear,
            ).then(sel => {
                if (sel === confirmClear) {
                    provider.usageTracker.clearStats();
                    provider.postMessage({ type: 'usageStats', stats: provider.usageTracker.getStats() });
                    vs.window.showInformationMessage(aiText('Token usage statistics cleared.', 'Token 消耗统计已清空'));
                }
            });
            break;
        }
        case 'clearUsageStats':
            provider.usageTracker.clearStats();
            provider.postMessage({ type: 'usageStats', stats: provider.usageTracker.getStats() });
            break;
        case 'requestCompactedMemory': {
            const activeTopicId = provider.topicManager.currentTopic?.id || 'default';
            // wsRoot is resolved from getProjectWorkspaceRoot
            const { getProjectWorkspaceRoot, getPrivateTopicStorageDir } = await import('../workspacePaths');
            const root = getProjectWorkspaceRoot();
            const topicStorage = getPrivateTopicStorageDir(activeTopicId, root);
            
            let markdownContent = '';
            if (topicStorage) {
                const fs = await import('fs');
                const pathModule = await import('path');
                const runsDir = pathModule.join(topicStorage, 'runs');
                if (fs.existsSync(runsDir)) {
                    try {
                        const runs = fs.readdirSync(runsDir)
                            .map(name => ({ name, time: fs.statSync(pathModule.join(runsDir, name)).mtimeMs }))
                            .sort((a, b) => b.time - a.time);
                        if (runs.length > 0) {
                            const latestRunId = runs[0]!.name;
                            const summaryMdPath = pathModule.join(runsDir, latestRunId, 'summary.md');
                            if (fs.existsSync(summaryMdPath)) {
                                markdownContent = fs.readFileSync(summaryMdPath, 'utf8');
                            }
                        }
                    } catch {
                        // ignore fs read error
                    }
                }
            }

            provider.postMessage({
                type: 'compactedMemoryResult',
                content: markdownContent || aiText(
                    'No structured compacted memory data yet. Run any AI task first; the system will extract and activate the Compacted Memory dashboard automatically.',
                    '✨ 暂无结构化压缩记忆数据。请先执行任何 AI 任务，系统将自动提炼并激活您的 Compacted Memory 看板！',
                ),
            });
            break;
        }
        case 'requestScratchFiles': {
            try {
                const { getProjectWorkspaceRoot, getTopicStorageDir } = await import('../workspacePaths');
                const fsModule = await import('fs');
                const pathModule = await import('path');
                const root = getProjectWorkspaceRoot();
                const topicId = provider.topicManager.currentTopic?.id || 'default';
                const topicDir = getTopicStorageDir(topicId, root);
                const scratchDir = topicDir ? pathModule.join(topicDir, 'scratch') : null;
                const files: Array<{ name: string; relPath: string; size: number }> = [];
                if (scratchDir && fsModule.existsSync(scratchDir)) {
                    const entries = fsModule.readdirSync(scratchDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (!entry.isFile()) continue;
                        const fullPath = pathModule.join(scratchDir, entry.name);
                        try {
                            const stat = fsModule.statSync(fullPath);
                            files.push({ name: entry.name, relPath: fullPath, size: stat.size });
                        } catch { /* ignore */ }
                    }
                }
                provider.postMessage({ type: 'scratchFiles', files } as any);
            } catch (e) {
                ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to list scratch files', e);
                provider.postMessage({ type: 'scratchFiles', files: [] } as any);
            }
            break;
        }
        case 'openScratchFile': {
            const filePath = (msg as any).file;
            if (filePath && typeof filePath === 'string') {
                try {
                    const doc = await vs.workspace.openTextDocument(vs.Uri.file(filePath));
                    await vs.window.showTextDocument(doc, { preview: true });
                } catch (e) {
                    ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to open scratch file', e);
                }
            }
            break;
        }
    }
}
