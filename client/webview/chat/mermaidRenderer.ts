const MAX_MERMAID_SOURCE_LENGTH = 20_000;
const MERMAID_FLOWCHART_WRAP_WIDTH = 180;
const MIN_MERMAID_NATURAL_WIDTH = 180;
let diagramCounter = 0;
let renderQueue = Promise.resolve();

interface MermaidRuntime {
    initialize(config: Record<string, unknown>): void;
    render(id: string, source: string): Promise<{ svg: string }>;
}

function getMermaidRuntime(): MermaidRuntime {
    const runtime = (globalThis as typeof globalThis & { mermaid?: MermaidRuntime }).mermaid;
    if (!runtime) throw new Error('The bundled Mermaid runtime is unavailable.');
    return runtime;
}

function labels(): {
    diagram: string;
    copy: string;
    copied: string;
    expand: string;
    close: string;
    error: string;
} {
    const isZh = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh');
    return isZh
        ? { diagram: '流程图', copy: '复制源码', copied: '已复制', expand: '全屏查看', close: '关闭', error: '流程图渲染失败，已保留 Mermaid 源码。' }
        : { diagram: 'Diagram', copy: 'Copy source', copied: 'Copied', expand: 'Expand', close: 'Close', error: 'Diagram rendering failed; the Mermaid source is preserved.' };
}

function themeValue(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function initializeMermaid(): void {
    const background = themeValue('--vscode-editor-background', '#1e1e1e');
    const foreground = themeValue('--vscode-editor-foreground', '#d4d4d4');
    const mutedForeground = themeValue('--vscode-descriptionForeground', '#9d9d9d');
    const widgetBackground = themeValue('--vscode-editorWidget-background', '#252526');
    const inputBackground = themeValue('--vscode-input-background', '#313131');
    const panelBorder = themeValue('--vscode-panel-border', '#454545');
    const fontFamily = themeValue('--vscode-font-family', 'system-ui, sans-serif');

    getMermaidRuntime().initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        htmlLabels: false,
        flowchart: {
            htmlLabels: false,
            useMaxWidth: true,
            curve: 'basis',
            diagramPadding: 6,
            nodeSpacing: 36,
            rankSpacing: 42,
            padding: 10,
            wrappingWidth: MERMAID_FLOWCHART_WRAP_WIDTH,
        },
        themeVariables: {
            background,
            primaryColor: widgetBackground,
            primaryTextColor: foreground,
            primaryBorderColor: panelBorder,
            secondaryColor: inputBackground,
            secondaryTextColor: foreground,
            secondaryBorderColor: panelBorder,
            tertiaryColor: background,
            tertiaryTextColor: foreground,
            tertiaryBorderColor: panelBorder,
            textColor: foreground,
            lineColor: mutedForeground,
            defaultLinkColor: mutedForeground,
            arrowheadColor: mutedForeground,
            mainBkg: widgetBackground,
            nodeBkg: widgetBackground,
            nodeBorder: panelBorder,
            nodeTextColor: foreground,
            clusterBkg: background,
            clusterBorder: panelBorder,
            edgeLabelBackground: background,
            titleColor: foreground,
            noteBkgColor: inputBackground,
            noteTextColor: foreground,
            noteBorderColor: panelBorder,
            actorBkg: widgetBackground,
            actorTextColor: foreground,
            actorBorder: panelBorder,
            labelBoxBkgColor: inputBackground,
            labelBoxBorderColor: panelBorder,
            labelTextColor: foreground,
            signalColor: foreground,
            signalTextColor: foreground,
            fontFamily,
            fontSize: '13px',
        },
    });
}

function preserveNaturalDiagramSize(output: HTMLElement): void {
    const svg = output.querySelector<SVGSVGElement>('svg');
    const viewBox = svg?.viewBox.baseVal;
    if (!svg || !viewBox || !Number.isFinite(viewBox.width) || viewBox.width <= 0) return;
    const naturalWidth = Math.max(MIN_MERMAID_NATURAL_WIDTH, Math.ceil(viewBox.width));
    svg.style.setProperty('--mermaid-natural-width', `${naturalWidth}px`);
}

function sanitizeSvg(svgText: string): string {
    const template = document.createElement('template');
    template.innerHTML = svgText;
    template.content.querySelectorAll('script, foreignObject, iframe, object, embed').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
        for (const attribute of Array.from(node.attributes)) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            if (name.startsWith('on')) {
                node.removeAttribute(attribute.name);
            } else if ((name === 'href' || name === 'xlink:href') && value && !value.startsWith('#')) {
                node.removeAttribute(attribute.name);
            }
        }
    });
    return template.innerHTML;
}

function createToolbar(container: HTMLElement, source: string): void {
    const text = labels();
    const toolbar = document.createElement('div');
    toolbar.className = 'md-mermaid-toolbar';

    const title = document.createElement('span');
    title.className = 'md-mermaid-title';
    title.textContent = text.diagram;

    const actions = document.createElement('span');
    actions.className = 'md-mermaid-actions';

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'md-mermaid-action md-mermaid-expand';
    expand.textContent = '⛶';
    expand.setAttribute('aria-label', text.expand);
    expand.title = text.expand;
    expand.addEventListener('click', () => openFullscreen(container));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'md-mermaid-action md-mermaid-copy';
    copy.textContent = '⧉';
    copy.setAttribute('aria-label', text.copy);
    copy.title = text.copy;
    copy.addEventListener('click', () => {
        navigator.clipboard.writeText(source).then(() => {
            copy.classList.add('copied');
            copy.title = text.copied;
            setTimeout(() => {
                copy.classList.remove('copied');
                copy.title = text.copy;
            }, 1500);
        }).catch(() => undefined);
    });

    actions.append(expand, copy);
    toolbar.append(title, actions);
    container.prepend(toolbar);
}

function openFullscreen(container: HTMLElement): void {
    const output = container.querySelector<HTMLElement>('.md-mermaid-output');
    const svg = output?.querySelector('svg');
    if (!svg) return;
    const text = labels();
    const overlay = document.createElement('div');
    overlay.className = 'md-mermaid-fullscreen';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', text.diagram);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'md-mermaid-fullscreen-close';
    close.textContent = '×';
    close.title = text.close;
    close.setAttribute('aria-label', text.close);
    const dismiss = (): void => overlay.remove();
    close.addEventListener('click', dismiss);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) dismiss();
    });
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') dismiss();
    });

    const viewport = document.createElement('div');
    viewport.className = 'md-mermaid-fullscreen-viewport';
    viewport.append(svg.cloneNode(true));
    overlay.append(close, viewport);
    document.body.append(overlay);
    overlay.tabIndex = -1;
    overlay.focus();
}

export function sanitizeMermaidSource(source: string): string {
    // Models often wrap label identifiers in Markdown backticks, which the
    // Mermaid lexer rejects. Backticks are never valid Mermaid syntax.
    return source.replace(/`/g, '');
}

async function renderContainer(container: HTMLElement): Promise<void> {
    if (container.dataset.mermaidState !== 'pending') return;
    container.dataset.mermaidState = 'rendering';
    const source = sanitizeMermaidSource(container.querySelector<HTMLElement>('.md-mermaid-source code')?.textContent?.trim() ?? '');
    const output = container.querySelector<HTMLElement>('.md-mermaid-output');
    const loading = container.querySelector<HTMLElement>('.md-mermaid-loading');
    const id = `cwtools-mermaid-${Date.now()}-${diagramCounter++}`;
    if (!source || !output) {
        container.dataset.mermaidState = 'error';
        return;
    }

    try {
        if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
            throw new Error(`Mermaid source exceeds ${MAX_MERMAID_SOURCE_LENGTH} characters.`);
        }
        // Mermaid init/config directives can override global settings. The chat
        // renderer owns configuration so model-authored diagrams cannot weaken it.
        if (/%%\{\s*(?:init|config)\s*:/i.test(source)) {
            throw new Error('Per-diagram Mermaid configuration directives are disabled.');
        }
        initializeMermaid();
        const rendered = await getMermaidRuntime().render(id, source);
        output.innerHTML = sanitizeSvg(rendered.svg);
        preserveNaturalDiagramSize(output);
        loading?.remove();
        createToolbar(container, source);
        container.dataset.mermaidState = 'rendered';
    } catch (error) {
        // Mermaid creates a temporary error diagram beside the requested target
        // before rejecting. Keep failures local to this card.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        loading?.remove();
        container.dataset.mermaidState = 'error';
        const message = document.createElement('div');
        message.className = 'md-mermaid-error';
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        message.textContent = `${labels().error} ${detail}`;
        container.prepend(message);
    }
}

export function renderMermaidDiagrams(root: ParentNode = document): Promise<void> {
    const containers = Array.from(root.querySelectorAll<HTMLElement>('.md-mermaid[data-mermaid-state="pending"]'));
    renderQueue = renderQueue.then(async () => {
        for (const container of containers) await renderContainer(container);
    });
    return renderQueue;
}

export function startMermaidRendering(root: HTMLElement): () => void {
    void renderMermaidDiagrams(root);
    const observer = new MutationObserver(mutations => {
        if (mutations.some(mutation => mutation.addedNodes.length > 0)) {
            void renderMermaidDiagrams(root);
        }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
}
