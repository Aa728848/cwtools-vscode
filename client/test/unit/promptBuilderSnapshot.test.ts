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
    });

    it('验证 plan 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan');

        expect(prompt).to.include('Plan Mode');
        expect(prompt).to.include('Clarification BEFORE Planning Phase');
        expect(prompt).to.include('write_design_blueprint');
        expect(prompt).to.include('Deep Coupling Assessment');
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
