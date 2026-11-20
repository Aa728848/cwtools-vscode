import { expect } from 'chai';
import {
    findDirtyShipDesignDocument,
    isGlobalShipDesignPath,
} from '../../extension/visualEditorSafety';

describe('ship design document write safety', () => {
    it('protects matching unsaved global ship design drafts only', () => {
        const target = { uri: { scheme: 'file', fsPath: 'C:/Mod/common/global_ship_designs/ships.txt' }, isDirty: true };
        expect(isGlobalShipDesignPath(target.uri.fsPath)).to.equal(true);
        expect(isGlobalShipDesignPath('C:/Mod/common/ship_sizes/ships.txt')).to.equal(false);
        expect(findDirtyShipDesignDocument('c:/mod/common/global_ship_designs/ships.txt', [target], 'win32')).to.equal(target);
        expect(findDirtyShipDesignDocument('C:/Mod/common/global_ship_designs/other.txt', [target], 'win32')).to.equal(undefined);
        expect(findDirtyShipDesignDocument('C:/Mod/common/ship_sizes/ships.txt', [target], 'win32')).to.equal(undefined);
    });

    it('protects a Host-only draft even when its TextDocument is still clean', () => {
        const cleanDocument = { uri: { scheme: 'file', fsPath: 'C:/Mod/common/global_ship_designs/ships.txt' }, isDirty: false };
        const panelDraft = { uri: cleanDocument.uri, isDirty: true };
        expect(findDirtyShipDesignDocument(cleanDocument.uri.fsPath, [cleanDocument, panelDraft], 'win32')).to.equal(panelDraft);
    });

    it('ignores clean and non-file documents', () => {
        const clean = { uri: { scheme: 'file', fsPath: 'C:/Mod/common/global_ship_designs/ships.txt' }, isDirty: false };
        const untitled = { uri: { scheme: 'untitled', fsPath: 'C:/Mod/common/global_ship_designs/ships.txt' }, isDirty: true };
        expect(findDirtyShipDesignDocument('C:/Mod/common/global_ship_designs/ships.txt', [clean, untitled], 'win32')).to.equal(undefined);
    });
});
