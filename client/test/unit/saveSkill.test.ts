import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSkillIndexPrompt, listSkills, loadSkill, SKILL_BODY_CHAR_LIMIT } from '../../extension/ai/skills';
import { saveSkill, skillSaveDirectory, SKILL_DESCRIPTION_CHAR_LIMIT } from '../../extension/ai/skillsWriter';
import { setAiMessageLocale } from '../../extension/ai/messages';
import { GENERAL_WRITE, PARADOX_EXPLORE, PARADOX_PLAN } from './schedulingFixtures';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import {
    AgentToolExecutor,
    makeWorkspace,
    cleanupWorkspace,
    resetStubState,
    resetSandboxStorageForTesting,
    workspacePaths,
} from './agentToolSafetyFixtures';

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

describe('saveSkill writer', () => {
    let sandbox: string;
    let workspaceRoot: string;
    let homeDir: string;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-save-skill-'));
        workspaceRoot = path.join(sandbox, 'workspace');
        homeDir = path.join(sandbox, 'home', '.cwtools');
        fs.mkdirSync(workspaceRoot, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it('saves a project skill into .agents/skills and listSkills/loadSkill discover it', () => {
        const result = saveSkill({
            name: 'Release-Check',
            description: 'Release checklist skill',
            body: '# Release\n\n1. Bump the version.',
            scope: 'project',
            workspaceRoot,
            homeDir,
        });

        expect(result.success).to.equal(true);
        const expectedPath = path.join(workspaceRoot, '.agents', 'skills', 'release-check', 'SKILL.md');
        expect(result.success && result.path).to.equal(expectedPath);
        expect(result.success && result.scope).to.equal('project');
        expect(result.success && result.name).to.equal('release-check');

        const raw = fs.readFileSync(expectedPath, 'utf8');
        expect(raw.charCodeAt(0)).to.not.equal(0xFEFF);
        expect(raw).to.include('name: release-check');
        expect(raw).to.include('description: "Release checklist skill"');
        expect(raw).to.include('1. Bump the version.');
        // Atomic write leaves no temp files behind.
        expect(fs.readdirSync(path.dirname(expectedPath)).filter(name => name.endsWith('.tmp'))).to.deep.equal([]);

        const skills = listSkills({ workspaceRoot });
        const entry = skills.find(skill => skill.name === 'release-check');
        expect(entry?.source).to.equal('project');
        // .agents/skills defaults to domain both, so the skill is usable everywhere.
        expect(entry?.capabilityDomain).to.equal('both');
        expect(entry?.description).to.equal('Release checklist skill');
        expect(entry?.runAs).to.equal(undefined);
        expect(entry?.allowedTools).to.equal(undefined);

        const loaded = loadSkill('release-check', { workspaceRoot });
        expect(loaded.success).to.equal(true);
        if (loaded.success) {
            expect(loaded.content).to.include('# Release');
        }
        expect(buildSkillIndexPrompt({ workspaceRoot })).to.include('release-check');
    });

    it('saves a user skill into the home skills directory', () => {
        const result = saveSkill({
            name: 'home-skill',
            description: 'User-level skill',
            body: 'Use from every workspace.',
            scope: 'user',
            workspaceRoot,
            homeDir,
        });

        expect(result.success).to.equal(true);
        expect(result.success && result.path).to.equal(path.join(homeDir, 'skills', 'home-skill', 'SKILL.md'));
        const skills = listSkills({ homeDir });
        expect(skills.map(skill => skill.name)).to.deep.equal(['home-skill']);
        expect(skills[0]?.source).to.equal('user');
    });

    it('round-trips optional frontmatter fields through the scanner', () => {
        const result = saveSkill({
            name: 'narrowed',
            description: 'Skill with policy fields',
            body: 'Body.',
            capabilityDomain: 'paradox',
            runAs: 'subagent',
            allowedTools: ['read_file', 'grep'],
            scope: 'project',
            workspaceRoot,
            homeDir,
        });
        expect(result.success).to.equal(true);

        const entry = listSkills({ workspaceRoot }, 'paradox').find(skill => skill.name === 'narrowed');
        expect(entry?.capabilityDomain).to.equal('paradox');
        expect(entry?.runAs).to.equal('subagent');
        expect(entry?.allowedTools).to.deep.equal(['read_file', 'grep']);
        // Domain gate honoured: not visible to the general runtime.
        expect(listSkills({ workspaceRoot }, 'general').map(skill => skill.name)).to.not.include('narrowed');
    });

    it('refuses to overwrite an existing skill unless overwrite=true', () => {
        const base = { name: 'dup', description: 'first', body: 'v1', scope: 'project' as const, workspaceRoot, homeDir };
        expect(saveSkill(base).success).to.equal(true);

        const conflict = saveSkill({ ...base, description: 'second', body: 'v2' });
        expect(conflict.success).to.equal(false);
        if (!conflict.success) {
            expect(conflict.alreadyExists).to.equal(true);
            expect(conflict.error).to.include('overwrite');
        }
        const filePath = path.join(workspaceRoot, '.agents', 'skills', 'dup', 'SKILL.md');
        expect(fs.readFileSync(filePath, 'utf8')).to.include('v1');

        const replaced = saveSkill({ ...base, body: 'v2-body', overwrite: true });
        expect(replaced.success).to.equal(true);
        expect(fs.readFileSync(filePath, 'utf8')).to.include('v2-body');
    });

    it('rejects invalid names before touching the filesystem', () => {
        const invalid = ['', '   ', 'Bad Name', '-leading', '.leading', '../escape', 'a/b', 'a\\b', `a${'b'.repeat(64)}`];
        for (const name of invalid) {
            const result = saveSkill({ name, description: 'd', body: 'b', scope: 'project', workspaceRoot, homeDir });
            expect(result.success, `name '${name}' must be rejected`).to.equal(false);
        }
        expect(fs.existsSync(path.join(workspaceRoot, '.agents'))).to.equal(false);
    });

    it('rejects oversize description and body', () => {
        const tooLongDescription = saveSkill({
            name: 'limits',
            description: 'd'.repeat(SKILL_DESCRIPTION_CHAR_LIMIT + 1),
            body: 'b',
            scope: 'project',
            workspaceRoot,
            homeDir,
        });
        expect(tooLongDescription.success).to.equal(false);

        const tooLongBody = saveSkill({
            name: 'limits',
            description: 'd',
            body: 'b'.repeat(SKILL_BODY_CHAR_LIMIT + 1),
            scope: 'project',
            workspaceRoot,
            homeDir,
        });
        expect(tooLongBody.success).to.equal(false);

        expect(saveSkill({ name: 'limits', description: '', body: 'b', scope: 'project', workspaceRoot, homeDir }).success).to.equal(false);
        expect(saveSkill({ name: 'limits', description: 'd', body: '   ', scope: 'project', workspaceRoot, homeDir }).success).to.equal(false);
        expect(saveSkill({ name: 'limits', description: 'd', body: 'b', scope: 'project', workspaceRoot, homeDir, capabilityDomain: 'weird' as never }).success).to.equal(false);
        expect(fs.existsSync(path.join(workspaceRoot, '.agents'))).to.equal(false);
    });

    it('requires an existing workspace root for project scope', () => {
        const missing = saveSkill({ name: 's', description: 'd', body: 'b', scope: 'project', homeDir });
        expect(missing.success).to.equal(false);

        const gone = path.join(sandbox, 'gone');
        const result = saveSkill({ name: 's', description: 'd', body: 'b', scope: 'project', workspaceRoot: gone, homeDir });
        expect(result.success).to.equal(false);
        if (!result.success) expect(result.error).to.include('Workspace root');
    });

    it('resolves save directories per scope', () => {
        expect(skillSaveDirectory('project', workspaceRoot, homeDir)).to.equal(path.join(workspaceRoot, '.agents', 'skills'));
        expect(skillSaveDirectory('user', workspaceRoot, homeDir)).to.equal(path.join(homeDir, 'skills'));
        expect(skillSaveDirectory('project', undefined, homeDir)).to.equal(undefined);
    });
});

describe('save_skill tool executor wiring', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
        resetStubState();
        resetSandboxStorageForTesting();
    });

    afterEach(() => {
        resetStubState();
        resetSandboxStorageForTesting();
        cleanupWorkspace(workspaceRoot);
    });

    it('saves a project skill through the executor and emits bilingual feedback', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const steps: Array<{ type: string; content: string }> = [];
        const result = await executor.execute('save_skill', {
            name: 'executor-skill',
            description: 'Saved through the tool surface',
            body: '# Steps\n\nDo the thing.',
            scope: 'project',
        }, {
            runnerOptions: { schedulingState: GENERAL_WRITE },
            onStep: (step: { type: string; content: string }) => steps.push(step),
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(result.path).to.equal(path.join(workspaceRoot, '.agents', 'skills', 'executor-skill', 'SKILL.md'));
        expect(fs.existsSync(result.path)).to.equal(true);

        const feedback = steps.find(step => step.type === 'thinking' && step.content.includes('executor-skill'));
        expect(feedback, 'expected a thinking step announcing the saved skill').to.not.equal(undefined);
        expect(feedback?.content).to.include('Skill saved');
        expect(feedback?.content).to.include('run_skill');

        setAiMessageLocale('zh-CN');
        try {
            const zhSteps: Array<{ type: string; content: string }> = [];
            const zhResult = await executor.execute('save_skill', {
                name: 'executor-skill-zh',
                description: '中文反馈',
                body: '中文正文。',
                scope: 'project',
            }, {
                runnerOptions: { schedulingState: GENERAL_WRITE },
                onStep: (step: { type: string; content: string }) => zhSteps.push(step),
            } as any) as any;
            expect(zhResult.success).to.equal(true);
            const zhFeedback = zhSteps.find(step => step.type === 'thinking' && step.content.includes('executor-skill-zh'));
            expect(zhFeedback?.content).to.include('技能已保存');
            expect(zhFeedback?.content).to.include('项目级');
            expect(zhFeedback?.content).to.include('run_skill');
        } finally {
            setAiMessageLocale('en');
        }

        // The saved skill is immediately loadable through the run_skill surface.
        const loaded = await executor.execute('run_skill', { name: 'executor-skill' }, {
            runnerOptions: { schedulingState: GENERAL_WRITE },
        } as any) as any;
        expect(loaded.success).to.equal(true);
        expect(loaded.content).to.include('Do the thing.');
    });

    it('reports name conflicts and honours overwrite through the executor', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const context = { runnerOptions: { schedulingState: GENERAL_WRITE } } as any;
        const first = await executor.execute('save_skill', {
            name: 'dup', description: 'one', body: 'v1', scope: 'project',
        }, context) as any;
        expect(first.success).to.equal(true);

        const conflict = await executor.execute('save_skill', {
            name: 'dup', description: 'two', body: 'v2', scope: 'project',
        }, context) as any;
        expect(conflict.success).to.equal(false);
        expect(conflict.alreadyExists).to.equal(true);

        const replaced = await executor.execute('save_skill', {
            name: 'dup', description: 'two', body: 'v2', scope: 'project', overwrite: true,
        }, context) as any;
        expect(replaced.success).to.equal(true);
    });

    it('rejects unknown allowed_tools entries and paradox-domain saves in General Coding', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const context = { runnerOptions: { schedulingState: GENERAL_WRITE } } as any;

        const unknownTool = await executor.execute('save_skill', {
            name: 'bad-tools', description: 'd', body: 'b', scope: 'project', allowed_tools: ['not_a_tool'],
        }, context) as any;
        expect(unknownTool.success).to.equal(false);
        expect(unknownTool.error).to.include('not_a_tool');

        const paradoxDomain = await executor.execute('save_skill', {
            name: 'paradox-only', description: 'd', body: 'b', scope: 'project', capability_domain: 'paradox',
        }, context) as any;
        expect(paradoxDomain.success).to.equal(false);
        expect(paradoxDomain.error).to.include('paradox');

        const paradoxTool = await executor.execute('save_skill', {
            name: 'paradox-tool', description: 'd', body: 'b', scope: 'project', allowed_tools: ['query_rules'],
        }, context) as any;
        expect(paradoxTool.success).to.equal(false);
        expect(paradoxTool.error).to.include('query_rules');

        expect(fs.existsSync(path.join(workspaceRoot, '.agents'))).to.equal(false);
    });

    it('requires a valid scope', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('save_skill', {
            name: 's', description: 'd', body: 'b',
        }, { runnerOptions: { schedulingState: GENERAL_WRITE } } as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('scope');
    });

    it('stays permitted in plan and explore modes, and auto-discloses with file_write', async () => {
        expect(TOOL_REGISTRY.get('save_skill')?.group).to.equal('file_write');

        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const planResult = await executor.execute('save_skill', {
            name: 'plan-skill', description: 'd', body: 'b', scope: 'project',
        }, { runnerOptions: { schedulingState: { ...PARADOX_PLAN, profileName: 'planner' } } } as any) as any;
        expect(planResult.success).to.equal(true);
        expect(fs.existsSync(path.join(workspaceRoot, '.agents', 'skills', 'plan-skill', 'SKILL.md'))).to.equal(true);

        const exploreResult = await executor.execute('save_skill', {
            name: 'explore-skill', description: 'd', body: 'b', scope: 'project',
        }, { runnerOptions: { schedulingState: PARADOX_EXPLORE } } as any) as any;
        expect(exploreResult.success).to.equal(true);
        expect(fs.existsSync(path.join(workspaceRoot, '.agents', 'skills', 'explore-skill', 'SKILL.md'))).to.equal(true);
    });

    it('returns a recoverable save_skill redirect instead of a run-terminating policy denial when generic write tools target experience.json or skill directories', async () => {
        const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-private-exp-'));
        workspacePaths.configurePrivateAgentStorage(privateRoot);
        try {
            const executor = new AgentToolExecutor({} as any, workspaceRoot);
            executor.fileWriteMode = 'auto';
            const context = { runnerOptions: { schedulingState: GENERAL_WRITE, topicId: 'topic-1' } } as any;

            const expTarget = path.join(privateRoot, 'experience', 'dawning_firmament-433ff8c99b', 'experience.json');
            const expWrite = await executor.execute('write_file', {
                file: expTarget,
                content: '{}',
            }, context) as any;
            expect(expWrite.success).to.equal(false);
            expect(expWrite.policyDenied).to.equal(undefined);
            expect(expWrite.terminalOutcome).to.equal(undefined);
            expect(expWrite.error).to.include('save_skill');
            expect(fs.existsSync(expTarget)).to.equal(false);

            const skillTarget = path.join(workspaceRoot, '.agents', 'skills', 'manual-skill', 'SKILL.md');
            const skillWrite = await executor.execute('write_file', {
                file: skillTarget,
                content: '# bad manual write',
            }, context) as any;
            expect(skillWrite.success).to.equal(false);
            expect(skillWrite.policyDenied).to.equal(undefined);
            expect(skillWrite.terminalOutcome).to.equal(undefined);
            expect(skillWrite.error).to.include('save_skill');
            expect(fs.existsSync(skillTarget)).to.equal(false);

            // Project .cwtools/skills stays rooted in the workspace even when private topic storage is active.
            const projectSkillDir = path.join(workspaceRoot, '.cwtools', 'skills', 'paradox-only');
            fs.mkdirSync(projectSkillDir, { recursive: true });
            fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '---\nname: paradox-only\ndescription: test\n---\nBody\n', 'utf8');
            const readRes = await executor.execute('read_file', {
                file: '.cwtools/skills/paradox-only/SKILL.md',
            }, context) as any;
            expect(readRes.error).to.equal(undefined);
            expect(readRes.content).to.include('paradox-only');
        } finally {
            workspacePaths.configurePrivateAgentStorage(undefined);
            fs.rmSync(privateRoot, { recursive: true, force: true });
        }
    });
});

describe('skills index hash invalidation', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-skill-hash-'));
        saveSkill({
            name: 'seed', description: 'seed skill', body: 'seed body', scope: 'project', workspaceRoot,
        });
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('reuses the cached hash while skills are untouched and invalidates on add/edit', () => {
        const { PromptBuilder } = loadPromptBuilder();
        const builder = new PromptBuilder(workspaceRoot) as unknown as { computeSkillsIndexHash(domain: 'paradox'): string };

        const first = builder.computeSkillsIndexHash('paradox');
        expect(builder.computeSkillsIndexHash('paradox')).to.equal(first);

        saveSkill({ name: 'added', description: 'added skill', body: 'added body', scope: 'project', workspaceRoot });
        const afterAdd = builder.computeSkillsIndexHash('paradox');
        expect(afterAdd).to.not.equal(first);
        expect(builder.computeSkillsIndexHash('paradox')).to.equal(afterAdd);

        saveSkill({ name: 'seed', description: 'seed skill', body: 'seed body with a different length', scope: 'project', workspaceRoot, overwrite: true });
        expect(builder.computeSkillsIndexHash('paradox')).to.not.equal(afterAdd);
    });
});
