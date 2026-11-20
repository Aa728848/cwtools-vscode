import { expect } from 'chai';
import * as THREE from 'three';
import { shipDesignModelNodeKeys, type ShipDesignModelNodeData } from '../../shared/shipDesignProtocol';
import {
    ShipAssemblyQueue, buildShipLocatorAnchors, mountShipAttachment, planShipAssembly, shipAttachmentTransform,
} from '../../webview/shipDesignAssembly';

const root: ShipDesignModelNodeData = { id: 'hull', kind: 'root', warnings: [] };
const section: ShipDesignModelNodeData = {
    id: 'bow', kind: 'section', parentId: root.id, locatorName: 'Bow', sectionId: 'section-1', warnings: [],
};
const component: ShipDesignModelNodeData = {
    id: 'weapon', kind: 'component', parentId: section.id, locatorName: 'Turret',
    sectionId: section.sectionId, slotId: 'slot-1', warnings: [],
};

function positionOf(object: THREE.Object3D): number[] {
    return object.getWorldPosition(new THREE.Vector3()).toArray();
}

function expectVector(actual: number[], expected: number[]): void {
    expect(actual.length).to.equal(expected.length);
    actual.forEach((value, i) => expect(value).to.be.closeTo(expected[i] ?? NaN, 1e-6));
}

describe('ship design assembly', () => {
    it('keys model nodes so a component swap rebuilds only that component', () => {
        const hull = { ...root, entityName: 'hull_entity' };
        const bow = { ...section, entityName: 'bow_entity' };
        const weapon = { ...component, entityName: 'laser_entity' };
        const other = { ...component, id: 'weapon-2', slotId: 'slot-2', locatorName: 'Turret2', entityName: 'laser_entity' };
        const before = shipDesignModelNodeKeys([hull, bow, weapon, other]);
        const swapped = shipDesignModelNodeKeys([hull, bow, { ...weapon, entityName: 'blue_laser_entity' }, other]);
        expect(swapped.get('weapon')).not.to.equal(before.get('weapon'));
        for (const id of ['hull', 'bow', 'weapon-2']) expect(swapped.get(id), id).to.equal(before.get(id));

        const resectioned = shipDesignModelNodeKeys([hull, { ...bow, entityName: 'bow_entity_b' }, weapon, other]);
        expect(resectioned.get('hull')).to.equal(before.get('hull'));
        for (const id of ['bow', 'weapon', 'weapon-2']) expect(resectioned.get(id), id).not.to.equal(before.get(id));
    });

    it('terminates on malformed parent cycles', () => {
        const keys = shipDesignModelNodeKeys([
            { id: 'a', kind: 'section', parentId: 'b', warnings: [] },
            { id: 'b', kind: 'section', parentId: 'a', warnings: [] },
        ]);
        expect(keys.size).to.equal(2);
    });

    it('parents sections to the ship size root and components to their section', () => {
        const planned = planShipAssembly([component, root, section]);
        expect(planned.map(({ model, parentId, invalidParent }) => [model.id, parentId, invalidParent])).to.deep.equal([
            ['hull', undefined, false], ['bow', 'hull', false], ['weapon', 'bow', false],
        ]);
        expect(planShipAssembly([{ ...section, parentId: component.id }, component])[0]?.invalidParent).to.equal(true);
    });

    it('uses a bone-local mesh transform and a PDX script locator through the full hierarchy', () => {
        const hull = new THREE.Group();
        hull.position.set(1, 0, 0);
        hull.scale.setScalar(2);
        const joint = new THREE.Bone();
        joint.position.set(3, 0, 0);
        hull.add(joint);
        const meshTransform = new THREE.Matrix4().makeTranslation(0, 0, -5);
        const hullLocators = buildShipLocatorAnchors(hull, [{
            name: 'Bow', position: [99, 0, 0], rotation: [0, 0, 0, 1], parentBone: 'joint',
            transform: new Float32Array(meshTransform.elements),
        }], [{ name: 'bow', rotation: [90, 0, 0] }], new Map([['joint', joint]]));
        const bow = new THREE.Group();
        expect(mountShipAttachment(bow, hull, hullLocators, section.locatorName)).to.equal(true);
        expect(bow.parent).to.equal(hull);
        expectVector(positionOf(bow), [7, 0, -10]);

        const bowLocators = buildShipLocatorAnchors(bow, [], [{
            name: 'Turret', position: [0, 1, -2], rotation: [0, -90, 0], scale: 0.5,
        }]);
        const weapon = new THREE.Group();
        expect(mountShipAttachment(weapon, bow, bowLocators, component.locatorName)).to.equal(true);
        expect(weapon.parent).to.equal(bow);
        expectVector(positionOf(weapon), [3, 2, -10]);
        expectVector(new THREE.Vector3(0, 0, -1).transformDirection(weapon.matrixWorld).toArray(), [0, -1, 0]);
        expectVector(weapon.getWorldScale(new THREE.Vector3()).toArray(), [1, 1, 1]);
    });

    it('reports missing locators and places the child at its parent origin', () => {
        const parent = new THREE.Group();
        parent.position.set(-6, 1, 12);
        const child = new THREE.Group();
        child.position.set(10, 20, 30);
        const anchors = buildShipLocatorAnchors(parent, [], []);
        const result = shipAttachmentTransform(parent, anchors, 'absent');
        expect(result.missing).to.equal(true);
        expect(result.matrix.equals(new THREE.Matrix4())).to.equal(true);
        expect(mountShipAttachment(child, parent, anchors, undefined)).to.equal(false);
        expectVector(positionOf(child), [-6, 1, 12]);
    });

    it('holds out-of-order assets and drains root, section, component in parent order', () => {
        const plan = planShipAssembly([component, section, root]);
        const queue = new ShipAssemblyQueue<string>(plan, 2);
        const applied: string[] = [];
        const drain = (): void => queue.drain((node, asset) => applied.push(node.model.id + ':' + asset));
        expect(queue.enqueue('stale', 'old')).to.equal('ignored');
        expect(queue.enqueue(component.id, 'c')).to.equal('queued');
        drain();
        expect(queue.enqueue(section.id, 's')).to.equal('queued');
        drain();
        expect(applied).to.deep.equal([]);
        expect([...queue.pendingAssets().keys()].sort()).to.deep.equal([section.id, component.id].sort());
        expect(queue.enqueue(root.id, 'r')).to.equal('queued');
        drain();
        expect(applied).to.deep.equal(['hull:r', 'bow:s', 'weapon:c']);
        expect(queue.complete).to.equal(true);
    });

    it('does not read the 2D slot position or rotation to mount a component', () => {
        const componentWithLayout = { ...component, position: { x: 100, y: -200, rotation: 270 } };
        const planned = planShipAssembly([componentWithLayout, root, section]);
        const parent = new THREE.Group();
        const anchors = buildShipLocatorAnchors(parent, [], [{ name: 'Turret', position: [4, 5, 6] }]);
        const weapon = new THREE.Group();
        expect(mountShipAttachment(weapon, parent, anchors, planned[2]?.model.locatorName)).to.equal(true);
        expectVector(positionOf(weapon), [4, 5, 6]);
        expectVector(new THREE.Vector3(0, 0, -1).transformDirection(weapon.matrixWorld).toArray(), [0, 0, -1]);
    });
});
