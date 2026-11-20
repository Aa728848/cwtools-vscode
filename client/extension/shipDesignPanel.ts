import * as path from 'path';
import * as vscode from 'vscode';
import { ErrorReporter } from './ai/errorReporter';
import { localize } from './panelI18n';
import { shipDesignErrorText } from './shipDesign/messages';
import { isPathInsideOrEqual } from './pathScope';
import { isGlobalShipDesignPath } from './visualEditorSafety';
import { loadEnvironmentPresets } from './worldgfxPresets';
import type { IndexService } from './indexing/indexService';
import { getDefaultLocalisationLanguagesForUiLocale, getPreferredLocalisationLanguageTags } from './localisationLanguagePreference';
import { resolveShipDesignDisplayNames, type ShipDesignLocalisationCache } from './shipDesign/localisation';
import {
    collectWorkspaceRoots,
    LayeredShipIconDataSource,
    resolveVanillaGamePath,
} from './shipIconCommand';
import {
    applyShipDesignOperation,
    parseShipDesignDocument,
    ShipDesignDraftSession,
    ShipDesignEditError,
    type ShipDesignEditResult,
} from './shipDesign/designDocument';
import { loadShipDesignCatalog, lookupShipDesignComponent, type ShipDesignCatalog, type ShipDesignComponentDefinition } from './shipDesign/definitions';
import { generateShipDesignDraft } from './shipDesign/generator';
import { ShipDesignResourceLoader, shipDesignContentOrigin } from './shipDesign/resources';
import { ShipDesignSpriteResolver, resolveShipDesignViewIcons } from './shipDesign/sprites';
import {
    buildShipDesignView,
    buildShipDesignRequiredSlots,
    fillShipDesignSlots,
    replaceShipDesignRequiredComponent,
    shipDesignComponentCandidates,
    shipDesignComponentTiers,
    shipDesignRequiredCandidates,
    shipDesignRequiredCompatibility,
    shipDesignDropCompatibility,
    shipDesignPlaceableSlotIds,
    shipDesignSectionCandidates,
} from './shipDesign/slots';
import { computeShipDesignStats } from './shipDesign/stats';
import {
    parseShipDesignRequest,
    shipDesignModelNodeKeys,
    type ShipDesignOperation,
    type ShipDesignRequest,
    type ShipDesignResponse,
    type ShipDesignViewData,
} from '../shared/shipDesignProtocol';

function compareNames(left: string, right: string): number {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    if (a !== b) return a < b ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

function localizedCandidateLabel(key: string, names: ReadonlyMap<string, string>): string {
    return names.get(key) || key;
}

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index++) value += chars[Math.floor(Math.random() * chars.length)] ?? 'A';
    return value;
}

export class ShipDesignPanel {
    public static currentPanel: ShipDesignPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly document: vscode.TextDocument;
    private readonly source: LayeredShipIconDataSource;
    private readonly indexService?: IndexService;
    private readonly extensionPath: string;
    private workspaceDesignsPromise: Promise<void> | undefined;
    private readonly localisationCache: ShipDesignLocalisationCache = { languages: new Map() };
    private readonly webviewRootPath: string;
    private resourceLoader: ShipDesignResourceLoader;
    private spriteResolver: ShipDesignSpriteResolver;
    private catalogPromise: Promise<ShipDesignCatalog> | undefined;
    private selectedDesignId: string | undefined;
    private previewCulture: string | undefined;
    private generation = 0;
    /** Node keys whose assets the current Webview scene has received; see `shipDesignModelNodeKeys`. */
    private sentModelAssets = new Map<string, string>();
    /** Must match the Webview scene identity; a different design or revision forces a full rebuild there. */
    private sentModelIdentity: string | undefined;
    private assetRevision = 0;
    private queue: Promise<void> = Promise.resolve();
    private readonly draft: ShipDesignDraftSession;
    private applyingEdit = false;
    private saving = false;
    private disposed = false;
    private readonly disposables: vscode.Disposable[] = [];

    public static async create(extensionPath: string, document: vscode.TextDocument, indexService?: IndexService, selectedDesignId?: string): Promise<void> {
        if (document.uri.scheme !== 'file' || !collectWorkspaceRoots().some(root => isPathInsideOrEqual(document.uri.fsPath, root))) {
            void vscode.window.showWarningMessage(localize(
                'Ship design visual editing is available only for documents inside the current workspace.',
                '舰船设计可视化编辑仅适用于当前工作区内的文档。',
            ));
            return;
        }
        if (this.currentPanel?.document.uri.toString() === document.uri.toString()) {
            if (selectedDesignId) this.currentPanel.selectedDesignId = selectedDesignId;
            this.currentPanel.panel.reveal();
            await this.currentPanel.refresh();
            return;
        }
        this.currentPanel?.dispose();
        this.currentPanel = new ShipDesignPanel(extensionPath, document, indexService);
        this.currentPanel.selectedDesignId = selectedDesignId;
        await this.currentPanel.refresh();
    }

    private constructor(extensionPath: string, document: vscode.TextDocument, indexService?: IndexService) {
        this.document = document;
        this.indexService = indexService;
        this.extensionPath = extensionPath;
        this.draft = new ShipDesignDraftSession(document.getText());
        const roots = collectWorkspaceRoots();
        const vanilla = resolveVanillaGamePath();
        this.source = new LayeredShipIconDataSource(roots, vanilla ?? '');
        this.spriteResolver = new ShipDesignSpriteResolver(this.source);
        this.webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        const localResourceRoots = [
            vscode.Uri.file(this.webviewRootPath),
            ...roots.map(root => vscode.Uri.file(root)),
            ...vanilla ? [vscode.Uri.file(vanilla)] : [],
        ];
        this.panel = vscode.window.createWebviewPanel(
            'cwtoolsShipDesign',
            'Ship Design: ' + path.basename(document.fileName),
            vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots,
            },
        );
        this.resourceLoader = this.createResourceLoader();
        this.panel.webview.html = this.html(this.panel.webview, this.webviewRootPath);
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
        this.panel.webview.onDidReceiveMessage((raw: unknown) => {
            this.queue = this.queue.then(() => this.receive(raw)).catch(error => {
                ErrorReporter.warn('ShipDesignPanel', 'Webview request failed', error);
                this.post({ type: 'error', message: shipDesignErrorText(error, localize) });
            });
        }, undefined, this.disposables);
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== this.document || this.applyingEdit || this.disposed) return;
            this.workspaceDesignsPromise = undefined;
            if (!this.draft.externalChange(this.document.getText())) {
                this.post({ type: 'error', message: localize(
                    'The source document changed outside the workbench. Your draft is preserved; discard it to adopt the external contents.',
                    '源文档已在工作台外修改。草稿已保留；放弃草稿即可采用外部内容。',
                ) });
                return;
            }
            void this.refresh();
        }, undefined, this.disposables);
        vscode.workspace.onDidSaveTextDocument(savedDocument => {
            if (savedDocument === this.document) {
                const savedText = this.document.getText();
                if (this.draft.text === savedText) this.draft.markSaved();
                else if (!this.draft.externalChange(savedText)) {
                    this.post({ type: 'error', message: localize(
                        'The saved source differs from the workbench draft. Your draft is preserved; discard it to adopt the saved contents.',
                        '已保存的源文件与工作台草稿不一致。草稿已保留；放弃草稿即可采用已保存的内容。',
                    ) });
                }
                this.postDocumentState(this.draft.text === savedText);
            }
            const lower = savedDocument.fileName.toLowerCase();
            if (savedDocument === this.document || /[\\/](?:common|gfx|localisation|localization)[\\/]/.test(lower)) {
                this.workspaceDesignsPromise = undefined;
                this.localisationCache.languages.clear();
                this.catalogPromise = undefined;
                this.resourceLoader = this.createResourceLoader();
                this.spriteResolver = new ShipDesignSpriteResolver(this.source);
                this.resetModelAssets();
            }
            void this.refresh();
        }, undefined, this.disposables);
    }

    private async sendEnvironments(): Promise<void> {
        try {
            const roots = collectWorkspaceRoots();
            const vanilla = resolveVanillaGamePath();
            const searchRoots = [...roots, ...vanilla ? [vanilla] : []];
            const presets = loadEnvironmentPresets(searchRoots, absolute =>
                this.panel.webview.asWebviewUri(vscode.Uri.file(absolute)).toString());
            const workerUri = this.panel.webview.asWebviewUri(
                vscode.Uri.file(path.join(this.webviewRootPath, 'skyboxEnvWorker.js'))).toString();
            this.post({ type: 'environments', presets, workerUri });
        } catch (error) {
            ErrorReporter.warn('ShipDesignPanel', 'Unable to load worldgfx environments', error);
        }
    }

    private createResourceLoader(): ShipDesignResourceLoader {
        return new ShipDesignResourceLoader(this.source, absolute =>
            this.panel.webview.asWebviewUri(vscode.Uri.file(absolute)).toString());
    }

    private post(message: ShipDesignResponse): void {
        if (!this.disposed) void this.panel.webview.postMessage(message);
    }

    private preferredLocalisationTags(): string[] {
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
        const inspected = config.inspect<string[]>('localisation.languages');
        const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
        const languages = configured && configured.length > 0
            ? configured
            : getDefaultLocalisationLanguagesForUiLocale(vscode.env.language);
        return getPreferredLocalisationLanguageTags(languages);
    }

    private displayNames(ids: readonly string[]): Promise<Map<string, string>> {
        return resolveShipDesignDisplayNames({
            source: this.source,
            ids,
            preferredTags: this.preferredLocalisationTags(),
            indexService: this.indexService,
            cache: this.localisationCache,
        });
    }

    private catalog(): Promise<ShipDesignCatalog> {
        if (!this.catalogPromise) {
            this.originCache.clear();
            this.catalogPromise = loadShipDesignCatalog(this.source);
        }
        return this.catalogPromise;
    }

    private readonly originCache = new Map<string, 'vanilla' | 'mod' | undefined>();

    /** Bounded by the number of component definition files; reset with the catalog. */
    private componentOrigin(component: ShipDesignComponentDefinition): 'vanilla' | 'mod' | undefined {
        const file = component.sourceFile;
        if (!file) return undefined;
        const folded = file.toLowerCase();
        if (!this.originCache.has(folded)) {
            this.originCache.set(folded, shipDesignContentOrigin(this.source.resolvePath(file), collectWorkspaceRoots()));
        }
        return this.originCache.get(folded);
    }

    private parsed() {
        return parseShipDesignDocument(this.draft.text);
    }

    private selectedDesign() {
        const parsed = this.parsed();
        return parsed.designs.find(design => design.id === this.selectedDesignId) ?? parsed.designs[0];
    }

    private isDirty(): boolean {
        return this.document.isDirty || this.draft.dirty;
    }

    public get dirtyDocumentState(): { uri: vscode.Uri; isDirty: boolean } {
        return { uri: this.document.uri, isDirty: this.isDirty() };
    }

    private postDocumentState(saved = false): void {
        this.post({
            type: 'document-state',
            dirty: this.isDirty(),
            saving: this.saving,
            saved,
            canUndo: this.draft.canUndo,
            canRedo: this.draft.canRedo,
        });
    }

    private async refresh(): Promise<void> {
        if (this.disposed) return;
        const generation = ++this.generation;
        const parsed = this.parsed();
        if (!parsed.designs.some(design => design.id === this.selectedDesignId)) {
            this.selectedDesignId = parsed.designs[0]?.id;
        }
        this.post({
            type: 'snapshot',
            snapshot: {
                documentVersion: this.draft.version,
                generation,
                designs: parsed.designs,
                selectedDesignId: this.selectedDesignId,
                diagnostics: parsed.diagnostics,
                dirty: this.isDirty(),
                saving: this.saving,
                canUndo: this.draft.canUndo,
                canRedo: this.draft.canRedo,
            },
        });
        const design = this.selectedDesign();
        if (!design) return;
        try {
            const catalog = await this.catalog();
            if (this.disposed || generation !== this.generation) return;
            const view = buildShipDesignView(catalog, design, this.previewCulture);
            view.assetRevision = this.assetRevision;
            await resolveShipDesignViewIcons(view, catalog, this.spriteResolver);
            if (this.disposed || generation !== this.generation) return;
            this.post({ type: 'view', view });
            this.post({ type: 'stats', stats: computeShipDesignStats(catalog, design) });
            await this.postCatalogOptions(catalog, view);
            await this.postWorkspaceDesigns();
            if (this.disposed || generation !== this.generation) return;
            await this.postModelAssets(view, generation);
        } catch (error) {
            if (generation !== this.generation) return;
            ErrorReporter.warn('ShipDesignPanel', 'Unable to build ship design view', error);
            this.post({ type: 'error', message: shipDesignErrorText(error, localize) });
        }
    }

    private async postCatalogOptions(catalog: ShipDesignCatalog, view: ShipDesignViewData): Promise<void> {
        const shipSizes = new Set<string>([...catalog.base.shipSizes.keys(), ...catalog.shipSizeDetails.keys()]);
        const designNames = this.parsed().designs.map(design => design.name);
        const sectionNames = view.sections.map(section => section.section.template);
        const componentNames = view.sections.flatMap(section => section.slots.map(slot => slot.selected ?? ''));
        const displayNames = await this.displayNames([
            ...shipSizes, ...designNames, ...sectionNames, ...componentNames, view.shipSize,
        ]);
        this.post({
            type: 'catalog-options',
            shipSizes: [...shipSizes].sort(compareNames),
            roles: catalog.roles,
            cultures: view.cultures,
            technologies: [...catalog.technologies.keys()].sort(compareNames),
            displayNames: Object.fromEntries(displayNames),
        });
    }

    private postWorkspaceDesigns(): Promise<void> {
        if (!this.workspaceDesignsPromise) this.workspaceDesignsPromise = this.loadWorkspaceDesigns().catch(error => {
            this.workspaceDesignsPromise = undefined;
            throw error;
        });
        return this.workspaceDesignsPromise;
    }

    private async loadWorkspaceDesigns(): Promise<void> {
        const uris = await vscode.workspace.findFiles(
            '**/common/global_ship_designs/*.txt',
            '**/{node_modules,.git,artifacts}/**',
            128,
        );
        uris.sort((left, right) => compareNames(left.toString(), right.toString()));
        const designs: Array<{ uri: string; designId: string; name: string; filePath: string; selected: boolean; current: boolean }> = [];
        for (const uri of uris) {
            const document = uri.toString() === this.document.uri.toString()
                ? this.document
                : await vscode.workspace.openTextDocument(uri);
            for (const design of parseShipDesignDocument(document.getText()).designs) {
                if (designs.length >= 512) break;
                designs.push({
                    uri: uri.toString(),
                    designId: design.id,
                    name: design.name,
                    filePath: vscode.workspace.asRelativePath(uri, false),
                    selected: uri.toString() === this.document.uri.toString() && design.id === this.selectedDesignId,
                    current: uri.toString() === this.document.uri.toString(),
                });
            }
        }
        const names = await this.displayNames(designs.map(design => design.name));
        this.post({
            type: 'workspace-designs',
            designs: designs.map(design => ({
                ...design,
                displayName: names.get(design.name) || design.name || design.filePath,
            })),
        });
    }

    private resetModelAssets(): void {
        this.sentModelAssets = new Map();
        this.assetRevision++;
    }

    /**
     * Sends assets only for nodes whose composite key the Webview has not received yet. The scene
     * keeps settled nodes with unchanged keys, so a component swap transfers one entity instead of
     * the whole ship. A node is recorded only after its message is posted for the current generation.
     */
    private async postModelAssets(view: ShipDesignViewData, generation: number): Promise<void> {
        const keys = shipDesignModelNodeKeys(view.model);
        const identity = JSON.stringify([view.designId, view.assetRevision ?? 0]);
        const previous = identity === this.sentModelIdentity ? this.sentModelAssets : new Map<string, string>();
        this.sentModelIdentity = identity;
        const sent = new Map<string, string>();
        for (const node of view.model) {
            const key = keys.get(node.id);
            if (key !== undefined && previous.get(node.id) === key) sent.set(node.id, key);
        }
        this.sentModelAssets = sent;
        for (const node of view.model) {
            const key = keys.get(node.id);
            if (!node.entityName || key === undefined || sent.get(node.id) === key) continue;
            try {
                const resolved = await this.resourceLoader.load(node.entityName);
                if (this.disposed || generation !== this.generation) return;
                this.post({ type: 'model-asset', generation, nodeId: node.id, asset: resolved.asset });
            } catch (error) {
                if (this.disposed || generation !== this.generation) return;
                this.post({
                    type: 'model-asset',
                    generation,
                    nodeId: node.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            sent.set(node.id, key);
        }
    }

    private assertVersion(expectedVersion: number): void {
        this.draft.assertVersion(expectedVersion);
    }

    private async writeDocument(target: string): Promise<void> {
        const before = this.document.getText();
        if (before === target) return;
        let start = 0;
        while (start < before.length && start < target.length && before[start] === target[start]) start++;
        let beforeEnd = before.length;
        let targetEnd = target.length;
        while (beforeEnd > start && targetEnd > start && before[beforeEnd - 1] === target[targetEnd - 1]) {
            beforeEnd--;
            targetEnd--;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, new vscode.Range(
            this.document.positionAt(start),
            this.document.positionAt(beforeEnd),
        ), target.slice(start, targetEnd));
        this.applyingEdit = true;
        try {
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) throw new ShipDesignEditError('edit-rejected', 'VS Code rejected the source edit.');
        } finally {
            this.applyingEdit = false;
        }
    }

    private applyResult(result: ShipDesignEditResult): void {
        this.draft.apply(result.text);
    }

    private async applyOperation(operation: ShipDesignOperation): Promise<void> {
        this.workspaceDesignsPromise = undefined;
        if (operation.kind === 'drop-component') {
            const design = this.parsed().designs.find(candidate => candidate.id === operation.sectionId.split('/')[0]);
            if (!design) throw new ShipDesignEditError('design-not-found', 'The selected design no longer exists.');
            const catalog = await this.catalog();
            const view = buildShipDesignView(catalog, design, this.previewCulture);
            const slot = view.sections.flatMap(section => section.slots).find(candidate =>
                candidate.sectionId === operation.sectionId && candidate.name.toLowerCase() === operation.slot.toLowerCase());
            if (!slot) throw new ShipDesignEditError('slot-not-found', 'The drop target no longer exists.');
            const component = lookupShipDesignComponent(catalog, operation.template);
            if (!component) throw new ShipDesignEditError('component-not-found', 'The dragged component no longer exists.');
            const compatibility = shipDesignDropCompatibility(catalog, design, slot, component);
            if (!compatibility.compatible) {
                throw new ShipDesignEditError('incompatible-drop', compatibility.reasons.join(' ') || 'This component cannot be dropped into the slot.');
            }
            await this.applyResult(applyShipDesignOperation(this.draft.text, {
                kind: 'set-component',
                sectionId: operation.sectionId,
                slot: operation.slot,
                template: operation.template,
            }));
            return;
        }
        if (operation.kind === 'set-required-component') {
            const design = this.parsed().designs.find(candidate => candidate.id === operation.designId);
            if (!design) throw new ShipDesignEditError('design-not-found', 'The selected design no longer exists.');
            const catalog = await this.catalog();
            const slot = buildShipDesignRequiredSlots(catalog, design).find(candidate => candidate.id === operation.slotId);
            if (!slot?.editable) throw new ShipDesignEditError('slot-not-found', 'The required component slot no longer exists.');
            const component = lookupShipDesignComponent(catalog, operation.template);
            if (!component) throw new ShipDesignEditError('component-not-found', 'The dragged component no longer exists.');
            const compatibility = shipDesignRequiredCompatibility(catalog, design, slot, component);
            if (!compatibility.compatible) {
                throw new ShipDesignEditError('incompatible-drop', compatibility.reasons.join(' ') || 'This component cannot be used for the required slot.');
            }
            this.applyResult(applyShipDesignOperation(this.draft.text, {
                kind: 'set-required-components',
                designId: design.id,
                components: replaceShipDesignRequiredComponent(design, slot, component.key),
            }));
            return;
        }
        if (operation.kind === 'fill-empty-slots') {
            const design = this.parsed().designs.find(candidate => candidate.id === operation.designId);
            if (!design) throw new ShipDesignEditError('design-not-found', 'The selected design no longer exists.');
            const catalog = await this.catalog();
            const fill = fillShipDesignSlots(catalog, design, operation.componentKey, { replaceEquipped: operation.replaceEquipped === true });
            let text = this.draft.text;
            for (const item of fill.operations) text = applyShipDesignOperation(text, item).text;
            this.draft.apply(text);
            this.post({
                type: 'generation-explanation',
                designId: operation.designId,
                lines: [
                    operation.replaceEquipped
                        ? localize('Filled ' + fill.filledSlotIds.length + ' compatible slot(s).', '已填充 ' + fill.filledSlotIds.length + ' 个兼容槽位。')
                        : localize('Filled ' + fill.filledSlotIds.length + ' compatible empty slot(s).', '已填充 ' + fill.filledSlotIds.length + ' 个兼容空槽位。'),
                ],
            });
            return;
        }
        const result = applyShipDesignOperation(this.draft.text, operation);
        await this.applyResult(result);
        if (operation.kind === 'create-design' || operation.kind === 'duplicate-design') {
            const name = operation.kind === 'create-design' ? operation.name : operation.newName;
            this.selectedDesignId = this.parsed().designs.find(design => design.name === name)?.id;
        } else if (operation.kind === 'delete-design' && operation.designId === this.selectedDesignId) {
            this.selectedDesignId = undefined;
        }
    }

    private async receive(raw: unknown): Promise<void> {
        const request = parseShipDesignRequest(raw);
        if (!request) {
            this.post({ type: 'error', message: localize('Invalid ship design workbench message.', '舰船设计工作台消息无效。') });
            return;
        }
        switch (request.type) {
            case 'ready':
                // A (re)loaded Webview has an empty scene and must receive every model asset.
                this.sentModelAssets = new Map();
                await this.sendEnvironments();
                await this.refresh();
                return;
            case 'select-design':
                this.selectedDesignId = request.designId;
                this.workspaceDesignsPromise = undefined;
                await this.refresh();
                return;
            case 'open-workspace-design': {
                const target = vscode.Uri.parse(request.uri, true);
                if (target.scheme !== 'file' || !isGlobalShipDesignPath(target.fsPath)
                    || !collectWorkspaceRoots().some(root => isPathInsideOrEqual(target.fsPath, root))) {
                    throw new ShipDesignEditError('invalid-workspace-design', 'The requested design is outside the workspace global_ship_designs directories.');
                }
                if (target.toString() !== this.document.uri.toString() && this.isDirty()) {
                    const choice = await vscode.window.showWarningMessage(
                        localize('The current workbench has an unsaved draft. Switching will discard this draft.', '当前工作台有未保存草稿，切换将放弃该草稿。'),
                        { modal: true },
                        localize('Switch', '切换'),
                    );
                    if (!choice) return;
                }
                const document = await vscode.workspace.openTextDocument(target);
                if (!parseShipDesignDocument(document.getText()).designs.some(design => design.id === request.designId)) {
                    throw new ShipDesignEditError('design-not-found', 'The requested workspace design no longer exists.');
                }
                await ShipDesignPanel.create(this.extensionPath, document, this.indexService, request.designId);
                return;
            }
            case 'set-preview-culture':
                this.previewCulture = request.culture;
                await this.refresh();
                return;
            case 'apply-operation':
                this.assertVersion(request.expectedVersion);
                await this.applyOperation(request.operation);
                await this.refresh();
                return;
            case 'generate-draft':
                await this.generateDraft(request);
                return;
            case 'request-slot-candidates':
                await this.sendSlotCandidates(request);
                return;
            case 'request-section-candidates':
                await this.sendSectionCandidates(request);
                return;
            case 'request-required-candidates':
                await this.sendRequiredCandidates(request);
                return;
            case 'request-compatible-slots':
                await this.sendCompatibleSlots(request);
                return;
            case 'undo':
                await this.undo();
                return;
            case 'redo':
                await this.redo();
                return;
            case 'save': {
                this.draft.assertEditable();
                this.saving = true;
                this.postDocumentState();
                let saved = false;
                try {
                    await this.writeDocument(this.draft.text);
                    saved = await this.document.save();
                    if (!saved) throw new Error('VS Code could not save the ship design document.');
                    this.draft.markSaved();
                } finally {
                    this.saving = false;
                    this.postDocumentState(saved);
                }
                return;
            }
            case 'discard':
                this.draft.discard(this.draft.hasConflict ? this.document.getText() : undefined);
                await this.refresh();
                return;
            case 'open-source': {
                const design = this.parsed().designs.find(candidate => candidate.id === request.designId);
                if (!design) return;
                const source = request.range ?? design.source;
                const start = Math.max(0, Math.min(source.start, this.document.getText().length));
                const end = Math.max(start, Math.min(source.end, this.document.getText().length));
                await vscode.window.showTextDocument(this.document, {
                    viewColumn: vscode.ViewColumn.Beside,
                    selection: new vscode.Range(this.document.positionAt(start), this.document.positionAt(end)),
                });
                return;
            }
        }
    }

    private async generateDraft(request: Extract<ShipDesignRequest, { type: 'generate-draft' }>): Promise<void> {
        this.assertVersion(request.expectedVersion);
        const design = this.parsed().designs.find(candidate => candidate.id === request.designId);
        if (!design) throw new ShipDesignEditError('design-not-found', 'The selected design no longer exists.');
        const catalog = await this.catalog();
        const result = generateShipDesignDraft(catalog, design, request.options, localize);
        if (result.sections.length === 0 && result.warnings.length > 0) {
            this.post({ type: 'error', message: result.warnings[0] ?? localize('No ship loadout could be generated.', '无法生成舰船配装。') });
            return;
        }
        await this.applyResult(applyShipDesignOperation(this.draft.text, {
            kind: 'replace-loadout',
            designId: design.id,
            sections: result.sections,
            requiredComponents: result.requiredComponents,
            autoGenerated: true,
        }));
        this.post({
            type: 'generation-explanation',
            designId: design.id,
            lines: result.explanations,
        });
        await this.refresh();
    }

    private async sendSlotCandidates(request: Extract<ShipDesignRequest, { type: 'request-slot-candidates' }>): Promise<void> {
        const design = this.selectedDesign();
        if (!design) return;
        const catalog = await this.catalog();
        const view = buildShipDesignView(catalog, design, this.previewCulture);
        const slot = view.sections.flatMap(section => section.slots).find(candidate =>
            candidate.sectionId === request.sectionId && candidate.name.toLowerCase() === request.slot.toLowerCase());
        if (!slot) throw new ShipDesignEditError('slot-not-found', 'The requested slot no longer exists.');
        const candidates = shipDesignComponentCandidates(catalog, design, slot, request.includeIncompatible);
        const tiers = shipDesignComponentTiers(catalog);
        const names = await this.displayNames(candidates.map(candidate => candidate.component.key));
        const icons = new Map<string, Awaited<ReturnType<ShipDesignSpriteResolver['resolve']>>>();
        for (const candidate of candidates.slice(0, 256)) {
            if (candidate.component.icon) icons.set(candidate.component.key,
                await this.spriteResolver.resolve(candidate.component.icon, candidate.component.iconFrame));
        }
        this.post({
            type: 'slot-candidates',
            sectionId: request.sectionId,
            slot: request.slot,
            candidates: candidates.map(candidate => ({
                key: candidate.component.key,
                label: localizedCandidateLabel(candidate.component.key, names),
                compatible: candidate.compatibility.compatible,
                reasons: candidate.compatibility.reasons,
                icon: icons.get(candidate.component.key),
                tier: tiers.get(candidate.component.key.toLowerCase()),
                upgradesTo: candidate.component.upgradesTo,
                origin: this.componentOrigin(candidate.component),
            })),
        });
    }

    private async sendCompatibleSlots(request: Extract<ShipDesignRequest, { type: 'request-compatible-slots' }>): Promise<void> {
        const design = this.parsed().designs.find(candidate => candidate.id === request.designId);
        if (!design) return;
        const catalog = await this.catalog();
        const component = lookupShipDesignComponent(catalog, request.componentKey);
        this.post({
            type: 'compatible-slots',
            designId: request.designId,
            componentKey: request.componentKey,
            slotIds: component ? shipDesignPlaceableSlotIds(catalog, design, component) : [],
        });
    }

    private async sendRequiredCandidates(request: Extract<ShipDesignRequest, { type: 'request-required-candidates' }>): Promise<void> {
        const design = this.parsed().designs.find(candidate => candidate.id === request.designId);
        if (!design) return;
        const catalog = await this.catalog();
        const slot = buildShipDesignRequiredSlots(catalog, design).find(candidate => candidate.id === request.slotId);
        if (!slot) throw new ShipDesignEditError('slot-not-found', 'The required component slot no longer exists.');
        const components = shipDesignRequiredCandidates(catalog, design, slot);
        const tiers = shipDesignComponentTiers(catalog);
        const names = await this.displayNames(components.map(component => component.key));
        const icons = new Map<string, Awaited<ReturnType<ShipDesignSpriteResolver['resolve']>>>();
        for (const component of components.slice(0, 256)) {
            if (component.icon) icons.set(component.key, await this.spriteResolver.resolve(component.icon, component.iconFrame));
        }
        this.post({
            type: 'required-candidates',
            designId: request.designId,
            slotId: request.slotId,
            candidates: components.map(component => ({
                key: component.key,
                label: localizedCandidateLabel(component.key, names),
                compatible: true,
                reasons: [],
                icon: icons.get(component.key),
                tier: tiers.get(component.key.toLowerCase()),
                upgradesTo: component.upgradesTo,
                origin: this.componentOrigin(component),
            })),
        });
    }

    private async sendSectionCandidates(request: Extract<ShipDesignRequest, { type: 'request-section-candidates' }>): Promise<void> {
        const design = this.parsed().designs.find(candidate => candidate.id === request.designId);
        if (!design) return;
        const catalog = await this.catalog();
        const candidates = shipDesignSectionCandidates(catalog, design.shipSize ?? '', request.sectionSlot, request.includeIncompatible);
        const names = await this.displayNames(candidates.map(candidate => candidate.section.key));
        this.post({
            type: 'section-candidates',
            designId: request.designId,
            sectionSlot: request.sectionSlot,
            candidates: candidates.map(candidate => ({
                key: candidate.section.key,
                label: localizedCandidateLabel(candidate.section.key, names),
                compatible: candidate.compatibility.compatible,
                reasons: candidate.compatibility.reasons,
            })),
        });
    }

    private async undo(): Promise<void> {
        this.draft.undo();
        await this.refresh();
    }

    private async redo(): Promise<void> {
        this.draft.redo();
        await this.refresh();
    }

    private html(webview: vscode.Webview, root: string): string {
        const script = webview.asWebviewUri(vscode.Uri.file(path.join(root, 'shipDesignPreview.js')));
        const style = webview.asWebviewUri(vscode.Uri.file(path.join(root, 'shipDesignPreview.css')));
        const token = nonce();
        const csp = [
            "default-src 'none'",
            "img-src " + webview.cspSource + " data: blob:",
            "style-src " + webview.cspSource + " 'unsafe-inline'",
            "script-src 'nonce-" + token + "'",
            "connect-src " + webview.cspSource + " data: blob:",
            "worker-src blob:",
        ].join('; ');
        return '<!DOCTYPE html><html lang="' + (vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')
            + '"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' + csp
            + '"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="' + style
            + '"><title>Stellaris Ship Design</title></head><body><div id="app"></div><script nonce="' + token
            + '" src="' + script + '"></script></body></html>';
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.generation++;
        if (ShipDesignPanel.currentPanel === this) ShipDesignPanel.currentPanel = undefined;
        for (const disposable of this.disposables) disposable.dispose();
        this.panel.dispose();
    }
}
