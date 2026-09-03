import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
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

function withoutRepositoryInstructions(prompt: string): string {
    return prompt.replace(/<project-instructions>[\s\S]*?<\/project-instructions>/g, '');
}

describe('PromptBuilder context budgeting', () => {
    const tempBase = path.join(os.tmpdir(), 'cwtools-prompt-context');

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
            domain: 'paradox',
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
        const prompt = builder.buildSystemPromptForMode('utility', undefined, undefined, undefined, undefined, undefined, true, true, 'general');

        expect(prompt).to.include('edit that script directly');
        expect(prompt).to.include('execute it from the project root');
        expect(prompt).to.include('Prefer `python "relative/path/to/script.py"` over wrapper files');
        expect(withoutRepositoryInstructions(prompt)).to.not.match(/\b(?:Paradox|PDXScript|CWTools|CWT)\b/i);
    });

    it('injects generated profile facts and user-owned CWTOOLS.md instructions independently', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const workspaceRoot = makeWorkspace();
        try {
            const profileDir = path.join(workspaceRoot, '.cwtools', 'project');
            fs.mkdirSync(profileDir, { recursive: true });
            fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({
                schemaVersion: 4,
                generatedAt: '2026-05-24T00:00:00.000Z',
                workspaceRoot,
                workspaceKind: 'paradox_mod',
                projectName: 'SampleMod',
                game: { id: 'stellaris', displayName: 'Stellaris', confidence: 'high', evidence: ['test'] },
                keyDirectories: [{ key: 'events', path: 'events', exists: true, fileCount: 1 }],
                localisation: { roots: ['localisation'], languages: ['l_english'], encoding: 'UTF-8 with BOM', sampleFiles: [] },
                identifiers: {
                    namespaces: ['samplemod'],
                    variablePrefixes: [],
                    byType: {},
                },
                routing: {
                    recommendedWorkflowByIntent: [{
                        intent: 'Fix CWTools diagnostics',
                        workflowId: 'diagnostic-fix',
                        reason: 'test',
                    }],
                    preferredReadTools: ['query_project_profile'],
                    avoidPatterns: [],
                },
                validation: { lspReady: 'unknown', indexStatus: 'unknown', vanillaCache: 'unknown' },
                guidanceCards: { implementation: 'Build guidance from profile' },
                efficiencyHints: ['Use profile first'],
            }), 'utf8');
            fs.writeFileSync(path.join(workspaceRoot, 'CWTOOLS.md'), [
                '# Project Instructions',
                '',
                '## Architecture Decisions',
                '- PRESERVE_USER_ARCHITECTURE_RULE',
            ].join('\n'), 'utf8');

            const builder = new PromptBuilder(workspaceRoot);
            const prompt = builder.buildSystemPromptForMode('build', undefined, undefined, undefined, undefined, undefined, true, true, 'paradox');

            expect(prompt).to.include('PROJECT PROFILE');
            expect(prompt).to.include('Build guidance from profile');
            expect(prompt).to.include('query_project_profile');
            expect(prompt).to.include('PROJECT INSTRUCTIONS');
            expect(prompt).to.include('PRESERVE_USER_ARCHITECTURE_RULE');
            expect(prompt).to.not.include('PROJECT RULES SUMMARY');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('injects only the current topic unified implementation plan into build prompts', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const workspaceRoot = makeWorkspace();
        try {
            const topicA = path.join(workspaceRoot, '.cwtools', 'topic-a');
            const topicB = path.join(workspaceRoot, '.cwtools', 'topic-b');
            fs.mkdirSync(topicA, { recursive: true });
            fs.mkdirSync(topicB, { recursive: true });
            fs.writeFileSync(path.join(topicA, 'Implementation_Plan.md'), '# Implementation Plan: Topic A\n\nA_ONLY_ENTITY\n', 'utf8');
            fs.writeFileSync(path.join(topicB, 'Implementation_Plan.md'), '# Implementation Plan: Topic B\n\nB_ONLY_ENTITY\n', 'utf8');

            const builder = new PromptBuilder(workspaceRoot);
            const prompt = builder.buildSystemPromptForMode('build', undefined, undefined, 'topic-a', undefined, undefined, true, true, 'paradox');

            expect(prompt).to.include('Current Topic Implementation Plan');
            expect(prompt).to.include('topic-a');
            expect(prompt).to.include('A_ONLY_ENTITY');
            expect(prompt).to.not.include('B_ONLY_ENTITY');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('injects only the current topic memory and keeps frozen prompts memory-free', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const workspaceRoot = makeWorkspace();
        try {
            const topicA = path.join(workspaceRoot, '.cwtools', 'topic-memory-a');
            const topicB = path.join(workspaceRoot, '.cwtools', 'topic-memory-b');
            fs.mkdirSync(topicA, { recursive: true });
            fs.mkdirSync(topicB, { recursive: true });
            const memory = (content: string) => JSON.stringify({
                version: 5,
                entries: [{
                    key: content,
                    content,
                    domain: 'paradox',
                    priority: 'normal',
                    source: 'user:test',
                    kind: 'user_fact',
                }],
            });
            fs.writeFileSync(path.join(topicA, 'memory.json'), memory('TOPIC_A_MEMORY'), 'utf8');
            fs.writeFileSync(path.join(topicB, 'memory.json'), memory('TOPIC_B_MEMORY'), 'utf8');

            const builder = new PromptBuilder(workspaceRoot);
            const prompt = builder.buildSystemPromptForMode('build', undefined, undefined, 'topic-memory-a', undefined, undefined, true, true, 'paradox');
            const dynamic = builder.buildDynamicPromptBlock(undefined, 'topic-memory-a', undefined, { domain: 'paradox' });
            const frozen = builder.buildFrozenSystemPrompt('build', undefined, undefined, { domain: 'paradox' });

            expect(prompt).to.include('TOPIC_A_MEMORY');
            expect(prompt).to.not.include('TOPIC_B_MEMORY');
            expect(String(dynamic[0]!.content)).to.include('TOPIC_A_MEMORY');
            expect(frozen).to.not.include('TOPIC_A_MEMORY');
            expect(frozen).to.not.include('TOPIC_B_MEMORY');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('ranks dynamic memory by the current task and active path scope', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const workspaceRoot = makeWorkspace();
        try {
            const topicId = 'topic-memory-relevance';
            const topicDir = path.join(workspaceRoot, '.cwtools', topicId);
            fs.mkdirSync(topicDir, { recursive: true });
            const now = Date.now();
            const fillerEntries = Array.from({ length: 10 }, (_, index) => ({
                key: `filler ${index}`,
                content: `Generic banana convention ${index}.`,
                priority: 'normal',
                confidence: 0.8,
                domain: 'paradox',
                source: 'user:test',
                kind: 'user_fact',
                createdAt: now,
                updatedAt: now,
            }));
            fs.writeFileSync(path.join(topicDir, 'memory.json'), JSON.stringify({
                version: 5,
                entries: [
                    ...fillerEntries,
                    {
                        key: 'event namespace path rule',
                        content: 'For events/alpha.txt, use the alpha namespace for country events.',
                        priority: 'normal',
                        confidence: 0.8,
                        domain: 'paradox',
                        source: 'user:test',
                        kind: 'user_fact',
                        createdAt: now,
                        updatedAt: now,
                    },
                ],
            }), 'utf8');

            const builder = new PromptBuilder(workspaceRoot);
            const dynamic = builder.buildDynamicPromptBlock(undefined, topicId, undefined, {
                mode: 'build',
                domain: 'paradox',
                taskText: 'Add a country event to the alpha namespace',
                pathScope: ['events/alpha.txt'],
            });
            const content = String(dynamic[0]!.content);

            expect(content).to.include('event namespace path rule');
            expect(content).to.include('events/alpha.txt');
            expect(content.match(/^## /gm)).to.have.lengthOf(10);
            expect(content).to.not.include('filler 9');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('provides the exact canonical Implementation Plan path before a write', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const context = builder.buildContextMessages({ topicId: 'topic-123', domain: 'paradox' });
        const content = String(context[0]!.content);

        expect(content).to.include('**Implementation Plan File**');
        expect(content).to.include('.cwtools/topic-123/Implementation_Plan.md');
        expect(content).to.include('copy this exact literal path');
    });

    it('tells agents to reuse one temporary helper script per task', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('utility', undefined, undefined, undefined, undefined, undefined, true, true, 'general');
        const context = builder.buildContextMessages({ topicId: 'topic-123', domain: 'general' });

        expect(prompt).to.include('reuse one helper for the whole task');
        expect(prompt).to.include('provided topic scratch directory');
        expect(prompt).to.include('Delete it only when it was created solely for execution or verification');
        expect(prompt).to.include('preserve existing scripts and user-requested deliverables');
        expect(prompt).to.not.include('CWT_AGENT_HELPER_SCRIPT');
        expect(String(context[0]!.content)).to.include('Agent Helper Script');
        expect(String(context[0]!.content)).to.include('.cwtools/topic-123/scratch/agent_helper.py');
        expect(String(context[0]!.content)).to.include('never user-requested deliverables');
    });

    it('tells agents to use platform-appropriate run_command env-var syntax', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSystemPromptForMode('utility', undefined, undefined, undefined, undefined, undefined, true, true, 'general');

        if (process.platform === 'win32') {
            expect(prompt).to.include('PowerShell in every mode');
        } else {
            expect(prompt).to.include('/bin/sh');
        }
        expect(withoutRepositoryInstructions(prompt)).to.not.match(/\b(?:Paradox|PDXScript|CWTools|CWT)\b/i);
        expect(prompt).to.not.include('cmd.exe');
        expect(prompt).to.not.include('%VAR%');
    });

    it('tells slim sub-agents to use structured edits instead of commands', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSlimSystemPromptForMode('build', undefined, undefined, undefined, 'paradox');
        const context = builder.buildContextMessages({
            topicId: 'topic-123',
            domain: 'paradox',
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

    it('inherits user-owned CWTOOLS.md instructions in slim Paradox prompts', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const workspaceRoot = makeWorkspace();
        try {
            fs.writeFileSync(path.join(workspaceRoot, 'CWTOOLS.md'), [
                '# CWTools Agent Project Rules',
                '',
                '## Any User Heading',
                '- SLIM_MUST_KEEP_THIS_RULE',
                '',
            ].join('\r\n'), 'utf8');
            const builder = new PromptBuilder(workspaceRoot);

            const paradoxPrompt = builder.buildSlimSystemPromptForMode('build', undefined, undefined, undefined, 'paradox');
            const generalPrompt = builder.buildSlimSystemPromptForMode('utility', undefined, undefined, undefined, 'general');

            expect(paradoxPrompt).to.include('SLIM_MUST_KEEP_THIS_RULE');
            expect(generalPrompt).to.not.include('SLIM_MUST_KEEP_THIS_RULE');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('lets slim utility sub-agents run scoped repository verification commands', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(process.cwd());
        const prompt = builder.buildSlimSystemPromptForMode('utility', undefined, undefined, undefined, 'general');

        expect(prompt).to.include('general-coding sub-task');
        expect(prompt).to.include('scoped repository inspection, formatting, builds, or tests');
        expect(prompt).to.include('parent policy engine');
        expect(prompt).to.not.include('NEVER use `run_command`');
    });
});
