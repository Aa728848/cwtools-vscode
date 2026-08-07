import * as THREE from 'three';

export interface LocatorLocalTransform {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
}

export type MultiRotationSpace = 'local' | 'world';

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

/**
 * Apply a shared rotation delta to an object around its own origin. Unlike a
 * pivot matrix delta, this preserves the object's world position.
 */
export function applySelfRotationDeltaToLocalTransform(
    startWorld: THREE.Matrix4,
    parentWorld: THREE.Matrix4,
    pivotStartWorld: THREE.Matrix4,
    pivotCurrentWorld: THREE.Matrix4,
    space: MultiRotationSpace,
): LocatorLocalTransform {
    const worldPosition = new THREE.Vector3();
    const worldQuaternion = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    startWorld.decompose(worldPosition, worldQuaternion, worldScale);

    const pivotStartQuaternion = new THREE.Quaternion();
    const pivotCurrentQuaternion = new THREE.Quaternion();
    pivotStartWorld.decompose(new THREE.Vector3(), pivotStartQuaternion, new THREE.Vector3());
    pivotCurrentWorld.decompose(new THREE.Vector3(), pivotCurrentQuaternion, new THREE.Vector3());

    if (space === 'local') {
        const localDelta = pivotStartQuaternion.clone().invert().multiply(pivotCurrentQuaternion);
        worldQuaternion.multiply(localDelta);
    } else {
        const worldDelta = pivotCurrentQuaternion.clone().multiply(pivotStartQuaternion.clone().invert());
        worldQuaternion.premultiply(worldDelta);
    }

    const nextWorld = new THREE.Matrix4().compose(worldPosition, worldQuaternion, worldScale);
    const local = parentWorld.clone().invert().multiply(nextWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const ignoredScale = new THREE.Vector3();
    local.decompose(position, quaternion, ignoredScale);
    return { position, quaternion };
}
