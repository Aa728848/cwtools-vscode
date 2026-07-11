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
import { generateProjectKnowledge, getProjectKnowledgeManifestPath } from './projectKnowledge';
import { getKnownProfileByLanguageId } from '../gameProfiles';
import {
    buildProjectProfile,
    extractCustomRules,
    getProjectProfilePath,
    renderProjectRulesMarkdown,
    writeProjectProfile,
} from './projectProfile';

type PostMessageFn = (msg: HostMessage) => void;
type RecordSnapshotFn = (filePath: string) => void;

export interface InitGenerationResult {
    success: boolean;
    rulesPath?: string;
    profilePath?: string;
    knowledgeManifestPath?: string;
    message?: string;
}

async function generateDeepKnowledgeWithRetry(root: string, profile: import('./types').ProjectProfile) {
    const delays = [0, 1200, 3000, 6000];
    let lastError: unknown;
    for (const delay of delays) {
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        try {
            return await generateProjectKnowledge(root, profile, { mode: 'full' });
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Knowledge export failed'));
}

/**
 * Generate project rules and the machine-readable Agent project profile.
 */
export async function generateInitFile(
    postMessage: PostMessageFn,
    recordFileSnapshot: RecordSnapshotFn
): Promise<InitGenerationResult> {
    const folders = vs.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vs.window.showWarningMessage(UI.NO_WORKSPACE_INIT);
        return { success: false, message: UI.NO_WORKSPACE_INIT };
    }

    const root = folders[0]!.uri.fsPath;
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

        const manifest = await generateDeepKnowledgeWithRetry(root, profile);
        profile.game.id = manifest.game || profile.game.id;
        profile.game.displayName = getKnownProfileByLanguageId(manifest.game)?.displayName ?? profile.game.displayName;
        profile.game.confidence = manifest.game && manifest.game !== 'paradox' ? 'high' : profile.game.confidence;
        profile.game.evidence = Array.from(new Set([...profile.game.evidence, 'active CWTools LSP game model']));
        profile.validation.lspReady = manifest.status === 'ready' ? 'ready' : 'not_ready';
        profile.validation.vanillaCache = manifest.counts.vanillaDefinitions > 0 ? 'configured' : 'missing';
        writeProjectProfile(root, profile);

        recordFileSnapshot(rulesPath);
        fs.writeFileSync(rulesPath, renderProjectRulesMarkdown(profile, customRules), 'utf8');

        const doc = await vs.workspace.openTextDocument(vs.Uri.file(rulesPath));
        await vs.window.showTextDocument(doc, { preview: false });

        postMessage({
            type: 'agentStep',
            step: {
                type: 'validation',
                content: aiText(
                    `Generated CWTOOLS.md, Agent profile, and semantic knowledge pack -> ${getProjectKnowledgeManifestPath(root)}`,
                    `已生成 CWTOOLS.md、Agent 项目画像和语义知识包 -> ${getProjectKnowledgeManifestPath(root)}`,
                ),
                timestamp: Date.now(),
            },
        });

        vs.window.showInformationMessage(aiText(
            `Eddy CWTool Code: generated project + vanilla knowledge for ${path.basename(root)}`,
            `Eddy CWTool Code：已为 ${path.basename(root)} 生成项目与原版知识包`,
        ));
        return { success: true, rulesPath, profilePath, knowledgeManifestPath: getProjectKnowledgeManifestPath(root) };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        postMessage({
            type: 'agentStep',
            step: { type: 'error', content: `/init failed: ${message}`, timestamp: Date.now() },
        });
        return { success: false, message };
    }
}
