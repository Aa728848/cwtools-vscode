import { expect } from 'chai';

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({ get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue }),
        workspaceFolders: [],
    },
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
    moduleLoader._load = function (this: unknown, request: string, ...args: unknown[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            PromptBuilder: (require('../../extension/ai/promptBuilder') as typeof import('../../extension/ai/promptBuilder')).PromptBuilder,
            TOOL_DEFINITIONS: (require('../../extension/ai/tools/definitions') as typeof import('../../extension/ai/tools/definitions')).TOOL_DEFINITIONS,
            runnerPolicy: require('../../extension/ai/runnerPolicy') as typeof import('../../extension/ai/runnerPolicy'),
            estimateTokenCount: (require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner')).estimateTokenCount,
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('AI static prompt budgets', () => {
    it('keeps every build and slim stage inside the plan budgets', () => {
        const { PromptBuilder, TOOL_DEFINITIONS, runnerPolicy, estimateTokenCount } = loadPromptBudgetModules();
        const builder = new PromptBuilder(process.cwd());
        const stage = runnerPolicy.initialToolStageForMode('build');

        const measure = (buildStage: import('../../extension/ai/runnerPolicy').AgentToolStage, slim: boolean): number => {
            const modeTools = runnerPolicy.filterToolDefinitionsForMode(TOOL_DEFINITIONS, 'build', {
                useSlimPrompt: slim,
            });
            const tools = runnerPolicy.filterToolDefinitionsForStage(modeTools, 'build', buildStage);
            const prompt = slim
                ? builder.buildSlimSystemPromptForMode('build', undefined, 'stellaris')
                : builder.buildSystemPromptForMode('build', undefined, 'stellaris');
            return estimateTokenCount(prompt) + estimateTokenCount(JSON.stringify(tools));
        };

        expect(stage).to.equal('discovery');

        for (const buildStage of ['discovery', 'design', 'validation', 'write', 'finalize'] as const) {
            const modeTools = runnerPolicy.filterToolDefinitionsForMode(TOOL_DEFINITIONS, 'build');
            const tools = runnerPolicy.filterToolDefinitionsForStage(modeTools, 'build', buildStage);
            expect(tools.length, `${buildStage} tool count`).to.be.within(8, 15);
            expect(measure(buildStage, false), `${buildStage} main system + tools`).to.be.at.most(8_000);
            expect(measure(buildStage, true), `${buildStage} slim system + tools`).to.be.at.most(4_000);
        }
    });

    it('keeps every staged read-only mode below the main-agent budget', () => {
        const { PromptBuilder, TOOL_DEFINITIONS, runnerPolicy, estimateTokenCount } = loadPromptBudgetModules();
        const builder = new PromptBuilder(process.cwd());
        const stages = {
            plan: ['discovery', 'design', 'validation', 'finalize'],
            explore: ['discovery', 'validation', 'finalize'],
            review: ['discovery', 'validation', 'finalize'],
        } as const;
        const projectWriteTools = new Set(['write_file', 'edit_file', 'replace_lines', 'edit_pdx_block', 'write_localisation']);

        for (const mode of Object.keys(stages) as Array<keyof typeof stages>) {
            const modeTools = runnerPolicy.filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode);
            const promptTokens = estimateTokenCount(builder.buildSystemPromptForMode(mode, undefined, 'stellaris'));
            for (const stage of stages[mode]) {
                const tools = runnerPolicy.filterToolDefinitionsForStage(modeTools, mode, stage);
                const total = promptTokens + estimateTokenCount(JSON.stringify(tools));
                expect(tools.length, `${mode}/${stage} tool count`).to.be.within(8, 15);
                expect(total, `${mode}/${stage} system + tools`).to.be.at.most(8_000);
                expect(tools.some(tool => projectWriteTools.has(tool.function.name)), `${mode}/${stage} project writes`).to.equal(false);
            }
        }
    });
});
