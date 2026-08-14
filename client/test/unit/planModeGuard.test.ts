import { expect } from 'chai';
import * as path from 'path';

describe('planModeGuard', () => {
    it('allows only read-only git_ops actions in read-only oriented modes', () => {
        const { validateGitOpsForMode } = loadPlanModeGuardModule();

        expect(validateGitOpsForMode('plan', { action: 'status' }).allowed).to.equal(true);
        expect(validateGitOpsForMode('review', { action: 'diff' }).allowed).to.equal(true);

        const blocked = validateGitOpsForMode('explore', { action: 'checkout', file: 'src/main.ts' });
        expect(blocked.allowed).to.equal(false);
        expect(blocked.reason).to.include('status and diff');

        expect(validateGitOpsForMode('build', { action: 'checkout', file: 'src/main.ts' }).allowed).to.equal(true);
    });

    it('lets plan mode write topic card artifacts but blocks project file edits', () => {
        const { validatePlanModeToolUse } = loadPlanModeGuardModule();
        const { configurePrivateAgentStorage } = require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths');
        const workspaceRoot = path.join(process.cwd(), '.tmp-plan-mode-workspace');

        const artifact = validatePlanModeToolUse(
            'edit_file',
            { filePath: path.join(workspaceRoot, '.cwtools-ai', 'topic-123', 'annotations.md') },
            workspaceRoot
        );
        expect(artifact.allowed).to.equal(true);

        const projectEdit = validatePlanModeToolUse(
            'edit_file',
            { filePath: path.join(workspaceRoot, 'common', 'events', 'test.txt') },
            workspaceRoot
        );
        expect(projectEdit.allowed).to.equal(false);

        const privateRoot = path.join(process.cwd(), '.tmp-private-agent-storage');
        configurePrivateAgentStorage(privateRoot);
        try {
            const privateArtifact = path.join(privateRoot, 'topics', 'topic-123', 'design_blueprint.md');
            expect(validatePlanModeToolUse(
                'write_file',
                { file: privateArtifact },
                workspaceRoot,
                'topic-123',
            ).allowed).to.equal(true);
            expect(validatePlanModeToolUse(
                'write_file',
                { file: path.join(privateRoot, 'topics', 'other-topic', 'design_blueprint.md') },
                workspaceRoot,
                'topic-123',
            ).allowed).to.equal(false);
        } finally {
            configurePrivateAgentStorage(undefined);
        }
    });

    it('lets coordinators write only the current topic Implementation_Plan.md', () => {
        const { validatePlanModeToolUse } = loadPlanModeGuardModule();
        const workspaceRoot = path.join(process.cwd(), '.tmp-plan-mode-workspace');
        const currentPlan = path.join(workspaceRoot, '.cwtools', 'topic-123', 'Implementation_Plan.md');

        expect(validatePlanModeToolUse(
            'write_file',
            { file: currentPlan, content: '# Plan' },
            workspaceRoot,
            'topic-123',
            undefined,
            'orchestrator',
        ).allowed).to.equal(true);

        for (const blockedPath of [
            path.join(workspaceRoot, '.cwtools', 'other-topic', 'Implementation_Plan.md'),
            path.join(workspaceRoot, '.cwtools', 'topic-123', 'annotations.md'),
            path.join(workspaceRoot, 'client', 'extension.ts'),
        ]) {
            const blocked = validatePlanModeToolUse(
                'write_file',
                { file: blockedPath, content: '# Plan' },
                workspaceRoot,
                'topic-123',
                undefined,
                'script',
            );
            expect(blocked.allowed, blockedPath).to.equal(false);
            expect(blocked.reason).to.include('script mode blocks direct workspace mutation');
        }
    });
});

function loadPlanModeGuardModule() {
    return require('../../extension/ai/planModeGuard') as typeof import('../../extension/ai/planModeGuard');
}
