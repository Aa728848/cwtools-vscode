import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSkillIndexPrompt, listSkills, loadSkill } from '../../extension/ai/skills';

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
