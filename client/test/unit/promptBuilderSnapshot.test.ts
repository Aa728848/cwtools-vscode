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

function withoutRepositoryInstructions(prompt: string): string {
    return prompt.replace(/<project-instructions>[\s\S]*?<\/project-instructions>/g, '');
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
        expect(prompt).to.include('ordinary software engineering or Paradox/CWTools work');
        expect(prompt).to.include('ordinary code');
        expect(prompt).to.include('final design authority');
        expect(prompt).to.include('Approval transitions directly to Write/Execute');
        expect(prompt).to.include('Adaptive planning fan-out');
        expect(prompt).to.include('Dispatch only `explore`, `plan`, and `review` roles');
        expect(prompt).to.include('main Agent alone author the final Implementation Plan');
    });

    it('keeps changing Stellaris facts out of domain-neutral plan prompts', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan', undefined, 'stellaris');

        expect(prompt).to.include('current workspace');
        expect(prompt).to.include('query active CWT/LSP');
        expect(prompt).to.include('Common Directory Capability Review');
        expect(prompt).to.not.include('intentionally contains no game-version rule tables');
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

    it('keeps general orchestrators on utility writers and explicit write targets', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('orchestrator');

        expect(prompt).to.include('plannedFiles');
        expect(prompt).to.include('utility');
        expect(prompt).to.include('discovery wave');
        expect(prompt).to.include('Approved Implementation Plan is design-complete');
        expect(prompt).to.not.include('mandatory user-facing approval');
        expect(prompt).to.not.include('LocWriter');
    });

    it('keeps every General Coding intent free of Paradox prompts and repair protocols', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const generalDomainPrompt = (mode: 'plan' | 'explore' | 'review') =>
            builder.buildSystemPromptForMode(
                mode,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                true,
                true,
                'general',
            );
        const prompts = [
            builder.buildSystemPromptForMode('utility'),
            generalDomainPrompt('plan'),
            generalDomainPrompt('explore'),
            generalDomainPrompt('review'),
            builder.buildSystemPromptForMode('orchestrator'),
            builder.buildSlimSystemPromptForMode('utility', undefined, undefined, undefined, 'general'),
        ];
        const forbidden = [
            'Paradox', 'PDXScript', 'CWTools', 'CWT/LSP', 'query_scope',
            'write_design_blueprint', 'EvidenceGate', 'sprite repair',
            'localisation sweep', 'vanilla cache',
        ];

        for (const prompt of prompts) {
            const platformPrompt = withoutRepositoryInstructions(prompt);
            for (const term of forbidden) expect(platformPrompt, term).to.not.include(term);
            expect(prompt).to.include('repository');
        }

        const paradoxPlan = builder.buildSystemPromptForMode('plan');
        expect(paradoxPlan).to.include('query active CWT/LSP');
        expect(paradoxPlan).to.include('write_design_blueprint');
    });

    it('requires plan mode to design executable entity relationships before approval', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan');

        expect(prompt).to.include('Blueprint Self-check');
        expect(prompt).to.include('get_design_blueprint_contract');
        expect(prompt).to.include('machine-checkable `featureManifest`');
        expect(prompt).to.include('executable `taskPlan`');
        expect(prompt).to.include('produces/consumes');
        expect(prompt).to.include('at least one evidence-backed selection and rejection');
        expect(prompt).to.include('Audit the manifest as one identity graph');
        expect(prompt).to.include('dependencies must encode that producer-to-consumer order');
        expect(prompt).to.include('before the first `write_design_blueprint` call');
        expect(prompt).to.include('STOP and wait for user approval');
        expect(prompt).to.include('Do not defer any design work until after approval');
    });

    it('describes script mode as a dynamic PDXScript workflow coordinator', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('script');

        expect(prompt).to.include('Paradox Multi-Agent Mode');
        expect(prompt).to.include('dynamic workflow coordinator');
        expect(prompt).to.include('dispatch_agents');
        expect(prompt).to.include('up to 8');
        expect(prompt).to.include('plannedFiles');
        expect(prompt).to.include('approved `blueprintFile`');
        expect(prompt).to.include('write_design_blueprint');
        expect(prompt).to.include('Approved Implementation Plan');
        expect(prompt).to.include('dispatch immediately');
        expect(prompt).to.include('Do not call `write_design_blueprint`');
        expect(prompt).to.include('Blueprint Self-check');
        expect(prompt).to.include('Structured dispatch preflight for Paradox write waves');
        expect(prompt).to.include('exact current-topic `design_blueprint.json`');
        expect(prompt).to.include('schemaVersion 2 manifest and task DAG remain canonical');
        expect(prompt).to.include('cross-check task IDs, files, entity contracts, dependencies, and acceptance checks');
    });

    it('keeps slim localisation writers on write_localisation and concise completion', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSlimSystemPromptForMode('loc_writer');

        expect(prompt).to.include('write_localisation` is the only mutation path');
        expect(prompt).to.include('Do not use `edit_file`');
        expect(prompt).to.include('non-localisation deliverable');
        expect(prompt).to.include('return a concise summary immediately');
    });
});
