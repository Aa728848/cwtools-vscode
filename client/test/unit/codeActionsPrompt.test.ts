import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('AI code action prompts', () => {
    const root = path.resolve(__dirname, '../../..');
    const source = fs.readFileSync(path.join(root, 'client/extension/codeActions.ts'), 'utf8');

    it('scopes single-diagnostic fixes away from file-wide repair', () => {
        expect(source).to.include('function buildSingleDiagnosticFixPrompt');
        expect(source).to.include('Fix only this one CWTools diagnostic.');
        expect(source).to.include('Do not fix other diagnostics in the same file.');
        expect(source).to.include('any other diagnostics returned by that tool are out of scope');
        expect(source).to.include('Completion criterion for this quick fix is that the target diagnostic is resolved');
        expect(source).to.include('只修复这一个诊断');
        expect(source).to.include('不要修复同一文件中的其它诊断');
        expect(source).to.include('完成标准是该目标诊断被解决');
    });

    it('keeps missing-localisation quick fixes limited to the named key', () => {
        expect(source).to.include('create or update only the exact key named by this diagnostic message');
        expect(source).to.include('do not also create other missing keys');
        expect(source).to.include('`_desc` companion keys');
    });

    it('keeps the explicit fix-all command separate', () => {
        expect(source).to.include("command: 'cwtools.ai.codeAction.fixAll'");
        expect(source).to.include('Get and fix all CWTools diagnostic errors');
        expect(source).to.include('修复当前文件');
    });
});
