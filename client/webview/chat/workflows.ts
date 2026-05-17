export interface WorkflowPhaseView {
    id: string;
    title: string;
    description?: string;
}

export interface WorkflowVerificationView {
    id: string;
    description: string;
    required?: boolean;
    verificationTool?: string;
}

export interface WorkflowView {
    id: string;
    title: string;
    description: string;
    mode: string;
    phases: WorkflowPhaseView[];
    verification: WorkflowVerificationView[];
}

export function buildWorkflowSummary(workflow: WorkflowView | undefined): string {
    if (!workflow) return 'No workflow selected';
    const phaseCount = workflow.phases?.length ?? 0;
    const requiredChecks = (workflow.verification ?? []).filter(v => v.required !== false).length;
    return `${workflow.title} | ${workflow.mode} | ${phaseCount} phase(s) | ${requiredChecks} required check(s)`;
}

export function getWorkflowSlashCommand(workflowId: string): string {
    return `/workflow:${workflowId}`;
}
