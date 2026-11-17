import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GuiPreviewLoader } from '../guiPreviewLoader';
import { GuiPanel } from '../guiPanel';
import {
    createGuiElementReference,
    flattenGuiElements,
    resolveGuiElementReference,
    type GuiElement,
    type GuiPreviewSnapshot,
    type GuiSelection,
    type GuiSelectionContextData,
} from '../../shared/guiPreview';
import type { GuiPreviewRequestMessage, GuiVisualCaptureResponseMessage } from './types';
import { getPrivateTopicStorageDir, resolveProjectWorkspacePath } from './workspacePaths';
import {
    GUI_VISUAL_MAX_REVIEW_ROUNDS,
    GUI_VISUAL_WIDTH,
    GUI_VISUAL_HEIGHT,
    isGuiVisualEvidence,
    type GuiVisualCapture,
    type GuiVisualCaptureRequestMessage,
    type GuiVisualEvidence,
} from '../../shared/guiVisualVerification';
import { ErrorReporter } from './errorReporter';
import { aiText, SOURCE } from './messages';

function normalizePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fingerprint(element: GuiElement): string {
    return JSON.stringify({
        type: element.type,
        name: element.name,
        position: element.position,
        size: element.size,
        properties: element.properties,
        line: element.line,
        endLine: element.endLine,
    });
}

interface VisualRunState {
    runId: string;
    file: string;
    topicId: string;
    baseline?: GuiVisualCapture;
    baselinePromise?: Promise<void>;
    reviews: number;
    writeTimer?: ReturnType<typeof setTimeout>;
    inFlight: boolean;
    queued: boolean;
    closed: boolean;
}

interface PendingVisualCapture {
    resolve: (message: GuiVisualCaptureResponseMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Owns manager preview state; all filesystem and VS Code operations stay in the host. */
export class ManagerGuiPreviewController {
    private readonly loader = new GuiPreviewLoader();
    private readonly disposables: vs.Disposable[] = [];
    private webview?: vs.Webview;
    private currentFile?: string;
    private currentDocument?: vs.TextDocument;
    private loadedFile?: string;
    private currentElements: GuiElement[] = [];
    private currentSnapshot: GuiPreviewSnapshot = { status: 'empty', elements: [], pinned: false };
    private selection: GuiSelection = { elements: [] };
    private pinned = false;
    private revision = 0;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private readonly visualRuns = new Map<string, VisualRunState>();
    private readonly pendingVisualCaptures = new Map<string, PendingVisualCapture>();
    private latestVisualEvidence?: GuiVisualEvidence;
    private currentTopicId = 'default';

    constructor(
        private readonly extensionPath: string,
        private readonly postSnapshot: (snapshot: GuiPreviewSnapshot) => void,
        private readonly addContext: (context: GuiSelectionContextData) => void,
        private readonly postVisualEvidence: (evidence: GuiVisualEvidence) => void,
        private readonly injectVisualEvidence: (runId: string, evidence: GuiVisualEvidence) => void,
        private readonly injectVisualFailure: (runId: string, error: unknown) => void,
    ) {
        this.disposables.push(
            vs.window.onDidChangeActiveTextEditor(editor => {
                if (this.webview && !this.pinned && editor?.document.languageId !== undefined) {
                    void this.followDocument(editor.document);
                }
            }),
            vs.workspace.onDidChangeTextDocument(event => {
                if (!this.isCurrentFile(event.document.uri.fsPath)) return;
                this.scheduleRefresh(false, 250);
            }),
            vs.workspace.onDidSaveTextDocument(document => {
                if (this.isCurrentFile(document.uri.fsPath)) this.scheduleRefresh(false, 50);
            }),
        );
    }

    public async attach(webview: vs.Webview, topicId = 'default'): Promise<void> {
        this.webview = webview;
        const topicChanged = this.currentTopicId !== topicId;
        this.currentTopicId = topicId;
        if (topicChanged) this.latestVisualEvidence = undefined;
        await this.restoreStoredVisualEvidence();
        if (this.currentFile) {
            await this.loadCurrent(false);
            return;
        }
        const active = vs.window.activeTextEditor?.document;
        if (active && this.isGuiDocument(active)) {
            this.currentFile = active.uri.fsPath;
            await this.loadCurrent(false);
            return;
        }
        this.emit({ status: 'empty', elements: [], pinned: this.pinned });
    }

    public detach(): void {
        this.webview = undefined;
    }

    public async followDocument(document: vs.TextDocument): Promise<void> {
        if (!this.webview || this.pinned || !this.isGuiDocument(document)) return;
        if (this.currentFile && normalizePath(this.currentFile) === normalizePath(document.uri.fsPath)) return;
        this.currentFile = document.uri.fsPath;
        this.selection = { elements: [] };
        await this.loadCurrent(false);
    }

    public async prepareVisualReview(runId: string, filePath?: string, topicId = 'default'): Promise<void> {
        const target = filePath ? this.resolveGuiPath(filePath) : this.currentFile;
        if (!target || this.visualRuns.has(runId)) return;
        const state: VisualRunState = {
            runId,
            file: target,
            topicId,
            reviews: 0,
            inFlight: false,
            queued: false,
            closed: false,
        };
        this.visualRuns.set(runId, state);
        while (this.visualRuns.size > 8) {
            const oldest = this.visualRuns.keys().next().value as string | undefined;
            if (!oldest || oldest === runId) break;
            this.finishRun(oldest);
        }
        this.currentTopicId = topicId;
        if (!this.webview) return;
        if (!this.currentFile || normalizePath(this.currentFile) !== normalizePath(target)) {
            this.currentFile = target;
            this.selection = { elements: [] };
        }
        await this.loadCurrent(false);
        state.baselinePromise = this.requestVisualCapture(runId, target, 0).then(response => {
            if (!state.closed && response.capture) state.baseline = response.capture;
        }).catch(error => {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, `GUI visual baseline unavailable for ${runId}`, error);
        });
        await state.baselinePromise;
    }

    public notifyAgentWrite(runId: string, filePath: string): void {
        if (!filePath.toLowerCase().endsWith('.gui')) return;
        this.scheduleRefresh(true, 180, filePath);
        const state = this.visualRuns.get(runId);
        if (!state || state.closed || state.reviews >= GUI_VISUAL_MAX_REVIEW_ROUNDS
            || normalizePath(state.file) !== normalizePath(filePath)) return;
        if (state.writeTimer) clearTimeout(state.writeTimer);
        state.writeTimer = setTimeout(() => {
            state.writeTimer = undefined;
            void this.performVisualReview(state);
        }, 450);
    }

    public finishRun(runId: string): void {
        const state = this.visualRuns.get(runId);
        if (!state) return;
        state.closed = true;
        if (state.writeTimer) clearTimeout(state.writeTimer);
        state.writeTimer = undefined;
        this.visualRuns.delete(runId);
    }

    public handleVisualCaptureResponse(message: GuiVisualCaptureResponseMessage): void {
        const pending = this.pendingVisualCaptures.get(message.requestId);
        if (!pending) return;
        this.pendingVisualCaptures.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message);
    }

    private async performVisualReview(state: VisualRunState): Promise<void> {
        if (state.inFlight) {
            state.queued = true;
            return;
        }
        state.inFlight = true;
        try {
            do {
                state.queued = false;
                if (state.closed || state.reviews >= GUI_VISUAL_MAX_REVIEW_ROUNDS) break;
                await state.baselinePromise;
                await this.loadCurrent(true);
                if (state.closed || !this.currentFile || normalizePath(this.currentFile) !== normalizePath(state.file)) break;
                const round = state.reviews + 1;
                const response = await this.requestVisualCapture(state.runId, state.file, round, state.baseline);
                if (state.closed || !response.evidence) continue;
                state.reviews = round;
                state.baseline = {
                    dataUrl: response.evidence.after,
                    width: GUI_VISUAL_WIDTH,
                    height: GUI_VISUAL_HEIGHT,
                    frame: response.evidence.frame,
                };
                this.latestVisualEvidence = response.evidence;
                this.currentTopicId = state.topicId;
                try {
                    await this.postVisualArtifacts(response.evidence);
                } catch (error) {
                    ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Unable to persist GUI visual evidence; using in-memory images.', error);
                    this.postVisualEvidence(response.evidence);
                }
                this.injectVisualEvidence(state.runId, response.evidence);
            } while (state.queued && !state.closed && state.reviews < GUI_VISUAL_MAX_REVIEW_ROUNDS);
        } catch (error) {
            if (!state.closed) {
                ErrorReporter.warn(SOURCE.CHAT_PANEL, `GUI visual review failed for ${state.runId}`, error);
                this.injectVisualFailure(state.runId, error);
            }
        } finally {
            state.inFlight = false;
        }
    }

    private requestVisualCapture(
        runId: string,
        file: string,
        round: number,
        before?: GuiVisualCapture,
    ): Promise<GuiVisualCaptureResponseMessage> {
        const webview = this.webview;
        if (!webview) return Promise.reject(new Error('The Agent Manager preview is not open.'));
        const requestId = `visual_${runId}_${round}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const message: GuiVisualCaptureRequestMessage = {
            type: 'guiVisualCaptureRequest',
            requestId,
            runId,
            file: vs.workspace.asRelativePath(file).replace(/\\/g, '/'),
            round,
            ...(before ? { before } : {}),
        };
        return new Promise<GuiVisualCaptureResponseMessage>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingVisualCaptures.delete(requestId);
                reject(new Error('GUI visual capture timed out.'));
            }, 5000);
            this.pendingVisualCaptures.set(requestId, { resolve, reject, timer });
            void webview.postMessage(message);
        });
    }

    public async handleRequest(message: GuiPreviewRequestMessage, webview: vs.Webview): Promise<void> {
        this.webview = webview;
        switch (message.action) {
            case 'open':
                if (message.file) {
                    const resolved = this.resolveGuiPath(message.file);
                    if (!resolved) return this.warnInvalidFile(message.file);
                    this.currentFile = resolved;
                    this.selection = { elements: [] };
                } else if (!this.currentFile) {
                    const active = vs.window.activeTextEditor?.document;
                    if (active && this.isGuiDocument(active)) this.currentFile = active.uri.fsPath;
                }
                await this.loadCurrent(false);
                break;
            case 'chooseFile':
                await this.chooseFile();
                break;
            case 'refresh':
                await this.loadCurrent(false);
                break;
            case 'togglePin':
                this.pinned = !this.pinned;
                this.emit({ ...this.currentSnapshot, pinned: this.pinned });
                break;
            case 'openFull':
                await this.openFullWorkbench();
                break;
            case 'openSource':
                await this.openSource(message.line);
                break;
            case 'select':
                if (message.selection) this.updateSelection(message.selection);
                break;
            case 'addToChat':
                if (message.selection) this.updateSelection(message.selection);
                this.createSelectionContext();
                break;
        }
    }

    public dispose(): void {
        this.revision++;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        for (const state of this.visualRuns.values()) {
            state.closed = true;
            if (state.writeTimer) clearTimeout(state.writeTimer);
        }
        this.visualRuns.clear();
        for (const pending of this.pendingVisualCaptures.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('GUI preview controller disposed.'));
        }
        this.pendingVisualCaptures.clear();
        this.disposables.forEach(item => item.dispose());
        this.loader.dispose();
        this.webview = undefined;
        this.currentDocument = undefined;
        this.currentElements = [];
    }

    private async chooseFile(): Promise<void> {
        const files = await vs.workspace.findFiles('**/*.gui', '**/{node_modules,.git,release}/**', 200);
        files.sort((left, right) => left.fsPath.localeCompare(right.fsPath));
        if (!files.length) {
            void vs.window.showInformationMessage(aiText('No .gui files were found in this workspace.', '当前工作区未找到 .gui 文件。'));
            return;
        }
        const items = files.map(uri => ({
            label: path.basename(uri.fsPath),
            description: vs.workspace.asRelativePath(uri),
            file: uri.fsPath,
        }));
        const picked = await vs.window.showQuickPick(items, {
            title: aiText('Select a GUI file to preview', '选择要预览的 GUI 文件'),
            matchOnDescription: true,
        });
        if (!picked) return;
        this.currentFile = picked.file;
        this.selection = { elements: [] };
        await this.loadCurrent(false);
    }

    private async openFullWorkbench(): Promise<void> {
        const document = await this.requireCurrentDocument();
        if (document) await GuiPanel.create(this.extensionPath, document);
    }

    private async openSource(line: number | undefined): Promise<void> {
        const document = await this.requireCurrentDocument();
        if (!document || !line || !Number.isInteger(line) || line < 1 || line > document.lineCount) {
            void vs.window.showWarningMessage(aiText('The selected source line is no longer valid.', '所选源码行已失效，请刷新预览后重试。'));
            return;
        }
        const editor = await vs.window.showTextDocument(document, { preview: true });
        const range = new vs.Range(line - 1, 0, line - 1, 0);
        editor.selection = new vs.Selection(range.start, range.start);
        editor.revealRange(range, vs.TextEditorRevealType.InCenter);
    }

    private createSelectionContext(): void {
        if (!this.currentFile || !this.currentDocument || !this.selection.elements.length) {
            void vs.window.showInformationMessage(aiText('Select at least one GUI element first.', '请先选择至少一个 GUI 元素。'));
            return;
        }
        const resolved = this.resolveSelection(this.selection);
        if (resolved.elements.length !== this.selection.elements.length) {
            void vs.window.showWarningMessage(aiText(
                'The GUI selection is stale or ambiguous. Refresh and select the elements again.',
                'GUI 选区已失效或无法唯一定位，请刷新后重新选择元素。',
            ));
            void this.loadCurrent(false);
            return;
        }
        this.selection = resolved;
        const file = vs.workspace.asRelativePath(this.currentFile).replace(/\\/g, '/');
        this.addContext({
            uri: file,
            documentVersion: this.currentDocument.version,
            elements: resolved.elements,
            ...(resolved.region ? { region: resolved.region } : {}),
        });
    }

    private updateSelection(selection: GuiSelection): void {
        this.selection = this.resolveSelection(selection);
        this.currentSnapshot = { ...this.currentSnapshot, selection: this.selection };
    }

    private resolveSelection(selection: GuiSelection): GuiSelection {
        const elements = selection.elements.flatMap(reference => {
            const resolved = resolveGuiElementReference(this.currentElements, reference);
            return resolved ? [createGuiElementReference(resolved.element, resolved.path, resolved.ancestors)] : [];
        });
        const unique = Array.from(new Map(elements.map(item => [item.path, item])).values()).slice(0, 32);
        return { elements: unique, ...(selection.region ? { region: selection.region } : {}) };
    }

    private scheduleRefresh(fromDisk: boolean, delay: number, writtenFile?: string): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            const target = writtenFile ?? this.currentFile;
            if (target) {
                void GuiPanel.refreshIfFile(target).catch(error => {
                    ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to refresh the full GUI workbench after a write.', error);
                });
            }
            if (this.webview && (fromDisk || this.currentFile)) void this.loadCurrent(fromDisk);
        }, delay);
    }

    private async loadCurrent(fromDisk: boolean): Promise<void> {
        const webview = this.webview;
        const filePath = this.currentFile;
        if (!webview || !filePath) {
            this.emit({ status: 'empty', elements: [], pinned: this.pinned });
            return;
        }
        const revision = ++this.revision;
        try {
            const document = await vs.workspace.openTextDocument(vs.Uri.file(filePath));
            const content = fromDisk && !document.isDirty ? await fs.promises.readFile(filePath, 'utf8') : undefined;
            const loaded = await this.loader.load(document, webview, content);
            if (revision !== this.revision || webview !== this.webview) return;
            const sameDocument = this.loadedFile && normalizePath(this.loadedFile) === normalizePath(filePath);
            const changedPaths = sameDocument ? this.changedPaths(this.currentElements, loaded.elements) : [];
            this.loadedFile = filePath;
            this.currentDocument = document;
            this.currentElements = loaded.elements;
            this.selection = this.resolveSelection(this.selection);
            this.emit({
                status: 'ready',
                file: vs.workspace.asRelativePath(filePath).replace(/\\/g, '/'),
                fileName: path.basename(filePath),
                documentVersion: document.version,
                dirty: document.isDirty,
                pinned: this.pinned,
                elements: loaded.elements,
                selection: this.selection,
                changedPaths,
            });
        } catch (error) {
            if (revision !== this.revision) return;
            ErrorReporter.warn(SOURCE.CHAT_PANEL, `Failed to load manager GUI preview: ${filePath}`, error);
            this.emit({
                status: 'error',
                file: filePath,
                fileName: path.basename(filePath),
                pinned: this.pinned,
                message: error instanceof Error ? error.message : String(error),
                elements: [],
            });
        }
    }

    private async postVisualArtifacts(evidence: GuiVisualEvidence): Promise<void> {
        const view = await this.writeVisualArtifacts(evidence);
        this.postVisualEvidence(view);
    }

    private async restoreStoredVisualEvidence(): Promise<void> {
        if (this.latestVisualEvidence) {
            await this.postVisualArtifacts(this.latestVisualEvidence);
            return;
        }
        const directory = this.visualArtifactDirectory();
        if (!directory || !this.webview) return;
        try {
            const raw = await fs.promises.readFile(path.join(directory, 'latest.json'), 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (!isGuiVisualEvidence(parsed, false)) return;
            const view = this.visualEvidenceUris(parsed, directory);
            this.postVisualEvidence(view);
        } catch {
            // No prior evidence is an ordinary first-run state.
        }
    }

    private async writeVisualArtifacts(evidence: GuiVisualEvidence): Promise<GuiVisualEvidence> {
        const directory = this.visualArtifactDirectory();
        if (!directory || !this.webview) return evidence;
        await fs.promises.mkdir(directory, { recursive: true });
        if (evidence.before) await this.writeVisualFile(path.join(directory, 'before.png'), evidence.before);
        else await this.removeVisualFile(path.join(directory, 'before.png'));
        await this.writeVisualFile(path.join(directory, 'after.png'), evidence.after);
        if (evidence.diff) await this.writeVisualFile(path.join(directory, 'diff.png'), evidence.diff);
        else await this.removeVisualFile(path.join(directory, 'diff.png'));
        const metadata: GuiVisualEvidence = {
            ...evidence,
            before: evidence.before ? 'before.png' : undefined,
            after: 'after.png',
            diff: evidence.diff ? 'diff.png' : undefined,
        };
        await this.writeVisualFile(path.join(directory, 'latest.json'), Buffer.from(JSON.stringify(metadata), 'utf8'));
        return this.visualEvidenceUris(metadata, directory);
    }

    private visualEvidenceUris(evidence: GuiVisualEvidence, directory: string): GuiVisualEvidence {
        if (!this.webview) return evidence;
        const resource = (name: string) => this.webview!.asWebviewUri(vs.Uri.file(path.join(directory, name))).toString();
        return {
            ...evidence,
            before: evidence.before ? resource('before.png') : undefined,
            after: resource('after.png'),
            diff: evidence.diff ? resource('diff.png') : undefined,
        };
    }

    private async writeVisualFile(filePath: string, value: string | Buffer): Promise<void> {
        const buffer = typeof value === 'string' ? this.decodeVisualDataUrl(value) : value;
        const temporary = filePath + '.tmp';
        await fs.promises.writeFile(temporary, buffer);
        await fs.promises.rename(temporary, filePath);
    }

    private decodeVisualDataUrl(value: string): Buffer {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value);
        if (!match) throw new Error('Invalid GUI visual evidence image encoding.');
        return Buffer.from(match[1]!, 'base64');
    }

    private async removeVisualFile(filePath: string): Promise<void> {
        try { await fs.promises.unlink(filePath); } catch { /* already absent */ }
    }

    private visualArtifactDirectory(): string {
        const root = getPrivateTopicStorageDir(this.currentTopicId);
        return root ? path.join(root, 'gui-preview') : '';
    }

    private changedPaths(previous: GuiElement[], next: GuiElement[]): string[] {
        if (!previous.length) return [];
        const before = new Map(flattenGuiElements(previous).map(item => [item.path, fingerprint(item.element)]));
        return flattenGuiElements(next)
            .filter(item => before.has(item.path) && before.get(item.path) !== fingerprint(item.element))
            .map(item => item.path)
            .slice(0, 32);
    }

    private emit(snapshot: GuiPreviewSnapshot): void {
        this.currentSnapshot = snapshot;
        this.postSnapshot(snapshot);
    }

    private async requireCurrentDocument(): Promise<vs.TextDocument | undefined> {
        if (!this.currentFile) {
            void vs.window.showInformationMessage(aiText('Choose a GUI file first.', '请先选择 GUI 文件。'));
            return undefined;
        }
        this.currentDocument = await vs.workspace.openTextDocument(vs.Uri.file(this.currentFile));
        return this.currentDocument;
    }

    private resolveGuiPath(file: string): string | undefined {
        const resolved = resolveProjectWorkspacePath(file);
        if (!resolved || !resolved.toLowerCase().endsWith('.gui') || !fs.existsSync(resolved)) return undefined;
        return resolved;
    }

    private warnInvalidFile(file: string): void {
        void vs.window.showWarningMessage(aiText(
            `Cannot preview '${file}': choose a .gui file inside the workspace.`,
            `无法预览“${file}”：请选择工作区内的 .gui 文件。`,
        ));
    }

    private isGuiDocument(document: vs.TextDocument): boolean {
        return document.uri.scheme === 'file' && document.uri.fsPath.toLowerCase().endsWith('.gui');
    }

    private isCurrentFile(filePath: string): boolean {
        return !!this.currentFile && normalizePath(this.currentFile) === normalizePath(filePath);
    }
}
