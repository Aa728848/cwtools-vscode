import * as THREE from 'three';

export interface LocatorLocalTransform {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
}

/** Compute the world-space center used by the multi-selection gizmo. */
export function getSelectionWorldCenter(objects: readonly THREE.Object3D[]): THREE.Vector3 {
    const center = new THREE.Vector3();
    if (objects.length === 0) return center;
    for (const object of objects) center.add(object.getWorldPosition(new THREE.Vector3()));
    return center.multiplyScalar(1 / objects.length);
}

/** Apply a world-space gizmo delta and return the resulting parent-local transform. */
export function applyWorldDeltaToLocalTransform(
    startWorld: THREE.Matrix4,
    parentWorld: THREE.Matrix4,
    deltaWorld: THREE.Matrix4,
): LocatorLocalTransform {
    const local = parentWorld.clone().invert().multiply(deltaWorld).multiply(startWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const ignoredScale = new THREE.Vector3();
    local.decompose(position, quaternion, ignoredScale);
    return { position, quaternion };
}
