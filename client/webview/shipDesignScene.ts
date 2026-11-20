import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { shipDesignModelNodeKeys, type ShipDesignEntityAssetData, type ShipDesignViewData } from '../shared/shipDesignProtocol';
import {
    EntityTextureCache, buildGeometry, buildSkeletonFromParsedBones, createPlaceholderMaterial,
    decodeModelBase64, resolveMeshTextureUri, resolveSubmeshTextures, upgradeSubmeshMaterial,
    type ResolvedMeshSetting, type ResolvedTextures,
} from './entityModelRuntime';
import type { EnvironmentPreset } from './environmentTypes';
import { parsePdxMesh } from './pdxMeshParser';
import {
    ShipAssemblyQueue, buildShipLocatorAnchors, mountShipAttachment, planShipAssembly,
    type ShipAssemblyNode, type ShipEntityAnchors,
} from './shipDesignAssembly';
import { SkyboxEnvironment } from './skyboxEnvironment';

export interface ShipDesignSceneSelection {
    sectionId?: string;
    slotId?: string;
}

export interface ShipDesignSceneCallbacks {
    onSelect(selection: ShipDesignSceneSelection): void;
    onError(message: string): void;
}

export interface ShipDesignScene {
    setView(view: ShipDesignViewData): void;
    setAsset(nodeId: string, asset: ShipDesignEntityAssetData): void;
    setAssetError(nodeId: string, message: string): void;
    setSelected(selection: ShipDesignSceneSelection): void;
    setEnvironment(presets: EnvironmentPreset[], workerUri?: string): void;
    resize(): void;
    dispose(): void;
}

interface SceneNode {
    mount: THREE.Group;
    entity: THREE.Group;
    anchors?: ShipEntityAnchors;
    /** Composite identity from `shipDesignModelNodeKeys`; reuse requires an equal key. */
    key: string;
    /** True once the node's asset or failure has been applied. */
    settled: boolean;
    meshes: ShipMesh[];
    axes: THREE.AxesHelper[];
}

type MeshBuffers = ReadonlyMap<ShipDesignEntityAssetData, ArrayBuffer>;
type AssetResult = { asset: ShipDesignEntityAssetData; buffers?: MeshBuffers } | { error: string };
type ShipMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
interface MaterialJob {
    mesh: ShipMesh;
    textures: ResolvedTextures;
}

const MAX_ATTACH_DEPTH = 16;
const MAX_MATERIAL_JOBS = 4;
const MAX_VISIBLE_WARNINGS = 12;
/** Reused meshes (e.g. many identical turrets) stay cached; one huge hull is fetched but not retained. */
const MAX_MESH_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_MESH_BYTES = 32 * 1024 * 1024;
const VIEW_DIRECTION = new THREE.Vector3(1.1, 0.68, 1.4).normalize();
const SELECTED_COLOR = new THREE.Color(0x4fc3f7);

function meshSelection(mesh: THREE.Object3D): ShipDesignSceneSelection {
    const { sectionId, slotId } = mesh.userData;
    return {
        sectionId: typeof sectionId === 'string' ? sectionId : undefined,
        slotId: typeof slotId === 'string' ? slotId : undefined,
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function meshSettings(asset: ShipDesignEntityAssetData): ResolvedMeshSetting[] {
    // Host supplies GFX, entity and default-state overrides in increasing precedence.
    const merged = new Map<string, ResolvedMeshSetting>();
    for (const source of asset.meshSettings) {
        const name = source.name ?? '__unnamed';
        const key = JSON.stringify([name, source.index]);
        const setting = merged.get(key) ?? { name, index: source.index };
        if (source.shader) setting.shader = source.shader;
        for (const [value, channel] of [
            [source.textureDiffuse, 'diffuse'], [source.textureNormal, 'normal'], [source.textureSpecular, 'specular'],
        ] as const) {
            if (value) setting[channel] = resolveMeshTextureUri(asset.textureMap, value);
        }
        merged.set(key, setting);
    }
    return [...merged.values()].reverse();
}

export function createShipDesignScene(container: HTMLElement, callbacks: ShipDesignSceneCallbacks): ShipDesignScene {
    const zh = (document.documentElement.lang || navigator.language).toLowerCase().startsWith('zh');
    const text = (en: string, cn: string): string => zh ? cn : en;
    const surface = document.createElement('div');
    surface.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden';
    const status = document.createElement('div');
    status.className = 'ship-design-scene-fallback';
    status.setAttribute('role', 'status');
    status.textContent = text('Preparing ship model…', '正在准备舰船模型…');
    container.append(surface);
    surface.append(status);

    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try {
        renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (error) {
        const fallback = text('WebGL is unavailable. The design and loadout are still available.', 'WebGL 不可用。仍可查看舰船设计和配装。');
        status.textContent = fallback;
        queueMicrotask(() => {
            if (!disposed) callbacks.onError(fallback + ' ' + messageOf(error));
        });
        return {
            setView(view) {
                if (!disposed) status.textContent = view.model.length ? fallback + ' ' + (view.shipSize || view.designId) : fallback;
            },
            setAsset() {},
            setAssetError(_id, message) { if (!disposed) callbacks.onError(message); },
            setSelected() {},
            setEnvironment() {},
            resize() {},
            dispose() { disposed = true; surface.remove(); },
        };
    }

    const canvas = renderer.domElement;
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    canvas.setAttribute('aria-label', text('3D ship model', '舰船三维模型'));
    surface.prepend(canvas);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5000);
    camera.position.copy(VIEW_DIRECTION).multiplyScalar(12);
    const controls = new OrbitControls(camera, canvas);
    // Default stationary orbit and on-demand rendering also respect reduced motion.
    controls.enableDamping = false;
    const defaults = new THREE.Group();
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 3);
    const fill = new THREE.DirectionalLight(0xffffff, 1.3);
    fill.position.set(-3, 2, -4);
    defaults.add(new THREE.HemisphereLight(0xffffff, 0x969696, 1.3), key, fill);
    const restoreDefaults = (): void => {
        defaults.visible = true;
        scene.background = new THREE.Color(getComputedStyle(container).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e');
    };
    restoreDefaults();
    const assembly = new THREE.Group();
    // Apply the same viewing-basis conversion as Entity Preview once to the whole design.
    assembly.rotation.y = Math.PI;
    scene.add(assembly, defaults);

    const lifetime = new AbortController();
    const listener = { signal: lifetime.signal };
    status.style.cssText = 'position:absolute;inset:0;display:grid;place-content:center;pointer-events:none';
    const toolbar = document.createElement('div');
    toolbar.className = 'ship-design-scene-toolbar';
    const button = (label: string): HTMLButtonElement => {
        const control = document.createElement('button');
        control.type = 'button';
        control.textContent = label;
        toolbar.append(control);
        return control;
    };
    const reset = button(text('Reset view', '重置视角'));
    const toggleLocators = button(text('Locators', '定位点'));
    toggleLocators.setAttribute('aria-pressed', 'false');
    surface.append(toolbar);

    const nodes = new Map<string, SceneNode>();
    const meshes: ShipMesh[] = [];
    const baseColors = new WeakMap<THREE.Material, THREE.Color>();
    const axes: THREE.AxesHelper[] = [];
    let queue: ShipAssemblyQueue<AssetResult> | undefined;
    let textureCache = new EntityTextureCache();
    let materialJobs: MaterialJob[] = [];
    let activeJobs = 0;
    let epoch = 0;
    let frame: number | undefined;
    let autoFit = true;
    let fitPending = false;
    /** Only the first assembly of a design reframes the camera; incremental edits keep the user's view. */
    let fitOnLoad = true;
    let viewIdentity: string | undefined;
    const retired = new WeakSet<THREE.Mesh>();
    let showLocators = false;
    let contextLost = false;
    let selection: ShipDesignSceneSelection = {};
    const modelWarnings = new Set<string>();
    let environmentWarning: string | undefined;

    function warn(message: string): void {
        if (disposed || modelWarnings.has(message) || modelWarnings.size >= MAX_VISIBLE_WARNINGS) return;
        modelWarnings.add(message);
    }

    let environmentEpoch = 0;
    let environmentRunning = false;
    let nextEnvironment: { presets: EnvironmentPreset[]; workerUri?: string } | undefined;
    const environment = new SkyboxEnvironment(renderer, scene, camera, {
        hideDefaults() { defaults.visible = false; },
        restoreDefaults,
        onLog(message, level) {
            if (disposed || nextEnvironment || level === 'info') return;
            setEnvironmentWarning(text('Using available environment settings.', '正在使用可用的环境设置。') + ' ' + message);
        },
    });
    environment.setLutEnabled(false);

    function setEnvironmentWarning(message: string | undefined): void {
        if (disposed || environmentWarning === message) return;
        environmentWarning = message;
    }

    async function applyNextEnvironment(): Promise<void> {
        if (disposed || environmentRunning || !nextEnvironment) return;
        const { presets, workerUri } = nextEnvironment;
        nextEnvironment = undefined;
        const token = environmentEpoch;
        environmentRunning = true;
        const preset = presets.find(item => item.id === 'ship_designer');
        const usable = preset && (workerUri || !preset.environmentMapUri && !preset.backgrounds.some(bg => bg.textureUri));
        environment.setPresets(presets, workerUri);
        try {
            if (!usable) {
                setEnvironmentWarning(text('Ship designer environment unavailable. Using neutral lighting.', '舰船设计环境不可用，正在使用中性光照。'));
            }
            const pending = environment.applyPreset(usable ? preset.id : null);
            requestFrame();
            await pending;
        } catch (error) {
            if (!disposed && token === environmentEpoch) {
                await environment.applyPreset(null);
                setEnvironmentWarning(text('Environment could not be loaded.', '无法加载环境。') + ' ' + messageOf(error));
            }
        } finally {
            environmentRunning = false;
            if (disposed) environment.dispose();
            else {
                requestFrame();
                void applyNextEnvironment();
            }
        }
    }

    function requestFrame(): void {
        if (disposed || contextLost || frame !== undefined) return;
        frame = requestAnimationFrame(() => {
            frame = undefined;
            if (fitPending) {
                fitPending = false;
                if (autoFit) fitCamera();
            }
            renderer.render(scene, camera);
        });
    }

    function fitCamera(): void {
        if (meshes.length === 0) return;
        assembly.updateMatrixWorld(true);
        const box = new THREE.Box3();
        const scratch = new THREE.Box3();
        for (const mesh of meshes) {
            if (!mesh.visible) continue;
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            if (mesh.geometry.boundingBox) box.union(scratch.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
        }
        if (box.isEmpty()) return;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        if (!Number.isFinite(sphere.radius)) return;
        const radius = Math.max(0.1, sphere.radius);
        const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2);
        const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect);
        const distance = 1.28 * radius / Math.sin(Math.min(halfVertical, halfHorizontal));
        camera.near = Math.max(0.001, radius / 500);
        camera.far = Math.max(100, distance + 100 * radius);
        controls.minDistance = radius * 0.05;
        controls.maxDistance = camera.far * 0.65;
        const center = sphere.center.clone();
        center.y -= radius * 0.12;
        controls.target.copy(center);
        camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
        camera.updateProjectionMatrix();
        controls.update();
    }

    function resize(): void {
        if (disposed) return;
        const { clientHeight: height, clientWidth: width } = surface;
        if (!height || !width) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        fitPending = true;
        requestFrame();
    }

    function updateStatus(): void {
        const hasGeometry = meshes.some(mesh => mesh.visible);
        status.style.display = hasGeometry && !contextLost ? 'none' : 'grid';
        if (contextLost) {
            status.textContent = text('Graphics context unavailable. You can still inspect the design and loadout.', '图形上下文不可用。仍可检查舰船设计和配装。');
        } else if (!queue) {
            status.textContent = text('Preparing ship model…', '正在准备舰船模型…');
        } else if (!queue.complete) {
            status.textContent = text('Loading ship model…', '正在加载舰船模型…');
        } else {
            status.textContent = text('No visible model geometry is available for this design.', '此舰船设计没有可显示的模型几何体。');
        }
    }

    function highlight(mesh: ShipMesh): void {
        const material = mesh.material;
        let base = baseColors.get(material);
        if (!base) {
            base = material.color.clone();
            baseColors.set(material, base);
        }
        const owner = meshSelection(mesh);
        const selected = selection.slotId ? owner?.slotId === selection.slotId
            : !!selection.sectionId && !owner?.slotId && owner?.sectionId === selection.sectionId;
        material.color.copy(base);
        if (selected) material.color.lerp(SELECTED_COLOR, 0.65);
    }

    function pumpMaterials(): void {
        while (!disposed && activeJobs < MAX_MATERIAL_JOBS) {
            const job = materialJobs.pop();
            if (!job) break;
            const token = epoch;
            activeJobs++;
            const isCurrent = (): boolean => !disposed && token === epoch && !retired.has(job.mesh);
            void upgradeSubmeshMaterial(job.mesh, job.textures, {
                textureCache,
                hideSingleTexture: false,
                getEnvMapIntensity: () => environment.envMapIntensity,
                isCurrent,
                onError: error => warn(text('Model material failed to load.', '模型材质加载失败。') + ' ' + messageOf(error)),
            }).then(() => {
                if (isCurrent()) {
                    job.mesh.material.envMapIntensity = environment.envMapIntensity;
                    highlight(job.mesh);
                    requestFrame();
                }
            }).finally(() => {
                activeJobs--;
                pumpMaterials();
            });
        }
    }

    function showMissingLocator(parent: string, child: string, locator?: string): void {
        warn(locator
            ? text(
                'Locator “' + locator + '” is missing on “' + parent + '”. “' + child + '” is placed at its parent origin.',
                '“' + parent + '”缺少定位点“' + locator + '”。“' + child + '”已放在父节点原点。',
            ) : text(
                'No locator is specified for “' + child + '”. It is placed at its parent origin.',
                '“' + child + '”未指定定位点，已放在父节点原点。',
            ));
    }

    function buildEntity(
        entity: THREE.Group,
        asset: ShipDesignEntityAssetData,
        owner: ShipDesignSceneSelection,
        ancestors: Set<string>,
        sink: SceneNode,
        buffers?: MeshBuffers,
    ): ShipEntityAnchors {
        entity.name = asset.name;
        entity.scale.setScalar(asset.scale ?? 1);
        const joints = new Map<string, THREE.Object3D>();
        let parsed: ReturnType<typeof parsePdxMesh> | undefined;
        const bytes = buffers?.get(asset) ?? (asset.meshBase64 ? decodeModelBase64(asset.meshBase64) : undefined);
        if (bytes) {
            try {
                parsed = parsePdxMesh(bytes);
            } catch (error) {
                warn(text('Unable to parse mesh for ', '无法解析网格 ') + asset.name + '. ' + messageOf(error));
            }
        }
        const skeleton = parsed?.shapes.find(shape => shape.skeleton.length)?.skeleton;
        const built = skeleton && buildSkeletonFromParsedBones(skeleton);
        if (built) {
            for (const bone of built.orderedBones) {
                if (!bone.parent) entity.add(bone);
                joints.set(bone.name.toLowerCase(), bone);
            }
        }

        const resolvedMeshSettings = meshSettings(asset);
        const materialData = { resolvedMeshSettings, textureMap: asset.textureMap };
        let meshIndex = 0;
        for (const shape of parsed?.shapes ?? []) {
            for (const [index, subMesh] of shape.meshes.entries()) {
                const textures = resolveSubmeshTextures(meshIndex++, subMesh.name, subMesh.material, materialData, index);
                if (textures.shaderCategory !== 'pbr' || subMesh.positions.length === 0) continue;
                const mesh = new THREE.Mesh(buildGeometry(subMesh), createPlaceholderMaterial(textures, false));
                mesh.name = subMesh.name;
                mesh.userData.sectionId = owner.sectionId;
                mesh.userData.slotId = owner.slotId;
                entity.add(mesh);
                meshes.push(mesh);
                sink.meshes.push(mesh);
                highlight(mesh);
                if (textures.diffuse || textures.normal || textures.specular) materialJobs.push({ mesh, textures });
            }
        }
        const anchors = buildShipLocatorAnchors(entity, parsed?.locators ?? [], asset.locators, joints, (locator, joint) => {
            warn(text(
                'Joint “' + joint + '” is missing for locator “' + locator + '” on “' + asset.name + '”.',
                '“' + asset.name + '”的定位点“' + locator + '”缺少关节“' + joint + '”。',
            ));
        });
        for (const anchor of anchors.locators.values()) {
            const helper = new THREE.AxesHelper(1);
            helper.visible = showLocators;
            anchor.add(helper);
            axes.push(helper);
            sink.axes.push(helper);
        }

        ancestors.add(asset.name.toLowerCase());
        for (const { locatorName, entity: child } of asset.attaches) {
            if (ancestors.size >= MAX_ATTACH_DEPTH || ancestors.has(child.name.toLowerCase())) {
                warn(text('Skipped cyclic or deeply nested attachment ', '已跳过循环或嵌套过深的挂件 ') + child.name + '.');
                continue;
            }
            const mount = new THREE.Group();
            if (!mountShipAttachment(mount, entity, anchors, locatorName)) showMissingLocator(asset.name, child.name, locatorName);
            const childEntity = new THREE.Group();
            mount.add(childEntity);
            buildEntity(childEntity, child, owner, ancestors, sink, buffers);
        }
        ancestors.delete(asset.name.toLowerCase());
        return anchors;
    }

    function drainAssets(): void {
        queue?.drain(({ model, parentId }, result) => {
            if (disposed) return;
            const node = nodes.get(model.id);
            if (!node) return;
            const parent = parentId === undefined ? undefined : nodes.get(parentId);
            if (parent && model.locatorName
                && !mountShipAttachment(node.mount, parent.entity, parent.anchors, model.locatorName)) {
                showMissingLocator(parent.entity.name, node.entity.name, model.locatorName);
            }
            node.settled = true;
            if ('error' in result) return;
            try {
                node.anchors = buildEntity(node.entity, result.asset, { sectionId: model.sectionId, slotId: model.slotId }, new Set(), node, result.buffers);
            } catch (error) {
                warn(text('Unable to build entity ', '无法构建实体 ') + result.asset.name + '. ' + messageOf(error));
            }
        });
        updateStatus();
        if (fitOnLoad && meshCountChanged()) fitPending = true;
        if (queue?.complete) fitOnLoad = false;
        pumpMaterials();
        requestFrame();
    }

    let lastMeshCount = 0;
    function meshCountChanged(): boolean {
        const changed = lastMeshCount !== meshes.length;
        lastMeshCount = meshes.length;
        return changed;
    }

    function disposeMesh(mesh: ShipMesh): void {
        mesh.geometry.dispose();
        const material = mesh.material;
        // Materials own borrowed texture clones; the shared cache keeps the base textures.
        const textures = new Set([material.map, material.normalMap, material.roughnessMap, material.metalnessMap]);
        for (const texture of textures) texture?.dispose();
        material.dispose();
    }

    function clearDesign(): void {
        epoch++;
        textureCache.dispose();
        materialJobs = [];
        queue = undefined;
        for (const mesh of meshes) disposeMesh(mesh);
        meshes.length = 0;
        lastMeshCount = 0;
        for (const helper of axes) helper.dispose();
        axes.length = 0;
        assembly.clear();
        nodes.clear();
        modelWarnings.clear();
    }

    /** Removes one node's own meshes; descendant nodes are retired separately by key comparison. */
    function retireNodes(removed: readonly SceneNode[]): void {
        if (!removed.length) return;
        const retiredAxes = new Set<THREE.AxesHelper>();
        for (const node of removed) {
            for (const mesh of node.meshes) {
                retired.add(mesh);
                disposeMesh(mesh);
            }
            for (const helper of node.axes) {
                retiredAxes.add(helper);
                helper.dispose();
            }
            node.mount.removeFromParent();
        }
        const keptMeshes = meshes.filter(mesh => !retired.has(mesh));
        meshes.splice(0, meshes.length, ...keptMeshes);
        const keptAxes = axes.filter(helper => !retiredAxes.has(helper));
        axes.splice(0, axes.length, ...keptAxes);
        materialJobs = materialJobs.filter(job => !retired.has(job.mesh));
        lastMeshCount = meshes.length;
    }

    function createNode(entry: ShipAssemblyNode, key: string): void {
        const { model, parentId, invalidParent } = entry;
        const mount = new THREE.Group();
        mount.name = model.id;
        const entity = new THREE.Group();
        entity.name = model.entityName ?? model.id;
        mount.add(entity);
        const parent = parentId === undefined ? undefined : nodes.get(parentId);
        (parent?.entity ?? assembly).add(mount);
        const node: SceneNode = { mount, entity, key, settled: false, meshes: [], axes: [] };
        nodes.set(model.id, node);
        if (invalidParent) warn(text('Parent node is unavailable for ', '缺少父节点 ') + entity.name + '.');
        for (const warning of model.warnings) warn(warning);
        if (!model.entityName) {
            if (model.kind === 'root') {
                queue?.settle(model.id);
                node.settled = true;
            } else acceptAsset(model.id, { error: text('No model entity is available for ', '模型实体不可用 ') + model.id + '.' });
        }
    }

    function setView(view: ShipDesignViewData): void {
        if (disposed) return;
        const identity = JSON.stringify([view.designId, view.assetRevision ?? 0]);
        const keys = shipDesignModelNodeKeys(view.model);
        const plan = planShipAssembly(view.model);
        if (identity !== viewIdentity || nodes.size === 0) {
            clearDesign();
            viewIdentity = identity;
            textureCache = new EntityTextureCache();
            autoFit = true;
            fitOnLoad = true;
            queue = new ShipAssemblyQueue(plan);
            for (const entry of plan) createNode(entry, keys.get(entry.model.id) ?? '');
            updateStatus();
            resize();
            requestFrame();
            return;
        }
        // Same design: keep every loaded node whose composite identity is unchanged, so an edit
        // rebuilds only the replaced component (or a changed section subtree) without reframing.
        // Unchanged nodes are kept even while their asset is still downloading or waiting for a
        // parent; the Host never resends an asset it already delivered for the same key.
        const kept = new Set<string>();
        for (const { model } of plan) {
            const existing = nodes.get(model.id);
            if (existing && existing.key === keys.get(model.id)) kept.add(model.id);
        }
        const removed: SceneNode[] = [];
        for (const [id, node] of nodes) {
            if (kept.has(id)) continue;
            removed.push(node);
            nodes.delete(id);
        }
        retireNodes(removed);
        const carried = queue?.pendingAssets() ?? new Map<string, AssetResult>();
        queue = new ShipAssemblyQueue(plan);
        for (const entry of plan) {
            if (!kept.has(entry.model.id)) createNode(entry, keys.get(entry.model.id) ?? '');
            else if (nodes.get(entry.model.id)?.settled) queue.settle(entry.model.id);
        }
        let carriedAny = false;
        for (const [id, result] of carried) {
            if (!kept.has(id) || nodes.get(id)?.settled) continue;
            queue.enqueue(id, result);
            carriedAny = true;
        }
        if (carriedAny) drainAssets();
        updateStatus();
        requestFrame();
    }

    const meshCache = new Map<string, ArrayBuffer>();
    let meshCacheBytes = 0;
    const meshRequests = new Map<string, Promise<ArrayBuffer>>();

    function fetchMesh(uri: string): Promise<ArrayBuffer> {
        const cached = meshCache.get(uri);
        if (cached) {
            meshCache.delete(uri);
            meshCache.set(uri, cached);
            return Promise.resolve(cached);
        }
        const running = meshRequests.get(uri);
        if (running) return running;
        const request = fetch(uri, { signal: lifetime.signal }).then(async response => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength <= MAX_CACHED_MESH_BYTES) {
                meshCache.set(uri, buffer);
                meshCacheBytes += buffer.byteLength;
                for (const [oldest, value] of meshCache) {
                    if (meshCacheBytes <= MAX_MESH_CACHE_BYTES) break;
                    meshCache.delete(oldest);
                    meshCacheBytes -= value.byteLength;
                }
            }
            return buffer;
        }).finally(() => meshRequests.delete(uri));
        meshRequests.set(uri, request);
        return request;
    }

    /** Resolves every URI-referenced mesh in an entity tree before it is built synchronously. */
    async function loadMeshBuffers(asset: ShipDesignEntityAssetData): Promise<MeshBuffers> {
        const buffers = new Map<ShipDesignEntityAssetData, ArrayBuffer>();
        const pending: Array<Promise<void>> = [];
        const visit = (entry: ShipDesignEntityAssetData, depth: number): void => {
            if (depth > MAX_ATTACH_DEPTH) return;
            if (entry.meshUri && !entry.meshBase64) {
                const uri = entry.meshUri;
                pending.push(fetchMesh(uri).then(buffer => { buffers.set(entry, buffer); }, error => {
                    warn(text('Unable to load mesh for ', '无法加载网格 ') + entry.name + '. ' + messageOf(error));
                }));
            }
            for (const attach of entry.attaches) visit(attach.entity, depth + 1);
        };
        visit(asset, 0);
        await Promise.all(pending);
        return buffers;
    }

    function hasMeshUri(asset: ShipDesignEntityAssetData, depth = 0): boolean {
        if (depth > MAX_ATTACH_DEPTH) return false;
        return Boolean(asset.meshUri && !asset.meshBase64) || asset.attaches.some(attach => hasMeshUri(attach.entity, depth + 1));
    }

    function receiveAsset(nodeId: string, asset: ShipDesignEntityAssetData): void {
        const node = nodes.get(nodeId);
        if (!node || node.entity.name.toLowerCase() !== asset.name.toLowerCase()) return;
        if (!hasMeshUri(asset)) {
            acceptAsset(nodeId, { asset });
            return;
        }
        void loadMeshBuffers(asset).then(buffers => {
            // The node may have been retired or rebuilt by a newer view while the mesh downloaded.
            if (!disposed && nodes.get(nodeId) === node) acceptAsset(nodeId, { asset, buffers });
        });
    }

    function acceptAsset(nodeId: string, result: AssetResult): void {
        if ('error' in result && nodes.has(nodeId)) warn(result.error);
        const accepted = queue?.enqueue(nodeId, result);
        if (accepted === 'ignored' || accepted === undefined) return;
        if (accepted === 'full') {
            warn(text('Too many model assets awaiting parent nodes.', '等待父节点的模型资源过多。'));
        }
        drainAssets();
    }

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let pointerDown: { id: number; x: number; y: number } | undefined;
    canvas.addEventListener('pointerdown', event => {
        pointerDown = event.isPrimary && event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : undefined;
    }, listener);
    canvas.addEventListener('pointercancel', () => { pointerDown = undefined; }, listener);
    canvas.addEventListener('pointerup', event => {
        const start = pointerDown;
        pointerDown = undefined;
        if (!start || start.id !== event.pointerId || Math.hypot(start.x - event.clientX, start.y - event.clientY) > 5) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height || !meshes.length) return;
        ndc.set((event.clientX - rect.left) * 2 / rect.width - 1, 1 - (event.clientY - rect.top) * 2 / rect.height);
        assembly.updateMatrixWorld(true);
        camera.updateWorldMatrix(true, false);
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObjects(meshes, false)[0];
        const owner = hit && meshSelection(hit.object);
        if (owner?.sectionId || owner?.slotId) callbacks.onSelect(owner);
    }, listener);
    canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        contextLost = true;
        updateStatus();
        callbacks.onError(status.textContent ?? 'WebGL context lost');
    }, listener);
    canvas.addEventListener('webglcontextrestored', () => {
        contextLost = false;
        updateStatus();
        requestFrame();
    }, listener);
    function stopAutoFit(): void { autoFit = false; }
    controls.addEventListener('start', stopAutoFit);
    controls.addEventListener('change', requestFrame);
    reset.addEventListener('click', () => { autoFit = true; fitPending = true; requestFrame(); }, listener);
    toggleLocators.addEventListener('click', () => {
        showLocators = !showLocators;
        toggleLocators.setAttribute('aria-pressed', String(showLocators));
        for (const helper of axes) helper.visible = showLocators;
        requestFrame();
    }, listener);

    resize();
    return {
        setView,
        setAsset: receiveAsset,
        setAssetError(nodeId, message) { acceptAsset(nodeId, { error: message }); },
        setSelected(next) { selection = next; for (const mesh of meshes) highlight(mesh); requestFrame(); },
        setEnvironment(presets, workerUri) {
            if (disposed) return;
            environmentEpoch++;
            setEnvironmentWarning(undefined);
            nextEnvironment = { presets, workerUri };
            void applyNextEnvironment();
        },
        resize,
        dispose() {
            if (disposed) return;
            disposed = true;
            lifetime.abort();
            nextEnvironment = undefined;
            if (frame !== undefined) cancelAnimationFrame(frame);
            controls.removeEventListener('start', stopAutoFit);
            controls.removeEventListener('change', requestFrame);
            controls.dispose();
            clearDesign();
            // Invalidate the active preset immediately. The shared controller clears
            // pending worker promises on dispose, so let any current decode settle first.
            if (environmentRunning) void environment.applyPreset(null);
            else environment.dispose();
            renderer.dispose();
            renderer.forceContextLoss();
            surface.remove();
        },
    };
}
