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
    scheduling: { domain: string; intent: string; strategy: string; profileName?: string };
    locale?: string;
    phases: WorkflowPhaseView[];
    verification: WorkflowVerificationView[];
}

export interface WorkflowUiLabels {
    selectorPlaceholder: string;
    noWorkflowSelected: string;
    phaseUnit: string;
    phasesUnit: string;
    requiredCheckUnit: string;
    requiredChecksUnit: string;
}

export const DEFAULT_WORKFLOW_LABELS: WorkflowUiLabels = {
    selectorPlaceholder: 'Workflow',
    noWorkflowSelected: 'No workflow selected',
    phaseUnit: 'phase',
    phasesUnit: 'phases',
    requiredCheckUnit: 'required check',
    requiredChecksUnit: 'required checks',
};

export function normalizeWorkflowLabels(labels?: Partial<WorkflowUiLabels> | null): WorkflowUiLabels {
    return {
        ...DEFAULT_WORKFLOW_LABELS,
        ...(labels ?? {}),
    };
}

export function buildWorkflowSummary(workflow: WorkflowView | undefined, labels?: Partial<WorkflowUiLabels> | null): string {
    const ui = normalizeWorkflowLabels(labels);
    if (!workflow) return ui.noWorkflowSelected;
    const phaseCount = workflow.phases?.length ?? 0;
    const requiredChecks = (workflow.verification ?? []).filter(v => v.required !== false).length;
    const phaseUnit = phaseCount === 1 ? ui.phaseUnit : ui.phasesUnit;
    const checkUnit = requiredChecks === 1 ? ui.requiredCheckUnit : ui.requiredChecksUnit;
    const route = `${workflow.scheduling.domain}/${workflow.scheduling.intent}/${workflow.scheduling.strategy}`;
    return `${workflow.title} | ${route} | ${phaseCount} ${phaseUnit} | ${requiredChecks} ${checkUnit}`;
}

export function getWorkflowSlashCommand(workflowId: string): string {
    return `/workflow:${workflowId}`;
}
