import * as THREE from 'three';
import type { ParticleTexturePayload, Subsystem } from './particleTypes';
import type { ParticleSystemSim } from './particleSimulation';

interface Batch {
    system: ParticleSystemSim;
    geometry: THREE.InstancedBufferGeometry;
    material: THREE.ShaderMaterial;
    mesh: THREE.Mesh;
    posAttr: THREE.InstancedBufferAttribute;
    tailAttr: THREE.InstancedBufferAttribute;
    sizeAttr: THREE.InstancedBufferAttribute;
    rotAttr: THREE.InstancedBufferAttribute;
    colorAttr: THREE.InstancedBufferAttribute;
    frameAttr: THREE.InstancedBufferAttribute;
    rightAttr: THREE.InstancedBufferAttribute;
    upAttr: THREE.InstancedBufferAttribute;
    sortOrder: number[];
    sortDepths: number[];
    sortByCameraDepth: boolean;
    disposed: boolean;
    texture?: THREE.Texture;
}

const VERTEX_SHADER = `
attribute vec3 instancePos;
attribute vec3 instanceTail;
attribute float instanceSize;
attribute float instanceRot;
attribute vec4 instanceColor;
attribute float instanceFrame;
attribute vec3 instanceRight;
attribute vec3 instanceUp;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform vec3 uCameraForward;
uniform float uBillboard;
uniform float uTrail;
uniform float uCols;
uniform float uRows;
varying vec2 vUv;
varying vec4 vColor;
void main() {
    vec2 local = position.xy;
    float c = cos(instanceRot);
    float s = sin(instanceRot);
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    vec3 right = mix(instanceRight, uCameraRight, uBillboard);
    vec3 up = mix(instanceUp, uCameraUp, uBillboard);
    vec3 quadPos = instancePos + (right * rotated.x + up * rotated.y) * instanceSize;
    vec3 trailAxis = instancePos - instanceTail;
    float trailLength = length(trailAxis);
    vec3 trailAlong = trailLength > 0.0001 ? trailAxis / trailLength : up;
    vec3 trailSide = cross(trailAlong, uCameraForward);
    trailSide = length(trailSide) > 0.0001 ? normalize(trailSide) : right;
    vec3 trailPos = mix(instanceTail, instancePos, local.y + 0.5) + trailSide * local.x * instanceSize;
    vec3 worldPos = mix(quadPos, trailPos, uTrail);
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

function makeTransparentTexture(): THREE.Texture {
    const data = new Uint8Array([0, 0, 0, 0]);
    const texture = new THREE.DataTexture(data, 1, 1);
    texture.needsUpdate = true;
    return texture;
}

function configureParticleTexture(texture: THREE.Texture, mipmaps = true): void {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
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
        const forward = new THREE.Vector3(-(elements[8] ?? 0), -(elements[9] ?? 0), -(elements[10] ?? 1));
        this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
        for (const batch of this.batches) {
            const buffer = batch.system.buffer;
            batch.geometry.instanceCount = buffer.count;
            this.copyInstanceData(batch);
            batch.posAttr.needsUpdate = true;
            batch.tailAttr.needsUpdate = true;
            batch.sizeAttr.needsUpdate = true;
            batch.rotAttr.needsUpdate = true;
            batch.colorAttr.needsUpdate = true;
            batch.frameAttr.needsUpdate = true;
            batch.rightAttr.needsUpdate = true;
            batch.upAttr.needsUpdate = true;
            batch.material.uniforms.uCameraRight!.value.copy(right);
            batch.material.uniforms.uCameraUp!.value.copy(up);
            batch.material.uniforms.uCameraForward!.value.copy(forward);
        }
    }

    private copyInstanceData(batch: Batch): void {
        const buffer = batch.system.buffer;
        const count = buffer.count;
        const posArray = batch.posAttr.array as Float32Array;
        const tailArray = batch.tailAttr.array as Float32Array;
        const sizeArray = batch.sizeAttr.array as Float32Array;
        const rotArray = batch.rotAttr.array as Float32Array;
        const colorArray = batch.colorAttr.array as Float32Array;
        const frameArray = batch.frameAttr.array as Float32Array;
        const rightArray = batch.rightAttr.array as Float32Array;
        const upArray = batch.upAttr.array as Float32Array;

        if (!batch.sortByCameraDepth || count <= 1) {
            posArray.set(buffer.positions.subarray(0, count * 3));
            tailArray.set(buffer.trailTails.subarray(0, count * 3));
            sizeArray.set(buffer.sizes.subarray(0, count));
            rotArray.set(buffer.rotations.subarray(0, count));
            colorArray.set(buffer.colors.subarray(0, count * 4));
            frameArray.set(buffer.frames.subarray(0, count));
            rightArray.set(buffer.rights.subarray(0, count * 3));
            upArray.set(buffer.ups.subarray(0, count * 3));
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
            tailArray[dst3] = buffer.trailTails[src3] ?? posArray[dst3] ?? 0;
            tailArray[dst3 + 1] = buffer.trailTails[src3 + 1] ?? posArray[dst3 + 1] ?? 0;
            tailArray[dst3 + 2] = buffer.trailTails[src3 + 2] ?? posArray[dst3 + 2] ?? 0;
            sizeArray[dst] = buffer.sizes[src] ?? 1;
            rotArray[dst] = buffer.rotations[src] ?? 0;
            rightArray[dst3] = buffer.rights[src3] ?? 1;
            rightArray[dst3 + 1] = buffer.rights[src3 + 1] ?? 0;
            rightArray[dst3 + 2] = buffer.rights[src3 + 2] ?? 0;
            upArray[dst3] = buffer.ups[src3] ?? 0;
            upArray[dst3 + 1] = buffer.ups[src3 + 1] ?? 1;
            upArray[dst3 + 2] = buffer.ups[src3 + 2] ?? 0;
            colorArray[dst4] = buffer.colors[src4] ?? 1;
            colorArray[dst4 + 1] = buffer.colors[src4 + 1] ?? 1;
            colorArray[dst4 + 2] = buffer.colors[src4 + 2] ?? 1;
            colorArray[dst4 + 3] = buffer.colors[src4 + 3] ?? 1;
            frameArray[dst] = buffer.frames[src] ?? 0;
        }
    }

    dispose(): void {
        for (const batch of this.batches) {
            batch.disposed = true;
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
        const tailAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3);
        const sizeAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity), 1);
        const rotAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity), 1);
        const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity * 4), 4);
        const frameAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity), 1);
        const rightAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3);
        const upAttr = new THREE.InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3);
        geometry.setAttribute('instancePos', posAttr);
        geometry.setAttribute('instanceTail', tailAttr);
        geometry.setAttribute('instanceSize', sizeAttr);
        geometry.setAttribute('instanceRot', rotAttr);
        geometry.setAttribute('instanceColor', colorAttr);
        geometry.setAttribute('instanceFrame', frameAttr);
        geometry.setAttribute('instanceRight', rightAttr);
        geometry.setAttribute('instanceUp', upAttr);

        const expectedTexture = !!system.subsystem.texture?.file;
        const texturePayload = expectedTexture ? textures[system.subsystem.texture!.file] : undefined;
        const texture = expectedTexture ? makeTransparentTexture() : makeWhiteTexture();
        configureParticleTexture(texture, false);

        const cols = Math.max(1, system.subsystem.texture?.x ?? 1);
        const rows = Math.max(1, system.subsystem.texture?.y ?? 1);
        const additive = isAdditive(system.subsystem);
        const material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: blendMode(system.subsystem),
            premultipliedAlpha: (system.subsystem.texture?.shader?.toLowerCase() ?? '').includes('prealpha'),
            uniforms: {
                uMap: { value: texture },
                uUseTexture: { value: expectedTexture ? 1 : 0 },
                uCols: { value: cols },
                uRows: { value: rows },
                uCameraRight: { value: new THREE.Vector3(1, 0, 0) },
                uCameraUp: { value: new THREE.Vector3(0, 1, 0) },
                uCameraForward: { value: new THREE.Vector3(0, 0, -1) },
                uBillboard: { value: system.subsystem.billboard === false ? 0 : 1 },
                uTrail: { value: system.subsystem.trail ? 1 : 0 },
            },
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = additive ? 20 : 10;
        this.scene.add(mesh);
        const batch = {
            system,
            geometry,
            material,
            mesh,
            posAttr,
            tailAttr,
            sizeAttr,
            rotAttr,
            colorAttr,
            frameAttr,
            rightAttr,
            upAttr,
            sortOrder: [],
            sortDepths: [],
            sortByCameraDepth: shouldSortByCameraDepth(system.subsystem),
            disposed: false,
            texture,
        };
        if (texturePayload) {
            this.loader.load(texturePayload.dataUri, loadedTexture => {
                if (batch.disposed) {
                    loadedTexture.dispose();
                    return;
                }
                configureParticleTexture(loadedTexture);
                batch.texture?.dispose();
                batch.texture = loadedTexture;
                batch.material.uniforms.uMap!.value = loadedTexture;
                batch.material.uniforms.uUseTexture!.value = 1;
            }, undefined, () => {
                if (!batch.disposed) {
                    batch.material.uniforms.uUseTexture!.value = 1;
                }
            });
        }
        return batch;
    }
}
