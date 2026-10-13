import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-prompt-experience');

const configValues: Record<string, unknown> = {};

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (key in configValues) return configValues[key] as T;
                return defaultValue;
            },
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

function loadModules() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
        delete require.cache[require.resolve('../../extension/ai/memoryParser')];
        delete require.cache[require.resolve('../../extension/ai/experienceStore')];
        delete require.cache[require.resolve('../../extension/ai/promptBuilder')];
        return {
            promptBuilder: require('../../extension/ai/promptBuilder') as typeof import('../../extension/ai/promptBuilder'),
            experienceStore: require('../../extension/ai/experienceStore') as typeof import('../../extension/ai/experienceStore'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('PromptBuilder <task-experience> recall', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-pexp-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
        for (const key of Object.keys(configValues)) delete configValues[key];
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty */ }
    });

    function seedExperience(modules: ReturnType<typeof loadModules>): void {
        modules.experienceStore.appendExperiences(workspaceRoot, [{
            title: '事件本地化顺序经验',
            lesson: '先创建 owning entity 再 write_localisation 写 yml，否则写入被拒。',
            pitfalls: ['localization before entity'],
            domain: 'paradox',
            confidence: 'high',
        }]);
    }

    it('injects a bounded <task-experience> block into the dynamic prompt block', () => {
        const modules = loadModules();
        seedExperience(modules);
        const builder = new modules.promptBuilder.PromptBuilder(workspaceRoot);

        const dynamic = builder.buildDynamicPromptBlock(undefined, 'topic-exp', undefined, {
            mode: 'build',
            domain: 'paradox',
            taskText: '给新事件写本地化 yml',
        });

        expect(dynamic).to.have.lengthOf(1);
        const content = String(dynamic[0]!.content);
        expect(content).to.include('<task-experience>');
        expect(content).to.include('事件本地化顺序经验');
        expect(content).to.include('先创建 owning entity 再 write_localisation');
        expect(content).to.include('</task-experience>');
        // The block must not introduce Markdown H2 lines: existing memory
        // prompt assertions count ^## occurrences in this dynamic block.
        expect(content.match(/^## /gm)).to.equal(null);
    });

    it('recalls nothing when the store is empty', () => {
        const modules = loadModules();
        const builder = new modules.promptBuilder.PromptBuilder(workspaceRoot);
        const dynamic = builder.buildDynamicPromptBlock(undefined, 'topic-exp', undefined, {
            mode: 'build',
            domain: 'paradox',
            taskText: '给新事件写本地化 yml',
        });
        const content = dynamic.map(message => String(message.content)).join('\n');
        expect(content).to.not.include('<task-experience>');
    });

    it('recalls nothing for an unrelated task (similarity-gated recall)', () => {
        const modules = loadModules();
        seedExperience(modules);
        const builder = new modules.promptBuilder.PromptBuilder(workspaceRoot);
        const dynamic = builder.buildDynamicPromptBlock(undefined, 'topic-exp', undefined, {
            mode: 'build',
            domain: 'paradox',
            taskText: 'quantum zebra radiator analysis',
        });
        const content = dynamic.map(message => String(message.content)).join('\n');
        expect(content).to.not.include('<task-experience>');
    });

    it('is gated by stellarisLanguageServices.ai.experience.enabled', () => {
        configValues['experience.enabled'] = false;
        const modules = loadModules();
        seedExperience(modules);
        const builder = new modules.promptBuilder.PromptBuilder(workspaceRoot);
        const dynamic = builder.buildDynamicPromptBlock(undefined, 'topic-exp', undefined, {
            mode: 'build',
            domain: 'paradox',
            taskText: '给新事件写本地化 yml',
        });
        const content = dynamic.map(message => String(message.content)).join('\n');
        expect(content).to.not.include('<task-experience>');
    });
});
