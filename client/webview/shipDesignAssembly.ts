import * as THREE from 'three';
import type { ShipDesignLocatorAssetData, ShipDesignModelNodeData } from '../shared/shipDesignProtocol';
import { applyLocatorTransform, applyScriptLocatorTransform } from './entityModelRuntime';
import type { ParsedLocator } from './pdxMeshParser';

export interface ShipAssemblyNode {
    model: ShipDesignModelNodeData;
    parentId?: string;
    invalidParent: boolean;
}

const order = ['root', 'section', 'component'] as const;

/** Parent kind is validated as well as ID, so malformed trees cannot form cycles. */
export function planShipAssembly(models: readonly ShipDesignModelNodeData[]): ShipAssemblyNode[] {
    const byId = new Map<string, ShipDesignModelNodeData>();
    for (const model of models) if (!byId.has(model.id)) byId.set(model.id, model);
    const result: ShipAssemblyNode[] = [];
    for (const kind of order) {
        for (const model of byId.values()) {
            if (model.kind !== kind) continue;
            const expected = kind === 'section' ? 'root' : kind === 'component' ? 'section' : undefined;
            const parent = model.parentId === undefined ? undefined : byId.get(model.parentId);
            const validParent = expected !== undefined && parent?.kind === expected;
            result.push({
                model,
                parentId: validParent ? parent?.id : undefined,
                invalidParent: expected !== undefined && !validParent,
            });
        }
    }
    return result;
}

/** Accepts only current-view IDs and holds a bounded number of assets awaiting ancestors. */
export class ShipAssemblyQueue<T> {
    private readonly nodes: Map<string, ShipAssemblyNode>;
    private readonly pending = new Map<string, T>();
    private readonly settled = new Set<string>();

    constructor(
        private readonly plan: readonly ShipAssemblyNode[],
        private readonly limit = 256,
    ) {
        this.nodes = new Map(plan.map(node => [node.model.id, node]));
    }

    enqueue(nodeId: string, asset: T): 'queued' | 'ignored' | 'full' {
        if (!this.nodes.has(nodeId) || this.settled.has(nodeId)) return 'ignored';
        if (!this.pending.has(nodeId) && this.pending.size >= this.limit && !this.canAttach(nodeId)) {
            this.settle(nodeId);
            return 'full';
        }
        this.pending.set(nodeId, asset);
        return 'queued';
    }

    settle(nodeId: string): void {
        if (this.nodes.has(nodeId)) this.settled.add(nodeId);
        this.pending.delete(nodeId);
    }

    /** Assets received but still waiting for an ancestor, so a rebuilt queue can carry them over. */
    pendingAssets(): ReadonlyMap<string, T> {
        return this.pending;
    }

    get complete(): boolean {
        return this.settled.size === this.plan.length;
    }

    drain(attach: (node: ShipAssemblyNode, asset: T) => void): void {
        for (const node of this.plan) {
            const id = node.model.id;
            const asset = this.pending.get(id);
            if (asset === undefined || !this.canAttach(id)) continue;
            this.settle(id);
            attach(node, asset);
        }
    }

    private canAttach(nodeId: string): boolean {
        const parentId = this.nodes.get(nodeId)?.parentId;
        return parentId === undefined || this.settled.has(parentId);
    }
}

const locatorKey = (name: string): string => name.toLowerCase();

export interface ShipEntityAnchors {
    locators: ReadonlyMap<string, THREE.Object3D>;
    joints: ReadonlyMap<string, THREE.Object3D>;
}

/** Mesh locators can be bone-local. Script values override only the fields they define. */
export function buildShipLocatorAnchors(
    entity: THREE.Object3D,
    meshLocators: readonly ParsedLocator[],
    scriptLocators: readonly ShipDesignLocatorAssetData[],
    joints: ReadonlyMap<string, THREE.Object3D> = new Map(),
    onMissingJoint?: (locator: string, joint: string) => void,
): ShipEntityAnchors {
    const locators = new Map<string, THREE.Object3D>();
    const resolveJoint = (name: string | undefined, locator: string): THREE.Object3D => {
        if (name === undefined) return entity;
        const joint = joints.get(locatorKey(name));
        if (!joint) onMissingJoint?.(locator, name);
        return joint ?? entity;
    };
    for (const locator of meshLocators) {
        const anchor = new THREE.Object3D();
        anchor.name = locator.name;
        applyLocatorTransform(anchor, locator, true);
        resolveJoint(locator.parentBone, locator.name).add(anchor);
        locators.set(locatorKey(locator.name), anchor);
    }
    for (const locator of scriptLocators) {
        const key = locatorKey(locator.name);
        const anchor = locators.get(key) ?? new THREE.Object3D();
        anchor.name = locator.name;
        if (!anchor.parent || locator.parentJoint !== undefined) {
            resolveJoint(locator.parentJoint, locator.name).add(anchor);
        }
        applyScriptLocatorTransform(anchor, locator, true);
        locators.set(key, anchor);
    }
    return { locators, joints };
}

export interface ShipAttachmentTransform {
    matrix: THREE.Matrix4;
    missing: boolean;
}

/** Compute the actual locator world transform in the owning entity frame. */
export function shipAttachmentTransform(
    parent: THREE.Object3D,
    anchors: ShipEntityAnchors | undefined,
    name: string | undefined,
): ShipAttachmentTransform {
    const key = name ? locatorKey(name) : '';
    const anchor = key ? anchors?.locators.get(key) ?? anchors?.joints.get(key) : undefined;
    const matrix = new THREE.Matrix4();
    if (!anchor) return { matrix, missing: true };
    parent.updateWorldMatrix(true, false);
    if (parent.matrixWorld.determinant() === 0) return { matrix, missing: true };
    anchor.updateWorldMatrix(true, false);
    matrix.copy(parent.matrixWorld).invert().multiply(anchor.matrixWorld);
    return { matrix, missing: false };
}

export function mountShipAttachment(
    child: THREE.Object3D,
    parent: THREE.Object3D,
    anchors: ShipEntityAnchors | undefined,
    name: string | undefined,
): boolean {
    const { matrix, missing } = shipAttachmentTransform(parent, anchors, name);
    parent.add(child);
    child.matrixAutoUpdate = false;
    child.matrix.copy(matrix);
    child.matrixWorldNeedsUpdate = true;
    return !missing;
}
