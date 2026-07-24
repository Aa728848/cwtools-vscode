import { expect } from 'chai';
import {
    buildApprovedPlanExecutionReminder,
    shouldRenderInteractivePlan,
    validateImplementationPlan,
} from '../../extension/ai/executePlanHandoff';
import { buildBuildSystemPrompt } from '../../extension/ai/prompt/sections/modePrompts';
import type { AgentStep } from '../../extension/ai/types';

function toolCall(toolName: string, file?: string, invocationId = `${toolName}-1`): AgentStep {
    return { type: 'tool_call', toolName, toolArgs: file ? { file } : undefined, content: '', timestamp: 1, invocationId };
}

function successfulToolResult(toolName: string, invocationId = `${toolName}-1`): AgentStep {
    return { type: 'tool_result', toolName, toolResult: { success: true }, content: '', timestamp: 2, invocationId };
}

function completePlan(overrides: Record<string, unknown> = {}): string {
    const contract = {
        version: 1,
        status: 'ready',
        objective: 'Replace wording-based plan detection with a structured and mode-safe approval handoff.',
        targetFiles: ['client/extension/ai/executePlanHandoff.ts', 'client/test/unit/executePlanHandoff.test.ts'],
        operations: [
            {
                id: 'runtime',
                description: 'Validate the explicit plan handoff contract before showing approval UI.',
                files: ['client/extension/ai/executePlanHandoff.ts'],
                dependsOn: [],
            },
            {
                id: 'tests',
                description: 'Cover mode boundaries and incomplete plan rejection.',
                files: ['client/test/unit/executePlanHandoff.test.ts'],
                dependsOn: ['runtime'],
            },
        ],
        verification: ['Run the targeted executePlanHandoff unit tests.'],
        acceptanceCriteria: ['Explore prose never creates an execution approval card.'],
        risks: [{ risk: 'Older unstructured plans no longer render approval UI.', mitigation: 'Require Plan mode to emit the documented v1 contract.' }],
        rollback: ['Revert the handoff validator and its prompt contract together.'],
        unresolvedCritical: [],
        ...overrides,
    };
    return `# Objective

Replace the permissive wording detector with a structured approval boundary. The change keeps exploratory findings in chat and reserves execution approval for a complete implementation contract.

## Operations

First update the runtime validator and its mode boundary. Then update the regression tests so execution cannot begin from a preliminary answer or from a plan with unresolved dependencies.

## Verification and rollback

Run the focused unit tests and the TypeScript compiler. If compatibility problems appear, revert the validator, prompt contract, and tests as one change rather than weakening only one side of the boundary.

\`\`\`cwtools-plan
${JSON.stringify(contract, null, 2)}
\`\`\``;
}

describe('Execute-to-Plan handoff', () => {
    it('never turns Explore prose into an approvable plan', () => {
        const explanation = 'The implementation plan is ready for approval. Confirm and I will execute it.';
        expect(shouldRenderInteractivePlan({ explanation, steps: [] }, {
            mode: 'explore',
            planText: completePlan(),
        })).to.equal(false);
    });

    it('renders a complete structured Plan-mode handoff', () => {
        const plan = completePlan();
        expect(shouldRenderInteractivePlan({ explanation: plan, steps: [] }, {
            mode: 'plan',
            planText: plan,
        })).to.equal(true);
    });

    it('rejects Plan-mode prose without the structured contract', () => {
        const explanation = 'The implementation plan is ready for approval.';
        expect(shouldRenderInteractivePlan({ explanation, steps: [] }, {
            mode: 'plan',
            planText: explanation,
        })).to.equal(false);
    });

    it('rejects a structured plan with unresolved critical decisions', () => {
        const plan = completePlan({ unresolvedCritical: ['Choose the storage format.'] });
        const validation = validateImplementationPlan(plan);
        expect(validation.complete).to.equal(false);
        expect(validation.missing).to.include('unresolvedCritical must be empty');
    });

    it('requires exactly one contract with exact unique target-file ownership', () => {
        expect(validateImplementationPlan(`${completePlan()}\n${completePlan()}`).missing)
            .to.include('exactly one cwtools-plan contract');
        expect(validateImplementationPlan(completePlan({
            targetFiles: ['client/**/handoff.ts'],
            operations: [{
                id: 'runtime',
                description: 'Update runtime.',
                files: ['client/**/handoff.ts'],
                dependsOn: [],
            }],
        })).missing).to.include('exact unique targetFiles');
        expect(validateImplementationPlan(completePlan({
            operations: [
                {
                    id: 'runtime',
                    description: 'Update runtime.',
                    files: ['client/extension/ai/executePlanHandoff.ts'],
                    dependsOn: [],
                },
                {
                    id: 'tests',
                    description: 'Update tests and the runtime file again.',
                    files: ['client/extension/ai/executePlanHandoff.ts', 'client/test/unit/executePlanHandoff.test.ts'],
                    dependsOn: ['runtime'],
                },
            ],
        })).missing).to.include('operation file ownership');
    });

    it('rejects operation dependencies that are missing or cyclic', () => {
        const missingDependency = completePlan({
            operations: [{
                id: 'runtime',
                description: 'Update runtime.',
                files: ['client/extension/ai/executePlanHandoff.ts', 'client/test/unit/executePlanHandoff.test.ts'],
                dependsOn: ['unknown'],
            }],
        });
        expect(validateImplementationPlan(missingDependency).missing).to.include('valid operation dependencies');

        const cyclic = completePlan({
            operations: [
                {
                    id: 'runtime',
                    description: 'Update runtime.',
                    files: ['client/extension/ai/executePlanHandoff.ts'],
                    dependsOn: ['tests'],
                },
                {
                    id: 'tests',
                    description: 'Update tests.',
                    files: ['client/test/unit/executePlanHandoff.test.ts'],
                    dependsOn: ['runtime'],
                },
            ],
        });
        expect(validateImplementationPlan(cyclic).missing).to.include('acyclic operation dependencies');
    });

    it('requires Execute-mode handoffs to create an explicit plan artifact', () => {
        const plan = completePlan();
        expect(shouldRenderInteractivePlan({ explanation: plan, steps: [] }, {
            mode: 'utility',
            planText: plan,
        })).to.equal(false);
        expect(shouldRenderInteractivePlan({
            explanation: plan,
            steps: [
                toolCall('write_file', '.cwtools/topic/Implementation_Plan.md'),
                successfulToolResult('write_file'),
            ],
        }, {
            mode: 'utility',
            planText: plan,
        })).to.equal(true);
    });

    it('does not intercept an Execute result after a project write', () => {
        const plan = completePlan();
        expect(shouldRenderInteractivePlan({
            explanation: plan,
            steps: [
                toolCall('write_file', '.cwtools/topic/Implementation_Plan.md'),
                successfulToolResult('write_file'),
                toolCall('edit_file', 'client/extension/ai/chatPanel.ts'),
            ],
        }, {
            mode: 'utility',
            planText: plan,
        })).to.equal(false);
    });

    it('rejects failed or generically named Execute-mode plan artifacts', () => {
        const plan = completePlan();
        expect(shouldRenderInteractivePlan({
            explanation: plan,
            steps: [
                toolCall('write_file', '.cwtools/topic/Implementation_Plan.md'),
                { ...successfulToolResult('write_file'), toolResult: { success: false, error: 'write failed' } },
            ],
        }, { mode: 'utility', planText: plan })).to.equal(false);
        expect(shouldRenderInteractivePlan({
            explanation: plan,
            steps: [toolCall('write_file', '.cwtools/topic/plan.md'), successfulToolResult('write_file')],
        }, { mode: 'utility', planText: plan })).to.equal(false);
    });

    it('keeps the approval lifecycle on the main Agent and out of slim sub-Agent prompts', () => {
        const mainPrompt = buildBuildSystemPrompt('', 'Synthetic', false);
        const childPrompt = buildBuildSystemPrompt('', 'Synthetic', true);
        expect(mainPrompt).to.include('cwtools-plan');
        expect(childPrompt).to.not.include('cwtools-plan');
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
