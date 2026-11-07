import { expect } from 'chai';
import {
    clearSessionPermissionMode,
    getSessionPermissionMode,
    sessionFileWriteMode,
    setSessionPermissionMode,
} from '../../extension/ai/runner/sessionPermissions';

describe('session file-write mode', () => {
    const workspace = 'C:/workspace/session-permissions';

    afterEach(() => clearSessionPermissionMode(workspace));

    it('keeps quick write-mode changes in memory and clears them explicitly', () => {
        setSessionPermissionMode(workspace, 'confirm');
        expect(getSessionPermissionMode(workspace)).to.equal('confirm');
        expect(sessionFileWriteMode(workspace)).to.equal('confirm');

        setSessionPermissionMode(workspace, 'auto');
        expect(getSessionPermissionMode(workspace)).to.equal('auto');
        expect(sessionFileWriteMode(workspace)).to.equal('auto');

        clearSessionPermissionMode(workspace);
        expect(getSessionPermissionMode(workspace)).to.equal(undefined);
        expect(sessionFileWriteMode(workspace)).to.equal(undefined);
    });
});
