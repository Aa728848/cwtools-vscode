import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ParticleEffect, ParticleRenderPayload, Scalar } from './particleTypes';
import { isRange } from './particleTypes';
import { ParticleEffectSimulation } from './particleSimulation';
import { ParticleRenderer } from './particleRenderer';
import { CurveEditor } from './curveEditor';
import { createDefaultCurve, createDefaultForce, createDefaultSubsystem, ParticleInspector } from './inspector';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

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

let glRenderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
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
let currentSubsystemIndex = 0;
let currentCurveIndex = 0;
let currentForceIndex = 0;
let dirty = false;
let hideOtherSubsystems = false;
let curveEditor: CurveEditor | null = null;
let curveSaveTimer = 0;

const inspector = new ParticleInspector(inspectorRoot);
const forceInspector = new ParticleInspector(forceInspectorRoot);

function cssColor(variable: string, fallback: string): string {
    return getComputedStyle(document.body).getPropertyValue(variable).trim() || fallback;
}

function initThree(): void {
    glRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    glRenderer.setPixelRatio(window.devicePixelRatio);
    glRenderer.outputColorSpace = THREE.SRGBColorSpace;
    viewport.append(glRenderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color().setStyle(cssColor('--vscode-editor-background', '#1e1e1e'));
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
    glRenderer.render(scene, camera);
    updateTimelineControls();
    animationId = requestAnimationFrame(animate);
}

function handleResize(): void {
    const rect = viewport.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    glRenderer.setSize(width, height, false);
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
    return isRange(value) ? value.b.value : value.value;
}

function computePlaybackDuration(effect: ParticleEffect | undefined): number {
    if (!effect) return 20;
    let maxTime = 0;
    for (const subsystem of effect.subsystems) {
        const start = scalarBaseValue(subsystem.start, 0);
        const duration = scalarBaseValue(subsystem.duration, 4);
        const life = scalarBaseValue(subsystem.life, 1);
        maxTime = Math.max(maxTime, start + (duration >= 0 ? duration : 8) + Math.max(0.1, life));
    }
    return Math.max(1, Math.min(60, maxTime || 20));
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

function getByPath(root: unknown, path: Array<string | number>): unknown {
    let current: unknown = root;
    for (const segment of path) {
        if (current === undefined || current === null) return undefined;
        current = (current as Record<string, unknown>)[String(segment)];
    }
    return current;
}

function hasSpan(value: unknown): boolean {
    return !!(value as { span?: unknown } | undefined)?.span;
}

function fieldPathHasSourceSpan(effect: ParticleEffect, path: Array<string | number>): boolean {
    const current = getByPath(effect, path);
    if (hasSpan(current)) return true;
    if (path.length === 0) return false;

    const parentPath = path.slice(0, -1);
    const key = String(path[path.length - 1]);
    const parent = getByPath(effect, parentPath) as { spans?: Record<string, unknown> } | undefined;
    if (parent?.spans?.[key]) return true;

    if (path.length >= 2) {
        const containerPath = path.slice(0, -2);
        const aggregateKey = String(path[path.length - 2]);
        const container = getByPath(effect, containerPath) as { spans?: Record<string, unknown> } | undefined;
        if (container?.spans?.[aggregateKey]) return true;
    }
    return false;
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

function markDirty(): void {
    dirty = true;
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
        const x = Math.max(0.1, Math.abs(scalarBaseValue(subsystem.boxEmitterX, 1)) * 2);
        const y = Math.max(0.1, Math.abs(scalarBaseValue(subsystem.boxEmitterY, 1)) * 2);
        const z = Math.max(0.1, Math.abs(scalarBaseValue(subsystem.boxEmitterZ, 1)) * 2);
        geometry = new THREE.BoxGeometry(x, y, z);
    } else {
        const radius = subsystem.emitterType === 'sphere'
            ? Math.max(0.1, Math.abs(scalarBaseValue(subsystem.sphereEmitterRadius, 1)))
            : 0.18;
        geometry = new THREE.SphereGeometry(radius, 24, 12);
    }
    const helper = new THREE.Mesh(geometry, material);
    helper.position.set(
        scalarBaseValue(subsystem.position?.x, 0),
        scalarBaseValue(subsystem.position?.y, 0),
        scalarBaseValue(subsystem.position?.z, 0),
    );
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
    effectSelect.value = String(currentEffectIndex);
    effectRow.classList.toggle('hidden', payload.effects.length <= 1);

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

function handleFieldEdit(path: Array<string | number>, value: unknown, options?: { reload?: boolean }): void {
    const effect = currentEffect();
    if (!effect) return;
    const canPatchField = fieldPathHasSourceSpan(effect, path);
    setByPath(effect, path, value);
    dirty = true;
    if (fieldEditNeedsSimulationRebuild(path)) rebuildSimulation(false);
    else if (fieldEditChangesEmitterVisuals(path)) refreshEmitterVisuals();
    if (fieldEditChangesSelectors(path)) refreshSelectors();
    refreshInspector();
    refreshForceInspector();
    if (canPatchField) {
        vscode.postMessage({ command: 'fieldEdit', effectIndex: currentEffectIndex, path, value, reload: !!options?.reload });
    } else {
        saveCurrentEffect();
    }
}

function inspectorCallbacks() {
    return {
        onDirty: markDirty,
        onFieldEdit: handleFieldEdit,
    };
}

function refreshInspector(): void {
    inspector.render(currentEffect(), currentSubsystemIndex, inspectorCallbacks());
}

function refreshForceInspector(): void {
    forceInspector.renderForce(currentEffect(), currentForceIndex, inspectorCallbacks());
}

function refreshCurveEditor(): void {
    const effect = currentEffect();
    const curve = effect?.animations[currentCurveIndex];
    curveEditor?.dispose();
    curveEditor = new CurveEditor(curveCanvas, points => {
        const current = currentEffect()?.animations[currentCurveIndex];
        if (!current) return;
        current.points = points;
        dirty = true;
        window.clearTimeout(curveSaveTimer);
        curveSaveTimer = window.setTimeout(() => saveCurrentEffect(), 250);
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
    rebuildSimulation(reset);
}

function saveCurrentEffect(): void {
    const effect = currentEffect();
    if (!effect) return;
    vscode.postMessage({ command: 'replaceEffect', effectIndex: currentEffectIndex, effect });
    dirty = false;
}

function cloneEffectValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function addSubsystem(): void {
    const effect = currentEffect();
    if (!effect) return;
    effect.subsystems.push(createDefaultSubsystem(`subsystem_${effect.subsystems.length + 1}`));
    currentSubsystemIndex = effect.subsystems.length - 1;
    dirty = true;
    refreshAll();
    saveCurrentEffect();
}

function cloneSubsystem(): void {
    const effect = currentEffect();
    const source = effect?.subsystems[currentSubsystemIndex];
    if (!effect || !source) return;
    const clone = cloneEffectValue(source);
    clone.name = `${clone.name ?? 'subsystem'}_copy`;
    effect.subsystems.splice(currentSubsystemIndex + 1, 0, clone);
    currentSubsystemIndex++;
    dirty = true;
    refreshAll();
    saveCurrentEffect();
}

function moveSubsystem(delta: number): void {
    const effect = currentEffect();
    if (!effect) return;
    const nextIndex = currentSubsystemIndex + delta;
    if (nextIndex < 0 || nextIndex >= effect.subsystems.length) return;
    const [item] = effect.subsystems.splice(currentSubsystemIndex, 1);
    if (!item) return;
    effect.subsystems.splice(nextIndex, 0, item);
    currentSubsystemIndex = nextIndex;
    dirty = true;
    refreshAll();
    saveCurrentEffect();
}

function removeSubsystem(): void {
    const effect = currentEffect();
    if (!effect || effect.subsystems.length === 0) return;
    effect.subsystems.splice(currentSubsystemIndex, 1);
    currentSubsystemIndex = Math.max(0, currentSubsystemIndex - 1);
    dirty = true;
    refreshAll();
    saveCurrentEffect();
}

function addCurve(): void {
    const effect = currentEffect();
    if (!effect) return;
    effect.animations.push(createDefaultCurve(`curve_${effect.animations.length + 1}`));
    currentCurveIndex = effect.animations.length - 1;
    dirty = true;
    refreshAll(false);
    saveCurrentEffect();
}

function removeCurve(): void {
    const effect = currentEffect();
    if (!effect || effect.animations.length === 0) return;
    effect.animations.splice(currentCurveIndex, 1);
    currentCurveIndex = Math.max(0, currentCurveIndex - 1);
    dirty = true;
    refreshAll(false);
    saveCurrentEffect();
}

function addForce(): void {
    const effect = currentEffect();
    if (!effect) return;
    effect.forces.push(createDefaultForce(`force_${effect.forces.length + 1}`));
    currentForceIndex = effect.forces.length - 1;
    dirty = true;
    refreshAll(false);
    saveCurrentEffect();
}

function removeForce(): void {
    const effect = currentEffect();
    const index = currentForceIndex;
    if (!effect || !Number.isInteger(index) || index < 0 || index >= effect.forces.length) return;
    effect.forces.splice(index, 1);
    currentForceIndex = Math.max(0, currentForceIndex - 1);
    dirty = true;
    refreshAll(false);
    saveCurrentEffect();
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
                readonly: !!message.readonly,
            };
            currentEffectIndex = currentPayload.selectedEffectIndex;
            const effect = currentPayload.effects[currentEffectIndex];
            currentSubsystemIndex = Math.min(previousSubsystem, Math.max(0, (effect?.subsystems.length ?? 1) - 1));
            currentCurveIndex = Math.min(previousCurve, Math.max(0, (effect?.animations.length ?? 1) - 1));
            currentForceIndex = Math.min(previousForce, Math.max(0, (effect?.forces.length ?? 1) - 1));
            dirty = false;
            refreshAll();
            break;
        }
        case 'dispose':
            disposeAll();
            break;
    }
}

window.addEventListener('message', handleMessage);
window.addEventListener('resize', handleResize);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        playing = false;
        updatePlayButton();
    }
});

effectSelect.addEventListener('change', () => {
    currentEffectIndex = Number(effectSelect.value) || 0;
    currentSubsystemIndex = 0;
    vscode.postMessage({ command: 'selectEffect', index: currentEffectIndex });
});
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
document.getElementById('btn-save')?.addEventListener('click', saveCurrentEffect);
document.getElementById('btn-undo')?.addEventListener('click', () => vscode.postMessage({ command: 'undo' }));
document.getElementById('btn-redo')?.addEventListener('click', () => vscode.postMessage({ command: 'redo' }));
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
    window.clearTimeout(curveSaveTimer);
    curveEditor?.dispose();
    curveEditor = null;
    particleRenderer?.dispose();
    disposeEmitterVisuals();
    controls?.dispose();
    if (animationId) cancelAnimationFrame(animationId);
    glRenderer?.dispose();
    glRenderer?.forceContextLoss();
    glRenderer?.domElement.remove();
}

initThree();

window.addEventListener('beforeunload', () => {
    if (dirty) saveCurrentEffect();
    disposeAll();
});
