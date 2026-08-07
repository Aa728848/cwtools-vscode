import { expect } from 'chai';
import { parseAssetFile } from '../../extension/entityAssetParser';
import {
    findLocatorTextBlock,
    renameLocatorBlock,
    renameLocatorReferencesInEntity,
    updateLocatorTransformBlock,
} from '../../extension/entityLocatorEditing';

describe('entity static locator editing', () => {
    it('finds the exact top-level locator block from the parser line', () => {
        const text = `entity = {
    name = test
    locator =
    {
        name = static_locator
        position = { 0 0 0 }
    }
    state = {
        name = moving
        locator = { name = static_locator position = { 9 9 9 } }
    }
}`;
        const entity = parseAssetFile(text, 'test.asset').entities[0]!;
        const block = findLocatorTextBlock(text.split('\n'), entity.locators[0]!.line);

        expect(block).to.deep.equal({ startLine: 2, endLine: 6 });
    });

    it('updates transform fields without discarding other locator properties', () => {
        const source = '    locator = { name = "static_locator" parent_joint = "root" scale = 0.75 custom = yes position = { 0 0 0 } }';
        const updated = updateLocatorTransformBlock(source, [1, 2, 3], [10, 20, 30]);

        expect(updated).to.include('name = "static_locator"');
        expect(updated).to.include('parent_joint = "root"');
        expect(updated).to.include('scale = 0.75');
        expect(updated).to.include('custom = yes');
        expect(updated).to.include('position = { 1.000000 2.000000 3.000000 }');
        expect(updated).to.include('rotation = { 10.00 20.00 30.00 }');
    });

    it('preserves multiline layout while replacing existing position and rotation', () => {
        const source = `\tlocator = {
\t\tname = static_locator
\t\tposition = { 0 0 0 }
\t\trotation = { 0 0 0 }
\t\tscale = 2
\t}`;
        const updated = updateLocatorTransformBlock(source, [-1, 0.5, 4], [0, 90, 0]);

        expect(updated).to.include('\n\t\tscale = 2\n');
        expect(updated).to.include('position = { -1.000000 0.500000 4.000000 }');
        expect(updated).to.include('rotation = { 0.00 90.00 0.00 }');
    });

    it('renames only the resolved locator name field', () => {
        const source = 'locator = { name = "engine.old" parent_joint = "engine.old" position = { 0 0 0 } }';
        const updated = renameLocatorBlock(source, 'engine.old', 'engine_new');

        expect(updated).to.include('name = "engine_new"');
        expect(updated).to.include('parent_joint = "engine.old"');
    });

    it('renames attach keys and particle nodes without changing entity values', () => {
        const source = `entity = {
    name = test
    attach = { "engine.old" = "engine.old" }
    state = { event = { node = engine.old particle = fx } }
}`;
        const updated = renameLocatorReferencesInEntity(source, 'engine.old', 'engine_new');

        expect(updated).to.include('attach = { "engine_new" = "engine.old" }');
        expect(updated).to.include('node = engine_new');
        expect(updated).to.include('name = test');
    });
});
