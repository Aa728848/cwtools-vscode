import { svgIcon, svgIconNoMargin } from '../svgIcons';
import { escapeHtml } from './formatters';
import { renderMermaidDiagrams } from './mermaidRenderer';

export interface AnnotationLabels {
    title: string;
    hint: string;
    approve: string;
    approved: string;
    submit: string;
    submitted: string;
    addTitle: string;
    placeholder: string;
    confirm: string;
    cancel: string;
    edit: string;
}

export interface AnnotationCardOptions {
    className: string;
    icon: string;
    approveIcon?: string;
    sections: string[];
    labels: AnnotationLabels;
    renderMarkdown: (text: string) => string;
    postMessage: (message: unknown) => void;
    dismissCard: (element: HTMLElement, delay: number, done?: () => void, removeFromDom?: boolean) => void;
    approveMessageType?: string;
    reviseMessageType?: string;
    approvePayload?: Record<string, unknown>;
    revisePayload?: Record<string, unknown>;
    onApprove?: (wrap: HTMLElement) => void;
    disableApproveOnSubmit?: boolean;
}

interface AnnotationEntry {
    sectionIdx: number;
    section: string;
    note: string;
}

export function createAnnotationCard(options: AnnotationCardOptions): HTMLElement {
    let currentOptions = options;
    const annotations: AnnotationEntry[] = [];
    const wrap = document.createElement('div');
    wrap.className = `annotatable-plan ${options.className}`;

    const header = document.createElement('div');
    header.className = 'ap-header';
    header.innerHTML = `
        <span class="ap-header-title">${svgIcon(options.icon as any)}${escapeHtml(options.labels.title)}</span>
        <span class="ap-header-hint">${escapeHtml(options.labels.hint)}</span>
        <div style="display:flex; gap:6px;">
            <button class="ap-approve-btn" style="background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:4px 10px; border-radius:2px; cursor:pointer; min-width:80px;">${svgIcon(options.approveIcon as any || 'check')}${escapeHtml(options.labels.approve)}</button>
            <button class="ap-submit-btn" disabled>${submitLabel(options.labels.submit, 0)}</button>
        </div>`;
    wrap.appendChild(header);

    const submitBtn = header.querySelector('.ap-submit-btn') as HTMLButtonElement;
    const approveBtn = header.querySelector('.ap-approve-btn') as HTMLButtonElement;
    const headerHint = header.querySelector('.ap-header-hint') as HTMLElement | null;
    const isManagerCard = (): boolean => document.body.classList.contains('agent-manager-shell');
    const toggleCompact = (): void => {
        wrap.classList.toggle('ap-compact');
        header.setAttribute('aria-expanded', wrap.classList.contains('ap-compact') ? 'false' : 'true');
    };
    if (isManagerCard()) {
        header.tabIndex = 0;
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', 'true');
    }

    header.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, textarea, input, select, a')) return;
        if (isManagerCard() || wrap.classList.contains('ap-approved')) {
            toggleCompact();
        }
    });
    header.addEventListener('keydown', event => {
        const keyEvent = event as KeyboardEvent;
        if (!isManagerCard() && !wrap.classList.contains('ap-approved')) return;
        if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return;
        keyEvent.preventDefault();
        toggleCompact();
    });

    const updateSubmitBtn = (): void => {
        submitBtn.innerHTML = submitLabel(currentOptions.labels.submit, annotations.length);
        submitBtn.disabled = annotations.length === 0;
    };

    approveBtn.addEventListener('click', () => {
        if (currentOptions.approveMessageType) {
            currentOptions.postMessage({
                ...(currentOptions.approvePayload || {}),
                type: currentOptions.approveMessageType,
                annotations: annotationPayload(annotations),
            });
        }
        currentOptions.onApprove?.(wrap);
        approveBtn.innerHTML = svgIcon('check') + escapeHtml(currentOptions.labels.approved);
        approveBtn.disabled = true;
        submitBtn.disabled = true;
        if (document.body.classList.contains('agent-manager-shell')) {
            wrap.classList.add('ap-approved', 'ap-compact');
            header.tabIndex = 0;
            header.setAttribute('role', 'button');
            header.setAttribute('aria-expanded', 'false');
            if (headerHint) headerHint.textContent = currentOptions.labels.approved;
            return;
        }
        currentOptions.dismissCard(wrap, 400);
    });

    submitBtn.addEventListener('click', () => {
        if (annotations.length === 0 || !currentOptions.reviseMessageType) return;
        currentOptions.postMessage({
            ...(currentOptions.revisePayload || {}),
            type: currentOptions.reviseMessageType,
            annotations: annotationPayload(annotations),
        });
        submitBtn.innerHTML = svgIcon('check') + escapeHtml(currentOptions.labels.submitted);
        submitBtn.disabled = true;
        if (currentOptions.disableApproveOnSubmit) approveBtn.disabled = true;
    });

    const sectionsWrap = document.createElement('div');
    sectionsWrap.className = 'ap-sections';
    const renderSections = (sections: string[], labels: AnnotationLabels, renderMarkdownFn: (text: string) => string): void => {
        sectionsWrap.replaceChildren(...sections.map((section, index) => createAnnotationRow({
            section,
            index,
            annotations,
            labels,
            renderMarkdown: renderMarkdownFn,
            updateSubmitBtn,
        })));
    };
    renderSections(options.sections, options.labels, options.renderMarkdown);
    void renderMermaidDiagrams(wrap);
    wrap.appendChild(sectionsWrap);
    (wrap as HTMLElement & { __cwtoolsUpdateAnnotationCard?: (nextOptions: AnnotationCardOptions) => void }).__cwtoolsUpdateAnnotationCard = (nextOptions: AnnotationCardOptions) => {
        currentOptions = nextOptions;
        annotations.length = 0;
        const titleEl = header.querySelector<HTMLElement>('.ap-header-title');
        if (titleEl) titleEl.innerHTML = `${svgIcon(nextOptions.icon as any)}${escapeHtml(nextOptions.labels.title)}`;
        if (headerHint) headerHint.textContent = nextOptions.labels.hint;
        wrap.className = `annotatable-plan ${nextOptions.className}`;
        approveBtn.innerHTML = svgIcon(nextOptions.approveIcon as any || 'check') + escapeHtml(nextOptions.labels.approve);
        approveBtn.disabled = false;
        submitBtn.innerHTML = submitLabel(nextOptions.labels.submit, 0);
        submitBtn.disabled = true;
        if (isManagerCard()) {
            header.tabIndex = 0;
            header.setAttribute('role', 'button');
            header.setAttribute('aria-expanded', 'true');
        } else {
            header.removeAttribute('tabindex');
            header.removeAttribute('role');
            header.removeAttribute('aria-expanded');
        }
        renderSections(nextOptions.sections, nextOptions.labels, nextOptions.renderMarkdown);
        void renderMermaidDiagrams(wrap);
        updateSubmitBtn();
    };
    return wrap;
}

function createAnnotationRow(options: {
    section: string;
    index: number;
    annotations: AnnotationEntry[];
    labels: AnnotationLabels;
    renderMarkdown: (text: string) => string;
    updateSubmitBtn: () => void;
}): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ap-row';
    row.dataset.idx = String(options.index);

    const textDiv = document.createElement('div');
    textDiv.className = 'ap-section-text markdown-body msg-bubble';
    textDiv.innerHTML = options.renderMarkdown(options.section);

    const addBtn = document.createElement('button');
    addBtn.className = 'ap-add-btn';
    addBtn.title = options.labels.addTitle;
    addBtn.innerHTML = svgIconNoMargin('messageSquare');

    const bubble = document.createElement('div');
    bubble.className = 'ap-bubble';
    bubble.style.display = 'none';

    const inputBox = document.createElement('div');
    inputBox.className = 'ap-input-box';
    inputBox.style.display = 'none';
    inputBox.innerHTML = `
        <textarea class="ap-textarea" rows="3" placeholder="${escapeHtml(options.labels.placeholder)}"></textarea>
        <div class="ap-input-actions">
            <button class="ap-confirm-btn">${escapeHtml(options.labels.confirm)}</button>
            <button class="ap-cancel-btn">${escapeHtml(options.labels.cancel)}</button>
        </div>`;

    const openInput = (): void => {
        const existing = options.annotations.find(a => a.sectionIdx === options.index);
        const textarea = inputBox.querySelector('.ap-textarea') as HTMLTextAreaElement;
        textarea.value = existing ? existing.note : '';
        inputBox.style.display = 'block';
        textarea.focus();
        row.classList.add('ap-row-active');
    };
    const closeInput = (): void => {
        inputBox.style.display = 'none';
        row.classList.remove('ap-row-active');
    };
    const confirmAnnotation = (): void => {
        const value = (inputBox.querySelector('.ap-textarea') as HTMLTextAreaElement).value.trim();
        closeInput();
        if (!value) {
            const existingIndex = options.annotations.findIndex(a => a.sectionIdx === options.index);
            if (existingIndex >= 0) options.annotations.splice(existingIndex, 1);
            bubble.style.display = 'none';
            row.classList.remove('ap-row-annotated');
        } else {
            const existing = options.annotations.find(a => a.sectionIdx === options.index);
            if (existing) existing.note = value;
            else options.annotations.push({ sectionIdx: options.index, section: options.section, note: value });
            bubble.innerHTML = `<span class="ap-bubble-icon">${svgIconNoMargin('messageSquare')}</span><span class="ap-bubble-text">${escapeHtml(value)}</span><button class="ap-bubble-edit">${escapeHtml(options.labels.edit)}</button>`;
            bubble.querySelector('.ap-bubble-edit')!.addEventListener('click', event => {
                event.stopPropagation();
                openInput();
            });
            bubble.style.display = 'flex';
            row.classList.add('ap-row-annotated');
        }
        options.updateSubmitBtn();
    };

    addBtn.addEventListener('click', event => {
        event.stopPropagation();
        openInput();
    });
    row.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, textarea, input, select, a')) return;
        if (inputBox.style.display === 'none') openInput();
    });
    inputBox.querySelector('.ap-confirm-btn')!.addEventListener('click', confirmAnnotation);
    inputBox.querySelector('.ap-cancel-btn')!.addEventListener('click', closeInput);
    inputBox.querySelector('.ap-textarea')!.addEventListener('keydown', event => {
        const keyEvent = event as KeyboardEvent;
        if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.metaKey)) confirmAnnotation();
        if (keyEvent.key === 'Escape') closeInput();
    });
    inputBox.addEventListener('click', event => event.stopPropagation());

    row.appendChild(textDiv);
    row.appendChild(addBtn);
    row.appendChild(bubble);
    row.appendChild(inputBox);
    return row;
}

function submitLabel(label: string, count: number): string {
    return `${svgIconNoMargin('upload')} ${escapeHtml(label)} (${count})`;
}

function annotationPayload(annotations: AnnotationEntry[]): Array<{ section: string; note: string }> {
    return annotations.map(annotation => ({ section: annotation.section, note: annotation.note }));
}
