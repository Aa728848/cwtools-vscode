import type { ChatModeMeta } from './i18n';

export const MODE_BODY_CLASSES = [
    'build-mode',
    'plan-mode',
    'explore-mode',
    'general-mode',
    'utility-mode',
    'review-mode',
    'orchestrator-mode',
] as const;

export function normalizeMode(mode: string): string {
    return mode === 'general' ? 'utility' : mode;
}

export function applyModeUi(
    mode: string,
    modeMeta: Record<string, ChatModeMeta>,
    body: HTMLElement,
    selector: HTMLSelectElement | null,
    indicator: HTMLElement | null
): string {
    const normalized = normalizeMode(mode);
    if (selector && selector.value !== normalized) {
        selector.value = normalized;
    }
    body.classList.remove(...MODE_BODY_CLASSES);

    const meta = modeMeta[normalized];
    if (meta?.bodyClass) {
        body.classList.add(meta.bodyClass);
    }
    if (indicator) {
        indicator.textContent = meta?.label ?? '';
    }
    return normalized;
}
