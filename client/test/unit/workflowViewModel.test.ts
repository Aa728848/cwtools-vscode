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
});
