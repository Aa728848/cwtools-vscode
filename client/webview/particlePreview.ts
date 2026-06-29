import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { ParticleEffect, ParticleRenderPayload, Scalar } from './particleTypes';
import { isRange } from './particleTypes';
import { ParticleEffectSimulation } from './particleSimulation';
import { ParticleRenderer } from './particleRenderer';
import { CurveEditor } from './curveEditor';
import { createDefaultCurve, createDefaultForce, createDefaultSubsystem, ParticleInspector } from './inspector';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const GAME_LOOK_EXPOSURE = 1.08;
const GAME_BLOOM_STRENGTH = 0.32;
const GAME_BLOOM_RADIUS = 0.28;
const GAME_BLOOM_THRESHOLD = 0.72;
const HISTORY_LIMIT = 100;
const CURVE_HISTORY_IDLE_MS = 350;

interface EditorSnapshot {
    effects: ParticleEffect[];
    currentEffectIndex: number;
    currentSubsystemIndex: number;
    currentCurveIndex: number;
    currentForceIndex: number;
}

const locale = document.body.dataset.locale ?? 'en';
const isChinese = locale.toLowerCase().startsWith('zh');
const i18n: Record<string, { en: string; zh: string }> = {
    systems: { en: 'Systems', zh: '子系统' },
    curves: { en: 'Curves', zh: '曲线' },
    forces: { en: 'Forces', zh: '力' },
    properties: { en: 'Properties', zh: '属性' },
    readonly: { en: 'Read-only source. Editing will save a mod copy first.', zh: '只读来源。编辑前会先另存为 mod 副本。' },
    approx: { en: 'Approximate simulation', zh: '近似模拟' },
    loop: { en: 'Loop', zh: '循环' },
    empty: { en: 'Open a particle .asset file to preview.', zh: '打开粒子 .asset 文件进行预览。' },
};

function applyI18n(): void {
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
        const entry = i18n[element.dataset.i18n ?? ''];
        if (entry) element.textContent = isChinese ? entry.zh : entry.en;
    });
}

applyI18n();

const viewport = document.getElementById('viewport')!;
const emptyState = document.getElementById('empty-state')!;
const titleEl = document.getElementById('particle-title')!;
const loadedEffectName = document.getElementById('loaded-effect-name')!;
const effectRow = document.getElementById('effect-row')!;
const effectSelect = document.getElementById('effect-select') as HTMLSelectElement;
const loadEffectButton = document.getElementById('btn-load-effect') as HTMLButtonElement;
const subsystemSelect = document.getElementById('subsystem-select') as HTMLSelectElement;
const curveSelect = document.getElementById('curve-select') as HTMLSelectElement;
const forceSelect = document.getElementById('force-select') as HTMLSelectElement;
const curveCanvas = document.getElementById('curve-canvas') as HTMLCanvasElement;
const inspectorRoot = document.getElementById('inspector')!;
const forceInspectorRoot = document.getElementById('force-inspector')!;
const readonlyBanner = document.getElementById('readonly-banner')!;
const playButton = document.getElementById('btn-play') as HTMLButtonElement;
const restartButton = document.getElementById('btn-restart') as HTMLButtonElement;
const loopToggle = document.getElementById('loop-toggle') as HTMLInputElement;
const hideOthersToggle = document.getElementById('hide-others-toggle') as HTMLInputElement;
const emitterVisualsToggle = document.getElementById('emitter-visuals-toggle') as HTMLInputElement;
const scrub = document.getElementById('time-scrub') as HTMLInputElement;
const timeLabel = document.getElementById('time-label')!;
const saveButton = document.getElementById('btn-save') as HTMLButtonElement;
const undoButton = document.getElementById('btn-undo') as HTMLButtonElement;
const redoButton = document.getElementById('btn-redo') as HTMLButtonElement;

let glRenderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let composer: EffectComposer;
let bloomPass: UnrealBloomPass;
let outputPass: OutputPass;
let controls: OrbitControls;
let emitterVisualsGroup: THREE.Group | undefined;
let particleRenderer: ParticleRenderer;
let simulation: ParticleEffectSimulation | null = null;
let animationId = 0;
let lastFrame = performance.now();
let playing = true;
let elapsed = 0;
let playbackDurationSeconds = 20;
let currentPayload: ParticleRenderPayload | null = null;
let currentEffectIndex = 0;
let pendingEffectIndex = 0;
let currentSubsystemIndex = 0;
let currentCurveIndex = 0;
let currentForceIndex = 0;
let dirty = false;
let savedEffectsBaseline: ParticleEffect[] = [];
let undoStack: EditorSnapshot[] = [];
let redoStack: EditorSnapshot[] = [];
let textureRequestId = 0;
let hideOtherSubsystems = false;
let curveEditor: CurveEditor | null = null;
let curveHistoryTimer = 0;
let curveHistoryOpen = false;

const inspector = new ParticleInspector(inspectorRoot);
const forceInspector = new ParticleInspector(forceInspectorRoot);

function cssColor(variable: string, fallback: string): string {
    return getComputedStyle(document.body).getPropertyValue(variable).trim() || fallback;
}

function initThree(): void {
    glRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    glRenderer.setPixelRatio(window.devicePixelRatio);
    glRenderer.setClearColor(0x000000, 1);
    glRenderer.outputColorSpace = THREE.SRGBColorSpace;
    glRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    glRenderer.toneMappingExposure = GAME_LOOK_EXPOSURE;
    viewport.append(glRenderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    camera.position.set(0, 4, 9);
    controls = new OrbitControls(camera, glRenderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1, 0);

    const grid = new THREE.GridHelper(20, 20);
    const material = grid.material;
    if (Array.isArray(material)) {
        for (const item of material) {
            item.opacity = 0.25;
            item.transparent = true;
        }
    } else {
        material.opacity = 0.25;
        material.transparent = true;
    }
    scene.add(grid);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const light = new THREE.DirectionalLight(0xffffff, 0.5);
    light.position.set(3, 5, 4);
    scene.add(light);
    emitterVisualsGroup = new THREE.Group();
    scene.add(emitterVisualsGroup);

    composer = new EffectComposer(glRenderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), GAME_BLOOM_STRENGTH, GAME_BLOOM_RADIUS, GAME_BLOOM_THRESHOLD);
    composer.addPass(bloomPass);
    outputPass = new OutputPass();
    composer.addPass(outputPass);

    particleRenderer = new ParticleRenderer(scene);
    handleResize();
    animationId = requestAnimationFrame(animate);
}

function animate(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (playing && simulation) {
        elapsed += dt;
        simulation.update(dt);
        if (elapsed >= playbackDurationSeconds && loopToggle.checked) {
            elapsed = 0;
            simulation.reset();
        } else if (elapsed >= playbackDurationSeconds) {
            elapsed = playbackDurationSeconds;
            playing = false;
            updatePlayButton();
        }
    }
    if (simulation) particleRenderer.update(camera);
    controls.update();
    composer.render(dt);
    updateTimelineControls();
    animationId = requestAnimationFrame(animate);
}

function handleResize(): void {
    const rect = viewport.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    glRenderer.setSize(width, height, false);
    composer?.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}

function currentEffect(): ParticleEffect | undefined {
    return currentPayload?.effects[currentEffectIndex];
}

function currentSubsystem() {
    return currentEffect()?.subsystems[currentSubsystemIndex];
}

function scalarBaseValue(value: Scalar | undefined, fallback: number): number {
    if (!value) return fallback;
    return isRange(value) ? value.a.value : value.value;
}

function scalarMaxValue(value: Scalar | undefined, fallback: number): number {
    if (!value) return fallback;
    if (!isRange(value)) return value.value;
    const base = value.a.value;
    const variance = Math.abs(value.b.value);
    const extras = (value.extras ?? []).map(item => item.value);
    return Math.max(base + variance, base - variance, ...extras);
}

function scalarExtentValue(value: Scalar | undefined, fallback: number): number {
    if (!value) return Math.abs(fallback);
    if (isRange(value)) {
        const base = value.a.value;
        const variance = Math.abs(value.b.value);
        const extras = (value.extras ?? []).map(item => Math.abs(item.value));
        return Math.max(Math.abs(base + variance), Math.abs(base - variance), ...extras);
    }
    return Math.abs(value.value);
}

function assetVectorToWorld(x: number, y: number, z: number): { x: number; y: number; z: number } {
    return { x: z, y, z: -x };
}

function computePlaybackDuration(effect: ParticleEffect | undefined): number {
    if (!effect) return 20;
    let maxTime = 0;
    for (const subsystem of effect.subsystems) {
        const start = scalarMaxValue(subsystem.start, 0);
        const duration = scalarMaxValue(subsystem.duration, 4);
        const life = scalarMaxValue(subsystem.life, 1);
        maxTime = Math.max(maxTime, start + (duration >= 0 ? duration : 8) + Math.max(0.1, life));
    }
    return Math.max(1, Math.min(60, maxTime || 20));
}

function computeEffectRadius(effect: ParticleEffect | undefined): number {
    if (!effect) return 20;
    let radius = 20;
    for (const subsystem of effect.subsystems) {
        const px = scalarExtentValue(subsystem.position?.x, 0);
        const py = scalarExtentValue(subsystem.position?.y, 0);
        const pz = scalarExtentValue(subsystem.position?.z, 0);
        const positionRadius = Math.hypot(px, py, pz);
        const emitterRadius = subsystem.emitterType === 'box'
            ? Math.hypot(
                scalarExtentValue(subsystem.boxEmitterX, 0),
                scalarExtentValue(subsystem.boxEmitterY, 0),
                scalarExtentValue(subsystem.boxEmitterZ, 0),
            )
            : subsystem.emitterType === 'sphere'
                ? scalarExtentValue(subsystem.sphereEmitterRadius, 1)
                : 0;
        const particleSize = scalarExtentValue(subsystem.size, 1);
        radius = Math.max(radius, positionRadius + emitterRadius + particleSize);
    }
    return Math.max(10, radius * Math.max(0.1, effect.scale ?? 1));
}

function frameCurrentEffect(effect: ParticleEffect | undefined): void {
    const radius = computeEffectRadius(effect);
    controls.target.set(0, 0, 0);
    camera.near = Math.max(0.1, radius / 1000);
    camera.far = Math.max(2000, radius * 10);
    camera.position.set(radius * 0.35, radius * 0.55, radius * 1.45);
    camera.updateProjectionMatrix();
    controls.update();
}

function updatePlayButton(): void {
    playButton.textContent = playing ? 'Pause' : 'Play';
}

function updateTimelineControls(): void {
    timeLabel.textContent = `${elapsed.toFixed(2)}s`;
    scrub.value = String(Math.min(1000, Math.round(elapsed / playbackDurationSeconds * 1000)));
}

function seekTo(seconds: number): void {
    const target = Math.max(0, Math.min(playbackDurationSeconds, seconds));
    if (!simulation) {
        elapsed = target;
        updateTimelineControls();
        return;
    }
    simulation.reset();
    elapsed = 0;
    let remaining = target;
    while (remaining > 0) {
        const step = Math.min(0.05, remaining);
        simulation.update(step);
        elapsed += step;
        remaining -= step;
    }
    particleRenderer.update(camera);
    updateTimelineControls();
}

function setByPath(root: unknown, path: Array<string | number>, value: unknown): void {
    let current = root as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
        const key = String(path[i]!);
        let next = current[key] as Record<string, unknown> | undefined;
        if (next === undefined || next === null) {
            next = typeof path[i + 1] === 'number' ? [] as unknown as Record<string, unknown> : {};
            current[key] = next;
        }
        current = next;
    }
    current[String(path[path.length - 1]!)] = value;
}

function forceReferenceNames(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(name => name.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
}

function forceRenameForEdit(effect: ParticleEffect, path: Array<string | number>, value: unknown): { oldName: string; newName: string } | undefined {
    const parts = path.map(String);
    if (parts[0] !== 'forces' || parts[2] !== 'name' || typeof value !== 'string') return undefined;
    const index = Number(parts[1]);
    const oldName = effect.forces[index]?.name;
    if (!oldName || oldName === value) return undefined;
    return { oldName, newName: value };
}

function renameForceReferences(effect: ParticleEffect, oldName: string, newName: string): void {
    const visit = (subsystems: ParticleEffect['subsystems']): void => {
        for (const subsystem of subsystems) {
            const refs = forceReferenceNames(subsystem.force);
            if (refs.includes(oldName)) subsystem.force = refs.map(name => name === oldName ? newName : name).join(',');
            if (subsystem.childsystems?.length) visit(subsystem.childsystems);
        }
    };
    visit(effect.subsystems);
}

function fieldEditNeedsSimulationRebuild(path: Array<string | number>): boolean {
    const parts = path.map(String);
    if (parts[0] === 'subsystems') {
        const field = parts[2];
        if (field === 'maxAmount' || field === 'billboard') return true;
        if (field === 'particleYaw' || field === 'particlePitch' || field === 'particleRoll') return true;
        if (field === 'texture') return parts[3] === 'file' || parts[3] === 'x' || parts[3] === 'y' || parts[3] === 'shader';
    }
    if (parts[0] === 'animations' && parts[2] === 'name') return true;
    if (parts[0] === 'forces' && parts[2] === 'name') return true;
    return false;
}

function fieldEditChangesSelectors(path: Array<string | number>): boolean {
    const parts = path.map(String);
    return parts[2] === 'name' && (parts[0] === 'subsystems' || parts[0] === 'animations' || parts[0] === 'forces');
}

function fieldEditChangesEmitterVisuals(path: Array<string | number>): boolean {
    const parts = path.map(String);
    if (parts[0] !== 'subsystems' || Number(parts[1]) !== currentSubsystemIndex) return false;
    const field = parts[2];
    if (field === 'emitterType' || field === 'sphereEmitterRadius' || field === 'boxEmitterX' || field === 'boxEmitterY' || field === 'boxEmitterZ') return true;
    return field === 'position' && (parts[3] === 'x' || parts[3] === 'y' || parts[3] === 'z');
}

function fieldEditNeedsTextureRefresh(path: Array<string | number>): boolean {
    const parts = path.map(String);
    return parts[0] === 'subsystems' && parts[2] === 'texture' && parts[3] === 'file';
}

function effectFingerprint(effect: ParticleEffect | undefined): string {
    return JSON.stringify(effect ?? null);
}

function dirtyEffectIndices(): number[] {
    if (!currentPayload) return [];
    const dirtyIndices: number[] = [];
    const count = Math.max(currentPayload.effects.length, savedEffectsBaseline.length);
    for (let index = 0; index < count; index++) {
        if (effectFingerprint(currentPayload.effects[index]) !== effectFingerprint(savedEffectsBaseline[index])) {
            dirtyIndices.push(index);
        }
    }
    return dirtyIndices;
}

function hasUnsavedChanges(): boolean {
    return dirtyEffectIndices().length > 0;
}

function setDirtyState(nextDirty: boolean): void {
    if (dirty === nextDirty) {
        updateEditButtons();
        return;
    }
    dirty = nextDirty;
    vscode.postMessage({ command: 'dirtyState', dirty });
    updateEditButtons();
}

function updateEditButtons(): void {
    saveButton.disabled = !dirty;
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
    loadEffectButton.disabled = pendingEffectIndex === currentEffectIndex;
}

function markDirty(): void {
    setDirtyState(true);
}

function editorSnapshot(): EditorSnapshot | undefined {
    if (!currentPayload) return undefined;
    return {
        effects: cloneEffectValue(currentPayload.effects),
        currentEffectIndex,
        currentSubsystemIndex,
        currentCurveIndex,
        currentForceIndex,
    };
}

function pushHistorySnapshot(): void {
    const snapshot = editorSnapshot();
    if (!snapshot) return;
    undoStack.push(snapshot);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateEditButtons();
}

function restoreEditorSnapshot(snapshot: EditorSnapshot): void {
    if (!currentPayload) return;
    currentPayload.effects = cloneEffectValue(snapshot.effects);
    currentEffectIndex = Math.min(snapshot.currentEffectIndex, Math.max(0, currentPayload.effects.length - 1));
    currentPayload.selectedEffectIndex = currentEffectIndex;
    pendingEffectIndex = currentEffectIndex;
    const effect = currentEffect();
    currentSubsystemIndex = Math.min(snapshot.currentSubsystemIndex, Math.max(0, (effect?.subsystems.length ?? 1) - 1));
    currentCurveIndex = Math.min(snapshot.currentCurveIndex, Math.max(0, (effect?.animations.length ?? 1) - 1));
    currentForceIndex = Math.min(snapshot.currentForceIndex, Math.max(0, (effect?.forces.length ?? 1) - 1));
    setDirtyState(hasUnsavedChanges());
    refreshAll(false);
    requestPreviewTextures();
}

function undoCachedEdit(): void {
    const previous = undoStack.pop();
    const current = editorSnapshot();
    if (!previous || !current) {
        updateEditButtons();
        return;
    }
    redoStack.push(current);
    restoreEditorSnapshot(previous);
}

function redoCachedEdit(): void {
    const next = redoStack.pop();
    const current = editorSnapshot();
    if (!next || !current) {
        updateEditButtons();
        return;
    }
    undoStack.push(current);
    restoreEditorSnapshot(next);
}

function isTextEditingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    const tag = element.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable;
}

function finishCommittedEdit(): void {
    setDirtyState(hasUnsavedChanges());
}

function requestPreviewTextures(): void {
    if (!currentPayload) return;
    textureRequestId++;
    vscode.postMessage({ command: 'previewEffects', requestId: textureRequestId, effects: currentPayload.effects });
}

function rebuildSimulation(reset = true): void {
    const effect = currentEffect();
    if (!effect) {
        simulation = null;
        particleRenderer.setSystems([], {});
        emptyState.style.display = 'flex';
        return;
    }
    emptyState.style.display = 'none';
    const previewEffect = hideOtherSubsystems
        ? { ...effect, subsystems: effect.subsystems[currentSubsystemIndex] ? [effect.subsystems[currentSubsystemIndex]!] : [] }
        : effect;
    simulation = new ParticleEffectSimulation(previewEffect);
    particleRenderer.setSystems(simulation.systems, currentPayload?.textures ?? {});
    if (reset) {
        elapsed = 0;
        simulation.reset();
    }
    refreshEmitterVisuals();
}

function disposeEmitterVisuals(): void {
    if (!emitterVisualsGroup) return;
    for (const child of [...emitterVisualsGroup.children]) {
        emitterVisualsGroup.remove(child);
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
            for (const item of material) item.dispose();
        } else {
            material?.dispose();
        }
    }
}

function refreshEmitterVisuals(): void {
    if (!emitterVisualsGroup) return;
    disposeEmitterVisuals();
    const subsystem = currentSubsystem();
    if (!emitterVisualsToggle.checked || !subsystem) return;

    const color = new THREE.Color().setStyle(cssColor('--vscode-focusBorder', '#7f7fd5'));
    const material = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.8 });
    let geometry: THREE.BufferGeometry;
    if (subsystem.emitterType === 'box') {
        const x = Math.max(0.1, scalarExtentValue(subsystem.boxEmitterZ, 1) * 2);
        const y = Math.max(0.1, scalarExtentValue(subsystem.boxEmitterY, 1) * 2);
        const z = Math.max(0.1, scalarExtentValue(subsystem.boxEmitterX, 1) * 2);
        geometry = new THREE.BoxGeometry(x, y, z);
    } else {
        const radius = subsystem.emitterType === 'sphere'
            ? Math.max(0.1, scalarExtentValue(subsystem.sphereEmitterRadius, 1))
            : 0.18;
        geometry = new THREE.SphereGeometry(radius, 24, 12);
    }
    const helper = new THREE.Mesh(geometry, material);
    const position = assetVectorToWorld(
        scalarBaseValue(subsystem.position?.x, 0),
        scalarBaseValue(subsystem.position?.y, 0),
        scalarBaseValue(subsystem.position?.z, 0),
    );
    helper.position.set(position.x, position.y, position.z);
    emitterVisualsGroup.add(helper);
}

function refreshSelectors(): void {
    const payload = currentPayload;
    effectSelect.innerHTML = '';
    subsystemSelect.innerHTML = '';
    curveSelect.innerHTML = '';
    forceSelect.innerHTML = '';
    if (!payload) return;

    payload.effects.forEach((effect, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = effect.name || `particle_${index + 1}`;
        effectSelect.append(option);
    });
    pendingEffectIndex = Math.min(pendingEffectIndex, Math.max(0, payload.effects.length - 1));
    effectSelect.value = String(pendingEffectIndex);
    effectRow.classList.toggle('hidden', payload.effects.length <= 1);
    loadEffectButton.disabled = pendingEffectIndex === currentEffectIndex;

    const effect = currentEffect();
    if (!effect) return;
    effect.subsystems.forEach((subsystem, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = subsystem.name || `subsystem_${index + 1}`;
        subsystemSelect.append(option);
    });
    currentSubsystemIndex = Math.min(currentSubsystemIndex, Math.max(0, effect.subsystems.length - 1));
    subsystemSelect.value = String(currentSubsystemIndex);

    effect.animations.forEach((curve, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = curve.name || `curve_${index + 1}`;
        curveSelect.append(option);
    });
    currentCurveIndex = Math.min(currentCurveIndex, Math.max(0, effect.animations.length - 1));
    curveSelect.value = String(currentCurveIndex);

    effect.forces.forEach((force, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = force.name || `force_${index + 1}`;
        forceSelect.append(option);
    });
    currentForceIndex = Math.min(currentForceIndex, Math.max(0, effect.forces.length - 1));
    forceSelect.value = String(currentForceIndex);
    forceSelect.disabled = effect.forces.length === 0;
}

function handleFieldEdit(path: Array<string | number>, value: unknown): void {
    const effect = currentEffect();
    if (!effect) return;
    const forceRename = forceRenameForEdit(effect, path, value);
    pushHistorySnapshot();
    setByPath(effect, path, value);
    if (forceRename) renameForceReferences(effect, forceRename.oldName, forceRename.newName);
    finishCommittedEdit();
    if (fieldEditNeedsSimulationRebuild(path)) rebuildSimulation(false);
    else if (fieldEditChangesEmitterVisuals(path)) refreshEmitterVisuals();
    if (fieldEditChangesSelectors(path)) refreshSelectors();
    refreshInspector();
    refreshForceInspector();
    if (fieldEditNeedsTextureRefresh(path)) requestPreviewTextures();
}

function inspectorCallbacks() {
    return {
        onDirty: markDirty,
        onFieldEdit: handleFieldEdit,
    };
}

function refreshInspector(): void {
    inspector.render(currentEffect(), currentSubsystemIndex, inspectorCallbacks(), currentPayload?.textureCandidates ?? []);
}

function refreshForceInspector(): void {
    forceInspector.renderForce(currentEffect(), currentForceIndex, inspectorCallbacks());
}

function refreshCurveEditor(): void {
    const effect = currentEffect();
    const curve = effect?.animations[currentCurveIndex];
    curveEditor?.dispose();
    window.clearTimeout(curveHistoryTimer);
    curveHistoryOpen = false;
    curveEditor = new CurveEditor(curveCanvas, points => {
        const current = currentEffect()?.animations[currentCurveIndex];
        if (!current) return;
        if (!curveHistoryOpen) {
            pushHistorySnapshot();
            curveHistoryOpen = true;
        }
        current.points = points;
        window.clearTimeout(curveHistoryTimer);
        curveHistoryTimer = window.setTimeout(() => {
            curveHistoryOpen = false;
        }, CURVE_HISTORY_IDLE_MS);
        finishCommittedEdit();
    });
    curveEditor.setPoints(curve?.points ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
}

function refreshAll(reset = true): void {
    const effect = currentEffect();
    titleEl.textContent = effect?.name || currentPayload?.fileName || 'Particle Editor';
    loadedEffectName.textContent = effect?.name || currentPayload?.fileName || 'particle';
    readonlyBanner.classList.toggle('hidden', !(currentPayload?.readonly));
    playbackDurationSeconds = computePlaybackDuration(effect);
    updatePlayButton();
    refreshSelectors();
    refreshInspector();
    refreshForceInspector();
    refreshCurveEditor();
    if (reset) frameCurrentEffect(effect);
    rebuildSimulation(reset);
}

function saveCachedEffects(): void {
    if (!currentPayload) return;
    const changed = dirtyEffectIndices();
    if (!changed.length) {
        setDirtyState(false);
        return;
    }
    vscode.postMessage({
        command: 'saveEffects',
        selectedEffectIndex: currentEffectIndex,
        effects: currentPayload.effects,
        dirtyEffectIndices: changed,
    });
}

function loadSelectedEffect(): void {
    if (!currentPayload || pendingEffectIndex === currentEffectIndex) return;
    currentEffectIndex = Math.min(pendingEffectIndex, Math.max(0, currentPayload.effects.length - 1));
    pendingEffectIndex = currentEffectIndex;
    currentPayload.selectedEffectIndex = currentEffectIndex;
    currentSubsystemIndex = 0;
    currentCurveIndex = 0;
    currentForceIndex = 0;
    vscode.postMessage({ command: 'selectEffect', index: currentEffectIndex });
    refreshAll();
    updateEditButtons();
}

function cloneEffectValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function addSubsystem(): void {
    const effect = currentEffect();
    if (!effect) return;
    pushHistorySnapshot();
    effect.subsystems.push(createDefaultSubsystem(`subsystem_${effect.subsystems.length + 1}`));
    currentSubsystemIndex = effect.subsystems.length - 1;
    finishCommittedEdit();
    refreshAll();
}

function cloneSubsystem(): void {
    const effect = currentEffect();
    const source = effect?.subsystems[currentSubsystemIndex];
    if (!effect || !source) return;
    pushHistorySnapshot();
    const clone = cloneEffectValue(source);
    clone.name = `${clone.name ?? 'subsystem'}_copy`;
    effect.subsystems.splice(currentSubsystemIndex + 1, 0, clone);
    currentSubsystemIndex++;
    finishCommittedEdit();
    refreshAll();
}

function moveSubsystem(delta: number): void {
    const effect = currentEffect();
    if (!effect) return;
    const nextIndex = currentSubsystemIndex + delta;
    if (nextIndex < 0 || nextIndex >= effect.subsystems.length) return;
    pushHistorySnapshot();
    const [item] = effect.subsystems.splice(currentSubsystemIndex, 1);
    if (!item) return;
    effect.subsystems.splice(nextIndex, 0, item);
    currentSubsystemIndex = nextIndex;
    finishCommittedEdit();
    refreshAll();
}

function removeSubsystem(): void {
    const effect = currentEffect();
    if (!effect || effect.subsystems.length === 0) return;
    pushHistorySnapshot();
    effect.subsystems.splice(currentSubsystemIndex, 1);
    currentSubsystemIndex = Math.max(0, currentSubsystemIndex - 1);
    finishCommittedEdit();
    refreshAll();
}

function addCurve(): void {
    const effect = currentEffect();
    if (!effect) return;
    pushHistorySnapshot();
    effect.animations.push(createDefaultCurve(`curve_${effect.animations.length + 1}`));
    currentCurveIndex = effect.animations.length - 1;
    finishCommittedEdit();
    refreshAll(false);
}

function removeCurve(): void {
    const effect = currentEffect();
    if (!effect || effect.animations.length === 0) return;
    pushHistorySnapshot();
    effect.animations.splice(currentCurveIndex, 1);
    currentCurveIndex = Math.max(0, currentCurveIndex - 1);
    finishCommittedEdit();
    refreshAll(false);
}

function addForce(): void {
    const effect = currentEffect();
    if (!effect) return;
    pushHistorySnapshot();
    effect.forces.push(createDefaultForce(`force_${effect.forces.length + 1}`));
    currentForceIndex = effect.forces.length - 1;
    finishCommittedEdit();
    refreshAll(false);
}

function removeForce(): void {
    const effect = currentEffect();
    const index = currentForceIndex;
    if (!effect || !Number.isInteger(index) || index < 0 || index >= effect.forces.length) return;
    pushHistorySnapshot();
    effect.forces.splice(index, 1);
    currentForceIndex = Math.max(0, currentForceIndex - 1);
    finishCommittedEdit();
    refreshAll(false);
}

function handleMessage(event: MessageEvent): void {
    const message = event.data;
    if (!message?.command) return;
    switch (message.command) {
        case 'render': {
            const previousSubsystem = currentSubsystemIndex;
            const previousCurve = currentCurveIndex;
            const previousForce = currentForceIndex;
            currentPayload = {
                effects: message.effects ?? [],
                diagnostics: message.diagnostics ?? [],
                fileName: message.fileName ?? 'particle.asset',
                selectedEffectIndex: message.selectedEffectIndex ?? 0,
                textures: message.textures ?? {},
                textureCandidates: message.textureCandidates ?? [],
                readonly: !!message.readonly,
            };
            currentEffectIndex = Math.min(currentPayload.selectedEffectIndex, Math.max(0, currentPayload.effects.length - 1));
            currentPayload.selectedEffectIndex = currentEffectIndex;
            pendingEffectIndex = currentEffectIndex;
            const effect = currentPayload.effects[currentEffectIndex];
            currentSubsystemIndex = Math.min(previousSubsystem, Math.max(0, (effect?.subsystems.length ?? 1) - 1));
            currentCurveIndex = Math.min(previousCurve, Math.max(0, (effect?.animations.length ?? 1) - 1));
            currentForceIndex = Math.min(previousForce, Math.max(0, (effect?.forces.length ?? 1) - 1));
            savedEffectsBaseline = cloneEffectValue(currentPayload.effects);
            undoStack = [];
            redoStack = [];
            textureRequestId++;
            setDirtyState(false);
            refreshAll();
            break;
        }
        case 'textures':
            if (currentPayload) {
                if (message.requestId !== textureRequestId) break;
                currentPayload.textures = message.textures ?? {};
                if (simulation) particleRenderer.setSystems(simulation.systems, currentPayload.textures);
            }
            break;
        case 'saved':
            if (currentPayload) {
                currentPayload.fileName = message.fileName ?? currentPayload.fileName;
                currentPayload.selectedEffectIndex = message.selectedEffectIndex ?? currentEffectIndex;
                currentPayload.textures = message.textures ?? currentPayload.textures;
                currentPayload.textureCandidates = message.textureCandidates ?? currentPayload.textureCandidates;
                currentPayload.readonly = !!message.readonly;
                currentEffectIndex = Math.min(currentPayload.selectedEffectIndex, Math.max(0, currentPayload.effects.length - 1));
                currentPayload.selectedEffectIndex = currentEffectIndex;
                pendingEffectIndex = currentEffectIndex;
                savedEffectsBaseline = cloneEffectValue(currentPayload.effects);
                textureRequestId++;
                setDirtyState(false);
                refreshAll(false);
            }
            break;
        case 'dispose':
            disposeAll();
            break;
    }
}

window.addEventListener('message', handleMessage);
window.addEventListener('resize', handleResize);
document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || isTextEditingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoCachedEdit();
        else undoCachedEdit();
    } else if (key === 'y') {
        event.preventDefault();
        redoCachedEdit();
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        playing = false;
        updatePlayButton();
    }
});

effectSelect.addEventListener('change', () => {
    pendingEffectIndex = Number(effectSelect.value) || 0;
    updateEditButtons();
});
loadEffectButton.addEventListener('click', loadSelectedEffect);
subsystemSelect.addEventListener('change', () => {
    currentSubsystemIndex = Number(subsystemSelect.value) || 0;
    refreshInspector();
    if (hideOtherSubsystems) rebuildSimulation(false);
    refreshEmitterVisuals();
});
curveSelect.addEventListener('change', () => {
    currentCurveIndex = Number(curveSelect.value) || 0;
    refreshCurveEditor();
    refreshInspector();
    refreshForceInspector();
});
forceSelect.addEventListener('change', () => {
    currentForceIndex = Number(forceSelect.value) || 0;
    refreshForceInspector();
});
saveButton.addEventListener('click', saveCachedEffects);
undoButton.addEventListener('click', undoCachedEdit);
redoButton.addEventListener('click', redoCachedEdit);
document.getElementById('btn-open')?.addEventListener('click', () => vscode.postMessage({ command: 'openFile' }));
document.getElementById('btn-close')?.addEventListener('click', () => vscode.postMessage({ command: 'close' }));
hideOthersToggle.addEventListener('change', () => {
    hideOtherSubsystems = hideOthersToggle.checked;
    rebuildSimulation(false);
});
emitterVisualsToggle.addEventListener('change', refreshEmitterVisuals);
document.getElementById('btn-add-subsystem')?.addEventListener('click', addSubsystem);
document.getElementById('btn-clone-subsystem')?.addEventListener('click', cloneSubsystem);
document.getElementById('btn-move-up')?.addEventListener('click', () => moveSubsystem(-1));
document.getElementById('btn-move-down')?.addEventListener('click', () => moveSubsystem(1));
document.getElementById('btn-remove-subsystem')?.addEventListener('click', removeSubsystem);
document.getElementById('btn-add-curve')?.addEventListener('click', addCurve);
document.getElementById('btn-remove-curve')?.addEventListener('click', removeCurve);
document.getElementById('btn-add-force')?.addEventListener('click', addForce);
document.getElementById('btn-remove-force')?.addEventListener('click', removeForce);
playButton.addEventListener('click', () => {
    playing = !playing;
    updatePlayButton();
});
restartButton.addEventListener('click', () => {
    seekTo(0);
});
scrub.addEventListener('input', () => {
    seekTo(Number(scrub.value) / 1000 * playbackDurationSeconds);
});
document.getElementById('btn-screenshot')?.addEventListener('click', () => {
    const data = glRenderer.domElement.toDataURL('image/png').split(',')[1] ?? '';
    vscode.postMessage({ command: 'screenshot', data });
});

function disposeAll(): void {
    window.clearTimeout(curveHistoryTimer);
    curveEditor?.dispose();
    curveEditor = null;
    particleRenderer?.dispose();
    disposeEmitterVisuals();
    controls?.dispose();
    bloomPass?.dispose();
    outputPass?.dispose();
    composer?.dispose();
    if (animationId) cancelAnimationFrame(animationId);
    glRenderer?.dispose();
    glRenderer?.forceContextLoss();
    glRenderer?.domElement.remove();
}

initThree();

window.addEventListener('beforeunload', () => {
    disposeAll();
});
