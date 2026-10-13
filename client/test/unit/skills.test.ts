import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSkillIndexPrompt, listSkills, loadSkill, parseFrontmatter, type ParsedFrontmatter } from '../../extension/ai/skills';

describe('Agent skill capability domains', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-skills-'));
        const writeSkill = (base: string, name: string, frontmatter: string) => {
            const directory = path.join(workspaceRoot, base, name);
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n${frontmatter}---\nUse ${name}.\n`, 'utf8');
        };
        writeSkill('.agents/skills', 'shared-skill', '');
        writeSkill('.agents/skills', 'general-skill', 'capability-domain: general\n');
        writeSkill('.cwtools/skills', 'paradox-skill', '');
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('keeps legacy CWTools skills Paradox-only while allowing explicit General skills', () => {
        const general = listSkills({ workspaceRoot }, 'general');
        const paradox = listSkills({ workspaceRoot }, 'paradox');

        expect(general.map(skill => skill.name)).to.deep.equal(['general-skill', 'shared-skill']);
        expect(paradox.map(skill => skill.name)).to.deep.equal(['paradox-skill', 'shared-skill']);
        expect(buildSkillIndexPrompt({ workspaceRoot }, 'general')).to.not.include('paradox-skill');
        expect(loadSkill('paradox-skill', { workspaceRoot }, 'general').success).to.equal(false);
        expect(loadSkill('paradox-skill', { workspaceRoot }, 'paradox').success).to.equal(true);
    });
});

describe('Agent skill lookup roots (home dir)', () => {
    let sandbox: string;
    let workspaceRoot: string;
    let globalStoragePath: string;
    let extensionPath: string;
    let homeDir: string;

    const writeSkill = (base: string, name: string, frontmatter = '', body?: string) => {
        const directory = path.join(base, name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
            path.join(directory, 'SKILL.md'),
            `---\nname: ${name}\ndescription: ${name} from ${base}\n${frontmatter}---\n${body ?? `Use ${name}.`}\n`,
            'utf8',
        );
    };

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-skill-roots-'));
        workspaceRoot = path.join(sandbox, 'workspace');
        globalStoragePath = path.join(sandbox, 'globalStorage');
        extensionPath = path.join(sandbox, 'extension');
        homeDir = path.join(sandbox, 'home', '.cwtools');
    });

    afterEach(() => {
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it('is skipped when homeDir is not provided', () => {
        writeSkill(path.join(homeDir, 'skills'), 'home-only');
        const skills = listSkills({ workspaceRoot });
        expect(skills.map(skill => skill.name)).to.deep.equal([]);
    });

    it('scans the home dir as a user-level root with default domain both', () => {
        writeSkill(path.join(homeDir, 'skills'), 'home-skill');
        const general = listSkills({ workspaceRoot, homeDir }, 'general');
        const paradox = listSkills({ workspaceRoot, homeDir }, 'paradox');
        expect(general.map(skill => skill.name)).to.deep.equal(['home-skill']);
        expect(paradox.map(skill => skill.name)).to.deep.equal(['home-skill']);
        expect(general[0]?.source).to.equal('user');
    });

    it('lets the home dir override a same-named built-in skill', () => {
        writeSkill(path.join(extensionPath, 'resources', 'skills'), 'shared');
        writeSkill(path.join(homeDir, 'skills'), 'shared');
        const skills = listSkills({ extensionPath, homeDir });
        expect(skills).to.have.length(1);
        expect(skills[0]?.source).to.equal('user');
        expect(skills[0]?.filePath).to.equal(path.join(homeDir, 'skills', 'shared', 'SKILL.md'));
    });

    it('keeps the legacy globalStorage root readable and winning over home on name clash', () => {
        writeSkill(path.join(homeDir, 'skills'), 'dup');
        writeSkill(path.join(globalStoragePath, '.agents', 'skills'), 'dup');
        const skills = listSkills({ globalStoragePath, homeDir });
        expect(skills).to.have.length(1);
        expect(skills[0]?.source).to.equal('user');
        expect(skills[0]?.filePath).to.equal(path.join(globalStoragePath, '.agents', 'skills', 'dup', 'SKILL.md'));
    });

    it('lets project roots override the home dir', () => {
        writeSkill(path.join(homeDir, 'skills'), 'dup');
        writeSkill(path.join(workspaceRoot, '.agents', 'skills'), 'dup');
        const skills = listSkills({ workspaceRoot, homeDir });
        expect(skills).to.have.length(1);
        expect(skills[0]?.source).to.equal('project');
    });

    it('honours capability-domain frontmatter in home skills', () => {
        writeSkill(path.join(homeDir, 'skills'), 'home-general', 'capability-domain: general\n');
        expect(listSkills({ homeDir }, 'paradox').map(skill => skill.name)).to.deep.equal([]);
        expect(listSkills({ homeDir }, 'general').map(skill => skill.name)).to.deep.equal(['home-general']);
    });

    it('loads a home skill body through loadSkill', () => {
        writeSkill(path.join(homeDir, 'skills'), 'home-body', '', 'HOME BODY');
        const loaded = loadSkill('home-body', { homeDir });
        expect(loaded.success).to.equal(true);
        if (loaded.success) {
            expect(loaded.content).to.include('HOME BODY');
            expect(loaded.skill.source).to.equal('user');
        }
    });
});


describe('YAML frontmatter block scalars (skills specification)', () => {
    const parse = (lines: string[]): ParsedFrontmatter => parseFrontmatter(lines.join('\n'));

    it('folds a ">-" block into a single line and stops at the terminator', () => {
        const parsed = parse([
            '---',
            'name: folded',
            'description: >-',
            '  Use this skill when the user asks to release,',
            '  bump the version and publish.',
            '---',
            '',
            '# Body',
            '---',
            '',
            'after',
        ]);

        expect(parsed.frontmatter.description)
            .to.equal('Use this skill when the user asks to release, bump the version and publish.');
        expect(parsed.frontmatter.name).to.equal('folded');
        // The '---' inside the body is body text, never a frontmatter terminator.
        expect(parsed.body).to.equal('# Body\n---\n\nafter');
    });

    it('accepts every folded and literal header and keeps the keys that follow', () => {
        for (const header of ['>', '>-', '>+']) {
            const folded = parse([
                '---',
                'description: ' + header,
                '  one two',
                '  three four',
                'run-as: worker',
                '---',
                'body',
            ]);
            expect(folded.frontmatter.description, header).to.equal('one two three four');
            expect(folded.frontmatter['run-as'], header).to.equal('worker');
        }

        for (const header of ['|', '|-', '|+']) {
            const literal = parse([
                '---',
                'description: ' + header,
                '  one two',
                '  three four',
                'run-as: worker',
                '---',
                'body',
            ]);
            expect(literal.frontmatter.description, header).to.equal('one two\nthree four');
            expect(literal.frontmatter['run-as'], header).to.equal('worker');
        }
    });

    it('keeps the whole block when it is the last frontmatter entry', () => {
        const parsed = parse([
            '---',
            'name: last-block',
            'description: >-',
            '  trailing block text',
            '---',
            'body',
        ]);

        expect(parsed.frontmatter.description).to.equal('trailing block text');
        expect(parsed.frontmatter.name).to.equal('last-block');
        expect(parsed.body).to.equal('body');
    });

    it('folds blank lines into a paragraph break and keeps them in a literal block', () => {
        const folded = parse([
            '---',
            'description: >-',
            '  first paragraph',
            '',
            '  second paragraph',
            '---',
        ]);
        expect(folded.frontmatter.description).to.equal('first paragraph\nsecond paragraph');

        const literal = parse([
            '---',
            'description: |-',
            '  first line',
            '',
            '  third line',
            '---',
        ]);
        expect(literal.frontmatter.description).to.equal('first line\n\nthird line');
    });

    it('reads block scalars through CRLF line endings', () => {
        const parsed = parseFrontmatter([
            '---',
            'description: >-',
            '  crlf one',
            '  crlf two',
            'name: crlf',
            '---',
            'body',
        ].join('\r\n'));

        expect(parsed.frontmatter.description).to.equal('crlf one crlf two');
        expect(parsed.frontmatter.name).to.equal('crlf');
    });

    it('ends the block at a column-0 line and at a dedent below the block indent', () => {
        const columnZero = parse([
            '---',
            'description: >-',
            '  block text',
            'name: after',
            '---',
            'body',
        ]);
        expect(columnZero.frontmatter.description).to.equal('block text');
        expect(columnZero.frontmatter.name).to.equal('after');

        const dedent = parse([
            '---',
            'description: >-',
            '    deeply indented text',
            '  dedented text',
            'name: after',
            '---',
        ]);
        expect(dedent.frontmatter.description).to.equal('deeply indented text');
        expect(dedent.frontmatter.name).to.equal('after');
    });

    it('treats an empty block as no value and keeps a quoted indicator literal', () => {
        const empty = parse(['---', 'description: >-', 'name: empty', '---']);
        expect(empty.frontmatter.description).to.equal('');
        expect(empty.frontmatter.name).to.equal('empty');

        const quoted = parse(['---', 'description: ">-"', 'name: quoted', '---']);
        expect(quoted.frontmatter.description).to.equal('>-');
        expect(quoted.frontmatter.name).to.equal('quoted');
    });

    it('leaves single-line frontmatter parsing unchanged', () => {
        const parsed = parse([
            '---',
            'name: plain',
            'Description: A single line value.',
            'allowed-tools: read_file, write_file',
            'capability-domain: general',
            '---',
            '# Title',
            'First useful body line.',
        ]);

        expect(parsed.frontmatter).to.deep.equal({
            name: 'plain',
            description: 'A single line value.',
            'allowed-tools': 'read_file, write_file',
            'capability-domain': 'general',
        });
        expect(parsed.body).to.equal('# Title\nFirst useful body line.');
    });

    it('keeps the missing and unterminated frontmatter fallbacks', () => {
        expect(parseFrontmatter('no frontmatter here')).to.deep.equal({ frontmatter: {}, body: 'no frontmatter here' });
        expect(parseFrontmatter('---\ndescription: >-\n  orphan text\n')).to.deep.equal({
            frontmatter: {},
            body: '---\ndescription: >-\n  orphan text',
        });
    });

    it('feeds the folded description into the skill index instead of the indicator', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-skill-folded-'));
        try {
            const directory = path.join(workspaceRoot, '.agents', 'skills', 'folded-skill');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'SKILL.md'), [
                '---',
                'name: folded-skill',
                'description: >-',
                '  Use this skill when the user asks to fold',
                '  a description across lines.',
                'capability-domain: general',
                '---',
                'Follow the skill.',
                '',
            ].join('\n'), 'utf8');

            expect(listSkills({ workspaceRoot }).map(skill => skill.description)).to.deep.equal([
                'Use this skill when the user asks to fold a description across lines.',
            ]);
            const index = buildSkillIndexPrompt({ workspaceRoot });
            expect(index).to.include(
                '- folded-skill: Use this skill when the user asks to fold a description across lines. (source: project; domain: general)',
            );
            expect(index).to.not.include('folded-skill: >-');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('falls back to the first body line when a block carries no content', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-skill-empty-block-'));
        try {
            const directory = path.join(workspaceRoot, '.agents', 'skills', 'empty-block');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'SKILL.md'), [
                '---',
                'name: empty-block',
                'description: >-',
                '---',
                'First useful body line.',
                '',
            ].join('\n'), 'utf8');

            expect(listSkills({ workspaceRoot }).map(skill => skill.description)).to.deep.equal(['First useful body line.']);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
});
