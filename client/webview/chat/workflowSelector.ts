import {
    buildWorkflowSummary,
    normalizeWorkflowLabels,
    type WorkflowUiLabels,
    type WorkflowView,
} from './workflows';

export interface WorkflowSelectorState {
    workflows: WorkflowView[];
    activeWorkflowId?: string | null;
    labels?: Partial<WorkflowUiLabels> | null;
}

export function renderWorkflowSelector(
    selector: HTMLSelectElement | null,
    state: WorkflowSelectorState
): WorkflowView | undefined {
    if (!selector) return undefined;

    const labels = normalizeWorkflowLabels(state.labels);
    const activeWorkflow = state.workflows.find(workflow => workflow.id === state.activeWorkflowId);

    selector.innerHTML = '';
    const off = document.createElement('option');
    off.value = '';
    off.textContent = labels.selectorPlaceholder;
    off.title = labels.noWorkflowSelected;
    off.selected = !activeWorkflow;
    selector.appendChild(off);

    for (const workflow of state.workflows) {
        const opt = document.createElement('option');
        opt.value = workflow.id;
        opt.textContent = workflow.title;
        opt.title = buildWorkflowSummary(workflow, labels);
        opt.selected = workflow.id === state.activeWorkflowId;
        selector.appendChild(opt);
    }

    selector.classList.toggle('active', !!activeWorkflow);
    selector.title = buildWorkflowSummary(activeWorkflow, labels);
    return activeWorkflow;
}
