import { expect } from 'chai';
import {
    applyLocatorTransformDelta,
    buildSpecialDuplicateTransforms,
    generateDuplicateLocatorNames,
    getLocatorTransformDelta,
    type LocatorTransform,
} from '../../webview/locatorDuplicate';

describe('Locator special duplicate', () => {
    it('accumulates position and rotation steps for every copy', () => {
        const copies = buildSpecialDuplicateTransforms(
            { position: [1, 2, 3], rotation: [10, 20, 30] },
            {
                copies: 3,
                positionStep: [2, -1, 0.5],
                rotationStep: [0, 15, -5],
            },
        );

        expect(copies).to.deep.equal([
            { position: [3, 1, 3.5], rotation: [10, 35, 25] },
            { position: [5, 0, 4], rotation: [10, 50, 20] },
            { position: [7, -1, 4.5], rotation: [10, 65, 15] },
        ]);
    });

    it('can rotate copied positions around the model origin', () => {
        const copies = buildSpecialDuplicateTransforms(
            { position: [2, 0, 0], rotation: [0, 0, 0] },
            {
                copies: 2,
                positionStep: [0, 0, 0],
                rotationStep: [0, 0, 90],
                orbitAroundOrigin: true,
            },
        );

        expect(copies[0]!.position[0]).to.be.closeTo(0, 1e-10);
        expect(copies[0]!.position[1]).to.be.closeTo(2, 1e-10);
        expect(copies[1]!.position[0]).to.be.closeTo(-2, 1e-10);
        expect(copies[1]!.position[1]).to.be.closeTo(0, 1e-10);
        expect(copies.map(copy => copy.rotation)).to.deep.equal([[0, 0, 90], [0, 0, 180]]);
    });

    it('uses XYZ Euler order when orbiting around all three axes', () => {
        const [copy] = buildSpecialDuplicateTransforms(
            { position: [1.2, -2.3, 4.5], rotation: [0, 0, 0] },
            {
                copies: 1,
                positionStep: [0, 0, 0],
                rotationStep: [20, -35, 71],
                orbitAroundOrigin: true,
            },
        );

        expect(copy!.position[0]).to.be.closeTo(-0.47966218998, 1e-10);
        expect(copy!.position[1]).to.be.closeTo(-1.40146279833, 1e-10);
        expect(copy!.position[2]).to.be.closeTo(4.97853655288, 1e-10);
    });

    it('preserves numeric suffixes and skips names that already exist', () => {
        expect(generateDuplicateLocatorNames(
            'weapon_007',
            3,
            ['weapon_008', 'WEAPON_010'],
        )).to.deep.equal(['weapon_009', 'weapon_011', 'weapon_012']);
    });

    it('adds a readable suffix when the source has no number', () => {
        expect(generateDuplicateLocatorNames('turret', 2, ['turret_copy_01']))
            .to.deep.equal(['turret_copy_02', 'turret_copy_03']);
    });

    it('captures and reapplies the transform used by Shift+D', () => {
        const source: LocatorTransform = { position: [1, 2, 3], rotation: [10, 170, -170] };
        const moved: LocatorTransform = { position: [3, 1, 7], rotation: [25, -170, 170] };
        const delta = getLocatorTransformDelta(source, moved);

        expect(delta).to.deep.equal({
            position: [2, -1, 4],
            rotation: [15, 20, -20],
        });
        expect(applyLocatorTransformDelta(moved, delta)).to.deep.equal({
            position: [5, 0, 11],
            rotation: [40, -150, 150],
        });
    });
});
