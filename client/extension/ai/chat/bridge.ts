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
import { SOURCE } from '../messages';

export async function routeWebviewMessage(
    provider: AIChatPanelProvider,
    msg: WebViewMessage,
    sourceSurface: 'chat' | 'manager' = 'chat'
): Promise<void> {
    switch (msg.type) {
        case 'sendMessage':
            await provider.handleUserMessage(msg.text, msg.images, msg.attachedFiles);
            break;
        case 'sendMessageWithReference': {
            const referencePrompt = await provider.contextReferences.buildReferencePrompt(msg.contexts);
            const displayText = msg.text.trim();
            const agentText = [
                referencePrompt,
                msg.text || 'Please use the referenced context above.',
            ].filter(Boolean).join('\n\n');

            await provider.handleUserMessage(agentText, msg.images, undefined, false, false, false, displayText, msg.contexts);
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
            vs.window.showInformationMessage('代码已复制到剪贴板');
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
            await provider.settingsManager.fetchApiModels(msg.providerId, msg.endpoint, msg.apiKey);
            break;
        case 'deleteApiKey':
            await provider.settingsManager.deleteApiKey(msg.providerId, sourceSurface);
            break;
        case 'testConnection':
            await provider.settingsManager.testConnection(msg.settings);
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
            provider.switchMode(msg.mode);
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
        case 'quickChangeWriteMode':
            await provider.settingsManager.quickChangeWriteMode(msg.mode);
            break;
        case 'slashCommand':
            await provider.handleSlashCommand(msg.command);
            break;
        case 'permissionResponse':
            provider.postMessage({ type: 'floatingCardResolved', card: 'permission', id: msg.permissionId });
            provider.resolvePermissionRequest(msg.permissionId, msg.allowed, msg.alwaysAllow);
            break;
        case 'openPlanFile': {
            const planPath = provider.resolveArtifactFilePath(msg.filePath);
            if (planPath) {
                void vs.commands.executeCommand('markdown.showPreview', vs.Uri.file(planPath));
            } else {
                vs.window.showWarningMessage(`无法找到计划文件: ${path.basename(msg.filePath)}`);
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
                contextStr = '\n\n用户批注:\n' + msg.annotations.map((a: { section: string; note: string }) => `- ${a.section}: ${a.note}`).join('\n');
            }

            if (provider.session.currentMode === 'orchestrator') {
                const prompt = '同意执行。请根据最新生成的计划，使用 `dispatch_agents` 工具将该计划分解并分配给适当的子 Agent 执行。' + contextStr;
                await provider.handleUserMessage(prompt, undefined, undefined, true, true);
            } else {
                provider.switchMode('build');
                const prompt = '同意执行。请根据最新生成的计划进行构建。\n\n⚠️ 重要要求：你必须首先使用 `todo_write` 工具将该计划的所有步骤转化为详细的子任务列表（即 task 线路），在开始任何 `write_file` 或其他构建操作之前完成这一步！' + contextStr;
                await provider.handleUserMessage(prompt, undefined, undefined, true, true);
            }
            break;
        }
        case 'revisePlanWithAnnotations': {
            provider.postMessage({ type: 'floatingCardResolved', card: 'plan' });
            provider.postMessage({ type: 'floatingCardResolved', card: 'blueprint' });
            let reviseContext = '';
            if (msg.annotations && msg.annotations.length > 0) {
                reviseContext = '\n\n需要修改的地方批注如下:\n' + msg.annotations.map((a: { section: string; note: string }) => `- ${a.section}: ${a.note}`).join('\n');
            }
            const revisePrompt = '请根据我的批注考虑改进现有的执行计划，重新完善计划。' + reviseContext;
            await provider.handleUserMessage(revisePrompt, undefined, undefined, true, true);
            break;
        }
        case 'reviseWalkthroughWithAnnotations': {
            provider.postMessage({ type: 'floatingCardResolved', card: 'walkthrough' });
            let reviseWtContext = '';
            if (msg.annotations && msg.annotations.length > 0) {
                reviseWtContext = '\n\n针对报告中需要修改的地方，我的批注（要求）如下:\n' + msg.annotations.map((a: { section: string; note: string }) => `### 针对片段：\n${a.section}\n**要求**：${a.note}`).join('\n\n');
            }
            const reviseWtPrompt = '请根据我的批注，重新修改并输出一份新的 walkthrough.md 报告。' + reviseWtContext;
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
        case 'promptClearUsageStats':
            vs.window.showWarningMessage('确定要清空所有 Token 消耗统计吗？此操作不可逆转。', '确定清空', '取消').then(sel => {
                if (sel === '确定清空') {
                    provider.usageTracker.clearStats();
                    provider.postMessage({ type: 'usageStats', stats: provider.usageTracker.getStats() });
                    vs.window.showInformationMessage('Token 消耗统计已清空');
                }
            });
            break;
        case 'clearUsageStats':
            provider.usageTracker.clearStats();
            provider.postMessage({ type: 'usageStats', stats: provider.usageTracker.getStats() });
            break;
        case 'requestCompactedMemory': {
            const activeTopicId = provider.topicManager.currentTopic?.id || 'default';
            // wsRoot is resolved from getProjectWorkspaceRoot
            const { getProjectWorkspaceRoot, getTopicStorageDir } = await import('../workspacePaths');
            const root = getProjectWorkspaceRoot();
            const topicStorage = getTopicStorageDir(activeTopicId, root);
            
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
                content: markdownContent || '✨ 暂无结构化压缩记忆数据。请先执行任何 AI 任务，系统将自动提炼并激活您的 Compacted Memory 看板！'
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
