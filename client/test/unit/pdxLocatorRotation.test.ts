import { expect } from 'chai';
import * as THREE from 'three';
import {
    getLocatorRotationDegrees,
    pdxScriptEuler,
    setLocatorRotationDegrees,
    toPdxScriptRotation,
} from '../../webview/pdxLocatorRotation';

const DEG = Math.PI / 180;

function quaternionForScript(rotation: [number, number, number]): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(pdxScriptEuler(rotation[0], rotation[1], rotation[2]));
}

describe('PDX script locator rotation', () => {
    it('applies the script pitch as-is so attached effects keep the in-game direction', () => {
        // Vanilla/mod entity locators such as "rotation = { 0 -90 0 }" pitch the
        // locator forward axis (-Z) downwards; negating the pitch pointed it up.
        const forward = new THREE.Vector3(0, 0, -1).applyEuler(pdxScriptEuler(0, -90, 0));

        expect(forward.x).to.be.closeTo(0, 1e-6);
        expect(forward.y).to.be.closeTo(-1, 1e-6);
        expect(forward.z).to.be.closeTo(0, 1e-6);
    });

    it('applies yaw and roll as-is, matching the mesh locator quaternions', () => {
        // Verified against vanilla data: the avian ring habitat yaws its part
        // locators in 60 degree steps (mesh +Z = (-0.87, 0, 0.50) for yaw -60),
        // and planetary entities use roll values such as "rotation = { 0 0 110 }".
        const yaw = quaternionForScript([-60, 0, 0]);
        const expectedYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -60 * DEG);
        expect(yaw.angleTo(expectedYaw)).to.be.closeTo(0, 1e-6);

        const roll = quaternionForScript([0, 0, 110]);
        const expectedRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 110 * DEG);
        expect(roll.angleTo(expectedRoll)).to.be.closeTo(0, 1e-6);
    });

    it('keeps script storage order Y/X/Z when writing logical rotations back', () => {
        const object = new THREE.Object3D();

        setLocatorRotationDegrees(object, [-90, 0, 0]);
        expect(toPdxScriptRotation(getLocatorRotationDegrees(object))).to.deep.equal([0, -90, 0]);

        setLocatorRotationDegrees(object, [15, 30, -20]);
        const written = toPdxScriptRotation(getLocatorRotationDegrees(object));
        expect(written[0]).to.be.closeTo(30, 1e-6);
        expect(written[1]).to.be.closeTo(15, 1e-6);
        expect(written[2]).to.be.closeTo(-20, 1e-6);
    });

    it('round-trips script rotations without changing their sign', () => {
        const scripts: Array<[number, number, number]> = [
            [0, 0, 0],
            [0, -90, 0],
            [-60, 0, 0],
            [0, 0, 110],
            [180, 0, 0],
            [15, 30, -20],
        ];

        for (const script of scripts) {
            const object = new THREE.Object3D();
            object.setRotationFromEuler(pdxScriptEuler(script[0], script[1], script[2]));
            const written = toPdxScriptRotation(getLocatorRotationDegrees(object));
            for (let index = 0; index < 3; index++) {
                expect(written[index]).to.be.closeTo(script[index]!, 1e-6);
            }
        }
    });
});
