import { expect } from 'chai';

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({ get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue }),
        workspaceFolders: [],
    },
    commands: { executeCommand: async () => undefined },
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {}, dispose() {} }),
        showErrorMessage: () => Promise.resolve(undefined),
    },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
};

function loadPromptBudgetModules() {
    const moduleLoader = require('module') as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, ...args: unknown[]) {
        if (args[0] === 'vscode') return vscodeStub;
        return originalLoad.apply(this, args);
    };
    try {
        return {
            PromptBuilder: (require('../../extension/ai/promptBuilder') as typeof import('../../extension/ai/promptBuilder')).PromptBuilder,
            TOOL_DEFINITIONS: (require('../../extension/ai/tools/definitions') as typeof import('../../extension/ai/tools/definitions')).TOOL_DEFINITIONS,
            runnerPolicy: require('../../extension/ai/runnerPolicy') as typeof import('../../extension/ai/runnerPolicy'),
            toolDisclosureService: (require('../../extension/ai/runner/toolDisclosure') as typeof import('../../extension/ai/runner/toolDisclosure')).toolDisclosureService,
            estimateTokenCount: (require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner')).estimateTokenCount,
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('AI static prompt budgets', () => {
    const coreTools = new Set([
        'ask_user_question', 'grep', 'manage_goal', 'read_file', 'select_tools', 'todo_write',
    ]);

    it('keeps the disclosed build and slim surfaces inside prompt budgets', () => {
        const { PromptBuilder, TOOL_DEFINITIONS, runnerPolicy, toolDisclosureService, estimateTokenCount } = loadPromptBudgetModules();
        const builder = new PromptBuilder(process.cwd());

        for (const slim of [false, true]) {
            const eligible = runnerPolicy.filterToolDefinitionsForMode(TOOL_DEFINITIONS, 'build', {
                useSlimPrompt: slim,
            });
            const tools = toolDisclosureService.initialTools(eligible, {
                mode: 'build', domain: 'paradox', dynamicSupported: true, loaded: new Set(),
            });
            const prompt = slim
                ? builder.buildSlimSystemPromptForMode('build', undefined, 'stellaris')
                : builder.buildSystemPromptForMode('build', undefined, 'stellaris');
            const total = estimateTokenCount(prompt) + estimateTokenCount(JSON.stringify(tools));
            const names = tools.map(tool => tool.function.name);
            expect(names, `${slim ? 'slim' : 'main'} tool count`).to.have.length.within(4, coreTools.size);
            expect(names.every(name => coreTools.has(name)), `${slim ? 'slim' : 'main'} core-only disclosure`).to.equal(true);
            expect(names, `${slim ? 'slim' : 'main'} required core tools`).to.include.members([
                'grep', 'manage_goal', 'read_file', 'select_tools',
            ]);
            expect(total, `${slim ? 'slim' : 'main'} system + tools`).to.be.at.most(slim ? 4_900 : 9_200);
        }
    });

    it('keeps disclosed read-only modes below budget and free of project writes', () => {
        const { PromptBuilder, TOOL_DEFINITIONS, runnerPolicy, toolDisclosureService, estimateTokenCount } = loadPromptBudgetModules();
        const builder = new PromptBuilder(process.cwd());
        const projectWriteTools = new Set(['write_file', 'edit_file', 'replace_lines', 'write_localisation']);

        for (const mode of ['plan', 'explore', 'review'] as const) {
            const eligible = runnerPolicy.filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode);
            const tools = toolDisclosureService.initialTools(eligible, {
                mode, domain: 'paradox', dynamicSupported: true, loaded: new Set(),
            });
            const total = estimateTokenCount(builder.buildSystemPromptForMode(mode, undefined, 'stellaris'))
                + estimateTokenCount(JSON.stringify(tools));
            const names = tools.map(tool => tool.function.name);
            expect(names, `${mode} tool count`).to.have.length.within(4, coreTools.size);
            expect(names.every(name => coreTools.has(name)), `${mode} core-only disclosure`).to.equal(true);
            expect(names, `${mode} required core tools`).to.include.members([
                'grep', 'manage_goal', 'read_file', 'select_tools',
            ]);
            expect(total, `${mode} system + tools`).to.be.at.most(9_500);
            expect(tools.some(tool => projectWriteTools.has(tool.function.name)), `${mode} project writes`).to.equal(false);
        }
    });
});
