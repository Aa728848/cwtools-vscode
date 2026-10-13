import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { buildSkillSlashTurnBody, listSkills, loadSkill, SKILL_BODY_CHAR_LIMIT } from '../../extension/ai/skills';
import { getSlashCommandDescriptors, resolveSlashCommand } from '../../extension/ai/slashCommands';
import { GENERAL_WRITE } from './schedulingFixtures';
import {
    AgentToolExecutor,
    makeWorkspace,
    cleanupWorkspace,
    resetStubState,
    resetSandboxStorageForTesting,
} from './agentToolSafetyFixtures';

/** Write a project-level SKILL.md the way an installed skill looks on disk. */
function writeSkill(workspaceRoot: string, name: string, frontmatter = '', body = `Follow ${name}.`): void {
    const directory = path.join(workspaceRoot, '.agents', 'skills', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} skill\n${frontmatter}---\n${body}\n`,
        'utf8',
    );
}

describe('/skill slash command (skill lookup and turn body)', () => {
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

    it('injects the SKILL.md body of the skill the command named', () => {
        writeSkill(workspaceRoot, 'release-extension', '', '# Release\n\nBump the version.');

        // Both invocations resolve to the same definition and therefore to the
        // same skill name, exactly as /skill:<name> promises.
        for (const command of ['/skill release-extension', '/skill:release-extension']) {
            const resolved = resolveSlashCommand(command);
            expect(resolved?.definition.id, command).to.equal('skill');
            expect(resolved?.skillName, command).to.equal('release-extension');

            const loaded = loadSkill(resolved!.skillName!, { workspaceRoot }, GENERAL_WRITE.domainProfile);
            expect(loaded.success, command).to.equal(true);
            if (!loaded.success) return;
            const turnBody = buildSkillSlashTurnBody(loaded.skill.name, loaded.content, resolved!.argument);
            expect(turnBody, command).to.include('<skill name="release-extension">');
            expect(turnBody, command).to.include('Bump the version.');
            expect(turnBody, command).to.include('</skill>');
            expect(turnBody, command).to.not.include('<skill-arguments>');
        }
    });

    it('carries slash arguments in a skill-arguments block', () => {
        const resolved = resolveSlashCommand('/skill:release-extension target 2.8.0');
        expect(resolved?.skillName).to.equal('release-extension');
        expect(resolved?.argument).to.equal('target 2.8.0');

        const turnBody = buildSkillSlashTurnBody('release-extension', 'Body.', resolved!.argument);
        expect(turnBody).to.include('<skill-arguments>');
        expect(turnBody).to.include('"target 2.8.0"');
        expect(turnBody).to.include('</skill-arguments>');
    });

    it('truncates an oversized skill body the same way run_skill does', () => {
        const oversized = 'x'.repeat(SKILL_BODY_CHAR_LIMIT + 5000);
        writeSkill(workspaceRoot, 'huge-skill', '', oversized);

        const loaded = loadSkill('huge-skill', { workspaceRoot }, GENERAL_WRITE.domainProfile);
        expect(loaded.success).to.equal(true);
        if (!loaded.success) return;
        expect(loaded.truncated).to.equal(true);
        expect(loaded.content.length).to.equal(SKILL_BODY_CHAR_LIMIT);

        const turnBody = buildSkillSlashTurnBody(loaded.skill.name, loaded.content, 'arg');
        expect(turnBody).to.include('<skill name="huge-skill">');
        expect(turnBody.length).to.be.lessThan(loaded.content.length + 200);
    });

    it('lists an unknown skill with the names the user can actually use', () => {
        writeSkill(workspaceRoot, 'release-extension');
        writeSkill(workspaceRoot, 'other-skill');

        const failed = loadSkill('nope', { workspaceRoot }, GENERAL_WRITE.domainProfile);
        expect(failed.success).to.equal(false);
        if (failed.success) return;
        expect(failed.availableSkills).to.deep.equal(['other-skill', 'release-extension']);
    });

    it('matches skill names case-insensitively through the same lookup', () => {
        writeSkill(workspaceRoot, 'release-extension');
        expect(loadSkill('RELEASE-EXTENSION', { workspaceRoot }, GENERAL_WRITE.domainProfile).success).to.equal(true);
        expect(listSkills({ workspaceRoot }).map(skill => skill.name)).to.deep.equal(['release-extension']);
    });
});

describe('/skill slash command (allowed-tools policy)', () => {
    let workspaceRoot: string;
    let executor: InstanceType<typeof AgentToolExecutor>;

    const runId = 'run_skill_slash_test';
    const runContext = () => ({
        runnerOptions: {
            schedulingState: GENERAL_WRITE,
            runRecord: { runId },
            topicId: 'topic-a',
        },
    }) as any;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
        resetStubState();
        resetSandboxStorageForTesting();
        executor = new AgentToolExecutor({} as any, workspaceRoot);
    });

    afterEach(() => {
        resetStubState();
        resetSandboxStorageForTesting();
        cleanupWorkspace(workspaceRoot);
    });

    it('narrows the run to the preloaded skill allowed-tools without calling run_skill', async () => {
        writeSkill(workspaceRoot, 'narrow-skill', 'allowed-tools: read_file\n', 'Read only.');

        const preload = executor.preloadSkillPolicy(runId, 'narrow-skill', GENERAL_WRITE.domainProfile);
        expect(preload.applied).to.equal(true);
        expect(preload.skillName).to.equal('narrow-skill');
        expect(preload.allowedTools).to.deep.equal(['read_file']);
        expect(preload.activeSkills).to.deep.equal(['narrow-skill']);

        // A tool outside the declaration is denied by the same guard run_skill uses.
        const denied = await executor.execute('list_directory', { path: '.' }, runContext()) as any;
        expect(denied.success).to.equal(false);
        expect(denied.skillPolicyDenied).to.equal(true);
        expect(denied.allowedTools).to.deep.equal(['read_file']);

        // run_skill itself stays reachable so the model can still switch skills.
        const withinPolicy = await executor.execute('read_file', { path: 'notes.md' }, runContext()) as any;
        expect(withinPolicy.skillPolicyDenied).to.not.equal(true);
    });

    it('intersects a preloaded skill with a later run_skill on the same run', async () => {
        writeSkill(workspaceRoot, 'first-skill', 'allowed-tools: read_file, list_directory\n', 'First.');
        writeSkill(workspaceRoot, 'second-skill', 'allowed-tools: list_directory\n', 'Second.');

        expect(executor.preloadSkillPolicy(runId, 'first-skill', GENERAL_WRITE.domainProfile).allowedTools)
            .to.deep.equal(['list_directory', 'read_file']);

        const loaded = await executor.execute('run_skill', { name: 'second-skill' }, runContext()) as any;
        expect(loaded.success).to.equal(true);
        expect(loaded.policyEnforced).to.equal(true);
        expect(loaded.activeSkills).to.deep.equal(['first-skill', 'second-skill']);
        // Intersection, never a union: loading a second skill cannot widen tools.
        expect(loaded.effectiveAllowedTools).to.deep.equal(['list_directory']);

        const denied = await executor.execute('read_file', { path: 'notes.md' }, runContext()) as any;
        expect(denied.skillPolicyDenied).to.equal(true);
        expect(denied.allowedTools).to.deep.equal(['list_directory']);
    });

    it('reports why a policy was not armed instead of failing silently', () => {
        writeSkill(workspaceRoot, 'plain-skill');
        writeSkill(workspaceRoot, 'broken-skill', 'allowed-tools: not_a_tool\n', 'Broken.');

        expect(executor.preloadSkillPolicy(runId, 'missing-skill', GENERAL_WRITE.domainProfile))
            .to.include({ applied: false, reason: 'unknown-skill' });
        expect(executor.preloadSkillPolicy(runId, '', GENERAL_WRITE.domainProfile))
            .to.include({ applied: false, reason: 'empty-request' });
        expect(executor.preloadSkillPolicy('', 'plain-skill', GENERAL_WRITE.domainProfile))
            .to.include({ applied: false, reason: 'empty-request' });
        // A skill without allowed-tools narrows nothing; that is not a failure.
        expect(executor.preloadSkillPolicy(runId, 'plain-skill', GENERAL_WRITE.domainProfile))
            .to.include({ applied: false, reason: 'no-allowed-tools', skillName: 'plain-skill' });
        expect(executor.preloadSkillPolicy(runId, 'broken-skill', GENERAL_WRITE.domainProfile))
            .to.include({ applied: false, reason: 'unknown-tool', skillName: 'broken-skill', detail: 'not_a_tool' });
    });

    it('scopes the policy to its run id and releases it on cleanup', async () => {
        writeSkill(workspaceRoot, 'narrow-skill', 'allowed-tools: read_file\n', 'Read only.');

        expect(executor.preloadSkillPolicy('run_a', 'narrow-skill', GENERAL_WRITE.domainProfile).applied).to.equal(true);
        const otherRun = {
            runnerOptions: { schedulingState: GENERAL_WRITE, runRecord: { runId: 'run_b' }, topicId: 'topic-a' },
        } as any;
        const unconstrained = await executor.execute('list_directory', { path: '.' }, otherRun) as any;
        expect(unconstrained.skillPolicyDenied).to.not.equal(true);

        executor.clearSkillPolicyForRun('run_a');
        const afterClear = {
            runnerOptions: { schedulingState: GENERAL_WRITE, runRecord: { runId: 'run_a' }, topicId: 'topic-a' },
        } as any;
        const released = await executor.execute('list_directory', { path: '.' }, afterClear) as any;
        expect(released.skillPolicyDenied).to.not.equal(true);
    });
});


describe('/skill catalog rows read folded SKILL.md descriptions', () => {
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

    it('shows the folded description and keeps the 160 character catalog cap', () => {
        const directory = path.join(workspaceRoot, '.agents', 'skills', 'release-extension');
        fs.mkdirSync(directory, { recursive: true });
        const folded = [
            'Use this skill when the user asks to release a new version of the extension,',
            'bump the version number, write changelogs, build cross-platform .NET servers,',
            'package universal VSIX, and publish to GitHub Releases.',
        ];
        fs.writeFileSync(path.join(directory, 'SKILL.md'), [
            '---',
            'name: release-extension',
            'description: >-',
            ...folded.map(line => '  ' + line),
            '---',
            'Follow the release SOP.',
            '',
        ].join('\n'), 'utf8');

        const skills = listSkills({ workspaceRoot }, GENERAL_WRITE.domainProfile);
        expect(skills.map(skill => skill.description)).to.deep.equal([
            folded.join(' '),
        ]);

        const commands = getSlashCommandDescriptors('en', skills.map(skill => ({
            name: skill.name,
            description: skill.description,
        })));
        const row = commands.find(command => command.command === '/skill:release-extension');
        expect(row).to.not.be.undefined;
        expect(row!.description).to.equal('Load Agent skill "release-extension": ' + folded.join(' ').slice(0, 160));
        expect(row!.description).to.not.include('>-');
        expect(row!.description.length).to.equal('Load Agent skill "release-extension": '.length + 160);
    });
});
