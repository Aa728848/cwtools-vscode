/**
 * Agent Manager Embedded `.gui` Preview Pane (Browser-Sandboxed Webview).
 *
 * Renders the toolbar, read-only `GuiCanvasView`, selection summary, and
 * before/after/diff visual verification evidence drawer; communicates with
 * `ai/managerGuiPreview.ts` exclusively via `postMessage`.
 */

import type { GuiPreviewSnapshot, GuiSelection } from '../shared/guiPreview';
import type { GuiVisualCaptureRequestMessage, GuiVisualCaptureResponseMessage, GuiVisualEvidence } from '../shared/guiVisualVerification';
import { GuiCanvasView } from './guiCanvas';

interface VsCodeBridge { postMessage(message: unknown): void }

/** Owns the manager preview toolbar and a canvas that survives inspector tab switches. */
export class ManagerGuiPreviewPane {
    readonly element: HTMLElement;
    private readonly canvas: GuiCanvasView;
    private readonly fileButton: HTMLButtonElement;
    private readonly pinButton: HTMLButtonElement;
    private readonly marqueeButton: HTMLButtonElement;
    private readonly addButton: HTMLButtonElement;
    private readonly sourceButton: HTMLButtonElement;
    private readonly summary: HTMLElement;
    private readonly status: HTMLElement;
    private readonly evidencePanel: HTMLDetailsElement;
    private readonly evidenceSummary: HTMLElement;
    private readonly evidenceImage: HTMLImageElement;
    private evidence?: GuiVisualEvidence;
    private evidenceMode: 'before' | 'after' | 'diff' = 'after';
    private snapshot: GuiPreviewSnapshot = { status: 'empty', elements: [], pinned: false };
    private selection: GuiSelection = { elements: [] };
    private readonly zh: boolean;
    private visibleFile?: string;

    constructor(private readonly vscode: VsCodeBridge) {
        this.zh = (document.documentElement.lang || navigator.language).toLowerCase().startsWith('zh');
        this.element = document.createElement('section');
        this.element.className = 'manager-gui-preview-pane';
        this.element.hidden = true;
        this.element.setAttribute('aria-label', this.tr('GUI development preview', 'GUI 开发预览'));
        const toolbar = document.createElement('div');
        toolbar.className = 'manager-gui-preview-toolbar';
        this.fileButton = this.button(this.tr('Choose GUI file', '选择 GUI 文件'), () => this.request('chooseFile'), 'manager-gui-file-button');
        this.pinButton = this.button(this.tr('Pin file', '固定文件'), () => this.request('togglePin'));
        const refresh = this.button(this.tr('Refresh', '刷新'), () => this.request('refresh'));
        const fit = this.button(this.tr('Fit', '适应'), () => this.canvas.fit());
        const actual = this.button('1:1', () => this.canvas.actualSize());
        this.marqueeButton = this.button(this.tr('Select region', '框选'), () => this.toggleMarquee());
        const full = this.button(this.tr('Open workbench', '完整工作台'), () => this.request('openFull'));
        toolbar.append(this.fileButton, this.pinButton, refresh, fit, actual, this.marqueeButton, full);
        this.status = document.createElement('div');
        this.status.className = 'manager-gui-preview-status';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'manager-gui-preview-canvas-host';
        this.canvas = new GuiCanvasView(canvasHost, {
            onSelection: selection => {
                this.selection = selection;
                this.updateSummary();
                if (this.snapshot.file) this.request('select', { selection });
            },
            onOpenSource: line => this.request('openSource', { line }),
        });
        this.evidencePanel = document.createElement('details');
        this.evidencePanel.className = 'manager-gui-visual-evidence';
        this.evidencePanel.hidden = true;
        this.evidenceSummary = document.createElement('summary');
        this.evidenceSummary.textContent = this.tr('Visual verification', '视觉验证');
        const evidenceBody = document.createElement('div');
        evidenceBody.className = 'manager-gui-visual-evidence-body';
        const evidenceTabs = document.createElement('div');
        evidenceTabs.className = 'manager-gui-visual-evidence-tabs';
        for (const [mode, label] of [['before', 'Before'], ['after', 'After'], ['diff', 'Diff']] as const) {
            const button = this.button(label, () => this.setEvidenceMode(mode));
            button.dataset.evidenceMode = mode;
            evidenceTabs.append(button);
        }
        this.evidenceImage = document.createElement('img');
        this.evidenceImage.className = 'manager-gui-visual-evidence-image';
        this.evidenceImage.alt = this.tr('GUI visual verification evidence', 'GUI 视觉验证证据');
        evidenceBody.append(evidenceTabs, this.evidenceImage);
        this.evidencePanel.append(this.evidenceSummary, evidenceBody);
        const footer = document.createElement('div');
        footer.className = 'manager-gui-preview-footer';
        this.summary = document.createElement('span');
        this.summary.className = 'manager-gui-selection-summary';
        this.addButton = this.button(this.tr('Add to conversation', '添加到对话'), () => this.request('addToChat', { selection: this.selection }));
        this.sourceButton = this.button(this.tr('Open source', '打开源码'), () => {
            const line = this.selection.elements[0]?.line;
            if (line) this.request('openSource', { line });
        });
        footer.append(this.summary, this.sourceButton, this.addButton);
        this.element.append(toolbar, this.status, canvasHost, this.evidencePanel, footer);
        this.updateSummary();
    }

    async captureVisual(request: GuiVisualCaptureRequestMessage): Promise<GuiVisualCaptureResponseMessage> {
        return this.canvas.captureVisual(request);
    }

    applyVisualEvidence(evidence: GuiVisualEvidence): void {
        this.evidence = evidence;
        this.evidenceMode = evidence.before ? 'diff' : 'after';
        this.evidencePanel.hidden = false;
        const ratio = evidence.metrics ? this.tr(`${(evidence.metrics.changeRatio * 100).toFixed(3)}% changed`, `变化 ${(evidence.metrics.changeRatio * 100).toFixed(3)}%`) : this.tr('after only', '仅修改后');
        this.evidenceSummary.textContent = this.tr(
            `Visual verification · round ${evidence.round}/2 · ${ratio}`,
            `视觉验证 · 第 ${evidence.round}/2 轮 · ${ratio}`,
        );
        this.setEvidenceMode(this.evidenceMode);
    }

    private setEvidenceMode(mode: 'before' | 'after' | 'diff'): void {
        if (!this.evidence) return;
        this.evidenceMode = mode;
        const source = mode === 'before' ? this.evidence.before : mode === 'after' ? this.evidence.after : this.evidence.diff;
        this.evidenceImage.src = source ?? this.evidence.after;
        for (const button of Array.from(this.evidencePanel.querySelectorAll<HTMLButtonElement>('[data-evidence-mode]'))) {
            const buttonMode = button.dataset.evidenceMode;
            button.classList.toggle('active', buttonMode === mode);
            button.disabled = buttonMode !== 'after' && !source;
        }
    }

    setVisible(visible: boolean): void {
        this.element.hidden = !visible;
        const file = this.snapshot.file;
        if (visible && this.snapshot.status === 'ready' && file && this.visibleFile !== file) {
            this.visibleFile = file;
            requestAnimationFrame(() => this.canvas.fit());
        }
    }

    applySnapshot(snapshot: GuiPreviewSnapshot): void {
        this.snapshot = snapshot;
        this.selection = snapshot.selection ?? { elements: [] };
        this.fileButton.textContent = snapshot.fileName || this.tr('Choose GUI file', '选择 GUI 文件');
        this.fileButton.title = snapshot.file || this.fileButton.textContent;
        this.pinButton.classList.toggle('active', snapshot.pinned === true);
        this.pinButton.textContent = snapshot.pinned ? this.tr('Pinned', '已固定') : this.tr('Pin file', '固定文件');
        const dirty = snapshot.dirty ? this.tr(' · unsaved; save before Agent writes', ' · 未保存，Agent 写入前需先保存') : '';
        this.status.textContent = (snapshot.message || (snapshot.status === 'ready' ? this.tr('Click or marquee elements to add context', '点击或框选元素以添加对话上下文') : this.tr('Open a .gui file to start previewing', '打开 .gui 文件以开始预览'))) + dirty;
        this.status.dataset.state = snapshot.status;
        this.canvas.applySnapshot(snapshot);
        if (!this.element.hidden) this.setVisible(true);
        this.updateSummary();
    }

    private updateSummary(): void {
        const count = this.selection.elements.length;
        this.summary.textContent = count
            ? this.tr(`${count} element(s) selected`, `已选择 ${count} 个元素`)
            : this.tr('No element selected', '未选择元素');
        this.addButton.disabled = !count || this.snapshot.status !== 'ready';
        this.sourceButton.disabled = count !== 1;
    }

    private toggleMarquee(): void {
        const enabled = !this.marqueeButton.classList.contains('active');
        this.marqueeButton.classList.toggle('active', enabled);
        this.marqueeButton.setAttribute('aria-pressed', String(enabled));
        this.canvas.setMarqueeMode(enabled);
    }

    private request(action: string, extra: Record<string, unknown> = {}): void {
        this.vscode.postMessage({ type: 'guiPreviewRequest', action, ...extra });
    }

    private button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `manager-gui-preview-button ${className}`.trim();
        button.textContent = label;
        button.title = label;
        button.addEventListener('click', onClick);
        return button;
    }

    private tr(en: string, zh: string): string { return this.zh ? zh : en; }
}
