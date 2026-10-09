import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Regression tests for the settings form being a draft.
 *
 * The real 'showSettingsPage' (and the helpers it uses) is lifted out of
 * client/webview/chatPanel.ts through the TypeScript AST and executed against a
 * minimal DOM stub, so the assertion is about the shipped render path and not
 * about a copy of it.
 */
const chatPanelPath = path.resolve(__dirname, '../../webview/chatPanel.ts');
const chatPanelSource = fs.readFileSync(chatPanelPath, 'utf8');

const WANTED_FUNCTIONS = [
    'showSettingsPage',
    'settingsFormSignature',
    'settingsHasUnsavedDraft',
    'renderSettingsProviderOptions',
];

function extractFunctionSources(names: string[]): Map<string, string> {
    const file = ts.createSourceFile('chatPanel.ts', chatPanelSource, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const found = new Map<string, string>();
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
            found.set(node.name.text, chatPanelSource.slice(node.getStart(file), node.getEnd()));
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}

function toExecutableSource(fragments: string[]): string {
    return ts.transpileModule(fragments.join('\n\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    }).outputText;
}

class StubClassList {
    private readonly tokens = new Set<string>();
    constructor(initial = '') {
        for (const token of initial.split(' ')) if (token) this.tokens.add(token);
    }
    contains(token: string): boolean { return this.tokens.has(token); }
    add(...tokens: string[]): void { for (const token of tokens) this.tokens.add(token); }
    remove(...tokens: string[]): void { for (const token of tokens) this.tokens.delete(token); }
    toggle(token: string, force?: boolean): boolean {
        const on = force ?? !this.tokens.has(token);
        if (on) this.tokens.add(token); else this.tokens.delete(token);
        return on;
    }
}

class StubElement {
    readonly id: string;
    readonly tagName: string;
    readonly classList: StubClassList;
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    textContent = '';
    placeholder = '';
    title = '';
    type = '';
    checked = false;
    disabled = false;
    hidden = false;
    onchange: unknown = null;
    oninput: unknown = null;
    inSubscriptionProxyGroup = false;
    private readonly children: StubElement[] = [];
    private fieldValue = '';
    private markup = '';
    constructor(id: string, tagName = 'div', className = '') {
        this.id = id;
        this.tagName = tagName;
        this.classList = new StubClassList(className);
    }
    get innerHTML(): string { return this.markup; }
    set innerHTML(next: string) { this.markup = next; }
    get value(): string { return this.fieldValue; }
    set value(next: string) { this.fieldValue = next; }
    closest(selector: string): StubElement | null {
        return selector === '#subscriptionProxyGroup' && this.inSubscriptionProxyGroup ? this : null;
    }
    querySelector(): null { return null; }
    querySelectorAll(): StubElement[] { return []; }
    addEventListener(): void { /* no listeners in this harness */ }
    removeEventListener(): void { /* no listeners in this harness */ }
    dispatchEvent(): boolean { return true; }
    appendChild(child: StubElement): void { this.children.push(child); }
    remove(): void { /* no-op */ }
    setAttribute(): void { /* no-op */ }
    getAttribute(): null { return null; }
}

class StubInputElement extends StubElement { }

class StubButtonElement extends StubElement { }

class StubTextAreaElement extends StubElement { }

class StubOption {
    constructor(readonly value: string, readonly selected: boolean) { }
}

/** Records a repaint/side-effect the render path performs outside the harness. */
type CallLog = Array<{ name: string; args: unknown[] }>;

/** Mirrors the parts of HTMLSelectElement the settings form depends on. */
class StubSelectElement extends StubElement {
    private optionList: StubOption[] = [];
    private selectedIndex = -1;
    private assignedMarkup = '';
    constructor(id: string) { super(id, 'select'); }
    get options(): StubOption[] { return this.optionList; }
    override get innerHTML(): string { return this.assignedMarkup; }
    override set innerHTML(next: string) {
        this.assignedMarkup = next;
        this.optionList = Array.from(next.matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g))
            .map(match => new StubOption(match[1] ?? '', /\bselected\b/.test(match[2] ?? '')));
        const marked = this.optionList.findIndex(option => option.selected);
        this.selectedIndex = marked >= 0 ? marked : (this.optionList.length > 0 ? 0 : -1);
    }
    override get value(): string { return this.optionList[this.selectedIndex]?.value ?? ''; }
    override set value(next: string) { this.selectedIndex = this.optionList.findIndex(option => option.value === next); }
}

const SELECT_IDS = new Set(['settingsProvider', 'inlineProvider', 'translationPreviewProvider', 'subscriptionProxyMode']);
const PROXY_GROUP_IDS = new Set(['subscriptionProxyMode', 'subscriptionProxyUrl', 'subscriptionProxySaveBtn', 'subscriptionProxyRefreshBtn', 'subscriptionProxyStatus']);

interface Harness {
    readonly deps: Record<string, unknown>;
    readonly calls: Array<{ name: string; args: unknown[] }>;
    render(providers: unknown[], current: unknown, ollamaModels?: unknown[], reloadForm?: boolean): void;
    element(id: string): StubElement;
    select(id: string): StubSelectElement;
    isDirty(): boolean;
    accountRepaintProviders(): string[];
    resetCalls(): void;
}

function createHarness(): Harness {
    const calls: CallLog = [];
    const elementById = new Map<string, StubElement>();
    const formFields: StubElement[] = [];
    const record = (name: string) => (...args: unknown[]): undefined => { calls.push({ name, args }); return undefined; };
    const accountRepaintProviders: string[] = [];

    const createElement = (id: string): StubElement => {
        const element = SELECT_IDS.has(id)
            ? new StubSelectElement(id)
            : new StubInputElement(id, 'input');
        element.inSubscriptionProxyGroup = PROXY_GROUP_IDS.has(id);
        elementById.set(id, element);
        if (id !== 'settingsPage') formFields.push(element);
        return element;
    };
    const element = (id: string): StubElement => elementById.get(id) ?? createElement(id);

    const settingsPage = new StubElement('settingsPage', 'div', 'settings-page');
    const formFieldsInPage = formFields;
    settingsPage.querySelectorAll = ((selector: string): StubElement[] => (selector.includes('input') ? [...formFieldsInPage] : [])) as unknown as () => StubElement[];
    elementById.set('settingsPage', settingsPage);

    const document = {
        getElementById: (id: string): StubElement | null => element(id),
        querySelectorAll: (): StubElement[] => [],
        querySelector: (): null => null,
        body: new StubElement('body', 'body'),
        createElement: (tag: string): StubElement => new StubElement('', tag),
    };

    const deps: Record<string, unknown> = {
        document,
        settingsPage,
        chatHeader: new StubElement('chatHeader', 'div'),
        inputWrapper: new StubElement('inputWrapper', 'div'),
        todoPanel: new StubElement('todoPanel', 'div'),
        settingsBody: new StubElement('settingsBody', 'div'),
        settingsModelInputTimer: undefined,
        activeSettingsTab: 'models',
        settingsTabScroll: {},
        HTMLSelectElement: StubSelectElement,
        HTMLInputElement: StubInputElement,
        HTMLButtonElement: StubButtonElement,
        HTMLTextAreaElement: StubTextAreaElement,
        chatI18n: { locale: 'zh-cn' },
        tr: (_en: string, zh: string) => zh,
        escapeHtml: (value: unknown) => String(value),
        settingsProviders: [],
        settingsOllamaModels: [],
        settingsProviderEndpoints: {},
        settingsThinkingPrefixes: [],
        settingsReasoningCapabilities: {},
        settingsModelContextTokens: {},
        settingsSubscriptionPools: {},
        settingsSubscriptionProxy: undefined,
        settingsCodexAccount: undefined,
        settingsAntigravityAccount: undefined,
        settingsCommandCodeAccount: undefined,
        settingsKimiAccount: undefined,
        settingsWorkBuddyAccount: undefined,
        settingsWorkBuddyCheckin: undefined,
        settingsMinimaxCodeAccount: undefined,
        settingsClaudeSubscriptionAccount: undefined,
        lastSettingsPageSignature: '',
        settingsFormBaseline: null,
        settingsSavePending: false,
        settingsInSideWorkspace: false,
        responsiveWorkspacePinnedClosed: false,
        activeResponsiveWorkspace: undefined,
        isManagerShell: () => false,
        shouldUseSideWorkspace: () => false,
        updateApiKeyStatus: (providerId: string) => { accountRepaintProviders.push(String(providerId)); },
        selectedPoolProviderId: () => (document.getElementById('settingsProvider') as StubSelectElement | null)?.value ?? '',
        updateQuickModelSelector: record('updateQuickModelSelector'),
        updateQuickWriteModeSelector: record('updateQuickWriteModeSelector'),
        updateContextControls: record('updateContextControls'),
        updateCustomApiFormatUI: record('updateCustomApiFormatUI'),
        updateModelUI: record('updateModelUI'),
        refreshSettingsOverview: record('refreshSettingsOverview'),
        refreshSettingsDraftStatus: record('refreshSettingsDraftStatus'),
        openSideWorkspace: record('openSideWorkspace'),
        closeSideWorkspace: record('closeSideWorkspace'),
        addMcpServerBlock: record('addMcpServerBlock'),
        setupApDropdown: record('setupApDropdown'),
    };

    // Anything the form touches that this harness does not care about resolves to
    // a self-referential stub, so an unrecognised element or helper can neither
    // throw nor silently change the behaviour under test.
    const makeUniversalStub = (): unknown => {
        const stub = function universalStub(): unknown { return makeUniversalStub(); };
        return new Proxy(stub, {
            get: (target, property) => {
                if (property === 'style' || property === 'dataset' || property === 'classList') {
                    return new Proxy({}, { get: () => () => undefined, set: () => true });
                }
                if (property === Symbol.toPrimitive || property === 'valueOf' || property === 'toString') {
                    return () => '';
                }
                if (property === 'length') return 0;
                if (typeof property === 'symbol') return undefined;
                return makeUniversalStub();
            },
            set: () => true,
            apply: () => makeUniversalStub(),
        });
    };

    const sources = extractFunctionSources(WANTED_FUNCTIONS);
    const stubs = new Map<string, (...args: unknown[]) => undefined>();
    const proxy = new Proxy(deps, {
        has: () => true,
        get: (target, property) => {
            if (typeof property === 'symbol') return undefined;
            if (property in target) return target[property as string];
            const globalValue = (globalThis as Record<string, unknown>)[property];
            if (globalValue !== undefined) return globalValue;
            let stub = stubs.get(property);
            if (!stub) { stub = record(property); stubs.set(property, stub); }
            return stub;
        },
        set: (target, property, value) => { if (typeof property === 'string') target[property] = value; return true; },
    });
    void makeUniversalStub;

    const evaluateFirst = (names: string[]): void => {
        const available = names.filter(name => sources.has(name));
        if (available.length === 0) return;
        const factory = new Function('__deps', 'with (__deps) { ' + toExecutableSource(available.map(name => sources.get(name) as string)) + ' return { ' + available.join(', ') + ' }; }');
        const produced = factory(proxy) as Record<string, unknown>;
        for (const name of available) deps[name] = produced[name];
    };
    // The helpers are evaluated first so the render function can call them; a
    // helper that does not exist yet simply stays unresolved (and its caller
    // would then behave as if it always returned a falsy value).
    evaluateFirst(WANTED_FUNCTIONS.filter(name => name !== 'showSettingsPage'));
    evaluateFirst(['showSettingsPage']);

    const showSettingsPage = deps.showSettingsPage as (providers: unknown[], current: unknown, ollamaModels: unknown[], reloadForm?: boolean) => void;
    const formSignature = deps.settingsFormSignature as () => string;

    return {
        deps,
        calls,
        render(providers, current, ollamaModels = [], reloadForm = false) {
            deps.providers = providers;
            deps.current = current;
            deps.ollamaModels = ollamaModels;
            showSettingsPage(providers, current, ollamaModels, reloadForm);
        },
        element,
        select: (id: string) => element(id) as StubSelectElement,
        isDirty: () => deps.settingsFormBaseline !== null && formSignature() !== deps.settingsFormBaseline,
        accountRepaintProviders: () => [...accountRepaintProviders],
        resetCalls: () => { accountRepaintProviders.length = 0; calls.length = 0; },
    };
}

const SAVED_PROVIDERS = [
    { id: 'custom', name: 'Custom line', models: [], hasKey: true, supportsUtilityCalls: true, userEndpoint: '' },
    { id: 'minimax-code', name: 'MiniMax Code', models: [], hasKey: false, supportsUtilityCalls: true, userEndpoint: '' },
];

function savedConfig(provider: string, endpoint: string): Record<string, unknown> {
    return {
        provider,
        model: provider + '-model',
        endpoint,
        customApiFormat: 'openai-chat-completions',
        maxContextTokens: 32000,
        reasoningEffort: 'high',
        responseVerbosity: 'default',
        codexServiceTier: 'default',
        inlineCompletion: { enabled: false },
        translationPreview: {},
        webAccess: {},
        mcp: {},
    };
}

describe('settings page draft preservation', () => {
    it('keeps the unsaved provider line and still repaints that line\'s account state', () => {
        const harness = createHarness();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));
        const providerSelect = harness.select('settingsProvider');
        expect(providerSelect.value).to.equal('custom');

        // The user picks another line in the dropdown and has not saved it yet.
        providerSelect.value = 'minimax-code';
        expect(harness.isDirty(), 'picking another line is an unsaved change').to.equal(true);

        // Signing in changes account state only; the host pushes the saved config back.
        harness.deps.settingsMinimaxCodeAccount = { signedIn: true, fresh: true };
        harness.resetCalls();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));

        expect(providerSelect.value, 'the unsaved dropdown choice survives a settings refresh').to.equal('minimax-code');
        expect(harness.accountRepaintProviders(), 'the draft line is the one whose account state is repainted')
            .to.deep.equal(['minimax-code']);
        expect(harness.isDirty(), 'the unsaved-changes indicator stays on').to.equal(true);
    });

    it('follows the saved line when the user never touched the dropdown', () => {
        const harness = createHarness();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));
        const providerSelect = harness.select('settingsProvider');

        harness.deps.settingsMinimaxCodeAccount = { signedIn: true, fresh: true };
        harness.resetCalls();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));

        expect(providerSelect.value, 'an untouched form keeps tracking the saved configuration').to.equal('custom');
        expect(harness.accountRepaintProviders()).to.deep.equal(['custom']);
    });

    it('reloads the form from the saved configuration once the user saves', () => {
        const harness = createHarness();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));
        const providerSelect = harness.select('settingsProvider');
        const endpointInput = harness.element('settingsEndpoint');
        providerSelect.value = 'minimax-code';
        endpointInput.value = 'https://typed-by-hand.example/v1';

        // The user hits save; the host's answer carries what is now saved.
        harness.deps.settingsSavePending = true;
        harness.deps.settingsMinimaxCodeAccount = { signedIn: true, fresh: true };
        harness.render(SAVED_PROVIDERS, savedConfig('minimax-code', 'https://saved.example/v2'));

        expect(providerSelect.value, 'the dropdown shows the saved line after a save').to.equal('minimax-code');
        expect(endpointInput.value, 'the saved endpoint replaces the typed draft').to.equal('https://saved.example/v2');
        expect(harness.isDirty(), 'a saved form has no pending changes').to.equal(false);
    });

    it('refreshes the provider option list without dropping the draft selection', () => {
        const harness = createHarness();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));
        const providerSelect = harness.select('settingsProvider');
        providerSelect.value = 'minimax-code';

        const extended = [...SAVED_PROVIDERS, { id: 'kimi-code-plan', name: 'Kimi Code', models: [], hasKey: false, userEndpoint: '' }];
        harness.deps.settingsMinimaxCodeAccount = { signedIn: true, fresh: true };
        harness.render(extended, savedConfig('custom', 'https://saved.example/v1'));

        expect(Array.from(providerSelect.options).map(option => option.value), 'the option set stays current').to.deep.equal(['custom', 'minimax-code', 'kimi-code-plan']);
        expect(providerSelect.value, 'the draft selection is the only thing preserved').to.equal('minimax-code');
    });

    it('discards the draft when the caller asks the form to start over', () => {
        const harness = createHarness();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));
        const providerSelect = harness.select('settingsProvider');
        providerSelect.value = 'minimax-code';

        // The discard handler clears the signature first so the rebuild is not
        // skipped as a no-op repaint, then asks for a reload from the saved state.
        harness.deps.lastSettingsPageSignature = '';
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'), [], true);

        expect(providerSelect.value, 'an explicit reload drops the draft').to.equal('custom');
        expect(harness.isDirty(), 'the reloaded form has no pending changes').to.equal(false);
    });

    it('rebuilds the form when the draft line itself disappears', () => {
        const harness = createHarness();
        harness.render(SAVED_PROVIDERS, savedConfig('custom', 'https://saved.example/v1'));
        const providerSelect = harness.select('settingsProvider');
        providerSelect.value = 'minimax-code';

        harness.deps.settingsMinimaxCodeAccount = { signedIn: true, fresh: true };
        harness.render([SAVED_PROVIDERS[0]!], savedConfig('custom', 'https://saved.example/v1'));

        expect(providerSelect.value, 'a vanished draft line falls back to the saved one').to.equal('custom');
    });
});
