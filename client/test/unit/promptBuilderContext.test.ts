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

describe('PromptBuilder context budgeting', () => {
    it('does not inject full small files by default', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const fileContent = Array.from({ length: 40 }, (_, i) => `line_${i + 1} = yes`).join('\n');
        const messages = builder.buildContextMessages({
            activeFile: `${process.cwd()}\\events\\small.txt`,
            cursorLine: 30,
            fileContent,
        });

        const content = String(messages[0]!.content);
        expect(content).to.include('File header excerpt');
        expect(content).to.not.include('Full file content');
    });

    it('tells utility mode to run existing scripts directly instead of creating wrappers', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('utility');

        expect(prompt).to.include('edit that script directly');
        expect(prompt).to.include('execute it with `run_command` from the project root');
        expect(prompt).to.include('Prefer `python "relative/path/to/script.py"` over wrapper files');
    });

    it('tells agents to reuse one temporary helper script per task', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('utility');
        const context = builder.buildContextMessages({ topicId: 'topic-123' });

        expect(prompt).to.include('reuse and overwrite one script for the whole task');
        expect(prompt).to.include('CWT_AGENT_HELPER_SCRIPT');
        expect(prompt).to.include('agent_helper.py');
        expect(prompt).to.include('Delete the helper only when it is a temporary execution/verification helper');
        expect(prompt).to.include('preserve user-requested deliverable scripts');
        expect(String(context[0]!.content)).to.include('Agent Helper Script');
        expect(String(context[0]!.content)).to.include('.cwtools-ai/topic-123/scratch/agent_helper.py');
        expect(String(context[0]!.content)).to.include('never user-requested deliverables');
    });

    it('tells agents to use PowerShell-style run_command paths on Windows', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('utility');

        expect(prompt).to.include('run_command` uses PowerShell in every mode');
        expect(prompt).to.include('$env:CWT_AGENT_SCRATCH_DIR');
        expect(prompt).to.include('$env:CWT_AGENT_HELPER_SCRIPT');
        expect(prompt).to.not.include('%CWT_AGENT_SCRATCH_DIR%');
        expect(prompt).to.not.include('cmd.exe');
        expect(prompt).to.not.include('%VAR%');
    });

    it('tells slim sub-agents to use structured edits instead of commands', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSlimSystemPromptForMode('build');

        expect(prompt).to.include('NEVER use `run_command`');
        expect(prompt).to.include('For bulk file changes');
        expect(prompt).to.include('structured tools');
        expect(prompt).to.include('BLOCKED_FOR_ORCHESTRATOR');
    });
});
