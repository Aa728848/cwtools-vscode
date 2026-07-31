import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGeneralProjectInstructionsPrompt } from '../../extension/ai/projectInstructions';

describe('general project instructions', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-instructions-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('loads standard root instructions and increasingly specific AGENTS.md files', () => {
        fs.mkdirSync(path.join(root, '.github'), { recursive: true });
        fs.mkdirSync(path.join(root, 'packages', 'app', 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rule', 'utf8');
        fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'claude rule', 'utf8');
        fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'copilot rule', 'utf8');
        fs.writeFileSync(path.join(root, 'packages', 'AGENTS.md'), 'package rule', 'utf8');
        fs.writeFileSync(path.join(root, 'packages', 'app', 'AGENTS.md'), 'app rule', 'utf8');

        const prompt = buildGeneralProjectInstructionsPrompt(
            root,
            path.join(root, 'packages', 'app', 'src', 'index.ts'),
        );
        expect(prompt).to.include('root rule');
        expect(prompt).to.include('claude rule');
        expect(prompt).to.include('copilot rule');
        expect(prompt).to.include('package rule');
        expect(prompt).to.include('app rule');
        expect(prompt.indexOf('root rule')).to.be.lessThan(prompt.indexOf('app rule'));
    });

    it('does not load target instructions outside the workspace', () => {
        fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root only', 'utf8');
        const prompt = buildGeneralProjectInstructionsPrompt(root, path.join(os.tmpdir(), 'outside', 'file.ts'));
        expect(prompt).to.include('root only');
        expect(prompt).to.not.include('outside');
    });
});
