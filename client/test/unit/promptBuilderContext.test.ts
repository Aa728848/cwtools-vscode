import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

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
    const tempBase = path.resolve(__dirname, '../../..', '.tmp-test');

    function makeWorkspace(): string {
        fs.mkdirSync(tempBase, { recursive: true });
        return fs.mkdtempSync(path.join(tempBase, 'prompt-profile-'));
    }

    function cleanupWorkspace(workspaceRoot: string): void {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        try { fs.rmdirSync(tempBase); } catch { /* not empty */ }
    }

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

    it('injects the /init project profile card instead of full CWTOOLS.md when available', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const workspaceRoot = makeWorkspace();
        try {
            const profileDir = path.join(workspaceRoot, '.cwtools-ai', 'project');
            fs.mkdirSync(profileDir, { recursive: true });
            fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({
                schemaVersion: 1,
                generatedAt: '2026-05-24T00:00:00.000Z',
                workspaceRoot,
                workspaceKind: 'paradox_mod',
                projectName: 'Kuat',
                game: { id: 'stellaris', displayName: 'Stellaris', confidence: 'high', evidence: ['test'] },
                keyDirectories: [{ key: 'events', path: 'events', exists: true, fileCount: 1 }],
                localisation: { roots: ['localisation'], languages: ['l_english'], encoding: 'UTF-8 with BOM', sampleFiles: [] },
                identifiers: {
                    namespaces: ['kuat'],
                    variablePrefixes: [],
                    scriptedTriggers: [],
                    scriptedEffects: [],
                    events: [],
                    onActions: [],
                    staticModifiers: [],
                },
                routing: {
                    recommendedWorkflowByIntent: [{
                        intent: 'Fix CWTools diagnostics',
                        workflowId: 'diagnostic-fix',
                        mode: 'build',
                        reason: 'test',
                    }],
                    preferredReadTools: ['query_project_profile'],
                    avoidPatterns: [],
                },
                validation: { lspReady: 'unknown', indexStatus: 'unknown', vanillaCache: 'unknown' },
                promptCards: { build: 'Build card from profile' },
                efficiencyHints: ['Use profile first'],
            }), 'utf8');

            const builder = new PromptBuilder(workspaceRoot);
            const prompt = builder.buildSystemPromptForMode('build');

            expect(prompt).to.include('PROJECT PROFILE');
            expect(prompt).to.include('Build card from profile');
            expect(prompt).to.include('query_project_profile');
            expect(prompt).to.not.include('PROJECT RULES SUMMARY');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('injects only the current topic design blueprint into build prompts', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const workspaceRoot = makeWorkspace();
        try {
            const topicA = path.join(workspaceRoot, '.cwtools-ai', 'topic-a');
            const topicB = path.join(workspaceRoot, '.cwtools-ai', 'topic-b');
            fs.mkdirSync(topicA, { recursive: true });
            fs.mkdirSync(topicB, { recursive: true });
            fs.writeFileSync(path.join(topicA, 'design_blueprint.md'), '# Design Blueprint: Topic A\n\nA_ONLY_ENTITY\n', 'utf8');
            fs.writeFileSync(path.join(topicB, 'design_blueprint.md'), '# Design Blueprint: Topic B\n\nB_ONLY_ENTITY\n', 'utf8');

            const builder = new PromptBuilder(workspaceRoot);
            const prompt = builder.buildSystemPromptForMode('build', undefined, undefined, 'topic-a');

            expect(prompt).to.include('Current Topic Design Blueprint');
            expect(prompt).to.include('topic-a');
            expect(prompt).to.include('A_ONLY_ENTITY');
            expect(prompt).to.not.include('B_ONLY_ENTITY');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
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
        const context = builder.buildContextMessages({
            topicId: 'topic-123',
            commandToolsAvailable: false,
        });

        expect(prompt).to.include('NEVER use `run_command`');
        expect(prompt).to.include('For bulk file changes');
        expect(prompt).to.include('structured tools');
        expect(prompt).to.include('Do NOT create helper scripts');
        expect(prompt).to.include('SUB-AGENT COMMAND BOUNDARY');
        expect(prompt).to.not.include('COMMAND PERMISSION');
        expect(prompt).to.not.include('Agent Helper Script');
        expect(prompt).to.include('BLOCKED_FOR_ORCHESTRATOR');
        expect(String(context[0]!.content)).to.not.include('run_command cwd');
        expect(String(context[0]!.content)).to.not.include('Agent Helper Script');
    });
});
