/**
 * quick 档位切换与设置页共用同一份实时目录。
 *
 * 这里执行的是真实的 `ChatSettingsManager.quickChangeReasoningEffort`：只把 vscode 宿主与
 * 设置页重绘换成桩，档位判定本身走真实实现，所以断言的是公开行为，而不是复制一份逻辑。
 */
import { expect } from 'chai';
import type { ModelReasoningCapability, ReasoningEffort } from '../../extension/ai/types';

interface StubState {
    /** 真正写进会话的档位。 */
    overrides: ReasoningEffort[];
    /** 设置页重绘次数；被拒绝的档位不该触发重绘。 */
    repaints: number;
    /** 实时目录被读取的次数；非 Kimi 线路不该读它。 */
    catalogCalls: number;
}

let state: StubState;

const vscodeStub = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
            update: async (): Promise<void> => undefined,
        }),
    },
    window: {
        showInformationMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
        setStatusBarMessage: () => ({ dispose: () => undefined }),
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

type ChatSettingsModule = typeof import('../../extension/ai/chatSettings');
type ProvidersModule = typeof import('../../extension/ai/providers');
type CatalogModule = typeof import('../../extension/ai/kimi/catalog');

interface ManagerLike {
    quickChangeReasoningEffort(effort: ReasoningEffort): Promise<void>;
    buildAndSendSettingsData(...args: unknown[]): Promise<void>;
}

interface Loaded {
    ChatSettingsManager: ChatSettingsModule['ChatSettingsManager'];
    getModelReasoningCapability: ProvidersModule['getModelReasoningCapability'];
    getProviderApiFormat: ProvidersModule['getProviderApiFormat'];
    parseKimiCatalog: CatalogModule['parseKimiCatalog'];
}

/** chatSettings 在模块顶层就 require 了 vscode，所以加载期间必须挂着宿主桩。 */
function loadWithStubbedHost(): Loaded {
    const moduleLoader = require('module') as { _load: (request: string, ...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: unknown[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        for (const target of [
            '../../extension/ai/chatSettings',
            '../../extension/ai/errorReporter',
            '../../extension/ai/providers',
            '../../extension/ai/kimi/catalog',
        ]) {
            delete require.cache[require.resolve(target)];
        }
        const chatSettings = require('../../extension/ai/chatSettings') as ChatSettingsModule;
        const providers = require('../../extension/ai/providers') as ProvidersModule;
        const catalog = require('../../extension/ai/kimi/catalog') as CatalogModule;
        return {
            ChatSettingsManager: chatSettings.ChatSettingsManager,
            getModelReasoningCapability: providers.getModelReasoningCapability,
            getProviderApiFormat: providers.getProviderApiFormat,
            parseKimiCatalog: catalog.parseKimiCatalog,
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

/** 与 quick 实现同一条静态解析路径，避免测试自己另立一套格式推导。 */
function staticCapabilityOf(loaded: Loaded, provider: string, model: string): ModelReasoningCapability {
    return loaded.getModelReasoningCapability(
        provider,
        model,
        loaded.getProviderApiFormat(provider, model, undefined),
    );
}

function createManager(
    loaded: Loaded,
    config: { provider: string; model: string },
    listing: unknown[],
): ManagerLike {
    const aiService = {
        getConfig: () => ({ ...config, customApiFormat: undefined }),
        setReasoningEffortOverride: (effort: ReasoningEffort) => {
            state.overrides.push(effort);
        },
        listKimiCodeModels: async () => {
            state.catalogCalls += 1;
            return loaded.parseKimiCatalog(listing);
        },
    };
    const manager = new loaded.ChatSettingsManager(aiService as never, () => undefined) as unknown as ManagerLike;
    // 重绘会去读七条线路的凭据；这里只关心档位判定本身。
    manager.buildAndSendSettingsData = async () => {
        state.repaints += 1;
    };
    return manager;
}

const ALL_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('quick reasoning effort follows the live Kimi catalog', () => {
    beforeEach(() => {
        state = { overrides: [], repaints: 0, catalogCalls: 0 };
    });

    it('accepts a level only the live directory lists and refuses a stale static one', async () => {
        const loaded = loadWithStubbedHost();
        // The shipped table has never heard of `medium` for K3.1; the account's directory
        // is the only place that level exists.
        const shipped = staticCapabilityOf(loaded, 'kimi-code-plan', 'k3.1-pro');
        expect(shipped.options).to.not.include('medium');
        const stale = shipped.options.find(option => option !== 'medium');
        expect(stale, 'the static table must offer a level the directory has withdrawn').to.not.equal(undefined);

        const manager = createManager(loaded, { provider: 'kimi-code-plan', model: 'k3.1-pro' }, [{
            id: 'k3.1-pro',
            context_length: 262_144,
            think_efforts: { valid_efforts: ['medium'] },
        }]);

        await manager.quickChangeReasoningEffort('medium');
        expect(state.overrides).to.deep.equal(['medium']);
        expect(state.repaints).to.equal(1);

        // The static table still advertises this level, but the directory no longer does:
        // the switch must be refused rather than silently written.
        await manager.quickChangeReasoningEffort(stale!);
        expect(state.overrides).to.deep.equal(['medium']);
        expect(state.repaints).to.equal(1);
    });

    it('passes an explicit "no thinking" through as none only', async () => {
        const loaded = loadWithStubbedHost();
        expect(staticCapabilityOf(loaded, 'kimi-code-plan', 'k3.1-pro').options).to.include('high');

        const manager = createManager(loaded, { provider: 'kimi-code-plan', model: 'k3.1-pro' }, [{
            id: 'k3.1-pro',
            context_length: 262_144,
            supports_thinking_type: 'no',
        }]);

        await manager.quickChangeReasoningEffort('high');
        expect(state.overrides).to.deep.equal([]);
        expect(state.repaints).to.equal(0);

        await manager.quickChangeReasoningEffort('none');
        expect(state.overrides).to.deep.equal(['none']);
        expect(state.repaints).to.equal(1);
    });

    it('keeps the static guidance for a provider the directory does not describe', async () => {
        const loaded = loadWithStubbedHost();
        const config = { provider: 'deepseek', model: 'deepseek-chat' };
        const shipped = staticCapabilityOf(loaded, config.provider, config.model);
        const accepted = shipped.options.find(option => option !== 'none');
        const refused = ALL_EFFORTS.find(option => !shipped.options.includes(option));
        expect(accepted, 'the static table must offer a positive level').to.not.equal(undefined);
        expect(refused, 'the static table must leave some level out').to.not.equal(undefined);

        const manager = createManager(loaded, config, []);
        await manager.quickChangeReasoningEffort(accepted!);
        expect(state.overrides).to.deep.equal([accepted]);

        await manager.quickChangeReasoningEffort(refused!);
        expect(state.overrides).to.deep.equal([accepted]);
        // Another provider never reaches the Kimi loader.
        expect(state.catalogCalls).to.equal(0);
    });

    it('falls back to the static ladder when the directory omits the model', async () => {
        const loaded = loadWithStubbedHost();
        const shipped = staticCapabilityOf(loaded, 'kimi-code-plan', 'k3.1-pro');
        const level = shipped.options.find(option => option !== 'none');
        expect(level).to.not.equal(undefined);

        const manager = createManager(loaded, { provider: 'kimi-code-plan', model: 'k3.1-pro' }, [{
            id: 'kimi-for-coding',
            context_length: 1_048_576,
        }]);
        await manager.quickChangeReasoningEffort(level!);
        expect(state.overrides).to.deep.equal([level]);
        expect(state.catalogCalls).to.equal(1);
    });
});
