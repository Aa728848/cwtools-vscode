/**
 * Entity Preview Panel — manages the webview for 3D entity model visualization.
 * Follows the same architecture as GuiPanel and SolarSystemPanel.
 */
import * as vscode from 'vscode';
import { panelText } from './panelI18n';
import * as path from 'path';
import * as fs from 'fs';
import { buildEntityGraph, parseAssetFile, type EntityDefinition, type EntityGraph } from './entityAssetParser';
import { getNewAttachCycle } from './entityAttachDiagnostics';
import { applyDraftTextEdits } from './entityDraftEditing';
import {
    findLocatorTextBlock,
    renameLocatorBlock,
    renameLocatorReferencesInEntity,
    updateLocatorTransformBlock,
} from './entityLocatorEditing';
import { matchesExt } from './fileExtensions';
import { walkFiles } from './fileWalker';
import { resolveCaseInsensitivePath } from './fsCaseInsensitive';
import { isPathInsideOrEqual } from './pathScope';
import { resolveNamedParticleResources } from './particleResourceResolver';
import { normalizedPdxMeshAnchorNames } from './pdxMeshAnchors';
import { loadEnvironmentPresets } from './worldgfxPresets';
import {
    fields,
    isArrayOf,
    isBoolean,
    isFiniteNumber,
    isIntegerInRange,
    isOneOf,
    isRecord,
    isString,
    optional,
    type MessageValidator,
} from '../shared/protocolValidation';

type LocatorTransformUpdate = {
    locatorName: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: number;
};

interface EntityDraftDocument {
    document: vscode.TextDocument;
    baselineText: string;
    baselineVersion: number;
    expectedVersion: number;
    changedByPanel: boolean;
    conflict: boolean;
    operations: string[];
    draftText: string;
    undoStack: string[];
    redoStack: string[];
}


// ── WebView message types ──────────────────────────────────────────────────────
type EntityPanelMessage =
    | { command: 'goToLine'; line: number }
    | { command: 'selectState'; stateName: string }
    | { command: 'selectEntity'; index: number }
    | { command: 'openFile' }
    | ({ command: 'updateLocator' } & LocatorTransformUpdate)
    | { command: 'updateLocators'; locators: LocatorTransformUpdate[] }
    | { command: 'renameLocator'; oldName: string; newName: string }
    | { command: 'addLocator'; locatorName: string; position: [number, number, number]; rotation: [number, number, number]; attachEntity?: string }
    | { command: 'duplicateLocators'; locators: Array<{ locatorName: string; position: [number, number, number]; rotation: [number, number, number]; attachEntity?: string }> }
    | { command: 'deleteLocators'; locatorNames: string[] }
    | { command: 'updateAttach'; locatorName: string; entityName: string; targetEntity?: string }
    | { command: 'requestEntityNames' }
    | { command: 'requestEnvironments' }
    | { command: 'setEditMode'; editMode: boolean }
    | { command: 'undo' }
    | { command: 'redo' }
    | { command: 'saveDocument' }
    | { command: 'discardDrafts' }
    | { command: 'openEntityDefinition'; entityName: string }
    | { command: 'screenshot'; data: string }
    | { command: 'log'; text: string; level?: 'info' | 'warn' | 'error' };

// ── WebView message validation ─────────────────────────────────────────────────

/** One-based document line number (upper bound is a sanity cap, not a real limit). */
const isDocumentLine = isIntegerInRange(1, 100_000_000);
const isEntityIndex = isIntegerInRange(0, 100_000_000);
const isLogLevel = isOneOf(['info', 'warn', 'error'] as const);
/** Base64 screenshot payload cap (~16 MiB decoded). */
const MAX_SCREENSHOT_BASE64_LENGTH = 16 * 1024 * 1024 * 4 / 3 + 4;

function isVec3(value: unknown): value is [number, number, number] {
    return Array.isArray(value)
        && value.length === 3
        && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

function isLocatorTransformUpdate(value: unknown): value is LocatorTransformUpdate {
    return isRecord(value)
        && typeof value.locatorName === 'string'
        && isVec3(value.position)
        && isVec3(value.rotation)
        && isFiniteNumber(value.scale);
}

const isNamedLocator: (value: unknown) => boolean = value =>
    isRecord(value)
    && typeof value.locatorName === 'string'
    && isVec3(value.position)
    && isVec3(value.rotation)
    && (value.attachEntity === undefined || typeof value.attachEntity === 'string');

function isEntityPanelMessage(input: unknown): input is EntityPanelMessage {
    if (!isRecord(input) || typeof input.command !== 'string') return false;
    const validators: Record<string, MessageValidator> = {
        goToLine: fields({ line: isDocumentLine }),
        selectState: fields({ stateName: isString }),
        selectEntity: fields({ index: isEntityIndex }),
        openFile: fields(),
        updateLocator: fields({
            locatorName: isString,
            position: isVec3,
            rotation: isVec3,
            scale: isFiniteNumber,
        }),
        updateLocators: fields({ locators: isArrayOf(isLocatorTransformUpdate) }),
        renameLocator: fields({ oldName: isString, newName: isString }),
        addLocator: fields(
            { locatorName: isString, position: isVec3, rotation: isVec3 },
            { attachEntity: optional(isString) },
        ),
        duplicateLocators: fields({ locators: isArrayOf(isNamedLocator) }),
        deleteLocators: fields({ locatorNames: isArrayOf(isString) }),
        updateAttach: fields(
            { locatorName: isString, entityName: isString },
            { targetEntity: optional(isString) },
        ),
        requestEntityNames: fields(),
        requestEnvironments: fields(),
        setEditMode: fields({ editMode: isBoolean }),
        undo: fields(),
        redo: fields(),
        saveDocument: fields(),
        discardDrafts: fields(),
        openEntityDefinition: fields({ entityName: isString }),
        screenshot: fields({
            data: value => typeof value === 'string' && value.length <= MAX_SCREENSHOT_BASE64_LENGTH,
        }),
        log: fields({ text: isString }, { level: optional(isLogLevel) }),
    };
    const validator = validators[input.command];
    return validator ? validator(input) : false;
}

export class EntityPanel {
    public static currentPanel: EntityPanel | undefined;
    private static readonly viewType = 'cwtools-entity-preview';
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    /** Aborts any in-flight workspace scan when the panel is disposed. */
    private _scanAbortController = new AbortController();
    private readonly _webviewRootPath: string;
    private _document: vscode.TextDocument | undefined;
    private _searchRoots: string[] = [];
    private _entityGraph: EntityGraph | null = null;
    private _skipNextReload = false;
    private _currentEntityName: string | undefined;
    private _currentEntityIndex = 0;
    private _currentModelAnchorNames = new Set<string>();
    private _messageQueue: Promise<void> = Promise.resolve();
    private _editMode = false;
    private readonly _draftDocuments = new Map<string, EntityDraftDocument>();
    private readonly _pendingPanelEditUris = new Set<string>();
    private _disposed = false;
    private _panelClosed = false;
    private static _outputChannel: vscode.OutputChannel | undefined;

    private _queueOperation(operation: () => Promise<void>): void {
        this._messageQueue = this._messageQueue
            .then(operation, operation)
            .catch(error => {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`${panelText('Entity edit failed', '实体编辑失败')}: ${detail}`);
            });
    }

    private _updateKeybindingContext(): void {
        void vscode.commands.executeCommand(
            'setContext',
            'cwtools.entityPreview.editing',
            !this._disposed && this._panel.active && this._editMode,
        );
    }

    public undo(): void {
        if (!this._editMode || !this._panel.active) return;
        this._queueOperation(() => this._handleUndoRedo('undo'));
    }

    public redo(): void {
        if (!this._editMode || !this._panel.active) return;
        this._queueOperation(() => this._handleUndoRedo('redo'));
    }

    private _trackDraftDocument(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        if (this._draftDocuments.has(key)) return;
        this._draftDocuments.set(key, {
            document,
            baselineText: document.getText(),
            baselineVersion: document.version,
            expectedVersion: document.version,
            changedByPanel: false,
            conflict: false,
            operations: [],
            draftText: document.getText(),
            undoStack: [],
            redoStack: [],
        });
    }

    private _getDraftText(document: vscode.TextDocument): string {
        this._trackDraftDocument(document);
        return this._draftDocuments.get(document.uri.toString())!.draftText;
    }

    private async _applyDraftEdit(
        document: vscode.TextDocument,
        edit: vscode.WorkspaceEdit,
        operation: string,
    ): Promise<boolean> {
        this._trackDraftDocument(document);
        const key = document.uri.toString();
        const draft = this._draftDocuments.get(key)!;
        const entry = edit.entries().find(([uri]) => uri.toString() === key);
        if (!entry || entry[1].length === 0) return false;
        const nextText = applyDraftTextEdits(draft.draftText, entry[1].map(textEdit => ({
            start: { line: textEdit.range.start.line, character: textEdit.range.start.character },
            end: { line: textEdit.range.end.line, character: textEdit.range.end.character },
            newText: textEdit.newText,
        })));
        if (nextText === undefined || nextText === draft.draftText) return false;
        draft.undoStack.push(draft.draftText);
        if (draft.undoStack.length > 200) draft.undoStack.shift();
        draft.redoStack = [];
        draft.draftText = nextText;
        draft.changedByPanel = draft.draftText !== draft.baselineText;
        if (!draft.operations.includes(operation)) draft.operations.push(operation);
        this._postDocumentState();
        return true;
    }

    public static async create(extensionPath: string, document: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (EntityPanel.currentPanel) {
            if (!await EntityPanel.currentPanel._confirmDraftNavigation()) return;
            EntityPanel.currentPanel._finalizeDispose(true);
        }

        const panel = new EntityPanel(extensionPath, column || vscode.ViewColumn.Beside, document);
        EntityPanel.currentPanel = panel;
        await panel._loadAndRender(document);
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, document: vscode.TextDocument) {
        this._webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        this._document = document;

        // Build resource roots: webview assets + all workspace folders + game path
        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(this._webviewRootPath)];
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            localResourceRoots.push(wf.uri);
        }
        const docDir = path.dirname(document.uri.fsPath);
        const modRoot = this._findModRoot(docDir);
        if (modRoot) localResourceRoots.push(vscode.Uri.file(modRoot));

        const gamePath = this._getGamePath();
        if (gamePath) localResourceRoots.push(vscode.Uri.file(gamePath));

        this._panel = vscode.window.createWebviewPanel(
            EntityPanel.viewType,
            `Entity: ${path.basename(document.fileName)}`,
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots },
        );

        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => { void this._handlePanelClosed(); }, null, this._disposables);
        this._disposables.push(this._panel.onDidChangeViewState(() => this._updateKeybindingContext()));
        this._updateKeybindingContext();
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async (raw: unknown) => {
                if (!isEntityPanelMessage(raw)) return;
                const msg = raw;
                switch (msg.command) {
                    case 'goToLine': {
                        if (!this._document) break;
                        const ed = await vscode.window.showTextDocument(this._document.uri, { viewColumn: vscode.ViewColumn.One });
                        const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);
                        ed.selection = new vscode.Selection(range.start, range.start);
                        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        break;
                    }
                    case 'selectEntity': {
                        if (!this._document || !await this._confirmDraftNavigation()) break;
                        await this._loadAndRender(this._document, msg.index);
                        break;
                    }
                    case 'openFile': {
                        if (!await this._confirmDraftNavigation()) break;
                        // Open file picker for .asset files
                        const uris = await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: false,
                            filters: { 'Asset Files': ['asset'] },
                            title: panelText('Open Entity Asset File', '打开实体资产文件'),
                        });
                        if (uris && uris[0]) {
                            const doc = await vscode.workspace.openTextDocument(uris[0]);
                            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                            this._document = doc;
                            this._trackDraftDocument(doc);
                            this._panel.title = `Entity: ${path.basename(doc.fileName)}`;
                            this._entityGraph = null;
                            await this._loadAndRender(doc);
                        }
                        break;
                    }
                    case 'updateLocator': {
                        this._queueOperation(async () => {
                            await this._handleUpdateLocator(msg);
                            this._postDocumentState();
                        });
                        break;
                    }
                    case 'updateLocators': {
                        this._queueOperation(async () => {
                            await this._handleUpdateLocators(msg);
                            this._postDocumentState();
                        });
                        break;
                    }
                    case 'renameLocator': {
                        this._queueOperation(async () => {
                            await this._handleRenameLocator(msg);
                            this._postDocumentState();
                        });
                        break;
                    }
                    case 'addLocator': {
                        this._queueOperation(async () => {
                            await this._handleAddLocator(msg);
                            this._postDocumentState();
                        });
                        break;
                    }
                    case 'duplicateLocators': {
                        this._queueOperation(async () => {
                            await this._handleDuplicateLocators(msg);
                            this._postDocumentState();
                        });
                        break;
                    }
                    case 'deleteLocators': {
                        this._queueOperation(async () => {
                            await this._handleDeleteLocators(msg);
                            this._postDocumentState();
                        });
                        break;
                    }
                    case 'updateAttach': {
                        this._queueOperation(async () => {
                            await this._handleUpdateAttach(msg);
                            this._postDocumentState();
                        });
                        break;
                    }
                    case 'requestEntityNames': {
                        await this._handleRequestEntityNames();
                        break;
                    }
                    case 'requestEnvironments': {
                        await this._sendEnvironments();
                        break;
                    }
                    case 'setEditMode': {
                        if (typeof msg.editMode !== 'boolean') break;
                        this._editMode = msg.editMode;
                        this._updateKeybindingContext();
                        break;
                    }
                    case 'undo': {
                        this._queueOperation(() => this._handleUndoRedo('undo'));
                        break;
                    }
                    case 'redo': {
                        this._queueOperation(() => this._handleUndoRedo('redo'));
                        break;
                    }
                    case 'saveDocument': {
                        this._queueOperation(async () => { await this._handleSaveDocument(); });
                        break;
                    }
                    case 'discardDrafts': {
                        this._queueOperation(async () => { await this._handleDiscardDrafts(); });
                        break;
                    }
                    case 'openEntityDefinition': {
                        await this._handleOpenEntityDefinition(msg.entityName);
                        break;
                    }
                    case 'screenshot': {
                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(
                                path.join(
                                    path.dirname(this._document?.uri.fsPath ?? ''),
                                    `${this._currentEntityName ?? 'entity'}_screenshot.png`,
                                ),
                            ),
                            filters: { 'PNG Image': ['png'] },
                            title: panelText('Save Screenshot', '保存截图'),
                        });
                        if (uri && msg.command === 'screenshot') {
                            const buf = Buffer.from(msg.data, 'base64');
                            await fs.promises.writeFile(uri.fsPath, buf);
                            vscode.window.showInformationMessage(`Screenshot saved: ${path.basename(uri.fsPath)}`);
                        }
                        break;
                    }
                    case 'log': {
                        if (!EntityPanel._outputChannel) {
                            EntityPanel._outputChannel = vscode.window.createOutputChannel('Entity Preview');
                            EntityPanel._outputChannel.show(true); // auto-show, preserve focus
                        }
                        const prefix = msg.level === 'error' ? '❌' : msg.level === 'warn' ? '⚠️' : 'ℹ️';
                        EntityPanel._outputChannel.appendLine(`${prefix} ${msg.text}`);
                        break;
                    }
                }
            }, null, this._disposables),
        );

        // Locator edits stay in an in-memory preview draft. The VS Code text
        // buffer and disk are both untouched until the explicit Save action.
        this._trackDraftDocument(document);
        this._disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                const key = event.document.uri.toString();
                const draft = this._draftDocuments.get(key);
                if (!draft) return;
                if (this._pendingPanelEditUris.has(key)) {
                    draft.expectedVersion = event.document.version;
                } else if (draft.changedByPanel) {
                    draft.conflict = true;
                } else {
                    draft.baselineText = event.document.getText();
                    draft.draftText = draft.baselineText;
                    draft.baselineVersion = event.document.version;
                    draft.expectedVersion = event.document.version;
                }
                this._postDocumentState();
            }),
        );

        // Watch for document saves to auto-refresh preview
        this._disposables.push(
            vscode.workspace.onDidSaveTextDocument(async savedDoc => {
                const draft = this._draftDocuments.get(savedDoc.uri.toString());
                if (draft) {
                    if (draft.changedByPanel && savedDoc.getText() !== draft.draftText) {
                        draft.conflict = true;
                        draft.expectedVersion = savedDoc.version;
                    } else {
                        draft.baselineText = savedDoc.getText();
                        draft.draftText = draft.baselineText;
                        draft.baselineVersion = savedDoc.version;
                        draft.expectedVersion = savedDoc.version;
                        draft.changedByPanel = false;
                        draft.conflict = false;
                        draft.operations = [];
                        draft.undoStack = [];
                        draft.redoStack = [];
                    }
                }
                if (savedDoc.uri.fsPath === this._document?.uri.fsPath) {
                    if (this._skipNextReload) {
                        this._skipNextReload = false;
                        this._postDocumentState(false, true);
                        return;
                    }
                    this._entityGraph = null; // invalidate cache
                    await this._loadAndRender(savedDoc);
                    this._postDocumentState(false, true);
                }
            }),
        );
    }

    private _postDocumentState(saving = false, saved = false): void {
        const drafts = Array.from(this._draftDocuments.values()).filter(draft => draft.changedByPanel);
        if (this._panelClosed) return;
        void this._panel.webview.postMessage({
            command: 'documentState',
            dirty: drafts.length > 0,
            saving,
            saved,
            conflict: drafts.some(draft => draft.conflict),
            files: drafts.map(draft => ({
                path: draft.document.uri.fsPath,
                name: path.basename(draft.document.uri.fsPath),
                conflict: draft.conflict,
                operations: draft.operations,
            })),
        });
    }

    private _draftSummary(drafts: EntityDraftDocument[]): string {
        return drafts.map(draft => {
            const operations = draft.operations.length > 0 ? draft.operations.join('、') : panelText('Entity edits', '实体编辑');
            return `${path.basename(draft.document.uri.fsPath)} — ${operations}${draft.conflict ? panelText(' (conflict)', '（存在冲突）') : ''}`;
        }).join('\n');
    }

    private async _handleSaveDocument(skipConfirmation = false): Promise<boolean> {
        const drafts = Array.from(this._draftDocuments.values()).filter(draft => draft.changedByPanel);
        if (drafts.length === 0) {
            this._postDocumentState(false, true);
            return true;
        }
        const detail = this._draftSummary(drafts);
        if (!skipConfirmation) {
            const choice = await vscode.window.showInformationMessage(
                panelText(`Save changes to ${drafts.length} file(s)?`, `保存 ${drafts.length} 个文件的更改？`),
                { modal: true, detail },
                panelText('Save All', '全部保存'),
            );
            if (!choice) return false;
        }
        if (drafts.some(draft => draft.conflict)) {
            const choice = await vscode.window.showWarningMessage(
                panelText('Some edited files changed outside the Entity editor.', '部分已编辑文件在实体编辑器之外发生了变化。'),
                { modal: true, detail },
                panelText('Save Anyway', '仍然保存'),
            );
            if (!choice) return false;
        }

        this._postDocumentState(true);
        const edit = new vscode.WorkspaceEdit();
        for (const draft of drafts) {
            const end = draft.document.positionAt(draft.document.getText().length);
            edit.replace(draft.document.uri, new vscode.Range(new vscode.Position(0, 0), end), draft.draftText);
            this._pendingPanelEditUris.add(draft.document.uri.toString());
        }
        let applied = false;
        try {
            applied = await vscode.workspace.applyEdit(edit);
        } finally {
            for (const draft of drafts) this._pendingPanelEditUris.delete(draft.document.uri.toString());
        }
        if (!applied) {
            this._postDocumentState(false);
            void vscode.window.showErrorMessage(panelText(
                'Unable to apply the Entity editor draft.',
                '无法应用实体编辑器草稿。',
            ));
            return false;
        }

        this._skipNextReload = drafts.some(draft => draft.document.uri.fsPath === this._document?.uri.fsPath);
        let saved = true;
        for (const draft of drafts) {
            if (!await draft.document.save()) {
                saved = false;
                draft.expectedVersion = draft.document.version;
                draft.changedByPanel = true;
            }
        }
        if (!saved) {
            this._skipNextReload = false;
            void vscode.window.showErrorMessage(panelText(
                'Unable to save all entity locator changes.',
                '无法保存全部实体定位器更改。',
            ));
        }
        if (saved) {
            for (const draft of drafts) {
                draft.baselineText = draft.document.getText();
                draft.draftText = draft.baselineText;
                draft.baselineVersion = draft.document.version;
                draft.expectedVersion = draft.document.version;
                draft.changedByPanel = false;
                draft.conflict = false;
                draft.operations = [];
                draft.undoStack = [];
                draft.redoStack = [];
            }
        }
        this._postDocumentState(false, saved);
        return saved;
    }

    private async _handleDiscardDrafts(skipConfirmation = false): Promise<boolean> {
        const drafts = Array.from(this._draftDocuments.values()).filter(draft => draft.changedByPanel);
        if (drafts.length === 0) return true;
        if (!skipConfirmation) {
            const choice = await vscode.window.showWarningMessage(
                panelText('Discard all unsaved Entity editor changes?', '放弃实体编辑器中的全部未保存更改？'),
                { modal: true, detail: this._draftSummary(drafts) },
                panelText('Discard All', '全部放弃'),
            );
            if (!choice) return false;
        }
        for (const draft of drafts) {
            draft.draftText = draft.baselineText;
            draft.changedByPanel = false;
            draft.conflict = false;
            draft.operations = [];
            draft.undoStack = [];
            draft.redoStack = [];
        }
        this._entityGraph = null;
        if (this._document && !this._panelClosed) await this._loadAndRender(this._document, this._currentEntityIndex);
        this._postDocumentState(false, true);
        return true;
    }

    private async _confirmDraftNavigation(): Promise<boolean> {
        const drafts = Array.from(this._draftDocuments.values()).filter(draft => draft.changedByPanel);
        if (drafts.length === 0) return true;
        const save = panelText('Save and Continue', '保存并继续');
        const discard = panelText('Discard and Continue', '放弃并继续');
        const choice = await vscode.window.showWarningMessage(
            panelText('There are unsaved Entity editor changes.', '实体编辑器中存在未保存更改。'),
            { modal: true, detail: this._draftSummary(drafts) },
            save,
            discard,
        );
        if (choice === save) return this._handleSaveDocument(true);
        if (choice === discard) return this._handleDiscardDrafts(true);
        return false;
    }

    private async _handleUndoRedo(command: 'undo' | 'redo'): Promise<void> {
        if (!this._document) return;
        this._trackDraftDocument(this._document);
        const draft = this._draftDocuments.get(this._document.uri.toString())!;
        const source = command === 'undo' ? draft.undoStack : draft.redoStack;
        const target = command === 'undo' ? draft.redoStack : draft.undoStack;
        const nextText = source.pop();
        if (nextText === undefined) return;
        target.push(draft.draftText);
        draft.draftText = nextText;
        draft.changedByPanel = draft.draftText !== draft.baselineText;
        if (draft.changedByPanel) {
            const operation = command === 'undo' ? panelText('Undo', '撤销') : panelText('Redo', '重做');
            if (!draft.operations.includes(operation)) draft.operations.push(operation);
        } else {
            draft.operations = [];
            draft.conflict = false;
        }
        this._entityGraph = null;
        await this._loadAndRender(this._document, this._currentEntityIndex);
        this._postDocumentState();
        this._panel.reveal();
    }

    private _isKnownAttachAnchor(document: vscode.TextDocument, entityName: string, anchorName: string): boolean {
        const parsedEntity = parseAssetFile(this._getDraftText(document), document.uri.fsPath).entities
            .find(entity => entity.name === entityName);
        if (parsedEntity?.locators.some(locator => locator.name === anchorName)) return true;

        const normalizedAnchorName = anchorName.toLowerCase();
        if (document === this._document && entityName === this._currentEntityName
            && this._currentModelAnchorNames.has(normalizedAnchorName)) {
            return true;
        }
        const entityDefinition = this._entityGraph?.entities.get(entityName);
        const meshDefinition = entityDefinition?.pdxmesh
            ? this._entityGraph?.meshes.get(entityDefinition.pdxmesh)
            : undefined;
        const meshFile = meshDefinition ? this._resolveFilePath(meshDefinition.file, this._searchRoots) : undefined;
        if (!meshFile) return false;
        try {
            return this._readMeshAnchorNames(fs.readFileSync(meshFile)).has(normalizedAnchorName);
        } catch {
            return false;
        }
    }

    private _readMeshAnchorNames(data: Buffer): Set<string> {
        const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        return normalizedPdxMeshAnchorNames(buffer) ?? new Set<string>();
    }

    /**
     * Handle locator position/rotation update from the webview.
     * Only top-level static locators declared by the current .asset are mutable.
     * Mesh locators, bones, state locators, and child-entity anchors are read-only.
     */
    private async _handleUpdateLocator(msg: LocatorTransformUpdate) {
        await this._handleUpdateLocators({ locators: [msg] });
    }

    /** Apply a multi-selection transform as one draft edit and one undo step. */
    private async _handleUpdateLocators(msg: { locators: LocatorTransformUpdate[] }) {
        if (!this._document) return;
        const doc = this._document;
        const text = this._getDraftText(doc);
        const lines = text.split('\n');
        const entityName = this._currentEntityName;
        const vectorIsValid = (value: unknown): value is [number, number, number] =>
            Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item));
        if (!entityName || !Array.isArray(msg.locators) || msg.locators.length === 0 || msg.locators.length > 500) return;
        const parsedEntity = parseAssetFile(text, doc.uri.fsPath).entities.find(entity => entity.name === entityName);
        const edit = new vscode.WorkspaceEdit();
        let editCount = 0;
        const seenNames = new Set<string>();
        for (const update of msg.locators) {
            if (typeof update?.locatorName !== 'string'
                || update.locatorName.length === 0
                || /["{}\r\n=]/.test(update.locatorName)
                || seenNames.has(update.locatorName)
                || !vectorIsValid(update.position)
                || !vectorIsValid(update.rotation)) continue;
            seenNames.add(update.locatorName);

            const locator = parsedEntity?.locators.find(candidate => candidate.name === update.locatorName);
            if (!locator) {
                console.warn(`[EntityPanel] Rejected transform for non-script locator "${update.locatorName}"`);
                continue;
            }
            if (this._currentModelAnchorNames.has(update.locatorName.toLowerCase())) {
                console.warn(`[EntityPanel] Rejected transform for model locator or bone "${update.locatorName}"`);
                continue;
            }
            const block = findLocatorTextBlock(lines, locator.line);
            if (!block) continue;
            const oldText = lines.slice(block.startLine, block.endLine + 1).join('\n');
            const newText = updateLocatorTransformBlock(oldText, update.position, update.rotation);
            if (newText === oldText) continue;
            edit.replace(doc.uri, new vscode.Range(
                new vscode.Position(block.startLine, 0),
                new vscode.Position(block.endLine, lines[block.endLine]!.length),
            ), newText);
            editCount++;
        }
        if (editCount === 0) return;
        await this._applyDraftEdit(doc, edit, panelText(
            `Transform ${editCount} locator(s)`,
            `变换 ${editCount} 个定位器`,
        ));
    }

    /** Rename one static locator plus attach and particle-node references in the current entity. */
    private async _handleRenameLocator(msg: { oldName: string; newName: string }): Promise<void> {
        if (!this._document || !this._currentEntityName) return;
        const validName = (value: unknown): value is string =>
            typeof value === 'string' && value.length > 0 && value.length <= 200 && !/["{}\r\n=]/.test(value);
        if (!validName(msg.oldName) || !validName(msg.newName) || msg.oldName === msg.newName) return;

        const doc = this._document;
        const draftText = this._getDraftText(doc);
        const lines = draftText.split('\n');
        const entity = parseAssetFile(draftText, doc.uri.fsPath).entities
            .find(candidate => candidate.name === this._currentEntityName);
        const locator = entity?.locators.find(candidate => candidate.name === msg.oldName);
        const collides = entity?.locators.some(candidate => candidate.name === msg.newName)
            || entity?.states.some(state => state.locators.some(candidate => candidate.name === msg.newName))
            || this._currentModelAnchorNames.has(msg.newName.toLowerCase());
        if (!entity || !locator || collides || this._currentModelAnchorNames.has(msg.oldName.toLowerCase())) return;

        const locatorLines = findLocatorTextBlock(lines, locator.line);
        if (!locatorLines) return;
        const entityStart = Math.max(0, entity.line - 1);
        const entityEnd = Math.min(lines.length - 1, Math.max(entityStart, entity.endLine - 1));
        const oldEntityText = lines.slice(entityStart, entityEnd + 1).join('\n');
        const oldLocatorText = lines.slice(locatorLines.startLine, locatorLines.endLine + 1).join('\n');
        const renamedLocatorText = renameLocatorBlock(oldLocatorText, msg.oldName, msg.newName);
        let newEntityText = oldEntityText.replace(oldLocatorText, renamedLocatorText);
        newEntityText = renameLocatorReferencesInEntity(newEntityText, msg.oldName, msg.newName);
        if (newEntityText === oldEntityText) return;

        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(
            new vscode.Position(entityStart, 0),
            new vscode.Position(entityEnd, lines[entityEnd]!.length),
        ), newEntityText);
        await this._applyDraftEdit(doc, edit, panelText(
            `Rename locator ${msg.oldName} → ${msg.newName}`,
            `重命名定位器 ${msg.oldName} → ${msg.newName}`,
        ));
    }

    /**
     * Handle addLocator message: insert a new locator (and optionally attach block)
     * into the current entity's .asset definition, then refresh the preview.
     */
    private async _handleAddLocator(msg: { locatorName: string; position: [number, number, number]; rotation: [number, number, number]; attachEntity?: string }) {
        if (!this._document) return;
        const doc = this._document;
        const text = this._getDraftText(doc);
        const lines = text.split('\n');
        const entityName = this._currentEntityName;
        const vectorIsValid = (value: unknown): value is [number, number, number] =>
            Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item));
        if (!entityName
            || typeof msg.locatorName !== 'string'
            || msg.locatorName.length === 0
            || /["{}\r\n=]/.test(msg.locatorName)
            || !vectorIsValid(msg.position)
            || !vectorIsValid(msg.rotation)) {
            console.warn('[EntityPanel] No current entity for addLocator');
            return;
        }

        // Find the entity block (both start and end)
        const entityNameEsc = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const entityNamePat = new RegExp(`name\\s*=\\s*"?${entityNameEsc}"?`);
        let entityBlockEnd = -1;

        for (let i = 0; i < lines.length; i++) {
            if (/entity\s*=\s*\{/.test(lines[i]!)) {
                let depth = 0;
                let blockEnd = i;
                let hasName = false;
                for (let j = i; j < lines.length; j++) {
                    for (const ch of lines[j]!) {
                        if (ch === '{') depth++;
                        if (ch === '}') depth--;
                    }
                    if (entityNamePat.test(lines[j]!)) hasName = true;
                    if (depth <= 0) { blockEnd = j; break; }
                }
                if (hasName) {
                    entityBlockEnd = blockEnd;
                    break;
                }
            }
        }

        if (entityBlockEnd < 0) {
            console.warn(`[EntityPanel] Cannot find entity block "${entityName}" for addLocator`);
            return;
        }

        const p = msg.position;
        const r = msg.rotation;
        const parsedEntity = parseAssetFile(text, doc.uri.fsPath).entities.find(entity => entity.name === entityName);
        const existsInAsset = parsedEntity?.locators.some(locator => locator.name === msg.locatorName)
            || parsedEntity?.states.some(state => state.locators.some(locator => locator.name === msg.locatorName));
        const existsInModel = this._currentModelAnchorNames.has(msg.locatorName.toLowerCase());
        if (existsInAsset || existsInModel) {
            console.warn(`[EntityPanel] Rejected duplicate or model-backed locator name "${msg.locatorName}"`);
            return;
        }

        let insertText = `\tlocator = { name = "${msg.locatorName}" position = { ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)} } rotation = { ${r[0].toFixed(2)} ${r[1].toFixed(2)} ${r[2].toFixed(2)} } }\n`;

        // If attach entity is specified, append a new attach = { } block
        // (Stellaris format: each attach block holds exactly one locator→entity mapping)
        if (msg.attachEntity) {
            insertText += `\tattach = { "${msg.locatorName}" = "${msg.attachEntity}" }\n`;
        }

        if (insertText.length > 0) {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, new vscode.Position(entityBlockEnd, 0), insertText);
            await this._applyDraftEdit(doc, edit, panelText(
                `Add locator ${msg.locatorName}`,
                `新建定位器 ${msg.locatorName}`,
            ));
        }

        console.log(`[EntityPanel] Added locator "${msg.locatorName}"${msg.attachEntity ? ` with attach → ${msg.attachEntity}` : ''}`);

        // Resolve and send the attach entity data for incremental loading
        if (msg.attachEntity) {
            await this._sendAttachEntityData(msg.locatorName, msg.attachEntity);
        }
        this._entityGraph = null;
    }

    /** Insert a Duplicate Special result as one edit/save operation. */
    private async _handleDuplicateLocators(msg: Extract<EntityPanelMessage, { command: 'duplicateLocators' }>) {
        if (!this._document || msg.locators.length === 0) return;
        const doc = this._document;
        const lines = this._getDraftText(doc).split('\n');
        const entityName = this._currentEntityName;
        if (!entityName) return;

        const entityNameEsc = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const entityNamePat = new RegExp(`name\\s*=\\s*"?${entityNameEsc}"?`);
        let entityBlockStart = -1;
        let entityBlockEnd = -1;
        for (let i = 0; i < lines.length; i++) {
            if (!/entity\s*=\s*\{/.test(lines[i]!)) continue;
            let depth = 0;
            let blockEnd = i;
            let hasName = false;
            for (let j = i; j < lines.length; j++) {
                for (const ch of lines[j]!) {
                    if (ch === '{') depth++;
                    if (ch === '}') depth--;
                }
                if (entityNamePat.test(lines[j]!)) hasName = true;
                if (depth <= 0) { blockEnd = j; break; }
            }
            if (hasName) {
                entityBlockStart = i;
                entityBlockEnd = blockEnd;
                break;
            }
        }
        if (entityBlockEnd < 0) {
            console.warn(`[EntityPanel] Cannot find entity block "${entityName}" for Duplicate Special`);
            return;
        }

        const entityBlockText = lines.slice(entityBlockStart, entityBlockEnd + 1).join('\n');
        const accepted: typeof msg.locators = [];
        const acceptedNames = new Set<string>();
        for (const locator of msg.locators.slice(0, 100)) {
            const name = locator.locatorName.trim();
            if (!name || /["{}\r\n=]/.test(name)) continue;
            if (!locator.position.every(Number.isFinite) || !locator.rotation.every(Number.isFinite)) continue;

            const lowerName = name.toLowerCase();
            if (acceptedNames.has(lowerName)) continue;
            const nameEsc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const scriptNamePattern = new RegExp(`locator\\s*=\\s*\\{[\\s\\S]*?name\\s*=\\s*"?${nameEsc}"?(?:\\s|$)`, 'i');
            const existsInScript = scriptNamePattern.test(entityBlockText);
            const existsInMesh = this._currentModelAnchorNames.has(lowerName);
            if (existsInScript || existsInMesh) {
                console.warn(`[EntityPanel] Skipped duplicate locator name "${name}"`);
                continue;
            }

            acceptedNames.add(lowerName);
            accepted.push({ ...locator, locatorName: name });
        }
        if (accepted.length === 0) return;

        let insertText = '';
        for (const locator of accepted) {
            const p = locator.position;
            const r = locator.rotation;
            insertText += `\tlocator = { name = "${locator.locatorName}" position = { ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)} } rotation = { ${r[0].toFixed(2)} ${r[1].toFixed(2)} ${r[2].toFixed(2)} } }\n`;
            if (locator.attachEntity) {
                insertText += `\tattach = { "${locator.locatorName}" = "${locator.attachEntity}" }\n`;
            }
        }

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(entityBlockEnd, 0), insertText);
        const applied = await this._applyDraftEdit(doc, edit, panelText(
            `Duplicate ${accepted.length} locator(s)`,
            `复制 ${accepted.length} 个定位器`,
        ));
        if (!applied) {
            console.warn('[EntityPanel] Duplicate Special edit could not be applied');
            return;
        }
        for (const locator of accepted) {
            if (locator.attachEntity) {
                await this._sendAttachEntityData(locator.locatorName, locator.attachEntity);
            }
        }
        console.log(`[EntityPanel] Duplicate Special created ${accepted.length} locator(s)`);
        this._entityGraph = null;
    }

    /** Delete script-defined locator and matching attach blocks in one undoable edit. */
    private async _handleDeleteLocators(msg: Extract<EntityPanelMessage, { command: 'deleteLocators' }>) {
        if (!this._document || msg.locatorNames.length === 0) return;
        const requestedNames = Array.from(new Set(
            msg.locatorNames.slice(0, 100)
                .map(name => name.trim())
                .filter(name => name.length > 0 && !/["{}\r\n=]/.test(name)),
        ));
        if (requestedNames.length === 0) return;

        const doc = this._document;
        const text = this._getDraftText(doc);
        const lines = text.split('\n');
        const entityName = this._currentEntityName;
        if (!entityName) return;

        const requestedSet = new Set(requestedNames);
        const parsedEntity = parseAssetFile(text, doc.uri.fsPath).entities.find(entity => entity.name === entityName);
        const editableLocators = (parsedEntity?.locators ?? []).filter(locator =>
            requestedSet.has(locator.name)
            && !this._currentModelAnchorNames.has(locator.name.toLowerCase()));
        const names = editableLocators.map(locator => locator.name);
        if (names.length === 0) {
            console.warn('[EntityPanel] Rejected delete request without editable static locators');
            return;
        }

        const entityNameEsc = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const entityNamePat = new RegExp(`name\\s*=\\s*"?${entityNameEsc}"?`);
        let entityBlockStart = -1;
        let entityBlockEnd = -1;
        for (let i = 0; i < lines.length; i++) {
            if (!/entity\s*=\s*\{/.test(lines[i]!)) continue;
            let depth = 0;
            let hasName = false;
            let blockEnd = i;
            for (let j = i; j < lines.length; j++) {
                for (const ch of lines[j]!) {
                    if (ch === '{') depth++;
                    if (ch === '}') depth--;
                }
                if (entityNamePat.test(lines[j]!)) hasName = true;
                if (depth <= 0) { blockEnd = j; break; }
            }
            if (hasName) {
                entityBlockStart = i;
                entityBlockEnd = blockEnd;
                break;
            }
        }
        if (entityBlockEnd < 0) return;

        const namePatterns = names.map(name => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`"?${escaped}"?\\s*=`, 'i');
        });
        const blocksToDelete: Array<{ start: number; end: number }> = editableLocators
            .map(locator => findLocatorTextBlock(lines, locator.line))
            .filter((block): block is { startLine: number; endLine: number } => block !== undefined)
            .map(block => ({ start: block.startLine, end: block.endLine }));
        for (let i = entityBlockStart + 1; i < entityBlockEnd; i++) {
            const isAttach = /attach\s*=\s*\{/.test(lines[i]!);
            if (!isAttach) continue;

            let depth = 0;
            let blockEnd = i;
            for (let j = i; j <= entityBlockEnd; j++) {
                for (const ch of lines[j]!) {
                    if (ch === '{') depth++;
                    if (ch === '}') depth--;
                }
                if (depth <= 0) { blockEnd = j; break; }
            }
            const blockText = lines.slice(i, blockEnd + 1).join('\n');
            const matches = namePatterns.some(pattern => pattern.test(blockText));
            if (matches) blocksToDelete.push({ start: i, end: blockEnd });
            i = blockEnd;
        }
        if (blocksToDelete.length === 0) return;

        const edit = new vscode.WorkspaceEdit();
        for (const block of blocksToDelete) {
            const start = new vscode.Position(block.start, 0);
            const end = block.end + 1 < lines.length
                ? new vscode.Position(block.end + 1, 0)
                : new vscode.Position(block.end, lines[block.end]!.length);
            edit.delete(doc.uri, new vscode.Range(start, end));
        }
        const applied = await this._applyDraftEdit(doc, edit, panelText(
            `Delete ${names.length} locator(s)`,
            `删除 ${names.length} 个定位器`,
        ));
        if (!applied) {
            return;
        }
        this._entityGraph = null;
        console.log(`[EntityPanel] Deleted ${names.length} locator(s)`);
    }

    /**
     * Update the attach entity for an existing locator.
     * Finds `attach = { "locatorName" = "oldEntity" }` and replaces the entity value,
     * or creates a new attach block if none exists.
     */
    private async _handleUpdateAttach(msg: Extract<EntityPanelMessage, { command: 'updateAttach' }>) {
        const targetEntityName = msg.targetEntity || this._currentEntityName;
        if (!targetEntityName
            || typeof msg.locatorName !== 'string'
            || typeof msg.entityName !== 'string'
            || /["{}\r\n=]/.test(msg.locatorName)
            || /["{}\r\n=]/.test(msg.entityName)
            || (msg.targetEntity !== undefined && /["{}\r\n=]/.test(msg.targetEntity))) {
            return;
        }

        let doc = this._document;
        let isCrossFile = false;

        // If a specific target entity is provided and it's different from the root entity
        if (msg.targetEntity && msg.targetEntity !== this._currentEntityName) {
            if (!this._entityGraph) {
                this._entityGraph = await this._buildEntityGraph(this._searchRoots);
            }
            const targetDef = this._entityGraph.entities.get(msg.targetEntity);
            if (!targetDef) {
                vscode.window.showErrorMessage(panelText(
                    `[CWTools] Could not find the definition file for entity "${msg.targetEntity}".`,
                    `[CWTools] 无法找到实体 "${msg.targetEntity}" 的定义文件。`,
                ));
                return;
            }

            const targetFsPath = vscode.Uri.file(targetDef.filePath).fsPath;
            // Security check: must be inside a workspace folder. Uses isPathInsideOrEqual
            // (path.relative semantics, Windows-only case folding) so `/repo-mod` does NOT
            // match `/repo-mod-evil` and case is not wrongly folded on Linux.
            const workspaceFolders = vscode.workspace.workspaceFolders || [];
            const isInsideWorkspace = workspaceFolders.some(wf => isPathInsideOrEqual(targetFsPath, wf.uri.fsPath));
            
            if (!isInsideWorkspace) {
                vscode.window.showErrorMessage(panelText(
                    `[CWTools] Cross-file write blocked: cannot modify vanilla or mod asset files outside the current workspace (${targetDef.filePath}).`,
                    `[CWTools] 跨文件写入被拦截：不允许修改位于当前工作区外部的原版或 Mod 资产文件 (${targetDef.filePath})。`,
                ));
                return;
            }

            try {
                doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetDef.filePath));
                isCrossFile = true;
            } catch (e) {
                vscode.window.showErrorMessage(panelText(
                    `[CWTools] Could not open entity file: ${e}`,
                    `[CWTools] 无法打开实体文件: ${e}`,
                ));
                return;
            }
        }

        if (!doc) return;

        if (msg.entityName) {
            if (!this._entityGraph) this._entityGraph = await this._buildEntityGraph(this._searchRoots);
            const entities = this._entityDefinitionsWithDrafts();
            if (!entities.has(msg.entityName)) {
                await this._panel.webview.postMessage({
                    command: 'attachValidation',
                    locatorName: msg.locatorName,
                    severity: 'error',
                    message: panelText('Attached entity definition is missing.', '被挂载实体定义不存在。'),
                });
            } else {
                const cycle = getNewAttachCycle(entities, targetEntityName, msg.entityName);
                if (cycle) {
                    await this._panel.webview.postMessage({
                        command: 'attachValidation',
                        locatorName: msg.locatorName,
                        severity: 'error',
                        message: panelText(`Circular attach blocked: ${cycle.join(' → ')}`, `已阻止循环挂载：${cycle.join(' → ')}`),
                    });
                    return;
                }
            }
        }

        const text = this._getDraftText(doc);
        const lines = text.split('\n');

        // Find the entity block bounds
        const entityNameEsc = targetEntityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const entityNamePat = new RegExp(`name\\s*=\\s*"?${entityNameEsc}"?`);
        let entityBlockStart = -1;
        let entityBlockEnd = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/entity\s*=\s*\{/.test(lines[i]!)) {
                let depth = 0;
                let blockEnd = i;
                let hasName = false;
                for (let j = i; j < lines.length; j++) {
                    for (const ch of lines[j]!) {
                        if (ch === '{') depth++;
                        if (ch === '}') depth--;
                    }
                    if (entityNamePat.test(lines[j]!)) hasName = true;
                    if (depth <= 0) { blockEnd = j; break; }
                }
                if (hasName) {
                    entityBlockStart = i;
                    entityBlockEnd = blockEnd;
                    break;
                }
            }
        }
        if (entityBlockEnd < 0) {
            vscode.window.showErrorMessage(panelText(
                `[CWTools] Could not locate the block for entity "${targetEntityName}" in the file.`,
                `[CWTools] 未能在文件中定位到实体 "${targetEntityName}" 的区块。`,
            ));
            return;
        }

        // Escape the locator name for regex
        const locNameEsc = msg.locatorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Search for existing attach = { "locatorName" = "..." } within the entity
        const attachPat = new RegExp(`^(\\s*attach\\s*=\\s*\\{\\s*"${locNameEsc}"\\s*=\\s*)"([^"]*)"(\\s*\\}\\s*)$`);
        let attachLine = -1;
        for (let i = entityBlockStart; i <= entityBlockEnd; i++) {
            if (attachPat.test(lines[i]!)) {
                attachLine = i;
                break;
            }
        }

        // Removing a stale attach is always allowed. Creating or changing one
        // requires a real static locator, model locator, or bone anchor.
        if (msg.entityName && !this._isKnownAttachAnchor(doc, targetEntityName, msg.locatorName)) {
            console.warn(`[EntityPanel] Rejected attach for unknown anchor "${msg.locatorName}"`);
            await this._panel.webview.postMessage({
                command: 'attachValidation',
                locatorName: msg.locatorName,
                severity: 'error',
                message: panelText('Attach anchor is missing.', '挂载锚点不存在。'),
            });
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        if (msg.entityName) {
            if (attachLine >= 0) {
                // Replace the entity name in existing attach block
                const oldLine = lines[attachLine]!;
                const newLine = oldLine.replace(attachPat, `$1"${msg.entityName}"$3`);
                const range = new vscode.Range(attachLine, 0, attachLine, oldLine.length);
                edit.replace(doc.uri, range, newLine);
            } else {
                // No existing attach for this locator → create new block
                const attachBlock = `\tattach = { "${msg.locatorName}" = "${msg.entityName}" }\n`;
                edit.insert(doc.uri, new vscode.Position(entityBlockEnd, 0), attachBlock);
            }
        } else {
            // Empty entity name → remove the attach block
            if (attachLine >= 0) {
                const range = new vscode.Range(attachLine, 0, attachLine + 1, 0);
                edit.delete(doc.uri, range);
            } else return;
        }

        await this._applyDraftEdit(doc, edit, panelText(
            `${msg.entityName ? 'Set' : 'Remove'} attach ${msg.locatorName}${msg.entityName ? ` → ${msg.entityName}` : ''}`,
            `${msg.entityName ? '设置' : '清除'}挂载 ${msg.locatorName}${msg.entityName ? ` → ${msg.entityName}` : ''}`,
        ));
        console.log(`[EntityPanel] Updated attach for "${msg.locatorName}" on "${targetEntityName}" → "${msg.entityName || '(removed)'}"`);

        const updatedEntity = parseAssetFile(this._getDraftText(doc), doc.uri.fsPath).entities
            .find(entity => entity.name === targetEntityName);
        if (updatedEntity) await this._postAttachDiagnostics(updatedEntity, doc);

        // When modifying across files: the same subentity may be referenced in multiple locations, and incremental updates cannot synchronize all instances.
        // A full _loadAndRender overload must be triggered to ensure all reference points are refreshed.
        // When directly editing the attach of the current root entity, use incremental updates to improve the interactive experience.
        this._entityGraph = null;
        if (isCrossFile) {
            // Cross-file modification - complete reload of the entire entity hierarchy
            if (this._document) {
                await this._loadAndRender(this._document, this._currentEntityIndex);
            }
        } else if (msg.entityName) {
            // Modifications in the current file - incremental loading
            await this._sendAttachEntityData(msg.locatorName, msg.entityName);
        } else {
            // Entity removed — tell webview to remove the attached model
            await this._panel.webview.postMessage({
                command: 'removeAttachEntity',
                locatorName: msg.locatorName,
            });
        }
    }

    /**
     * Resolve a single attach entity and send its data to the webview for incremental loading.
     */
    private async _sendAttachEntityData(locatorName: string, entityName: string) {
        try {
            if (!this._entityGraph) {
                this._entityGraph = await this._buildEntityGraph(this._searchRoots);
            }
            const graph = this._entityGraph;
            const childEntity = graph.entities.get(entityName);
            if (!childEntity) {
                console.warn(`[EntityPanel] Attach entity "${entityName}" not found in graph`);
                return;
            }

            // Build a temporary entity definition with a single attach entry
            // so _resolveAttachData can resolve it
            const tempEntity: EntityDefinition = {
                name: '__temp__',
                pdxmesh: undefined,
                scale: undefined,
                locators: [],
                attaches: [{ locatorName, entityName }],
                states: [],
                meshSettings: [],
                line: 0,
                endLine: 0,
                filePath: '',
            };

            const textureMap: Record<string, string> = {};
            // Build parent texture map from search roots
            for (const root of this._searchRoots) {
                const gfxDir = path.join(root, 'gfx');
                try { await fs.promises.access(gfxDir); } catch { continue; }
                this._scanMeshDirTextures(gfxDir, this._searchRoots, textureMap);
            }

            const attachDataArr = await this._resolveAttachData(tempEntity, graph, this._searchRoots, textureMap, 0, 8);
            if (attachDataArr.length > 0) {
                const data = attachDataArr[0]!;
                // Convert texture URIs to webview URIs
                const webviewTextureMap: Record<string, string> = {};
                for (const [key, val] of Object.entries(data.textureMap)) {
                    if (val && fs.existsSync(val)) {
                        webviewTextureMap[key] = this._panel.webview.asWebviewUri(vscode.Uri.file(val)).toString();
                    }
                }
                data.textureMap = webviewTextureMap;

                await this._panel.webview.postMessage({
                    command: 'attachEntityData',
                    locatorName,
                    attachData: data,
                });
            }
        } catch (e) {
            console.warn(`[EntityPanel] Failed to resolve attach entity "${entityName}": ${e}`);
        }
    }

    /**
     * Send all known entity names to the webview for autocomplete.
     */
    private async _handleRequestEntityNames() {
        if (!this._entityGraph) {
            this._entityGraph = await this._buildEntityGraph(this._searchRoots);
        }
        const names = Array.from(this._entityGraph.entities.keys()).sort();
        await this._panel.webview.postMessage({
            command: 'entityNames',
            names,
        });
    }

    private async _handleOpenEntityDefinition(entityName: string): Promise<void> {
        if (typeof entityName !== 'string' || entityName.length === 0 || /["{}\r\n=]/.test(entityName)) return;
        if (!this._entityGraph) this._entityGraph = await this._buildEntityGraph(this._searchRoots);
        const definition = this._entityGraph.entities.get(entityName);
        if (!definition) {
            void vscode.window.showWarningMessage(panelText(
                `Entity definition not found: ${entityName}`,
                `找不到实体定义：${entityName}`,
            ));
            return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(definition.filePath));
        const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        const position = new vscode.Position(Math.max(0, definition.line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    private _entityDefinitionsWithDrafts(): Map<string, EntityDefinition> {
        const entities = new Map(this._entityGraph?.entities ?? []);
        for (const draft of this._draftDocuments.values()) {
            for (const entity of parseAssetFile(draft.draftText, draft.document.uri.fsPath).entities) {
                entities.set(entity.name, entity);
            }
        }
        return entities;
    }

    private async _postAttachDiagnostics(entity: EntityDefinition, document: vscode.TextDocument): Promise<void> {
        if (!this._entityGraph) return;
        const diagnostics: Array<{
            locatorName: string;
            entityName: string;
            severity: 'warning' | 'error';
            message: string;
        }> = [];
        const entities = this._entityDefinitionsWithDrafts();
        for (const attach of entity.attaches) {
            if (!this._isKnownAttachAnchor(document, entity.name, attach.locatorName)) {
                diagnostics.push({
                    locatorName: attach.locatorName,
                    entityName: attach.entityName,
                    severity: 'error',
                    message: panelText('Attach anchor is missing.', '挂载锚点不存在。'),
                });
            }
            if (!entities.has(attach.entityName)) {
                diagnostics.push({
                    locatorName: attach.locatorName,
                    entityName: attach.entityName,
                    severity: 'error',
                    message: panelText('Attached entity definition is missing.', '被挂载实体定义不存在。'),
                });
                continue;
            }
            const cycle = getNewAttachCycle(entities, entity.name, attach.entityName);
            if (cycle) {
                diagnostics.push({
                    locatorName: attach.locatorName,
                    entityName: attach.entityName,
                    severity: 'error',
                    message: panelText(`Circular attach: ${cycle.join(' → ')}`, `循环挂载：${cycle.join(' → ')}`),
                });
            }
        }
        await this._panel.webview.postMessage({ command: 'attachDiagnostics', diagnostics });
    }

    private _getGamePath(): string | null {
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
        const configPath = config.get<string>('cache.stellaris');
        if (configPath && fs.existsSync(configPath)) return configPath;
        return null;
    }

    /** Parse worldgfx configs and send skybox/environment presets to the webview. */
    private async _sendEnvironments() {
        try {
            const presets = loadEnvironmentPresets(
                this._searchRoots,
                p => this._panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(),
            );
            const workerUri = this._panel.webview.asWebviewUri(
                vscode.Uri.file(path.join(this._webviewRootPath, 'skyboxEnvWorker.js')),
            ).toString();
            await this._panel.webview.postMessage({ command: 'environments', presets, workerUri });
        } catch (error) {
            console.warn('[EntityPanel] Failed to load environment presets', error);
        }
    }

    private _findModRoot(dir: string): string | null {
        let current = dir;
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(current, 'descriptor.mod')) ||
                fs.existsSync(path.join(current, 'common')) ||
                (fs.existsSync(path.join(current, 'interface')) && fs.existsSync(path.join(current, 'gfx')))) {
                return current;
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return dir;
    }

    private async _loadAndRender(document: vscode.TextDocument, entityIndex = 0) {
        const content = this._getDraftText(document);
        this._currentModelAnchorNames.clear();
        const docDir = path.dirname(document.uri.fsPath);
        const modRoot = this._findModRoot(docDir);

        // Collect search roots
        const searchRoots: string[] = [];
        if (modRoot) searchRoots.push(modRoot);
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            if (!searchRoots.includes(wf.uri.fsPath)) searchRoots.push(wf.uri.fsPath);
        }
        const gamePath = this._getGamePath();
        if (gamePath && !searchRoots.includes(gamePath)) searchRoots.push(gamePath);
        this._searchRoots = searchRoots;

        // Build entity graph (cached)
        if (!this._entityGraph) {
            this._entityGraph = await this._buildEntityGraph(searchRoots);
        }

        // Find all entities defined in the current file
        const currentEntities = parseAssetFile(content, document.uri.fsPath).entities;
        if (currentEntities.length === 0) {
            await this._panel.webview.postMessage({
                command: 'error',
                message: 'No entity definitions found in this file',
            });
            return;
        }

        // Send entity list so the webview can show a selector
        await this._panel.webview.postMessage({
            command: 'entityList',
            entities: currentEntities.map((e, i) => ({ name: e.name, index: i })),
            selectedIndex: entityIndex,
        });

        const entity = currentEntities[Math.min(entityIndex, currentEntities.length - 1)]!;
        this._currentEntityName = entity.name;
        this._currentEntityIndex = entityIndex;

        // Resolve mesh file path
        let meshBuffer: ArrayBuffer | undefined;
        let meshFileDir: string | undefined;
        // Per-submesh material overrides from GFX/entity, keyed by mesh index
        const resolvedMeshSettings: Array<{
            name: string;
            index: number;
            diffuse?: string;
            normal?: string;
            specular?: string;
            shader?: string;
        }> = [];
        // Map of relative texture path → webview URI for mesh-embedded materials
        const textureMap: Record<string, string> = {};

        let meshScale: number | undefined;
        if (entity.pdxmesh) {
            const meshDef = this._entityGraph.meshes.get(entity.pdxmesh);
            if (meshDef) {
                meshScale = meshDef.scale;
                // Find the .mesh binary file
                const meshFilePath = this._resolveFilePath(meshDef.file, searchRoots);
                meshFileDir = meshFilePath ? path.dirname(meshFilePath) : undefined;
                if (meshFilePath) {
                    try {
                        const data = await fs.promises.readFile(meshFilePath);
                        const buf = Buffer.from(data);
                        this._currentModelAnchorNames = this._readMeshAnchorNames(buf);
                        meshBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
                    } catch (e) {
                        console.warn(`Failed to read mesh file: ${meshFilePath}`, e);
                    }
                }

                // Collect ALL meshsettings keyed by NAME+INDEX
                // name = which submesh, index = texture layer (0 = base layer)
                const msMap = new Map<string, { name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }>();

                // GFX pdxmesh meshsettings (lower priority)
                for (const ms of meshDef.meshSettings) {
                    const name = ms.name || `__unnamed`;
                    const idx = ms.index ?? 0;
                    const key = `${name}@${idx}`;
                    msMap.set(key, {
                        name,
                        index: idx,
                        diffuse: ms.textureDiffuse ? this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir) : undefined,
                        normal: ms.textureNormal ? this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir) : undefined,
                        specular: ms.textureSpecular ? this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir) : undefined,
                        shader: ms.shader,
                    });
                }

                // Entity meshsettings override (higher priority)
                for (const ms of entity.meshSettings) {
                    const name = ms.name || `__unnamed`;
                    const idx = ms.index ?? 0;
                    const key = `${name}@${idx}`;
                    const existing = msMap.get(key) ?? { name, index: idx };
                    if (ms.textureDiffuse) existing.diffuse = this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir);
                    if (ms.textureNormal) existing.normal = this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir);
                    if (ms.textureSpecular) existing.specular = this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir);
                    if (ms.shader) existing.shader = ms.shader;
                    msMap.set(key, existing);
                }

                for (const [, ms] of msMap) {
                    resolvedMeshSettings.push(ms);
                }

                // Also scan the mesh file's directory (and subdirectories like sourceimages/)
                // for textures. Mesh-embedded materials use bare filenames (e.g. "foo.dds")
                // which may reside in subdirectories rather than alongside the .mesh file.
                if (meshFileDir) {
                    this._scanMeshDirTextures(meshFileDir, searchRoots, textureMap);
                }
            }
        }

        // Build textureMap: try to resolve common texture paths from gfx directory
        // This lets the webview look up mesh-embedded material texture paths
        await this._buildTextureMap(textureMap, searchRoots);

        // Recursively resolve attach data (child entities)
        const attachData = await this._resolveAttachData(entity, this._entityGraph!, searchRoots, textureMap, 0, 8);

        // Send data to webview
        let meshBase64: string | undefined;
        if (meshBuffer) {
            meshBase64 = Buffer.from(meshBuffer).toString('base64');
        }

        // Discover animation files for each state (deduplicate by animName)
        const animations: Array<{ stateName: string; animName: string; animBase64: string }> = [];
        const seenAnims = new Set<string>();
        for (const state of entity.states) {
            if (state.animation && !seenAnims.has(state.animation)) {
                seenAnims.add(state.animation);
                const meshDef = entity.pdxmesh ? this._entityGraph?.meshes.get(entity.pdxmesh) : undefined;
                let mappedAnim = meshDef?.animations?.[state.animation];
                if (mappedAnim) {
                    const graphAnim = this._entityGraph?.animations.get(mappedAnim);
                    mappedAnim = graphAnim || mappedAnim;
                    const animFile = this._findAnimFile(mappedAnim, searchRoots, meshFileDir);
                    if (animFile) {
                        try {
                            const animBuffer = fs.readFileSync(animFile);
                            animations.push({
                                stateName: state.name,
                                animName: state.animation,
                                animBase64: animBuffer.toString('base64'),
                            });
                        } catch { /* skip unreadable anim files */ }
                    }
                }
            }
        }

        const particleNames = new Set<string>();
        for (const state of entity.states) {
            for (const event of state.particleEvents) particleNames.add(event.particle);
        }
        const particleResources = await resolveNamedParticleResources(
            particleNames,
            searchRoots,
            document.uri.fsPath,
        );

        await this._panel.webview.postMessage({
            command: 'render',
            entity: {
                name: entity.name,
                pdxmesh: entity.pdxmesh,
                scale: entity.scale,
                meshScale,
                resolvedMeshSettings,
                textureMap,
                locators: entity.locators.map(l => ({
                    name: l.name,
                    position: l.position,
                    rotation: l.rotation,
                    scale: l.scale,
                })),
                attaches: entity.attaches,
                states: entity.states.map(s => ({
                    name: s.name,
                    animation: s.animation,
                    stateTime: s.stateTime,
                    looping: s.looping,
                    particleEvents: s.particleEvents,
                })),
                defaultState: entity.defaultState,
                attachData,
            },
            meshBase64,
            animations: animations.length > 0 ? animations : undefined,
            particleEffects: particleResources.effects,
            particleTextures: particleResources.textures,
            unresolvedParticles: particleResources.unresolved,
            fileName: path.basename(document.fileName),
        });
        await this._postAttachDiagnostics(entity, document);
        this._postDocumentState();
    }

    private _resolveFilePath(relPath: string, searchRoots: string[]): string | null {
        const normalized = relPath.replace(/\//g, path.sep);
        for (const root of searchRoots) {
            const full = path.join(root, normalized);
            if (fs.existsSync(full)) return full;
        }
        return null;
    }

    /**
     * Search for a .anim file by animation name.
     * Strategy:
     * 1. Direct match: {name}.anim in mesh dir / searchRoots
     * 2. Suffix match: *_{name}.anim in mesh dir (Stellaris convention)
     * 3. Recursive search in gfx/models
     */
    private _findAnimFile(animName: string, searchRoots: string[], meshFileDir?: string): string | null {
        const fileName = animName.endsWith('.anim') ? animName : `${animName}.anim`;
        const suffix = `_${animName}.anim`.toLowerCase();

        // 1. Direct match in mesh directory
        if (meshFileDir) {
            const direct = path.join(meshFileDir, fileName);
            if (fs.existsSync(direct)) return direct;

            // 2. Suffix match: *_{animName}.anim in mesh directory
            try {
                const entries = fs.readdirSync(meshFileDir);
                for (const entry of entries) {
                    if (entry.toLowerCase().endsWith(suffix)) {
                        return path.join(meshFileDir, entry);
                    }
                }
            } catch { /* skip */ }
        }

        // 3. Direct match in searchRoots
        for (const root of searchRoots) {
            const full = path.join(root, fileName);
            if (fs.existsSync(full)) return full;
        }

        // 4. Recursive search in gfx/models subdirectories
        for (const root of searchRoots) {
            const gfxDir = path.join(root, 'gfx', 'models');
            if (fs.existsSync(gfxDir)) {
                const found = this._findFileRecursive(gfxDir, fileName);
                if (found) return found;
            }
        }

        return null;
    }

    private _resolveTextureUri(texPath: string, searchRoots: string[], meshFileDir?: string): string | undefined {
        const normalized = texPath.replace(/\//g, path.sep);
        const extensions = ['.dds', '.png', '.tga'];

        // Helper to try a full path with extension fallbacks
        const tryPath = (base: string): string | undefined => {
            for (const ext of extensions) {
                const p = base.replace(/\.(dds|png|tga)$/i, ext);
                const resolved = fs.existsSync(p) ? p : resolveCaseInsensitivePath(p);
                if (resolved) {
                    return this._panel.webview.asWebviewUri(vscode.Uri.file(resolved)).toString();
                }
            }
            // If no extension in original, try adding .dds
            if (!/\.(dds|png|tga)$/i.test(base)) {
                const ddsPath = base + '.dds';
                const resolved = fs.existsSync(ddsPath) ? ddsPath : resolveCaseInsensitivePath(ddsPath);
                if (resolved) {
                    return this._panel.webview.asWebviewUri(vscode.Uri.file(resolved)).toString();
                }
            }
            return undefined;
        };

        // 1. Try as relative path from each search root
        for (const root of searchRoots) {
            const result = tryPath(path.join(root, normalized));
            if (result) return result;
        }

        // 2. If it's a bare filename (no directory separators), search in the mesh file's directory
        if (meshFileDir && !texPath.includes('/') && !texPath.includes('\\')) {
            const result = tryPath(path.join(meshFileDir, normalized));
            if (result) return result;
        }

        // 3. Try glob-searching in gfx/models under each root for bare filenames
        if (!texPath.includes('/') && !texPath.includes('\\')) {
            for (const root of searchRoots) {
                const found = this._findFileRecursive(path.join(root, 'gfx', 'models'), texPath);
                if (found) {
                    return this._panel.webview.asWebviewUri(vscode.Uri.file(found)).toString();
                }
            }
        }

        return undefined;
    }

    /**
     * Recursively search for a file by name in a directory (max depth 5).
     */
    private _findFileRecursive(dir: string, filename: string, depth = 0): string | null {
        if (depth > 5) return null;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
                    return full;
                }
                if (entry.isDirectory() && depth < 5) {
                    const found = this._findFileRecursive(full, filename, depth + 1);
                    if (found) return found;
                }
            }
        } catch { /* skip */ }
        return null;
    }

    /**
     * Recursively resolve attach data for child entities.
     * Returns an array of resolved child entity data including mesh buffers and textures.
     */
    private async _resolveAttachData(
        entity: EntityDefinition,
        graph: EntityGraph,
        searchRoots: string[],
        parentTextureMap: Record<string, string>,
        currentDepth: number,
        maxDepth: number,
    ): Promise<Array<{
        locatorName: string;
        entityName: string;
        meshBase64?: string;
        resolvedMeshSettings: Array<{ name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }>;
        textureMap: Record<string, string>;
        scale?: number;
        meshScale?: number;
        locators: Array<{ name: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: number }>;
        attachData?: unknown[];
        defaultState?: string;
        getStateFromParent?: boolean;
        animations?: Array<{ stateName: string; animName: string; animBase64: string }>;
    }>> {
        if (currentDepth >= maxDepth || !entity.attaches || entity.attaches.length === 0) {
            return [];
        }

        const results: Array<{
            locatorName: string;
            entityName: string;
            meshBase64?: string;
            resolvedMeshSettings: Array<{ name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }>;
            textureMap: Record<string, string>;
            scale?: number;
            meshScale?: number;
            locators: Array<{ name: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: number }>;
            attachData?: unknown[];
            defaultState?: string;
            getStateFromParent?: boolean;
            animations?: Array<{ stateName: string; animName: string; animBase64: string }>;
        }> = [];

        const attachPromises = entity.attaches.map(async (attach) => {
            try {
                const childEntity = graph.entities.get(attach.entityName);
                if (!childEntity) {
                    console.warn(`[EntityPanel] Attach entity "${attach.entityName}" not found in entity graph (locator: ${attach.locatorName})`);
                    return undefined;
                }

                // Resolve mesh
                let meshBase64: string | undefined;
                const childMeshSettings: Array<{ name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }> = [];
                const childTextureMap: Record<string, string> = { ...parentTextureMap };

                let childMeshScale: number | undefined;
                if (childEntity.pdxmesh) {
                    const meshDef = graph.meshes.get(childEntity.pdxmesh);
                    if (meshDef) {
                        childMeshScale = meshDef.scale;
                        const meshFilePath = this._resolveFilePath(meshDef.file, searchRoots);
                        const meshFileDir = meshFilePath ? path.dirname(meshFilePath) : undefined;

                        if (meshFilePath) {
                            try {
                                const data = await fs.promises.readFile(meshFilePath);
                                const buf = Buffer.from(data);
                                meshBase64 = buf.toString('base64');
                            } catch { /* skip */ }
                        }

                        // Resolve meshsettings
                        for (const ms of meshDef.meshSettings) {
                            const name = ms.name || '__unnamed';
                            const idx = ms.index ?? 0;
                            childMeshSettings.push({
                                name, index: idx,
                                diffuse: ms.textureDiffuse ? this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir) : undefined,
                                normal: ms.textureNormal ? this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir) : undefined,
                                specular: ms.textureSpecular ? this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir) : undefined,
                                shader: ms.shader,
                            });
                        }

                        // Entity-level meshsettings override
                        for (const ms of childEntity.meshSettings) {
                            const name = ms.name || '__unnamed';
                            const idx = ms.index ?? 0;
                            const existing = childMeshSettings.find(s => s.name === name && s.index === idx);
                            if (existing) {
                                if (ms.textureDiffuse) existing.diffuse = this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir);
                                if (ms.textureNormal) existing.normal = this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir);
                                if (ms.textureSpecular) existing.specular = this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir);
                                if (ms.shader) existing.shader = ms.shader;
                            } else {
                                childMeshSettings.push({
                                    name, index: idx,
                                    diffuse: ms.textureDiffuse ? this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir) : undefined,
                                    normal: ms.textureNormal ? this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir) : undefined,
                                    specular: ms.textureSpecular ? this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir) : undefined,
                                    shader: ms.shader,
                                });
                            }
                        }

                        // Scan the child's mesh file directory (and subdirectories) for textures
                        // (mirrors root entity logic — ensures child mesh-embedded material
                        //  paths resolve even when textures are in subdirectories like sourceimages/)
                        if (meshFileDir) {
                            this._scanMeshDirTextures(meshFileDir, searchRoots, childTextureMap);
                        }
                    }
                }

                // Recursively resolve child's attaches
                const childAttachData = await this._resolveAttachData(childEntity, graph, searchRoots, childTextureMap, currentDepth + 1, maxDepth);

                // Resolve child's animations (needed for both own-state and parent-state modes)
                let childAnimations: Array<{ stateName: string; animName: string; animBase64: string }> | undefined;
                if (childEntity.states.length > 0) {
                    const meshDef = childEntity.pdxmesh ? graph.meshes.get(childEntity.pdxmesh) : undefined;
                    const childMeshFileDir = meshDef ? (() => { const p = this._resolveFilePath(meshDef.file, searchRoots); return p ? path.dirname(p) : undefined; })() : undefined;
                    childAnimations = [];
                    // Cache loaded anim data by animName (multiple states may share same animation file)
                    const animCache = new Map<string, string>();
                    for (const state of childEntity.states) {
                        if (!state.animation) continue;
                        let base64 = animCache.get(state.animation);
                        if (base64 === undefined) {
                            const meshDef = childEntity.pdxmesh ? graph.meshes.get(childEntity.pdxmesh) : undefined;
                            let mappedAnim = meshDef?.animations?.[state.animation];
                            if (mappedAnim) {
                                mappedAnim = graph.animations.get(mappedAnim) || mappedAnim;
                                const animFile = this._findAnimFile(mappedAnim, searchRoots, childMeshFileDir);
                                if (animFile) {
                                    try {
                                        base64 = fs.readFileSync(animFile).toString('base64');
                                        animCache.set(state.animation, base64);
                                    } catch { /* skip */ }
                                }
                            } else {
                                // No GFX animation mapping for this child state
                            }
                        }
                        if (base64) {
                            childAnimations.push({
                                stateName: state.name,
                                animName: state.animation,
                                animBase64: base64,
                            });
                        }
                    }
                    if (childAnimations.length === 0) childAnimations = undefined;
                }

                return {
                    locatorName: attach.locatorName,
                    entityName: attach.entityName,
                    meshBase64,
                    resolvedMeshSettings: childMeshSettings,
                    textureMap: childTextureMap,
                    scale: childEntity.scale,
                    meshScale: childMeshScale,
                    locators: childEntity.locators.map(l => ({
                        name: l.name,
                        position: l.position,
                        rotation: l.rotation,
                        scale: l.scale,
                    })),
                    attachData: childAttachData,
                    defaultState: childEntity.defaultState,
                    getStateFromParent: childEntity.getStateFromParent,
                    animations: childAnimations,
                };
            } catch (e) {
                console.warn(`[EntityPanel] Failed to resolve attach "${attach.entityName}": ${e}`);
                return undefined;
            }
        });

        const resolvedAttaches = (await Promise.all(attachPromises)).filter(a => a !== undefined);
        results.push(...(resolvedAttaches as typeof results));

        return results;
    }

    /**
     * Recursively scan the mesh file directory and its subdirectories for texture files.
     * Mesh-embedded materials reference textures by bare filename (e.g. "foo.dds")
     * but some mods store textures in subdirectories like sourceimages/.
     * Maps both the bare filename AND the root-relative path for flexible resolution.
     */
    private _scanMeshDirTextures(
        meshFileDir: string,
        searchRoots: string[],
        textureMap: Record<string, string>,
        depth = 0,
    ) {
        if (depth > 3) return; // limit recursion depth
        try {
            const entries = fs.readdirSync(meshFileDir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(meshFileDir, entry.name);
                if (entry.isDirectory()) {
                    // Recurse into subdirectories (e.g. sourceimages/)
                    this._scanMeshDirTextures(full, searchRoots, textureMap, depth + 1);
                } else if (entry.isFile() && /\.(dds|png|tga)$/i.test(entry.name)) {
                    // Map by bare filename (for mesh-embedded material resolution)
                    textureMap[entry.name] = this._panel.webview.asWebviewUri(vscode.Uri.file(full)).toString();
                    // Also add with forward-slash relative path from each root
                    for (const root of searchRoots) {
                        if (full.startsWith(root)) {
                            const relPath = path.relative(root, full).replace(/\\/g, '/');
                            textureMap[relPath] = this._panel.webview.asWebviewUri(vscode.Uri.file(full)).toString();
                        }
                    }
                }
            }
        } catch { /* skip inaccessible */ }
    }

    /**
     * Build a textureMap by scanning for .dds files near the mesh file.
     * Maps relative paths (e.g. "gfx/models/ships/x_diffuse.dds") to webview URIs
     * so the webview can resolve mesh-embedded material texture references.
     */
    private async _buildTextureMap(textureMap: Record<string, string>, searchRoots: string[]) {
        // Scan gfx/models directories for .dds textures, limited to avoid perf issues
        const maxTextures = 2000;
        let count = 0;
        for (const root of searchRoots) {
            const modelsDir = path.join(root, 'gfx', 'models');
            try { await fs.promises.access(modelsDir); } catch { continue; }
            await this._scanTextures(root, modelsDir, textureMap, maxTextures, () => count++, () => count);
        }
    }

    private async _scanTextures(
        rootDir: string,
        dir: string,
        textureMap: Record<string, string>,
        maxTextures: number,
        increment: () => void,
        getCount: () => number,
    ) {
        if (getCount() >= maxTextures) return;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (getCount() >= maxTextures) break;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await this._scanTextures(rootDir, full, textureMap, maxTextures, increment, getCount);
                } else if (/\.(dds|png|tga)$/i.test(entry.name)) {
                    const relPath = path.relative(rootDir, full).replace(/\\/g, '/');
                    textureMap[relPath] = this._panel.webview.asWebviewUri(vscode.Uri.file(full)).toString();
                    increment();
                }
            }
        } catch { /* skip inaccessible */ }
    }

    private async _buildEntityGraph(searchRoots: string[]): Promise<EntityGraph> {
        const assetFiles: Array<{ path: string; content: string }> = [];
        const gfxFiles: Array<{ path: string; content: string }> = [];
        const maxFiles = 1000;

        for (const root of searchRoots) {
            const gfxDir = path.join(root, 'gfx');
            try { await fs.promises.access(gfxDir); } catch { continue; }
            const signal = this._scanAbortController.signal;
            const assets = await walkFiles(gfxDir, { ext: '.asset', maxFiles, signal });
            const gfx = await walkFiles(gfxDir, { ext: '.gfx', maxFiles, signal });
            for (const file of assets) assetFiles.push({ path: file.path, content: file.content });
            for (const file of gfx) gfxFiles.push({ path: file.path, content: file.content });
        }

        // Overlay in-memory cross-file drafts so previews and cycle diagnostics
        // see the complete staged graph before Save touches any document.
        const pathKey = (filePath: string) => process.platform === 'win32'
            ? path.resolve(filePath).toLowerCase()
            : path.resolve(filePath);
        const assetIndex = new Map(assetFiles.map((file, index) => [pathKey(file.path), index]));
        for (const draft of this._draftDocuments.values()) {
            if (!matchesExt(draft.document.fileName, '.asset')) continue;
            const key = pathKey(draft.document.uri.fsPath);
            const index = assetIndex.get(key);
            const entry = { path: draft.document.uri.fsPath, content: draft.draftText };
            if (index === undefined) {
                assetIndex.set(key, assetFiles.length);
                assetFiles.push(entry);
            } else {
                assetFiles[index] = entry;
            }
        }

        return buildEntityGraph(assetFiles, gfxFiles);
    }

    private async _handlePanelClosed(): Promise<void> {
        if (this._disposed) return;
        this._panelClosed = true;
        const drafts = Array.from(this._draftDocuments.values()).filter(draft => draft.changedByPanel);
        if (drafts.length > 0) {
            const save = panelText('Save All', '全部保存');
            const discard = panelText('Discard All', '全部放弃');
            const choice = await vscode.window.showWarningMessage(
                panelText(
                    'The Entity editor was closed with unsaved changes. Save them or discard only the Entity editor changes?',
                    '实体编辑器关闭时仍有未保存更改。要保存，还是仅放弃实体编辑器产生的更改？',
                ),
                { modal: true, detail: this._draftSummary(drafts) },
                save,
                discard,
            );
            if (choice === save) await this._handleSaveDocument(true);
            if (choice === discard) await this._handleDiscardDrafts(true);
            // Dismissal leaves source documents untouched; closing the panel
            // intentionally ends the transient preview draft.
        }
        this._finalizeDispose(false);
    }

    private _finalizeDispose(disposePanel: boolean): void {
        if (this._disposed) return;
        this._disposed = true;
        EntityPanel.currentPanel = undefined;
        this._document = undefined;
        this._searchRoots = [];
        this._entityGraph = null;
        this._currentModelAnchorNames.clear();
        this._editMode = false;
        this._updateKeybindingContext();
        this._draftDocuments.clear();
        // Tell webview to clean up Three.js resources before destroying
        if (!this._panelClosed) {
            try {
                void this._panel.webview.postMessage({ command: 'dispose' });
            } catch { /* panel may already be disposed */ }
        }
        if (disposePanel && !this._panelClosed) this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    public dispose(): void {
        this._scanAbortController.abort();
        this._finalizeDispose(true);
    }

    private _getHtml(): string {
        const webview = this._panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'entityPreview.js')));
        const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'entityPreview.css')));
        const locale = vscode.env.language; // e.g. 'zh-cn', 'en'
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource}; worker-src blob:;">
    <link rel="stylesheet" href="${cssUri}">
    <title>Entity Preview</title>
</head>
<body data-locale="${locale}">
    <div id="error-banner"></div>

    <div id="toolbar">
        <span class="entity-name" data-i18n="title">Entity Preview</span>
        <select id="sel-entity" style="display:none"></select>
        <select id="sel-state" style="display:none"></select>
        <div id="mode-switch" role="group" aria-label="${locale.startsWith('zh') ? '工作模式' : 'Workspace mode'}">
            <button id="btn-preview" class="active" type="button" aria-pressed="true">${locale.startsWith('zh') ? '预览' : 'Preview'}</button>
            <button id="btn-edit" type="button" aria-pressed="false">${locale.startsWith('zh') ? '编辑' : 'Edit'}</button>
        </div>
        <div id="document-actions" class="edit-only">
            <button id="btn-save" class="toolbar-btn" type="button" disabled title="${locale.startsWith('zh') ? '保存定位器更改 (Ctrl+S)' : 'Save locator changes (Ctrl+S)'}">${locale.startsWith('zh') ? '保存' : 'Save'}</button>
            <button id="btn-discard-drafts" class="toolbar-btn secondary" type="button" disabled>${locale.startsWith('zh') ? '放弃全部' : 'Discard All'}</button>
            <span id="edit-save-state" role="status" aria-live="polite">${locale.startsWith('zh') ? '已保存' : 'Saved'}</span>
            <details id="draft-summary" class="hidden"><summary id="draft-summary-label"></summary><div id="draft-summary-files"></div></details>
        </div>
        <span class="toolbar-separator"></span>
        <button id="btn-focus" class="toolbar-icon-btn" data-i18n-title="focus"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="3"/></svg></button>
        <span class="toolbar-separator edit-only"></span>
        <button id="btn-translate" class="toolbar-icon-btn tool-mode active edit-only" data-i18n-title="translateBtn" data-mode="translate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="14,7 19,12 14,17"/><line x1="12" y1="5" x2="12" y2="19"/><polyline points="7,14 12,19 17,14"/></svg></button>
        <button id="btn-rotate" class="toolbar-icon-btn tool-mode edit-only" data-i18n-title="rotateBtn" data-mode="rotate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6"/><polyline points="21,3 21,9 15,9"/></svg></button>
        <select id="sel-transform-space" class="toolbar-compact-select edit-only" title="${locale.startsWith('zh') ? '变换坐标系' : 'Transform space'}"><option value="local" selected>${locale.startsWith('zh') ? '局部' : 'Local'}</option><option value="world">${locale.startsWith('zh') ? '世界' : 'World'}</option></select>
        <select id="sel-multi-rotation-mode" class="toolbar-compact-select edit-only" title="${locale.startsWith('zh') ? '多选旋转方式' : 'Multi-selection rotation mode'}" disabled><option value="individual" selected>${locale.startsWith('zh') ? '各自轴' : 'Self'}</option><option value="center">${locale.startsWith('zh') ? '公共中心' : 'Orbit'}</option></select>
        <label class="toolbar-checkbox-btn edit-only" title="${locale.startsWith('zh') ? '移动吸附（按住 X 临时启用）' : 'Translation snap (hold X temporarily)'}" aria-label="${locale.startsWith('zh') ? '移动吸附' : 'Translation snap'}">
            <input type="checkbox" id="chk-grid-snap">
            <div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v6a6 6 0 0 0 12 0V4M8 4v6a2 2 0 0 0 4 0V4M4 4h4M12 4h4"/><path d="M15 18h6m-3-3 3 3-3 3"/></svg></div>
        </label>
        <input id="move-snap-step" class="toolbar-number edit-only" type="number" min="0.0001" step="0.1" value="1" title="${locale.startsWith('zh') ? '移动步长' : 'Translation step'}">
        <label class="toolbar-checkbox-btn edit-only" title="${locale.startsWith('zh') ? '旋转吸附' : 'Rotation snap'}" aria-label="${locale.startsWith('zh') ? '旋转吸附' : 'Rotation snap'}"><input type="checkbox" id="chk-rotation-snap"><div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.5 8A7.5 7.5 0 1 0 20 14"/><path d="m15 5 4 3-4 3"/><path d="M12 3v2M5.6 5.6 7 7M3 12h2"/></svg></div></label>
        <input id="rotation-snap-step" class="toolbar-number edit-only" type="number" min="0.1" max="180" step="1" value="15" title="${locale.startsWith('zh') ? '旋转步长（度）' : 'Rotation step (degrees)'}">
        <label class="toolbar-checkbox-btn edit-only" title="${locale.startsWith('zh') ? '顶点吸附（按住 V 临时启用）' : 'Vertex snap (hold V temporarily)'}">
            <input type="checkbox" id="chk-vertex-snap">
            <div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 9 17H3L12 3Z"/><circle cx="12" cy="3" r="2.2" fill="currentColor" stroke="none"/><circle cx="3" cy="20" r="2.2" fill="currentColor" stroke="none"/><circle cx="21" cy="20" r="2.2" fill="currentColor" stroke="none"/></svg></div>
        </label>
        <span class="toolbar-separator"></span>
        <label class="toolbar-checkbox-btn" data-i18n-title="wireframe">
            <input type="checkbox" id="chk-wireframe">
            <div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/><line x1="12" y1="22" x2="12" y2="12"/></svg></div>
        </label>
        <label class="toolbar-checkbox-btn" data-i18n-title="locators">
            <input type="checkbox" id="chk-locators" checked>
            <div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></div>
        </label>
        <label class="toolbar-checkbox-btn" title="${locale.startsWith('zh') ? '显示 Mesh 自带定位器' : 'Show mesh locators'}">
            <input type="checkbox" id="chk-mesh-locators" checked>
            <div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2 3.5 6.5 12 11l8.5-4.5L12 2Z"/><path d="M3.5 6.5V16L12 21l8.5-5V6.5M12 11v10"/><circle cx="12" cy="11" r="2.2" fill="currentColor" stroke="none"/></svg></div>
        </label>
        <label class="toolbar-checkbox-btn" data-i18n-title="bones">
            <input type="checkbox" id="chk-bones">
            <div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg></div>
        </label>
        <label class="toolbar-checkbox-btn" data-i18n-title="disableNormals">
            <input type="checkbox" id="chk-normals">
            <div class="icon-btn-content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></div>
        </label>
    </div>

    <div id="main-content">
        <div id="entity-tree"></div>
        <div id="sidebar-resize"></div>
        <div id="canvas-container">
            <div id="loading-overlay">
                <div class="spinner"></div>
                <div class="progress-text" data-i18n="loading">Loading...</div>
                <div class="progress-bar"><div class="progress-bar-fill"></div></div>
            </div>
            <div id="empty-state">
                <div class="empty-icon">📦</div>
                <div class="empty-text" data-i18n="noEntity">No entity loaded</div>
                <div class="empty-hint" data-i18n="openHint">Open a .asset file and click preview</div>
            </div>
            <div id="transform-hint" class="hidden"></div>
            <div id="orientation-gizmo" title="${locale.startsWith('zh') ? '世界坐标轴方向' : 'World axis orientation'}" aria-label="${locale.startsWith('zh') ? '世界坐标轴方向' : 'World axis orientation'}">
                <svg viewBox="0 0 76 76" aria-hidden="true">
                    <circle class="orientation-center" cx="38" cy="38" r="3"></circle>
                    <g id="orientation-axis-x"><line x1="38" y1="38" x2="62" y2="38"></line><circle cx="62" cy="38" r="3"></circle><text x="68" y="41">X</text></g>
                    <g id="orientation-axis-y"><line x1="38" y1="38" x2="38" y2="14"></line><circle cx="38" cy="14" r="3"></circle><text x="38" y="9">Y</text></g>
                    <g id="orientation-axis-z"><line x1="38" y1="38" x2="20" y2="54"></line><circle cx="20" cy="54" r="3"></circle><text x="14" y="62">Z</text></g>
                </svg>
                <span>${locale.startsWith('zh') ? '世界' : 'WORLD'}</span>
            </div>
            <div id="selection-marquee"></div>
            <div id="locator-selection-actions" class="hidden">
                <span id="locator-selection-count"></span>
                <button class="toolbar-btn secondary" id="btn-paste-selected-transform">${locale.startsWith('zh') ? '粘贴变换' : 'Paste Transform'}</button>
                <button class="toolbar-btn secondary" id="btn-origin-selected-locators">${locale.startsWith('zh') ? '位置归零' : 'To Origin'}</button>
                <button class="toolbar-btn secondary" id="btn-hide-selected-locators" title="${locale.startsWith('zh') ? 'H 隐藏，Shift+H 恢复最近隐藏项' : 'H to hide; Shift+H restores the last hidden selection'}">${locale.startsWith('zh') ? '隐藏' : 'Hide'}</button>
                <button class="toolbar-btn danger" id="btn-delete-selected-locators" title="Delete">${locale.startsWith('zh') ? '删除' : 'Delete'}</button>
                <button class="props-close" id="btn-clear-locator-selection">&times;</button>
            </div>

            <div id="context-menu">
                <div class="ctx-menu-item" id="ctx-add-locator"><span class="ctx-icon">📌</span><span>${locale.startsWith('zh') ? '新建定位器' : 'Add Locator'}</span></div>
            </div>

            <div id="properties-panel" class="hidden">
                <div class="props-header">
                    <span class="props-title">Properties</span>
                    <span class="props-name" id="props-locator-name"></span>
                    <button class="props-close" id="btn-props-close">&times;</button>
                </div>
                <div class="props-body">
                    <div id="props-locator-source" class="props-source"></div>
                    <div class="props-row"><label>${locale.startsWith('zh') ? '名称' : 'Name'}</label><input type="text" id="prop-locator-rename"><button class="toolbar-btn compact" id="btn-rename-locator">${locale.startsWith('zh') ? '重命名' : 'Rename'}</button></div>
                    <div class="props-row"><label>Position X</label><input type="number" step="0.1" id="prop-px"></div>
                    <div class="props-row"><label>Position Y</label><input type="number" step="0.1" id="prop-py"></div>
                    <div class="props-row"><label>Position Z</label><input type="number" step="0.1" id="prop-pz"></div>
                    <div class="props-row"><label>Rotation X</label><input type="number" step="1" id="prop-rx"></div>
                    <div class="props-row"><label>Rotation Y</label><input type="number" step="1" id="prop-ry"></div>
                    <div class="props-row"><label>Rotation Z</label><input type="number" step="1" id="prop-rz"></div>
                    <div class="props-row" style="position:relative"><label>${locale.startsWith('zh') ? '挂载实体' : 'Attach'}</label><input type="text" id="prop-attach-entity" autocomplete="off" placeholder="${locale.startsWith('zh') ? '(无)' : '(none)'}"></div>
                    <div id="prop-autocomplete-list" class="autocomplete-dropdown"></div>
                    <div class="attach-manager-actions">
                        <button class="toolbar-btn" id="btn-set-attach">${locale.startsWith('zh') ? '设置/替换' : 'Set / Replace'}</button>
                        <button class="toolbar-btn secondary" id="btn-clear-attach">${locale.startsWith('zh') ? '清除' : 'Clear'}</button>
                        <button class="toolbar-btn secondary" id="btn-open-attach-entity">${locale.startsWith('zh') ? '跳转定义' : 'Open Definition'}</button>
                    </div>
                    <div id="attach-diagnostic" class="attach-diagnostic hidden" role="status"></div>
                    <div class="static-transform-note">${locale.startsWith('zh') ? '模型 Locator/Bone 的变换只读；切换到编辑模式后仍可设置 Attach。复制其变换只会写入静态定位器，不会建立动态绑定。' : 'Model Locator/Bone transforms are read-only; Attach remains editable in Edit mode. Copying their transform writes only a static locator value and does not create a dynamic binding.'}</div>
                    <div class="props-actions">
                        <button class="toolbar-btn secondary props-action-leading" id="btn-special-duplicate" title="${locale.startsWith('zh') ? '特殊复制 (Ctrl+Shift+D)' : 'Duplicate Special (Ctrl+Shift+D)'}">${locale.startsWith('zh') ? '特殊复制…' : 'Duplicate…'}</button>
                        <button class="toolbar-btn secondary" id="btn-copy-transform">${locale.startsWith('zh') ? '复制变换' : 'Copy Transform'}</button>
                        <button class="toolbar-btn secondary" id="btn-paste-transform">${locale.startsWith('zh') ? '粘贴变换' : 'Paste Transform'}</button>
                        <button class="toolbar-btn secondary" id="btn-origin-locator">${locale.startsWith('zh') ? '位置归零' : 'To Origin'}</button>
                        <button class="toolbar-btn" id="btn-apply" data-i18n="apply">Apply</button>
                        <button class="toolbar-btn secondary" id="btn-reset" data-i18n="reset">Reset</button>
                    </div>
                </div>
            </div>

            <div id="add-locator-panel" class="hidden">
                <div class="props-header">
                    <span class="props-title">${locale.startsWith('zh') ? '新建定位器' : 'Add Locator'}</span>
                    <button class="props-close" id="btn-add-locator-close">&times;</button>
                </div>
                <div class="props-body">
                    <div class="props-row"><label>${locale.startsWith('zh') ? '名称' : 'Name'}</label><input type="text" id="add-loc-name" placeholder="locator_name"></div>
                    <div class="props-row" style="position:relative"><label>${locale.startsWith('zh') ? '挂载实体' : 'Attach'}</label><input type="text" id="add-loc-entity" autocomplete="off" placeholder="${locale.startsWith('zh') ? '(可选)' : '(optional)'}"></div>
                    <div id="autocomplete-list" class="autocomplete-dropdown"></div>
                    <div class="props-actions">
                        <button class="toolbar-btn" id="btn-add-loc-confirm">${locale.startsWith('zh') ? '确认' : 'Confirm'}</button>
                        <button class="toolbar-btn secondary" id="btn-add-loc-cancel">${locale.startsWith('zh') ? '取消' : 'Cancel'}</button>
                    </div>
                </div>
            </div>

            <div id="special-duplicate-panel" class="hidden">
                <div class="props-header">
                    <span class="props-title">${locale.startsWith('zh') ? '特殊复制' : 'Duplicate Special'}</span>
                    <span class="props-name" id="duplicate-source-name"></span>
                    <button class="props-close" id="btn-special-duplicate-close">&times;</button>
                </div>
                <div class="props-body">
                    <div class="props-row"><label>${locale.startsWith('zh') ? '副本数' : 'Copies'}</label><input type="number" min="1" max="100" step="1" value="1" id="duplicate-copies"></div>
                    <div class="duplicate-section-label">${locale.startsWith('zh') ? '位置间隔' : 'Position step'}</div>
                    <div class="props-row"><label>Position <span class="axis-x">X</span></label><input type="number" step="0.1" value="0" id="duplicate-tx"></div>
                    <div class="props-row"><label>Position <span class="axis-y">Y</span></label><input type="number" step="0.1" value="0" id="duplicate-ty"></div>
                    <div class="props-row"><label>Position <span class="axis-z">Z</span></label><input type="number" step="0.1" value="0" id="duplicate-tz"></div>
                    <div class="duplicate-section-label">${locale.startsWith('zh') ? '旋转间隔（度）' : 'Rotation step (degrees)'}</div>
                    <div class="props-row"><label>Rotation <span class="axis-x">X</span></label><input type="number" step="1" value="0" id="duplicate-rx"></div>
                    <div class="props-row"><label>Rotation <span class="axis-y">Y</span></label><input type="number" step="1" value="0" id="duplicate-ry"></div>
                    <div class="props-row"><label>Rotation <span class="axis-z">Z</span></label><input type="number" step="1" value="0" id="duplicate-rz"></div>
                    <label class="duplicate-checkbox" title="${locale.startsWith('zh') ? '旋转副本的位置，形成以模型原点为中心的环形阵列' : 'Rotate copied positions to form an array around the model origin'}">
                        <input type="checkbox" id="duplicate-orbit">
                        <span>${locale.startsWith('zh') ? '绕模型原点旋转位置' : 'Orbit position around model origin'}</span>
                    </label>
                    <div class="duplicate-help">${locale.startsWith('zh') ? '每个副本在前一项基础上累加间隔；挂载实体会一并复制。' : 'Steps accumulate per copy; the attached entity is copied too.'}</div>
                    <div class="duplicate-preview" id="duplicate-preview"></div>
                    <div class="props-actions duplicate-actions">
                        <button class="toolbar-btn" id="btn-special-duplicate-confirm">${locale.startsWith('zh') ? '复制' : 'Duplicate'}</button>
                        <button class="toolbar-btn secondary" id="btn-special-duplicate-cancel">${locale.startsWith('zh') ? '取消' : 'Cancel'}</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div id="timeline" style="display:none">
        <button id="btn-anim-play" class="timeline-btn" title="${locale.startsWith('zh') ? '播放/暂停（Space）' : 'Play/Pause (Space)'}">▶</button>
        <input type="range" id="anim-scrub" min="0" max="1000" value="0" class="timeline-scrub">
        <span id="anim-time" class="timeline-time">0.0 / 0.0s</span>
        <button id="btn-anim-loop" class="timeline-btn" title="Loop"><svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.08 4.79l2.84-2.85.71.71-1.63 1.63h6.64a2.91 2.91 0 0 1 2.9 2.9v4.28h-1V7.18a1.91 1.91 0 0 0-1.9-1.9H4.01l1.62 1.62-.7.7-2.85-2.81zm11.84 6.42l-2.84 2.85-.71-.71 1.63-1.63H5.36a2.91 2.91 0 0 1-2.9-2.9V4.54h1v4.28a1.91 1.91 0 0 0 1.9 1.9h6.63l-1.62-1.62.7-.7 2.85 2.81z"/></svg></button>
        <button id="btn-anim-speed" class="timeline-btn" title="Speed">1x</button>
    </div>
    <div id="info-panel"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
