import type { AiWorkflow } from './workflowRegistry';

export interface WorkflowViewModel {
    id: string;
    title: string;
    description: string;
    mode: string;
    phases: Array<{ id: string; title: string; description: string }>;
    verification: Array<{ id: string; description: string; required: boolean; verificationTool?: string }>;
}

export function toWorkflowViewModel(workflow: AiWorkflow): WorkflowViewModel {
    return {
        id: workflow.id,
        title: workflow.title,
        description: workflow.description,
        mode: workflow.mode,
        phases: workflow.phases.map(phase => ({
            id: phase.id,
            title: phase.title,
            description: phase.description,
        })),
        verification: workflow.verification.map(step => ({
            id: step.id,
            description: step.description,
            required: step.required,
            verificationTool: step.verificationTool,
        })),
    };
}
