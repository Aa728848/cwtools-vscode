import { expect } from 'chai';

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (key === 'includeFullSmallFiles') return false as T;
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

describe('PromptBuilder 快照与稳定性测试', () => {
    it('验证 build 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('build');

        // 验证系统提示词中包含核心规则，防止重构时遗漏
        expect(prompt).to.include('Eddy CWTool Code');
        expect(prompt).to.include('Anti-Rush & Clarification');
        expect(prompt).to.include('Strict Rule Compliance in Code Generation');
        expect(prompt).to.include('Least Privilege Check');
        expect(prompt).to.include('ZERO-ERROR DELIVERY GATE');
        expect(prompt).to.include('write_localisation');
        expect(prompt).to.include('evidence hierarchy');
        expect(prompt).to.include('PDX final verification override');
        expect(prompt).to.include('Functional Completeness');
        expect(prompt).to.include('Generic Paradox');
        expect(prompt).to.not.include('Stellaris common/ Design Space Review');
    });

    it('验证 plan 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan');

        expect(prompt).to.include('Plan Mode');
        expect(prompt).to.include('Clarification BEFORE Planning Phase');
        expect(prompt).to.include('write_design_blueprint');
        expect(prompt).to.include('Dynamic Coupling Assessment');
        expect(prompt).to.include('Common Directory Capability Review');
        expect(prompt).to.include('Reward Implementation Grounding');
        expect(prompt).to.include('current-game common subsystems');
        expect(prompt).to.include('bounded vanilla archetype evidence');
    });

    it('injects Stellaris dynamic evidence guidance only when Stellaris is explicit', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan', undefined, 'stellaris');

        expect(prompt).to.include('Stellaris PDXScript modding');
        expect(prompt).to.include('Do not rely on static prompt knowledge for scopes');
        expect(prompt).to.include('Static prompt text must not encode current-version CWT facts');
        expect(prompt).to.include('subsystem directory capability');
        expect(prompt).to.include('Do not copy scope, on_action, or subsystem facts from this prompt');
        expect(prompt).to.include('query_cwt_schema');
        expect(prompt).to.include('query_workspace_index');
        expect(prompt).to.include('Common Directory Capability Review');
        expect(prompt).to.not.include('Stellaris common/ Design Space Review');
        expect(prompt).to.not.include('common/pop_faction_types');
        expect(prompt).to.not.include('common/storm_types');
    });

    it('requires visible process updates for main, orchestrator, and slim prompts', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const buildPrompt = builder.buildSystemPromptForMode('build');
        const orchestratorPrompt = builder.buildSystemPromptForMode('orchestrator');
        const slimPrompt = builder.buildSlimSystemPromptForMode('build');

        for (const prompt of [buildPrompt, orchestratorPrompt, slimPrompt]) {
            expect(prompt).to.include('Visible Process Updates');
            expect(prompt).to.include('Codex-style visible process narrative');
            expect(prompt).to.include('what you will do next, how you will do it, and why');
            expect(prompt).to.include('Avoid generic filler');
            expect(prompt).to.include('Do NOT expose chain-of-thought');
            expect(prompt).to.include('tool parameters');
            expect(prompt).to.include('stdout/stderr dumps');
        }
    });

    it('验证 explore 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('explore');

        expect(prompt).to.include('Explore Mode');
        expect(prompt).to.include('Explore Mode Guidelines');
        expect(prompt).to.not.include('write_file');
    });

    it('验证 review 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('review');

        expect(prompt).to.include('Review Mode');
        expect(prompt).to.include('Diagnostics Retrieval');
        expect(prompt).to.include('Large Project Review Strategy');
    });

    it('验证 gui_expert 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('gui_expert');

        expect(prompt).to.include('GUI Expert Mode');
        expect(prompt).to.include('NEVER Delete Vanilla Elements');
        expect(prompt).to.include('Template Reference Methodology');
    });

    it('tells orchestrators to declare known builder write targets', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('orchestrator');

        expect(prompt).to.include('plannedFiles');
        expect(prompt).to.include('Builder task');
        expect(prompt).to.include('dispatch the Explorer batch first');
        expect(prompt).to.include('featureManifest');
        expect(prompt).to.include('taskPlan');
        expect(prompt).to.include('dispatch_agents({ blueprintFile })');
    });

    it('requires plan mode to design executable entity relationships before approval', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan');

        expect(prompt).to.include('machine-checkable `featureManifest`');
        expect(prompt).to.include('executable `taskPlan`');
        expect(prompt).to.include('produces/consumes');
        expect(prompt).to.include('STOP and wait for user approval');
    });

    it('describes script mode as a dynamic PDXScript workflow coordinator', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('script');

        expect(prompt).to.include('Script Mode');
        expect(prompt).to.include('dynamic workflow coordinator');
        expect(prompt).to.include('dispatch_agents');
        expect(prompt).to.include('up to 8');
        expect(prompt).to.include('plannedFiles');
        expect(prompt).to.include('approved `blueprintFile`');
        expect(prompt).to.include('write_design_blueprint');
    });

    it('keeps slim localisation writers on write_localisation and concise completion', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSlimSystemPromptForMode('loc_writer');

        expect(prompt).to.include('write_localisation` is the only mutation path');
        expect(prompt).to.include('Do not use `apply_patch`');
        expect(prompt).to.include('non-localisation deliverable');
        expect(prompt).to.include('return a concise summary immediately');
    });
});
