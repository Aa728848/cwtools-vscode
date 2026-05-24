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
import { UI } from './messages';
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
    message?: string;
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
            content: 'Scanning workspace and building Agent project profile...',
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

        const doc = await vs.workspace.openTextDocument(vs.Uri.file(rulesPath));
        await vs.window.showTextDocument(doc, { preview: false });

        postMessage({
            type: 'agentStep',
            step: {
                type: 'validation',
                content: `Generated CWTOOLS.md and Agent profile -> ${profilePath}`,
                timestamp: Date.now(),
            },
        });

        vs.window.showInformationMessage(`Eddy CWTool Code: generated CWTOOLS.md and profile.json for ${path.basename(root)}`);
        return { success: true, rulesPath, profilePath };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        postMessage({
            type: 'agentStep',
            step: { type: 'error', content: `/init failed: ${message}`, timestamp: Date.now() },
        });
        return { success: false, message };
    }
}
