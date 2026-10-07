/**
 * Workshop Upload — Webview Script
 *
 * Side panel form for uploading a mod to the Steam Workshop. This script runs in the
 * browser sandbox: no Node APIs, no `vscode` import, and no file I/O. Every side effect
 * is delegated to the Extension Host through `acquireVsCodeApi().postMessage`.
 *
 * Webview → Host: `ready` / `pickPreview` / `upload`
 * Host → Webview: `prefill` / `previewPicked` / `progress` / `busy` / `result`
 *
 * Host payloads are treated as untrusted input: every field is narrowed at the boundary
 * and falls back to a safe default instead of throwing.
 */

const vscode = acquireApi();

// ─── Types ───────────────────────────────────────────────────────────────────

type Locale = 'en' | 'zh';

type Visibility = 'unchanged' | 'public' | 'friends' | 'private' | 'unlisted';

const VISIBILITIES: readonly Visibility[] = ['unchanged', 'public', 'friends', 'private', 'unlisted'];

type UploadStage =
    | 'connecting'
    | 'creating'
    | 'staging'
    | 'preparingConfig'
    | 'preparingContent'
    | 'uploadingContent'
    | 'uploadingPreview'
    | 'committing'
    | 'done';

const UPLOAD_STAGES: readonly UploadStage[] = [
    'connecting',
    'creating',
    'staging',
    'preparingConfig',
    'preparingContent',
    'uploadingContent',
    'uploadingPreview',
    'committing',
    'done',
];

interface FormModel {
    title: string;
    description: string;
    tags: string[];
    previewPath?: string;
    visibility: Visibility;
    changeNote: string;
}

interface ContextModel {
    modRoot: string;
    remoteFileId?: string;
    appId: string;
    gameId: string;
}

interface WorkshopTexts {
    heading: string;
    subtitle: string;
    targetCreate: string;
    targetUpdate: string;
    modRoot: string;
    appId: string;
    gameId: string;
    fieldTitle: string;
    titlePlaceholder: string;
    titleRequired: string;
    fieldDescription: string;
    descriptionPlaceholder: string;
    fieldTags: string;
    tagsPlaceholder: string;
    tagsHint: string;
    fieldPreview: string;
    previewPlaceholder: string;
    browse: string;
    fieldVisibility: string;
    fieldChangeNote: string;
    changeNotePlaceholder: string;
    upload: string;
    uploading: string;
    resultCreated: string;
    resultUpdated: string;
    resultFailed: string;
    unknownError: string;
    itemId: string;
    url: string;
    agreementWarning: string;
    stageUnknown: string;
}

// ─── Bilingual strings ───────────────────────────────────────────────────────

const TEXT: Record<Locale, WorkshopTexts> = {
    en: {
        heading: 'Upload Mod to Steam Workshop',
        subtitle: 'Fill in the item metadata below; the Extension Host performs the Steam upload.',
        targetCreate: 'A new Workshop item will be created.',
        targetUpdate: 'The existing Workshop item {id} will be updated.',
        modRoot: 'Mod root',
        appId: 'App ID',
        gameId: 'Game',
        fieldTitle: 'Title',
        titlePlaceholder: 'Item title',
        titleRequired: 'Title is required.',
        fieldDescription: 'Description',
        descriptionPlaceholder: 'Describe your mod (optional)',
        fieldTags: 'Tags',
        tagsPlaceholder: 'balance, graphics, gameplay',
        tagsHint: 'Separate tags with commas.',
        fieldPreview: 'Preview image',
        previewPlaceholder: 'No preview image selected',
        browse: 'Browse…',
        fieldVisibility: 'Visibility',
        fieldChangeNote: 'Change note',
        changeNotePlaceholder: 'What changed in this update? (optional)',
        upload: 'Upload',
        uploading: 'Uploading…',
        resultCreated: 'Workshop item created.',
        resultUpdated: 'Workshop item updated.',
        resultFailed: 'Upload failed.',
        unknownError: 'Unknown error.',
        itemId: 'Item ID',
        url: 'URL',
        agreementWarning:
            'The Steam Workshop agreement has not been accepted yet. The item stays hidden '
            + 'until you accept the agreement on its item page.',
        stageUnknown: 'Working',
    },
    zh: {
        heading: '上传 Mod 到 Steam 创意工坊',
        subtitle: '在下方填写物品信息，由扩展宿主进程执行 Steam 上传。',
        targetCreate: '将创建新工坊物品。',
        targetUpdate: '将更新已有工坊物品 {id}。',
        modRoot: 'Mod 根目录',
        appId: '应用 ID',
        gameId: '游戏',
        fieldTitle: '标题',
        titlePlaceholder: '物品标题',
        titleRequired: '标题不能为空。',
        fieldDescription: '描述',
        descriptionPlaceholder: '描述你的 Mod（可选）',
        fieldTags: '标签',
        tagsPlaceholder: 'balance, graphics, gameplay',
        tagsHint: '使用英文逗号分隔标签。',
        fieldPreview: '预览图',
        previewPlaceholder: '未选择预览图',
        browse: '浏览…',
        fieldVisibility: '可见性',
        fieldChangeNote: '更新说明',
        changeNotePlaceholder: '本次更新了什么？（可选）',
        upload: '上传',
        uploading: '上传中…',
        resultCreated: '工坊物品已创建。',
        resultUpdated: '工坊物品已更新。',
        resultFailed: '上传失败。',
        unknownError: '未知错误。',
        itemId: '物品 ID',
        url: '链接',
        agreementWarning: 'Steam 工坊协议尚未接受，物品会保持隐藏，请在物品页面接受协议。',
        stageUnknown: '处理中',
    },
};

const VISIBILITY_LABEL: Record<Visibility, Record<Locale, string>> = {
    unchanged: { en: 'Keep unchanged', zh: '保持不变' },
    private: { en: 'Private', zh: '私有' },
    friends: { en: 'Friends only', zh: '仅好友' },
    unlisted: { en: 'Unlisted', zh: '不公开' },
    public: { en: 'Public', zh: '公开' },
};

const STAGE_LABEL: Record<UploadStage, Record<Locale, string>> = {
    connecting: { en: 'Connecting to Steam', zh: '正在连接 Steam' },
    creating: { en: 'Creating Workshop item', zh: '正在创建工坊物品' },
    staging: { en: 'Filtering mod files', zh: '正在按忽略规则筛选文件' },
    preparingConfig: { en: 'Preparing mod config', zh: '正在准备 Mod 配置' },
    preparingContent: { en: 'Preparing mod content', zh: '正在准备 Mod 内容' },
    uploadingContent: { en: 'Uploading mod content', zh: '正在上传 Mod 内容' },
    uploadingPreview: { en: 'Uploading preview image', zh: '正在上传预览图' },
    committing: { en: 'Committing changes', zh: '正在提交变更' },
    done: { en: 'Done', zh: '完成' },
};

// ─── Host bridge ─────────────────────────────────────────────────────────────

/**
 * `acquireVsCodeApi` throws outside a real Webview (e.g. a plain browser preview).
 * Fall back to a sink so the panel still renders instead of failing to start.
 */
function acquireApi(): VsCodeApi {
    try {
        return acquireVsCodeApi();
    } catch {
        return {
            postMessage: () => { /* no host available */ },
            getState: () => undefined,
            setState: () => { /* no host available */ },
        };
    }
}

// ─── Untrusted-input narrowing ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asText(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asOptionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((tag): tag is string => typeof tag === 'string');
}

function asVisibility(value: unknown): Visibility {
    return typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value)
        ? (value as Visibility)
        : 'unchanged';
}

function asStage(value: unknown): UploadStage | undefined {
    return typeof value === 'string' && (UPLOAD_STAGES as readonly string[]).includes(value)
        ? (value as UploadStage)
        : undefined;
}

function asLocale(value: unknown): Locale | undefined {
    return value === 'zh' || value === 'en' ? value : undefined;
}

// ─── State ───────────────────────────────────────────────────────────────────

function detectLocale(): Locale {
    const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
    return lang.startsWith('zh') ? 'zh' : 'en';
}

const state = {
    locale: detectLocale(),
    busy: false,
    /** True between the upload click and the host acknowledging it. */
    pending: false,
    context: { modRoot: '', appId: '', gameId: '' } as ContextModel,
    form: { title: '', description: '', tags: [], visibility: 'unchanged', changeNote: '' } as FormModel,
    previewUri: undefined as string | undefined,
};

function t(): WorkshopTexts {
    return TEXT[state.locale];
}

function format(template: string, id: string): string {
    return template.replace('{id}', id);
}

// ─── Styles ──────────────────────────────────────────────────────────────────

/**
 * Styles are inlined so this bundle stays self-contained (no sibling .css asset).
 * Only VS Code theme variables are used; every animation is disabled under
 * `prefers-reduced-motion: reduce`.
 */
const STYLES = [
    '.wu-root { box-sizing: border-box; padding: 10px 12px 16px; font-family: var(--vscode-font-family);',
    '  font-size: var(--vscode-font-size); color: var(--vscode-foreground); line-height: 1.5; }',
    '.wu-root *, .wu-root *::before, .wu-root *::after { box-sizing: border-box; }',
    '.wu-heading { margin: 0 0 2px; font-size: 1.05em; font-weight: 600; }',
    '.wu-subtitle { margin: 0 0 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }',
    '.wu-target { margin: 0 0 4px; font-weight: 600; }',
    '.wu-meta { margin: 0 0 4px; color: var(--vscode-descriptionForeground); font-size: 0.85em;',
    '  overflow-wrap: anywhere; }',
    '.wu-field { margin: 0 0 10px; display: flex; flex-direction: column; gap: 4px; }',
    '.wu-label { font-weight: 600; font-size: 0.9em; }',
    '.wu-required { color: var(--vscode-errorForeground); margin-left: 3px; }',
    '.wu-input, .wu-textarea, .wu-select { width: 100%; font-family: inherit; font-size: inherit;',
    '  color: var(--vscode-input-foreground); background: var(--vscode-input-background);',
    '  border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;',
    '  padding: 4px 6px; }',
    '.wu-textarea { min-height: 84px; resize: vertical; }',
    '.wu-input:focus, .wu-textarea:focus, .wu-select:focus { outline: 1px solid var(--vscode-focusBorder);',
    '  outline-offset: -1px; }',
    '.wu-input[readonly] { color: var(--vscode-descriptionForeground); }',
    '.wu-hint { margin: 0; color: var(--vscode-descriptionForeground); font-size: 0.8em; }',
    '.wu-error { margin: 0; color: var(--vscode-errorForeground); font-size: 0.85em; }',
    '.wu-preview-row { display: flex; gap: 6px; align-items: center; }',
    '.wu-preview-row .wu-input { flex: 1 1 auto; min-width: 0; }',
    '.wu-button { font-family: inherit; font-size: inherit; color: var(--vscode-button-foreground);',
    '  background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 2px;',
    '  padding: 4px 10px; cursor: pointer; }',
    '.wu-button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }',
    '.wu-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }',
    '.wu-button:disabled { opacity: 0.6; cursor: default; }',
    '.wu-button-secondary { color: var(--vscode-button-secondaryForeground);',
    '  background: var(--vscode-button-secondaryBackground); }',
    '.wu-button-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }',
    '.wu-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }',
    '.wu-busy-note { color: var(--vscode-descriptionForeground); font-size: 0.85em; }',
    '.wu-progress { margin-top: 12px; padding: 8px; border: 1px solid var(--vscode-panel-border, transparent);',
    '  border-radius: 3px; }',
    '.wu-progress-head { display: flex; justify-content: space-between; gap: 8px; font-size: 0.85em;',
    '  margin-bottom: 6px; }',
    '.wu-progress-track { height: 4px; border-radius: 2px; overflow: hidden;',
    '  background: var(--vscode-progressBar-background); opacity: 0.25; }',
    '.wu-progress-bar { height: 100%; width: 0; border-radius: 2px;',
    '  background: var(--vscode-progressBar-background); transition: width 0.2s ease; }',
    '.wu-progress-bar.wu-indeterminate { width: 35%; animation: wu-slide 1.2s ease-in-out infinite; }',
    '@keyframes wu-slide { 0% { margin-left: 0; } 50% { margin-left: 65%; } 100% { margin-left: 0; } }',
    '.wu-result { margin-top: 12px; padding: 8px; border-radius: 3px; border: 1px solid var(--vscode-panel-border, transparent);',
    '  overflow-wrap: anywhere; }',
    '.wu-result-ok { border-color: var(--vscode-testing-iconPassed, var(--vscode-panel-border, transparent)); }',
    '.wu-result-error { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }',
    '.wu-result-line { margin: 0 0 4px; }',
    '.wu-result-warning { margin: 6px 0 0; color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));',
    '  font-size: 0.85em; }',
    '.wu-preview-thumb { margin-top: 6px; max-width: 100%; max-height: 160px; border-radius: 3px;',
    '  border: 1px solid var(--vscode-panel-border, transparent); }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .wu-progress-bar { transition: none; }',
    '  .wu-progress-bar.wu-indeterminate { animation: none; width: 100%; }',
    '}',
].join('\n');

function installStyles(): void {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
}

// ─── DOM ─────────────────────────────────────────────────────────────────────

const root = document.getElementById('workshop-upload-root') ?? (() => {
    const created = document.createElement('div');
    created.id = 'workshop-upload-root';
    document.body.appendChild(created);
    return created;
})();

function query<T extends Element>(selector: string): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`workshopUpload: missing element ${selector}`);
    return found;
}

const SHELL = [
    '<header>',
    '  <h1 class="wu-heading" data-wu="heading"></h1>',
    '  <p class="wu-subtitle" data-wu="subtitle"></p>',
    '  <p class="wu-target" data-wu="target"></p>',
    '  <div data-wu="meta"></div>',
    '</header>',
    '<form class="wu-form" novalidate>',
    '  <div class="wu-field">',
    '    <label class="wu-label" for="wu-title" data-wu="labelTitle"></label>',
    '    <input class="wu-input" id="wu-title" type="text" autocomplete="off" />',
    '    <p class="wu-error" data-wu="titleError" role="alert" hidden></p>',
    '  </div>',
    '  <div class="wu-field">',
    '    <label class="wu-label" for="wu-description" data-wu="labelDescription"></label>',
    '    <textarea class="wu-textarea" id="wu-description"></textarea>',
    '  </div>',
    '  <div class="wu-field">',
    '    <label class="wu-label" for="wu-tags" data-wu="labelTags"></label>',
    '    <input class="wu-input" id="wu-tags" type="text" autocomplete="off" />',
    '    <p class="wu-hint" data-wu="tagsHint"></p>',
    '  </div>',
    '  <div class="wu-field">',
    '    <label class="wu-label" for="wu-preview" data-wu="labelPreview"></label>',
    '    <div class="wu-preview-row">',
    '      <input class="wu-input" id="wu-preview" type="text" readonly />',
    '      <button class="wu-button wu-button-secondary" type="button" data-wu="browse"></button>',
    '    </div>',
    '    <img class="wu-preview-thumb" data-wu="previewThumb" alt="" hidden />',
    '  </div>',
    '  <div class="wu-field">',
    '    <label class="wu-label" for="wu-visibility" data-wu="labelVisibility"></label>',
    '    <select class="wu-select" id="wu-visibility" data-wu="visibility"></select>',
    '  </div>',
    '  <div class="wu-field">',
    '    <label class="wu-label" for="wu-change-note" data-wu="labelChangeNote"></label>',
    '    <input class="wu-input" id="wu-change-note" type="text" autocomplete="off" />',
    '  </div>',
    '  <div class="wu-actions">',
    '    <button class="wu-button" type="submit" data-wu="upload"></button>',
    '    <span class="wu-busy-note" data-wu="busyNote" hidden></span>',
    '  </div>',
    '</form>',
    '<section class="wu-progress" data-wu="progress" aria-live="polite" hidden>',
    '  <div class="wu-progress-head">',
    '    <span data-wu="progressStage"></span>',
    '    <span data-wu="progressPercent"></span>',
    '  </div>',
    '  <div class="wu-progress-track"><div class="wu-progress-bar" data-wu="progressBar"></div></div>',
    '</section>',
    '<section class="wu-result" data-wu="result" aria-live="polite" hidden></section>',
].join('\n');

/** Element references, refreshed on every render because the shell is rebuilt. */
interface Ui {
    form: HTMLFormElement;
    title: HTMLInputElement;
    description: HTMLTextAreaElement;
    tags: HTMLInputElement;
    preview: HTMLInputElement;
    previewThumb: HTMLImageElement;
    visibility: HTMLSelectElement;
    changeNote: HTMLInputElement;
    browse: HTMLButtonElement;
    upload: HTMLButtonElement;
    busyNote: HTMLElement;
    titleError: HTMLElement;
    target: HTMLElement;
    meta: HTMLElement;
    progress: HTMLElement;
    progressStage: HTMLElement;
    progressPercent: HTMLElement;
    progressBar: HTMLElement;
    result: HTMLElement;
}

function buildUi(): Ui {
    root.textContent = '';
    root.className = 'wu-root';
    root.innerHTML = SHELL;

    const ui: Ui = {
        form: query<HTMLFormElement>('form'),
        title: query<HTMLInputElement>('#wu-title'),
        description: query<HTMLTextAreaElement>('#wu-description'),
        tags: query<HTMLInputElement>('#wu-tags'),
        preview: query<HTMLInputElement>('#wu-preview'),
        previewThumb: query<HTMLImageElement>('[data-wu="previewThumb"]'),
        visibility: query<HTMLSelectElement>('[data-wu="visibility"]'),
        changeNote: query<HTMLInputElement>('#wu-change-note'),
        browse: query<HTMLButtonElement>('[data-wu="browse"]'),
        upload: query<HTMLButtonElement>('[data-wu="upload"]'),
        busyNote: query<HTMLElement>('[data-wu="busyNote"]'),
        titleError: query<HTMLElement>('[data-wu="titleError"]'),
        target: query<HTMLElement>('[data-wu="target"]'),
        meta: query<HTMLElement>('[data-wu="meta"]'),
        progress: query<HTMLElement>('[data-wu="progress"]'),
        progressStage: query<HTMLElement>('[data-wu="progressStage"]'),
        progressPercent: query<HTMLElement>('[data-wu="progressPercent"]'),
        progressBar: query<HTMLElement>('[data-wu="progressBar"]'),
        result: query<HTMLElement>('[data-wu="result"]'),
    };

    applyLabels();
    applyModel(ui);
    applyBusy(ui);
    return ui;
}

function setText(name: string, text: string): void {
    const node = root.querySelector<HTMLElement>(`[data-wu="${name}"]`);
    if (node) node.textContent = text;
}

function applyLabels(): void {
    const text = t();
    document.documentElement.lang = state.locale === 'zh' ? 'zh-CN' : 'en';

    setText('heading', text.heading);
    setText('subtitle', text.subtitle);
    setText('labelTitle', `${text.fieldTitle} *`);
    setText('titleError', text.titleRequired);
    setText('labelDescription', text.fieldDescription);
    setText('labelTags', text.fieldTags);
    setText('tagsHint', text.tagsHint);
    setText('labelPreview', text.fieldPreview);
    setText('browse', text.browse);
    setText('labelVisibility', text.fieldVisibility);
    setText('labelChangeNote', text.fieldChangeNote);

    query<HTMLInputElement>('#wu-description').placeholder = text.descriptionPlaceholder;
    query<HTMLInputElement>('#wu-tags').placeholder = text.tagsPlaceholder;
    query<HTMLInputElement>('#wu-title').placeholder = text.titlePlaceholder;
    query<HTMLInputElement>('#wu-change-note').placeholder = text.changeNotePlaceholder;

    const select = query<HTMLSelectElement>('[data-wu="visibility"]');
    select.textContent = '';
    for (const value of VISIBILITIES) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = VISIBILITY_LABEL[value][state.locale];
        select.appendChild(option);
    }
}

function applyModel(ui: Ui): void {
    const text = t();
    ui.title.value = state.form.title;
    ui.description.value = state.form.description;
    ui.tags.value = state.form.tags.join(', ');
    ui.changeNote.value = state.form.changeNote;
    ui.visibility.value = state.form.visibility;
    ui.preview.value = state.form.previewPath ?? text.previewPlaceholder;

    if (state.previewUri) {
        ui.previewThumb.src = state.previewUri;
        ui.previewThumb.hidden = false;
    } else {
        ui.previewThumb.removeAttribute('src');
        ui.previewThumb.hidden = true;
    }

    const metaLines: string[] = [];
    if (state.context.modRoot) metaLines.push(`${text.modRoot}: ${state.context.modRoot}`);
    if (state.context.gameId) metaLines.push(`${text.gameId}: ${state.context.gameId}`);
    if (state.context.appId) metaLines.push(`${text.appId}: ${state.context.appId}`);
    ui.meta.textContent = metaLines.join(' · ');

    const remoteFileId = state.context.remoteFileId;
    ui.target.textContent = remoteFileId
        ? format(text.targetUpdate, remoteFileId)
        : text.targetCreate;
}

function applyBusy(ui: Ui): void {
    const active = state.busy || state.pending;
    ui.upload.disabled = active;
    ui.browse.disabled = active;
    ui.busyNote.hidden = !active;
    ui.busyNote.textContent = active ? t().uploading : '';
    ui.form.setAttribute('aria-busy', active ? 'true' : 'false');
}

function showTitleError(ui: Ui, message: string | undefined): void {
    ui.titleError.hidden = !message;
    ui.titleError.textContent = message ?? '';
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function render(): Ui {
    const ui = buildUi();
    ui.upload.textContent = t().upload;

    ui.form.addEventListener('submit', (event: SubmitEvent) => {
        event.preventDefault();
        submitUpload(ui);
    });

    ui.browse.addEventListener('click', () => {
        vscode.postMessage({ type: 'pickPreview' });
    });

    ui.title.addEventListener('input', () => {
        state.form.title = ui.title.value;
        if (ui.title.value.trim().length > 0) showTitleError(ui, undefined);
    });
    ui.description.addEventListener('input', () => {
        state.form.description = ui.description.value;
    });
    ui.tags.addEventListener('input', () => {
        state.form.tags = parseTags(ui.tags.value);
    });
    ui.changeNote.addEventListener('input', () => {
        state.form.changeNote = ui.changeNote.value;
    });
    ui.visibility.addEventListener('change', () => {
        state.form.visibility = asVisibility(ui.visibility.value);
    });
    ui.previewThumb.addEventListener('error', () => {
        ui.previewThumb.hidden = true;
    });

    return ui;
}

function parseTags(raw: string): string[] {
    return raw
        .split(/[,，\n]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
}

function hideProgress(ui: Ui): void {
    ui.progress.hidden = true;
    ui.progressBar.classList.remove('wu-indeterminate');
    ui.progressBar.style.width = '0%';
}

function clearResult(ui: Ui): void {
    ui.result.hidden = true;
    ui.result.textContent = '';
    ui.result.className = 'wu-result';
}

function renderProgress(ui: Ui, stage: UploadStage | undefined, done: number, total: number): void {
    const text = t();
    const label = stage ? STAGE_LABEL[stage][state.locale] : text.stageUnknown;
    const hasTotal = Number.isFinite(total) && total > 0;
    const percent = hasTotal
        ? Math.max(0, Math.min(100, Math.round((Math.max(0, done) / total) * 100)))
        : null;

    ui.progress.hidden = false;
    ui.progressStage.textContent = label;
    ui.progressPercent.textContent = percent === null ? '' : `${percent}%`;

    if (percent === null) {
        ui.progressBar.classList.add('wu-indeterminate');
        ui.progressBar.style.width = '';
    } else {
        ui.progressBar.classList.remove('wu-indeterminate');
        ui.progressBar.style.width = `${percent}%`;
    }
}

function renderResult(
    ui: Ui,
    payload: { ok: boolean; created?: boolean; itemId?: string; url?: string; needsAgreement?: boolean; error?: string }
): void {
    const text = t();
    ui.result.textContent = '';
    ui.result.hidden = false;

    if (!payload.ok) {
        ui.result.className = 'wu-result wu-result-error';
        const line = document.createElement('p');
        line.className = 'wu-result-line';
        const detail = payload.error && payload.error.length > 0 ? payload.error : text.unknownError;
        line.textContent = `${text.resultFailed} ${detail}`;
        ui.result.appendChild(line);
        return;
    }

    ui.result.className = 'wu-result wu-result-ok';

    const headline = document.createElement('p');
    headline.className = 'wu-result-line';
    headline.textContent = payload.created ? text.resultCreated : text.resultUpdated;
    ui.result.appendChild(headline);

    if (payload.itemId) {
        const itemLine = document.createElement('p');
        itemLine.className = 'wu-result-line';
        itemLine.textContent = `${text.itemId}: ${payload.itemId}`;
        ui.result.appendChild(itemLine);
    }

    if (payload.url) {
        const urlLine = document.createElement('p');
        urlLine.className = 'wu-result-line';
        urlLine.textContent = `${text.url}: ${payload.url}`;
        ui.result.appendChild(urlLine);
    }

    if (payload.needsAgreement) {
        const warning = document.createElement('p');
        warning.className = 'wu-result-warning';
        warning.textContent = text.agreementWarning;
        ui.result.appendChild(warning);
    }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function submitUpload(ui: Ui): void {
    // A disabled button cannot be clicked, but Enter inside a text input still
    // submits the form: guard here so one host run stays one upload.
    if (state.busy || state.pending) return;

    state.form.title = ui.title.value;
    state.form.description = ui.description.value;
    state.form.tags = parseTags(ui.tags.value);
    state.form.changeNote = ui.changeNote.value;
    state.form.visibility = asVisibility(ui.visibility.value);

    if (state.form.title.trim().length === 0) {
        showTitleError(ui, t().titleRequired);
        ui.title.focus();
        return;
    }
    showTitleError(ui, undefined);

    clearResult(ui);
    hideProgress(ui);

    const previewPath = state.form.previewPath;
    state.pending = true;
    applyBusy(ui);

    vscode.postMessage({
        type: 'upload',
        data: {
            title: state.form.title,
            description: state.form.description,
            tags: state.form.tags,
            ...(previewPath ? { previewPath } : {}),
            visibility: state.form.visibility,
            changeNote: state.form.changeNote,
        },
    });
}

function applyPrefill(data: Record<string, unknown>): void {
    const locale = asLocale(data.locale);
    if (locale) state.locale = locale;

    state.form.title = asText(data.title);
    state.form.description = asText(data.description);
    state.form.tags = asTags(data.tags);
    state.form.visibility = asVisibility(data.visibility);
    state.form.changeNote = asText(data.changeNote);
    state.form.previewPath = asOptionalText(data.previewPath);

    state.context.modRoot = asText(data.modRoot);
    state.context.appId = asText(data.appId);
    state.context.gameId = asText(data.gameId);
    state.context.remoteFileId = asOptionalText(data.remoteFileId);

    // A prefill invalidates any in-flight run started against the previous values.
    state.busy = false;
    state.pending = false;
    state.previewUri = undefined;

    currentUi = render();
    hideProgress(currentUi);
    clearResult(currentUi);
    showTitleError(currentUi, undefined);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

installStyles();

/** Rebuilt by `prefill`; the message listener below always reads the live shell. */
let currentUi: Ui = render();

window.addEventListener('message', (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message)) return;

    const ui = currentUi;
    switch (asText(message.type)) {
        case 'prefill':
            if (isRecord(message.data)) applyPrefill(message.data);
            break;

        case 'previewPicked': {
            const path = asOptionalText(message.path);
            if (path === undefined) break;
            state.form.previewPath = path;
            state.previewUri = asOptionalText(message.webviewUri);
            ui.preview.value = path;
            if (state.previewUri) {
                ui.previewThumb.src = state.previewUri;
                ui.previewThumb.hidden = false;
            } else {
                ui.previewThumb.removeAttribute('src');
                ui.previewThumb.hidden = true;
            }
            break;
        }

        case 'progress':
            renderProgress(ui, asStage(message.stage), asCount(message.done), asCount(message.total));
            break;

        case 'busy':
            state.busy = message.busy === true;
            if (!state.busy) state.pending = false;
            applyBusy(ui);
            break;

        case 'result':
            state.busy = false;
            state.pending = false;
            applyBusy(ui);
            hideProgress(ui);
            renderResult(ui, {
                ok: message.ok === true,
                created: message.created === true ? true : undefined,
                itemId: asOptionalText(message.itemId),
                url: asOptionalText(message.url),
                needsAgreement: message.needsAgreement === true ? true : undefined,
                error: asOptionalText(message.error),
            });
            break;

        default:
            break;
    }
});

vscode.postMessage({ type: 'ready' });
