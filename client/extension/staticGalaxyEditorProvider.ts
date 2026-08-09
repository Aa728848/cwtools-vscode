/**
 * Static Galaxy Preview/Editor — CustomTextEditorProvider.
 *
 * Host responsibilities (docs/static-galaxy-preview-editor-plan.md §5.2):
 * - Owns parsing, revisions, source spans, permissions and WorkspaceEdits.
 * - The TextDocument stays the single source of truth; undo/redo/save are the
 *   native VS Code document operations.
 * - The webview receives plain data snapshots only and can never specify URIs,
 *   source offsets or replacement text.
 */
import * as fs from 'fs';
import { panelText } from './panelI18n';
import * as path from 'path';
import * as vscode from 'vscode';
import { ErrorReporter } from './ai/errorReporter';
import { isPreviewAvailable } from './gameProfiles';
import { parseStaticGalaxy, toScenarioView, ParsedScenario, OffsetSpan } from './staticGalaxyParser';
import { StaticGalaxyInitializerIndex } from './staticGalaxyInitializers';
import { StaticGalaxyInitializerSummary } from './staticGalaxyInitializerSummary';
import { buildStaticGalaxyEdits, StaticGalaxyEditError, StaticGalaxyEditRequest } from './staticGalaxyEditBuilder';
import {
    parseStaticGalaxyWebviewMessage,
    StaticGalaxyDocumentState,
    StaticGalaxyEditRejectCode,
    StaticGalaxyHostMessage,
    StaticGalaxyRevision,
    StaticGalaxyScenarioView,
} from '../shared/staticGalaxyProtocol';

export const STATIC_GALAXY_VIEW_TYPE = 'cwtools.staticGalaxyEditor';
export const PREVIEW_STATIC_GALAXY_COMMAND = 'cwtools.previewStaticGalaxy';

const SOURCE = 'StaticGalaxy';
const REPARSE_DEBOUNCE_MS = 200;

/** Matches `map/setup_scenarios` with either separator, case-insensitively. */
export function isSetupScenariosPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/map/setup_scenarios/');
}

/** Steam Workshop content may be overwritten by Steam at any time. */
export function isWorkshopPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('steamapps/workshop/content');
}

interface RevisionState {
    revisionId: string;
    documentVersion: number;
    scenarios: ParsedScenario[];
    /** nodeKey -> go-to-source span (block when available, key otherwise). */
    sourceSpans: Map<string, OffsetSpan>;
}

class StaticGalaxyEditorSession implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    private _revision: RevisionState | undefined;
    private _revisionCounter = 0;
    private _parseTimer: ReturnType<typeof setTimeout> | undefined;
    private _lastGoodRevision: StaticGalaxyRevision | undefined;
    private _disposed = false;
    private _workshopEditAllowed = false;
    private readonly _workshopFile: boolean;
    private _canEditFs = false;
    private _parseAllowsEdit = false;
    private _parseSeq = 0;
    private readonly _initializerIndex = new StaticGalaxyInitializerIndex();
    private _messageQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly _document: vscode.TextDocument,
        private readonly _panel: vscode.WebviewPanel,
        private readonly _webviewRoot: string,
    ) {
        this._workshopFile = isWorkshopPath(_document.uri.fsPath);

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(this._webviewRoot)],
        };
        this._panel.webview.html = this._getHtml();

        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(
                (message: unknown) => this._queueMessage(message),
            ),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === this._document.uri.toString()) {
                    this._scheduleReparse();
                }
            }),
            vscode.workspace.onDidSaveTextDocument(d => {
                if (d.uri.toString() === this._document.uri.toString()) {
                    this._sendDocumentState();
                }
            }),
            this._panel.onDidDispose(() => this.dispose()),
        );
    }

    async initialize(): Promise<void> {
        this._canEditFs = await this._checkWritable();
        this._sendPermissions();
        this._reparseNow();
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        if (this._parseTimer !== undefined) clearTimeout(this._parseTimer);
        for (const d of this._disposables) d.dispose();
    }

    // ── Parsing & revision sync ─────────────────────────────────────────────

    private _scheduleReparse(): void {
        // Source changed: reject stale edits until the new revision lands.
        this._post({ type: 'documentState', state: 'stale', dirty: this._document.isDirty });
        if (this._parseTimer !== undefined) clearTimeout(this._parseTimer);
        this._parseTimer = setTimeout(() => {
            this._parseTimer = undefined;
            this._reparseNow();
        }, REPARSE_DEBOUNCE_MS);
    }

    private _reparseNow(): void {
        if (this._disposed) return;
        const text = this._document.getText();
        const result = parseStaticGalaxy(text);

        if (!result.ok) {
            // Keep the last displayable snapshot, drop into read-only preview.
            this._revision = undefined;
            this._parseAllowsEdit = false;
            this._sendPermissions();
            this._post({
                type: 'documentState',
                state: 'error',
                dirty: this._document.isDirty,
                message: result.error === 'No static_galaxy_scenario block found'
                    ? panelText(
                        'No static_galaxy_scenario found in this file',
                        '此文件中没有 static_galaxy_scenario',
                    )
                    : panelText('Source has syntax errors — read-only preview', '源码存在语法错误 — 只读预览'),
            });
            if (this._lastGoodRevision) {
                this._post({
                    type: 'render',
                    revision: { ...this._lastGoodRevision, parseFailed: true, documentVersion: this._document.version },
                });
            } else {
                this._post({
                    type: 'render',
                    revision: {
                        revisionId: 'invalid',
                        documentVersion: this._document.version,
                        scenarios: [],
                        parseFailed: true,
                    },
                });
            }
            return;
        }

        this._parseAllowsEdit = true;
        const revisionId = `rev-${++this._revisionCounter}`;
        const sourceSpans = new Map<string, OffsetSpan>();
        for (const scenario of result.scenarios) {
            for (const sys of scenario.systems) {
                sourceSpans.set(sys.nodeKey, sys.blockSpan ?? sys.keySpan);
            }
            for (const neb of scenario.nebulas) {
                sourceSpans.set(neb.nodeKey, neb.blockSpan ?? neb.keySpan);
            }
            for (const lane of scenario.hyperlanes) {
                sourceSpans.set(lane.nodeKey, lane.blockSpan ?? lane.keySpan);
            }
        }

        this._revision = {
            revisionId,
            documentVersion: this._document.version,
            scenarios: result.scenarios,
            sourceSpans,
        };

        // Enrich with initializer details asynchronously; stale results from
        // superseded parses are dropped before posting.
        const seq = ++this._parseSeq;
        const version = this._document.version;
        void this._buildScenarioViews(result.scenarios).then(scenarios => {
            if (this._disposed || seq !== this._parseSeq) return;
            const revision: StaticGalaxyRevision = {
                revisionId,
                documentVersion: version,
                scenarios,
            };
            this._lastGoodRevision = revision;
            this._post({ type: 'render', revision });
            this._sendPermissions();
            this._sendDocumentState();
        }, err => {
            ErrorReporter.warn(SOURCE, 'Failed to build static galaxy view', err);
        });
    }

    /** Maps parsed scenarios to views and resolves referenced initializers (bounded, cached). */
    private async _buildScenarioViews(scenarios: ParsedScenario[]): Promise<StaticGalaxyScenarioView[]> {
        const views = scenarios.map(toScenarioView);
        const names = new Set<string>();
        for (const scenario of scenarios) {
            for (const sys of scenario.systems) {
                if (sys.initializer) names.add(sys.initializer);
            }
        }
        if (names.size === 0) return views;

        const resolved = new Map<string, StaticGalaxyInitializerSummary | null>();
        await Promise.all([...names].map(async name => {
            resolved.set(name, await this._initializerIndex.resolve(name));
        }));
        for (const view of views) {
            for (const sys of view.systems) {
                if (!sys.initializer) continue;
                const info = resolved.get(sys.initializer);
                if (info) {
                    sys.initializerInfo = { ...info, found: true };
                    if (info.color) sys.visual = { color: info.color, starClass: info.starClass };
                } else {
                    sys.initializerInfo = { planetCount: 0, moonCount: 0, beltCount: 0, hasRing: false, found: false };
                }
            }
        }
        return views;
    }

    // ── Permissions ─────────────────────────────────────────────────────────

    private async _checkWritable(): Promise<boolean> {
        if (this._document.uri.scheme !== 'file') return false;
        try {
            await fs.promises.access(this._document.uri.fsPath, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }

    private _sendPermissions(): void {
        const canEdit = this._canEditFs
            && this._parseAllowsEdit
            && (!this._workshopFile || this._workshopEditAllowed);
        let reason: string | undefined;
        if (!this._canEditFs) {
            reason = panelText('File is read-only', '文件为只读');
        } else if (!this._parseAllowsEdit) {
            reason = panelText('Source has syntax errors — preview only', '源文件存在语法错误 — 仅可预览');
        } else if (this._workshopFile && !this._workshopEditAllowed) {
            reason = panelText(
                'Steam Workshop file — confirm before editing',
                'Steam Workshop 文件 — 编辑前需要确认',
            );
        }
        this._post({ type: 'permissions', canEdit, reason, workshopFile: this._workshopFile });
    }

    // ── Messages ────────────────────────────────────────────────────────────

    private _post(message: StaticGalaxyHostMessage): void {
        if (this._disposed) return;
        void this._panel.webview.postMessage(message);
    }

    private _queueMessage(message: unknown): void {
        this._messageQueue = this._messageQueue
            .then(() => this._handleMessage(message))
            .catch(err => {
                ErrorReporter.warn(SOURCE, 'Failed to process static galaxy webview message', err);
            });
    }

    private _sendDocumentState(): void {
        if (this._disposed) return;
        let state: StaticGalaxyDocumentState;
        if (!this._canEditFs) {
            state = 'readonly';
        } else {
            state = this._document.isDirty ? 'modified' : 'saved';
        }
        this._post({ type: 'documentState', state, dirty: this._document.isDirty });
    }

    private async _handleMessage(raw: unknown): Promise<void> {
        if (this._disposed) return;
        const message = parseStaticGalaxyWebviewMessage(raw);
        if (!message) {
            ErrorReporter.warn(SOURCE, 'Rejected malformed webview message');
            return;
        }

        switch (message.type) {
            case 'ready':
                this._sendPermissions();
                this._reparseNow();
                break;
            case 'goToSource':
                await this._goToSource(message.revisionId, message.nodeKey);
                break;
            case 'saveDocument':
                await this._document.save();
                this._sendDocumentState();
                break;
            case 'undo':
                await vscode.commands.executeCommand('undo');
                break;
            case 'redo':
                await vscode.commands.executeCommand('redo');
                break;
            case 'requestWorkshopEdit':
                await this._confirmWorkshopEdit();
                break;
            case 'copyToWorkspace':
                await this._copyToWorkspace();
                break;
            case 'moveSystems': {
                const moves = message.moves.map(m => ({ nodeKey: m.nodeKey, x: m.x, y: m.y }));
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, { kind: 'move', moves });
                break;
            }
            case 'moveNebula':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, {
                    kind: 'move',
                    moves: [message.move],
                });
                break;
            case 'updatePosition':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, { kind: 'update', update: message.update });
                break;
            case 'updateNebulaRadius':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, {
                    kind: 'nebulaRadius',
                    nodeKey: message.nodeKey,
                    radius: message.radius,
                });
                break;
            case 'setHyperlane':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, { kind: 'hyperlane', update: message.update });
                break;
            case 'addHyperlanes':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, { kind: 'addLanes', links: message.links });
                break;
            case 'spraySystems':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, {
                    kind: 'spraySystems',
                    scenarioKey: message.scenarioKey,
                    systems: message.systems,
                });
                break;
            case 'eraseSystems':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, {
                    kind: 'eraseSystems',
                    nodeKeys: message.nodeKeys,
                });
                break;
            case 'deleteHyperlane':
                await this._applyEdit(message.requestId, message.revisionId, message.documentVersion, {
                    kind: 'deleteLane',
                    fromNodeKey: message.fromNodeKey,
                    toNodeKey: message.toNodeKey,
                });
                break;
        }
    }

    private async _goToSource(revisionId: string, nodeKey: string): Promise<void> {
        try {
            const editor = await vscode.window.showTextDocument(this._document, {
                viewColumn: vscode.ViewColumn.Beside,
                preview: true,
            });
            // Empty nodeKey means "open the source" from the empty state.
            if (nodeKey === '') return;
            if (this._revision?.revisionId !== revisionId) return;
            const span = this._revision.sourceSpans.get(nodeKey);
            if (!span) return;
            const range = new vscode.Range(
                this._document.positionAt(span.start),
                this._document.positionAt(span.end),
            );
            editor.selection = new vscode.Selection(range.start, range.start);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch (err) {
            ErrorReporter.warn(SOURCE, 'Failed to reveal source', err);
        }
    }

    private async _confirmWorkshopEdit(): Promise<void> {
        if (!this._workshopFile || this._workshopEditAllowed) {
            this._sendPermissions();
            return;
        }
        const copy = panelText('Copy to Mod Workspace', '复制到 Mod 工作区');
        const editHere = panelText('Edit in Place (this session)', '本次会话仍然原地编辑');
        const cancel = panelText('Cancel', '取消');
        const choice = await vscode.window.showWarningMessage(
            panelText(
                'This file is inside Steam Workshop content and may be overwritten by Steam updates. Editing the original is discouraged.',
                '此文件位于 Steam Workshop 内容目录中，可能被 Steam 更新覆盖。不建议直接编辑原文件。',
            ),
            { modal: true },
            copy, editHere, cancel,
        );
        if (choice === copy) {
            await this._copyToWorkspace();
        } else if (choice === editHere) {
            this._workshopEditAllowed = true;
        }
        this._sendPermissions();
    }

    private async _copyToWorkspace(): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(this._document.uri)
                ?? vscode.workspace.workspaceFolders?.[0];
            const fileName = path.basename(this._document.uri.fsPath);
            let defaultUri: vscode.Uri;
            if (workspaceFolder) {
                const scenarioDirectory = vscode.Uri.joinPath(workspaceFolder.uri, 'map', 'setup_scenarios');
                try {
                    await vscode.workspace.fs.stat(scenarioDirectory);
                    defaultUri = vscode.Uri.joinPath(scenarioDirectory, fileName);
                } catch {
                    defaultUri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
                }
            } else {
                defaultUri = vscode.Uri.file(path.join(path.dirname(this._document.uri.fsPath), `copy-${fileName}`));
            }
            const target = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'Paradox Script': ['txt'] },
                title: panelText('Copy static galaxy scenario to workspace', '复制静态银河场景到工作区'),
            });
            if (!target) return;
            if (target.toString() === this._document.uri.toString()) {
                void vscode.window.showWarningMessage(panelText(
                    'Choose a different target for the Workshop copy',
                    '请为 Workshop 副本选择不同的目标文件',
                ));
                return;
            }
            await vscode.workspace.fs.writeFile(target, Buffer.from(this._document.getText(), 'utf8'));
            const doc = await vscode.workspace.openTextDocument(target);
            await vscode.commands.executeCommand('vscode.openWith', doc.uri, STATIC_GALAXY_VIEW_TYPE, {
                viewColumn: this._panel.viewColumn ?? vscode.ViewColumn.Active,
            });
        } catch (err) {
            ErrorReporter.warn(SOURCE, 'Failed to copy scenario to workspace', err);
        }
    }

    // ── Edit application ────────────────────────────────────────────────────

    private async _applyEdit(
        requestId: string,
        revisionId: string,
        documentVersion: number,
        request: StaticGalaxyEditRequest,
    ): Promise<void> {
        const reject = (code: StaticGalaxyEditRejectCode, message: string) => {
            this._post({
                type: 'editRejected',
                requestId,
                code,
                message,
                revision: this._lastGoodRevision,
            });
            // The editRejected message itself carries the error state; a
            // documentState echo here would immediately overwrite it.
        };

        if (!this._canEditFs) {
            reject('read-only', panelText('File is read-only', '文件为只读'));
            return;
        }
        if (this._workshopFile && !this._workshopEditAllowed) {
            reject('read-only', panelText('Workshop edit not confirmed', '未确认 Workshop 编辑'));
            return;
        }
        if (!this._revision || this._revision.revisionId !== revisionId) {
            reject('stale-revision', panelText('Source changed — edits were rejected', '源文件已变化 — 编辑被拒绝'));
            return;
        }
        if (this._document.version !== documentVersion || this._document.version !== this._revision.documentVersion) {
            reject('version-mismatch', panelText('Document version mismatch', '文档版本不一致'));
            return;
        }

        this._post({ type: 'documentState', state: 'applying', dirty: this._document.isDirty });
        try {
            const built = buildStaticGalaxyEdits(request, {
                text: this._document.getText(),
                scenarios: this._revision.scenarios,
            });
            if (built.replacements.length > 0) {
                const edit = new vscode.WorkspaceEdit();
                for (const rep of built.replacements) {
                    edit.replace(
                        this._document.uri,
                        new vscode.Range(this._document.positionAt(rep.span.start), this._document.positionAt(rep.span.end)),
                        rep.text,
                    );
                }
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    reject('apply-failed', panelText('WorkspaceEdit was rejected by VS Code', 'WorkspaceEdit 被 VS Code 拒绝'));
                    return;
                }
            }
            this._post({ type: 'editAccepted', requestId, revisionId });
            if (built.replacements.length === 0) {
                // A no-op does not fire onDidChangeTextDocument, so restore the
                // status explicitly instead of leaving the UI at "Applying".
                this._sendDocumentState();
            }
            // The document change listener reparses and converges state.
        } catch (err) {
            if (err instanceof StaticGalaxyEditError) {
                reject(err.code, err.message);
            } else {
                ErrorReporter.warn(SOURCE, 'Failed to apply static galaxy edit', err);
                reject('apply-failed', err instanceof Error ? err.message : String(err));
            }
        }
    }

    // ── HTML ────────────────────────────────────────────────────────────────

    private _getHtml(): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._webviewRoot, 'staticGalaxyPreview.css')),
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._webviewRoot, 'staticGalaxyPreview.js')),
        );
        const nonce = getNonce();
        const lang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
        const fileName = path.basename(this._document.uri.fsPath);

        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this._panel.webview.cspSource} data: blob:; script-src 'nonce-${nonce}'; style-src ${this._panel.webview.cspSource} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>${escapeHtml(fileName)}</title>
</head>
<body>
    <header id="app-header">
        <div class="app-identity">
            <span class="app-kicker">${panelText('STATIC GALAXY', '静态银河')}</span>
            <span id="title" title="${escapeHtml(this._document.uri.fsPath)}">${escapeHtml(fileName)}</span>
        </div>
        <label class="scenario-picker" id="scenario-picker" for="scenario-select">
            <span>${panelText('Scenario', '场景')}</span>
            <select id="scenario-select" title="${panelText('Select scenario', '选择场景')}"></select>
        </label>
        <div id="mode-switch" class="segmented-control" role="group" aria-label="${panelText('Workspace mode', '工作模式')}">
            <button id="btn-preview" class="active" type="button" aria-pressed="true"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg><span>${panelText('Preview', '预览')}</span></button>
            <button id="btn-edit" type="button" aria-pressed="false" title="${panelText('Edit mode (E)', '编辑模式 (E)')}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg><span>${panelText('Edit', '编辑')}</span></button>
        </div>
        <div id="document-actions" role="toolbar" aria-label="${panelText('Document actions', '文档操作')}">
            <button id="btn-undo" class="icon-button edit-only" type="button" title="${panelText('Undo (Ctrl+Z)', '撤销 (Ctrl+Z)')}" aria-label="${panelText('Undo', '撤销')}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 7 4 12l5 5"></path><path d="M20 18a8 8 0 0 0-8-8H4"></path></svg></button>
            <button id="btn-redo" class="icon-button edit-only" type="button" title="${panelText('Redo (Ctrl+Shift+Z)', '重做 (Ctrl+Shift+Z)')}" aria-label="${panelText('Redo', '重做')}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 7 5 5-5 5"></path><path d="M4 18a8 8 0 0 1 8-8h8"></path></svg></button>
            <button id="btn-save" class="button-secondary edit-only" type="button" title="${panelText('Save current file (Ctrl+S)', '保存当前文件 (Ctrl+S)')}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 3h12l4 4v14H3V3h2Z"></path><path d="M7 3v6h10V3M7 21v-8h10v8"></path></svg><span>${panelText('Save', '保存')}</span></button>
            <span id="edit-status" class="status-pill" data-state="saved" role="status" aria-live="polite">${panelText('Saved', '已保存')}</span>
            <button id="btn-toggle-inspector" class="icon-button" type="button" aria-pressed="true" title="${panelText('Toggle inspector', '切换检视器')}" aria-label="${panelText('Toggle inspector', '切换检视器')}"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1"></rect><path d="M15 4v16"></path></svg></button>
        </div>
    </header>
    <div id="workshop-banner" class="hidden" role="alert">
        <span>${panelText('Steam Workshop file — changes may be overwritten by Steam updates.', 'Steam Workshop 文件 — 修改可能被 Steam 更新覆盖。')}</span>
        <button id="btn-copy-workspace" type="button">${panelText('Copy to Mod Workspace', '复制到 Mod 工作区')}</button>
    </div>
    <div id="main-layout">
        <section id="viewport" tabindex="0" aria-label="${panelText('Interactive static galaxy canvas', '交互式静态银河画布')}">
            <canvas id="galaxy-canvas" role="img" aria-label="${panelText('Static galaxy map visualization', '静态银河地图可视化')}"></canvas>
            <div id="view-toolbar" class="floating-card" role="toolbar" aria-label="${panelText('View controls', '视图控制')}">
                <div class="toolbar-group zoom-group">
                    <button id="btn-zoom-out" class="icon-button" type="button" title="${panelText('Zoom out', '缩小')}" aria-label="${panelText('Zoom out', '缩小')}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14"></path></svg></button>
                    <span id="zoom-level">100%</span>
                    <button id="btn-zoom-in" class="icon-button" type="button" title="${panelText('Zoom in', '放大')}" aria-label="${panelText('Zoom in', '放大')}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg></button>
                </div>
                <span class="toolbar-divider" aria-hidden="true"></span>
                <button id="btn-fit" class="text-button" type="button" title="${panelText('Fit all systems and nebulas', '适应所有系统和星云')}">${panelText('Fit all', '适应全部')}</button>
                <button id="btn-focus" class="text-button" type="button" disabled title="${panelText('Center selected node', '居中所选节点')}">${panelText('Focus', '聚焦')}</button>
                <span class="toolbar-divider" aria-hidden="true"></span>
                <button id="btn-labels" class="toggle-button active" type="button" aria-pressed="true" title="${panelText('Toggle labels (L)', '切换标签 (L)')}">${panelText('Labels', '标签')}</button>
                <button id="btn-ranges" class="toggle-button active" type="button" aria-pressed="true" title="${panelText('Toggle coordinate ranges', '切换坐标范围')}">${panelText('Ranges', '范围')}</button>
                <button id="btn-nebulas" class="toggle-button active" type="button" aria-pressed="true" title="${panelText('Toggle nebulas', '切换星云')}">${panelText('Nebulas', '星云')}</button>
                <button id="btn-lanes" class="toggle-button active" type="button" aria-pressed="true" title="${panelText('Toggle explicit hyperlanes', '切换显式航道')}">${panelText('Lanes', '航道')}</button>
                <button id="btn-est-lanes" class="toggle-button" type="button" aria-pressed="false" title="${panelText('Toggle estimated lanes (heuristic approximation, not the game algorithm)', '切换估算航道（启发式近似，非游戏算法）')}">${panelText('Estimated', '估算')}</button>
                <button id="btn-grid" class="toggle-button" type="button" aria-pressed="false" title="${panelText('Toggle grid', '切换网格')}">${panelText('Grid', '网格')}</button>
                <span class="toolbar-divider edit-only" aria-hidden="true"></span>
                <button id="btn-spray" class="toggle-button edit-only" type="button" aria-pressed="false" title="${panelText('Spray random systems (left-drag)', '喷涂随机星系（左键拖动）')}">${panelText('Spray', '喷涂')}</button>
                <button id="btn-erase" class="toggle-button edit-only" type="button" aria-pressed="false" title="${panelText('Erase undefined random systems (left-drag)', '擦除未定义随机星系（左键拖动）')}">${panelText('Erase', '擦除')}</button>
                <span id="brush-controls" class="edit-only hidden" title="${panelText('Brush radius', '笔刷半径')}">
                    <input id="brush-radius" type="range" min="4" max="60" step="2" value="14" aria-label="${panelText('Brush radius', '笔刷半径')}" />
                    <span id="brush-radius-value">14</span>
                </span>
            </div>
            <div id="random-lanes-note" class="floating-card hidden" role="note">
                <span>${panelText('random_hyperlanes = yes — runtime lanes cannot be previewed exactly', 'random_hyperlanes = yes — 运行时随机航道无法精确预览')}</span>
            </div>
            <div id="lanes-legend" class="floating-card hidden" role="note">
                <span>${panelText('Estimated lanes — heuristic approximation, not the generated result', '估算航道 — 启发式近似，非游戏实际生成结果')}</span>
            </div>
            <div id="interaction-hint" class="floating-card" role="note">
                <span>${panelText('Wheel to zoom', '滚轮缩放')}</span>
                <span>${panelText('Space/Alt/middle drag to pan', '空格/Alt/中键拖动平移')}</span>
                <span>${panelText('Double-click to open source', '双击跳转源码')}</span>
                <span class="edit-hint edit-only">${panelText('Drag a system or nebula to move it', '拖动系统或星云修改位置')}</span>
                <span class="edit-hint edit-only">${panelText('Shift: line spray · Ctrl+Shift: exact line · Alt+right-drag: brush size', 'Shift 直线散布 · Ctrl+Shift 精确直线 · Alt+右键调半径')}</span>
                <span class="edit-hint edit-only">${panelText('Right-click a system to draw lanes, left-click to chain endpoints, right-click to confirm; right-click a lane to delete it', '右键系统绘制航道，左键连续链接端点，再次右键确认；右键航道删除')}</span>
            </div>
            <div id="drag-hud" class="floating-card hidden" aria-live="polite"></div>
            <div id="empty-state" class="hidden">
                <h2>${panelText('No static galaxy scenario', '没有静态银河场景')}</h2>
                <p id="empty-state-message">${panelText('This file does not contain a static_galaxy_scenario block.', '此文件不包含 static_galaxy_scenario 块。')}</p>
                <button id="btn-open-source" type="button">${panelText('Open source', '打开源码')}</button>
            </div>
        </section>
        <aside id="side-panel" aria-label="${panelText('Static galaxy inspector', '静态银河检视器')}">
            <div id="inspector-header">
                <div><span class="app-kicker">${panelText('INSPECTOR', '检视器')}</span><strong id="selection-title">${panelText('Galaxy overview', '银河概览')}</strong></div>
                <button id="btn-close-inspector" class="icon-button" type="button" title="${panelText('Close inspector', '关闭检视器')}" aria-label="${panelText('Close inspector', '关闭检视器')}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
            </div>
            <div id="search-box">
                <input id="search-input" type="search" placeholder="${panelText('Search id / name / initializer', '搜索 ID / 名称 / initializer')}" aria-label="${panelText('Search systems', '搜索系统')}" />
            </div>
            <div id="selection-details" role="region" aria-label="${panelText('Current selection', '当前选择')}">
                <div id="info-panel">${panelText('Select a system or nebula to view details', '选择一个系统或星云查看详情')}</div>
                <div id="props-panel" class="hidden"></div>
            </div>
            <div id="diagnostics-panel">
                <button id="diagnostics-toggle" type="button" aria-expanded="false">
                    <span id="diagnostics-summary">${panelText('No diagnostics', '没有诊断')}</span>
                </button>
                <div id="diagnostics-list" class="hidden" role="list"></div>
            </div>
        </aside>
    </div>
    <div id="tooltip" class="hidden"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class StaticGalaxyEditorProvider implements vscode.CustomTextEditorProvider {
    private readonly _sessions = new Set<StaticGalaxyEditorSession>();

    constructor(private readonly _extensionPath: string) { }

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new StaticGalaxyEditorProvider(context.extensionPath);
        return vscode.window.registerCustomEditorProvider(STATIC_GALAXY_VIEW_TYPE, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        });
    }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const session = new StaticGalaxyEditorSession(
            document,
            webviewPanel,
            path.join(this._extensionPath, 'bin/client/webview'),
        );
        this._sessions.add(session);
        webviewPanel.onDidDispose(() => this._sessions.delete(session));
        await session.initialize();
    }
}

export function registerStaticGalaxyEditor(context: vscode.ExtensionContext): void {
    context.subscriptions.push(StaticGalaxyEditorProvider.register(context));
}

/** Command handler for `cwtools.previewStaticGalaxy`. */
export async function openStaticGalaxyPreview(target?: vscode.Uri): Promise<void> {
    let uri = target;
    if (!uri) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showWarningMessage(panelText('No active editor to preview', '没有可预览的活动编辑器'));
            return;
        }
        uri = editor.document.uri;
    }
    if (uri.scheme !== 'file') {
        void vscode.window.showWarningMessage(panelText('Static Galaxy preview requires a local file', '静态银河预览需要本地文件'));
        return;
    }
    if (!uri.fsPath.toLowerCase().endsWith('.txt')) {
        void vscode.window.showWarningMessage(panelText('Static Galaxy preview is only available for .txt files', '静态银河预览仅支持 .txt 文件'));
        return;
    }

    // Profile gating: Stellaris only.
    let languageId: string | undefined;
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        languageId = doc.languageId;
    } catch (err) {
        ErrorReporter.warn(SOURCE, 'Failed to open document for static galaxy preview', err);
        return;
    }
    if (!isPreviewAvailable(languageId, 'staticGalaxyPreview')) {
        void vscode.window.showWarningMessage(panelText(
            'Static Galaxy preview is only available for Stellaris',
            '静态银河预览仅支持 Stellaris',
        ));
        return;
    }

    if (!isSetupScenariosPath(uri.fsPath)) {
        const proceed = await vscode.window.showWarningMessage(
            panelText(
                'This file is not in a map/setup_scenarios directory. Preview anyway?',
                '此文件不在 map/setup_scenarios 目录中。仍要预览吗？',
            ),
            panelText('Preview', '预览'),
            panelText('Cancel', '取消'),
        );
        if (proceed !== panelText('Preview', '预览')) return;
    }

    await vscode.commands.executeCommand('vscode.openWith', uri, STATIC_GALAXY_VIEW_TYPE, {
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
    });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, ch => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return ch;
        }
    });
}

