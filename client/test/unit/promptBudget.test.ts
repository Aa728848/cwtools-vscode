import { expect } from 'chai';

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({ get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue }),
        workspaceFolders: [],
    },
    commands: {
        executeCommand: async () => undefined,
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
    moduleLoader._load = function (this: unknown, ...args: unknown[]) {
        if (args[0] === 'vscode') return vscodeStub;
        return originalLoad.apply(this, args);
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

        expect(stage).to.equal('write');

        for (const buildStage of ['discovery', 'validation', 'write', 'finalize'] as const) {
            const modeTools = runnerPolicy.filterToolDefinitionsForMode(TOOL_DEFINITIONS, 'build');
            const tools = runnerPolicy.filterToolDefinitionsForStage(modeTools, 'build', buildStage);
            // Structured questions, programmable run_code, and the bounded typed
            // candidate/transaction pair occupy runtime-control slots in write stages.
            expect(tools.length, `${buildStage} tool count`).to.be.within(8, 22);
            // 9_200: includes the always-visible structured question and
            // programmable run_code schemas plus dispatch/durable-graph lookups.
            expect(measure(buildStage, false), `${buildStage} main system + tools`).to.be.at.most(9_200);
            expect(measure(buildStage, true), `${buildStage} slim system + tools`).to.be.at.most(4_900);
        }
    });

    it('keeps every staged read-only mode below the main-agent budget', () => {
        const { PromptBuilder, TOOL_DEFINITIONS, runnerPolicy, estimateTokenCount } = loadPromptBudgetModules();
        const builder = new PromptBuilder(process.cwd());
        const stages = {
            plan: ['discovery', 'validation', 'finalize'],
            explore: ['discovery', 'validation', 'finalize'],
            review: ['discovery', 'validation', 'finalize'],
        } as const;
        const projectWriteTools = new Set(['write_file', 'edit_file', 'replace_lines', 'write_localisation']);

        for (const mode of Object.keys(stages) as Array<keyof typeof stages>) {
            const modeTools = runnerPolicy.filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode);
            const promptTokens = estimateTokenCount(builder.buildSystemPromptForMode(mode, undefined, 'stellaris'));
            for (const stage of stages[mode]) {
                const tools = runnerPolicy.filterToolDefinitionsForStage(modeTools, mode, stage);
                const total = promptTokens + estimateTokenCount(JSON.stringify(tools));
                // Plan and Explore reserve three bounded fan-out slots; all modes
                // also expose one structured question slot to the main agent.
                const maxToolCount = mode === 'plan' || mode === 'explore' ? 19 : 16;
                expect(tools.length, `${mode}/${stage} tool count`).to.be.within(8, maxToolCount);
                // Keep a small margin for the coordinator schemas used by Plan and Explore.
                expect(total, `${mode}/${stage} system + tools`).to.be.at.most(9_500);
                expect(tools.some(tool => projectWriteTools.has(tool.function.name)), `${mode}/${stage} project writes`).to.equal(false);
            }
        }
    });
});
