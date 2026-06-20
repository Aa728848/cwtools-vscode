/**
 * Entity Preview — Three.js Webview Renderer
 *
 * Renders PDX entity models in a VS Code webview using Three.js.
 * Handles mesh loading via Web Worker, DDS texture decoding, PBR material
 * pipeline, and interactive orbit camera controls.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { parsePdxMesh, parsePdxAnim, type ParsedMeshFile, type ParsedSubMesh, type ParsedAnimation, type ParsedLocator } from './pdxMeshParser';
import { pdxHelperFunctions, pdxNormalFragmentMaps, pdxRoughnessFragment, pdxMetalnessFragment, pdxEmissiveFragment } from './pdxShaders';
import { Icons } from './svgIcons';
import {
    applyLocatorTransformDelta,
    buildSpecialDuplicateTransforms,
    generateDuplicateLocatorNames,
    getLocatorTransformDelta,
    type LocatorTransform,
    type LocatorTransformDelta,
    type LocatorVector3,
} from './locatorDuplicate';

// ── VS Code API ──────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();


// ── i18n ─────────────────────────────────────────────────────────────────────

const locale = document.body.dataset.locale ?? 'en';
const isChinese = locale.startsWith('zh');

const i18n: Record<string, { en: string; zh: string }> = {
    title:          { en: 'Entity Preview',               zh: '实体预览' },
    focus:          { en: 'Focus (F)',                     zh: '聚焦 (F)' },
    wireframe:      { en: 'Wireframe',                     zh: '线框' },
    locators:       { en: 'Locators',                      zh: '定位器' },
    disableNormals: { en: 'Disable Normals',               zh: '禁用法线' },
    bones:          { en: 'Bones',                          zh: '骨骼' },
    loading:        { en: 'Loading...',                     zh: '加载中...' },
    noEntity:       { en: 'No entity loaded',              zh: '未加载实体' },
    openHint:       { en: 'Open a .asset file and click preview', zh: '打开 .asset 文件并点击预览按钮' },
    apply:          { en: 'Apply',                         zh: '应用' },
    reset:          { en: 'Reset',                         zh: '重置' },
    transformHint:  { en: 'Click locator to select · W Translate · E Rotate', zh: '点击定位器选中 · W 移动 · E 旋转' },
    translateBtn:   { en: 'Translate (W)',                 zh: '移动 (W)' },
    rotateBtn:      { en: 'Rotate (E)',                    zh: '旋转 (E)' },
};

function applyI18n() {
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n!;
        const entry = i18n[key];
        if (entry) {
            el.textContent = isChinese ? entry.zh : entry.en;
        }
    });
    document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle!;
        const entry = i18n[key];
        if (entry) {
            el.title = isChinese ? entry.zh : entry.en;
        }
    });
}

applyI18n();

interface ResolvedMeshSetting {
    name: string;
    index: number;
    diffuse?: string;   // webview URI
    normal?: string;
    specular?: string;
    shader?: string;
}

interface AttachData {
    locatorName: string;
    entityName: string;
    meshBase64?: string;
    resolvedMeshSettings: ResolvedMeshSetting[];
    textureMap: Record<string, string>;
    scale?: number;
    meshScale?: number;
    locators: Array<{
        name: string;
        position?: [number, number, number];
        rotation?: [number, number, number];
        scale?: number;
    }>;
    attachData?: AttachData[];
    defaultState?: string;
    getStateFromParent?: boolean;
    animations?: Array<{ stateName: string; animName: string; animBase64: string }>;
}

interface EntityData {
    name: string;
    pdxmesh?: string;
    scale?: number;
    meshScale?: number;
    resolvedMeshSettings?: ResolvedMeshSetting[];
    textureMap?: Record<string, string>;  // relative path → webview URI
    locators?: Array<{
        name: string;
        position?: [number, number, number];
        rotation?: [number, number, number];
        scale?: number;
    }>;
    attaches?: Array<{ locatorName: string; entityName: string }>;
    states?: Array<{ name: string; animation?: string }>;
    defaultState?: string;
    attachData?: AttachData[];
}

interface RenderMessage {
    command: 'render';
    entity: EntityData;
    meshBase64?: string;  // base64-encoded .mesh binary
    animations?: Array<{ stateName: string; animName: string; animBase64: string }>;
    fileName: string;
}

// ── DOM Elements ─────────────────────────────────────────────────────────────

const toolbar = document.getElementById('toolbar')!;
const canvasContainer = document.getElementById('canvas-container')!;
const loadingOverlay = document.getElementById('loading-overlay')!;
const progressText = loadingOverlay.querySelector('.progress-text') as HTMLElement;
const progressBarFill = loadingOverlay.querySelector('.progress-bar-fill') as HTMLElement;
const infoPanel = document.getElementById('info-panel')!;
const entityTree = document.getElementById('entity-tree')!;
const errorBanner = document.getElementById('error-banner')!;
const emptyState = document.getElementById('empty-state')!;
const propsPanel = document.getElementById('properties-panel')!;
const propsName = document.getElementById('props-locator-name')!;
const transformHint = document.getElementById('transform-hint')!;

// Toolbar controls
const entityNameEl = toolbar.querySelector('.entity-name') as HTMLElement;
const wireframeToggle = document.getElementById('chk-wireframe') as HTMLInputElement;
const locatorToggle = document.getElementById('chk-locators') as HTMLInputElement;
const meshLocatorToggle = document.getElementById('chk-mesh-locators') as HTMLInputElement;
const normalToggle = document.getElementById('chk-normals') as HTMLInputElement;
const bonesToggle = document.getElementById('chk-bones') as HTMLInputElement;

// Property inputs
const propPx = document.getElementById('prop-px') as HTMLInputElement;
const propPy = document.getElementById('prop-py') as HTMLInputElement;
const propPz = document.getElementById('prop-pz') as HTMLInputElement;
const propRx = document.getElementById('prop-rx') as HTMLInputElement;
const propRy = document.getElementById('prop-ry') as HTMLInputElement;
const propRz = document.getElementById('prop-rz') as HTMLInputElement;
const propAttachEntity = document.getElementById('prop-attach-entity') as HTMLInputElement;
const propAutocompleteList = document.getElementById('prop-autocomplete-list')!;

// Context menu & add-locator panel
const contextMenu = document.getElementById('context-menu')!;
const addLocatorPanel = document.getElementById('add-locator-panel')!;
const addLocName = document.getElementById('add-loc-name') as HTMLInputElement;
const addLocEntity = document.getElementById('add-loc-entity') as HTMLInputElement;
const autocompleteList = document.getElementById('autocomplete-list')!;
const specialDuplicatePanel = document.getElementById('special-duplicate-panel')!;
const duplicateSourceName = document.getElementById('duplicate-source-name')!;
const duplicateCopies = document.getElementById('duplicate-copies') as HTMLInputElement;
const duplicateTx = document.getElementById('duplicate-tx') as HTMLInputElement;
const duplicateTy = document.getElementById('duplicate-ty') as HTMLInputElement;
const duplicateTz = document.getElementById('duplicate-tz') as HTMLInputElement;
const duplicateRx = document.getElementById('duplicate-rx') as HTMLInputElement;
const duplicateRy = document.getElementById('duplicate-ry') as HTMLInputElement;
const duplicateRz = document.getElementById('duplicate-rz') as HTMLInputElement;
const duplicateOrbit = document.getElementById('duplicate-orbit') as HTMLInputElement;
const duplicatePreview = document.getElementById('duplicate-preview')!;
const selectionMarquee = document.getElementById('selection-marquee')!;
const locatorSelectionActions = document.getElementById('locator-selection-actions')!;
const locatorSelectionCount = document.getElementById('locator-selection-count')!;
const hideSelectedLocatorsButton = document.getElementById('btn-hide-selected-locators') as HTMLButtonElement;
const deleteSelectedLocatorsButton = document.getElementById('btn-delete-selected-locators') as HTMLButtonElement;
const sidebarResize = document.getElementById('sidebar-resize')!;

// Cached entity names for autocomplete
let cachedEntityNames: string[] = [];
// Right-click 3D world position for "Add Locator" context menu
let contextMenuWorldPos: THREE.Vector3 | null = null;
// Timestamp guard to prevent context menu from being immediately dismissed
let contextMenuOpenTime = 0;

// ── Three.js Setup ───────────────────────────────────────────────────────────

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let transformCtrl: TransformControls;
let currentModel: THREE.Group | null = null;
let locatorHelpers: THREE.Group | null = null;
let animationFrameId = 0;
let selectedLocator: THREE.Object3D | null = null;
let selectedLocatorEditable = false;
const selectedLocators = new Set<THREE.Object3D>();
let lastHiddenLocators: THREE.Object3D[] = [];
let duplicateSourceLocator: THREE.Object3D | null = null;
let currentEntity: EntityData | null = null;
let lastParsedMeshFile: ParsedMeshFile | null = null;
let skeletonHelper: THREE.SkeletonHelper | null = null;
// Animation system
let mixer: THREE.AnimationMixer | null = null;
interface ChildMixerEntry {
    mixer: THREE.AnimationMixer;
    clips: Map<string, THREE.AnimationClip>; // stateName → clip
    getStateFromParent: boolean;
    currentAction: THREE.AnimationAction | null;
}
const childMixers: ChildMixerEntry[] = [];
const clock = new THREE.Clock();
const animationClips = new Map<string, THREE.AnimationClip>(); // stateName → clip
let currentAction: THREE.AnimationAction | null = null;
let isAnimPlaying = true;
let animLooping = true;
// Snapshot of selected locator's original position/rotation at selection time
let selectedLocatorSnapshot: { px: number; py: number; pz: number; rx: number; ry: number; rz: number } | null = null;
interface SmartDuplicateState {
    activeObject: THREE.Object3D;
    baseTransform: LocatorTransform;
    step?: LocatorTransformDelta;
    attachEntity?: string;
}
let smartDuplicateState: SmartDuplicateState | null = null;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
//Skeleton mounting synchronization list: not directly mounted to the skeleton scene graph to avoid SkinnedMesh double transformation
interface BoneAttachment {
    bone: THREE.Bone;
    group: THREE.Group;
    parentGroup: THREE.Group; //The actual mounted parent node
    entityScale: number;      // The original entity scale of the sub-model, which needs to be retained during synchronization
}
const boneAttachments: BoneAttachment[] = [];
// Pre-allocate vectors/quaternions/matrices to avoid GC pressure per frame
const _baDecompPos = new THREE.Vector3();
const _baDecompQuat = new THREE.Quaternion();
const _baDecompScale = new THREE.Vector3();
const _baParentInverse = new THREE.Matrix4();
const _baLocalPos = new THREE.Vector3();
const _baLocalQuat = new THREE.Quaternion();
const _baLocalScale = new THREE.Vector3();

function initThree() {
    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    canvasContainer.appendChild(renderer.domElement);

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color().setStyle(
        getComputedStyle(document.body).getPropertyValue('--ep-bg').trim() || '#1e1e1e'
    );

    // Camera
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    camera.position.set(5, 3, 8);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 5000;
    
    //Remap buttons: left button=rotation, middle button=translation. Right-click is completely disabled in favor of right-click menu creation locator.
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: -1 as any  // Use -1 to disable right-click (null may be ignored by some versions)
    };
    controls.enablePan = true;

    //Intercept right-click pointerdown before OrbitControls processing to prevent OrbitControls from swallowing the event
    renderer.domElement.addEventListener('pointerdown', (e) => {
        if (e.button === 2) {
            e.stopPropagation();  // Prevent OrbitControls from processing right clicks
        }
    }, true);  // use capture phase

    // Lighting — bright PBR setup for dark-textured models
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x556666, 0.6);
    hemiLight.position.set(0, 20, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xaabbdd, 0.45);
    fillLight.position.set(-3, -2, -5);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0x8899aa, 0.3);
    rimLight.position.set(0, -5, 3);
    scene.add(rimLight);

    // Grid helper (subtle)
    const grid = new THREE.GridHelper(20, 20, 0x333333, 0x222222);
    grid.material.opacity = 0.3;
    grid.material.transparent = true;
    scene.add(grid);

    // TransformControls (Maya-style: W=translate, E=rotate)
    // In Three.js r155+, TransformControls is NOT an Object3D;
    // we must add getHelper() to the scene for the gizmo to render.
    transformCtrl = new TransformControls(camera, renderer.domElement);
    transformCtrl.setMode('translate');
    // Fixed size — TransformControls auto-scales based on camera distance
    transformCtrl.setSize(0.7);
    transformCtrl.addEventListener('dragging-changed', (event) => {
        const isDragging = (event as unknown as { value: boolean }).value;
        controls.enabled = !isDragging;
        // Auto-save when gizmo drag finishes
        if (!isDragging && selectedLocator) {
            updateSmartDuplicateStepFromSelected();
            autoSaveLocator();
        }
    });
    transformCtrl.addEventListener('objectChange', () => {
        if (selectedLocator) updatePropsFromLocator(selectedLocator);
    });
    const transformHelper = transformCtrl.getHelper();
    scene.add(transformHelper);

    // Ctrl/Cmd + left drag performs marquee selection without changing the
    // established left-drag orbit camera behavior.
    let marqueePointerId: number | null = null;
    let marqueeStart = { x: 0, y: 0 };
    let marqueeAdditive = false;
    const updateMarquee = (clientX: number, clientY: number) => {
        const rect = renderer.domElement.getBoundingClientRect();
        const left = Math.min(marqueeStart.x, clientX) - rect.left;
        const top = Math.min(marqueeStart.y, clientY) - rect.top;
        selectionMarquee.style.left = `${left}px`;
        selectionMarquee.style.top = `${top}px`;
        selectionMarquee.style.width = `${Math.abs(clientX - marqueeStart.x)}px`;
        selectionMarquee.style.height = `${Math.abs(clientY - marqueeStart.y)}px`;
    };
    renderer.domElement.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (!e.ctrlKey && !e.metaKey) || !currentModel || !locatorToggle.checked) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        marqueePointerId = e.pointerId;
        marqueeStart = { x: e.clientX, y: e.clientY };
        marqueeAdditive = e.shiftKey;
        controls.enabled = false;
        renderer.domElement.setPointerCapture(e.pointerId);
        selectionMarquee.classList.add('visible');
        updateMarquee(e.clientX, e.clientY);
    }, true);
    renderer.domElement.addEventListener('pointermove', (e) => {
        if (marqueePointerId !== e.pointerId) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        updateMarquee(e.clientX, e.clientY);
    }, true);
    const finishMarquee = (e: PointerEvent, cancelled: boolean) => {
        if (marqueePointerId !== e.pointerId) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const start = marqueeStart;
        marqueePointerId = null;
        controls.enabled = true;
        selectionMarquee.classList.remove('visible');
        if (renderer.domElement.hasPointerCapture(e.pointerId)) {
            renderer.domElement.releasePointerCapture(e.pointerId);
        }
        if (!cancelled) selectLocatorsInScreenRect(start.x, start.y, e.clientX, e.clientY, marqueeAdditive);
    };
    renderer.domElement.addEventListener('pointerup', e => finishMarquee(e, false), true);
    renderer.domElement.addEventListener('pointercancel', e => finishMarquee(e, true), true);

    // Click handler for locator selection — use 'pointerup' with distance check
    // to avoid interfering with TransformControls drag events
    let pointerDownPos = { x: 0, y: 0 };
    renderer.domElement.addEventListener('pointerdown', (e) => {
        pointerDownPos = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener('pointerup', (e) => {
        // Only treat as "click" if the pointer didn't move (not a drag)
        const dx = e.clientX - pointerDownPos.x;
        const dy = e.clientY - pointerDownPos.y;
        if (dx * dx + dy * dy < 9) {
            onLocatorPointerDown(e);
        }
    });

    handleResize();
    animate();
}

/** Auto-save locator position/rotation to the .asset file after gizmo drag */
function autoSaveLocator() {
    if (!selectedLocator) return;
    const rotation = getLocatorRotationDegrees(selectedLocator);
    vscode.postMessage({
        command: 'updateLocator',
        locatorName: selectedLocator.name,
        position: [selectedLocator.position.x, selectedLocator.position.y, selectedLocator.position.z],
        rotation: toPdxScriptRotation(rotation),
        scale: 1,
    });
}

// Locator label DOM elements
const locatorLabelEls: Map<string, HTMLDivElement> = new Map();
let isWebviewVisible = true;

function animate() {
    if (!isWebviewVisible) return; // don't schedule frames when hidden
    animationFrameId = requestAnimationFrame(animate);
    controls.update();

    // Update animation mixers
    const delta = clock.getDelta();
    if (mixer && isAnimPlaying) {
        mixer.update(delta);
        updateTimelineUI();
    }
    // Always update child entity mixers
    for (const cm of childMixers) cm.mixer.update(delta);



    // Synchronize the position of the bone-mounted sub-model (to avoid SkinnedMesh double transformation)
    // The matrixWorld of the bone is the world space transformation, but the childGroup is the child node of parentGroup.
    // When setting position/quaternion, it must be converted to the local space of the parent node.
    // Otherwise, when Three.js calculates matrixWorld, it will superimpose the parent node transformation again, causing severe deformation.
    for (const ba of boneAttachments) {
        // Make sure the bone's matrixWorld is up to date after the animation mixer is updated
        ba.bone.updateWorldMatrix(true, false);
        // Calculate the local transformation of the bone relative to parentGroup
        _baParentInverse.copy(ba.parentGroup.matrixWorld).invert();
        _baParentInverse.multiply(ba.bone.matrixWorld);
        _baParentInverse.decompose(_baLocalPos, _baLocalQuat, _baLocalScale);
        ba.group.position.copy(_baLocalPos);
        ba.group.quaternion.copy(_baLocalQuat);
        // The skeleton passes uniform scale to the submodel and does not pass non-uniform scale.
        // Use the geometric mean of the 3-axis scaling as the uniform scaling factor
        const boneUniformScale = Math.cbrt(_baLocalScale.x * _baLocalScale.y * _baLocalScale.z);
        ba.group.scale.setScalar(boneUniformScale * ba.entityScale);
    }

    renderer.render(scene, camera);
    updateLocatorLabels();
}

// Pause render loop when webview is not visible to save resources
function handleVisibilityChange() {
    if (document.hidden) {
        isWebviewVisible = false;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = 0;
        }
    } else {
        isWebviewVisible = true;
        if (!animationFrameId && !isDisposed) {
            clock.getDelta(); // flush accumulated delta
            animate();
        }
    }
}
document.addEventListener('visibilitychange', handleVisibilityChange);

function handleResize() {
    const w = canvasContainer.clientWidth;
    const h = canvasContainer.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
}

// ── Locator Labels (2D overlay) ──────────────────────────────────────────────

// Pre-allocated vectors for projection (avoid per-frame GC pressure)
const _labelWorldPos = new THREE.Vector3();
const _labelProjected = new THREE.Vector3();

function clearLocatorLabels() {
    for (const el of locatorLabelEls.values()) el.remove();
    locatorLabelEls.clear();
}

function createLocatorLabel(name: string, source: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'locator-label';
    el.textContent = name;
    //Set the left border color based on the source type
    const borderColors: Record<string, string> = {
        mesh: '#4CAF50',      // Green — mesh embedded locator
        override: '#FFC107',  // yellow — script overrides locator
        script: '#2196F3',    // blue — script definition locator
        bone: '#4fc3f7',      // Cyan — bone points
    };
    el.style.borderLeft = `2px solid ${borderColors[source] ?? '#2196F3'}`;
    canvasContainer.appendChild(el);
    return el;
}

/** Get the associated tag DOM element based on the Three.js object id */
function getLabelForObject(obj: THREE.Object3D): HTMLDivElement | undefined {
    return locatorLabelEls.get(`${obj.id}`);
}

function updateLocatorLabels() {
    if (!currentModel) {
        for (const el of locatorLabelEls.values()) el.style.display = 'none';
        return;
    }

    //Hide all labels when both switches are off
    const showLocators = locatorToggle.checked;
    const showBones = bonesToggle.checked;
    if (!showLocators && !showBones) {
        for (const el of locatorLabelEls.values()) el.style.display = 'none';
        return;
    }

    const w = canvasContainer.clientWidth;
    const h = canvasContainer.clientHeight;
    if (w === 0 || h === 0) return;
    const halfW = w / 2;
    const halfH = h / 2;

    // Track the active tag key of this frame and clean up the invalid tags after the frame ends.
    const activeKeys = new Set<string>();

    // Handle single annotation points: create/update DOM tags and project to 2D
    const processPoint = (obj: THREE.Object3D, displayName: string, source: string) => {
        const key = `${obj.id}`;
        activeKeys.add(key);

        let el = locatorLabelEls.get(key);
        if (!el) {
            el = createLocatorLabel(displayName, source);
            locatorLabelEls.set(key, el);
            if (selectedLocators.has(obj)) {
                el.style.background = 'rgba(0, 127, 212, 0.75)';
                el.style.fontWeight = '600';
            }
        }

        obj.getWorldPosition(_labelWorldPos);
        _labelProjected.copy(_labelWorldPos).project(camera);

        if (_labelProjected.z > 1) {
            el.style.display = 'none';
            return;
        }

        const x = (_labelProjected.x * halfW) + halfW;
        const y = -(_labelProjected.y * halfH) + halfH;
        el.style.display = '';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    };

    // Only traverse the locators and bones of the root entity, skipping those of the child entities
    currentModel.traverse(obj => {
        // Skip objects inside child entities
        if (isInsideChildEntity(obj)) return;

        // Root entity locator — controlled by locatorToggle
        if (obj.userData?.isLocator && showLocators && isLocatorVisuallyVisible(obj)) {
            const src = (obj.userData as { source?: string }).source ?? 'mesh';
            processPoint(obj, obj.name, src);
        }
        // Root entity bone point — controlled by bonesToggle
        if (obj instanceof THREE.Bone && showBones) {
            processPoint(obj, obj.name, 'bone');
        }
    });

    // Clean up old tags that no longer exist (when switching models or switches)
    for (const [key, el] of locatorLabelEls) {
        if (!activeKeys.has(key)) {
            el.remove();
            locatorLabelEls.delete(key);
        }
    }
}

// ── Locator Selection & Properties ───────────────────────────────────────────

// Shared invisible sphere geometry for locator hit targets
const _locatorHitGeo = new THREE.SphereGeometry(0.25, 8, 6);
const _locatorHitMat = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Convert PDX script rotation (degrees) to a Three.js Euler.
 *
 * PDX/Clausewitz rotation format: { ry, rx, rz } (Yaw, Pitch, Roll)
 *   - First value  = rotation around Y axis (yaw)
 *   - Second value = rotation around X axis (pitch)
 *   - Third value  = rotation around Z axis (roll)
 *
 * modelGroup has a PI rotation around Y, which negates local X and Z axes.
 * Therefore X and Z rotations must be negated to preserve world-space orientation.
 * Y axis is unchanged by PI rotation, so Y rotation is applied as-is.
 */
function pdxScriptEuler(ryDeg: number, rxDeg: number, rzDeg: number): THREE.Euler {
    return new THREE.Euler(
        -rxDeg * Math.PI / 180,
         ryDeg * Math.PI / 180,
        -rzDeg * Math.PI / 180,
        'YXZ',
    );
}

/** Return the locator's logical X/Y/Z rotation in degrees. */
function getLocatorRotationDegrees(obj: THREE.Object3D): LocatorVector3 {
    const euler = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
    return [
        -euler.x * 180 / Math.PI,
         euler.y * 180 / Math.PI,
        -euler.z * 180 / Math.PI,
    ];
}

function setLocatorRotationDegrees(obj: THREE.Object3D, rotation: LocatorVector3) {
    obj.setRotationFromEuler(pdxScriptEuler(rotation[1], rotation[0], rotation[2]));
}

/** Convert logical X/Y/Z UI rotation to the PDX script's Y/X/Z storage order. */
function toPdxScriptRotation(rotation: LocatorVector3): LocatorVector3 {
    return [rotation[1], rotation[0], rotation[2]];
}

function getLocatorTransform(obj: THREE.Object3D): LocatorTransform {
    return {
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotation: getLocatorRotationDegrees(obj),
    };
}

function isInsideChildEntity(obj: THREE.Object3D): boolean {
    let parent = obj.parent;
    while (parent) {
        if (parent.name.startsWith('attach_')) return true;
        if (parent === currentModel) return false;
        parent = parent.parent;
    }
    return false;
}

function isLocatorObjectEditable(obj: THREE.Object3D): boolean {
    return obj.userData?.isLocator === true
        && !isInsideChildEntity(obj)
        && !(obj.parent instanceof THREE.Bone);
}

function isLocatorObjectDeletable(obj: THREE.Object3D): boolean {
    return isLocatorObjectEditable(obj) && obj.userData?.source === 'script';
}

function isLocatorVisuallyVisible(obj: THREE.Object3D): boolean {
    if (!locatorToggle.checked || obj.userData?.userHidden === true) return false;
    return obj.userData?.source !== 'mesh' || meshLocatorToggle.checked;
}

function updateLocatorVisualVisibility(obj: THREE.Object3D) {
    if (!obj.userData?.isLocator) return;
    const axes = obj.getObjectByName(`${obj.name}_axes`);
    if (axes) axes.visible = isLocatorVisuallyVisible(obj);
}

function refreshLocatorVisualVisibility() {
    currentModel?.traverse(updateLocatorVisualVisibility);
    updateLocatorLabels();
}

/** Create a locator Group: invisible hit sphere + AxesHelper visual */
function createLocatorGroup(name: string, size: number, source: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    group.userData = { source, isLocator: true };

    // Invisible sphere for raycasting (Mesh is much more reliable than LineSegments)
    const hitMesh = new THREE.Mesh(_locatorHitGeo, _locatorHitMat);
    hitMesh.name = `${name}_hit`;
    group.add(hitMesh);

    // Visible axes
    const axes = new THREE.AxesHelper(size);
    axes.name = `${name}_axes`;
    axes.visible = isLocatorVisuallyVisible(group);
    group.add(axes);

    return group;
}




/**
 * Apply PDX locator transform to a Three.js object.
 * Handles `tx` (full transform matrix) and `p`/`q` (position + quaternion).
 * PDX locator tx is 16 floats (4x4 column-major), bone tx is 12 floats (3x4 column-major).
 */
function applyLocatorTransform(obj: THREE.Object3D, loc: ParsedLocator) {
    if (loc.transform) {
        const tx = loc.transform;
        const m = new THREE.Matrix4();

        if (tx.length >= 16) {
            // 4x4 column-major (locator format): stride=4
            // Column 0: [0,1,2,3], Column 1: [4,5,6,7], Column 2: [8,9,10,11], Column 3: [12,13,14,15]
            // Three.js Matrix4.set() takes row-major arguments
            m.set(
                tx[0]!, tx[4]!, tx[8]!,  tx[12]!,  // row 0
                tx[1]!, tx[5]!, tx[9]!,  tx[13]!,  // row 1
                tx[2]!, tx[6]!, tx[10]!, tx[14]!,  // row 2
                tx[3]!, tx[7]!, tx[11]!, tx[15]!,  // row 3
            );
        } else if (tx.length >= 12) {
            // 3x4 column-major (bone format): stride=3
            // Column 0: [0,1,2], Column 1: [3,4,5], Column 2: [6,7,8], Column 3: [9,10,11]
            m.set(
                tx[0]!, tx[3]!, tx[6]!, tx[9]!,   // row 0
                tx[1]!, tx[4]!, tx[7]!, tx[10]!,   // row 1
                tx[2]!, tx[5]!, tx[8]!, tx[11]!,   // row 2
                0,      0,      0,      1,          // row 3
            );
        } else {
            // Fallback to p/q
            obj.position.set(loc.position[0], loc.position[1], loc.position[2]);
            const q = new THREE.Quaternion(loc.rotation[0], loc.rotation[1], loc.rotation[2], loc.rotation[3]);
            obj.setRotationFromQuaternion(q);
            return;
        }

        // Decompose into position, quaternion, scale
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        m.decompose(pos, quat, scl);

        obj.position.copy(pos);
        obj.quaternion.copy(quat);
    } else {
        obj.position.set(loc.position[0], loc.position[1], loc.position[2]);
        const q = new THREE.Quaternion(loc.rotation[0], loc.rotation[1], loc.rotation[2], loc.rotation[3]);
        obj.setRotationFromQuaternion(q);
    }
}

function onLocatorPointerDown(event: PointerEvent) {
    if (!locatorHelpers || !locatorHelpers.visible) return;
    if (event.button !== 0) return;

    // Check if click is on TransformControls gizmo (don't deselect)
    if (transformCtrl.dragging) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    // Raycast against locator hit meshes (recursive=true to find spheres inside Groups)
    const intersects = raycaster.intersectObjects(locatorHelpers.children, true);

    let target: THREE.Object3D | null = null;
    for (const intersection of intersects) {
        let candidate: THREE.Object3D | null = intersection.object;
        while (candidate && !candidate.userData?.isLocator) candidate = candidate.parent;
        if (candidate?.userData?.isLocator && isLocatorVisuallyVisible(candidate)) {
            target = candidate;
            break;
        }
    }
    if (target) {
        selectLocator(target, isLocatorObjectEditable(target));
    } else {
        deselectLocator();
    }
}

function setLocatorSelectedStyle(obj: THREE.Object3D, selected: boolean) {
    const label = getLabelForObject(obj);
    if (label) {
        label.style.background = selected ? 'rgba(0, 127, 212, 0.75)' : 'rgba(0, 0, 0, 0.65)';
        label.style.fontWeight = selected ? '600' : 'normal';
    }
}

function updateLocatorSelectionActions() {
    const selection = Array.from(selectedLocators);
    if (selection.length === 0 || selectedLocator) {
        locatorSelectionActions.classList.add('hidden');
        return;
    }
    locatorSelectionActions.classList.remove('hidden');
    locatorSelectionCount.textContent = isChinese ? `已选择 ${selection.length} 个` : `${selection.length} selected`;
    const allHidden = selection.every(obj => obj.userData?.userHidden === true);
    hideSelectedLocatorsButton.textContent = allHidden
        ? (isChinese ? '显示' : 'Show')
        : (isChinese ? '隐藏' : 'Hide');
    const deletableCount = selection.filter(isLocatorObjectDeletable).length;
    deleteSelectedLocatorsButton.disabled = deletableCount === 0;
    deleteSelectedLocatorsButton.textContent = isChinese ? `删除 (${deletableCount})` : `Delete (${deletableCount})`;
    deleteSelectedLocatorsButton.title = deletableCount < selection.length
        ? (isChinese ? '仅删除脚本中新建的定位器；Mesh 定位器只能隐藏' : 'Only script-created locators can be deleted; mesh locators can only be hidden')
        : '';
}

function clearLocatorSelectionStyles() {
    for (const obj of selectedLocators) setLocatorSelectedStyle(obj, false);
}

function selectLocator(obj: THREE.Object3D, editable = true, preserveSmartDuplicate = false) {
    clearLocatorSelectionStyles();
    selectedLocators.clear();
    selectedLocators.add(obj);
    if (!preserveSmartDuplicate) smartDuplicateState = null;

    selectedLocator = obj;
    // Determine if this locator is inside a submodel structure
    let ownerEntity = '';
    let p = obj.parent;
    while (p) {
        if (p.name.startsWith('attach_')) {
            ownerEntity = p.name.replace('attach_', '');
            break;
        }
        p = p.parent;
    }
    const isSubmodel = ownerEntity !== '';
    selectedLocatorEditable = editable && !isSubmodel && !(obj instanceof THREE.Bone) && !(obj.parent instanceof THREE.Bone);

    // Always show properties panel (attach editing is always allowed)
    updatePropsFromLocator(obj);
    propsPanel.classList.remove('hidden');
    propsName.textContent = obj instanceof THREE.Bone ? obj.name.replace(/^.*?__/, '') : obj.name;

    // Position/rotation inputs: enabled only for editable locators
    const posRotInputs = [propPx, propPy, propPz, propRx, propRy, propRz];
    for (const input of posRotInputs) {
        input.disabled = !editable;
        input.style.opacity = editable ? '1' : '0.5';
    }

    // Apply/Reset buttons: visible only for editable locators
    const applyBtn = document.getElementById('btn-apply');
    const resetBtn = document.getElementById('btn-reset');
    const duplicateBtn = document.getElementById('btn-special-duplicate');
    if (applyBtn) applyBtn.style.display = editable ? '' : 'none';
    if (resetBtn) resetBtn.style.display = editable ? '' : 'none';
    if (duplicateBtn) duplicateBtn.style.display = selectedLocatorEditable ? '' : 'none';

    // Attach entity input: enabled for all, including submodels (cross-file write supported)
    propAttachEntity.disabled = false;
    propAttachEntity.style.opacity = '1';
    propAttachEntity.placeholder = isSubmodel ? `Attach to ${ownerEntity}` : 'e.g. some_entity_name';

    if (selectedLocatorEditable) {
        transformCtrl.attach(obj);

        // Snapshot the original position/rotation for Reset
        const rotation = getLocatorRotationDegrees(obj);
        selectedLocatorSnapshot = {
            px: obj.position.x,
            py: obj.position.y,
            pz: obj.position.z,
            rx: rotation[0],
            ry: rotation[1],
            rz: rotation[2],
        };

        // Show hint
        const hintEntry = i18n['transformHint'];
        if (hintEntry) {
            transformHint.textContent = isChinese ? hintEntry.zh : hintEntry.en;
        }
        transformHint.classList.remove('hidden');
        transformHint.classList.add('visible');
    } else {
        // View-only position/rotation: detach transform controls
        transformCtrl.detach();
        selectedLocatorSnapshot = null;
        transformHint.classList.add('hidden');
        transformHint.classList.remove('visible');
    }

    locatorSelectionActions.classList.add('hidden');
    setLocatorSelectedStyle(obj, true);

    // Highlight in entity tree
    highlightTreeItem(obj.name);
}

function selectLocatorsFromMarquee(objects: THREE.Object3D[], additive: boolean) {
    if (!additive) {
        clearLocatorSelectionStyles();
        selectedLocators.clear();
    }
    for (const obj of objects) selectedLocators.add(obj);

    selectedLocator = null;
    selectedLocatorEditable = false;
    selectedLocatorSnapshot = null;
    smartDuplicateState = null;
    transformCtrl.detach();
    propsPanel.classList.add('hidden');
    hideSpecialDuplicatePanel(false);
    transformHint.classList.add('hidden');
    transformHint.classList.remove('visible');
    for (const obj of selectedLocators) setLocatorSelectedStyle(obj, true);
    highlightTreeItems(new Set(Array.from(selectedLocators, obj => obj.name)));
    updateLocatorSelectionActions();
}

function selectLocatorsInScreenRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    additive: boolean,
) {
    if (!currentModel) return;
    const canvasRect = renderer.domElement.getBoundingClientRect();
    const clickPadding = Math.abs(endX - startX) < 4 && Math.abs(endY - startY) < 4 ? 5 : 0;
    const left = Math.min(startX, endX) - clickPadding;
    const right = Math.max(startX, endX) + clickPadding;
    const top = Math.min(startY, endY) - clickPadding;
    const bottom = Math.max(startY, endY) + clickPadding;
    const worldPosition = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const matches: THREE.Object3D[] = [];

    currentModel.traverse(obj => {
        if (!isLocatorObjectEditable(obj) || !isLocatorVisuallyVisible(obj)) return;
        obj.getWorldPosition(worldPosition);
        projected.copy(worldPosition).project(camera);
        if (projected.z < -1 || projected.z > 1) return;
        const x = canvasRect.left + (projected.x + 1) * canvasRect.width / 2;
        const y = canvasRect.top + (1 - projected.y) * canvasRect.height / 2;
        if (x >= left && x <= right && y >= top && y <= bottom) matches.push(obj);
    });

    selectLocatorsFromMarquee(matches, additive);
}

function toggleSelectedLocatorVisibility() {
    const selection = Array.from(selectedLocators).filter(isLocatorObjectEditable);
    if (selection.length === 0) return;
    const shouldShow = selection.every(obj => obj.userData?.userHidden === true);
    if (!shouldShow) lastHiddenLocators = selection.slice();
    for (const obj of selection) {
        obj.userData.userHidden = !shouldShow;
        updateLocatorVisualVisibility(obj);
    }
    selectedLocator = null;
    selectedLocatorEditable = false;
    selectedLocatorSnapshot = null;
    smartDuplicateState = null;
    transformCtrl.detach();
    propsPanel.classList.add('hidden');
    transformHint.classList.add('hidden');
    refreshLocatorVisualVisibility();
    updateLocatorSelectionActions();
}

function restoreLastHiddenLocators() {
    const restorable = lastHiddenLocators.filter(obj => obj.parent && obj.userData?.isLocator);
    for (const obj of restorable) {
        obj.userData.userHidden = false;
        updateLocatorVisualVisibility(obj);
    }
    lastHiddenLocators = [];
    refreshLocatorVisualVisibility();
    if (restorable.length > 0) selectLocatorsFromMarquee(restorable, false);
}

function deleteSelectedLocatorObjects() {
    const deletable = Array.from(selectedLocators).filter(isLocatorObjectDeletable);
    if (deletable.length === 0) return;
    const names = deletable.map(obj => obj.name);
    vscode.postMessage({ command: 'deleteLocators', locatorNames: names });

    for (const obj of deletable) {
        removeAttachAtLocator(obj.name);
        const labelKey = `${obj.id}`;
        locatorLabelEls.get(labelKey)?.remove();
        locatorLabelEls.delete(labelKey);
        obj.parent?.remove(obj);
    }
    if (currentEntity) {
        const deletedNames = new Set(names);
        currentEntity.locators = currentEntity.locators?.filter(locator => !deletedNames.has(locator.name));
        currentEntity.attaches = currentEntity.attaches?.filter(attach => !deletedNames.has(attach.locatorName));
        currentEntity.attachData = currentEntity.attachData?.filter(attach => !deletedNames.has(attach.locatorName));
        updateEntityTree(currentEntity, lastParsedMeshFile ?? undefined);
    }
    lastHiddenLocators = lastHiddenLocators.filter(obj => !deletable.includes(obj));
    const remaining = Array.from(selectedLocators).filter(obj => !deletable.includes(obj));
    if (remaining.length > 0) {
        selectLocatorsFromMarquee(remaining, false);
    } else {
        deselectLocator();
    }
}

function deselectLocator() {
    clearLocatorSelectionStyles();
    selectedLocators.clear();
    selectedLocator = null;
    selectedLocatorEditable = false;
    selectedLocatorSnapshot = null;
    smartDuplicateState = null;
    transformCtrl.detach();
    propsPanel.classList.add('hidden');
    locatorSelectionActions.classList.add('hidden');
    hideSpecialDuplicatePanel(false);
    transformHint.classList.add('hidden');
    transformHint.classList.remove('visible');
    hidePropAutocomplete();
    highlightTreeItem(null);
}

function updatePropsFromLocator(obj: THREE.Object3D) {
    propPx.value = obj.position.x.toFixed(3);
    propPy.value = obj.position.y.toFixed(3);
    propPz.value = obj.position.z.toFixed(3);

    const rotation = getLocatorRotationDegrees(obj);
    propRx.value = rotation[0].toFixed(2);
    propRy.value = rotation[1].toFixed(2);
    propRz.value = rotation[2].toFixed(2);

    let ownerEntity = '';
    let p = obj.parent;
    while (p) {
        if (p.name.startsWith('attach_')) {
            ownerEntity = p.name.replace('attach_', '');
            break;
        }
        p = p.parent;
    }
    const isSubmodel = ownerEntity !== '';

    const rawName = obj instanceof THREE.Bone ? obj.name.replace(/^.*?__/, '') : obj.name;
    if (isSubmodel) {
        // Find attachEntry inside the submodel's AttachData structure
        let foundEntry: any = null;
        if (currentEntity && currentEntity.attachData) {
            const searchAttachData = (nodes: AttachData[]) => {
                for (const node of nodes) {
                    if (node.entityName === ownerEntity) {
                        if (node.attachData) {
                            foundEntry = node.attachData.find(a => a.locatorName === rawName);
                        }
                        if (foundEntry) return;
                    }
                    if (node.attachData) {
                        searchAttachData(node.attachData);
                    }
                }
            };
            searchAttachData(currentEntity.attachData);
        }
        propAttachEntity.value = foundEntry?.entityName ?? '';
    } else {
        // Populate attach entity from current entity data
        const attachEntry = currentEntity?.attaches?.find(a => a.locatorName === rawName);
        propAttachEntity.value = attachEntry?.entityName ?? '';
    }
    hidePropAutocomplete();
}

function applyPropsToLocator() {
    if (!selectedLocator) return;
    selectedLocator.position.set(
        parseFloat(propPx.value) || 0,
        parseFloat(propPy.value) || 0,
        parseFloat(propPz.value) || 0,
    );
    const rotation: LocatorVector3 = [
        parseFloat(propRx.value) || 0,
        parseFloat(propRy.value) || 0,
        parseFloat(propRz.value) || 0,
    ];
    setLocatorRotationDegrees(selectedLocator, rotation);
    updateSmartDuplicateStepFromSelected();

    // Send to extension for file write-back
    vscode.postMessage({
        command: 'updateLocator',
        locatorName: selectedLocator.name,
        position: [selectedLocator.position.x, selectedLocator.position.y, selectedLocator.position.z],
        rotation: toPdxScriptRotation(rotation),
        scale: 1,
    });
}

// ── Properties Panel: Attach Entity Editing ──────────────────────────────────

function hidePropAutocomplete() {
    propAutocompleteList.classList.remove('visible');
    propAutocompleteList.innerHTML = '';
}

function showPropAutocomplete(filter: string) {
    const query = filter.toLowerCase();
    const matches = cachedEntityNames.filter(n => n.toLowerCase().includes(query)).slice(0, 50);
    if (matches.length === 0) {
        hidePropAutocomplete();
        return;
    }
    propAutocompleteList.innerHTML = '';
    for (const name of matches) {
        const item = document.createElement('div');
        item.className = 'ac-item';
        item.tabIndex = 0;
        const idx = name.toLowerCase().indexOf(query);
        if (query && idx >= 0) {
            item.innerHTML = escapeHtml(name.substring(0, idx))
                + `<strong>${escapeHtml(name.substring(idx, idx + query.length))}</strong>`
                + escapeHtml(name.substring(idx + query.length));
        } else {
            item.textContent = name;
        }
        item.addEventListener('click', () => {
            propAttachEntity.value = name;
            hidePropAutocomplete();
            sendUpdateAttach();
        });
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                propAttachEntity.value = name;
                hidePropAutocomplete();
                sendUpdateAttach();
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); (item.nextElementSibling as HTMLElement)?.focus(); }
            if (e.key === 'ArrowUp') { e.preventDefault(); const prev = item.previousElementSibling as HTMLElement | null; if (prev) prev.focus(); else propAttachEntity.focus(); }
            if (e.key === 'Escape') { hidePropAutocomplete(); propAttachEntity.focus(); }
        });
        propAutocompleteList.appendChild(item);
    }
    propAutocompleteList.classList.add('visible');
}

function sendUpdateAttach() {
    if (!selectedLocator) return;
    
    // Determine the owner entity for cross-file writing
    let targetEntity = '';
    let p = selectedLocator.parent;
    while (p) {
        if (p.name.startsWith('attach_')) {
            targetEntity = p.name.replace('attach_', '');
            break;
        }
        p = p.parent;
    }

    const rawName = selectedLocator instanceof THREE.Bone ? selectedLocator.name.replace(/^.*?__/, '') : selectedLocator.name;
    vscode.postMessage({
        command: 'updateAttach',
        locatorName: rawName,
        entityName: propAttachEntity.value.trim(),
        targetEntity: targetEntity || undefined
    });
}

propAttachEntity.addEventListener('input', () => {
    if (cachedEntityNames.length === 0) {
        vscode.postMessage({ command: 'requestEntityNames' });
    }
    const val = propAttachEntity.value.trim();
    if (val.length === 0) {
        hidePropAutocomplete();
        return;
    }
    showPropAutocomplete(val);
});

propAttachEntity.addEventListener('focus', () => {
    if (cachedEntityNames.length === 0) {
        vscode.postMessage({ command: 'requestEntityNames' });
    }
    const val = propAttachEntity.value.trim();
    if (val.length > 0) showPropAutocomplete(val);
});

propAttachEntity.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !propAutocompleteList.classList.contains('visible')) {
        sendUpdateAttach();
    }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const first = propAutocompleteList.querySelector('.ac-item') as HTMLElement | null;
        first?.focus();
    }
    if (e.key === 'Escape') {
        hidePropAutocomplete();
    }
});

function highlightTreeItems(names: Set<string>) {
    const items = entityTree.querySelectorAll('.tree-item');
    items.forEach(item => {
        const el = item as HTMLElement;
        const label = el.querySelector('.tree-label')?.textContent ?? '';
        const locatorName = el.dataset.locator ?? label;
        el.classList.toggle('selected', el.classList.contains('tree-locator') && names.has(locatorName));
    });
}

function highlightTreeItem(name: string | null) {
    highlightTreeItems(name ? new Set([name]) : new Set());
}

interface SkeletonBuildResult {
    root: THREE.Bone;
    orderedBones: THREE.Bone[];
}

/** Build a THREE.Bone hierarchy from PDX parsed bone data. */
function buildSkeletonFromParsedBones(parsedBones: import('./pdxMeshParser').ParsedBone[]): SkeletonBuildResult | null {
    if (parsedBones.length === 0) return null;

    const bones: THREE.Bone[] = [];
    for (const pb of parsedBones) {
        const bone = new THREE.Bone();
        bone.name = pb.name;
        bones.push(bone);
    }

    for (let i = 0; i < parsedBones.length; i++) {
        const pb = parsedBones[i]!;
        if (pb.parentIndex >= 0 && pb.parentIndex < bones.length) {
            bones[pb.parentIndex]!.add(bones[i]!);
        }
    }

    function pdxToMatrix4(m: Float32Array): THREE.Matrix4 {
        const mat = new THREE.Matrix4();
        mat.elements[0]  = m[0]!; mat.elements[1]  = m[1]!; mat.elements[2]  = m[2]!; mat.elements[3]  = 0;
        mat.elements[4]  = m[3]!; mat.elements[5]  = m[4]!; mat.elements[6]  = m[5]!; mat.elements[7]  = 0;
        mat.elements[8]  = m[6]!; mat.elements[9]  = m[7]!; mat.elements[10] = m[8]!; mat.elements[11] = 0;
        mat.elements[12] = m[9]!; mat.elements[13] = m[10]!; mat.elements[14] = m[11]!; mat.elements[15] = 1;
        return mat;
    }

    const worldMatrices: THREE.Matrix4[] = [];
    for (let i = 0; i < parsedBones.length; i++) {
        const pb = parsedBones[i]!;
        const m = pb.inverseBindMatrix;
        if (!m || m.length < 12) { worldMatrices.push(new THREE.Matrix4()); continue; }
        const invBind = pdxToMatrix4(m);
        if (Math.abs(invBind.determinant()) < 1e-10) { worldMatrices.push(new THREE.Matrix4()); continue; }
        worldMatrices.push(invBind.clone().invert());
    }

    for (let i = 0; i < parsedBones.length; i++) {
        const pb = parsedBones[i]!;
        const worldMat = worldMatrices[i]!;
        let localMat: THREE.Matrix4;
        if (pb.parentIndex >= 0 && pb.parentIndex < parsedBones.length) {
            localMat = worldMatrices[pb.parentIndex]!.clone().invert().multiply(worldMat);
        } else {
            localMat = worldMat;
        }
        const pos = new THREE.Vector3(); const rot = new THREE.Quaternion(); const scl = new THREE.Vector3();
        localMat.decompose(pos, rot, scl);
        bones[i]!.position.copy(pos);
        bones[i]!.quaternion.copy(rot);
        if (scl.x > 0.001 && scl.y > 0.001 && scl.z > 0.001) bones[i]!.scale.copy(scl);
    }

    const rootIdx = parsedBones.findIndex(b => b.parentIndex < 0);
    const root = rootIdx >= 0 ? bones[rootIdx]! : bones[0]!;
    root.updateWorldMatrix(false, true);

    return { root, orderedBones: bones };
}

// ── Animation System ─────────────────────────────────────────────────────────

/**
 * Convert a ParsedAnimation into a Three.js AnimationClip.
 * Creates keyframe tracks that reference bone names in the scene graph.
 * boneNameMap: maps animation bone index → actual scene bone name
 */
function pdxAnimToClip(anim: ParsedAnimation, clipName: string, boneNameMap?: Map<number, string>): THREE.AnimationClip {
    const tracks: THREE.KeyframeTrack[] = [];
    const duration = (anim.sampleCount - 1) / anim.fps;

    for (let boneIdx = 0; boneIdx < anim.bones.length; boneIdx++) {
        const bone = anim.bones[boneIdx]!;
        // Use remapped name if available, otherwise original
        const targetName = boneNameMap?.get(boneIdx) ?? bone.name;

        const tCount = bone.translations ? Math.floor(bone.translations.length / 3) : 0;
        const qCount = bone.rotations ? Math.floor(bone.rotations.length / 4) : 0;
        const sCount = bone.scales ? bone.scales.length : 0;

        if (tCount === 0 && qCount === 0 && sCount === 0) continue;

        const makeTimes = (n: number) => {
            const times = new Float32Array(n);
            for (let i = 0; i < n; i++) times[i] = i / anim.fps;
            return times as unknown as number[];
        };

        // Translation track
        if (bone.translations && tCount > 0) {
            tracks.push(new THREE.VectorKeyframeTrack(
                `${targetName}.position`,
                makeTimes(tCount),
                bone.translations as unknown as number[],
            ));
        }

        // Rotation track (quaternion xyzw)
        if (bone.rotations && qCount > 0) {
            tracks.push(new THREE.QuaternionKeyframeTrack(
                `${targetName}.quaternion`,
                makeTimes(qCount),
                bone.rotations as unknown as number[],
            ));
        }

        // Scale track (uniform → expand to xyz)
        if (bone.scales && sCount > 0) {
            const scaleData = new Float32Array(sCount * 3);
            for (let i = 0; i < sCount; i++) {
                const s = bone.scales[i]!;
                scaleData[i * 3] = s;
                scaleData[i * 3 + 1] = s;
                scaleData[i * 3 + 2] = s;
            }
            tracks.push(new THREE.VectorKeyframeTrack(
                `${targetName}.scale`,
                makeTimes(sCount),
                scaleData as unknown as number[],
            ));
        }
    }

    const clip = new THREE.AnimationClip(clipName, duration > 0 ? duration : 1 / anim.fps, tracks);
    return clip;
}

/**
 * Initialize animations from decoded buffers.
 * Creates AnimationMixer on the modelGroup and parses all clips.
 * animData: Map of animName → { buffer, stateName }
 */
function initAnimations(animBuffers: Map<string, ArrayBuffer>) {
    if (!currentModel) return;

    // Clean up previous mixer
    if (mixer) {
        mixer.stopAllAction();
        mixer.uncacheRoot(currentModel);
        mixer = null;
    }
    animationClips.clear();
    currentAction = null;

    mixer = new THREE.AnimationMixer(currentModel);

    // Build bone name map from ROOT ENTITY skeleton only (not child entity bones).
    // Child bones are prefixed with their entity name to avoid name collisions
    // (e.g., both parent and child having a bone named "root"), which would cause
    // AnimationMixer to bind animation tracks to the wrong bone.
    const sceneBones: THREE.Bone[] = [];
    const rootSkelBone = currentModel.children.find(
        c => c.userData?.isSkeleton,
    );
    if (rootSkelBone) {
        rootSkelBone.traverse(obj => {
            if (obj instanceof THREE.Bone) sceneBones.push(obj);
        });
    }
    const boneNameMap = new Map<number, string>();
    for (let i = 0; i < sceneBones.length; i++) {
        boneNameMap.set(i, sceneBones[i]!.name);
    }


    for (const [animName, buffer] of animBuffers) {
        try {
            const parsed = parsePdxAnim(buffer);
            const clip = pdxAnimToClip(parsed, animName, boneNameMap);
            animationClips.set(animName, clip);
        } catch {
        }
    }


    // Auto-play the first available clip
    const firstClip = animationClips.values().next().value;
    if (firstClip) {
        switchAnimation(firstClip);
    }

    // Show timeline
    showTimeline(true);
}

/**
 * Switch to a different AnimationClip with crossfade.
 */
function switchAnimation(clip: THREE.AnimationClip) {
    if (!mixer) return;

    const newAction = mixer.clipAction(clip);
    newAction.setLoop(animLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    newAction.clampWhenFinished = !animLooping;

    if (currentAction && currentAction !== newAction) {
        // Crossfade from old to new
        newAction.reset();
        newAction.play();
        currentAction.crossFadeTo(newAction, 0.3, true);
    } else {
        newAction.reset();
        newAction.play();
    }

    currentAction = newAction;
    clock.start();
    isAnimPlaying = true;

    // Update play button
    const playBtn = document.getElementById('btn-anim-play');
    if (playBtn) playBtn.textContent = '⏸';
}

/**
 * Show/hide the animation timeline bar.
 */
function showTimeline(show: boolean) {
    const timeline = document.getElementById('timeline');
    if (timeline) timeline.style.display = show ? 'flex' : 'none';
}

/**
 * Update the timeline scrub bar and time display.
 */
function updateTimelineUI() {
    if (!currentAction) return;
    const scrub = document.getElementById('anim-scrub') as HTMLInputElement | null;
    const timeDisplay = document.getElementById('anim-time');
    if (!scrub || !timeDisplay) return;

    const time = currentAction.time;
    const duration = currentAction.getClip().duration;

    scrub.max = '1000';
    scrub.value = String(Math.round((time / duration) * 1000));

    const fmt = (t: number) => {
        const s = Math.floor(t);
        const ms = Math.floor((t - s) * 10);
        return `${s}.${ms}`;
    };
    timeDisplay.textContent = `${fmt(time)} / ${fmt(duration)}s`;
}


/**
 * DDS header parsing for webview-side texture loading.
 * Decompresses BC1 (DXT1) and BC3 (DXT5) in software to RGBA DataTexture
 * so that channel remapping (PDX RRxG normals, specular) always works.
 */
function loadDDSTexture(buffer: ArrayBuffer): THREE.DataTexture | THREE.CompressedTexture | null {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x20534444) return null; // 'DDS '

    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const pfFlags = view.getUint32(80, true);
    const fourCC = view.getUint32(84, true);

    // Check for FourCC formats
    if (pfFlags & 0x4) { // DDPF_FOURCC
        const dataOffset = 128;

        switch (fourCC) {
            case 0x31545844: { // 'DXT1' = BC1
                const blockSize = 8;
                const dataLength = Math.max(1, Math.floor((width + 3) / 4)) *
                    Math.max(1, Math.floor((height + 3) / 4)) * blockSize;
                const compData = new Uint8Array(buffer, dataOffset, dataLength);
                const rgba = decompressBC1(compData, width, height);
                return configureDataTexture(new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat));
            }
            case 0x35545844: { // 'DXT5' = BC3
                const blockSize = 16;
                const dataLength = Math.max(1, Math.floor((width + 3) / 4)) *
                    Math.max(1, Math.floor((height + 3) / 4)) * blockSize;
                const compData = new Uint8Array(buffer, dataOffset, dataLength);
                const rgba = decompressBC3(compData, width, height);
                return configureDataTexture(new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat));
            }
            case 0x33545844: { // 'DXT3' = BC2 — rare, keep as CompressedTexture
                const blockSize = 16;
                const dataLength = Math.max(1, Math.floor((width + 3) / 4)) *
                    Math.max(1, Math.floor((height + 3) / 4)) * blockSize;
                const data = new Uint8Array(buffer, dataOffset, dataLength);
                const tex = new THREE.CompressedTexture(
                    [{ data, width, height }] as unknown as ImageData[],
                    width, height,
                    THREE.RGBA_S3TC_DXT3_Format,
                );
                tex.needsUpdate = true;
                return tex;
            }
            default:
                return decodeDDSToRGBA(buffer, width, height);
        }
    }

    // Uncompressed RGBA
    return decodeDDSToRGBA(buffer, width, height);
}

/** Configure a DataTexture with proper filtering/wrapping for 3D rendering */
function configureDataTexture(tex: THREE.DataTexture): THREE.DataTexture {
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
}

function decodeDDSToRGBA(buffer: ArrayBuffer, width: number, height: number): THREE.DataTexture {
    const view = new DataView(buffer);
    const pfFlags = view.getUint32(80, true);
    const fourCC = view.getUint32(84, true);
    const rgbBitCount = view.getUint32(88, true);
    const rMask = view.getUint32(92, true);
    const aMask = view.getUint32(104, true);

    // DX10 extended header adds 20 bytes
    const dataOffset = (pfFlags & 0x4) && fourCC === 0x30315844 ? 148 : 128;
    const pixelCount = width * height;
    const bpp = rgbBitCount || 32;
    const bytesPerPixel = bpp / 8;
    const srcData = new Uint8Array(buffer, dataOffset, pixelCount * bytesPerPixel);
    const rgbaData = new Uint8Array(pixelCount * 4);

    if (bpp === 32) {
        // 32-bit: determine channel order from masks
        const isBGRA = (rMask === 0x00FF0000 || rMask === 0);
        for (let i = 0; i < pixelCount; i++) {
            const si = i * 4;
            if (isBGRA) {
                rgbaData[si] = srcData[si + 2]!;       // R ← B
                rgbaData[si + 1] = srcData[si + 1]!;   // G
                rgbaData[si + 2] = srcData[si]!;        // B ← R
            } else {
                rgbaData[si] = srcData[si]!;            // R
                rgbaData[si + 1] = srcData[si + 1]!;    // G
                rgbaData[si + 2] = srcData[si + 2]!;    // B
            }
            rgbaData[si + 3] = aMask ? srcData[si + 3]! : 255;
        }
    } else if (bpp === 24) {
        // 24-bit BGR (no alpha)
        for (let i = 0; i < pixelCount; i++) {
            const si = i * 3;
            rgbaData[i * 4] = srcData[si + 2]!;       // R ← B
            rgbaData[i * 4 + 1] = srcData[si + 1]!;   // G
            rgbaData[i * 4 + 2] = srcData[si]!;        // B ← R
            rgbaData[i * 4 + 3] = 255;                 // A = opaque
        }
    } else if (bpp === 16) {
        // 16-bit: likely RGB565
        for (let i = 0; i < pixelCount; i++) {
            const val = srcData[i * 2]! | (srcData[i * 2 + 1]! << 8);
            const c = rgb565(val);
            rgbaData[i * 4] = c[0];
            rgbaData[i * 4 + 1] = c[1];
            rgbaData[i * 4 + 2] = c[2];
            rgbaData[i * 4 + 3] = 255;
        }
    } else {
        // Fallback: fill grey
        console.warn(`[DDS] Unsupported uncompressed bpp: ${bpp}`);
        rgbaData.fill(128);
    }

    return configureDataTexture(new THREE.DataTexture(rgbaData, width, height, THREE.RGBAFormat));
}

// ── BC1/BC3 Software Decompression ──────────────────────────────────────────

/** Expand a 16-bit RGB565 color to [R, G, B] (0-255) */
function rgb565(c: number): [number, number, number] {
    return [
        ((c >> 11) & 0x1f) * 255 / 31 | 0,
        ((c >> 5) & 0x3f) * 255 / 63 | 0,
        (c & 0x1f) * 255 / 31 | 0,
    ];
}

/** Decompress BC1 (DXT1) compressed data → RGBA Uint8Array */
function decompressBC1(src: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const bw = Math.max(1, (width + 3) >> 2);
    const bh = Math.max(1, (height + 3) >> 2);

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const blockIdx = (by * bw + bx) * 8;
            const c0raw = src[blockIdx]! | (src[blockIdx + 1]! << 8);
            const c1raw = src[blockIdx + 2]! | (src[blockIdx + 3]! << 8);
            const c0 = rgb565(c0raw);
            const c1 = rgb565(c1raw);

            // Build 4-color palette
            const palette: [number, number, number, number][] = [
                [c0[0], c0[1], c0[2], 255],
                [c1[0], c1[1], c1[2], 255],
                [0, 0, 0, 255],
                [0, 0, 0, 255],
            ];

            if (c0raw > c1raw) {
                palette[2] = [(2 * c0[0] + c1[0] + 1) / 3 | 0, (2 * c0[1] + c1[1] + 1) / 3 | 0, (2 * c0[2] + c1[2] + 1) / 3 | 0, 255];
                palette[3] = [(c0[0] + 2 * c1[0] + 1) / 3 | 0, (c0[1] + 2 * c1[1] + 1) / 3 | 0, (c0[2] + 2 * c1[2] + 1) / 3 | 0, 255];
            } else {
                palette[2] = [(c0[0] + c1[0] + 1) / 2 | 0, (c0[1] + c1[1] + 1) / 2 | 0, (c0[2] + c1[2] + 1) / 2 | 0, 255];
                palette[3] = [0, 0, 0, 0]; // transparent
            }

            // 4 bytes of 2-bit indices
            const bits = src[blockIdx + 4]! | (src[blockIdx + 5]! << 8) |
                (src[blockIdx + 6]! << 16) | (src[blockIdx + 7]! << 24);

            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const idx = (py * 4 + px) * 2;
                    const ci = (bits >>> idx) & 3;
                    const p = palette[ci]!;
                    const oi = (y * width + x) * 4;
                    out[oi] = p[0]; out[oi + 1] = p[1]; out[oi + 2] = p[2]; out[oi + 3] = p[3];
                }
            }
        }
    }
    return out;
}

/** Decompress BC3 (DXT5) compressed data → RGBA Uint8Array */
function decompressBC3(src: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const bw = Math.max(1, (width + 3) >> 2);
    const bh = Math.max(1, (height + 3) >> 2);

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const blockIdx = (by * bw + bx) * 16;

            // -- Alpha block (8 bytes) --
            const a0 = src[blockIdx]!;
            const a1 = src[blockIdx + 1]!;

            // Build 8-value alpha palette
            const alphas = new Uint8Array(8);
            alphas[0] = a0;
            alphas[1] = a1;
            if (a0 > a1) {
                for (let i = 1; i <= 6; i++) {
                    alphas[1 + i] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
                }
            } else {
                for (let i = 1; i <= 4; i++) {
                    alphas[1 + i] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0;
                }
                alphas[6] = 0;
                alphas[7] = 255;
            }

            // 6 bytes of 3-bit alpha indices (48 bits for 16 pixels)
            // Read as a 48-bit value
            let alphaBits = 0n;
            for (let i = 0; i < 6; i++) {
                alphaBits |= BigInt(src[blockIdx + 2 + i]!) << BigInt(i * 8);
            }

            // -- Color block (8 bytes, same as BC1) --
            const colorOff = blockIdx + 8;
            const c0raw = src[colorOff]! | (src[colorOff + 1]! << 8);
            const c1raw = src[colorOff + 2]! | (src[colorOff + 3]! << 8);
            const c0 = rgb565(c0raw);
            const c1 = rgb565(c1raw);

            const palette: [number, number, number][] = [
                c0,
                c1,
                [(2 * c0[0] + c1[0] + 1) / 3 | 0, (2 * c0[1] + c1[1] + 1) / 3 | 0, (2 * c0[2] + c1[2] + 1) / 3 | 0],
                [(c0[0] + 2 * c1[0] + 1) / 3 | 0, (c0[1] + 2 * c1[1] + 1) / 3 | 0, (c0[2] + 2 * c1[2] + 1) / 3 | 0],
            ];

            const colorBits = src[colorOff + 4]! | (src[colorOff + 5]! << 8) |
                (src[colorOff + 6]! << 16) | (src[colorOff + 7]! << 24);

            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;

                    const pixelIdx = py * 4 + px;

                    // Color index (2 bits)
                    const ci = (colorBits >>> (pixelIdx * 2)) & 3;
                    const p = palette[ci]!;

                    // Alpha index (3 bits)
                    const ai = Number((alphaBits >> BigInt(pixelIdx * 3)) & 7n);

                    const oi = (y * width + x) * 4;
                    out[oi] = p[0]; out[oi + 1] = p[1]; out[oi + 2] = p[2];
                    out[oi + 3] = alphas[ai]!;
                }
            }
        }
    }
    return out;
}
//Texture cache: key = URI, value = { promise, lastUsed }
const textureCache = new Map<string, { promise: Promise<THREE.Texture | null>; lastUsed: number }>();
const TEXTURE_CACHE_MAX = 128;

async function fetchTexture(uri: string): Promise<THREE.Texture | null> {
    if (!uri) return null;
    const existing = textureCache.get(uri);
    if (existing) {
        existing.lastUsed = performance.now();
        const tex = await existing.promise;
        return tex ? tex.clone() : null;
    }
    const promise = fetchTextureRaw(uri);
    textureCache.set(uri, { promise, lastUsed: performance.now() });
    
    // LRU elimination
    if (textureCache.size > TEXTURE_CACHE_MAX) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [k, v] of textureCache) {
            if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
        }
        if (oldestKey) {
            void textureCache.get(oldestKey)?.promise.then(t => t?.dispose());
            textureCache.delete(oldestKey);
        }
    }
    
    const tex = await promise;
    return tex ? tex.clone() : null;
}

async function fetchTextureRaw(uri: string): Promise<THREE.Texture | null> {
    if (!uri) return null;
    try {
        // Check if it's a data URI (from extension-side DDS decode)
        if (uri.startsWith('data:')) {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    const tex = new THREE.Texture(img);
                    tex.needsUpdate = true;
                    resolve(tex);
                };
                img.onerror = () => resolve(null);
                img.src = uri;
            });
        }

        // Fetch binary DDS via webview resource URI
        if (uri.toLowerCase().includes('.dds')) {
            const resp = await fetch(uri);
            if (!resp.ok) return null;
            const buffer = await resp.arrayBuffer();
            return loadDDSTexture(buffer);
        }

        // Standard image (PNG/TGA already decoded by extension)
        return new Promise((resolve) => {
            const loader = new THREE.TextureLoader();
            loader.load(uri, resolve, undefined, () => resolve(null));
        });
    } catch {
        return null;
    }
}

// ── Shader Classification ────────────────────────────────────────────────────

/** Shader categories determine how we render each submesh */
type ShaderCategory = 'pbr' | 'additive' | 'invisible';

/**
 * Classify a PDX shader effect name into a render category.
 * - pbr: Standard opaque PBR (DiffuseMap + NormalMap + SpecularMap)
 * - additive: Additive/alpha blend effects → transparent in preview
 * - invisible: Shadow-only / invisible effects → transparent
 */
function classifyShader(shaderName: string): ShaderCategory {
    if (!shaderName) return 'pbr'; // default
    const s = shaderName.toLowerCase();

    // Invisible / shadow-only / collision shaders
    if (s.includes('invisible') || s.includes('shadow') || s === 'collision') return 'invisible';

    // Additive / alpha blend / flow additive / simple / hologram
    if (s.includes('additive') || s.includes('alphablend') ||
        s.includes('hologram') || s === 'pdxmeshsimple') return 'additive';

    // PBR shaders: PdxMeshStandard, PdxMeshShipFlow, PdxMeshStandardSkinned, etc.
    return 'pbr';
}

// ── PBR Material Creation ────────────────────────────────────────────────────

interface ResolvedTextures {
    diffuse?: string;
    normal?: string;
    specular?: string;
    shader: string;
    shaderCategory: ShaderCategory;
    definedCount: number;
}

/**
 * Resolve textures for a submesh at a given index.
 * Priority: GFX/entity meshsettings → mesh-embedded material → textureMap lookup
 */
function resolveSubmeshTextures(
    submeshIndex: number,
    submeshName: string,
    meshMaterial: { shader?: string; diffuse?: string; normal?: string; specular?: string },
    entity: EntityData,
    meshIndexInShape = 0,
): ResolvedTextures {
    // Match by shape name + mesh index within shape (meshsettings index = material slot within shape)
    const meshSettings = entity.resolvedMeshSettings ?? [];
    const namedSetting = meshSettings.find(s => s.name === submeshName && s.index === meshIndexInShape)
        ?? meshSettings.find(s => s.name === submeshName);
    const unnamedSettings = meshSettings.filter(s => s.name === '__unnamed');
    // A sole unnamed meshsettings block is the default for the whole mesh. If there are
    // multiple unnamed blocks, their intended targets are ambiguous, so do not guess.
    // Never let that default turn collision/shadow geometry into a visible PBR mesh.
    const canUseGlobalDefault = classifyShader(meshMaterial.shader ?? '') !== 'invisible';
    const globalDefaultSetting = unnamedSettings.length === 1 && canUseGlobalDefault
        ? unnamedSettings[0]
        : undefined;
    const ms = namedSetting ?? globalDefaultSetting;
    const textureMap = entity.textureMap ?? {};

    // Helper: resolve a mesh-embedded relative path via textureMap
    const resolve = (relPath?: string): string | undefined => {
        if (!relPath) return undefined;
        // Try exact
        if (textureMap[relPath]) return textureMap[relPath];
        // Normalize separators
        const norm = relPath.replace(/\\/g, '/');
        if (textureMap[norm]) return textureMap[norm];
        // Try bare filename (last component)
        const basename = norm.split('/').pop() ?? '';
        if (basename && textureMap[basename]) return textureMap[basename];
        // Case-insensitive
        const lower = norm.toLowerCase();
        const baseLower = basename.toLowerCase();
        for (const [k, v] of Object.entries(textureMap)) {
            if (k.toLowerCase() === lower || k.toLowerCase() === baseLower) return v;
        }
        return undefined;
    };

    // GFX meshsettings shader takes priority over binary mesh shader
    const shader = ms?.shader || meshMaterial.shader || 'PdxMeshStandard';
    const shaderCategory = classifyShader(shader);

    const hasDiffuse = !!(ms?.diffuse || meshMaterial.diffuse);
    const hasNormal = !!(ms?.normal || meshMaterial.normal);
    const hasSpecular = !!(ms?.specular || meshMaterial.specular);
    const definedCount = [hasDiffuse, hasNormal, hasSpecular].filter(Boolean).length;

    const result: ResolvedTextures = {
        diffuse: ms?.diffuse ?? resolve(meshMaterial.diffuse),
        normal: ms?.normal ?? resolve(meshMaterial.normal),
        specular: ms?.specular ?? resolve(meshMaterial.specular),
        shader,
        shaderCategory,
        definedCount,
    };

    console.log(`[Material] Submesh ${submeshIndex} "${submeshName}" shader="${shader}" cat=${shaderCategory} defined=${definedCount} ms=${ms ? `found(${ms.name})` : 'none'} resolved=(${result.diffuse ? '✓' : '✗'}, ${result.normal ? '✓' : '✗'}, ${result.specular ? '✓' : '✗'})`);

    return result;
}

/**
 * Create a placeholder material synchronously.
 */
function createPlaceholderMaterial(textures: ResolvedTextures): THREE.MeshStandardMaterial {
    if (textures.shaderCategory !== 'pbr' || textures.definedCount === 1) {
        return new THREE.MeshStandardMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
    }

    return new THREE.MeshStandardMaterial({
        color: 0x666666,
        metalness: 0.15,
        roughness: 0.65,
        side: THREE.DoubleSide,
    });
}

/**
 * Fetch textures asynchronously and upgrade the material.
 */
async function upgradeSubmeshMaterial(mesh: THREE.Mesh | THREE.SkinnedMesh, textures: ResolvedTextures) {
    if (textures.shaderCategory !== 'pbr' || textures.definedCount === 1) {
        return;
    }

    const hasAnyResolved = textures.diffuse || textures.normal || textures.specular;
    if (!hasAnyResolved) return;

    try {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x888888,
            metalness: textures.specular ? 1.0 : 0.15,
            roughness: textures.specular ? 1.0 : 0.65,
            side: THREE.DoubleSide,
            envMapIntensity: 0.4,
            emissive: 0x000000,
            emissiveIntensity: 0.0,
        });

        const [diffTex, normTex, specTex] = await Promise.all([
            fetchTexture(textures.diffuse ?? ''),
            fetchTexture(textures.normal ?? ''),
            fetchTexture(textures.specular ?? ''),
        ]);

        if (diffTex) {
            diffTex.colorSpace = THREE.SRGBColorSpace;
            mat.map = diffTex;
            mat.color.set(0xffffff);
        }

        if (normTex) {
            normTex.colorSpace = THREE.LinearSRGBColorSpace;
            mat.normalMap = normTex;
        }

        if (specTex) {
            specTex.colorSpace = THREE.LinearSRGBColorSpace;
            mat.roughnessMap = specTex;
            mat.metalnessMap = specTex;
            mat.roughness = 1.0;
            mat.metalness = 1.0;
        }

        mat.onBeforeCompile = (shader) => {
            const hasNormalAtCompile = !!mat.normalMap;
            const hasSpecAtCompile = !!mat.roughnessMap;

            // Inject PDX GLSL shader fragment (imported from pdxShaders.ts)
            shader.fragmentShader = pdxHelperFunctions + shader.fragmentShader;

            if (hasNormalAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <normal_fragment_maps>', pdxNormalFragmentMaps);
            }

            if (hasSpecAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <roughnessmap_fragment>', pdxRoughnessFragment);
            }

            if (hasSpecAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <metalnessmap_fragment>', pdxMetalnessFragment);
            }

            if (hasNormalAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <emissivemap_fragment>', pdxEmissiveFragment);
            }
        };

        mat.needsUpdate = true;
        
        if (mesh.material instanceof THREE.Material) {
            mesh.material.dispose();
        }
        mesh.material = mat;
    } catch (err) {
        console.error('[Material] Upgrade failed:', err);
    }
}

// ── Mesh → Three.js Geometry ─────────────────────────────────────────────────

function buildGeometry(subMesh: ParsedSubMesh): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();

    // Positions (vec3)
    geo.setAttribute('position', new THREE.BufferAttribute(subMesh.positions, 3));

    // Normals (vec3)
    if (subMesh.normals.length > 0) {
        geo.setAttribute('normal', new THREE.BufferAttribute(subMesh.normals, 3));
    }

    // Tangents (vec4)
    if (subMesh.tangents && subMesh.tangents.length > 0) {
        geo.setAttribute('tangent', new THREE.BufferAttribute(subMesh.tangents, 4));
    }

    // UVs — channel 0
    // PDX UVs use DirectX convention (V=0 at top), matching DDS top-down storage
    if (subMesh.uvs.length > 0 && subMesh.uvs[0]!.length > 0) {
        geo.setAttribute('uv', new THREE.BufferAttribute(subMesh.uvs[0]!, 2));
    }

    // Skinning attributes
    if (subMesh.skin) {
        const vertexCount = subMesh.positions.length / 3;

        const declared = subMesh.skin.boneCount || 4;
        const derived = vertexCount > 0
            ? Math.round(subMesh.skin.boneIndices.length / vertexCount)
            : declared;
        const stride = derived >= 1 && derived <= 8 ? derived : declared;
        const influences = Math.min(stride, 4);

        // First pass: find the majority bone index among valid vertices
        const boneCounts = new Map<number, number>();
        for (let v = 0; v < vertexCount; v++) {
            for (let b = 0; b < influences; b++) {
                const idx = subMesh.skin.boneIndices[v * stride + b] ?? -1;
                const wt = subMesh.skin.weights[v * stride + b] ?? 0;
                if (idx >= 0 && wt > 0.001) {
                    boneCounts.set(idx, (boneCounts.get(idx) || 0) + 1);
                }
            }
        }
        let defaultBone = 0;
        let maxCount = 0;
        for (const [boneIdx, count] of boneCounts) {
            if (count > maxCount) { maxCount = count; defaultBone = boneIdx; }
        }

        // Second pass: build skinIndex/skinWeight buffers
        const skinIndices = new Uint16Array(vertexCount * 4);
        const skinWeights = new Float32Array(vertexCount * 4);
        for (let v = 0; v < vertexCount; v++) {
            let weightSum = 0;
            for (let b = 0; b < influences; b++) {
                const rawIdx = subMesh.skin.boneIndices[v * stride + b] ?? -1;
                const rawWt = subMesh.skin.weights[v * stride + b] ?? 0;
                skinIndices[v * 4 + b] = rawIdx >= 0 ? rawIdx : 0;
                skinWeights[v * 4 + b] = rawIdx >= 0 ? rawWt : 0;
                weightSum += skinWeights[v * 4 + b]!;
            }
            // Unbound vertices: bind to the majority bone so they move
            // with the rest of the submesh instead of collapsing to origin.
            if (weightSum < 0.001) {
                skinIndices[v * 4] = defaultBone;
                skinWeights[v * 4] = 1.0;
            }
        }
        geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
        geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));
    }

    // Index buffer
    geo.setIndex(new THREE.BufferAttribute(subMesh.indices, 1));

    // Compute missing normals if needed
    if (!subMesh.normals || subMesh.normals.length === 0) {
        geo.computeVertexNormals();
    }

    return geo;
}

// ── Model Loading ────────────────────────────────────────────────────────────

let totalTriangles = 0;
let totalVertices = 0;

async function loadModel(entity: EntityData, meshBuffer: ArrayBuffer | undefined) {
    // Deselect and clear labels
    deselectLocator();
    lastHiddenLocators = [];
    clearLocatorLabels();

    // Clear previous model
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
                obj.geometry.dispose();
                if (obj.material instanceof THREE.Material) obj.material.dispose();
            }
        });
        currentModel = null;
    }
    if (locatorHelpers) {
        scene.remove(locatorHelpers);
        locatorHelpers = null;
    }
    if (skeletonHelper) {
        scene.remove(skeletonHelper);
        skeletonHelper = null;
    }
    // Clean up animations
    if (mixer) {
        mixer.stopAllAction();
        mixer = null;
    }
    for (const cm of childMixers) cm.mixer.stopAllAction();
    childMixers.length = 0;
    boneAttachments.length = 0;
    animationClips.clear();
    currentAction = null;
    showTimeline(false);

    currentEntity = entity;
    totalTriangles = 0;
    totalVertices = 0;

    if (!meshBuffer) {
        // No mesh data — this entity may only have attach directives (e.g., turret_entity).
        // Create an empty model group so attachments and entity tree still work.
        const modelGroup = new THREE.Group();
        modelGroup.name = entity.name;
        const scale = entity.scale ?? 1.0;
        modelGroup.scale.setScalar(scale);
        modelGroup.rotation.y = Math.PI;

        // Still set up locator helpers for script-defined locators
        locatorHelpers = new THREE.Group();
        locatorHelpers.name = 'locators';
        if (entity.locators) {
            for (const loc of entity.locators) {
                const group = createLocatorGroup(loc.name, 0.5, 'script');
                if (loc.position) group.position.set(loc.position[0], loc.position[1], loc.position[2]);
                if (loc.rotation) {
                    group.setRotationFromEuler(pdxScriptEuler(loc.rotation[0], loc.rotation[1], loc.rotation[2]));
                }
                locatorHelpers.add(group);
            }
        }
        modelGroup.add(locatorHelpers);
        scene.add(modelGroup);
        currentModel = modelGroup;

        // Load attach children if any
        if (entity.attachData && entity.attachData.length > 0) {
            await loadAttachChildren(entity.attachData, locatorHelpers, modelGroup, entity.defaultState);
        }

        fitCameraToModel(modelGroup);
        updateInfoPanel(entity);
        lastParsedMeshFile = null;
        updateEntityTree(entity);
        updateStateSelector(entity);
        showLoading(false);
        emptyState.style.display = 'none';
        return;
    }

    showLoading(true, 'Parsing mesh...');

    try {
        // Parse mesh (synchronous for now; use Worker for files >10MB)
        const parsed: ParsedMeshFile = parsePdxMesh(meshBuffer, (pct) => {
            setProgress(pct, `Parsing mesh... ${pct}%`);
        });

        showLoading(true, 'Building geometry...');

        const modelGroup = new THREE.Group();
        modelGroup.name = entity.name;

        // Apply entity scale
        const scale = entity.scale ?? 1.0;
        modelGroup.scale.setScalar(scale);

        // Maya Z+ forward → Three.js Z- forward: rotate 180° around Y
        modelGroup.rotation.y = Math.PI;

        // Build skeleton + GPU skinning
        let sharedBoneRoot: THREE.Bone | null = null;
        let sharedSkeleton: THREE.Skeleton | null = null;
        const firstSkelShape = parsed.shapes.find(s => s.skeleton.length > 0);
        if (firstSkelShape) {
            const skelResult = buildSkeletonFromParsedBones(firstSkelShape.skeleton);
            if (skelResult) {
                sharedBoneRoot = skelResult.root;
                sharedBoneRoot.userData.isSkeleton = true;
                modelGroup.add(sharedBoneRoot);
                // Let THREE.js compute boneInverses from bone positions
                sharedSkeleton = new THREE.Skeleton(skelResult.orderedBones);
            }
        }

        // Apply pdxmesh scale
        const meshScale = entity.meshScale ?? 1.0;

        // Find leaf bone index (deepest in first chain) for non-skinned meshes
        let leafBoneIndex = 0;
        if (sharedSkeleton) {
            let cur = sharedSkeleton.bones[0];
            while (cur) {
                let next: THREE.Bone | null = null;
                for (const c of cur.children) {
                    if (c instanceof THREE.Bone) { next = c; break; }
                }
                if (!next) break;
                cur = next;
            }
            if (cur) leafBoneIndex = Math.max(0, sharedSkeleton.bones.indexOf(cur));
        }

        const materialUpgradeTasks: Array<{ mesh: THREE.Mesh | THREE.SkinnedMesh, textures: ResolvedTextures }> = [];
        let rootSubmeshIndexCounter = 0;
        for (const shape of parsed.shapes) {
            let meshIndexInShape = 0;
            for (const subMesh of shape.meshes) {
                const submeshIndex = rootSubmeshIndexCounter++;
                const currentMeshIndexInShape = meshIndexInShape++;
                
                const geo = buildGeometry(subMesh);
                const meshMat = subMesh.material;
                const textures = resolveSubmeshTextures(submeshIndex, subMesh.name, {
                    shader: meshMat.shader,
                    diffuse: meshMat.diffuse,
                    normal: meshMat.normal,
                    specular: meshMat.specular,
                }, entity, currentMeshIndexInShape);

                const material = createPlaceholderMaterial(textures);
                let mesh: THREE.Mesh | THREE.SkinnedMesh;
                if (sharedSkeleton) {
                    // Non-skinned meshes: bind all verts to leaf bone
                    if (!subMesh.skin) {
                        const vc = subMesh.positions.length / 3;
                        const si = new Uint16Array(vc * 4);
                        const sw = new Float32Array(vc * 4);
                        for (let v = 0; v < vc; v++) {
                            si[v * 4] = leafBoneIndex;
                            sw[v * 4] = 1.0;
                        }
                        geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
                        geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
                    }
                    const skinned = new THREE.SkinnedMesh(geo, material);
                    skinned.bind(sharedSkeleton, new THREE.Matrix4());
                    mesh = skinned;
                } else {
                    mesh = new THREE.Mesh(geo, material);
                }
                mesh.name = `submesh_${submeshIndex}`;

                totalTriangles += (subMesh.indices.length / 3);
                totalVertices += (subMesh.positions.length / 3);

                modelGroup.add(mesh);
                materialUpgradeTasks.push({ mesh, textures });
            }
        }
        Promise.all(materialUpgradeTasks.map(t => upgradeSubmeshMaterial(t.mesh, t.textures))).catch(e => console.error(e));

        // Debug: root mesh bounding box
        const rootBBox = new THREE.Box3();
        modelGroup.traverse(obj => { if ((obj as THREE.Mesh).isMesh) { (obj as THREE.Mesh).geometry.computeBoundingBox(); rootBBox.expandByObject(obj); } });
        if (!rootBBox.isEmpty()) {
            // bounding box computed — no additional debug action needed
        }

        // ── Locator Visualization ────────────────────────────────────
        locatorHelpers = new THREE.Group();
        locatorHelpers.name = 'locators';

        // Track which locators come from mesh vs script
        const meshLocatorNames = new Set<string>();

        for (const loc of parsed.locators) {
            const group = createLocatorGroup(loc.name, 0.5, 'mesh');
            applyLocatorTransform(group, loc);
            // Mesh-embedded locators are in pre-meshScale space; scale position to entity space
            if (meshScale !== 1.0) {
                group.position.multiplyScalar(meshScale);
            }


            // If locator has a parent bone, attach it to that bone so it follows animation
            if (loc.parentBone && sharedBoneRoot) {
                const parentBone = modelGroup.getObjectByName(loc.parentBone);
                if (parentBone) {
                    parentBone.add(group);
                } else {
                    locatorHelpers.add(group);
                }
            } else {
                locatorHelpers.add(group);
            }
            meshLocatorNames.add(loc.name);
        }

        // Script-defined locators (override or new)
        if (entity.locators) {
            for (const loc of entity.locators) {
                const existing = locatorHelpers.getObjectByName(loc.name);
                if (existing && loc.position) {
                    existing.position.set(loc.position[0], loc.position[1], loc.position[2]);
                    if (loc.rotation) {
                        existing.setRotationFromEuler(pdxScriptEuler(loc.rotation[0], loc.rotation[1], loc.rotation[2]));
                    }
                    existing.userData = { source: 'override', isLocator: true };
                    updateLocatorVisualVisibility(existing);
                } else if (loc.position) {
                    const group = createLocatorGroup(loc.name, 0.4, 'script');
                    group.position.set(loc.position[0], loc.position[1], loc.position[2]);
                    if (loc.rotation) {
                        group.setRotationFromEuler(pdxScriptEuler(loc.rotation[0], loc.rotation[1], loc.rotation[2]));
                    }
                    locatorHelpers.add(group);

                }
            }
        }

        modelGroup.add(locatorHelpers);

        // ── Skeleton Visualization ───────────────────────────────────
        try {
            if (sharedBoneRoot) {
                modelGroup.updateMatrixWorld(true);
                skeletonHelper = new THREE.SkeletonHelper(modelGroup);
                skeletonHelper.visible = bonesToggle.checked;
                (skeletonHelper.material as THREE.LineBasicMaterial).color.setHex(0x4fc3f7);
                (skeletonHelper.material as THREE.LineBasicMaterial).linewidth = 1;
                (skeletonHelper.material as THREE.LineBasicMaterial).depthTest = false;
                skeletonHelper.renderOrder = 999;
                scene.add(skeletonHelper);
            }
        } catch {
            skeletonHelper = null;
        }

        scene.add(modelGroup);
        currentModel = modelGroup;

        // ── Recursive Attach Loading ─────────────────────────────────
        if (entity.attachData && entity.attachData.length > 0) {
            setProgress(80, 'Loading attachments...');
            await loadAttachChildren(entity.attachData, locatorHelpers, modelGroup, entity.defaultState);
        }

        // Fit camera to model (only mesh geometry, not bones/locators)
        fitCameraToModel(modelGroup);

        // Update UI
        updateInfoPanel(entity, parsed);
        lastParsedMeshFile = parsed;
        updateEntityTree(entity, parsed);
        updateStateSelector(entity);
        showLoading(false);
        emptyState.style.display = 'none';

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showError(`Failed to load mesh: ${msg}`);
        showLoading(false);
    }
}

/**
 * Recursively load and mount child entities at their locator positions.
 * @param parentStateName The active state name from the parent entity, used by children with getStateFromParent=true
 */
async function loadAttachChildren(
    children: AttachData[],
    parentLocators: THREE.Group,
    parentGroup: THREE.Group,
    parentStateName?: string,
) {
    await Promise.all(children.map(async (child) => {
        try {
            // Find the attach target:
            // 1. Direct children of parentLocators (locator helpers)
            // 2. Bone-parented locators (locators attached to bones in the skeleton)
            // 3. Bones themselves
            let locator: THREE.Object3D | undefined = parentLocators.children.find(c => c.name === child.locatorName);
            let attachType = 'locator';
            if (!locator) {
                // Search bone-parented locators and bones throughout the model
                parentGroup.traverse(obj => {
                    if (!locator && obj.name === child.locatorName && obj.userData?.isLocator) {
                        locator = obj;
                    }
                });
                if (locator) {
                    attachType = 'bone-locator';
                }
            }
            if (!locator) {
                //Search for bones: bone names may have entity prefixes (such as "entityName__root"),
                // So match both exact names and names ending in "__locatorName"
                parentGroup.traverse(obj => {
                    if (!locator && obj instanceof THREE.Bone) {
                        if (obj.name === child.locatorName || obj.name.endsWith(`__${child.locatorName}`)) {
                            locator = obj;
                        }
                    }
                });
                if (locator) {
                    attachType = 'bone';
                }
            }
            if (!locator) {
                console.warn(`[Attach] Target "${child.locatorName}" not found for "${child.entityName}" — attaching to parent root`);
                locator = parentGroup;
                attachType = 'fallback';
            }

            const childGroup = new THREE.Group();
            childGroup.name = `attach_${child.entityName}`;

            // Dedicated locator group to avoid name collisions with bones/meshes
            const childLocatorGroup = new THREE.Group();
            childLocatorGroup.name = 'locators';

            // Apply child entity scale
            const scale = child.scale ?? 1.0;
            childGroup.scale.setScalar(scale);


            if (child.meshBase64) {
                // Decode mesh buffer
                const binaryStr = atob(child.meshBase64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                const meshBuffer = bytes.buffer;

                const parsed = parsePdxMesh(meshBuffer);

                // Build child entity data for texture resolution
                const childEntityData: EntityData = {
                    name: child.entityName,
                    resolvedMeshSettings: child.resolvedMeshSettings,
                    textureMap: child.textureMap,
                };

                // Apply pdxmesh scale (from .gfx definition)
                const childMeshScale = child.meshScale ?? 1.0;
                // Build skeleton for child entity.
                // Prefix child bone names with entity name to avoid collisions
                // with parent bones (e.g., both having a bone named "root").
                // This prevents the parent's AnimationMixer from accidentally
                // binding its animation tracks to child bones.
                const childBonePrefix = `${child.entityName}__`;
                const firstChildSkelShape = parsed.shapes.find(s => s.skeleton.length > 0);
                if (firstChildSkelShape) {
                    const childSkelResult = buildSkeletonFromParsedBones(firstChildSkelShape.skeleton);
                    if (childSkelResult) {
                        // Prefix all child bone names to avoid name collisions
                        for (const bone of childSkelResult.orderedBones) {
                            bone.name = `${childBonePrefix}${bone.name}`;
                        }
                        childGroup.add(childSkelResult.root);
                    }
                }

                // Build geometry and materials for child
                const materialUpgradeTasks: Array<{ mesh: THREE.Mesh | THREE.SkinnedMesh, textures: ResolvedTextures }> = [];
                let submeshIndexCounter = 0;
                for (const shape of parsed.shapes) {
                    let meshIndexInShape = 0;
                    for (const subMesh of shape.meshes) {
                        const submeshIndex = submeshIndexCounter++;
                        const currentMeshIndexInShape = meshIndexInShape++;
                        
                        const geo = buildGeometry(subMesh);
                        const meshMat = subMesh.material;
                        const textures = resolveSubmeshTextures(submeshIndex, subMesh.name, {
                            shader: meshMat.shader,
                            diffuse: meshMat.diffuse,
                            normal: meshMat.normal,
                            specular: meshMat.specular,
                        }, childEntityData, currentMeshIndexInShape);

                        const material = createPlaceholderMaterial(textures);
                        // The attached sub-models are unified as rigid bodies (ordinary Mesh),
                        // SkinnedMesh is not passed through attach.
                        // The sub-model only follows the bone's position/rotation/scale value changes and is not affected by skinning.
                        const mesh = new THREE.Mesh(geo, material);
                        mesh.name = `${child.entityName}_submesh_${submeshIndex}`;

                        totalTriangles += (subMesh.indices.length / 3);
                        totalVertices += (subMesh.positions.length / 3);

                        childGroup.add(mesh);
                        materialUpgradeTasks.push({ mesh, textures });
                    }
                }
                Promise.all(materialUpgradeTasks.map(t => upgradeSubmeshMaterial(t.mesh, t.textures))).catch(e => console.error(e));

                // Add mesh-embedded locators — respect parentBone just like root entity.
                // Locators WITH parentBone attach to their specific bone (follow that bone's animation).
                // Locators WITHOUT parentBone stay in childLocatorGroup (independent of skeleton).
                const childBoneRoot = childGroup.children.find(c => c instanceof THREE.Bone) as THREE.Bone | undefined;
                for (const loc of parsed.locators) {
                    const group = createLocatorGroup(loc.name, 0.3, 'mesh');
                    applyLocatorTransform(group, loc);
                    // Scale mesh-embedded locator positions from mesh space to entity space
                    if (childMeshScale !== 1.0) {
                        group.position.multiplyScalar(childMeshScale);
                    }
                    // Mirror root entity logic: attach to specific parent bone if defined
                    // Use prefixed bone name since child bones were renamed
                    if (loc.parentBone && childBoneRoot) {
                        const prefixedBoneName = `${childBonePrefix}${loc.parentBone}`;
                        const parentBone = childGroup.getObjectByName(prefixedBoneName);
                        if (parentBone) {
                            parentBone.add(group);
                        } else {
                            childLocatorGroup.add(group);
                        }
                    } else {
                        childLocatorGroup.add(group);
                    }
                }
            }

            // Add script-defined locators (override existing mesh locators or add new ones)
            if (child.locators && child.locators.length > 0) {
                for (const loc of child.locators) {
                    const existing = childLocatorGroup.getObjectByName(loc.name);
                    if (existing) {
                        if (loc.position) existing.position.set(loc.position[0], loc.position[1], loc.position[2]);
                        if (loc.rotation) {
                            existing.setRotationFromEuler(pdxScriptEuler(loc.rotation[0], loc.rotation[1], loc.rotation[2]));
                        }
                        existing.userData = { source: 'override', isLocator: true };
                        updateLocatorVisualVisibility(existing);
                    } else {
                        const group = createLocatorGroup(loc.name, 0.3, 'script');
                        if (loc.position) group.position.set(loc.position[0], loc.position[1], loc.position[2]);
                        if (loc.rotation) {
                            group.setRotationFromEuler(pdxScriptEuler(loc.rotation[0], loc.rotation[1], loc.rotation[2]));
                        }
                        childLocatorGroup.add(group);
                    }
                }
            }

            // Attach childLocatorGroup to childGroup (NOT to leaf bone).
            // Bone-parented locators are already attached to their specific bones above.
            // This group only contains bone-independent locators.
            childGroup.add(childLocatorGroup);

            // Mount child at the locator position in parent's coordinate space
            if (attachType === 'bone' && locator instanceof THREE.Bone) {
                // Bone mounting: Do not directly add bones to the scene graph subtree.
                // Otherwise, the SkinnedMesh of the submodel will be severely deformed by the double transformation of the bone's matrixWorld.
                // Mount to parentGroup instead and manually synchronize the bone's world position/rotation in the animation loop.
                parentGroup.add(childGroup);
                boneAttachments.push({
                    bone: locator,
                    group: childGroup,
                    parentGroup: parentGroup,
                    entityScale: scale,  //Save the original entity scale of the submodel
                });
                //Synchronize the position immediately: convert the bone world transformation to the local space of parentGroup
                locator.updateWorldMatrix(true, false);
                parentGroup.updateWorldMatrix(true, false);
                _baParentInverse.copy(parentGroup.matrixWorld).invert();
                _baParentInverse.multiply(locator.matrixWorld);
                _baParentInverse.decompose(_baLocalPos, _baLocalQuat, _baLocalScale);
                childGroup.position.copy(_baLocalPos);
                childGroup.quaternion.copy(_baLocalQuat);
                // Bones pass uniform scale to submodels
                const boneUniformScale = Math.cbrt(_baLocalScale.x * _baLocalScale.y * _baLocalScale.z);
                childGroup.scale.setScalar(boneUniformScale * scale);
            } else {
                locator.add(childGroup);
            }


            // Initialize child entity animations
            let childActiveState: string | undefined;
            if (child.animations && child.animations.length > 0) {
                const childMixer = new THREE.AnimationMixer(childGroup);
                // Only collect THIS child entity's bones (already prefixed with childBonePrefix).
                // Avoid traversing into grandchild entities which have their own prefixed bones.
                const childBones: THREE.Bone[] = [];
                const childSkelBone = childGroup.children.find(c => c instanceof THREE.Bone);
                if (childSkelBone) {
                    childSkelBone.traverse(obj => {
                        if (obj instanceof THREE.Bone) childBones.push(obj);
                    });
                }
                // Build bone name map: animation bone index → prefixed scene bone name.
                // The animation file uses un-prefixed names, but scene bones are prefixed,
                // so we map by index order (same as the skeleton construction order).
                const childBoneNameMap = new Map<number, string>();
                for (let i = 0; i < childBones.length; i++) childBoneNameMap.set(i, childBones[i]!.name);

                const clipMap = new Map<string, THREE.AnimationClip>();
                for (const animEntry of child.animations) {
                    try {
                        const bin = atob(animEntry.animBase64);
                        const buf = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                        const clip = pdxAnimToClip(parsePdxAnim(buf.buffer), animEntry.animName, childBoneNameMap);
                        clipMap.set(animEntry.stateName, clip);
                    } catch {
                    }
                }

                // Determine which state to play:
                // getStateFromParent = true → use parent's state
                // getStateFromParent = false/undefined (default no) → use child's own defaultState
                const targetState = child.getStateFromParent === true
                    ? parentStateName
                    : child.defaultState;
                childActiveState = targetState;

                // If a specific target state is set, only play that state's clip.
                // Don't fall back to first clip — a state without animation means "stay static".
                // Only use the first clip as fallback when no target state is specified at all.
                const targetClip = targetState
                    ? clipMap.get(targetState)
                    : clipMap.values().next().value;
                let childCurrentAction: THREE.AnimationAction | null = null;
                if (targetClip) {
                    childCurrentAction = childMixer.clipAction(targetClip);
                    childCurrentAction.setLoop(THREE.LoopRepeat, Infinity);
                    childCurrentAction.play();
                }

                childMixers.push({
                    mixer: childMixer,
                    clips: clipMap,
                    getStateFromParent: child.getStateFromParent === true,
                    currentAction: childCurrentAction,
                });
                isAnimPlaying = true;
                clock.start();
            } else {
                // No animations — propagate state correctly:
                // getStateFromParent=yes → pass parent's state through
                // getStateFromParent=no/undefined → use own defaultState
                childActiveState = child.getStateFromParent === true
                    ? parentStateName
                    : child.defaultState;
            }

            // Recursively load grandchildren, propagating the active state
            if (child.attachData && child.attachData.length > 0) {
                await loadAttachChildren(child.attachData as AttachData[], childLocatorGroup, childGroup, childActiveState);
            }
        } catch (e) {
            console.warn(`[Attach] Failed to load "${child.entityName}":`, e);
        }
    }));
}

function fitCameraToModel(model: THREE.Object3D) {
    // Compute bounding box from mesh geometry only (exclude bones, locators, helpers)
    const box = new THREE.Box3();
    model.traverse(obj => {
        if (obj instanceof THREE.Mesh && obj.geometry) {
            obj.geometry.computeBoundingBox();
            if (obj.geometry.boundingBox) {
                const meshBox = obj.geometry.boundingBox.clone();
                meshBox.applyMatrix4(obj.matrixWorld);
                box.union(meshBox);
            }
        }
    });

    if (box.isEmpty()) {
        // Fallback: use full bounding box
        box.setFromObject(model);
    }

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    // Use FOV-based distance so the model fills ~80% of the viewport
    const fovRad = camera.fov * Math.PI / 180;
    const dist = (maxDim / 2) / Math.tan(fovRad / 2) * 1.1;

    camera.position.copy(center);
    camera.position.x += dist * 0.35;
    camera.position.y += dist * 0.2;
    camera.position.z += dist * 0.85;

    controls.target.copy(center);
    controls.update();
}

// ── UI Updates ───────────────────────────────────────────────────────────────

function showLoading(visible: boolean, text?: string) {
    loadingOverlay.classList.toggle('hidden', !visible);
    if (text) progressText.textContent = text;
}

function setProgress(percent: number, text?: string) {
    progressBarFill.style.width = `${percent}%`;
    if (text) progressText.textContent = text;
}

function showError(msg: string) {
    errorBanner.textContent = `⚠ ${msg}`;
    errorBanner.classList.add('visible');
    setTimeout(() => errorBanner.classList.remove('visible'), 8000);
}

/** Capture current viewport as PNG and send to extension for saving */
function takeScreenshot() {
    if (!renderer) return;
    // Force a render so the buffer is fresh
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    // Strip the data:image/png;base64, prefix
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    vscode.postMessage({ command: 'screenshot', data: base64 });
}

function updateInfoPanel(entity: EntityData, parsed?: ParsedMeshFile) {
    const locCount = (parsed?.locators.length ?? 0) + (entity.locators?.length ?? 0);
    const boneCount = parsed?.shapes.reduce((sum, s) => sum + s.skeleton.length, 0) ?? 0;
    infoPanel.innerHTML = `
        <div class="info-group"><span class="info-label">Mesh:</span><span class="info-value">${entity.pdxmesh ?? '-'}</span></div>
        <div class="info-group"><span class="info-label">Triangles:</span><span class="info-value">${totalTriangles.toLocaleString()}</span></div>
        <div class="info-group"><span class="info-label">Vertices:</span><span class="info-value">${totalVertices.toLocaleString()}</span></div>
        <div class="info-group"><span class="info-label">Shapes:</span><span class="info-badge">${parsed?.shapes.length ?? 0}</span></div>
        <div class="info-group"><span class="info-label">Locators:</span><span class="info-badge">${locCount}</span></div>
        ${boneCount > 0 ? `<div class="info-group"><span class="info-label">Bones:</span><span class="info-badge">${boneCount}</span></div>` : ''}
        ${entity.scale ? `<div class="info-group"><span class="info-label">Scale:</span><span class="info-value">${entity.scale}</span></div>` : ''}
    `;
}

/**
 * Remove any attached entity model at the given locator.
 * Searches for Three.js groups named `attach_{entityName}` that are children of the locator.
 */
function removeAttachAtLocator(locatorName: string) {
    if (!currentModel) return;
    // The attach child is parented to the locator (or a bone with that name)
    const targets: THREE.Object3D[] = [];
    currentModel.traverse(obj => {
        if (obj.name === locatorName || (obj instanceof THREE.Bone && obj.name.endsWith(`__${locatorName}`))) {
            targets.push(obj);
        }
    });
    if (locatorHelpers) {
        locatorHelpers.traverse(obj => {
            if (obj.name === locatorName) targets.push(obj);
        });
    }
    for (const target of targets) {
        const toRemove: THREE.Object3D[] = [];
        for (const child of target.children) {
            if (child.name.startsWith('attach_')) {
                toRemove.push(child);
            }
        }
        for (const obj of toRemove) {
            obj.traverse(node => {
                if (node instanceof THREE.Mesh) {
                    node.geometry?.dispose();
                    if (Array.isArray(node.material)) {
                        node.material.forEach(m => m.dispose());
                    } else {
                        node.material?.dispose();
                    }
                }
            });
            target.remove(obj);
        }
    }
    // Also clear the corresponding entries in boneAttachments
    for (let i = boneAttachments.length - 1; i >= 0; i--) {
        const ba = boneAttachments[i]!;
        const boneName = ba.bone.name.replace(/^.*?__/, '');
        if (boneName === locatorName || ba.bone.name === locatorName) {
            //Clean and remove from scene
            ba.group.traverse(node => {
                if (node instanceof THREE.Mesh) {
                    node.geometry?.dispose();
                    if (Array.isArray(node.material)) {
                        node.material.forEach(m => m.dispose());
                    } else {
                        node.material?.dispose();
                    }
                }
            });
            ba.parentGroup.remove(ba.group);
            boneAttachments.splice(i, 1);
        }
    }
}

/**
 * Rebuild the entity tree sidebar using cached entity + mesh data.
 */
function buildEntityTree() {
    if (currentEntity) {
        updateEntityTree(currentEntity, lastParsedMeshFile ?? undefined);
    }
}

function updateEntityTree(_entity: EntityData, _parsed?: ParsedMeshFile) {
    // SVG icons (imported from svgIcons.ts)
    const svgIconEntity = Icons.entity;
    const svgIconBone = Icons.bone;
    const svgIconLocator = Icons.locator;
    const svgIconCollapse = Icons.collapseAll;
    const svgIconAdd = Icons.addItem;

    //Save the current expanded state (according to the data-parent attribute key value), collapsed by default
    const expandedSet = new Set<string>();
    let hasPreviousState = false;
    entityTree.querySelectorAll<HTMLElement>('.tree-children').forEach(el => {
        hasPreviousState = true;
        const key = el.dataset.parent;
        if (key && !el.classList.contains('collapsed')) expandedSet.add(key);
    });
    //Save filter activation status
    const boneFilterActive = entityTree.classList.contains('filter-bone');
    const locFilterActive = entityTree.classList.contains('filter-locator');

    let html = `<div class="tree-title" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-bottom: 4px;">
        <span>Entity Tree</span>
        <div style="display:flex; gap: 4px;">
            <button id="filter-bone" class="toolbar-icon-btn filter-btn${boneFilterActive ? ' active' : ''}" title="${isChinese ? '高亮骨骼' : 'Filter Bones'}" style="width: 24px; height: 24px;">${svgIconBone}</button>
            <button id="filter-locator" class="toolbar-icon-btn filter-btn${locFilterActive ? ' active' : ''}" title="${isChinese ? '高亮定位器' : 'Filter Locators'}" style="width: 24px; height: 24px;">${svgIconLocator}</button>
            <button id="btn-collapse-all" class="toolbar-icon-btn" title="${isChinese ? '全部折叠' : 'Collapse All'}" style="width: 24px; height: 24px;">${svgIconCollapse}</button>
            <button id="btn-add-locator" class="toolbar-icon-btn" title="${isChinese ? '新建全局定位器' : 'Add Root Locator'}" style="width: 24px; height: 24px;">${svgIconAdd}</button>
        </div>
    </div>`;

    const treeObjects = new Map<string, THREE.Object3D>();
    // Mark the subgroup of bone mounting to avoid repeated occurrence in the main traversal
    const boneAttachedGroups = new Set<THREE.Object3D>();
    for (const ba of boneAttachments) {
        boneAttachedGroups.add(ba.group);
    }

    function buildTreeHtml(obj: THREE.Object3D, depth: number): string {
        let nodeHtml = '';
        const pad = 12 + depth * 16;
        
        let isNode = false;
        let nodeClass = '';
        let icon = '';
        let label = obj.name;
        let sublabel = '';
        let dataset = '';
        
        if (obj === currentModel) {
            isNode = true;
            nodeClass = 'tree-entity';
            icon = svgIconEntity;
            label = currentEntity?.name || 'Root Model';
            dataset = `data-entity-name="${label}"`;
        } else if (obj.name.startsWith('attach_')) {
            isNode = true;
            nodeClass = 'tree-entity tree-attach';
            icon = svgIconEntity;
            label = obj.name.replace('attach_', '');
            dataset = `data-entity-name="${label}"`;
        } else if (obj instanceof THREE.Bone) {
            isNode = true;
            nodeClass = 'tree-bone';
            icon = svgIconBone;
            label = label.replace(/^.*?__/, ''); // Clear collision prefix for display
            treeObjects.set(obj.uuid, obj);
            dataset = `data-object-uuid="${obj.uuid}"`;
        } else if ((obj.userData as any).isLocator) {
            isNode = true;
            nodeClass = 'tree-locator';
            icon = svgIconLocator;
            const src = (obj.userData as any).source || 'script';
            sublabel = src;
            treeObjects.set(obj.uuid, obj);
            dataset = `data-object-uuid="${obj.uuid}"`;
        }
        
        let childrenHtml = '';
        for (const child of obj.children) {
            if (child.name.endsWith('_axes') || child.name.endsWith('_hit')) continue;
            // Skip the subgroups of bone mounts (they will be added virtually under the bone node)
            if (boneAttachedGroups.has(child)) continue;
            childrenHtml += buildTreeHtml(child, isNode ? depth + 1 : depth);
        }
        // The submodel mounted by the bone is not a direct child node of the bone in the scene graph.
        // But it should be displayed under the bone in the outline
        if (obj instanceof THREE.Bone) {
            for (const ba of boneAttachments) {
                if (ba.bone === obj) {
                    childrenHtml += buildTreeHtml(ba.group, isNode ? depth + 1 : depth);
                }
            }
        }
        
        if (isNode) {
            //Restore the previously saved expansion state (only expand the root node when loading for the first time)
            const isExpanded = hasPreviousState ? expandedSet.has(label) : (obj === currentModel);
            const isCollapsed = !isExpanded;
            const toggleCls = childrenHtml ? 'tree-toggle' : 'tree-toggle-placeholder';
            const toggleIcon = childrenHtml ? (isCollapsed ? '▶' : '▼') : '';
            nodeHtml += `<div class="tree-item ${nodeClass}" ${dataset} style="padding-left:${pad}px; display:flex; align-items:center;">`;
            nodeHtml += `<span class="${toggleCls}" style="width:16px;text-align:center;">${toggleIcon}</span>`;
            nodeHtml += `<span class="tree-icon" style="margin-right:4px; display:flex;">${icon}</span>`;
            nodeHtml += `<span class="tree-label">${label}</span>`;
            if (sublabel) nodeHtml += `<span class="tree-sublabel" style="margin-left:8px;opacity:0.6;font-size:0.9em;">${sublabel}</span>`;
            nodeHtml += `</div>`;
            if (childrenHtml) {
                nodeHtml += `<div class="tree-children${isCollapsed ? ' collapsed' : ''}" data-parent="${label}">`;
                nodeHtml += childrenHtml;
                nodeHtml += `</div>`;
            }
        } else {
            nodeHtml += childrenHtml;
        }
        return nodeHtml;
    }

    if (currentModel) {
        html += buildTreeHtml(currentModel, 0);
    } else {
        html += `<div class="empty-text">No model loaded</div>`;
    }

    entityTree.innerHTML = html;

    //Restore filter activation state
    entityTree.classList.toggle('filter-bone', boneFilterActive);
    entityTree.classList.toggle('filter-locator', locFilterActive);

    // ── Click handlers ──
    document.getElementById('filter-bone')?.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLElement;
        btn.classList.toggle('active');
        entityTree.classList.toggle('filter-bone', btn.classList.contains('active'));
    });
    
    document.getElementById('filter-locator')?.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLElement;
        btn.classList.toggle('active');
        entityTree.classList.toggle('filter-locator', btn.classList.contains('active'));
    });

    document.getElementById('btn-collapse-all')?.addEventListener('click', (e) => {
        e.stopPropagation();
        entityTree.querySelectorAll('.tree-children').forEach(el => el.classList.add('collapsed'));
        entityTree.querySelectorAll('.tree-toggle').forEach(el => {
            if (el.textContent === '▼') el.textContent = '▶';
        });
    });

    document.getElementById('btn-add-locator')?.addEventListener('click', (e) => {
        e.stopPropagation();
        contextMenuWorldPos = controls.target.clone();
        showAddLocatorPanel();
    });

    entityTree.querySelectorAll<HTMLElement>('[data-object-uuid]').forEach(el => {
        el.addEventListener('click', () => {
            const uuid = el.dataset.objectUuid!;
            const obj = treeObjects.get(uuid);
            if (obj) {
                if (obj.userData?.isLocator && !isLocatorVisuallyVisible(obj)) return;
                // Determine whether the object belongs to a sub-entity (inside the attach model)
                let isInsideChild = false;
                let p = obj.parent;
                while (p) {
                    if (p.name.startsWith('attach_')) { isInsideChild = true; break; }
                    if (p === currentModel) break;
                    p = p.parent;
                }
                
                // The points and bones of the submodel cannot be selected and edited.
                if (isInsideChild) {
                    return;
                }

                const isBoneParented = obj.parent instanceof THREE.Bone;
                const isEditable = !isBoneParented && !(obj instanceof THREE.Bone);
                selectLocator(obj, isEditable);
            }
        });
    });

    entityTree.querySelectorAll<HTMLElement>('[data-entity-name]').forEach(el => {
        el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).classList.contains('tree-toggle')) return;
            const name = el.dataset.entityName!;
            focusOnEntityByName(name);
        });
    });

    entityTree.querySelectorAll<HTMLElement>('.tree-toggle').forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const parent = toggle.closest('.tree-item, .tree-title') as HTMLElement | null;
            if (!parent) return;
            const nextSibling = parent.nextElementSibling as HTMLElement | null;
            if (nextSibling && nextSibling.classList.contains('tree-children')) {
                const isCollapsed = nextSibling.classList.toggle('collapsed');
                toggle.textContent = isCollapsed ? '▶' : '▼';
            }
        });
    });
}


/** Focus camera on a named entity group in the scene */
function focusOnEntityByName(name: string) {
    if (!currentModel) return;
    // Search the model hierarchy for a group matching the entity name
    let target: THREE.Object3D | null = null;
    currentModel.traverse(obj => {
        if (obj.name === name || obj.name === `entity_${name}`) {
            target = obj;
        }
    });
    // If not found by entity name, try the root model
    if (!target) target = currentModel;
    focusOnObject(target);
}

/** Focus camera on any Object3D */
function focusOnObject(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) {
        // For locators/empty groups, use position directly
        controls.target.copy(obj.getWorldPosition(new THREE.Vector3()));
        controls.update();
        return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fovRad = camera.fov * Math.PI / 180;
    const dist = Math.max((maxDim / 2) / Math.tan(fovRad / 2) * 1.1, 0.5);

    camera.position.copy(center);
    camera.position.x += dist * 0.35;
    camera.position.y += dist * 0.2;
    camera.position.z += dist * 0.85;

    controls.target.copy(center);
    controls.update();
}

/**
 * Build a map of unique state names → list of animation names for that state.
 * Stellaris entities can have multiple state definitions with the same name
 * but different animations (used for random selection via chance weights).
 */
function buildStateAnimMap(entity: EntityData): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!entity.states) return map;
    for (const s of entity.states) {
        if (!s.animation) continue;
        let arr = map.get(s.name);
        if (!arr) { arr = []; map.set(s.name, arr); }
        if (!arr.includes(s.animation)) arr.push(s.animation);
    }
    return map;
}

let currentStateAnimMap = new Map<string, string[]>();

function updateStateSelector(entity: EntityData) {
    const sel = document.getElementById('sel-state') as HTMLSelectElement;
    sel.innerHTML = '';
    currentStateAnimMap = buildStateAnimMap(entity);
    if (currentStateAnimMap.size > 0) {
        for (const [stateName] of currentStateAnimMap) {
            const opt = document.createElement('option');
            opt.value = stateName;
            opt.textContent = stateName;
            sel.appendChild(opt);
        }
        sel.style.display = 'inline-block';
        // Initialize secondary animation selector for the default/first state
        updateAnimVariantSelector(sel.value);
    } else {
        sel.style.display = 'none';
        const animSel = document.getElementById('sel-anim-variant') as HTMLSelectElement | null;
        if (animSel) animSel.style.display = 'none';
    }
}

/**
 * Update the secondary animation variant selector for a given state name.
 * Shows all animation variants available for this state.
 */
function updateAnimVariantSelector(stateName: string) {
    let animSel = document.getElementById('sel-anim-variant') as HTMLSelectElement | null;
    const anims = currentStateAnimMap.get(stateName);
    if (!anims || anims.length <= 1) {
        // Single or no animation — hide variant selector
        if (animSel) animSel.style.display = 'none';
        return;
    }
    // Create the selector if it doesn't exist yet
    if (!animSel) {
        animSel = document.createElement('select');
        animSel.id = 'sel-anim-variant';
        animSel.title = 'Animation variant';
        // Insert after sel-state
        const stateSel = document.getElementById('sel-state');
        if (stateSel?.parentElement) {
            stateSel.parentElement.insertBefore(animSel, stateSel.nextSibling);
        }
        animSel.addEventListener('change', () => {
            const animName = animSel!.value;
            const clip = animationClips.get(animName);
            if (clip) switchAnimation(clip);
        });
    }
    animSel.innerHTML = '';
    for (const anim of anims) {
        const opt = document.createElement('option');
        opt.value = anim;
        opt.textContent = anim;
        animSel.appendChild(opt);
    }
    animSel.style.display = 'inline-block';
}

// ── Toolbar Event Handlers ───────────────────────────────────────────────────

// State selector → switch animation
document.getElementById('sel-state')?.addEventListener('change', (e) => {
    const stateName = (e.target as HTMLSelectElement).value;

    // Update animation variant selector for the new state
    updateAnimVariantSelector(stateName);

    // Play the first animation for this state
    const anims = currentStateAnimMap.get(stateName);
    const animName = anims?.[0];
    const clip = animName ? animationClips.get(animName) : undefined;
    if (clip) {
        switchAnimation(clip);
    }

    // Propagate state change to all getStateFromParent child mixers
    for (const entry of childMixers) {
        if (!entry.getStateFromParent) continue;
        const childClip = entry.clips.get(stateName);
        if (childClip) {
            const newAction = entry.mixer.clipAction(childClip);
            newAction.setLoop(THREE.LoopRepeat, Infinity);
            if (entry.currentAction && entry.currentAction !== newAction) {
                newAction.reset();
                newAction.play();
                entry.currentAction.crossFadeTo(newAction, 0.3, true);
            } else {
                newAction.reset();
                newAction.play();
            }
            entry.currentAction = newAction;
        }
    }
});

// Animation timeline controls
document.getElementById('btn-anim-play')?.addEventListener('click', () => {
    if (!mixer || !currentAction) return;
    isAnimPlaying = !isAnimPlaying;
    const btn = document.getElementById('btn-anim-play');
    if (btn) btn.textContent = isAnimPlaying ? '⏸' : '▶';
    if (isAnimPlaying) {
        currentAction.paused = false;
        clock.start();
    } else {
        currentAction.paused = true;
    }
});

document.getElementById('anim-scrub')?.addEventListener('input', (e) => {
    if (!mixer || !currentAction) return;
    const val = Number((e.target as HTMLInputElement).value);
    const duration = currentAction.getClip().duration;
    const time = (val / 1000) * duration;
    currentAction.time = time;
    mixer.update(0); // Force update to this frame
    updateTimelineUI();
});

document.getElementById('btn-anim-loop')?.addEventListener('click', () => {
    animLooping = !animLooping;
    const btn = document.getElementById('btn-anim-loop');
    if (btn) btn.textContent = animLooping ? '🔁' : '➡️';
    if (currentAction) {
        currentAction.setLoop(animLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        currentAction.clampWhenFinished = !animLooping;
    }
});

document.getElementById('btn-anim-speed')?.addEventListener('click', () => {
    if (!mixer) return;
    // Cycle: 1x → 2x → 0.5x → 0.25x → 1x
    const speeds = [1, 2, 0.5, 0.25];
    const current = mixer.timeScale;
    const idx = speeds.indexOf(current);
    const next = speeds[(idx + 1) % speeds.length]!;
    mixer.timeScale = next;
    const btn = document.getElementById('btn-anim-speed');
    if (btn) btn.textContent = `${next}x`;
});

wireframeToggle.addEventListener('change', () => {
    if (!currentModel) return;
    currentModel.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
            obj.material.wireframe = wireframeToggle.checked;
        }
    });
});

locatorToggle.addEventListener('change', () => {
    refreshLocatorVisualVisibility();
    if (!locatorToggle.checked) deselectLocator();
});

meshLocatorToggle.addEventListener('change', () => {
    refreshLocatorVisualVisibility();
    if (!meshLocatorToggle.checked
        && Array.from(selectedLocators).some(obj => obj.userData?.source === 'mesh')) {
        deselectLocator();
    }
});

// Store original normal maps so they can be restored
const savedNormalMaps = new WeakMap<THREE.MeshStandardMaterial, THREE.Texture | null>();

normalToggle.addEventListener('change', () => {
    if (!currentModel) return;
    currentModel.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
            const mat = obj.material;
            if (normalToggle.checked) {
                // Save and remove normal map
                if (!savedNormalMaps.has(mat)) {
                    savedNormalMaps.set(mat, mat.normalMap);
                }
                mat.normalMap = null;
                mat.needsUpdate = true;
            } else {
                // Restore saved normal map
                const saved = savedNormalMaps.get(mat);
                if (saved !== undefined) {
                    mat.normalMap = saved;
                    mat.needsUpdate = true;
                }
            }
        }
    });
});

bonesToggle.addEventListener('change', () => {
    if (skeletonHelper) skeletonHelper.visible = bonesToggle.checked;
});

// Focus button — reframe camera to fit model (like Maya's F key)
const focusBtn = document.getElementById('btn-focus');
focusBtn?.addEventListener('click', () => {
    if (currentModel) fitCameraToModel(currentModel);
});

// Transform mode buttons (W=translate, E=rotate — no scale for locators)
function setTransformMode(mode: 'translate' | 'rotate') {
    transformCtrl.setMode(mode);
    document.querySelectorAll<HTMLElement>('.tool-mode').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
}

document.getElementById('btn-translate')?.addEventListener('click', () => setTransformMode('translate'));
document.getElementById('btn-rotate')?.addEventListener('click', () => setTransformMode('rotate'));
hideSelectedLocatorsButton.addEventListener('click', toggleSelectedLocatorVisibility);
deleteSelectedLocatorsButton.addEventListener('click', deleteSelectedLocatorObjects);
document.getElementById('btn-clear-locator-selection')?.addEventListener('click', deselectLocator);

// Properties panel buttons
document.getElementById('btn-apply')?.addEventListener('click', applyPropsToLocator);
document.getElementById('btn-reset')?.addEventListener('click', () => {
    if (selectedLocator && selectedLocatorSnapshot) {
        // Restore original position/rotation
        selectedLocator.position.set(
            selectedLocatorSnapshot.px,
            selectedLocatorSnapshot.py,
            selectedLocatorSnapshot.pz,
        );
        setLocatorRotationDegrees(selectedLocator, [
            selectedLocatorSnapshot.rx,
            selectedLocatorSnapshot.ry,
            selectedLocatorSnapshot.rz,
        ]);
        updatePropsFromLocator(selectedLocator);
        autoSaveLocator();
    }
});
document.getElementById('btn-props-close')?.addEventListener('click', deselectLocator);

// ── Maya-style Special Duplicate ────────────────────────────────────────────

const specialDuplicateInputs = [
    duplicateCopies,
    duplicateTx, duplicateTy, duplicateTz,
    duplicateRx, duplicateRy, duplicateRz,
];

function getExistingLocatorNames(): Set<string> {
    const names = new Set<string>();
    currentModel?.traverse(obj => {
        if (obj.userData?.isLocator || obj instanceof THREE.Bone) names.add(obj.name);
    });
    for (const locator of currentEntity?.locators ?? []) names.add(locator.name);
    return names;
}

function readDuplicateVector(inputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement]): LocatorVector3 {
    return inputs.map(input => {
        const value = Number(input.value);
        return Number.isFinite(value) ? value : 0;
    }) as LocatorVector3;
}

function readDuplicateOptions() {
    const rawCopies = Number(duplicateCopies.value);
    const copies = Number.isFinite(rawCopies) ? Math.floor(rawCopies) : 0;
    return {
        copies,
        positionStep: readDuplicateVector([duplicateTx, duplicateTy, duplicateTz]),
        rotationStep: readDuplicateVector([duplicateRx, duplicateRy, duplicateRz]),
        orbitAroundOrigin: duplicateOrbit.checked,
    };
}

function updateSpecialDuplicatePreview() {
    const source = duplicateSourceLocator;
    const options = readDuplicateOptions();
    const valid = options.copies >= 1 && options.copies <= 100;
    duplicateCopies.classList.toggle('invalid', !valid);
    if (!source || !valid) {
        duplicatePreview.textContent = isChinese ? '副本数应为 1–100' : 'Copies must be between 1 and 100';
        return;
    }

    const names = generateDuplicateLocatorNames(source.name, options.copies, getExistingLocatorNames());
    const transforms = buildSpecialDuplicateTransforms({
        position: [source.position.x, source.position.y, source.position.z],
        rotation: getLocatorRotationDegrees(source),
    }, options);
    const last = transforms[transforms.length - 1]!;
    const lastName = names[names.length - 1]!;
    const nameRange = names.length === 1 ? names[0]! : `${names[0]} … ${lastName}`;
    duplicatePreview.textContent = isChinese
        ? `${nameRange}；末项位置 ${last.position.map(v => v.toFixed(2)).join(', ')}；旋转 ${last.rotation.map(v => v.toFixed(1)).join('°, ')}°`
        : `${nameRange}; last position ${last.position.map(v => v.toFixed(2)).join(', ')}; rotation ${last.rotation.map(v => v.toFixed(1)).join('°, ')}°`;
}

function showSpecialDuplicatePanel() {
    if (!selectedLocator || !selectedLocatorEditable) return;
    duplicateSourceLocator = selectedLocator;
    duplicateSourceName.textContent = selectedLocator.name;
    duplicateCopies.value = '1';
    duplicateTx.value = '0';
    duplicateTy.value = '0';
    duplicateTz.value = '0';
    duplicateRx.value = '0';
    duplicateRy.value = '0';
    duplicateRz.value = '0';
    duplicateOrbit.checked = false;
    propsPanel.classList.add('hidden');
    specialDuplicatePanel.classList.remove('hidden');
    updateSpecialDuplicatePreview();
    duplicateCopies.focus();
    duplicateCopies.select();
}

function hideSpecialDuplicatePanel(restoreProperties = true) {
    specialDuplicatePanel.classList.add('hidden');
    duplicateSourceLocator = null;
    if (restoreProperties && selectedLocator) propsPanel.classList.remove('hidden');
}

function confirmSpecialDuplicate() {
    const source = duplicateSourceLocator;
    const options = readDuplicateOptions();
    if (!source || options.copies < 1 || options.copies > 100) {
        updateSpecialDuplicatePreview();
        return;
    }

    const names = generateDuplicateLocatorNames(source.name, options.copies, getExistingLocatorNames());
    const transforms = buildSpecialDuplicateTransforms({
        position: [source.position.x, source.position.y, source.position.z],
        rotation: getLocatorRotationDegrees(source),
    }, options);
    const attachEntity = currentEntity?.attaches?.find(attach => attach.locatorName === source.name)?.entityName;
    const locators = transforms.map((transform, index) => ({
        locatorName: names[index]!,
        position: transform.position,
        rotation: toPdxScriptRotation(transform.rotation),
        attachEntity,
    }));

    addLocatorsToScene(locators);
    vscode.postMessage({ command: 'duplicateLocators', locators });
    hideSpecialDuplicatePanel();
}

document.getElementById('btn-special-duplicate')?.addEventListener('click', showSpecialDuplicatePanel);
document.getElementById('btn-special-duplicate-close')?.addEventListener('click', () => hideSpecialDuplicatePanel());
document.getElementById('btn-special-duplicate-cancel')?.addEventListener('click', () => hideSpecialDuplicatePanel());
document.getElementById('btn-special-duplicate-confirm')?.addEventListener('click', confirmSpecialDuplicate);
for (const input of specialDuplicateInputs) {
    input.addEventListener('input', updateSpecialDuplicatePreview);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') confirmSpecialDuplicate();
        if (event.key === 'Escape') hideSpecialDuplicatePanel();
    });
}
duplicateOrbit.addEventListener('change', updateSpecialDuplicatePreview);

function updateSmartDuplicateStepFromSelected() {
    if (!selectedLocator || smartDuplicateState?.activeObject !== selectedLocator) return;
    smartDuplicateState.step = getLocatorTransformDelta(
        smartDuplicateState.baseTransform,
        getLocatorTransform(selectedLocator),
    );
}

function smartDuplicateSelectedLocator() {
    const source = selectedLocator;
    if (!source || !selectedLocatorEditable) return;
    const sourceTransform = getLocatorTransform(source);
    let chainState = smartDuplicateState?.activeObject === source ? smartDuplicateState : null;
    if (chainState && !chainState.step) {
        updateSmartDuplicateStepFromSelected();
        chainState = smartDuplicateState;
    }

    const step = chainState?.step;
    const targetTransform = step
        ? applyLocatorTransformDelta(sourceTransform, step)
        : sourceTransform;
    const attachEntity = chainState
        ? chainState.attachEntity
        : currentEntity?.attaches?.find(attach => attach.locatorName === source.name)?.entityName;
    const [name] = generateDuplicateLocatorNames(source.name, 1, getExistingLocatorNames());
    const locator: SceneLocatorInput = {
        locatorName: name!,
        position: targetTransform.position,
        rotation: toPdxScriptRotation(targetTransform.rotation),
        attachEntity,
    };
    const duplicate = addLocatorsToScene([locator]);
    if (!duplicate) return;
    vscode.postMessage({ command: 'duplicateLocators', locators: [locator] });
    smartDuplicateState = {
        activeObject: duplicate,
        baseTransform: sourceTransform,
        step,
        attachEntity,
    };
    transformHint.textContent = step
        ? (isChinese ? '已按上次变换复制 · 继续 Shift+D' : 'Repeated previous transform · Shift+D again')
        : (isChinese ? '已原地复制 · 拉动后继续 Shift+D' : 'Duplicated in place · move it, then press Shift+D')
    transformHint.classList.remove('hidden');
    transformHint.classList.add('visible');
}

// Screenshot button
document.getElementById('btn-screenshot')?.addEventListener('click', takeScreenshot);

// Keyboard shortcuts: F=focus, W=translate, E=rotate (Maya-style), Escape=deselect, Ctrl+Z=undo
function handleWindowKeydown(e: KeyboardEvent) {
    // Ctrl+Shift+S → screenshot
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        takeScreenshot();
        return;
    }
    // Forward Ctrl+Z / Ctrl+Shift+Z to extension for undo/redo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        vscode.postMessage({ command: e.shiftKey ? 'redo' : 'undo' });
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        vscode.postMessage({ command: 'redo' });
        return;
    }

    // Don't intercept if user is typing in an input
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        showSpecialDuplicatePanel();
        return;
    }
    if (!e.ctrlKey && !e.metaKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        smartDuplicateSelectedLocator();
        return;
    }
    if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        if (e.shiftKey) restoreLastHiddenLocators();
        else toggleSelectedLocatorVisibility();
        return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelectedLocatorObjects();
        return;
    }

    switch (e.key.toLowerCase()) {
        case 'f':
            e.preventDefault();
            if (currentModel) fitCameraToModel(currentModel);
            break;
        case 'w':
            e.preventDefault();
            setTransformMode('translate');
            break;
        case 'e':
            e.preventDefault();
            setTransformMode('rotate');
            break;
        case 'escape':
            if (!specialDuplicatePanel.classList.contains('hidden')) {
                hideSpecialDuplicatePanel();
            } else {
                deselectLocator();
            }
            break;
    }
}
window.addEventListener('keydown', handleWindowKeydown);

// ── Window Events ────────────────────────────────────────────────────────────

window.addEventListener('resize', handleResize);
const resizeObserver = new ResizeObserver(handleResize);
resizeObserver.observe(canvasContainer);

// ── Cleanup ──────────────────────────────────────────────────────────────────

let isDisposed = false;

function disposeAll() {
    if (isDisposed) return;
    isDisposed = true;

    // Remove event listeners
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('keydown', handleWindowKeydown);
    window.removeEventListener('message', handleWindowMessage);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('pointerdown', handleDocumentPointerDown as EventListener);
    document.removeEventListener('click', handleAutocompleteClickOutside);
    resizeObserver.disconnect();

    for (const [, v] of textureCache) {
        void v.promise.then(t => t?.dispose());
    }
    textureCache.clear();

    // Stop render loop
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = 0;
    }

    // Deselect and cleanup labels
    deselectLocator();
    clearLocatorLabels();

    // Dispose animation mixers
    if (mixer) {
        mixer.stopAllAction();
        mixer = null;
    }
    for (const cm of childMixers) cm.mixer.stopAllAction();
    childMixers.length = 0;
    boneAttachments.length = 0;
    animationClips.clear();
    currentAction = null;
    showTimeline(false);

    // Dispose TransformControls
    if (transformCtrl) {
        transformCtrl.detach();
        const helper = transformCtrl.getHelper();
        scene.remove(helper);
        transformCtrl.dispose();
    }

    // Dispose model
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
                obj.geometry.dispose();
                const mat = obj.material;
                if (mat instanceof THREE.MeshStandardMaterial) {
                    mat.map?.dispose();
                    mat.normalMap?.dispose();
                    mat.roughnessMap?.dispose();
                    mat.metalnessMap?.dispose();
                    mat.dispose();
                } else if (mat instanceof THREE.Material) {
                    mat.dispose();
                }
            }
        });
        currentModel = null;
    }

    if (locatorHelpers) {
        scene.remove(locatorHelpers);
        locatorHelpers = null;
    }

    // Dispose renderer
    if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss();
        const canvas = renderer.domElement;
        canvas.parentElement?.removeChild(canvas);
    }

    // Dispose controls
    if (controls) {
        controls.dispose();
    }
}

// ── Entity Selector ──────────────────────────────────────────────────────────

const entitySelect = document.getElementById('sel-entity') as HTMLSelectElement;

entitySelect.addEventListener('change', () => {
    const idx = parseInt(entitySelect.value, 10);
    if (!isNaN(idx)) {
        vscode.postMessage({ command: 'selectEntity', index: idx });
    }
});

function updateEntitySelector(entities: Array<{ name: string; index: number }>, selectedIndex: number) {
    entitySelect.innerHTML = '';
    for (const e of entities) {
        const opt = document.createElement('option');
        opt.value = String(e.index);
        opt.textContent = e.name || `entity_${e.index}`;
        entitySelect.appendChild(opt);
    }
    entitySelect.value = String(selectedIndex);
    // Show/hide selector based on entity count
    entitySelect.style.display = entities.length > 1 ? 'inline-block' : 'none';
}

// ── Context Menu (Right-click on canvas) ─────────────────────────────────────

function hideContextMenu() {
    contextMenu.classList.remove('visible');
}

// Right-click interception is registered in initThree() (see pointerdown monitoring of renderer.domElement in initThree function)

canvasContainer.addEventListener('contextmenu', (e) => {
    // Only displayed if the entity is loaded and the locator is visible
    if (!currentEntity || !locatorToggle.checked) return;
    e.preventDefault();

    // Compute 3D world position at right-click point (project onto
    // the plane at the camera target depth)
    const rect = canvasContainer.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const raycasterCtx = new THREE.Raycaster();
    raycasterCtx.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const plane = new THREE.Plane();
    plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), controls.target);
    const intersection = new THREE.Vector3();
    raycasterCtx.ray.intersectPlane(plane, intersection);
    contextMenuWorldPos = intersection || controls.target.clone();

    contextMenu.style.left = `${e.clientX - rect.left}px`;
    contextMenu.style.top = `${e.clientY - rect.top}px`;
    contextMenu.classList.add('visible');
    contextMenuOpenTime = Date.now();
});

// Hide context menu on left-click/pointerdown, but with a timestamp guard
// to prevent immediate dismissal from the same event cycle
function handleDocumentClick(e: MouseEvent) {
    if (Date.now() - contextMenuOpenTime < 100) return;
    if (contextMenu.contains(e.target as Node)) return;
    hideContextMenu();
}
document.addEventListener('click', handleDocumentClick);

function handleDocumentPointerDown(e: PointerEvent) {
    if (Date.now() - contextMenuOpenTime < 100) return;
    // Only dismiss on left button, not right button (which opens context menu)
    if (e.button !== 0) return;
    if (contextMenu.contains(e.target as Node)) return;
    hideContextMenu();
}
document.addEventListener('pointerdown', handleDocumentPointerDown as EventListener);

// Context menu: Add Locator
document.getElementById('ctx-add-locator')?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
    showAddLocatorPanel();
});

// ── Add Locator Panel ────────────────────────────────────────────────────────

function showAddLocatorPanel() {
    // Request fresh entity names from extension for autocomplete
    vscode.postMessage({ command: 'requestEntityNames' });
    addLocName.value = '';
    addLocEntity.value = '';
    hideAutocomplete();
    addLocatorPanel.classList.remove('hidden');
    addLocName.focus();
}

function hideAddLocatorPanel() {
    addLocatorPanel.classList.add('hidden');
    hideAutocomplete();
}

document.getElementById('btn-add-locator-close')?.addEventListener('click', hideAddLocatorPanel);
document.getElementById('btn-add-loc-cancel')?.addEventListener('click', hideAddLocatorPanel);

document.getElementById('btn-add-loc-confirm')?.addEventListener('click', () => {
    const name = addLocName.value.trim();
    if (!name) {
        addLocName.style.borderColor = '#be1100';
        return;
    }
    addLocName.style.borderColor = '';

    // Position: use the right-click world position, or camera target
    const pos = contextMenuWorldPos ? contextMenuWorldPos.clone() : controls.target.clone();

    // Convert world position to model local space
    if (currentModel) {
        const invMatrix = new THREE.Matrix4().copy(currentModel.matrixWorld).invert();
        pos.applyMatrix4(invMatrix);
    }

    const attachEntity = addLocEntity.value.trim() || undefined;
    const position: [number, number, number] = [pos.x, pos.y, pos.z];
    const rotation: [number, number, number] = [0, 0, 0];

    // Immediately create the locator in the 3D scene (no full reload)
    addLocatorToScene(name, position, rotation);

    // Send to extension for file write-back (no reload)
    vscode.postMessage({
        command: 'addLocator',
        locatorName: name,
        position,
        rotation,
        attachEntity,
    });

    hideAddLocatorPanel();
});

/** Incrementally add a locator to the current scene without full reload */
function addLocatorToScene(name: string, position: [number, number, number], rotation: [number, number, number]) {
    addLocatorsToScene([{ locatorName: name, position, rotation }]);
}

interface SceneLocatorInput {
    locatorName: string;
    position: LocatorVector3;
    /** PDX script order: Y, X, Z. */
    rotation: LocatorVector3;
    attachEntity?: string;
}

/** Incrementally add a batch of locators and rebuild the tree only once. */
function addLocatorsToScene(locators: SceneLocatorInput[]) {
    if (!locatorHelpers || !currentEntity) return null;

    // Update currentEntity so the tree knows about the new locator
    if (!currentEntity.locators) {
        currentEntity.locators = [];
    }
    let lastGroup: THREE.Group | null = null;
    for (const locator of locators) {
        const group = createLocatorGroup(locator.locatorName, 0.5, 'script');
        group.position.set(locator.position[0], locator.position[1], locator.position[2]);
        group.rotation.copy(pdxScriptEuler(locator.rotation[0], locator.rotation[1], locator.rotation[2]));
        group.userData = { source: 'script', isLocator: true };
        locatorHelpers.add(group);
        lastGroup = group;

        const existingLoc = currentEntity.locators.find(l => l.name === locator.locatorName);
        if (!existingLoc) {
            currentEntity.locators.push({
                name: locator.locatorName,
                position: locator.position,
                rotation: locator.rotation,
            });
        }
    }

    if (lastParsedMeshFile) {
        updateEntityTree(currentEntity, lastParsedMeshFile);
    } else {
        updateEntityTree(currentEntity);
    }

    if (lastGroup) selectLocator(lastGroup, true);
    return lastGroup;
}

// Allow Enter key to confirm in add-locator inputs
addLocName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-add-loc-confirm')?.click();
    if (e.key === 'Escape') hideAddLocatorPanel();
});
addLocEntity.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !autocompleteList.classList.contains('visible')) {
        document.getElementById('btn-add-loc-confirm')?.click();
    }
    if (e.key === 'Escape') {
        if (autocompleteList.classList.contains('visible')) {
            hideAutocomplete();
        } else {
            hideAddLocatorPanel();
        }
    }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const first = autocompleteList.querySelector('.ac-item') as HTMLElement | null;
        first?.focus();
    }
});

// ── Custom Autocomplete ──────────────────────────────────────────────────────

function hideAutocomplete() {
    autocompleteList.classList.remove('visible');
    autocompleteList.innerHTML = '';
}

function showAutocomplete(filter: string) {
    const query = filter.toLowerCase();
    const matches = cachedEntityNames.filter(n => n.toLowerCase().includes(query)).slice(0, 50);
    if (matches.length === 0) {
        hideAutocomplete();
        return;
    }

    autocompleteList.innerHTML = '';
    for (const name of matches) {
        const item = document.createElement('div');
        item.className = 'ac-item';
        item.tabIndex = 0;

        // Highlight matched portion
        const idx = name.toLowerCase().indexOf(query);
        if (query && idx >= 0) {
            item.innerHTML = escapeHtml(name.substring(0, idx))
                + `<strong>${escapeHtml(name.substring(idx, idx + query.length))}</strong>`
                + escapeHtml(name.substring(idx + query.length));
        } else {
            item.textContent = name;
        }

        item.addEventListener('click', () => {
            addLocEntity.value = name;
            hideAutocomplete();
            addLocEntity.focus();
        });
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                addLocEntity.value = name;
                hideAutocomplete();
                addLocEntity.focus();
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                (item.nextElementSibling as HTMLElement)?.focus();
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = item.previousElementSibling as HTMLElement | null;
                if (prev) prev.focus(); else addLocEntity.focus();
            }
            if (e.key === 'Escape') {
                hideAutocomplete();
                addLocEntity.focus();
            }
        });
        autocompleteList.appendChild(item);
    }
    autocompleteList.classList.add('visible');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

addLocEntity.addEventListener('input', () => {
    const val = addLocEntity.value.trim();
    if (val.length === 0) {
        hideAutocomplete();
        return;
    }
    showAutocomplete(val);
});

addLocEntity.addEventListener('focus', () => {
    const val = addLocEntity.value.trim();
    if (val.length > 0) showAutocomplete(val);
});

// Hide autocomplete when clicking outside
function handleAutocompleteClickOutside(e: MouseEvent) {
    if (!addLocatorPanel.contains(e.target as Node)) {
        hideAutocomplete();
    }
}
document.addEventListener('click', handleAutocompleteClickOutside);

function updateEntityNamesList(names: string[]) {
    cachedEntityNames = names;
}

// ── Sidebar Resize ───────────────────────────────────────────────────────────

{
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    sidebarResize.addEventListener('pointerdown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = entityTree.offsetWidth;
        sidebarResize.classList.add('dragging');
        sidebarResize.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    sidebarResize.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const delta = e.clientX - startX;
        const newWidth = Math.max(120, Math.min(window.innerWidth - 100, startWidth + delta));
        entityTree.style.width = `${newWidth}px`;
        handleResize();
    });

    sidebarResize.addEventListener('pointerup', () => {
        isDragging = false;
        sidebarResize.classList.remove('dragging');
    });
}

// ── Message Handler ──────────────────────────────────────────────────────────

async function handleWindowMessage(event: MessageEvent) {
    const msg = event.data;
    if (!msg?.command) return;

    switch (msg.command) {
        case 'entityList': {
            updateEntitySelector(msg.entities ?? [], msg.selectedIndex ?? 0);
            break;
        }
        case 'render': {
            const data = msg as RenderMessage;
            entityNameEl.textContent = data.entity.name || data.fileName;
            emptyState.style.display = 'none';
            document.title = `Entity: ${data.entity.name || data.fileName}`;
            // Decode base64 mesh data to ArrayBuffer
            let meshBuffer: ArrayBuffer | undefined;
            if (data.meshBase64) {
                const binary = atob(data.meshBase64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                meshBuffer = bytes.buffer;
            }
            // Decode animation data
            const animBuffers = new Map<string, ArrayBuffer>();
            if (data.animations) {
                for (const anim of data.animations) {
                    const binary = atob(anim.animBase64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i);
                    }
                    animBuffers.set(anim.animName, bytes.buffer);
                }
            }
            await loadModel(data.entity, meshBuffer);
            // Initialize animations after model is loaded
            if (animBuffers.size > 0) {
                initAnimations(animBuffers);
            }
            break;
        }
        case 'dispose': {
            disposeAll();
            break;
        }
        case 'entityNames': {
            updateEntityNamesList(msg.names ?? []);
            break;
        }
        case 'attachEntityData': {
            // Incremental attach: load entity model at the specified locator
            const locName: string = msg.locatorName;
            const attachData: AttachData = msg.attachData;
            
            if (currentEntity) {
                if (!currentEntity.attaches) {
                    currentEntity.attaches = [];
                }
                const existingIndex = currentEntity.attaches.findIndex(a => a.locatorName === locName);
                if (existingIndex >= 0) {
                    currentEntity.attaches[existingIndex]!.entityName = attachData.entityName || attachData.locatorName; // Fallback
                } else {
                    currentEntity.attaches.push({ locatorName: locName, entityName: attachData.entityName || attachData.locatorName });
                }

                if (!currentEntity.attachData) {
                    currentEntity.attachData = [];
                }
                const existingDataIndex = currentEntity.attachData.findIndex(a => a.locatorName === locName);
                if (existingDataIndex >= 0) {
                    currentEntity.attachData[existingDataIndex] = attachData;
                } else {
                    currentEntity.attachData.push(attachData);
                }
            }

            if (locatorHelpers && currentModel) {
                // Remove any existing attach at this locator first
                removeAttachAtLocator(locName);
                // Load the new attached entity
                await loadAttachChildren([attachData], locatorHelpers, currentModel, currentEntity?.defaultState);
                // Rebuild the entity tree in the sidebar
                buildEntityTree();
            }
            break;
        }
        case 'removeAttachEntity': {
            const locName2: string = msg.locatorName;
            
            if (currentEntity) {
                if (currentEntity.attaches) {
                    currentEntity.attaches = currentEntity.attaches.filter(a => a.locatorName !== locName2);
                }
                if (currentEntity.attachData) {
                    currentEntity.attachData = currentEntity.attachData.filter(a => a.locatorName !== locName2);
                }
            }
            
            removeAttachAtLocator(locName2);
            buildEntityTree();
            break;
        }
    }
}
window.addEventListener('message', handleWindowMessage);

// ── Initialize ───────────────────────────────────────────────────────────────

initThree();

