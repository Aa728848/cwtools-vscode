import { expect } from 'chai';
import * as THREE from 'three';
import { composeParticleAttachmentMatrix } from '../../webview/particleAttachmentTransform';

describe('particle attachment transform', () => {
    it('maps simulation forward to the locator backward exhaust axis', () => {
        const matrix = composeParticleAttachmentMatrix(new THREE.Matrix4());
        const direction = new THREE.Vector3(0, 0, 1).transformDirection(matrix);

        expect(direction.x).to.be.closeTo(0, 1e-6);
        expect(direction.y).to.be.closeTo(0, 1e-6);
        expect(direction.z).to.be.closeTo(-1, 1e-6);
    });

    it('applies locator or animated bone rotation and translation after basis conversion', () => {
        const anchor = new THREE.Matrix4().compose(
            new THREE.Vector3(4, 5, 6),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
            new THREE.Vector3(2, 2, 2),
        );
        const matrix = composeParticleAttachmentMatrix(anchor);
        const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
        const forwardPoint = new THREE.Vector3(0, 0, 1).applyMatrix4(matrix);

        expect(origin.toArray()).to.deep.equal([4, 5, 6]);
        expect(forwardPoint.x).to.be.closeTo(4, 1e-6);
        expect(forwardPoint.y).to.be.closeTo(5, 1e-6);
        expect(forwardPoint.z).to.be.closeTo(4, 1e-6);
    });
});
