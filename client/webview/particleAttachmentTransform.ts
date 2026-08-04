import * as THREE from 'three';

// Entity meshes are converted from Maya Z+ forward to Three.js Z- forward.
// Attached particle simulations are Z-forward too, so flip their local X/Z
// axes before applying the locator/bone transform. This makes an engine
// locator's local -Z the exhaust direction while retaining its roll/pitch.
const SIMULATION_TO_ATTACHMENT_BASIS = new THREE.Matrix4().set(
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -1, 0,
    0, 0, 0, 1,
);

/** Compose a particle simulation's local coordinates with a locator/bone world transform. */
export function composeParticleAttachmentMatrix(
    anchorWorld: THREE.Matrix4,
    target = new THREE.Matrix4(),
): THREE.Matrix4 {
    return target.copy(anchorWorld).multiply(SIMULATION_TO_ATTACHMENT_BASIS);
}
