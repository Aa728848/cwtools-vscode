/**
 * Global Ship Design Workbench Webview entry point.
 *
 * Validates all Host responses at the protocol boundary (bounding recursive
 * `attach` asset trees to `depth < 32`), drives the Three.js `ShipDesignScene`,
 * and dispatches typed user edit intents back to `ShipDesignPanel` without
 * holding filesystem write paths in the sandbox.
 */
import {
    fields, isArrayOf, isBoolean, isFiniteNumber, isIntegerInRange, isOneOf, isRecord,
    isString, isStringArray, optional, parseProtocolMessage, type MessageValidator, type ValueValidator,
} from '../shared/protocolValidation';
import {
    isShipDesignStatValue,
    type ShipDesignData, type ShipDesignDocumentSnapshot, type ShipDesignIconData,
    type ShipDesignOperation, type ShipDesignRequest, type ShipDesignRequiredSlotData, type ShipDesignResponse, type ShipDesignSlotData,
    type ShipDesignStatValue, type ShipDesignStatsData, type ShipDesignTechnologyScope, type ShipDesignViewData,
} from '../shared/shipDesignProtocol';
import { createShipDesignScene, type ShipDesignSceneSelection } from './shipDesignScene';

// Keep host messages at a validated boundary before passing data into the UI or renderer.
const object = (validate: MessageValidator): ValueValidator => value => isRecord(value) && validate(value);
const dictionary = (validate: ValueValidator): ValueValidator => value =>
    isRecord(value) && Object.values(value).every(validate);
const textOrBoolean = (value: unknown): boolean => isString(value) || isBoolean(value);
const nonnegative = isIntegerInRange(0, Number.MAX_SAFE_INTEGER);
const lineNumber = isIntegerInRange(1, Number.MAX_SAFE_INTEGER);
const range = object(fields({ start: nonnegative, end: nonnegative, startLine: lineNumber, endLine: lineNumber }));
const diagnostic = object(fields({ severity: isOneOf(['info', 'warning', 'error']), code: isString, message: isString }, {
    designId: isString, sectionId: isString, slotId: isString, source: range,
}));
const component = object(fields({ id: isString, slot: isString, template: isString, source: range }));
const section = object(fields({
    id: isString, designId: isString, occurrence: nonnegative, slot: isString, template: isString,
    components: isArrayOf(component), source: range,
}));
const design = object(fields({
    id: isString, occurrence: nonnegative, name: isString, sections: isArrayOf(section), requiredComponents: isStringArray,
    growthStageCount: nonnegative, metadata: dictionary(textOrBoolean), source: range,
}, { shipSize: isString, graphicalCulture: isString, roles: isString, loadoutReadOnlyReason: isString }));
const icon = object(fields({ key: isString, frame: lineNumber, frames: lineNumber }, { uri: isString, width: isFiniteNumber, height: isFiniteNumber }));
const slot = object(fields({
    id: isString, sectionId: isString, name: isString, kind: isOneOf(['weapon', 'utility', 'strike_craft', 'unknown']),
    size: isString, template: isString, componentTypes: isStringArray, fixed: isBoolean, compatible: isBoolean,
    reasons: isStringArray,
}, { locator: isString, selected: isString, icon, position: object(fields({}, { x: isFiniteNumber, y: isFiniteNumber, rotation: isFiniteNumber })) }));
const requiredSlot = object(fields({ id: isString, editable: isBoolean }, { componentSet: isString, selected: isString, icon }));
const modelNode = object(fields({ id: isString, kind: isOneOf(['root', 'section', 'component']), warnings: isStringArray }, {
    entityName: isString, meshFile: isString, parentId: isString, locatorName: isString, sectionId: isString, slotId: isString,
}));
const documentState = { dirty: isBoolean, saving: isBoolean, canUndo: isBoolean, canRedo: isBoolean };
const candidates = isArrayOf(object(fields({ key: isString, label: isString, compatible: isBoolean, reasons: isStringArray }, {
    icon: optional(icon), tier: optional(lineNumber), upgradesTo: optional(isString), origin: optional(isOneOf(['vanilla', 'mod'])),
})));
const vector = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
const assetFields = fields({
    name: isString,
    locators: isArrayOf(object(fields({ name: isString }, {
        position: vector, rotation: vector, scale: isFiniteNumber, parentJoint: isString,
    }))),
    meshSettings: isArrayOf(object(fields({}, {
        index: isFiniteNumber, name: isString, textureDiffuse: isString, textureNormal: isString,
        textureSpecular: isString, shader: isString,
    }))),
    textureMap: dictionary(isString),
}, { meshUri: isString, meshBase64: isString, scale: isFiniteNumber });
function isModelAsset(value: unknown, depth = 0): boolean {
    return depth < 32 && isRecord(value) && assetFields(value)
        && isArrayOf(object(fields({ locatorName: isString, entity: entity => isModelAsset(entity, depth + 1) })))(value.attaches);
}
const environmentBackground = object(fields({
    texturePath: isString, ycocg: isBoolean, label: isString,
}, { textureUri: isString, trigger: isString }));
const environmentPreset = object(fields({
    id: isString, fileName: isString, backgrounds: isArrayOf(environmentBackground),
}, {
    backgroundHsvShift: vector, backgroundLutUri: isString, colorLutUri: isString, environmentMapUri: isString,
    cubemapIntensity: isFiniteNumber, ambientHsv: vector, camLight1Hsv: vector, camLight2Hsv: vector,
    camLight3Hsv: vector, rimLightHsv: vector, systemBackLightHsv: vector,
    tonemapMiddleGrey: isFiniteNumber, tonemapWhiteLuminance: isFiniteNumber,
}));
const responseValidators: Record<ShipDesignResponse['type'], MessageValidator> = {
    snapshot: fields({ snapshot: object(fields({
        ...documentState, documentVersion: nonnegative, generation: nonnegative,
        designs: isArrayOf(design), diagnostics: isArrayOf(diagnostic),
    }, { selectedDesignId: isString })) }),
    'document-state': fields({ ...documentState, saved: isBoolean }),
    'slot-candidates': fields({ sectionId: isString, slot: isString, candidates }),
    'section-candidates': fields({ designId: isString, sectionSlot: isString, candidates }),
    'required-candidates': fields({ designId: isString, slotId: isString, candidates }),
    'compatible-slots': fields({ designId: isString, componentKey: isString, slotIds: isStringArray }),
    'workspace-designs': fields({ designs: isArrayOf(object(fields({ uri: isString, designId: isString, name: isString, displayName: isString, filePath: isString, selected: isBoolean, current: isBoolean }))) }),
    'catalog-options': fields({ shipSizes: isStringArray, cultures: isStringArray, roles: isStringArray, technologies: isStringArray, displayNames: dictionary(isString) }),
    environments: fields({ presets: isArrayOf(environmentPreset) }, { workerUri: isString }),
    'model-asset': fields({ generation: nonnegative, nodeId: isString }, { asset: isModelAsset, error: isString }),
    view: fields({ view: object(fields({
        designId: isString, shipSize: isString, culture: isString, cultures: isStringArray, roles: isStringArray,
        availableSectionSlots: isStringArray, model: isArrayOf(modelNode), requiredSlots: isArrayOf(requiredSlot), diagnostics: isArrayOf(diagnostic),
        sections: isArrayOf(object(fields({ section, entity: isString, shouldDrawComponents: isBoolean, slots: isArrayOf(slot) }))),
    }, { assetRevision: nonnegative })) }),
    stats: fields({ stats: object(fields({ designId: isString, values: dictionary(isShipDesignStatValue), resources: dictionary(isShipDesignStatValue) })) }),
    'generation-explanation': fields({ designId: isString, lines: isStringArray }),
    error: fields({ message: isString }),
};

const locale = document.documentElement.lang || navigator.language || 'en';
const zh = locale.toLowerCase().startsWith('zh');
const tr = (en: string, cn: string): string => zh ? cn : en;
const numberFormat = new Intl.NumberFormat(zh ? 'zh-CN' : 'en', { maximumFractionDigits: 5 });
const emptyLabel = tr('Empty', '空');
const unspecified = tr('Not set', '未设置');
const pendingLabel = tr('Loading…', '加载中…');
const modeLabels = {
    preview: tr('Preview', '预览'), inspect: tr('Inspect', '检查'), edit: tr('Edit', '编辑'),
};
const slotKinds: Record<ShipDesignSlotData['kind'], string> = {
    weapon: tr('Weapon', '武器'), utility: tr('Utility', '辅助'), strike_craft: tr('Strike craft', '舰载机'),
    unknown: tr('Unknown slot', '未知槽位'),
};

const statLabels: Record<string, string> = {
    buildTime: tr('Build time', '建造时间'), hull: tr('Hull', '船体'), armor: tr('Armor', '护甲'),
    shields: tr('Shields', '护盾'), evasion: tr('Evasion', '闪避'), speed: tr('Speed', '速度'),
    power: tr('Power', '能量'), sensorRange: tr('Sensor range', '探测范围'), damagePerDay: tr('Damage per day', '日均伤害'),
};
const resourceLabels: Record<string, string> = {
    alloys: tr('Alloys', '合金'), energy: tr('Energy', '能量'), minerals: tr('Minerals', '矿物'),
    food: tr('Food', '食物'), consumer_goods: tr('Consumer goods', '消费品'), exotic_gases: tr('Exotic gases', '异星天然气'),
    rare_crystals: tr('Rare crystals', '稀有水晶'), volatile_motes: tr('Volatile motes', '易爆微粒'),
    dark_matter: tr('Dark matter', '暗物质'), living_metal: tr('Living metal', '活金属'),
};
function displayStatKey(key: string): string {
    if (key.startsWith('cost.')) return tr('Cost', '花费') + ' · ' + displayStatKey(key.slice(5));
    if (key.startsWith('upkeep.')) return tr('Upkeep', '维护费') + ' · ' + displayStatKey(key.slice(7));
    return statLabels[key] ?? resourceLabels[key] ?? key;
}

function slotSizeLabel(size: string): string {
    const labels: Record<string, string> = {
        small: 'S', medium: 'M', large: 'L', aux: 'A', extra_large: 'XL', titanic: 'T',
        torpedo: 'G', point_defence: 'P', strike_craft: 'H', planet_killer: 'PK',
    };
    return labels[size] ?? size.slice(0, 1).toUpperCase();
}

function applySlotIcon(element: HTMLElement, icon?: ShipDesignIconData): void {
    if (!icon?.uri) return;
    const uri = icon.uri.replace(/["\\\r\n]/g, '');
    element.style.backgroundImage = 'url("' + uri + '")';
    if (icon.frames <= 1) {
        element.style.backgroundSize = 'contain';
        element.style.backgroundPosition = 'center';
        return;
    }
    const frameWidth = icon.width ? icon.width / icon.frames : 1;
    const ratio = icon.height && frameWidth ? icon.height / frameWidth : 1;
    element.style.backgroundSize = icon.frames * 100 + '% ' + ratio * 100 + '%';
    element.style.backgroundPosition = (icon.frame - 1) / Math.max(1, icon.frames - 1) * 100 + '% 0%';
}

type Mode = keyof typeof modeLabels;
type Panel = 'navigation' | 'inspector';
type Gate = 'document' | 'design';
type Candidate = Extract<ShipDesignResponse, { type: 'slot-candidates' }>['candidates'][number];
type CandidateTarget =
    | { kind: 'component'; slot: ShipDesignSlotData }
    | { kind: 'section'; designId: string; sectionSlot: string; sectionId?: string }
    | { kind: 'required'; designId: string; slot: ShipDesignRequiredSlotData };
interface Picker {
    target: CandidateTarget;
    includeIncompatible: boolean;
    pending: boolean;
    items?: Candidate[];
}

const panels = {
    navigation: { default: 250, min: 188, max: 380 },
    inspector: { default: 344, min: 260, max: 460 },
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function button(text: string, action: () => void, className = '', gate?: Gate): HTMLButtonElement {
    const element = node('button', className, text);
    element.type = 'button';
    element.onclick = action;
    if (gate) element.dataset.gate = gate;
    return element;
}

function options(select: HTMLSelectElement, items: ReadonlyArray<{ value: string; label: string }>, value = ''): void {
    select.replaceChildren(...items.map(item => {
        const option = node('option', '', item.label);
        option.value = item.value;
        return option;
    }));
    select.value = value;
}

function keys(items: string[]): Array<{ value: string; label: string }> {
    return items.map(value => ({ value, label: value }));
}

function field(text: string, input: HTMLElement, className = 'sd-field'): HTMLLabelElement {
    const label = node('label', className);
    label.append(node('span', '', text), input);
    return label;
}

function checkbox(text: string, checked: boolean): { label: HTMLLabelElement; input: HTMLInputElement } {
    const input = node('input');
    input.type = 'checkbox';
    input.checked = checked;
    return { label: field(text, input, 'sd-checkbox'), input };
}

function list(text: string[]): HTMLUListElement {
    const element = node('ul', 'sd-text-list');
    for (const line of text) element.append(node('li', '', line));
    return element;
}

function note(text: string, className = ''): HTMLParagraphElement {
    return node('p', className ? 'sd-note ' + className : 'sd-note', text);
}

function splitKeys(text: string): string[] {
    return [...new Set(text.split(/[,\n]+/).map(item => item.trim()).filter(Boolean))];
}

function title(section: HTMLElement, text: string): HTMLElement {
    const group = node('section', 'sd-group');
    group.append(node('h3', '', text));
    section.append(group);
    return group;
}

function clampPanel(panel: Panel, width: unknown): number {
    const config = panels[panel];
    if (width === 0) return 0;
    return typeof width === 'number' && Number.isFinite(width)
        ? Math.max(config.min, Math.min(config.max, Math.round(width))) : config.default;
}

function mount(app: HTMLElement): void {
    const vscode = acquireVsCodeApi();
    const persisted = vscode.getState();
    const state = isRecord(persisted) ? persisted : {};
    let mode: Mode = state.mode === 'preview' || state.mode === 'edit' ? state.mode : 'inspect';
    const widths = {
        navigation: clampPanel('navigation', state.navigationWidth), inspector: clampPanel('inspector', state.inspectorWidth),
    };
    let showDesignBar = state.designBar !== false;
    const savedFilter = isRecord(state.libraryFilter) ? state.libraryFilter : {};
    const libraryFilter: { query: string; hideObsolete: boolean; hideVanilla: boolean; emptyOnly: boolean; tier: number; sort: 'name' | 'tier' } = {
        query: typeof savedFilter.query === 'string' ? savedFilter.query.slice(0, 200) : '',
        hideObsolete: savedFilter.hideObsolete !== false,
        hideVanilla: savedFilter.hideVanilla === true,
        emptyOnly: savedFilter.emptyOnly === true,
        tier: typeof savedFilter.tier === 'number' && Number.isInteger(savedFilter.tier) && savedFilter.tier >= 0 && savedFilter.tier <= 99 ? savedFilter.tier : 0,
        sort: savedFilter.sort === 'tier' ? 'tier' : 'name',
    };
    /** The component last clicked or dragged in the library; the fill button uses it. */
    let libraryChosenKey: string | undefined;
    /** Click-to-place: the component "held" by the cursor and the slots the Host says it can go into. */
    let armed: { key: string; icon?: ShipDesignIconData } | undefined;
    let placeableSlots = new Set<string>();
    /** Library target to re-create once the newly selected design's view arrives. */
    let libraryResume: CandidateTarget | undefined;
    let snapshot: ShipDesignDocumentSnapshot | undefined;
    let view: ShipDesignViewData | undefined;
    let stats: ShipDesignStatsData | undefined;
    let catalog: Extract<ShipDesignResponse, { type: 'catalog-options' }> | undefined;
    let workspaceDesigns: Extract<ShipDesignResponse, { type: 'workspace-designs' }> | undefined;
    let explanation: Extract<ShipDesignResponse, { type: 'generation-explanation' }> | undefined;
    let selection: ShipDesignSceneSelection = {};
    let picker: Picker | undefined;
    let pending: 'draft' | 'save' | 'history' | undefined;
    let dirty = false;
    let saving = false;
    let saved = false;
    let canUndo = false;
    let canRedo = false;

    const lifecycle = new AbortController();
    const listener = { signal: lifecycle.signal };
    const post = (message: ShipDesignRequest): void => vscode.postMessage(message);
    const selectedDesign = (): ShipDesignData | undefined => snapshot?.designs.find(item => item.id === snapshot?.selectedDesignId);
    const displayName = (key: string | undefined): string => key ? catalog?.displayNames[key] ?? key : '';
    const designLabel = (item: ShipDesignData): string => item.name
        ? displayName(item.name)
        : tr('Unnamed design', '未命名设计');
    const syntaxBlocked = (): boolean => snapshot?.diagnostics.some(item => item.severity === 'error') ?? false;
    const documentEditable = (): boolean => mode === 'edit' && !!snapshot && !saving && !pending && !syntaxBlocked();
    const designEditable = (): boolean => documentEditable() && !!selectedDesign() && !selectedDesign()?.loadoutReadOnlyReason;

    app.classList.add('sd-workbench');
    const toolbar = node('header', 'sd-toolbar');
    const brand = node('h1', 'sd-title', tr('Ship Design', '舰船设计'));
    const modeSwitch = node('div', 'sd-segment');
    modeSwitch.setAttribute('role', 'group');
    modeSwitch.setAttribute('aria-label', tr('Workbench mode', '工作台模式'));
    const modeButtons = {
        preview: button(modeLabels.preview, () => setMode('preview')),
        inspect: button(modeLabels.inspect, () => setMode('inspect')),
        edit: button(modeLabels.edit, () => setMode('edit')),
    };
    modeSwitch.append(modeButtons.preview, modeButtons.inspect, modeButtons.edit);
    const designSelect = node('select');
    designSelect.onchange = () => requestDesign(designSelect.value);
    const cultureSelect = node('select');
    cultureSelect.onchange = () => {
        if (cultureSelect.value && cultureSelect.value !== view?.culture) {
            post({ type: 'set-preview-culture', culture: cultureSelect.value });
        }
    };
    const undo = button(tr('Undo', '撤销'), () => history('undo'));
    const redo = button(tr('Redo', '重做'), () => history('redo'));
    const save = button(tr('Save', '保存'), () => {
        if (save.disabled) return;
        pending = 'save';
        syncControls();
        post({ type: 'save' });
    }, 'sd-primary');
    const discard = button(tr('Discard', '放弃更改'), () => confirmAction(
        tr('Discard unsaved changes?', '放弃未保存的更改？'),
        tr('The draft will be restored from the last saved contents.', '草稿将恢复到上次保存的内容。'),
        tr('Discard changes', '放弃更改'), () => { history('discard'); return true; },
    ));
    const documentStatus = node('span', 'sd-document-status', pendingLabel);
    documentStatus.setAttribute('role', 'status');
    const historyActions = node('div', 'sd-actions sd-history');
    historyActions.append(undo, redo, discard, save, documentStatus);
    const panelActions = node('div', 'sd-actions sd-panel-actions');
    const navigationToggle = button(tr('Design list', '设计列表'), () => {
        showDesignBar = !showDesignBar;
        syncLayout();
        persist();
    });
    const inspectorToggle = button(tr('Inspector', '检查器'), () => {
        if (mode === 'preview') {
            if (!widths.inspector) widths.inspector = panels.inspector.default;
            setMode('inspect');
        } else togglePanel('inspector');
    });
    navigationToggle.setAttribute('aria-controls', 'ship-design-bar');
    inspectorToggle.setAttribute('aria-controls', 'ship-design-inspector');
    panelActions.append(navigationToggle, inspectorToggle);
    toolbar.append(brand, modeSwitch,
        field(tr('Design', '设计'), designSelect, 'sd-toolbar-field'),
        field(tr('Preview culture', '预览文化'), cultureSelect, 'sd-toolbar-field'),
        historyActions, panelActions);

    const errorBanner = node('div', 'sd-error-banner');
    errorBanner.hidden = true;
    errorBanner.setAttribute('role', 'alert');
    const errorText = node('span');
    errorBanner.append(errorText, button(tr('Dismiss', '关闭'), () => setError()));

    const workspace = node('div', 'sd-workspace');
    const navigation = node('nav', 'sd-panel sd-navigation');
    navigation.id = 'ship-design-navigation';
    navigation.setAttribute('aria-label', tr('Add components', '增加部件'));
    navigation.hidden = true;
    const navHeader = node('div', 'sd-panel-header sd-library-header');
    const navHeaderTitle = node('h2', '', tr('Add components', '增加部件'));
    const libraryClose = button('✕', () => closeLibrary(), 'sd-library-close');
    libraryClose.title = tr('Close component library', '关闭组件库');
    libraryClose.setAttribute('aria-label', libraryClose.title);
    navHeader.append(navHeaderTitle, libraryClose);
    // Library controls are built once so typing in the search box keeps focus across list refreshes.
    const libraryTools = node('div', 'sd-library-tools');
    const libraryHint = node('p', 'sd-library-hint');
    const fillTarget = node('button', 'sd-fill-target', tr('Fill all', '填充全部'));
    fillTarget.type = 'button';
    fillTarget.dataset.gate = 'design';
    fillTarget.title = tr('Drop a component here, or click to use the highlighted one, to fill every compatible slot.',
        '把部件拖到这里，或点击使用当前高亮的部件，填充所有兼容槽位。');
    const libraryHintRow = node('div', 'sd-library-hint-row');
    libraryHintRow.append(libraryHint, fillTarget);
    const emptyOnly = checkbox(tr('Only empty slots', '仅填充空槽'), libraryFilter.emptyOnly);
    const hideObsolete = checkbox(tr('Hide obsolete components', '隐藏已被淘汰的部件'), libraryFilter.hideObsolete);
    const hideVanilla = checkbox(tr('Hide vanilla components', '隐藏原版部件'), libraryFilter.hideVanilla);
    const librarySearch = node('input');
    librarySearch.type = 'search';
    librarySearch.className = 'sd-library-search';
    librarySearch.placeholder = tr('Search name or key', '搜索名称或键');
    librarySearch.value = libraryFilter.query;
    const tierSelect = node('select');
    tierSelect.className = 'sd-library-tier';
    tierSelect.setAttribute('aria-label', tr('Tier', '等级'));
    const sortSelect = node('select');
    sortSelect.className = 'sd-library-sort';
    sortSelect.setAttribute('aria-label', tr('Sort', '排序'));
    options(sortSelect, [
        { value: 'name', label: tr('Sort by name', '按名称排序') },
        { value: 'tier', label: tr('Sort by tier', '按等级排序') },
    ], libraryFilter.sort);
    const libraryFilterRow = node('div', 'sd-library-filter-row');
    libraryFilterRow.append(librarySearch, tierSelect, sortSelect);
    const libraryCount = node('div', 'sd-library-count');
    libraryTools.append(libraryHintRow, emptyOnly.label, hideObsolete.label, hideVanilla.label, libraryFilterRow, libraryCount);
    const navScroll = node('div', 'sd-panel-scroll');
    navigation.append(navHeader, libraryTools, navScroll);

    const viewport = node('main', 'sd-center');
    const viewportHeader = node('div', 'sd-panel-header');
    const viewportCaption = node('span', 'sd-muted');
    viewportHeader.append(node('h2', '', tr('Ship model', '舰船模型')), viewportCaption);
    const sceneFrame = node('div', 'sd-scene-frame');
    const sceneHost = node('div', 'sd-scene');
    const strips = node('section', 'sd-strips');
    strips.setAttribute('aria-label', tr('Loadout slots', '配装槽位'));
    const requiredRail = node('section', 'sd-required-rail');
    requiredRail.setAttribute('aria-label', tr('Required components', '必需部件'));
    requiredRail.hidden = true;
    sceneFrame.append(sceneHost, strips, requiredRail);
    const designBar = node('section', 'sd-design-bar');
    designBar.id = 'ship-design-bar';
    designBar.setAttribute('aria-label', tr('Ship designs', '舰船设计'));
    viewport.append(sceneFrame, designBar);

    const inspector = node('aside', 'sd-panel sd-inspector');
    inspector.id = 'ship-design-inspector';
    inspector.setAttribute('aria-label', tr('Inspector', '检查器'));
    const inspectorHeader = node('div', 'sd-panel-header');
    inspectorHeader.append(node('h2', '', tr('Inspector', '检查器')));
    const inspectorScroll = node('div', 'sd-panel-scroll');
    const properties = node('div', 'sd-properties');
    const designBanner = node('div', 'sd-design-banner');
    const productionRegion = node('div');
    const statsRegion = node('div');
    const explanationRegion = node('div');
    inspectorScroll.append(designBanner, productionRegion, statsRegion, properties, explanationRegion);
    inspector.append(inspectorHeader, inspectorScroll);

    const modal = node('dialog', 'sd-dialog');
    modal.setAttribute('aria-labelledby', 'ship-design-dialog-title');
    const leftRail = resizeRail('navigation');
    const rightRail = resizeRail('inspector');
    workspace.append(navigation, leftRail, viewport, rightRail, inspector);
    const cursorIcon = node('div', 'sd-cursor-icon');
    cursorIcon.hidden = true;
    cursorIcon.setAttribute('aria-hidden', 'true');
    app.append(toolbar, errorBanner, workspace, modal, cursorIcon);

    const scene = createShipDesignScene(sceneHost, {
        onSelect(next) {
            if (next.slotId) {
                const selected = view?.sections.flatMap(item => item.slots).find(item => item.id === next.slotId);
                if (selected) {
                    if (armed) placeArmed(selected);
                    else selectSlot(selected);
                }
            } else {
                disarm();
                select(next);
            }
        },
        onError(message) {
            setError(message);
        },
    });
    const resizeObserver = new ResizeObserver(() => scene.resize());
    resizeObserver.observe(sceneHost);

    const treeRows = new Map<string, HTMLButtonElement[]>();
    function selectionRow(key: string, row: HTMLButtonElement): void {
        const rows = treeRows.get(key) ?? [];
        rows.push(row);
        treeRows.set(key, rows);
    }

    function renderSelection(): void {
        const selected = selection.slotId ?? selection.sectionId ?? '';
        for (const [key, rows] of treeRows) {
            for (const row of rows) row.setAttribute('aria-pressed', String(key === selected));
        }
        syncRequiredPressed();
        scene.setSelected(selection);
    }

    function persist(): void {
        vscode.setState({
            mode, navigationWidth: widths.navigation, inspectorWidth: widths.inspector,
            designBar: showDesignBar, libraryFilter: { ...libraryFilter },
        });
    }

    function syncLayout(): void {
        app.dataset.mode = mode;
        for (const panel of ['navigation', 'inspector'] as const) {
            app.style.setProperty('--sd-' + panel + '-width', widths[panel] + 'px');
        }
        inspector.hidden = !widths.inspector || mode === 'preview';
        designBar.hidden = !showDesignBar;
        leftRail.hidden = true;
        rightRail.hidden = inspector.hidden;
        navigationToggle.setAttribute('aria-expanded', String(showDesignBar));
        inspectorToggle.setAttribute('aria-expanded', String(!inspector.hidden));
        leftRail.setAttribute('aria-valuenow', String(widths.navigation));
        rightRail.setAttribute('aria-valuenow', String(widths.inspector));
        for (const key of ['preview', 'inspect', 'edit'] as const) {
            modeButtons[key].setAttribute('aria-pressed', String(mode === key));
        }
    }

    function resizeRail(panel: Panel): HTMLElement {
        const rail = node('div', 'sd-resize');
        rail.setAttribute('role', 'separator');
        rail.setAttribute('aria-orientation', 'vertical');
        rail.setAttribute('aria-label', panel === 'navigation' ? tr('Design tree width', '设计树宽度') : tr('Inspector width', '检查器宽度'));
        rail.setAttribute('aria-controls', 'ship-design-' + panel);
        rail.setAttribute('aria-valuemin', String(panels[panel].min));
        rail.setAttribute('aria-valuemax', String(panels[panel].max));
        rail.tabIndex = 0;
        const direction = panel === 'navigation' ? 1 : -1;
        let drag: { pointerId: number; x: number; width: number } | undefined;
        rail.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const shown = (panel === 'navigation' ? navigation : inspector).getBoundingClientRect().width;
            drag = { pointerId: event.pointerId, x: event.clientX, width: shown };
            rail.setPointerCapture(event.pointerId);
        }, listener);
        rail.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            widths[panel] = clampPanel(panel, Math.max(1, drag.width + (event.clientX - drag.x) * direction));
            syncLayout();
        }, listener);
        rail.addEventListener('lostpointercapture', event => {
            if (drag?.pointerId !== event.pointerId) return;
            drag = undefined;
            persist();
        }, listener);
        rail.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const delta = event.key === 'ArrowLeft' ? -16 : 16;
            widths[panel] = clampPanel(panel, widths[panel] + delta * direction);
            syncLayout();
            persist();
        }, listener);
        return rail;
    }

    function togglePanel(panel: Panel): void {
        widths[panel] = widths[panel] ? 0 : panels[panel].default;
        syncLayout();
        persist();
    }

    function setMode(next: Mode): void {
        if (mode === next) return;
        mode = next;
        syncLayout();
        persist();
        renderProperties();
    }

    function syncControls(): void {
        const busy = saving || !!pending;
        undo.disabled = mode !== 'edit' || busy || !canUndo;
        redo.disabled = mode !== 'edit' || busy || !canRedo;
        save.disabled = mode !== 'edit' || busy || !dirty || syntaxBlocked();
        discard.disabled = mode !== 'edit' || busy || !dirty;
        designSelect.disabled = !snapshot?.designs.length || busy;
        cultureSelect.disabled = !view?.cultures.length || busy;
        documentStatus.dataset.state = saving || pending === 'save' ? 'saving' : dirty ? 'dirty' : saved ? 'saved' : 'clean';
        documentStatus.textContent = saving || pending === 'save' ? tr('Saving…', '保存中…')
            : pending ? tr('Updating draft…', '正在更新草稿…')
            : dirty ? tr('Unsaved changes', '有未保存的更改')
            : saved ? tr('Saved', '已保存') : snapshot ? tr('No unsaved changes', '无未保存的更改') : pendingLabel;
        const doc = documentEditable();
        const editable = designEditable();
        for (const control of Array.from(app.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>('[data-gate]'))) {
            control.disabled = control.dataset.unavailable === 'true' || !(control.dataset.gate === 'document' ? doc : editable);
        }
    }

    function setError(message?: string): void {
        errorBanner.hidden = !message;
        errorText.textContent = message ?? '';
    }

    function requestDesign(id: string): void {
        if (!id || id === snapshot?.selectedDesignId || saving || pending) return;
        setError();
        post({ type: 'select-design', designId: id });
    }

    function apply(operation: ShipDesignOperation): boolean {
        if (!snapshot || !(operation.kind === 'create-design' ? documentEditable() : designEditable())) return false;
        setError();
        pending = 'draft';
        syncControls();
        post({ type: 'apply-operation', expectedVersion: snapshot.documentVersion, operation });
        return true;
    }

    function history(type: 'undo' | 'redo' | 'discard'): void {
        if (mode !== 'edit' || saving || pending) return;
        setError();
        pending = 'history';
        syncControls();
        post({ type });
    }

    function renderToolbar(): void {
        options(designSelect, snapshot?.designs.length
            ? snapshot.designs.map(item => ({ value: item.id, label: designLabel(item) }))
            : [{ value: '', label: tr('No designs', '暂无设计') }], snapshot?.selectedDesignId ?? '');
        if (view) {
            options(cultureSelect, keys([...new Set([view.culture, ...view.cultures].filter(Boolean))]), view.culture);
        } else options(cultureSelect, [{ value: '', label: unspecified }]);
        viewportCaption.textContent = [displayName(view?.shipSize), view?.culture].filter(Boolean).join(' · ');
        syncControls();
    }

    function renderModelUi(): void {
        treeRows.clear();
        navScroll.replaceChildren();
        strips.replaceChildren();
        const item = selectedDesign();
        navigation.hidden = !picker;
        app.dataset.library = picker ? 'open' : 'closed';
        renderDesignBar();

        if (view?.sections.length) {
            const topLayer = node('div', 'sd-slot-layer sd-slot-layer-top');
            const bottomLayer = node('div', 'sd-slot-layer sd-slot-layer-bottom');
            strips.append(topLayer, bottomLayer);
            const appendStrip = (target: HTMLElement, entry: ShipDesignViewData['sections'][number], slots: ShipDesignSlotData[], kind: string): void => {
                if (!slots.length) return;
                const strip = node('div', 'sd-strip sd-strip-' + kind);
                const caption = button(displayName(entry.section.template) || entry.section.slot || tr('Section', '分段'),
                    () => {
                        select({ sectionId: entry.section.id });
                        openPicker({ kind: 'section', designId: entry.section.designId, sectionSlot: entry.section.slot, sectionId: entry.section.id });
                    }, 'sd-strip-caption');
                caption.title = entry.section.template;
                selectionRow(entry.section.id, caption);
                const grid = node('div', 'sd-slot-grid');
                for (let start = 0; start < slots.length; start += 5) {
                    const row = node('div', 'sd-slot-row');
                    for (const slot of slots.slice(start, start + 5)) {
                        const chip = button('', () => armed ? placeArmed(slot) : selectSlot(slot), 'sd-chip');
                        chip.dataset.slotId = slot.id;
                        chip.classList.toggle('sd-placeable', !!armed && placeableSlots.has(slot.id));
                        chip.dataset.kind = slot.kind;
                        chip.dataset.size = slot.size;
                        chip.classList.toggle('sd-empty', !slot.selected);
                        chip.title = slot.selected ? slot.name + ' · ' + displayName(slot.selected) + ' (' + slot.selected + ')' : slot.name;
                        chip.setAttribute('aria-label', slot.name + ': ' + (slot.selected ? displayName(slot.selected) : emptyLabel));
                        const iconElement = node('span', 'sd-slot-icon');
                        applySlotIcon(iconElement, slot.icon);
                        const badge = node('span', 'sd-slot-size', slotSizeLabel(slot.size));
                        chip.append(iconElement, badge);
                        chip.addEventListener('dragover', event => {
                            if (!designEditable() || slot.fixed) return;
                            event.preventDefault();
                            chip.classList.add('sd-drop-active');
                        });
                        chip.addEventListener('dragleave', () => chip.classList.remove('sd-drop-active'));
                        chip.addEventListener('drop', event => {
                            event.preventDefault();
                            const key = consumeDraggedKey(event);
                            chip.classList.remove('sd-drop-active');
                            draggedComponentKey = undefined;
                            if (key) apply({ kind: 'drop-component', sectionId: slot.sectionId, slot: slot.name, template: key });
                        });
                        selectionRow(slot.id, chip);
                        row.append(chip);
                    }
                    grid.append(row);
                }
                strip.append(caption, grid);
                target.append(strip);
            };
            for (const entry of view.sections) {
                const weapons = entry.slots.filter(slot => slot.kind !== 'utility');
                const utilities = entry.slots.filter(slot => slot.kind === 'utility');
                appendStrip(topLayer, entry, weapons, 'weapons');
                appendStrip(bottomLayer, entry, utilities, 'utilities');
                if (!entry.slots.length) topLayer.append(note(tr('No component slots', '没有部件槽位')));
            }
        } else strips.append(note(item && !view ? pendingLabel : tr('No sections to display.', '没有可显示的分段。')));
        renderRequiredRail();
        if (picker) renderPicker();
        renderSelection();
        syncControls();
    }

    function select(next: ShipDesignSceneSelection): void {
        selection = next;
        picker = undefined;
        navigation.hidden = true;
        app.dataset.library = 'closed';
        renderSelection();
        renderProperties();
        inspectorScroll.scrollTop = 0;
    }

    function selectSlot(value: ShipDesignSlotData): void {
        if (selection.slotId === value.id && picker?.target.kind === 'component') return;
        select({ sectionId: value.sectionId, slotId: value.id });
        openPicker({ kind: 'component', slot: value });
        navScroll.scrollTop = 0;
    }

    /** Game-style design strip below the viewport: designs grouped by ship size, plus other workspace files. */
    function renderDesignBar(): void {
        designBar.replaceChildren();
        const item = selectedDesign();
        const designs = snapshot?.designs ?? [];
        const create = button('', () => designDialog(), 'sd-design-card sd-design-new', 'document');
        create.append(node('span', 'sd-design-card-name', tr('New design', '新设计')));
        create.dataset.unavailable = String(!catalog?.shipSizes.length);
        designBar.append(create);
        const groups = new Map<string, ShipDesignData[]>();
        for (const value of designs) {
            const size = value.shipSize ?? '';
            groups.set(size, [...groups.get(size) ?? [], value]);
        }
        for (const [shipSize, values] of groups) {
            const group = node('div', 'sd-design-group');
            group.append(node('div', 'sd-design-group-label', displayName(shipSize) || tr('Unknown size', '未知尺寸')));
            const cards = node('div', 'sd-design-cards');
            for (const value of values) {
                const card = button('', () => { if (value.id !== item?.id) requestDesign(value.id); }, 'sd-design-card');
                card.setAttribute('aria-pressed', String(value.id === item?.id));
                card.title = value.name;
                card.append(node('span', 'sd-design-card-name', designLabel(value)));
                card.append(node('span', 'sd-design-card-tag', value.metadata.auto_gen_design === true
                    ? tr('Auto-generated', '自动生成') : value.shipSize ? displayName(value.shipSize) : ''));
                cards.append(card);
            }
            group.append(cards);
            designBar.append(group);
        }
        if (!designs.length) designBar.append(note(snapshot ? tr('This file has no ship designs.', '此文件中没有舰船设计。') : pendingLabel));
        const others = workspaceDesigns?.designs.filter(design => !design.current).slice(0, 100) ?? [];
        if (others.length) {
            const group = node('div', 'sd-design-group sd-design-group-other');
            group.append(node('div', 'sd-design-group-label', tr('Other files', '其他文件')));
            const cards = node('div', 'sd-design-cards');
            for (const design of others) {
                const card = button('', () => post({ type: 'open-workspace-design', uri: design.uri, designId: design.designId }), 'sd-design-card');
                card.title = design.name + ' · ' + design.filePath;
                card.append(node('span', 'sd-design-card-name', design.displayName),
                    node('span', 'sd-design-card-tag', design.filePath.split('/').pop() ?? design.filePath));
                cards.append(card);
            }
            group.append(cards);
            designBar.append(group);
        }
        if (item) {
            const actions = node('div', 'sd-design-actions');
            actions.append(
                button(tr('Duplicate', '复制设计'), () => designDialog(item), '', 'design'),
                button(tr('Delete', '删除'), () => confirmAction(tr('Delete design?', '删除设计？'), designLabel(item),
                    tr('Delete design', '删除设计'), () => apply({ kind: 'delete-design', designId: item.id })), '', 'design'),
            );
            designBar.append(actions);
        }
    }

    /** Core components sit in a vertical rail on the viewport's right edge, like the in-game designer. */
    function renderRequiredRail(): void {
        requiredRail.replaceChildren();
        const item = selectedDesign();
        const slots = item && view?.designId === item.id ? view.requiredSlots : [];
        requiredRail.hidden = !item || slots.length === 0;
        if (!item || !slots.length) return;
        for (const required of slots) {
            const chip = button('', () => selectRequired(required), 'sd-chip sd-required-chip');
            chip.dataset.kind = 'required';
            chip.dataset.requiredId = required.id;
            chip.classList.toggle('sd-empty', !required.selected);
            const name = required.selected ? displayName(required.selected) : emptyLabel;
            chip.title = [name, required.selected && required.selected !== name ? required.selected : '', required.componentSet ?? '']
                .filter(Boolean).join('\n');
            chip.setAttribute('aria-label', (required.componentSet ?? tr('Required component', '必需部件')) + ': ' + name);
            const iconElement = node('span', 'sd-slot-icon');
            applySlotIcon(iconElement, required.icon);
            chip.append(iconElement);
            if (required.editable) {
                chip.addEventListener('dragover', event => {
                    if (!designEditable()) return;
                    event.preventDefault();
                    chip.classList.add('sd-drop-active');
                });
                chip.addEventListener('dragleave', () => chip.classList.remove('sd-drop-active'));
                chip.addEventListener('drop', event => {
                    event.preventDefault();
                    const key = consumeDraggedKey(event);
                    chip.classList.remove('sd-drop-active');
                    draggedComponentKey = undefined;
                    if (key) apply({ kind: 'set-required-component', designId: item.id, slotId: required.id, template: key });
                });
            }
            requiredRail.append(chip);
        }
        syncRequiredPressed();
    }

    function syncRequiredPressed(): void {
        const active = picker?.target.kind === 'required' ? picker.target.slot.id : undefined;
        for (const chip of Array.from(requiredRail.querySelectorAll<HTMLElement>('[data-required-id]'))) {
            chip.setAttribute('aria-pressed', String(chip.dataset.requiredId === active));
        }
    }

    function selectRequired(value: ShipDesignRequiredSlotData): void {
        const item = selectedDesign();
        if (!item) return;
        disarm();
        select({});
        openPicker({ kind: 'required', designId: item.id, slot: value });
        navScroll.scrollTop = 0;
    }

    function sameCandidateTarget(left: CandidateTarget, right: CandidateTarget): boolean {
        if (left.kind === 'component' && right.kind === 'component') return left.slot.id === right.slot.id;
        if (left.kind === 'required' && right.kind === 'required') return left.designId === right.designId && left.slot.id === right.slot.id;
        if (left.kind === 'section' && right.kind === 'section') {
            return left.designId === right.designId && left.sectionSlot === right.sectionSlot && left.sectionId === right.sectionId;
        }
        return false;
    }

    function openPicker(target: CandidateTarget): void {
        // A draft refresh re-requests the same slot; keep the visible list until the new one arrives.
        const items = picker && sameCandidateTarget(picker.target, target) ? picker.items : undefined;
        picker = { target, includeIncompatible: false, pending: false, items };
        requestCandidates(picker);
    }

    function requestCandidates(current: Picker): void {
        current.pending = true;
        renderPicker();
        const { target, includeIncompatible } = current;
        if (target.kind === 'component') {
            post({ type: 'request-slot-candidates', sectionId: target.slot.sectionId, slot: target.slot.name, includeIncompatible });
        } else if (target.kind === 'required') {
            post({ type: 'request-required-candidates', designId: target.designId, slotId: target.slot.id });
        } else {
            post({ type: 'request-section-candidates', designId: target.designId, sectionSlot: target.sectionSlot, includeIncompatible });
        }
    }

    function definitionLines(container: HTMLElement, pairs: Array<[string, string]>): void {
        const dl = node('dl', 'sd-definitions');
        for (const [label, value] of pairs) dl.append(node('dt', '', label), node('dd', '', value || unspecified));
        container.append(dl);
    }

    function openDesignSource(item: ShipDesignData, source = item.source): void {
        post({ type: 'open-source', designId: item.id, range: source });
    }

    function renderProperties(): void {
        properties.replaceChildren();
        
        const item = selectedDesign();
        designBanner.replaceChildren();
        if (item) {
            designBanner.append(
                node('h2', '', designLabel(item)),
                node('span', '', [displayName(item.shipSize), item.roles].filter(Boolean).join(' · ')),
            );
        }
        if (!item) {
            properties.append(note(snapshot ? tr('Select or create a design to get started.', '请选择或创建设计。') : pendingLabel));
            syncControls();
            return;
        }
        const metadata = title(properties, tr('Design properties', '设计属性'));
        const designActions = node('div', 'sd-actions');
        const generate = button(tr('Generate draft…', '生成草稿…'), () => generateDialog(item), 'sd-primary', 'design');
        generate.dataset.unavailable = String(!generatorRoles().length);
        designActions.append(generate, button(tr('Open design source', '打开设计源文件'), () => openDesignSource(item)));
        metadata.append(designActions);
        const available = view?.availableSectionSlots.filter(value => !item.sections.some(entry => entry.slot.toLowerCase() === value.toLowerCase())) ?? [];
        if (available.length) {
            const selectSlot = node('select');
            selectSlot.dataset.gate = 'design';
            options(selectSlot, keys([...new Set(available)]), available[0]);
            const actions = node('div', 'sd-actions sd-add-section');
            actions.append(field(tr('Available section slot', '可用分段槽位'), selectSlot),
                button(tr('Add section…', '添加分段…'), () => {
                    if (!selectSlot.value) return;
                    select({});
                    openPicker({ kind: 'section', designId: item.id, sectionSlot: selectSlot.value });
                    navScroll.scrollTop = 0;
                }, '', 'design'));
            metadata.append(actions);
        }
        renderMetadata(metadata, item);
        syncControls();
    }

    function renderMetadata(container: HTMLElement, item: ShipDesignData): void {
        const textFields = [
            { key: 'name', label: tr('Name', '名称'), value: item.name },
            { key: 'ship_size', label: tr('Ship size', '舰船尺寸'), value: item.shipSize, values: catalog?.shipSizes },
            { key: 'graphical_culture', label: tr('Graphical culture', '图形文化'), value: item.graphicalCulture, values: catalog?.cultures },
            { key: 'roles', label: tr('Roles', '舰船角色'), value: item.roles, values: generatorRoles() },
        ];
        for (const entry of textFields) {
            const input = node('input');
            input.type = 'text';
            input.value = entry.value ?? '';
            input.required = entry.key === 'name';
            const form = fieldForm(entry.label, input, () => {
                const value = input.value.trim();
                if (input.required && !value) return invalidName(input);
                if (value === (entry.value ?? '')) return;
                apply({ kind: 'set-field', designId: item.id, field: entry.key, value: value || null });
            });
            if (entry.values?.length) form.append(suggestions(input, entry.key, entry.values));
            container.append(form);
        }
        const flags = [
            { key: 'auto_gen_design', label: tr('Auto-generated design', '自动生成设计') },
            { key: 'upgrade_ship_components', label: tr('Upgrade ship components', '升级舰船部件') },
            { key: 'is_event_design', label: tr('Event design', '事件设计') },
        ];
        const flagGroup = node('div', 'sd-flag-group');
        for (const entry of flags) {
            const { label, input } = checkbox(entry.label, item.metadata[entry.key] === true);
            input.dataset.gate = 'design';
            input.onchange = () => apply({ kind: 'set-field', designId: item.id, field: entry.key, value: input.checked });
            flagGroup.append(label);
        }
        container.append(flagGroup);
    }

    function fieldForm(label: string, input: HTMLInputElement | HTMLTextAreaElement, submit: () => void): HTMLFormElement {
        const form = node('form', 'sd-field-form');
        const commit = node('button', '', tr('Apply', '应用'));
        commit.type = 'submit';
        commit.setAttribute('aria-label', tr('Apply ' + label, '应用' + label));
        commit.dataset.gate = 'design';
        input.dataset.gate = 'design';
        form.onsubmit = event => { event.preventDefault(); if (!commit.disabled) submit(); };
        form.append(field(label, input), commit);
        return form;
    }

    function suggestions(input: HTMLInputElement, key: string, values: string[]): HTMLDataListElement {
        const data = node('datalist');
        data.id = 'sd-suggestions-' + key;
        input.setAttribute('list', data.id);
        for (const value of values) {
            const choice = node('option');
            choice.value = value;
            data.append(choice);
        }
        return data;
    }

    let draggedComponentKey: string | undefined;

    function attachDragSource(element: HTMLElement, key: string): void {
        element.draggable = true;
        element.addEventListener('dragstart', event => {
            if (!designEditable()) {
                event.preventDefault();
                return;
            }
            draggedComponentKey = key;
            libraryChosenKey = key;
            event.dataTransfer?.setData('application/x-cwtools-ship-component', key);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        });
        element.addEventListener('dragend', () => {
            draggedComponentKey = undefined;
            clearDropHighlights();
        });
    }

    function consumeDraggedKey(event: DragEvent): string | undefined {
        return draggedComponentKey ?? event.dataTransfer?.getData('application/x-cwtools-ship-component') ?? undefined;
    }

    function clearDropHighlights(): void {
        for (const element of Array.from(app.querySelectorAll('.sd-drop-active'))) element.classList.remove('sd-drop-active');
    }

    function fillWithComponent(key: string): void {
        const item = selectedDesign();
        if (!item || picker?.target.kind !== 'component') return;
        if (!picker.items?.some(value => value.key === key && value.compatible)) {
            setError(tr('The dragged component is not in the compatible library.', '拖入的部件不在兼容组件库中。'));
            return;
        }
        libraryChosenKey = key;
        apply({ kind: 'fill-empty-slots', designId: item.id, componentKey: key, replaceEquipped: !libraryFilter.emptyOnly });
    }

    fillTarget.addEventListener('click', () => {
        if (picker?.target.kind !== 'component') return;
        const visible = visibleCandidates(picker);
        const key = [libraryChosenKey, picker.target.slot.selected, visible[0]?.key]
            .find(value => value !== undefined && visible.some(candidate => candidate.key === value));
        if (key) fillWithComponent(key);
    });
    fillTarget.addEventListener('dragover', event => {
        if (picker?.target.kind !== 'component' || !designEditable()) return;
        event.preventDefault();
        fillTarget.classList.add('sd-drop-active');
    });
    fillTarget.addEventListener('dragleave', () => fillTarget.classList.remove('sd-drop-active'));
    fillTarget.addEventListener('drop', event => {
        event.preventDefault();
        const key = consumeDraggedKey(event);
        fillTarget.classList.remove('sd-drop-active');
        draggedComponentKey = undefined;
        if (key) fillWithComponent(key);
    });

    function updateLibraryFilter(change: Partial<typeof libraryFilter>): void {
        Object.assign(libraryFilter, change);
        persist();
        renderLibraryList();
    }
    emptyOnly.input.addEventListener('change', () => {
        libraryFilter.emptyOnly = emptyOnly.input.checked;
        persist();
        syncFillLabel();
    });
    hideObsolete.input.addEventListener('change', () => updateLibraryFilter({ hideObsolete: hideObsolete.input.checked }));
    hideVanilla.input.addEventListener('change', () => updateLibraryFilter({ hideVanilla: hideVanilla.input.checked }));
    librarySearch.addEventListener('input', () => updateLibraryFilter({ query: librarySearch.value.slice(0, 200) }));
    tierSelect.addEventListener('change', () => updateLibraryFilter({ tier: Number(tierSelect.value) || 0 }));
    sortSelect.addEventListener('change', () => updateLibraryFilter({ sort: sortSelect.value === 'tier' ? 'tier' : 'name' }));

    function syncFillLabel(): void {
        fillTarget.textContent = libraryFilter.emptyOnly ? tr('Fill empty', '填充空槽') : tr('Fill all', '填充全部');
    }

    function armComponent(candidate: Candidate): void {
        const item = selectedDesign();
        if (!item || !designEditable()) return;
        if (armed?.key === candidate.key) {
            disarm();
            return;
        }
        armed = { key: candidate.key, icon: candidate.icon };
        libraryChosenKey = candidate.key;
        placeableSlots = new Set();
        cursorIcon.style.backgroundImage = '';
        applySlotIcon(cursorIcon, candidate.icon);
        cursorIcon.hidden = false;
        app.dataset.armed = 'true';
        post({ type: 'request-compatible-slots', designId: item.id, componentKey: candidate.key });
        syncPlacement();
        renderLibraryList();
    }

    function disarm(): void {
        if (!armed) return;
        armed = undefined;
        placeableSlots = new Set();
        cursorIcon.hidden = true;
        delete app.dataset.armed;
        syncPlacement();
        if (picker) renderLibraryList();
    }

    function syncPlacement(): void {
        for (const chip of Array.from(strips.querySelectorAll<HTMLElement>('[data-slot-id]'))) {
            chip.classList.toggle('sd-placeable', !!armed && placeableSlots.has(chip.dataset.slotId ?? ''));
        }
    }

    function placeArmed(slot: ShipDesignSlotData): void {
        if (!armed || !placeableSlots.has(slot.id)) return;
        apply({ kind: 'drop-component', sectionId: slot.sectionId, slot: slot.name, template: armed.key });
    }

    function requestPlacement(): void {
        const item = selectedDesign();
        if (armed && item) post({ type: 'request-compatible-slots', designId: item.id, componentKey: armed.key });
    }

    /** Re-targets the open library to the closest slot of a newly selected design. */
    function resumeLibrary(previous: CandidateTarget, next: ShipDesignViewData): boolean {
        if (previous.kind === 'component') {
            const slots = next.sections.flatMap(entry => entry.slots).filter(slot => !slot.fixed);
            const match = slots.find(slot => slot.name === previous.slot.name && slot.size === previous.slot.size && slot.kind === previous.slot.kind)
                ?? slots.find(slot => slot.kind === previous.slot.kind && slot.size === previous.slot.size)
                ?? slots.find(slot => slot.kind === previous.slot.kind)
                ?? slots[0];
            if (!match) return false;
            select({ sectionId: match.sectionId, slotId: match.id });
            openPicker({ kind: 'component', slot: match });
            return true;
        }
        if (previous.kind === 'required') {
            const set = previous.slot.componentSet?.toLowerCase();
            const match = next.requiredSlots.find(slot => set !== undefined && slot.componentSet?.toLowerCase() === set)
                ?? next.requiredSlots.find(slot => slot.editable);
            if (!match) return false;
            select({});
            openPicker({ kind: 'required', designId: next.designId, slot: match });
            return true;
        }
        const section = next.sections.find(entry => entry.section.slot === previous.sectionSlot);
        if (!section) return false;
        select({ sectionId: section.section.id });
        openPicker({ kind: 'section', designId: next.designId, sectionSlot: section.section.slot, sectionId: section.section.id });
        return true;
    }

    function closeLibrary(): void {
        disarm();
        picker = undefined;
        renderModelUi();
    }

    const romanTiers = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    function tierLabel(tier: number): string {
        return romanTiers[tier - 1] ?? String(tier);
    }

    /** Compatible candidates after the name, tier and upgrade filters, in the chosen order. */
    function visibleCandidates(current: Picker): Candidate[] {
        const compatible = (current.items ?? []).filter(value => value.compatible);
        const available = new Set(compatible.map(value => value.key.toLowerCase()));
        const query = libraryFilter.query.trim().toLowerCase();
        const visible = compatible.filter(value =>
            !(libraryFilter.hideObsolete && value.upgradesTo && available.has(value.upgradesTo.toLowerCase()))
            && !(libraryFilter.hideVanilla && value.origin === 'vanilla')
            && (!libraryFilter.tier || (value.tier ?? 1) === libraryFilter.tier)
            && (!query || value.label.toLowerCase().includes(query) || value.key.toLowerCase().includes(query)));
        const byName = (left: Candidate, right: Candidate): number => (left.label || left.key).localeCompare(right.label || right.key, locale);
        return visible.sort(libraryFilter.sort === 'tier'
            ? (left, right) => (right.tier ?? 1) - (left.tier ?? 1) || byName(left, right)
            : byName);
    }

    function renderPicker(): void {
        const current = picker;
        const item = selectedDesign();
        if (!current || !item) return;
        navigation.hidden = false;
        app.dataset.library = 'open';
        const { target } = current;
        navHeaderTitle.textContent = target.kind === 'section' ? tr('Section templates', '分段模板')
            : target.kind === 'required' ? tr('Required component', '必需部件') : tr('Add components', '增加部件');
        libraryHint.textContent = target.kind === 'section'
            ? tr('Choose a template for section slot ', '为分段槽位选择模板：') + target.sectionSlot
            : target.kind === 'required'
                ? tr('Choose a component from the set ', '从该集合选择部件：') + (target.slot.componentSet ?? '')
                : tr('Select a component and place it in an available slot.', '选择一个部件，将其放入可用的槽位。');
        fillTarget.hidden = target.kind !== 'component';
        emptyOnly.label.hidden = target.kind !== 'component';
        emptyOnly.input.checked = libraryFilter.emptyOnly;
        hideObsolete.input.checked = libraryFilter.hideObsolete;
        hideVanilla.input.checked = libraryFilter.hideVanilla;
        hideVanilla.label.hidden = target.kind === 'section';
        if (librarySearch.value !== libraryFilter.query) librarySearch.value = libraryFilter.query;
        syncFillLabel();
        renderLibraryList();
        syncRequiredPressed();
        syncControls();
    }

    function renderLibraryList(): void {
        const current = picker;
        if (!current) return;
        const { target } = current;
        const scrollTop = navScroll.scrollTop;
        navScroll.replaceChildren();
        if (libraryResume) {
            // The previous design's target must not receive edits while the new design loads.
            navScroll.append(note(pendingLabel));
            return;
        }
        const tiers = [...new Set((current.items ?? []).filter(value => value.compatible && value.tier).map(value => value.tier ?? 1))].sort((a, b) => a - b);
        if (libraryFilter.tier && current.items && !tiers.includes(libraryFilter.tier)) libraryFilter.tier = 0;
        options(tierSelect, [{ value: '0', label: tr('All tiers', '全部等级') },
            ...tiers.map(tier => ({ value: String(tier), label: tr('Tier ', '等级 ') + tierLabel(tier) }))], String(libraryFilter.tier));
        tierSelect.disabled = tiers.length < 2;
        libraryCount.textContent = '';
        if (!current.items) {
            navScroll.append(current.pending ? note(pendingLabel)
                : button(tr('Retry candidates', '重试加载候选项'), () => requestCandidates(current)));
            return;
        }
        const total = current.items.filter(value => value.compatible).length;
        if (!total) {
            navScroll.append(note(current.pending ? pendingLabel : tr('No candidates match this slot.', '没有符合此槽位的候选项。')));
            return;
        }
        const visible = visibleCandidates(current);
        libraryCount.textContent = tr('Showing ', '显示 ') + visible.length + ' / ' + total;
        if (!visible.length) {
            navScroll.append(note(tr('No components match the filters.', '没有符合筛选条件的部件。')));
            return;
        }
        const equipped = target.kind === 'component' || target.kind === 'required' ? target.slot.selected?.toLowerCase() : undefined;
        const rows = node('ul', 'sd-candidate-list');
        for (const candidate of visible) {
            const row = node('li', 'sd-candidate sd-library-item');
            const select = button('', () => target.kind === 'component' ? armComponent(candidate) : chooseCandidate(target, candidate.key),
                'sd-candidate-choice', 'design');
            select.dataset.unavailable = String(target.kind === 'component' && target.slot.fixed);
            select.title = candidate.label === candidate.key ? candidate.key : candidate.label + '\n' + candidate.key;
            select.setAttribute('aria-pressed', String(armed ? candidate.key === armed.key : candidate.key.toLowerCase() === equipped));
            select.classList.toggle('sd-armed', armed?.key === candidate.key);
            if (target.kind !== 'section') {
                const iconElement = node('span', 'sd-slot-icon');
                applySlotIcon(iconElement, candidate.icon);
                select.append(iconElement);
                attachDragSource(select, candidate.key);
            } else select.classList.add('sd-section-candidate');
            select.append(node('span', 'sd-candidate-label', candidate.label || candidate.key));
            if (candidate.tier) select.append(node('span', 'sd-candidate-tier', tierLabel(candidate.tier)));
            if (target.kind === 'component') select.append(node('span', 'sd-slot-size', slotSizeLabel(target.slot.size)));
            row.append(select);
            rows.append(row);
        }
        navScroll.append(rows);
        navScroll.scrollTop = scrollTop;
    }

    function chooseCandidate(target: CandidateTarget, key: string): void {
        libraryChosenKey = key;
        if (target.kind === 'component') {
            apply({ kind: 'set-component', sectionId: target.slot.sectionId, slot: target.slot.name, template: key });
        } else if (target.kind === 'required') {
            apply({ kind: 'set-required-component', designId: target.designId, slotId: target.slot.id, template: key });
        } else if (target.sectionId) {
            apply({ kind: 'set-section-template', sectionId: target.sectionId, template: key });
        } else {
            apply({ kind: 'add-section', designId: target.designId, slot: target.sectionSlot, template: key });
        }
    }

    function generatorRoles(): string[] {
        return [...new Set([...(view?.roles ?? []), ...(catalog?.roles ?? [])])];
    }

    function openDialog(heading: string, submitLabel: string, contents: HTMLElement[], submit: () => boolean): void {
        if (modal.open) return;
        const form = node('form', 'sd-dialog-form');
        const headingNode = node('h2', '', heading);
        headingNode.id = 'ship-design-dialog-title';
        const actions = node('div', 'sd-actions sd-dialog-actions');
        const commit = node('button', 'sd-primary', submitLabel);
        commit.type = 'submit';
        actions.append(button(tr('Cancel', '取消'), () => modal.close()), commit);
        form.onsubmit = event => { event.preventDefault(); if (submit()) modal.close(); };
        form.append(headingNode, ...contents, actions);
        modal.replaceChildren(form);
        modal.showModal();
    }

    function confirmAction(heading: string, text: string, label: string, submit: () => boolean): void {
        openDialog(heading, label, [note(text)], submit);
    }

    function invalidName(input: HTMLInputElement, duplicate = false): void {
        input.setCustomValidity(duplicate ? tr('This design name already exists.', '此设计名称已存在。') : tr('Enter a design name.', '请输入设计名称。'));
        input.reportValidity();
        input.oninput = () => input.setCustomValidity('');
    }

    function designDialog(original?: ShipDesignData): void {
        if (original ? !designEditable() : !documentEditable() || !catalog?.shipSizes.length) return;
        const name = node('input');
        name.type = 'text';
        name.required = true;
        name.autofocus = true;
        const size = node('select');
        size.required = true;
        const culture = node('select');
        const contents: HTMLElement[] = [field(tr('Name', '名称'), name)];
        if (!original) {
            const sizes = catalog?.shipSizes ?? [];
            options(size, [{ value: '', label: tr('Choose a ship size', '选择舰船尺寸') }, ...keys(sizes)], '');
            options(culture, [{ value: '', label: tr('Default culture', '默认文化') }, ...keys(catalog?.cultures ?? [])], '');
            contents.push(field(tr('Ship size', '舰船尺寸'), size), field(tr('Graphical culture', '图形文化'), culture));
        }
        openDialog(original ? tr('Duplicate design', '复制设计') : tr('New design', '新建设计'),
            original ? tr('Duplicate', '复制') : tr('Create', '创建'), contents, () => {
                const value = name.value.trim();
                const duplicate = snapshot?.designs.some(item => item.name.trim().toLowerCase() === value.toLowerCase()) ?? false;
                if (!value || duplicate) { invalidName(name, duplicate); return false; }
                if (original) return selectedDesign()?.id === original.id && apply({ kind: 'duplicate-design', designId: original.id, newName: value });
                if (!size.value) return false;
                return apply({ kind: 'create-design', name: value, shipSize: size.value, graphicalCulture: culture.value || undefined });
            });
    }

    function generateDialog(item: ShipDesignData): void {
        if (!designEditable()) return;
        const role = node('select');
        const roles = generatorRoles();
        role.required = true;
        options(role, keys(roles), (item.roles && roles.includes(item.roles) ? item.roles : roles[0]) ?? '');
        const tech = node('select');
        options(tech, [
            { value: 'all', label: tr('All technologies', '全部科技') },
            { value: 'starting', label: tr('Starting technologies', '初始科技') },
            { value: 'custom', label: tr('Custom technologies', '自定义科技') },
        ], 'all');
        const technologies = node('textarea');
        technologies.rows = 4;
        technologies.placeholder = tr('Enter technology keys separated by commas or new lines', '科技键之间用逗号或换行分隔');
        const custom = field(tr('Technology keys', '科技键'), technologies);
        custom.hidden = true;
        tech.onchange = () => { custom.hidden = tech.value !== 'custom'; };
        const power = checkbox(tr('Enforce power balance', '强制功率平衡'), true);
        openDialog(tr('Generate loadout draft', '生成配装草稿'), tr('Generate draft', '生成草稿'), [
            field(tr('Role', '舰船角色'), role), field(tr('Technology scope', '科技范围'), tech), custom, power.label,
            note(tr('Generating replaces the draft loadout. Save to write it to the file.', '生成操作将替换草稿配装。点击保存后才会写入文件。')),
        ], () => {
            if (!snapshot || !role.value || selectedDesign()?.id !== item.id || !designEditable()) return false;
            const technology: ShipDesignTechnologyScope = tech.value === 'custom'
                ? { kind: 'custom', technologies: splitKeys(technologies.value) }
                : { kind: tech.value === 'starting' ? 'starting' : 'all' };
            setError();
            explanation = undefined;
            renderExplanation();
            pending = 'draft';
            syncControls();
            post({ type: 'generate-draft', expectedVersion: snapshot.documentVersion, designId: item.id,
                options: { role: role.value, technology, enforcePower: power.input.checked } });
            return true;
        });
    }

    function renderStats(): void {
        productionRegion.replaceChildren();
        statsRegion.replaceChildren();
        if (!selectedDesign()) return;
        const production = title(productionRegion, tr('Production', '生产'));
        const shipData = title(statsRegion, tr('Ship data', '舰船数据'));
        if (!stats || stats.designId !== selectedDesign()?.id) {
            production.append(note(pendingLabel));
            return;
        }
        const createStat = (key: string, stat: ShipDesignStatValue): HTMLElement => {
            const entry = node('details', 'sd-stat');
            const header = node('summary', 'sd-stat-header');
            const value = stat.value === undefined ? '—' : [numberFormat.format(stat.value), stat.unit].filter(Boolean).join(' ');
            const status = stat.status === 'known' ? tr('Known', '已知')
                : stat.status === 'partial' ? tr('Partial', '部分已知') : tr('Unknown', '未知');
            header.title = key;
            header.append(node('span', 'sd-stat-key', displayStatKey(key)), node('strong', 'sd-stat-value', value), node('span', 'sd-stat-status', status));
            entry.dataset.status = stat.status;
            entry.append(header);
            if (stat.sources.length) entry.append(node('div', 'sd-stat-detail-label', tr('Sources', '来源')), list(stat.sources));
            if (stat.unresolved.length) entry.append(node('div', 'sd-stat-detail-label', tr('Unresolved expressions', '未解析的表达式')), list(stat.unresolved));
            if (!stat.sources.length && !stat.unresolved.length) entry.append(note(tr('No calculation details.', '没有计算详情。')));
            return entry;
        };
        const render = (values: Record<string, ShipDesignStatValue>, target: HTMLElement): void => {
            for (const [key, stat] of Object.entries(values)) target.append(createStat(key, stat));
        };
        if (stats.values.buildTime) render({ buildTime: stats.values.buildTime }, production);
        render(stats.resources, production);
        render(Object.fromEntries(Object.entries(stats.values).filter(([key]) => key !== 'buildTime')), shipData);
        if (!Object.keys(stats.resources).length && !stats.values.buildTime) production.append(note(tr('No production data.', '没有生产数据。')));
    }

    function renderExplanation(): void {
        explanationRegion.replaceChildren();
        if (!explanation || explanation.designId !== selectedDesign()?.id || !explanation.lines.length) return;
        title(explanationRegion, tr('Draft generation', '草稿生成')).append(list(explanation.lines));
    }

    function receiveSnapshot(next: ShipDesignDocumentSnapshot): void {
        const designChanged = snapshot?.selectedDesignId !== next.selectedDesignId;
        const versionChanged = snapshot?.documentVersion !== next.documentVersion;
        const previousSection = selectedDesign()?.sections.find(entry => entry.id === selection.sectionId);
        snapshot = next;
        pending = undefined;
        ({ dirty, saving, canUndo, canRedo } = next);
        if (dirty) saved = false;
        if (designChanged || versionChanged) stats = undefined;
        if (designChanged) {
            selection = {};
            explanation = undefined;
        } else if (versionChanged && previousSection) {
            const current = selectedDesign()?.sections.find(entry => entry.id === selection.sectionId);
            if (!current || current.slot !== previousSection.slot) selection = {};
        }
        if (designChanged) {
            libraryResume = picker?.target;
            if (picker) picker.pending = true;
        } else if (versionChanged && picker) picker.pending = true;
        // Same-design refreshes keep the previous view and scene until the new view arrives;
        // the scene reconciles only changed nodes, so hiding it here would flash the whole model.
        if (designChanged) {
            view = undefined;
            if (!libraryResume) navigation.hidden = true;
        }
        sceneHost.hidden = !view;
        renderToolbar();
        renderModelUi();
        renderProperties();
        renderStats();
        renderExplanation();
    }

    function receiveView(next: ShipDesignViewData): void {
        if (next.designId !== selectedDesign()?.id) return;
        view = next;
        sceneHost.hidden = false;
        scene.setView(next);
        const section = next.sections.find(item => item.section.id === selection.sectionId);
        const slot = section?.slots.find(item => item.id === selection.slotId);
        if (selection.sectionId && !section) selection = {};
        else if (section && selection.slotId && !slot) selection = { sectionId: section.section.id };
        renderToolbar();
        renderModelUi();
        renderProperties();
        requestPlacement();
        if (libraryResume) {
            const previous = libraryResume;
            libraryResume = undefined;
            picker = undefined;
            if (!resumeLibrary(previous, next)) renderModelUi();
            return;
        }
        if (slot) openPicker({ kind: 'component', slot });
        else if (picker?.target.kind === 'section') openPicker(picker.target);
        else if (picker?.target.kind === 'required') {
            const currentId = picker.target.slot.id;
            const required = next.requiredSlots.find(item => item.id === currentId);
            if (required) openPicker({ kind: 'required', designId: next.designId, slot: required });
            else picker = undefined;
        }
    }

    function handleMessage(event: MessageEvent<unknown>): void {
        if (!isRecord(event.data) || typeof event.data.type !== 'string'
            || !Object.prototype.hasOwnProperty.call(responseValidators, event.data.type)) return;
        const message = parseProtocolMessage<ShipDesignResponse>(event.data, responseValidators);
        if (!message) {
            setError(tr('Received an invalid ship design response.', '收到无效的舰船设计响应。'));
            return;
        }
        switch (message.type) {
            case 'snapshot': receiveSnapshot(message.snapshot); break;
            case 'view': receiveView(message.view); break;
            case 'stats':
                if (message.stats.designId !== selectedDesign()?.id) break;
                stats = message.stats;
                renderStats();
                break;
            case 'slot-candidates':
                if (picker?.target.kind !== 'component' || picker.target.slot.sectionId !== message.sectionId
                    || picker.target.slot.name !== message.slot) break;
                picker.pending = false;
                picker.items = message.candidates.filter(candidate => picker?.includeIncompatible || candidate.compatible);
                renderPicker();
                break;
            case 'compatible-slots':
                if (!armed || message.componentKey !== armed.key || message.designId !== selectedDesign()?.id) break;
                placeableSlots = new Set(message.slotIds);
                syncPlacement();
                break;
            case 'required-candidates':
                if (picker?.target.kind !== 'required' || picker.target.designId !== message.designId
                    || picker.target.slot.id !== message.slotId) break;
                picker.pending = false;
                picker.items = message.candidates.filter(candidate => candidate.compatible);
                renderPicker();
                break;
            case 'section-candidates':
                if (picker?.target.kind !== 'section' || picker.target.designId !== message.designId
                    || picker.target.sectionSlot !== message.sectionSlot) break;
                picker.pending = false;
                picker.items = message.candidates.filter(candidate => picker?.includeIncompatible || candidate.compatible);
                renderPicker();
                break;
            case 'workspace-designs':
                workspaceDesigns = message;
                renderModelUi();
                break;
            case 'catalog-options':
                catalog = message;
                renderToolbar();
                renderModelUi();
                renderProperties();
                break;
            case 'environments':
                scene.setEnvironment(message.presets, message.workerUri);
                break;
            case 'document-state':
                ({ dirty, saving, saved, canUndo, canRedo } = message);
                if (pending === 'save' && !saving) pending = undefined;
                syncControls();
                break;
            case 'generation-explanation':
                if (message.designId !== selectedDesign()?.id) break;
                explanation = message;
                renderExplanation();
                break;
            case 'model-asset':
                if (!view || message.generation !== snapshot?.generation || !view.model.some(item => item.id === message.nodeId)) break;
                if (message.asset) {
                    scene.setAsset(message.nodeId, message.asset);

                } else if (message.error) {

                    scene.setAssetError(message.nodeId, message.error);
                }
                
                break;
            case 'error':
                pending = undefined;
                saving = false;
                setError(message.message);
                if (picker?.pending) {
                    picker.pending = false;
                    renderPicker();
                }
                syncControls();
                break;
        }
    }

    modal.addEventListener('close', () => modal.replaceChildren(), listener);
    window.addEventListener('message', handleMessage, listener);
    document.addEventListener('pointermove', event => {
        if (!armed) return;
        cursorIcon.style.transform = 'translate(' + (event.clientX + 14) + 'px, ' + (event.clientY + 14) + 'px)';
    }, listener);
    document.addEventListener('contextmenu', event => {
        if (!armed) return;
        event.preventDefault();
        disarm();
    }, listener);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && armed) disarm();
    }, listener);
    window.addEventListener('unload', () => {
        lifecycle.abort();
        resizeObserver.disconnect();
        scene.dispose();
        app.replaceChildren();
    }, { ...listener, once: true });
    syncLayout();
    renderToolbar();
    renderModelUi();
    renderProperties();
    
    post({ type: 'ready' });
}

const app = document.getElementById('app');
if (app) mount(app);
