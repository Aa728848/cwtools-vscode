import * as THREE from 'three';
import type { ParticleTexturePayload, Scalar, Subsystem } from './particleTypes';
import { isRange } from './particleTypes';
import type { ParticleSystemSim } from './particleSimulation';

interface Batch {
    system: ParticleSystemSim;
    geometry: THREE.InstancedBufferGeometry;
    material: THREE.ShaderMaterial;
    mesh: THREE.Mesh;
    posAttr: THREE.InstancedBufferAttribute;
    sizeAttr: THREE.InstancedBufferAttribute;
    rotAttr: THREE.InstancedBufferAttribute;
    colorAttr: THREE.InstancedBufferAttribute;
    frameAttr: THREE.InstancedBufferAttribute;
    sortOrder: number[];
    sortDepths: number[];
    sortByCameraDepth: boolean;
    texture?: THREE.Texture;
}

const VERTEX_SHADER = `
attribute vec3 instancePos;
attribute float instanceSize;
attribute float instanceRot;
attribute vec4 instanceColor;
attribute float instanceFrame;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform vec3 uFixedRight;
uniform vec3 uFixedUp;
uniform float uBillboard;
uniform float uCols;
uniform float uRows;
varying vec2 vUv;
varying vec4 vColor;
void main() {
    vec2 local = position.xy;
    float c = cos(instanceRot);
    float s = sin(instanceRot);
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    vec3 right = mix(uFixedRight, uCameraRight, uBillboard);
    vec3 up = mix(uFixedUp, uCameraUp, uBillboard);
    vec3 worldPos = instancePos + (right * rotated.x + up * rotated.y) * instanceSize;
    float frame = max(0.0, instanceFrame);
    float col = mod(frame, uCols);
    float row = max(0.0, uRows - 1.0 - floor(frame / uCols));
    vec2 tile = vec2(1.0 / uCols, 1.0 / uRows);
    vUv = vec2((uv.x + col) * tile.x, (uv.y + row) * tile.y);
    vColor = instanceColor;
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}`;

const FRAGMENT_SHADER = `
uniform sampler2D uMap;
uniform float uUseTexture;
varying vec2 vUv;
varying vec4 vColor;
void main() {
    vec4 texel = mix(vec4(1.0), texture2D(uMap, vUv), uUseTexture);
    vec4 outColor = texel * vColor;
    outColor.a *= 0.8;
    if (outColor.a < 0.01) discard;
    gl_FragColor = outColor;
}`;

function makeWhiteTexture(): THREE.Texture {
    const data = new Uint8Array([255, 255, 255, 255]);
    const texture = new THREE.DataTexture(data, 1, 1);
    texture.needsUpdate = true;
    return texture;
}

function createGeometry(capacity: number): Batch['geometry'] {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -0.5, -0.5, 0,
        0.5, -0.5, 0,
        0.5, 0.5, 0,
        -0.5, 0.5, 0,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 1,
        1, 1,
        1, 0,
        0, 0,
    ]), 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = capacity;
    return geometry;
}

function blendMode(subsystem: Subsystem): THREE.Blending {
    const shader = subsystem.texture?.shader?.toLowerCase() ?? '';
    return shader.includes('alphablend') ? THREE.NormalBlending : THREE.AdditiveBlending;
}

function isAdditive(subsystem: Subsystem): boolean {
    const shader = subsystem.texture?.shader?.toLowerCase() ?? '';
    return shader.includes('additive') || (!shader.includes('alphablend') && !shader.includes('prealpha'));
}

function shouldSortByCameraDepth(subsystem: Subsystem): boolean {
    const sort = subsystem.sort?.toLowerCase();
    return sort === 'depth' || sort === 'distance' || !isAdditive(subsystem);
}

function scalarBaseValue(value: Scalar | undefined, fallback = 0): number {
    if (!value) return fallback;
    return isRange(value) ? value.a.value : value.value;
}

function fixedOrientation(subsystem: Subsystem): { right: THREE.Vector3; up: THREE.Vector3 } {
    const yaw = THREE.MathUtils.degToRad(scalarBaseValue(subsystem.particleYaw, 0));
    const pitch = THREE.MathUtils.degToRad(scalarBaseValue(subsystem.particlePitch, 0));
    const roll = THREE.MathUtils.degToRad(scalarBaseValue(subsystem.particleRoll, 0));
    const rotation = new THREE.Euler(pitch, yaw, roll, 'YXZ');
    return {
        right: new THREE.Vector3(1, 0, 0).applyEuler(rotation).normalize(),
        up: new THREE.Vector3(0, 1, 0).applyEuler(rotation).normalize(),
    };
}

export class ParticleRenderer {
    private readonly scene: THREE.Scene;
    private batches: Batch[] = [];
    private readonly loader = new THREE.TextureLoader();
    private readonly cameraPosition = new THREE.Vector3();

    constructor(scene: THREE.Scene) {
        this.scene = scene;
    }

    setSystems(systems: ParticleSystemSim[], textures: Record<string, ParticleTexturePayload>): void {
        this.dispose();
        for (const system of systems) {
            this.batches.push(this.createBatch(system, textures));
        }
    }

    update(camera: THREE.Camera): void {
        const elements = camera.matrixWorld.elements;
        const right = new THREE.Vector3(elements[0] ?? 1, elements[1] ?? 0, elements[2] ?? 0);
        const up = new THREE.Vector3(elements[4] ?? 0, elements[5] ?? 1, elements[6] ?? 0);
        this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
        for (const batch of this.batches) {
            const buffer = batch.system.buffer;
            batch.geometry.instanceCount = buffer.count;
            this.copyInstanceData(batch);
            batch.posAttr.needsUpdate = true;
            batch.sizeAttr.needsUpdate = true;
            batch.rotAttr.needsUpdate = true;
            batch.colorAttr.needsUpdate = true;
            batch.frameAttr.needsUpdate = true;
            batch.material.uniforms.uCameraRight!.value.copy(right);
            batch.material.uniforms.uCameraUp!.value.copy(up);
        }
    }

    private copyInstanceData(batch: Batch): void {
        const buffer = batch.system.buffer;
        const count = buffer.count;
        const posArray = batch.posAttr.array as Float32Array;
        const sizeArray = batch.sizeAttr.array as Float32Array;
        const rotArray = batch.rotAttr.array as Float32Array;
        const colorArray = batch.colorAttr.array as Float32Array;
        const frameArray = batch.frameAttr.array as Float32Array;

        if (!batch.sortByCameraDepth || count <= 1) {
            posArray.set(buffer.positions.subarray(0, count * 3));
            sizeArray.set(buffer.sizes.subarray(0, count));
            rotArray.set(buffer.rotations.subarray(0, count));
            colorArray.set(buffer.colors.subarray(0, count * 4));
            frameArray.set(buffer.frames.subarray(0, count));
            return;
        }

        batch.sortOrder.length = count;
        batch.sortDepths.length = count;
        for (let i = 0; i < count; i++) {
            const offset = i * 3;
            const dx = (buffer.positions[offset] ?? 0) - this.cameraPosition.x;
            const dy = (buffer.positions[offset + 1] ?? 0) - this.cameraPosition.y;
            const dz = (buffer.positions[offset + 2] ?? 0) - this.cameraPosition.z;
            batch.sortOrder[i] = i;
            batch.sortDepths[i] = dx * dx + dy * dy + dz * dz;
        }
        batch.sortOrder.sort((a, b) => (batch.sortDepths[b] ?? 0) - (batch.sortDepths[a] ?? 0));

        for (let dst = 0; dst < count; dst++) {
            const src = batch.sortOrder[dst] ?? dst;
            const dst3 = dst * 3;
            const src3 = src * 3;
            const dst4 = dst * 4;
            const src4 = src * 4;
            posArray[dst3] = buffer.positions[src3] ?? 0;
            posArray[dst3 + 1] = buffer.positions[src3 + 1] ?? 0;
            posArray[dst3 + 2] = buffer.positions[src3 + 2] ?? 0;
            sizeArray[dst] = buffer.sizes[src] ?? 1;
            rotArray[dst] = buffer.rotations[src] ?? 0;
            colorArray[dst4] = buffer.colors[src4] ?? 1;
            colorArray[dst4 + 1] = buffer.colors[src4 + 1] ?? 1;
            colorArray[dst4 + 2] = buffer.colors[src4 + 2] ?? 1;
            colorArray[dst4 + 3] = buffer.colors[src4 + 3] ?? 1;
            frameArray[dst] = buffer.frames[src] ?? 0;
        }
    }

    dispose(): void {
        for (const batch of this.batches) {
            this.scene.remove(batch.mesh);
            batch.geometry.dispose();
            batch.material.dispose();
            batch.texture?.dispose();
        }
        this.batches = [];
    }

    private createBatch(system: ParticleSystemSim, textures: Record<string, ParticleTexturePayload>): Batch {
        const geometry = createGeometry(system.capacity);
        const posAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3);
        const sizeAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity), 1);
        const rotAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity), 1);
        const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity * 4), 4);
        const frameAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity), 1);
        geometry.setAttribute('instancePos', posAttr);
        geometry.setAttribute('instanceSize', sizeAttr);
        geometry.setAttribute('instanceRot', rotAttr);
        geometry.setAttribute('instanceColor', colorAttr);
        geometry.setAttribute('instanceFrame', frameAttr);

        const texturePayload = system.subsystem.texture?.file ? textures[system.subsystem.texture.file] : undefined;
        const texture = texturePayload ? this.loader.load(texturePayload.dataUri) : makeWhiteTexture();
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearMipmapLinearFilter;

        const cols = Math.max(1, system.subsystem.texture?.x ?? 1);
        const rows = Math.max(1, system.subsystem.texture?.y ?? 1);
        const additive = isAdditive(system.subsystem);
        const orientation = fixedOrientation(system.subsystem);
        const material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: blendMode(system.subsystem),
            premultipliedAlpha: (system.subsystem.texture?.shader?.toLowerCase() ?? '').includes('prealpha'),
            uniforms: {
                uMap: { value: texture },
                uUseTexture: { value: texturePayload ? 1 : 0 },
                uCols: { value: cols },
                uRows: { value: rows },
                uCameraRight: { value: new THREE.Vector3(1, 0, 0) },
                uCameraUp: { value: new THREE.Vector3(0, 1, 0) },
                uFixedRight: { value: orientation.right },
                uFixedUp: { value: orientation.up },
                uBillboard: { value: system.subsystem.billboard === false ? 0 : 1 },
            },
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = additive ? 20 : 10;
        this.scene.add(mesh);
        return {
            system,
            geometry,
            material,
            mesh,
            posAttr,
            sizeAttr,
            rotAttr,
            colorAttr,
            frameAttr,
            sortOrder: [],
            sortDepths: [],
            sortByCameraDepth: shouldSortByCameraDepth(system.subsystem),
            texture,
        };
    }
}
