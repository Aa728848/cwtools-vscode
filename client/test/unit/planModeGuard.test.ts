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
    });
});

function loadPlanModeGuardModule() {
    return require('../../extension/ai/planModeGuard') as typeof import('../../extension/ai/planModeGuard');
}
