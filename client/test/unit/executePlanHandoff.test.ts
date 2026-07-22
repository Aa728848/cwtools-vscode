import { expect } from 'chai';
import { buildApprovedPlanExecutionReminder, shouldRenderInteractivePlan } from '../../extension/ai/executePlanHandoff';
import { buildBuildSystemPrompt } from '../../extension/ai/prompt/sections/modePrompts';
import type { AgentStep } from '../../extension/ai/types';

function toolCall(toolName: string): AgentStep {
    return { type: 'tool_call', toolName, content: '', timestamp: 1 };
}

describe('Execute-to-Plan handoff', () => {
    it('turns a model-selected no-write plan stop into an approvable plan', () => {
        expect(shouldRenderInteractivePlan({
            explanation: '修改方案已准备就绪。等待进入执行阶段写入文件。',
            steps: [toolCall('read_file'), toolCall('todo_write')],
        })).to.equal(true);
    });

    it('does not intercept an Execute result after a project write', () => {
        expect(shouldRenderInteractivePlan({
            explanation: '修改计划已经完成，下一步可以执行验证。',
            steps: [toolCall('todo_write'), toolCall('edit_file')],
        })).to.equal(false);
    });

    it('renders an explicitly proposed interactive plan independently of runtime mode', () => {
        expect(shouldRenderInteractivePlan({
            explanation: 'The implementation plan is ready for approval.',
            steps: [],
        })).to.equal(true);
    });

    it('renders a proposed plan that asks to enter execution even without saying it is ready', () => {
        expect(shouldRenderInteractivePlan({
            explanation: '以下是将要执行的修改计划。如果方案确认，请让我进入执行阶段修改文件。',
            steps: [toolCall('read_file')],
        })).to.equal(true);
    });

    it('renders a main-Agent design-stage todo plan even when its final wording omits approval', () => {
        expect(shouldRenderInteractivePlan({
            explanation: '修改计划：更新两个目标文件并运行验证。',
            steps: [toolCall('todo_write')],
            tokenUsage: { toolStage: 'design' },
        })).to.equal(true);
    });

    it('renders an Execute evidence-stage handoff without calling it a second design phase', () => {
        expect(shouldRenderInteractivePlan({
            explanation: 'The implementation plan covers the proposed file changes.',
            steps: [toolCall('todo_write')],
            tokenUsage: { toolStage: 'evidence' },
        })).to.equal(true);
    });

    it('renders a generated plan artifact without relying on response wording', () => {
        const step = toolCall('write_file');
        step.toolArgs = { file: '.cwtools/topic/Implementation_Plan.md' };
        expect(shouldRenderInteractivePlan({ explanation: 'Done.', steps: [step] })).to.equal(true);
    });

    it('keeps ordinary analysis and non-interactive suggestions in chat', () => {
        expect(shouldRenderInteractivePlan({
            explanation: '建议先调整这两个段落，随后检查本地化。',
            steps: [toolCall('read_file')],
        })).to.equal(false);
    });

    it('keeps the approval lifecycle on the main Agent and out of slim sub-Agent prompts', () => {
        const mainPrompt = buildBuildSystemPrompt('', 'Synthetic', false);
        const childPrompt = buildBuildSystemPrompt('', 'Synthetic', true);
        expect(mainPrompt).to.include('host can render its approval card');
        expect(childPrompt).to.not.include('host can render its approval card');
        expect(childPrompt).to.include('Slim Build Contract');
    });

    it('makes an approved plan a direct execute handoff without a second design pass', () => {
        const reminder = buildApprovedPlanExecutionReminder();
        expect(reminder).to.include('final design authority');
        expect(reminder).to.include('Enter Write/Execute immediately');
        expect(reminder).to.include('Do not re-enter discovery or design');
        expect(reminder).to.include('request approval again');
    });
});
