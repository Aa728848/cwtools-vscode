import { expect } from 'chai';
import {
    clearSessionPermissionMode,
    getSessionPermissionMode,
    isSessionFullAccess,
    sessionApprovalsReviewer,
    sessionFileWriteMode,
    sessionPolicyPreset,
    setSessionPermissionMode,
    shouldReviewOpaqueCommandBeforePolicy,
} from '../../extension/ai/runner/sessionPermissions';

describe('session permission profiles', () => {
    const workspace = 'C:/workspace/session-permissions';

    afterEach(() => clearSessionPermissionMode(workspace));

    it('keeps quick permission changes in memory and clears them explicitly', () => {
        setSessionPermissionMode(workspace, 'confirm');
        expect(getSessionPermissionMode(workspace)).to.equal('confirm');
        expect(sessionFileWriteMode(workspace)).to.equal('confirm');
        expect(sessionApprovalsReviewer(workspace)).to.equal('user');
        expect(sessionPolicyPreset(workspace)).to.equal('workspace-auto');
        clearSessionPermissionMode(workspace);
        expect(getSessionPermissionMode(workspace)).to.equal(undefined);
    });

    it('maps auto-review and full access without persisting configuration', () => {
        setSessionPermissionMode(workspace, 'auto_review');
        expect(sessionApprovalsReviewer(workspace)).to.equal('auto_review');
        expect(sessionPolicyPreset(workspace)).to.equal('workspace-auto-review');
        expect(isSessionFullAccess(workspace)).to.equal(false);

        setSessionPermissionMode(workspace, 'full');
        expect(sessionFileWriteMode(workspace)).to.equal('auto');
        expect(sessionApprovalsReviewer(workspace)).to.equal('user');
        expect(sessionPolicyPreset(workspace)).to.equal('full-access');
        expect(isSessionFullAccess(workspace)).to.equal(true);
    });

    it('routes opaque commands through the model only in auto-review mode', () => {
        expect(shouldReviewOpaqueCommandBeforePolicy('auto_review', 'run_command', true, false)).to.equal(true);
        expect(shouldReviewOpaqueCommandBeforePolicy('user', 'run_command', true, false)).to.equal(false);
        expect(shouldReviewOpaqueCommandBeforePolicy('auto_review', 'run_command', false, false)).to.equal(false);
        expect(shouldReviewOpaqueCommandBeforePolicy('auto_review', 'run_command', true, true)).to.equal(false);
    });
});
