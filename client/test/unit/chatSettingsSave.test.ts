/**
 * AI 设置保存的容错回归。
 *
 * 背景：`saveSettings` 曾经是一条无 try 的直写链 —— 任何一个配置键写失败都会中断
 * 整次保存，用户既看不到「设置已保存」，也看不到错误，只有输出通道里一条泛化的
 * `Error handling webview message 'saveSettings'`。这里锁定修复后的契约：
 * 单个键失败只跳过该键，其余设置照常落盘并给出成功提示。
 */
import { expect } from 'chai';

interface StubState {
    writes: Array<{ section: string; key: string; value: unknown }>;
    infos: string[];
    lines: string[];
    /** 模拟一个「本该注册却没有注册」的键，触发 VS Code 的 ERROR_UNKNOWN_KEY。 */
    unregistered: Set<string>;
}

function createState(): StubState {
    return { writes: [], infos: [], lines: [], unregistered: new Set() };
}

let state = createState();

const vscodeStub = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        getConfiguration: (section: string) => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
            update: async (key: string, value: unknown): Promise<void> => {
                if (value !== undefined && state.unregistered.has(key)) {
                    throw new Error(`Unable to write to User Settings because ${key} is not a registered configuration.`);
                }
                state.writes.push({ section, key, value });
            },
        }),
    },
    window: {
        showInformationMessage: (message: string) => { state.infos.push(message); return Promise.resolve(undefined); },
        showErrorMessage: () => Promise.resolve(undefined),
        setStatusBarMessage: () => ({ dispose: () => undefined }),
        createOutputChannel: () => ({
            appendLine: (line: string) => { state.lines.push(line); },
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

function loadManager() {
    const moduleLoader = require('module') as { _load: (request: string, ...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: unknown[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        for (const target of ['../../extension/ai/chatSettings', '../../extension/ai/errorReporter']) {
            delete require.cache[require.resolve(target)];
        }
        const loaded = require('../../extension/ai/chatSettings') as typeof import('../../extension/ai/chatSettings');
        return loaded.ChatSettingsManager;
    } finally {
        moduleLoader._load = originalLoad;
    }
}

function panelSettings() {
    return {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: '',
        endpoint: 'https://api.deepseek.com/v1',
        maxContextTokens: 128000,
        agentFileWriteMode: 'confirm' as const,
        reasoningEffort: 'medium' as const,
        responseVerbosity: 'default' as const,
        codexServiceTier: 'default' as const,
        reasoningKey: '',
        inlineCompletion: {},
        translationPreview: {},
    } as unknown as Parameters<InstanceType<ReturnType<typeof loadManager>>['saveSettings']>[0];
}

function makeManager() {
    const ChatSettingsManager = loadManager();
    const aiService = { getKeyManager: () => ({ setKey: async () => undefined, deleteKey: async () => undefined }) };
    const manager = new ChatSettingsManager(aiService as never, () => undefined);
    // 真实实现会去读七条线路的 SecretStorage；这里只关心保存本身。
    (manager as unknown as { openSettingsPage: () => Promise<void> }).openSettingsPage = async () => undefined;
    return manager;
}

describe('AI settings save resilience', () => {
    beforeEach(() => { state = createState(); });

    it('skips an unregistered key instead of aborting the whole save', async () => {
        state.unregistered.add('provider');
        const manager = makeManager();

        await manager.saveSettings(panelSettings());

        const keys = state.writes.map(entry => entry.key);
        expect(keys).to.include('model');
        expect(keys).to.include('reasoningKey');
        expect(keys).to.include('maxContextTokens');
        expect(keys).not.to.include('provider');
        expect(state.infos).to.have.length(1);
        expect(state.lines.some(line => line.includes("Skipped unregistered AI setting 'provider'"))).to.equal(true);
    });

    it('still reports success when the settings page cannot be repainted', async () => {
        const manager = makeManager();
        (manager as unknown as { openSettingsPage: () => Promise<void> }).openSettingsPage = async () => {
            throw new Error('secret scan exploded');
        };

        await manager.saveSettings(panelSettings());

        expect(state.writes.some(entry => entry.key === 'provider')).to.equal(true);
        expect(state.infos).to.have.length(1);
        expect(state.lines.some(line => line.includes('could not be repainted'))).to.equal(true);
    });
});
