import type { AiWorkflow } from './workflowRegistry';
import { localizeWorkflow, normalizeWorkflowLocale, type WorkflowLocale } from './workflowI18n';

export interface WorkflowViewModel {
    id: string;
    title: string;
    description: string;
    scheduling: { domain: string; intent: string; strategy: string; profileName?: string };
    locale: WorkflowLocale;
    phases: Array<{ id: string; title: string; description: string }>;
    verification: Array<{ id: string; description: string; required: boolean; verificationTool?: string }>;
}

export function toWorkflowViewModel(workflow: AiWorkflow, locale?: string | null): WorkflowViewModel {
    const normalizedLocale = normalizeWorkflowLocale(locale);
    const localized = localizeWorkflow(workflow, normalizedLocale);
    return {
        id: localized.id,
        title: localized.title,
        description: localized.description,
        scheduling: { ...localized.scheduling },
        locale: normalizedLocale,
        phases: localized.phases.map(phase => ({
            id: phase.id,
            title: phase.title,
            description: phase.description,
        })),
        verification: localized.verification.map(step => ({
            id: step.id,
            description: step.description,
            required: step.required,
            verificationTool: step.verificationTool,
        })),
    };
}
