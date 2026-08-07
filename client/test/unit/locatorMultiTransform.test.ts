import { expect } from 'chai';
import * as THREE from 'three';
import { applyWorldDeltaToLocalTransform, getSelectionWorldCenter } from '../../webview/locatorMultiTransform';

describe('locator multi transform', () => {
    it('uses the world-space center of the selected locators', () => {
        const parent = new THREE.Group();
        parent.position.set(10, 0, 0);
        const first = new THREE.Object3D();
        const second = new THREE.Object3D();
        first.position.set(0, 0, 0);
        second.position.set(4, 2, 0);
        parent.add(first, second);
        parent.updateMatrixWorld(true);

        expect(getSelectionWorldCenter([first, second]).toArray()).to.deep.equal([12, 1, 0]);
    });

    it('applies one world translation to every parent-local transform', () => {
        const start = new THREE.Matrix4().makeTranslation(2, 0, 0);
        const parent = new THREE.Matrix4().makeTranslation(10, 0, 0);
        const delta = new THREE.Matrix4().makeTranslation(3, 4, 0);
        const result = applyWorldDeltaToLocalTransform(start, parent, delta);

        expect(result.position.toArray()).to.deep.equal([-5, 4, 0]);
    });

    it('rotates a locator around the shared pivot delta', () => {
        const start = new THREE.Matrix4().makeTranslation(2, 0, 0);
        const delta = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
        const result = applyWorldDeltaToLocalTransform(start, new THREE.Matrix4(), delta);

        expect(result.position.x).to.be.closeTo(0, 1e-10);
        expect(result.position.y).to.be.closeTo(2, 1e-10);
        const direction = new THREE.Vector3(1, 0, 0).applyQuaternion(result.quaternion);
        expect(direction.x).to.be.closeTo(0, 1e-10);
        expect(direction.y).to.be.closeTo(1, 1e-10);
    });
});
