import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PdxShaderNode, Range } from './shaderParser';
import { getCachedParse, ShaderIndex } from './shaderIndex';

/** Convert AST coordinate ranges to VS Code native Range objects */
function toVsRange(r: Range): vs.Range {
    return new vs.Range(
        new vs.Position(r.start.line, r.start.character),
        new vs.Position(r.end.line, r.end.character)
    );
}

/** Robust Include path resolution across mod folder, workspace folders, and vanilla game directory */
function resolveIncludePath(document: vs.TextDocument, relativePath: string): string | null {
    const docDir = path.dirname(document.uri.fsPath);
    const sameDir = path.join(docDir, relativePath);
    if (fs.existsSync(sameDir)) return sameDir;

    // Search all workspace root directories
    for (const wf of vs.workspace.workspaceFolders ?? []) {
        const root = wf.uri.fsPath;
        const full = path.join(root, relativePath);
        if (fs.existsSync(full)) return full;
        const fullFx = path.join(root, 'gfx', 'FX', relativePath);
        if (fs.existsSync(fullFx)) return fullFx;
    }

    // Search vanilla Stellaris installation directory
    const config = vs.workspace.getConfiguration('cwtools');
    const gamePath = config.get<string>('cache.stellaris');
    if (gamePath && fs.existsSync(gamePath)) {
        const full = path.join(gamePath, relativePath);
        if (fs.existsSync(full)) return full;
        const fullFx = path.join(gamePath, 'gfx', 'FX', relativePath);
        if (fs.existsSync(fullFx)) return fullFx;
    }

    return null;
}

// ─── 1. Document Link Provider (Include Jump) ────────────────────────────────

export class PdxShaderDocumentLinkProvider implements vs.DocumentLinkProvider {
    provideDocumentLinks(document: vs.TextDocument, _token: vs.CancellationToken): vs.DocumentLink[] {
        const doc = getCachedParse(document);
        const links: vs.DocumentLink[] = [];

        // Traverse includes to construct document links
        doc.ast.children.forEach(node => {
            if (node.type === 'Includes') {
                node.children.forEach(child => {
                    if (child.type === 'Property') {
                        const targetPath = resolveIncludePath(document, child.name!);
                        if (targetPath) {
                            const link = new vs.DocumentLink(
                                toVsRange(child.range),
                                vs.Uri.file(targetPath)
                            );
                            link.tooltip = `Jump to ${child.name}`;
                            links.push(link);
                        }
                    }
                });
            }
        });

        return links;
    }
}

// ─── 2. Document Symbol Provider (Outline Tree View) ─────────────────────────

export class PdxShaderDocumentSymbolProvider implements vs.DocumentSymbolProvider {
    provideDocumentSymbols(document: vs.TextDocument, _token: vs.CancellationToken): vs.DocumentSymbol[] {
        const doc = getCachedParse(document);
        const symbols: vs.DocumentSymbol[] = [];

        const toDocumentSymbol = (node: PdxShaderNode): vs.DocumentSymbol | null => {
            let kind: vs.SymbolKind;
            switch (node.type) {
                case 'VertexStruct':
                    kind = vs.SymbolKind.Class;
                    break;
                case 'ConstantBuffer':
                    kind = vs.SymbolKind.Struct;
                    break;
                case 'ShaderBlock':
                    kind = vs.SymbolKind.Module;
                    break;
                case 'MainCode':
                    kind = vs.SymbolKind.Function;
                    break;
                case 'Effect':
                    kind = vs.SymbolKind.Event;
                    break;
                case 'BlendState':
                case 'DepthStencilState':
                case 'RasterizerState':
                    kind = vs.SymbolKind.Interface;
                    break;
                case 'SamplerDecl':
                    kind = vs.SymbolKind.Field;
                    break;
                case 'Property':
                    kind = vs.SymbolKind.Property;
                    break;
                case 'Includes':
                case 'CodeBlock':
                    kind = vs.SymbolKind.Namespace;
                    break;
                default:
                    return null;
            }

            const name = node.name || node.type;
            const vsRange = toVsRange(node.range);
            const vsSelectionRange = node.nameRange ? toVsRange(node.nameRange) : vsRange;

            const detail = node.type === 'Property' && node.properties.type ? node.properties.type : '';
            const symbol = new vs.DocumentSymbol(name, detail, kind, vsRange, vsSelectionRange);

            node.children.forEach(child => {
                const childSym = toDocumentSymbol(child);
                if (childSym) {
                    symbol.children.push(childSym);
                }
            });

            return symbol;
        };

        doc.ast.children.forEach(node => {
            const sym = toDocumentSymbol(node);
            if (sym) {
                symbols.push(sym);
            }
        });

        return symbols;
    }
}

// ─── 3. Definition Provider (F12 GoToDefinition) ─────────────────────────────

export class PdxShaderDefinitionProvider implements vs.DefinitionProvider {
    constructor(private readonly index: ShaderIndex) {}

    async provideDefinition(
        document: vs.TextDocument,
        position: vs.Position,
        _token: vs.CancellationToken
    ): Promise<vs.Location | null> {
        const doc = getCachedParse(document);
        const cursorOffset = document.offsetAt(position);

        // Helper to check if cursor lies within node range
        const isOffsetInNode = (offset: number, node: PdxShaderNode): boolean => {
            const textStart = document.offsetAt(new vs.Position(node.range.start.line, node.range.start.character));
            const textEnd = document.offsetAt(new vs.Position(node.range.end.line, node.range.end.character));
            return offset >= textStart && offset < textEnd;
        };

        // Find active node at cursor
        let activeNode: PdxShaderNode | null = null;
        for (const child of doc.ast.children) {
            if (isOffsetInNode(cursorOffset, child)) {
                activeNode = child;
                break;
            }
        }

        if (!activeNode) return null;

        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
        if (!wordRange) return null;
        const hoveredWord = document.getText(wordRange);

        // Case A: Effect block property assignments -> Jump to MainCode
        if (activeNode.type === 'Effect') {
            const propKeys = ['VertexShader', 'PixelShader'];
            for (const key of propKeys) {
                const val = activeNode.properties[key];
                if (val === hoveredWord) {
                    // Try same-file first
                    const target = doc.allMainCodes.find(mc => mc.name === hoveredWord);
                    if (target) {
                        return new vs.Location(document.uri, toVsRange(target.nameRange || target.range));
                    }
                    // Fall back to cross-file index
                    await this.index.ensureReady();
                    const hits = this.index.findMainCode(hoveredWord);
                    if (hits.length > 0) {
                        const hit = hits[0]!;
                        return new vs.Location(vs.Uri.parse(hit.uri), toVsRange(hit.node.nameRange || hit.node.range));
                    }
                }
            }
        }

        // Case B: MainCode ConstantBuffers assignment -> Jump to ConstantBuffer
        if (activeNode.type === 'ShaderBlock') {
            for (const mc of activeNode.children) {
                if (mc.type === 'MainCode' && isOffsetInNode(cursorOffset, mc)) {
                    const cbList = mc.properties['ConstantBuffers'];
                    if (cbList && cbList.includes(hoveredWord)) {
                        // Try same-file first
                        const target = doc.constantBuffers.find(cb => cb.name === hoveredWord);
                        if (target) {
                            return new vs.Location(document.uri, toVsRange(target.nameRange || target.range));
                        }
                        // Fall back to cross-file index
                        await this.index.ensureReady();
                        const hits = this.index.findConstantBuffer(hoveredWord);
                        if (hits.length > 0) {
                            const hit = hits[0]!;
                            return new vs.Location(vs.Uri.parse(hit.uri), toVsRange(hit.node.nameRange || hit.node.range));
                        }
                    }
                }
            }
        }

        return null;
    }
}

// ─── 4. Hover Provider (Definition Tooltips) ─────────────────────────────────

export class PdxShaderHoverProvider implements vs.HoverProvider {
    provideHover(
        document: vs.TextDocument,
        position: vs.Position,
        _token: vs.CancellationToken
    ): vs.Hover | null {
        const doc = getCachedParse(document);
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
        if (!wordRange) return null;
        const word = document.getText(wordRange);

        // A. ConstantBuffer Hover - show all its members and types
        const cb = doc.constantBuffers.find(n => n.name === word);
        if (cb) {
            const md = new vs.MarkdownString();
            md.appendMarkdown(`**ConstantBuffer** \`${cb.name}\`\n\n`);
            md.appendCodeblock('struct {\n' + cb.children.map(f => `    ${f.properties.type} ${f.name};`).join('\n') + '\n}', 'hlsl');
            return new vs.Hover(md, wordRange);
        }

        // B. SamplerDecl Hover - show sampler registers and index configs
        const sampler = doc.allSamplers.find(n => n.name === word);
        if (sampler) {
            const md = new vs.MarkdownString();
            md.appendMarkdown(`**Sampler State** \`${sampler.name}\`\n\n`);
            const configs = Object.entries(sampler.properties).map(([k, v]) => `- **${k}**: \`${v}\``).join('\n');
            md.appendMarkdown(configs || '*No configuration properties defined.*');
            return new vs.Hover(md, wordRange);
        }

        // C. Effect Hover - show bound Vertex/Pixel shaders
        const effect = doc.effects.find(n => n.name === word);
        if (effect) {
            const md = new vs.MarkdownString();
            md.appendMarkdown(`**Effect** \`${effect.name}\`\n\n`);
            if (effect.properties.VertexShader) md.appendMarkdown(`- **VertexShader**: \`${effect.properties.VertexShader}\`\n`);
            if (effect.properties.PixelShader) md.appendMarkdown(`- **PixelShader**: \`${effect.properties.PixelShader}\`\n`);
            if (effect.properties.BlendState) md.appendMarkdown(`- **BlendState**: \`${effect.properties.BlendState}\`\n`);
            return new vs.Hover(md, wordRange);
        }

        // D. MainCode Hover - show ConstantBuffer bindings
        const mc = doc.allMainCodes.find(n => n.name === word);
        if (mc) {
            const md = new vs.MarkdownString();
            md.appendMarkdown(`**MainCode Entry** \`${mc.name}\`\n\n`);
            if (mc.properties.ConstantBuffers) {
                md.appendMarkdown(`- **ConstantBuffers**: \`${mc.properties.ConstantBuffers}\`\n`);
            }
            return new vs.Hover(md, wordRange);
        }

        return null;
    }
}

// ─── 5. Completion Item Provider (IntelliSense Auto-Complete) ────────────────

const SAMPLER_ENUMS: Record<string, string[]> = {
    'MagFilter': ['Linear', 'Point', 'Anisotropic'],
    'MinFilter': ['Linear', 'Point', 'Anisotropic'],
    'MipFilter': ['Linear', 'Point', 'None'],
    'AddressU': ['Wrap', 'Clamp', 'Mirror', 'Border'],
    'AddressV': ['Wrap', 'Clamp', 'Mirror', 'Border']
};

const BLEND_ENUMS: Record<string, string[]> = {
    'SourceBlend': ['SRC_ALPHA', 'INV_SRC_ALPHA', 'ONE', 'ZERO', 'SRC_COLOR', 'INV_SRC_COLOR', 'DEST_ALPHA', 'INV_DEST_ALPHA', 'DEST_COLOR', 'INV_DEST_COLOR'],
    'DestBlend': ['SRC_ALPHA', 'INV_SRC_ALPHA', 'ONE', 'ZERO', 'SRC_COLOR', 'INV_SRC_COLOR', 'DEST_ALPHA', 'INV_DEST_ALPHA', 'DEST_COLOR', 'INV_DEST_COLOR'],
    'BlendEnable': ['yes', 'no'],
    'WriteMask': ['RED', 'GREEN', 'BLUE', 'ALPHA', '0x0F', '0x00']
};

const RASTERIZER_ENUMS: Record<string, string[]> = {
    'CullMode': ['none', 'cw', 'ccw'],
    'FillMode': ['solid', 'wireframe']
};

const DEPTHSTENCIL_ENUMS: Record<string, string[]> = {
    'DepthEnable': ['yes', 'no'],
    'DepthWriteEnable': ['yes', 'no'],
    'StencilEnable': ['yes', 'no']
};

export class PdxShaderCompletionProvider implements vs.CompletionItemProvider {
    provideCompletionItems(
        document: vs.TextDocument,
        position: vs.Position,
        _token: vs.CancellationToken,
        _context: vs.CompletionContext
    ): vs.CompletionItem[] {
        const lineText = document.lineAt(position).text;
        const textBeforeCursor = lineText.substring(0, position.character);
        const doc = getCachedParse(document);

        // Context A: Effect block shaders auto-completion -> suggest MainCodes
        if (/\bVertexShader\s*=\s*"([^"]*)$/.test(textBeforeCursor) || /\bPixelShader\s*=\s*"([^"]*)$/.test(textBeforeCursor)) {
            return doc.allMainCodes.map(mc => {
                const item = new vs.CompletionItem(mc.name!, vs.CompletionItemKind.Function);
                item.detail = 'MainCode Shader Entry';
                return item;
            });
        }

        // Context B: ConstantBuffers list auto-completion inside MainCode
        if (/\bConstantBuffers\s*=\s*\{[^}]*$/.test(textBeforeCursor)) {
            return doc.constantBuffers.map(cb => {
                const item = new vs.CompletionItem(cb.name!, vs.CompletionItemKind.Struct);
                item.detail = 'ConstantBuffer';
                return item;
            });
        }

        // Context C: Sampler property enum completion
        for (const [key, values] of Object.entries(SAMPLER_ENUMS)) {
            const re = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)$`);
            const match = re.exec(textBeforeCursor);
            if (match) {
                return values.map(val => {
                    const item = new vs.CompletionItem(val, vs.CompletionItemKind.EnumMember);
                    item.detail = `${key} Value`;
                    return item;
                });
            }
        }

        // Context D: BlendState / RasterizerState / DepthStencilState property enum completion
        for (const enumTable of [BLEND_ENUMS, RASTERIZER_ENUMS, DEPTHSTENCIL_ENUMS]) {
            for (const [key, values] of Object.entries(enumTable)) {
                const re = new RegExp(`\\b${key}\\s*=\\s*"?([A-Za-z0-9_]*)$`);
                const match = re.exec(textBeforeCursor);
                if (match) {
                    return values.map(val => {
                        const item = new vs.CompletionItem(val, vs.CompletionItemKind.EnumMember);
                        item.detail = `${key} Value`;
                        return item;
                    });
                }
            }
        }

        return [];
    }
}

// ─── 6. Diagnostics Manager (D001–D005) ─────────────────────────────────────

export class PdxShaderDiagnosticsManager {
    private readonly collection: vs.DiagnosticCollection;
    private readonly index: ShaderIndex;

    constructor(index: ShaderIndex) {
        this.collection = vs.languages.createDiagnosticCollection('pdx-shader');
        this.index = index;
    }

    async updateDiagnostics(document: vs.TextDocument): Promise<void> {
        if (document.languageId !== 'pdx-shader') return;

        const doc = getCachedParse(document);
        this.index.updateFromTextDocument(document);
        const diags: vs.Diagnostic[] = [];

        // D001: Effect references a non-existent MainCode
        for (const effect of doc.effects) {
            for (const key of ['VertexShader', 'PixelShader'] as const) {
                const refName = effect.properties[key];
                if (!refName) continue;
                const foundLocal = doc.allMainCodes.some(mc => mc.name === refName);
                if (!foundLocal) {
                    await this.index.ensureReady();
                    const foundGlobal = this.index.findMainCode(refName);
                    if (foundGlobal.length === 0) {
                        const range = effect.nameRange || effect.range;
                        diags.push(new vs.Diagnostic(
                            toVsRange(range),
                            `D001: Effect "${effect.name}" references undefined ${key} "${refName}"`,
                            vs.DiagnosticSeverity.Warning
                        ));
                    }
                }
            }
        }

        // D002: MainCode references a non-existent ConstantBuffer
        for (const mc of doc.allMainCodes) {
            const cbList = mc.properties['ConstantBuffers'];
            if (!cbList) continue;
            const names = cbList.split(/[,\s]+/).filter(Boolean);
            for (const cbName of names) {
                const foundLocal = doc.constantBuffers.some(cb => cb.name === cbName);
                if (!foundLocal) {
                    await this.index.ensureReady();
                    const foundGlobal = this.index.findConstantBuffer(cbName);
                    if (foundGlobal.length === 0) {
                        const range = mc.nameRange || mc.range;
                        diags.push(new vs.Diagnostic(
                            toVsRange(range),
                            `D002: MainCode "${mc.name}" references undefined ConstantBuffer "${cbName}"`,
                            vs.DiagnosticSeverity.Warning
                        ));
                    }
                }
            }
        }

        // D003: Includes references a non-existent file
        for (const inc of doc.includes) {
            const resolved = resolveIncludePath(document, inc);
            if (!resolved) {
                // Find the include node range for accurate squiggle
                const inclNode = doc.ast.children.find(c => c.type === 'Includes');
                const childNode = inclNode?.children.find(c => c.name === inc);
                if (childNode) {
                    diags.push(new vs.Diagnostic(
                        toVsRange(childNode.range),
                        `D003: Include file "${inc}" not found`,
                        vs.DiagnosticSeverity.Warning
                    ));
                }
            }
        }

        // D004: Duplicate Effect names
        const effectNames = new Map<string, PdxShaderNode[]>();
        for (const e of doc.effects) {
            if (!e.name) continue;
            const list = effectNames.get(e.name) ?? [];
            list.push(e);
            effectNames.set(e.name, list);
        }
        for (const [name, nodes] of effectNames) {
            if (nodes.length > 1) {
                for (const node of nodes) {
                    diags.push(new vs.Diagnostic(
                        toVsRange(node.nameRange || node.range),
                        `D004: Duplicate Effect name "${name}"`,
                        vs.DiagnosticSeverity.Warning
                    ));
                }
            }
        }

        // D005: Duplicate MainCode names within the same ShaderBlock
        for (const sb of doc.shaderBlocks) {
            const mcNames = new Map<string, PdxShaderNode[]>();
            for (const child of sb.children) {
                if (child.type !== 'MainCode' || !child.name) continue;
                const list = mcNames.get(child.name) ?? [];
                list.push(child);
                mcNames.set(child.name, list);
            }
            for (const [name, nodes] of mcNames) {
                if (nodes.length > 1) {
                    for (const node of nodes) {
                        diags.push(new vs.Diagnostic(
                            toVsRange(node.nameRange || node.range),
                            `D005: Duplicate MainCode name "${name}" in ${sb.name ?? 'ShaderBlock'}`,
                            vs.DiagnosticSeverity.Warning
                        ));
                    }
                }
            }
        }

        this.collection.set(document.uri, diags);
    }

    clearDiagnostics(uri: vs.Uri): void {
        this.collection.delete(uri);
    }

    dispose(): void {
        this.collection.dispose();
    }
}

// ─── Registration Entry ──────────────────────────────────────────────────────

/**
 * Ensure .shader and .fxh files are associated with pdx-shader language.
 * This defeats ShaderLab or other extensions that may claim .shader files.
 */
function ensureShaderFileAssociation(): void {
    const config = vs.workspace.getConfiguration('files');
    const assoc = config.get<Record<string, string>>('associations') ?? {};

    let changed = false;
    const rules: Record<string, string> = {
        '*.fxh': 'pdx-shader',
        '**/gfx/FX/**/*.shader': 'pdx-shader'
    };
    for (const [pattern, lang] of Object.entries(rules)) {
        if (assoc[pattern] !== lang) {
            assoc[pattern] = lang;
            changed = true;
        }
    }
    if (changed) {
        void config.update('associations', assoc, vs.ConfigurationTarget.Workspace);
    }
}

export function registerShaderProviders(context: vs.ExtensionContext): void {
    // Force file association at activation time
    ensureShaderFileAssociation();

    const selector: vs.DocumentSelector = [
        { scheme: 'file', language: 'pdx-shader' }
    ];

    const index = new ShaderIndex();
    const diagnosticsManager = new PdxShaderDiagnosticsManager(index);

    // Register language feature providers
    context.subscriptions.push(
        vs.languages.registerDocumentLinkProvider(selector, new PdxShaderDocumentLinkProvider()),
        vs.languages.registerDocumentSymbolProvider(selector, new PdxShaderDocumentSymbolProvider()),
        vs.languages.registerDefinitionProvider(selector, new PdxShaderDefinitionProvider(index)),
        vs.languages.registerHoverProvider(selector, new PdxShaderHoverProvider()),
        vs.languages.registerCompletionItemProvider(selector, new PdxShaderCompletionProvider(), '"', '=', '{', ' ')
    );

    // File watcher for incremental index updates
    const watcher = vs.workspace.createFileSystemWatcher('**/*.{shader,fxh}');
    watcher.onDidChange(uri => index.onDocumentChanged(uri));
    watcher.onDidCreate(uri => index.onDocumentChanged(uri));
    watcher.onDidDelete(uri => index.onDocumentDeleted(uri));
    context.subscriptions.push(watcher);

    // Diagnostics on document open/save/change
    context.subscriptions.push(
        vs.workspace.onDidOpenTextDocument(doc => void diagnosticsManager.updateDiagnostics(doc)),
        vs.workspace.onDidSaveTextDocument(doc => void diagnosticsManager.updateDiagnostics(doc)),
        vs.workspace.onDidChangeTextDocument(e => void diagnosticsManager.updateDiagnostics(e.document)),
        vs.workspace.onDidCloseTextDocument(doc => diagnosticsManager.clearDiagnostics(doc.uri))
    );

    // Cleanup
    context.subscriptions.push({ dispose: () => { index.dispose(); diagnosticsManager.dispose(); } });
}
