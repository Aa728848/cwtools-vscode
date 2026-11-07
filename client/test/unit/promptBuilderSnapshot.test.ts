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
        const prompt = builder.buildSystemPromptForMode('build', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');

        // 验证系统提示词中包含核心规则，防止重构时遗漏
        expect(prompt).to.include('Eddy CWTool Code');
        expect(prompt).to.include('bounded reads and semantic queries');
        expect(prompt).to.not.include('Clarification and execution');
        expect(prompt).to.not.include('Explicit Plan Handoff');
        expect(prompt).to.include('Strict Rule Compliance in Code Generation');
        expect(prompt).to.include('host EvidenceGate');
        expect(prompt).to.include('write_localisation');
        expect(prompt).to.include('evidence hierarchy');
        expect(prompt).to.include('fresh diagnostics');
        expect(prompt).to.include('collect the named bounded evidence and retry');
        expect(prompt).to.include('Generic Paradox');
        expect(prompt).to.not.include('Stellaris common/ Design Space Review');
    });

    it('验证 plan 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');

        expect(prompt).to.include('Plan Mode');
        expect(prompt).to.include('Clarification BEFORE Planning Phase');
        expect(prompt).to.include('write_design_blueprint');
        expect(prompt).to.include('Dynamic Coupling Assessment');
        expect(prompt).to.include('fields as suggestions');
        expect(prompt).to.include('Include only sections');
        expect(prompt).to.include('Call `write_design_blueprint` once');
        expect(prompt).to.include('final design authority');
        expect(prompt).to.include('Approval transitions directly to Write/Execute');
    });

    it('keeps changing Stellaris facts out of plan prompts', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan', undefined, 'stellaris', undefined, undefined, undefined, true, true, 'paradox');

        expect(prompt).to.include('PDXScript mod development');
        expect(prompt).to.include('Query active CWT/LSP');
        expect(prompt).to.include('fields as suggestions');
        expect(prompt).to.not.include('intentionally contains no game-version rule tables');
        expect(prompt).to.not.include('Stellaris common/ Design Space Review');
        expect(prompt).to.not.include('common/pop_faction_types');
        expect(prompt).to.not.include('common/storm_types');
    });

    it('requires visible process updates for main and slim prompts', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const buildPrompt = builder.buildSystemPromptForMode('build', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');
        const slimPrompt = builder.buildSlimSystemPromptForMode('build', undefined, undefined, undefined, 'paradox');

        for (const prompt of [buildPrompt, slimPrompt]) {
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
        const prompt = builder.buildSystemPromptForMode('explore', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');

        expect(prompt).to.include('Explore Mode');
        expect(prompt).to.include('Explore Mode Guidelines');
        expect(prompt).to.include('You MUST NOT write or modify any files');
        // The save-skill rule mentions write_file only to forbid using it for SKILL.md
        // or experience files. A bare substring ban would confuse that safeguard with
        // an actual write permission, so pin the read-only meaning instead.
        const writeFileMentions = prompt.split(/\r?\n/).filter(line => line.includes('write_file'));
        expect(writeFileMentions).to.have.length(1);
        expect(writeFileMentions[0]).to.include('instead of writing `SKILL.md` or experience files with `write_file`/`edit_file`');
    });

    it('验证 review 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('review', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');

        expect(prompt).to.include('Review Mode');
        expect(prompt).to.include('Diagnostics Retrieval');
        expect(prompt).to.include('Large Project Review Strategy');
    });

    it('验证 gui_expert 模式的系统提示词关键特征', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('gui_expert', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');

        expect(prompt).to.include('GUI Expert Mode');
        expect(prompt).to.include('NEVER Delete Vanilla Elements');
        expect(prompt).to.include('Template Reference Methodology');
    });

    it('treats blueprint structure as model guidance instead of a host completeness gate', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('plan', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');

        expect(prompt).to.include('Blueprint Self-check');
        expect(prompt).to.include('fields as suggestions');
        expect(prompt).to.include('host saves and presents it without judging cross-section semantic completeness');
        expect(prompt).to.include('Omit `unresolvedCritical` or use `[]` to request approval');
        expect(prompt).to.include('Runtime path and schedulability checks still apply');
        expect(prompt).to.include('STOP and wait for user approval');
        expect(prompt).to.include('Do not defer any design work until after approval');
    });

    it('keeps slim localisation writers on write_localisation', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSlimSystemPromptForMode('loc_writer', undefined, undefined, undefined, 'paradox');

        expect(prompt).to.include('write_localisation');
        expect(prompt).to.include('MANDATORY for .yml files');
    });
});
