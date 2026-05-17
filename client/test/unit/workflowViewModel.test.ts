import { expect } from 'chai';
import { getWorkflow } from '../../extension/ai/workflowRegistry';
import { toWorkflowViewModel } from '../../extension/ai/workflowViewModel';

describe('workflowViewModel', () => {
    it('serializes workflow metadata for the webview', () => {
        const workflow = getWorkflow('diagnostic-fix')!;
        const view = toWorkflowViewModel(workflow);

        expect(view.id).to.equal('diagnostic-fix');
        expect(view.title).to.equal(workflow.title);
        expect(view.mode).to.equal(workflow.mode);
        expect(view.phases).to.have.lengthOf(workflow.phases.length);
        expect(view.verification[0]!.id).to.equal(workflow.verification[0]!.id);
    });

    it('localizes workflow metadata for Simplified Chinese UI', () => {
        const workflow = getWorkflow('diagnostic-fix')!;
        const view = toWorkflowViewModel(workflow, 'zh-cn');

        expect(view.locale).to.equal('zh-cn');
        expect(view.title).to.equal('诊断修复');
        expect(view.description).to.include('CWTools LSP');
        expect(view.phases[0]!.title).to.equal('收集诊断');
        expect(view.verification[0]!.description).to.include('真实错误');
    });
});
