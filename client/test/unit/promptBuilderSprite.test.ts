import { expect } from 'chai';

const vscodeStub = {
    workspace: {
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
};

function loadPromptBuilder() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/promptBuilder') as typeof import('../../extension/ai/promptBuilder');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('PromptBuilder sprite diagnostics', () => {
    let PromptBuilder: typeof import('../../extension/ai/promptBuilder').PromptBuilder;

    before(() => {
        PromptBuilder = loadPromptBuilder().PromptBuilder;
    });

    it('adds sprite candidate guidance to validation retries', () => {
        const builder = new PromptBuilder(process.cwd());
        const message = builder.buildValidationRetryMessage('', [
            { message: 'Expected value of type sprite', line: 299 },
        ]);

        expect(message.content).to.be.a('string');
        expect(message.content as string).to.include('find_sprite_candidates');
        expect(message.content as string).to.include('do NOT replace it with a raw `.dds` path');
    });

    it('adds sound asset candidate guidance to validation retries', () => {
        const builder = new PromptBuilder(process.cwd());
        const message = builder.buildValidationRetryMessage('', [
            { message: 'show_sound references an unknown sound asset', line: 42 },
        ]);

        expect(message.content).to.be.a('string');
        expect(message.content as string).to.include('find_sound_candidates');
        expect(message.content as string).to.include('do NOT replace it with a raw `.wav`/`.ogg` path');
    });
});
