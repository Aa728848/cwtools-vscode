import * as THREE from 'three';
import type { LocatorVector3 } from './locatorDuplicate';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Convert a PDX script locator rotation to a Three.js Euler.
 *
 * PDX/Clausewitz rotation format: { ry, rx, rz } (Yaw, Pitch, Roll)
 *   - First value  = rotation around Y axis (yaw)
 *   - Second value = rotation around X axis (pitch)
 *   - Third value  = rotation around Z axis (roll)
 *
 * Script locators live in the model frame: their `position` uses the same axes as
 * the .mesh locator positions and their rotation reproduces the .mesh locator
 * quaternions (vanilla evidence: the avian ring habitat yaws its part locators in
 * 60° steps that match the mesh quaternions exactly). The preview rotates the whole
 * model group by PI around Y so the model's -Z forward maps onto the Three.js -Z
 * forward; that group transform already covers mesh geometry, mesh locators and
 * script locators alike. Negating pitch/roll here would apply it a second time and
 * mirror every script locator, which reverses the direction of attached effects and
 * bones (for example `rotation = { 0 -90 0 }` must pitch the locator's forward axis
 * down; negating it points the effect straight up).
 */
export function pdxScriptEuler(ryDeg: number, rxDeg: number, rzDeg: number): THREE.Euler {
    return new THREE.Euler(
        rxDeg * DEG_TO_RAD,
        ryDeg * DEG_TO_RAD,
        rzDeg * DEG_TO_RAD,
        'YXZ',
    );
}

/** Return the locator's logical X/Y/Z rotation in degrees (script pitch/yaw/roll). */
export function getLocatorRotationDegrees(obj: THREE.Object3D): LocatorVector3 {
    const euler = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
    return [
        euler.x * RAD_TO_DEG,
        euler.y * RAD_TO_DEG,
        euler.z * RAD_TO_DEG,
    ];
}

/** Apply a logical X/Y/Z rotation (degrees) to a locator object. */
export function setLocatorRotationDegrees(obj: THREE.Object3D, rotation: LocatorVector3): void {
    obj.setRotationFromEuler(pdxScriptEuler(rotation[1], rotation[0], rotation[2]));
}

/** Convert logical X/Y/Z UI rotation to the PDX script's Y/X/Z storage order. */
export function toPdxScriptRotation(rotation: LocatorVector3): LocatorVector3 {
    return [rotation[1], rotation[0], rotation[2]];
}
