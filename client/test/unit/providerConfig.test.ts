import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    clearProviderConfigCache,
    getAgentModelOverrides,
    getHomeProviderApiKeyEnv,
    getHomeProviderEndpoint,
    getHomeProviders,
    isHomeProviderId,
    loadHomeAgentModelOverrides,
    loadHomeProviderConfigs,
    mergeAgentModelOverrides,
} from '../../extension/ai/providerConfig';

/**
 * The loaders read ~/.cwtools/*.json via os.homedir(); tests redirect the home
 * directory into a temp sandbox so the real user files are never touched
 * (same raw-module patching as mcpConfig.test.ts).
 */
const rawOs = require('os') as typeof os & { homedir: () => string };

function redirectHomedir(fakeHome: string): () => void {
    const original = rawOs.homedir;
    rawOs.homedir = () => fakeHome;
    return () => { rawOs.homedir = original; };
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
    env: { language: 'en' },
};

/** Load a vscode-bound module under the stub, restoring the cache entry afterwards. */
function loadWithVscodeStub<T>(id: string): T {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    const resolved = require.resolve(id);
    const previous = require.cache[resolved];
    delete require.cache[resolved];
    try {
        return require(id) as T;
    } finally {
        moduleLoader._load = originalLoad;
        delete require.cache[resolved];
        if (previous) require.cache[resolved] = previous;
    }
}

describe('home provider file configs (~/.cwtools/providers.json)', () => {
    let sandbox: string;
    let fakeHome: string;
    let restoreHomedir: () => void;

    const writeProviders = (content: unknown) => {
        const dir = path.join(fakeHome, '.cwtools');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'providers.json'),
            typeof content === 'string' ? content : JSON.stringify(content),
            'utf8',
        );
    };

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-provider-config-'));
        fakeHome = path.join(sandbox, 'home');
        restoreHomedir = redirectHomedir(fakeHome);
        clearProviderConfigCache();
    });

    afterEach(() => {
        restoreHomedir();
        clearProviderConfigCache();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it('returns empty results when the file does not exist', () => {
        const result = loadHomeProviderConfigs();
        expect(result.providers).to.deep.equal({});
        expect(result.warnings).to.deep.equal([]);
        expect(result.filePath).to.equal(path.join(fakeHome, '.cwtools', 'providers.json'));
        expect(isHomeProviderId('anything')).to.equal(false);
    });

    it('loads a valid entry with defaults derived from the wire format', () => {
        writeProviders({
            providers: {
                'my-relay': {
                    name: 'My Relay',
                    endpoint: 'https://relay.example.com/v1',
                    models: ['relay-pro', 'relay-fast'],
                    defaultModel: 'relay-pro',
                    apiKeyEnv: 'MY_RELAY_KEY',
                },
            },
        });
        const result = loadHomeProviderConfigs();
        expect(result.warnings).to.deep.equal([]);
        const entry = result.providers['my-relay'];
        expect(entry).to.deep.include({
            id: 'my-relay',
            name: 'My Relay',
            endpoint: 'https://relay.example.com/v1',
            defaultModel: 'relay-pro',
            requiresApiKey: true,
            supportsToolUse: true,
            supportsStreaming: true,
            maxContextTokens: 128000,
            isOpenAICompatible: true,
            toolCallStyle: 'openai',
            supportsFIM: false,
            supportsVision: false,
            apiFormatHint: 'openai-chat-completions',
            source: 'home',
            apiKeyEnv: 'MY_RELAY_KEY',
        });
        expect(entry?.models).to.deep.equal(['relay-pro', 'relay-fast']);
    });

    it('maps anthropic-messages to a non-OpenAI-compatible entry', () => {
        writeProviders({
            providers: {
                'claude-relay': {
                    endpoint: 'https://relay.example.com/anthropic',
                    models: ['claude-x'],
                    apiFormat: 'anthropic-messages',
                },
            },
        });
        const entry = loadHomeProviderConfigs().providers['claude-relay'];
        expect(entry?.apiFormatHint).to.equal('anthropic-messages');
        expect(entry?.isOpenAICompatible).to.equal(false);
    });

    it('skips entries that collide with a built-in provider id', () => {
        writeProviders({
            providers: {
                openai: { endpoint: 'https://evil.example.com/v1', models: ['x'] },
                legit: { endpoint: 'https://ok.example.com/v1', models: ['y'] },
            },
        });
        const result = loadHomeProviderConfigs();
        expect(Object.keys(result.providers)).to.deep.equal(['legit']);
        expect(result.warnings.some(w => w.includes('openai') && w.includes('built-in'))).to.equal(true);
    });

    it('skips entries with a missing, non-http, or malformed endpoint', () => {
        writeProviders({
            providers: {
                noEndpoint: { models: ['x'] },
                badProtocol: { endpoint: 'ftp://example.com/v1', models: ['x'] },
                notAUrl: { endpoint: '::not a url::', models: ['x'] },
                ok: { endpoint: 'http://localhost:8080/v1', models: ['x'] },
            },
        });
        const result = loadHomeProviderConfigs();
        expect(Object.keys(result.providers)).to.deep.equal(['ok']);
        expect(result.warnings.filter(w => w.includes('endpoint')).length).to.equal(3);
    });

    it('skips entries with invalid ids', () => {
        writeProviders({
            providers: {
                'has space': { endpoint: 'https://a.example.com/v1', models: ['x'] },
                ['x'.repeat(65)]: { endpoint: 'https://b.example.com/v1', models: ['x'] },
                'valid-id.1_2': { endpoint: 'https://c.example.com/v1', models: ['x'] },
            },
        });
        const result = loadHomeProviderConfigs();
        expect(Object.keys(result.providers)).to.deep.equal(['valid-id.1_2']);
        expect(result.warnings.filter(w => w.includes('invalid id')).length).to.equal(2);
    });

    it('narrows models to strings and defaults defaultModel to the first model', () => {
        writeProviders({
            providers: { p: { endpoint: 'https://a.example.com/v1', models: ['a', 1, null, 'b'] } },
        });
        const result = loadHomeProviderConfigs();
        expect(result.providers['p']?.models).to.deep.equal(['a', 'b']);
        expect(result.providers['p']?.defaultModel).to.equal('a');
        expect(result.warnings.some(w => w.includes("non-string 'models'"))).to.equal(true);
    });

    it('requires models to be an array', () => {
        writeProviders({ providers: { p: { endpoint: 'https://a.example.com/v1', models: 'nope' } } });
        const result = loadHomeProviderConfigs();
        expect(result.providers).to.deep.equal({});
        expect(result.warnings.some(w => w.includes("'models'"))).to.equal(true);
    });

    it('validates apiKeyEnv as an environment variable name and never stores a key', () => {
        writeProviders({
            providers: {
                badEnv: { endpoint: 'https://a.example.com/v1', models: ['x'], apiKeyEnv: '1BAD-NAME' },
                goodEnv: { endpoint: 'https://b.example.com/v1', models: ['x'], apiKeyEnv: 'GOOD_NAME_2' },
            },
        });
        const result = loadHomeProviderConfigs();
        expect(result.providers['badEnv']?.apiKeyEnv).to.equal(undefined);
        expect(result.providers['goodEnv']?.apiKeyEnv).to.equal('GOOD_NAME_2');
        expect(result.warnings.some(w => w.includes('apiKeyEnv'))).to.equal(true);
        expect(JSON.stringify(result.providers)).to.not.include('sk-');
    });

    it('honours requiresApiKey/supportsVision/maxContextTokens when well-formed', () => {
        writeProviders({
            providers: {
                local: {
                    endpoint: 'http://localhost:9000/v1',
                    models: ['m'],
                    requiresApiKey: false,
                    supportsVision: true,
                    maxContextTokens: 64000,
                },
                badNums: {
                    endpoint: 'https://a.example.com/v1',
                    models: ['m'],
                    requiresApiKey: 'yes',
                    supportsVision: 1,
                    maxContextTokens: -5,
                },
            },
        });
        const result = loadHomeProviderConfigs();
        const local = result.providers['local'];
        expect(local?.requiresApiKey).to.equal(false);
        expect(local?.supportsVision).to.equal(true);
        expect(local?.maxContextTokens).to.equal(64000);
        const bad = result.providers['badNums'];
        expect(bad?.requiresApiKey).to.equal(true);
        expect(bad?.supportsVision).to.equal(false);
        expect(bad?.maxContextTokens).to.equal(128000);
    });

    it('collects a warning instead of throwing on invalid JSON or wrong root shape', () => {
        writeProviders('{ not json');
        let result = loadHomeProviderConfigs();
        expect(result.providers).to.deep.equal({});
        expect(result.warnings.some(w => w.includes('invalid JSON'))).to.equal(true);

        clearProviderConfigCache();
        writeProviders({ providers: ['nope'] });
        result = loadHomeProviderConfigs();
        expect(result.warnings.some(w => w.includes("'providers'"))).to.equal(true);
    });

    it('serves repeat calls from the mtime cache and reloads after a rewrite', () => {
        writeProviders({ providers: { a: { endpoint: 'https://a.example.com/v1', models: ['x'] } } });
        const first = loadHomeProviderConfigs();
        const second = loadHomeProviderConfigs();
        expect(second).to.equal(first);

        writeProviders({
            providers: {
                a: { endpoint: 'https://a.example.com/v1', models: ['x'] },
                b: { endpoint: 'https://b.example.com/v1', models: ['y'] },
            },
        });
        const third = loadHomeProviderConfigs();
        expect(third.version).to.not.equal(first.version);
        expect(Object.keys(third.providers)).to.deep.equal(['a', 'b']);
    });

    it('exposes endpoint and apiKeyEnv helpers', () => {
        writeProviders({
            providers: { p: { endpoint: 'https://a.example.com/v1/', models: ['x'], apiKeyEnv: 'P_KEY' } },
        });
        expect(getHomeProviderEndpoint('p')).to.equal('https://a.example.com/v1');
        expect(getHomeProviderEndpoint('openai')).to.equal('');
        expect(getHomeProviderApiKeyEnv('p')).to.equal('P_KEY');
        expect(getHomeProviderApiKeyEnv('openai')).to.equal(undefined);
        expect(isHomeProviderId('p')).to.equal(true);
        expect(Object.keys(getHomeProviders())).to.deep.equal(['p']);
    });
});

describe('home agent-model overrides (~/.cwtools/agent-models.json)', () => {
    let sandbox: string;
    let fakeHome: string;
    let restoreHomedir: () => void;

    const writeAgentModels = (content: unknown) => {
        const dir = path.join(fakeHome, '.cwtools');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'agent-models.json'),
            typeof content === 'string' ? content : JSON.stringify(content),
            'utf8',
        );
    };

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-agent-models-'));
        fakeHome = path.join(sandbox, 'home');
        restoreHomedir = redirectHomedir(fakeHome);
        clearProviderConfigCache();
    });

    afterEach(() => {
        restoreHomedir();
        clearProviderConfigCache();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it('returns empty results when the file does not exist', () => {
        const result = loadHomeAgentModelOverrides();
        expect(result.agentModels).to.deep.equal({});
        expect(result.warnings).to.deep.equal([]);
    });

    it('loads valid assignments', () => {
        writeAgentModels({ agentModels: { reviewer: { provider: 'deepseek', model: 'deepseek-flash' } } });
        const result = loadHomeAgentModelOverrides();
        expect(result.warnings).to.deep.equal([]);
        expect(result.agentModels).to.deep.equal({ reviewer: { provider: 'deepseek', model: 'deepseek-flash' } });
    });

    it('skips invalid roles, non-object entries, and __inherit__ sentinels', () => {
        writeAgentModels({
            agentModels: {
                'bad role': { provider: 'deepseek', model: 'x' },
                notObject: 'deepseek:x',
                inherit: { provider: '__inherit__', model: 'x' },
                ok: { provider: 'deepseek', model: 'deepseek-flash' },
            },
        });
        const result = loadHomeAgentModelOverrides();
        expect(Object.keys(result.agentModels)).to.deep.equal(['ok']);
        expect(result.warnings.length).to.equal(3);
    });

    it('warns on unknown provider ids but keeps the entry', () => {
        writeAgentModels({ agentModels: { build: { provider: 'typo-provider', model: 'm' } } });
        const result = loadHomeAgentModelOverrides();
        expect(result.agentModels['build']).to.deep.equal({ provider: 'typo-provider', model: 'm' });
        expect(result.warnings.some(w => w.includes('unknown provider'))).to.equal(true);
    });

    it('accepts provider ids declared in providers.json without a warning', () => {
        const dir = path.join(fakeHome, '.cwtools');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
            providers: { 'my-relay': { endpoint: 'https://r.example.com/v1', models: ['m'] } },
        }), 'utf8');
        writeAgentModels({ agentModels: { build: { provider: 'my-relay', model: 'm' } } });
        const result = loadHomeAgentModelOverrides();
        expect(result.warnings).to.deep.equal([]);
        expect(result.agentModels['build']?.provider).to.equal('my-relay');
    });

    it('merges settings below home, whole-entry, with source annotations', () => {
        writeAgentModels({
            agentModels: {
                reviewer: { provider: 'deepseek', model: 'deepseek-flash' },
                build: { provider: 'openai', model: 'gpt-6-astra' },
            },
        });
        const merged = getAgentModelOverrides({
            reviewer: { provider: 'openai', model: 'gpt-5.5' },
            script: { provider: 'glm', model: 'glm-5.2' },
        });
        expect(merged?.['reviewer']).to.deep.equal({ provider: 'deepseek', model: 'deepseek-flash', source: 'home' });
        expect(merged?.['build']).to.deep.equal({ provider: 'openai', model: 'gpt-6-astra', source: 'home' });
        expect(merged?.['script']).to.deep.equal({ provider: 'glm', model: 'glm-5.2', source: 'settings' });
    });

    it('returns undefined when neither layer assigns a role', () => {
        expect(getAgentModelOverrides(undefined)).to.equal(undefined);
        expect(getAgentModelOverrides({})).to.equal(undefined);
    });

    it('mergeAgentModelOverrides skips malformed settings entries', () => {
        const merged = mergeAgentModelOverrides(
            { ok: { provider: 'openai', model: 'm' }, broken: { provider: 1 } as unknown as { provider: string; model: string } },
            {},
        );
        expect(Object.keys(merged)).to.deep.equal(['ok']);
    });

    it('migrates a retired Kimi K2.5 assignment in the effective result only', () => {
        writeAgentModels({
            agentModels: { reviewer: { provider: 'kimi', model: 'kimi-k2.5' } },
        });
        const merged = getAgentModelOverrides({
            build: { provider: 'kimi', model: 'kimi-k2.5' },
            script: { provider: 'openrouter', model: 'kimi-k2.5' },
            custom: { provider: 'kimi', model: 'my-relay-k2.5' },
        });
        // Both layers are migrated on the way out.
        expect(merged?.['reviewer']).to.deep.equal({ provider: 'kimi', model: 'kimi-k3.1-pro', source: 'home' });
        expect(merged?.['build']).to.deep.equal({ provider: 'kimi', model: 'kimi-k3.1-pro', source: 'settings' });
        // Another provider, and a custom id that merely mentions k2.5, are left alone.
        expect(merged?.['script']).to.deep.equal({ provider: 'openrouter', model: 'kimi-k2.5', source: 'settings' });
        expect(merged?.['custom']).to.deep.equal({ provider: 'kimi', model: 'my-relay-k2.5', source: 'settings' });
        // Nothing was written back: the file still holds what the user typed.
        expect(loadHomeAgentModelOverrides().agentModels['reviewer']).to.deep.equal({ provider: 'kimi', model: 'kimi-k2.5' });
    });
});

describe('provider registry integration (providers.ts)', () => {
    let sandbox: string;
    let fakeHome: string;
    let restoreHomedir: () => void;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-provider-reg-'));
        fakeHome = path.join(sandbox, 'home');
        restoreHomedir = redirectHomedir(fakeHome);
        clearProviderConfigCache();
    });

    afterEach(() => {
        restoreHomedir();
        clearProviderConfigCache();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function writeProviders(content: unknown) {
        const dir = path.join(fakeHome, '.cwtools');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(content), 'utf8');
    }

    it('resolves home providers through getProvider and keeps the openai fallback', () => {
        writeProviders({
            providers: { 'my-relay': { endpoint: 'https://r.example.com/v1', models: ['m1'], apiFormat: 'anthropic-messages' } },
        });
        const providers = loadWithVscodeStub<typeof import('../../extension/ai/providers')>('../../extension/ai/providers');
        const home = providers.getProvider('my-relay');
        expect(home.endpoint).to.equal('https://r.example.com/v1');
        expect(home.apiFormatHint).to.equal('anthropic-messages');
        // Built-ins are untouched.
        expect(providers.getProvider('openai').endpoint).to.equal('https://api.openai.com/v1');
        // Unknown ids still fall back to openai.
        expect(providers.getProvider('no-such-line').id).to.equal('openai');
    });

    it('prefers the home apiFormatHint in getProviderApiFormat', () => {
        writeProviders({
            providers: {
                'anth-line': { endpoint: 'https://a.example.com/v1', models: ['m'], apiFormat: 'anthropic-messages' },
                'gem-line': { endpoint: 'https://g.example.com/v1', models: ['m'], apiFormat: 'gemini-generate-content' },
                'oa-line': { endpoint: 'https://o.example.com/v1', models: ['m'] },
            },
        });
        const providers = loadWithVscodeStub<typeof import('../../extension/ai/providers')>('../../extension/ai/providers');
        expect(providers.getProviderApiFormat('anth-line', 'm')).to.equal('anthropic-messages');
        expect(providers.getProviderApiFormat('gem-line', 'm')).to.equal('gemini-generate-content');
        expect(providers.getProviderApiFormat('oa-line', 'm')).to.equal('openai-chat-completions');
        // Built-in behavior is unchanged.
        expect(providers.getProviderApiFormat('claude', 'claude-opus-4-8')).to.equal('anthropic-messages');
        expect(providers.getProviderApiFormat('openai', 'gpt-6-astra')).to.equal('openai-responses');
        expect(providers.getProviderApiFormat('custom', 'm', 'gemini-generate-content')).to.equal('gemini-generate-content');
    });
});

describe('AIService home provider credential order', () => {
    let sandbox: string;
    let fakeHome: string;
    let restoreHomedir: () => void;
    const ENV_NAME = 'CWTOOLS_TEST_HOME_PROVIDER_KEY';

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-provider-key-'));
        fakeHome = path.join(sandbox, 'home');
        restoreHomedir = redirectHomedir(fakeHome);
        clearProviderConfigCache();
        delete process.env[ENV_NAME];
        const dir = path.join(fakeHome, '.cwtools');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
            providers: {
                'env-line': { endpoint: 'https://e.example.com/v1', models: ['m'], apiKeyEnv: ENV_NAME },
                'stored-line': { endpoint: 'https://s.example.com/v1', models: ['m'] },
            },
        }), 'utf8');
    });

    afterEach(() => {
        restoreHomedir();
        clearProviderConfigCache();
        delete process.env[ENV_NAME];
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function makeService(secrets: Map<string, string>) {
        const { AIService } = loadWithVscodeStub<typeof import('../../extension/ai/aiService')>('../../extension/ai/aiService');
        const subscriptions: Array<{ dispose(): void }> = [];
        const context: Pick<import('vscode').ExtensionContext, 'secrets' | 'subscriptions'> = {
            secrets: {
                get: async key => secrets.get(key),
                store: async (key, value) => { secrets.set(key, value); },
                delete: async key => { secrets.delete(key); },
                onDidChange: () => ({ dispose() {} }),
            },
            subscriptions,
        };
        return new AIService(context as import('vscode').ExtensionContext);
    }

    it('reads the key from the named environment variable before SecretStorage', async () => {
        const secrets = new Map<string, string>([['cwtools.ai.apiKey.env-line', 'stored-key']]);
        process.env[ENV_NAME] = 'env-key';
        const service = makeService(secrets);
        expect(await service.getKeyForProvider('env-line')).to.equal('env-key');
    });

    it('falls back to SecretStorage when the env var is unset or blank', async () => {
        const secrets = new Map<string, string>([['cwtools.ai.apiKey.env-line', 'stored-key']]);
        const service = makeService(secrets);
        expect(await service.getKeyForProvider('env-line')).to.equal('stored-key');
        process.env[ENV_NAME] = '   ';
        expect(await service.getKeyForProvider('env-line')).to.equal('stored-key');
    });

    it('allows SecretStorage for home providers without apiKeyEnv', async () => {
        const secrets = new Map<string, string>([['cwtools.ai.apiKey.stored-line', 'stored-key-2']]);
        const service = makeService(secrets);
        expect(await service.getKeyForProvider('stored-line')).to.equal('stored-key-2');
        expect(await service.getKeyForProvider('env-line')).to.equal('');
    });
});
