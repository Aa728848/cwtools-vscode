export interface MessageSelectionActionLabels {
    addToTask: string;
    addToTaskHint: string;
}

export interface MessageSelectionActionOptions {
    root: HTMLElement;
    labels: MessageSelectionActionLabels;
    onAddToTask(text: string): void;
}

function elementForNode(node: Node): Element | null {
    return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function selectedMessageText(root: HTMLElement): { text: string; rect: DOMRect } | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const start = elementForNode(range.startContainer);
    const end = elementForNode(range.endContainer);
    if (!start || !end || !root.contains(start) || !root.contains(end)) return null;

    const startMessage = start.closest('.message');
    const endMessage = end.closest('.message');
    if (!startMessage || startMessage !== endMessage || !root.contains(startMessage)) return null;
    if (start.closest('button, textarea, input, select, [contenteditable="true"]')
        || end.closest('button, textarea, input, select, [contenteditable="true"]')) return null;

    const text = selection.toString().replace(/\r\n?/g, '\n').trim();
    if (!text) return null;

    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 || rect.height > 0);
    const rect = rects.at(-1) ?? range.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return null;
    return { text, rect };
}

export function formatSelectionForTask(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .trim()
        .split('\n')
        .map(line => line ? `> ${line}` : '>')
        .join('\n');
}

export function startMessageSelectionActions(options: MessageSelectionActionOptions): () => void {
    const toolbar = document.createElement('div');
    toolbar.className = 'message-selection-toolbar';
    toolbar.hidden = true;
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', options.labels.addToTaskHint);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'message-selection-add';
    addButton.textContent = options.labels.addToTask;
    addButton.title = options.labels.addToTaskHint;
    toolbar.appendChild(addButton);
    document.body.appendChild(toolbar);

    let selectedText = '';
    let scheduledFrame = 0;
    let selectingWithPointer = false;

    const hide = (): void => {
        selectedText = '';
        toolbar.hidden = true;
    };

    const update = (): void => {
        scheduledFrame = 0;
        const selected = selectedMessageText(options.root);
        if (!selected) {
            hide();
            return;
        }

        selectedText = selected.text;
        toolbar.hidden = false;
        const margin = 8;
        const width = toolbar.offsetWidth;
        const height = toolbar.offsetHeight;
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const left = Math.min(
            maxLeft,
            Math.max(margin, selected.rect.left + (selected.rect.width - width) / 2),
        );
        const maxTop = Math.max(margin, window.innerHeight - height - margin);
        const above = selected.rect.top - height - margin;
        const top = above >= margin
            ? Math.min(maxTop, above)
            : Math.min(maxTop, selected.rect.bottom + margin);
        toolbar.style.left = `${Math.round(left)}px`;
        toolbar.style.top = `${Math.round(top)}px`;
    };

    const scheduleUpdate = (): void => {
        if (selectingWithPointer) return;
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = requestAnimationFrame(update);
    };

    const onDocumentPointerDown = (event: PointerEvent): void => {
        const target = event.target as Node;
        if (toolbar.contains(target)) return;
        selectingWithPointer = options.root.contains(target);
        hide();
    };
    const onDocumentPointerUp = (): void => {
        if (!selectingWithPointer) return;
        selectingWithPointer = false;
        scheduleUpdate();
    };
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') hide();
    };
    const onViewportChange = (): void => hide();

    addButton.addEventListener('pointerdown', event => event.preventDefault());
    addButton.addEventListener('click', () => {
        const text = selectedText;
        if (!text) return;
        options.onAddToTask(text);
        window.getSelection()?.removeAllRanges();
        hide();
    });
    document.addEventListener('selectionchange', scheduleUpdate);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('pointerup', onDocumentPointerUp, true);
    document.addEventListener('pointercancel', onDocumentPointerUp, true);
    document.addEventListener('keydown', onDocumentKeyDown);
    options.root.addEventListener('keyup', scheduleUpdate);
    options.root.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);

    return () => {
        cancelAnimationFrame(scheduledFrame);
        document.removeEventListener('selectionchange', scheduleUpdate);
        document.removeEventListener('pointerdown', onDocumentPointerDown, true);
        document.removeEventListener('pointerup', onDocumentPointerUp, true);
        document.removeEventListener('pointercancel', onDocumentPointerUp, true);
        document.removeEventListener('keydown', onDocumentKeyDown);
        options.root.removeEventListener('keyup', scheduleUpdate);
        options.root.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
        toolbar.remove();
    };
}
