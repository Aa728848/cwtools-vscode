import { expect } from 'chai';
import { findEntityAttachPath, getNewAttachCycle } from '../../extension/entityAttachDiagnostics';

describe('entity attach diagnostics', () => {
    const graph = new Map([
        ['root', { attaches: [{ entityName: 'turret' }] }],
        ['turret', { attaches: [{ entityName: 'muzzle' }] }],
        ['muzzle', { attaches: [] }],
    ]);

    it('finds a deterministic attach path', () => {
        expect(findEntityAttachPath(graph, 'root', 'muzzle')).to.deep.equal(['root', 'turret', 'muzzle']);
        expect(findEntityAttachPath(graph, 'muzzle', 'root')).to.equal(undefined);
    });

    it('detects a proposed circular attach edge', () => {
        expect(getNewAttachCycle(graph, 'muzzle', 'root')).to.deep.equal([
            'muzzle', 'root', 'turret', 'muzzle',
        ]);
        expect(getNewAttachCycle(graph, 'root', 'muzzle')).to.equal(undefined);
        expect(getNewAttachCycle(graph, 'root', 'root')).to.deep.equal(['root', 'root']);
    });
});
