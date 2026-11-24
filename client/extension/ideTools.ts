import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import type { IdeHost } from 'cwtools-shared';
import { isPathInsideOrEqual } from './pathScope';
import type { IndexService } from './indexing/indexService';
import { GuiPanel } from './guiPanel';
import { GuiEvidenceHost } from './guiEvidence';

class IdeHostAdapter {
    constructor(
        private readonly workspaceRoot: string,
        private readonly extensionPath: string,
        private readonly indexService?: IndexService,
    ) {}
    private toWorkspaceRel(filePath: string | undefined): string | undefined {
        if (!filePath) return undefined;
        const resolved = path.resolve(filePath);
        if (this.workspaceRoot && isPathInsideOrEqual(resolved, this.workspaceRoot)) {
            return path.relative(this.workspaceRoot, resolved).replace(/\\/g, '/');
        }
        return resolved.replace(/\\/g, '/');
    }

    private async executeGetIdeContext(args: Record<string, unknown>): Promise<unknown> {
        const includeSelectionText = args.includeSelectionText !== false;
        const includeActiveFileDiagnostics = args.includeActiveFileDiagnostics !== false;
        const editor = vs.window.activeTextEditor;

        let activeEditorInfo: Record<string, unknown> | null = null;
        if (editor) {
            const doc = editor.document;
            const sel = editor.selection;
            const selectedRaw = includeSelectionText && !sel.isEmpty ? doc.getText(sel) : '';
            const selectedText = selectedRaw.length > 4000
                ? `${selectedRaw.slice(0, 4000)}\n...[truncated, full ${selectedRaw.length} chars]`
                : selectedRaw;
            const diagnostics = includeActiveFileDiagnostics
                ? (vs.languages.getDiagnostics(doc.uri) ?? []).slice(0, 100).map(d => ({
                    line: d.range.start.line + 1,
                    column: d.range.start.character + 1,
                    severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                        : d.severity === vs.DiagnosticSeverity.Warning ? 'warning' : 'info',
                    code: typeof d.code === 'object' && d.code !== null
                        ? String((d.code as { value?: unknown }).value ?? '')
                        : String(d.code ?? ''),
                    message: d.message,
                    source: d.source ?? 'cwtools',
                }))
                : undefined;

            activeEditorInfo = {
                file: this.toWorkspaceRel(doc.uri.fsPath),
                absolutePath: doc.uri.fsPath,
                languageId: doc.languageId,
                lineCount: doc.lineCount,
                isDirty: doc.isDirty,
                cursor: {
                    line: sel.active.line + 1,
                    column: sel.active.character + 1,
                },
                selection: {
                    isEmpty: sel.isEmpty,
                    startLine: sel.start.line + 1,
                    startColumn: sel.start.character + 1,
                    endLine: sel.end.line + 1,
                    endColumn: sel.end.character + 1,
                    ...(includeSelectionText && !sel.isEmpty ? { text: selectedText } : {}),
                },
                ...(diagnostics ? { diagnostics, diagnosticCount: diagnostics.length } : {}),
            };
        }

        const dirtyDocuments = (vs.workspace.textDocuments ?? [])
            .filter(doc => doc.isDirty && !doc.isUntitled && doc.uri.scheme === 'file')
            .slice(0, 50)
            .map(doc => ({
                file: this.toWorkspaceRel(doc.uri.fsPath),
                languageId: doc.languageId,
                lineCount: doc.lineCount,
            }));

        const visualPanels: Array<Record<string, unknown>> = [];
        try {
            const { GuiPanel } = await import('./guiPanel');
            if (GuiPanel.currentPanel) {
                const guiDoc = (GuiPanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                let guiSummary: Record<string, unknown> | undefined;
                if (guiDoc) {
                    const { parseGuiFile } = await import('./guiParser');
                    const parsedElements = parseGuiFile(guiDoc.getText(), new Map());
                    guiSummary = {
                        elementCount: parsedElements.length,
                        topLevelWindows: parsedElements.slice(0, 25).map(el => ({
                            type: el.type,
                            name: el.name,
                            line: el.line,
                            childCount: el.children.length,
                        })),
                    };
                }
                visualPanels.push({
                    editor: 'gui',
                    open: true,
                    file: this.toWorkspaceRel(guiDoc?.uri.fsPath),
                    ...(guiSummary ? { summary: guiSummary } : {}),
                });
            }
        } catch { /* ignore when panel module is unavailable in headless unit tests */ }

        try {
            const { EntityPanel } = await import('./entityPanel');
            if (EntityPanel.currentPanel) {
                const entityDoc = (EntityPanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                visualPanels.push({
                    editor: 'entity',
                    open: true,
                    file: this.toWorkspaceRel(entityDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { ParticlePanel } = await import('./particlePanel');
            if (ParticlePanel.currentPanel) {
                const particleDoc = (ParticlePanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                visualPanels.push({
                    editor: 'particle',
                    open: true,
                    file: this.toWorkspaceRel(particleDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { SolarSystemPanel } = await import('./solarSystemPanel');
            if (SolarSystemPanel.currentPanel) {
                const solarDoc = (SolarSystemPanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                visualPanels.push({
                    editor: 'solar_system',
                    open: true,
                    file: this.toWorkspaceRel(solarDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { TechTreePanel } = await import('./techTreePanel');
            if (TechTreePanel.currentPanel) {
                const techDoc = (TechTreePanel.currentPanel as unknown as { _seedDocument?: vs.TextDocument })._seedDocument;
                visualPanels.push({
                    editor: 'tech_tree',
                    open: true,
                    seedFile: this.toWorkspaceRel(techDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { EventChainPanel } = await import('./eventChainPanel');
            if (EventChainPanel.currentPanel) {
                visualPanels.push({
                    editor: 'event_chain',
                    open: true,
                });
            }
        } catch { /* ignore */ }

        try {
            const { TargetWeightPanel } = await import('./targetWeightPanel');
            if (TargetWeightPanel.currentPanel) {
                visualPanels.push({
                    editor: 'target_weight',
                    open: true,
                });
            }
        } catch { /* ignore */ }

        return {
            success: true,
            workspaceRoot: this.workspaceRoot,
            activeEditor: activeEditorInfo,
            dirtyDocuments,
            visualPanels,
        };
    }

    private async executeOpenInVisualEditor(args: Record<string, unknown>): Promise<unknown> {
        const rawFile = typeof args.file === 'string' ? args.file.trim() : '';
        const requestedEditor = typeof args.editor === 'string' ? args.editor.trim() : 'auto';
        const line = typeof args.line === 'number' && Number.isInteger(args.line) && args.line >= 1
            ? args.line
            : undefined;

        const extensionPath = this.extensionPath;
        if (!extensionPath) {
            return {
                success: false,
                error: 'Visual editor panels require an active VS Code Extension Host with extensionPath configured.',
            };
        }

        let targetDoc: vs.TextDocument | undefined;
        let resolvedFile: string | undefined;
        if (rawFile) {
            resolvedFile = path.isAbsolute(rawFile)
                ? path.resolve(rawFile)
                : path.resolve(this.workspaceRoot, rawFile);
            if (!isPathInsideOrEqual(resolvedFile, this.workspaceRoot)) {
                return {
                    success: false,
                    error: `Target file '${rawFile}' must be inside the workspace root.`,
                };
            }
            if (!fs.existsSync(resolvedFile)) {
                return {
                    success: false,
                    error: `Target file not found: '${rawFile}'.`,
                };
            }
            targetDoc = await vs.workspace.openTextDocument(vs.Uri.file(resolvedFile));
        } else {
            targetDoc = vs.window.activeTextEditor?.document;
            resolvedFile = targetDoc?.uri.fsPath;
        }

        const relPath = this.toWorkspaceRel(resolvedFile) ?? '';
        const lowerRel = relPath.toLowerCase();

        let editorKind = requestedEditor;
        if (!editorKind || editorKind === 'auto') {
            if (lowerRel.endsWith('.gui')) {
                editorKind = 'gui';
            } else if (lowerRel.endsWith('.asset')) {
                const text = targetDoc?.getText() ?? (resolvedFile ? fs.readFileSync(resolvedFile, 'utf8') : '');
                editorKind = /(?:^|\n)\s*particle\s*=\s*\{/.test(text) ? 'particle' : 'entity';
            } else if (lowerRel.includes('solar_system_initializers')) {
                editorKind = 'solar_system';
            } else if (lowerRel.includes('common/technology')) {
                editorKind = 'tech_tree';
            } else if (lowerRel.includes('common/component_templates')) {
                editorKind = 'target_weight';
            } else if (lowerRel.startsWith('events/') || lowerRel.includes('/events/')) {
                editorKind = 'event_chain';
            } else {
                return {
                    success: false,
                    error: `Could not auto-infer visual editor for '${relPath || '(no file)'}'. Specify editor explicitly: gui | entity | particle | solar_system | tech_tree | event_chain | target_weight.`,
                };
            }
        }

        switch (editorKind) {
            case 'gui': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.gui')) {
                    return { success: false, error: 'GUI Preview requires a .gui file.' };
                }
                const { GuiPanel } = await import('./guiPanel');
                const { parseGuiFile } = await import('./guiParser');
                await GuiPanel.create(extensionPath, targetDoc);
                const parsedElements = parseGuiFile(targetDoc.getText(), new Map());
                return {
                    success: true,
                    editor: 'gui',
                    file: relPath,
                    summary: {
                        elementCount: parsedElements.length,
                        topLevelWindows: parsedElements.slice(0, 30).map(el => ({
                            type: el.type,
                            name: el.name,
                            line: el.line,
                            childCount: el.children.length,
                        })),
                    },
                };
            }
            case 'entity': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.asset')) {
                    return { success: false, error: 'Entity Preview requires a .asset file.' };
                }
                const { EntityPanel } = await import('./entityPanel');
                const { parseAssetFile } = await import('./entityAssetParser');
                await EntityPanel.create(extensionPath, targetDoc);
                const parsed = parseAssetFile(targetDoc.getText(), targetDoc.uri.fsPath);
                return {
                    success: true,
                    editor: 'entity',
                    file: relPath,
                    summary: {
                        entityCount: parsed.entities.length,
                        entities: parsed.entities.slice(0, 30).map(ent => ({
                            name: ent.name,
                            pdxmesh: ent.pdxmesh,
                            line: ent.line,
                            stateCount: ent.states.length,
                            locatorCount: ent.locators.length,
                        })),
                    },
                };
            }
            case 'particle': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.asset')) {
                    return { success: false, error: 'Particle Preview requires a .asset file.' };
                }
                const { ParticlePanel } = await import('./particlePanel');
                const { parseParticleFile } = await import('./particleAssetParser');
                await ParticlePanel.create(extensionPath, targetDoc);
                const parsedParticle = parseParticleFile(targetDoc.getText());
                return {
                    success: true,
                    editor: 'particle',
                    file: relPath,
                    summary: {
                        effectCount: parsedParticle.effects.length,
                        effects: parsedParticle.effects.slice(0, 30).map(eff => ({
                            name: eff.name,
                            subsystemCount: eff.subsystems.length,
                        })),
                    },
                };
            }
            case 'solar_system': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.txt')) {
                    return { success: false, error: 'Solar System Preview requires a .txt initializer file.' };
                }
                const { SolarSystemPanel } = await import('./solarSystemPanel');
                const { parseSolarSystemFile } = await import('./solarSystemParser');
                await SolarSystemPanel.create(extensionPath, targetDoc);
                const systems = parseSolarSystemFile(targetDoc.getText());
                return {
                    success: true,
                    editor: 'solar_system',
                    file: relPath,
                    summary: {
                        systemCount: systems.length,
                        systems: systems.slice(0, 30).map(sys => ({
                            key: sys.key,
                            displayName: sys.displayName,
                            starClass: sys.starClass,
                            line: sys.line,
                            bodyCount: sys.bodies.length,
                        })),
                    },
                };
            }
            case 'tech_tree': {
                const { TechTreePanel } = await import('./techTreePanel');
                await TechTreePanel.create(extensionPath, targetDoc);
                return {
                    success: true,
                    editor: 'tech_tree',
                    file: relPath || undefined,
                };
            }
            case 'event_chain': {
                const { EventChainPanel } = await import('./eventChainPanel');
                await EventChainPanel.create(
                    extensionPath,
                    targetDoc,
                    line ?? (vs.window.activeTextEditor ? vs.window.activeTextEditor.selection.active.line + 1 : undefined),
                );
                return {
                    success: true,
                    editor: 'event_chain',
                    file: relPath || undefined,
                    line,
                };
            }
            case 'target_weight': {
                const { TargetWeightPanel } = await import('./targetWeightPanel');
                await TargetWeightPanel.create(extensionPath, {
                    indexService: this.indexService,
                    cursor: targetDoc
                        ? { document: targetDoc, line: line ?? (vs.window.activeTextEditor?.selection.active.line ?? 0) + 1 }
                        : undefined,
                });
                return {
                    success: true,
                    editor: 'target_weight',
                    file: relPath || undefined,
                    line,
                };
            }
            default:
                return {
                    success: false,
                    error: `Unsupported visual editor '${editorKind}'.`,
                };
        }
    }


}

/** VS Code-only host operations; no Agent Runner or Provider state is involved. */
export function createIdeHost(workspaceRoot: string, extensionPath: string, indexService: IndexService | undefined, artifactRoot: string): IdeHost {
    const adapter = new IdeHostAdapter(workspaceRoot, extensionPath, indexService) as unknown as {
        executeGetIdeContext(args: Record<string, unknown>): Promise<unknown>;
        executeOpenInVisualEditor(args: Record<string, unknown>): Promise<unknown>;
    };
    const evidence = new GuiEvidenceHost(artifactRoot);
    return {
        getContext: args => adapter.executeGetIdeContext(args),
        openVisualEditor: args => adapter.executeOpenInVisualEditor(args),
        captureGuiPreview: async args => {
            const rawFile = typeof args.file === 'string' ? args.file.trim() : '';
            if (rawFile) {
                const resolved = path.isAbsolute(rawFile) ? path.resolve(rawFile) : path.resolve(workspaceRoot, rawFile);
                if (!isPathInsideOrEqual(resolved, workspaceRoot)) throw new Error('GUI capture file must be inside the workspace.');
                await adapter.executeOpenInVisualEditor({ file: resolved, editor: 'gui' });
            }
            const panel = GuiPanel.currentPanel;
            const document = (panel as unknown as { _document?: vs.TextDocument })?._document;
            if (!panel || !document) throw new Error('Open a GUI preview before capturing evidence.');
            return evidence.capture(panel, document.uri.fsPath, typeof args.baselineArtifactId === 'string' ? args.baselineArtifactId : undefined);
        },
    };
}
