/**
 * Structured chat references for @mentions.
 *
 * Keeps the chat panel host small and makes every reference type pass through
 * the same search -> chip metadata -> prompt injection -> open flow.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import type { BaseContextItem, ContextItem, ContextItemType } from './types';
import { ErrorReporter } from './errorReporter';
import { diagnosticCodeString } from '../diagnosticI18n';
import { SOURCE } from './messages';
import type { Blackboard } from './orchestrator/blackboard';
import type { BlackboardEntry } from './orchestrator/types';
import { getProjectWorkspaceRoot, resolveProjectWorkspacePath } from './workspacePaths';

function isAgentTempPath(filePath: string): boolean {
    return /(?:^|[\\/])\.cwtools[\\/](?:tmp|[^\\/]+[\\/]tmp)(?:[\\/]|$)/i.test(filePath);
}

const QUOTED_TEXT_PROMPT_LIMIT = 8000;

export interface MentionSearchResult {
    type?: ContextItemType;
    uri?: string;
    label: string;
    desc: string;
    startLine?: number;
    endLine?: number;
    line?: number;
    column?: number;
    name?: string;
    kind?: string;
    vanillaType?: string;
    vanillaId?: string;
    key?: string;
    tokenEstimate?: number;
    cacheStatus?: BaseContextItem['cacheStatus'];
}

export class ContextReferenceManager {
    constructor(
        private readonly getBlackboard: () => Blackboard | undefined,
    ) {}

    resolveWorkspacePath(refPath: string | undefined): string | undefined {
        if (!refPath) return undefined;
        const workspaceFolders = vs.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

        const targetPath = resolveProjectWorkspacePath(refPath);
        if (!targetPath) return undefined;
        const isWindows = process.platform === 'win32';
        const normalizedTarget = isWindows ? targetPath.toLowerCase() : targetPath;

        for (const folder of workspaceFolders) {
            const folderPath = path.resolve(folder.uri.fsPath);
            const normalizedRoot = isWindows ? folderPath.toLowerCase() : folderPath;
            if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)) {
                return targetPath;
            }
        }

        return undefined;
    }

    workspaceLabel(filePath: string): string {
        return vs.workspace.asRelativePath(filePath).replace(/\\/g, '/');
    }

    async search(query: string): Promise<MentionSearchResult[]> {
        const q = query.trim();
        const qLower = q.toLowerCase();
        const editor = vs.window.activeTextEditor;
        const builtins = this.builtinReferences(editor, qLower);

        if (!q) return [...builtins, ...this.recentWorkspaceFiles(8)];

        const results: MentionSearchResult[] = [...builtins];
        if (qLower.startsWith('blackboard:')) {
            results.push(...this.searchBlackboard(q.slice('blackboard:'.length)));
            return results.slice(0, 30);
        }
        if (qLower.startsWith('vanilla::')) {
            results.push(...await this.searchVanilla(q));
            return results.slice(0, 30);
        }
        if (qLower.startsWith('symbol:')) {
            results.push(...await this.searchSymbols(q.slice('symbol:'.length)));
            return results.slice(0, 30);
        }

        results.push(...this.searchWorkspaceFolders(q, Math.min(8, Math.max(0, 30 - results.length))));
        results.push(...await this.searchWorkspaceFiles(q, Math.max(0, 30 - results.length)));
        if (q.length >= 2 && results.length < 30) {
            results.push(...await this.searchSymbols(q, Math.min(8, 30 - results.length)));
        }
        if (results.length < 30) {
            results.push(...this.searchBlackboard(q).slice(0, 30 - results.length));
        }

        return results.slice(0, 30);
    }

    async buildReferencePrompt(contexts: ContextItem[]): Promise<string> {
        const blocks: string[] = [];
        for (const ctx of contexts) {
            const ref = ctx as any;
            if (ctx.type === 'code_selection' && typeof ref.uri === 'string' && typeof ref.startLine === 'number' && typeof ref.endLine === 'number') {
                const liveContent = await this.resolveLiveCodeContext(ref.uri, ref.startLine, ref.endLine);
                blocks.push([
                    `Selection: ${ref.uri} lines ${ref.startLine}-${ref.endLine}`,
                    '```pdx',
                    liveContent,
                    '```',
                ].join('\n'));
            } else if (ctx.type === 'file') {
                blocks.push(await this.readReferencedFilePreview(ref.uri));
            } else if (ctx.type === 'folder') {
                blocks.push(await this.listReferencedFolderPreview(ref.uri));
            } else if (ctx.type === 'diagnostics') {
                blocks.push(this.formatReferencedDiagnostics(ref.uri));
            } else if (ctx.type === 'scope') {
                blocks.push(await this.formatReferencedScope(ref.uri, ref.line, ref.column));
            } else if (ctx.type === 'symbol') {
                blocks.push(await this.formatReferencedSymbol(ref));
            } else if (ctx.type === 'vanilla') {
                blocks.push(await this.formatReferencedVanilla(ref));
            } else if (ctx.type === 'blackboard') {
                blocks.push(await this.formatReferencedBlackboard(ref.key));
            } else if (ctx.type === 'quote' && typeof ref.text === 'string' && ref.text.trim()) {
                const text = ref.text.length > QUOTED_TEXT_PROMPT_LIMIT
                    ? `${ref.text.slice(0, QUOTED_TEXT_PROMPT_LIMIT)}\n... (truncated)`
                    : ref.text;
                blocks.push([
                    'Quoted chat content selected by the user:',
                    '```',
                    text,
                    '```',
                ].join('\n'));
            }
        }

        if (blocks.length === 0) return '';

        return [
            '<referenced-context>',
            'The user attached these explicit references from the chat input. Treat them as read-only context; verify with tools before editing.',
            blocks.map((block, index) => `\n[Reference ${index + 1}]\n${block}`).join('\n'),
            '</referenced-context>',
        ].join('\n');
    }

    async openReference(ctx: ContextItem): Promise<void> {
        const ref = ctx as any;
        if (ctx.type === 'quote') return;
        if (ctx.type === 'diagnostics') {
            await vs.commands.executeCommand('workbench.actions.view.problems');
            return;
        }
        if (ctx.type === 'blackboard') {
            await this.openBlackboardReference(ref.key);
            return;
        }

        const targetPath = this.resolveWorkspacePath(ref.uri);
        if (!targetPath) {
            vs.window.showWarningMessage(`Cannot open reference '${ctx.label}': path is outside the workspace or missing.`);
            return;
        }

        if (ctx.type === 'folder') {
            await vs.commands.executeCommand('revealInExplorer', vs.Uri.file(targetPath));
            return;
        }

        const doc = await vs.workspace.openTextDocument(vs.Uri.file(targetPath));
        const editor = await vs.window.showTextDocument(doc, { preview: true });
        const startLine = typeof ref.startLine === 'number'
            ? Math.max(0, ref.startLine - 1)
            : typeof ref.line === 'number'
                ? Math.max(0, ref.line)
                : 0;
        const endLine = typeof ref.endLine === 'number' ? Math.max(startLine, ref.endLine - 1) : startLine;
        const column = typeof ref.column === 'number' ? Math.max(0, ref.column) : 0;
        const start = new vs.Position(Math.min(startLine, doc.lineCount - 1), column);
        const end = new vs.Position(Math.min(endLine, doc.lineCount - 1), doc.lineAt(Math.min(endLine, doc.lineCount - 1)).text.length);
        editor.selection = new vs.Selection(start, end);
        editor.revealRange(new vs.Range(start, end), vs.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    private builtinReferences(editor: vs.TextEditor | undefined, queryLower: string): MentionSearchResult[] {
        const builtins: MentionSearchResult[] = [
            {
                type: 'diagnostics',
                uri: editor?.document.uri.fsPath,
                label: 'diagnostics',
                desc: editor ? `Problems for ${vs.workspace.asRelativePath(editor.document.uri)}` : 'Workspace problems',
                cacheStatus: 'live',
            },
            {
                type: 'scope',
                uri: editor?.document.uri.fsPath,
                label: 'scope',
                desc: editor ? `Current cursor scope in ${vs.workspace.asRelativePath(editor.document.uri)}` : 'Current CWTools scope',
                line: editor?.selection.active.line,
                column: editor?.selection.active.character,
                cacheStatus: 'live',
            },
            {
                type: 'symbol',
                label: 'symbol:',
                desc: 'Search workspace symbols with @symbol:<name>',
                cacheStatus: 'live',
            },
            {
                type: 'vanilla',
                label: 'vanilla::',
                desc: 'Reference vanilla cache with @vanilla::<type>:<id>',
                cacheStatus: 'cached',
            },
            {
                type: 'blackboard',
                label: 'blackboard:',
                desc: 'Reference shared blackboard entries with @blackboard:<key>',
                cacheStatus: 'cached',
            },
        ];

        if (editor && !editor.selection.isEmpty) {
            const relPath = vs.workspace.asRelativePath(editor.document.uri);
            const text = editor.document.getText(editor.selection);
            builtins.unshift({
                type: 'code_selection',
                uri: relPath,
                label: 'selection',
                desc: `${relPath} L${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
                startLine: editor.selection.start.line + 1,
                endLine: editor.selection.end.line + 1,
                tokenEstimate: this.estimateTokens(text),
                cacheStatus: editor.document.isDirty ? 'live' : 'disk',
            });
        }

        return builtins.filter(item =>
            !queryLower ||
            item.label.toLowerCase().includes(queryLower) ||
            item.desc.toLowerCase().includes(queryLower)
        );
    }

    /**
     * Return the N most recently accessed workspace documents as mention results.
     * Uses the already-open textDocument list (no fs scan needed).
     */
    private recentWorkspaceFiles(limit: number): MentionSearchResult[] {
        const docs = vs.workspace.textDocuments
            .filter(d =>
                d.uri.scheme === 'file'
                && !d.isUntitled
                && !isAgentTempPath(d.uri.fsPath)
                && !d.uri.fsPath.includes('node_modules')
            );
        // Sort by most recently changed (dirty first, then by fsPath length as heuristic)
        docs.sort((a, b) => {
            if (a.isDirty !== b.isDirty) return a.isDirty ? -1 : 1;
            return a.uri.fsPath.length - b.uri.fsPath.length;
        });
        return docs.slice(0, limit).map(d => ({
            type: 'file' as const,
            uri: d.uri.fsPath,
            label: path.basename(d.uri.fsPath),
            desc: vs.workspace.asRelativePath(d.uri),
            tokenEstimate: Math.ceil(d.getText().length / 4),
            cacheStatus: d.isDirty ? 'live' as const : 'disk' as const,
        }));
    }

    private async searchWorkspaceFiles(query: string, maxResults: number): Promise<MentionSearchResult[]> {
        if (maxResults <= 0) return [];
        const globPattern = `**/*${query}*.*`;
        const files = await vs.workspace.findFiles(globPattern, '**/node_modules/**', maxResults);
        files.sort((a, b) => {
            const baseA = path.basename(a.fsPath).toLowerCase();
            const baseB = path.basename(b.fsPath).toLowerCase();
            const q = query.toLowerCase();
            const idxA = baseA.indexOf(q);
            const idxB = baseB.indexOf(q);
            if (idxA !== idxB) {
                if (idxA === -1) return 1;
                if (idxB === -1) return -1;
                return idxA - idxB;
            }
            return a.fsPath.length - b.fsPath.length;
        });

        return Promise.all(files.map(async f => {
            let stat: vs.FileStat | undefined;
            try {
                stat = await vs.workspace.fs.stat(f);
            } catch {
                stat = undefined;
            }
            return {
                type: 'file' as const,
                uri: f.fsPath,
                label: path.basename(f.fsPath),
                desc: vs.workspace.asRelativePath(f),
                tokenEstimate: stat ? Math.ceil(stat.size / 4) : undefined,
                cacheStatus: vs.workspace.textDocuments.some(d => d.uri.fsPath.toLowerCase() === f.fsPath.toLowerCase()) ? 'live' as const : 'disk' as const,
            };
        }));
    }

    private searchWorkspaceFolders(query: string, maxResults: number): MentionSearchResult[] {
        const root = getProjectWorkspaceRoot();
        if (!root || maxResults <= 0) return [];
        const matches: MentionSearchResult[] = [];
        const q = query.toLowerCase();
        const ignored = new Set(['.git', 'node_modules', 'release', 'bin', 'obj', '.vscode-test']);
        const walk = (dir: string, depth: number): void => {
            if (matches.length >= maxResults || depth > 4) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (matches.length >= maxResults) break;
                if (!entry.isDirectory() || ignored.has(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.name.toLowerCase().includes(q)) {
                    matches.push({
                        type: 'folder',
                        uri: fullPath,
                        label: entry.name,
                        desc: vs.workspace.asRelativePath(fullPath),
                        cacheStatus: 'disk',
                    });
                }
                walk(fullPath, depth + 1);
            }
        };
        walk(root, 0);
        return matches;
    }

    private async searchSymbols(query: string, limit = 8): Promise<MentionSearchResult[]> {
        const q = query.trim();
        if (!q) return [];
        try {
            const symbols = await vs.commands.executeCommand<vs.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q);
            if (!symbols) return [];
            return symbols.slice(0, limit).map(s => ({
                type: 'symbol' as const,
                uri: s.location.uri.fsPath,
                label: s.name,
                desc: `${vs.SymbolKind[s.kind]} in ${vs.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`,
                name: s.name,
                kind: vs.SymbolKind[s.kind],
                line: s.location.range.start.line,
                column: s.location.range.start.character,
                cacheStatus: 'live' as const,
            }));
        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Symbol mention search failed', e);
            return [];
        }
    }

    private async searchVanilla(query: string): Promise<MentionSearchResult[]> {
        const match = query.match(/^vanilla::([^:]*)(?::(.*))?$/i);
        const vanillaType = match?.[1]?.trim() ?? '';
        const vanillaId = match?.[2]?.trim() ?? '';
        if (!vanillaType) {
            return [{
                type: 'vanilla',
                label: 'vanilla::<type>:<id>',
                desc: 'Format: vanilla::<type returned by query_types>::<identifier from active evidence>',
                vanillaType: '',
                vanillaId: '',
                cacheStatus: 'cached',
            }];
        }

        try {
            const raw = await vs.commands.executeCommand<any>(
                'cwtools.ai.queryTypes',
                vanillaType,
                vanillaId,
                20,
                true,
            );
            const instances = Array.isArray(raw?.instances) ? raw.instances : [];
            if (instances.length === 0 && vanillaId) {
                return [{
                    type: 'vanilla',
                    label: `vanilla::${vanillaType}:${vanillaId}`,
                    desc: 'Vanilla cache reference (no preview result yet)',
                    vanillaType,
                    vanillaId,
                    cacheStatus: 'cached',
                }];
            }
            return instances.slice(0, 20).map((item: any) => ({
                type: 'vanilla' as const,
                uri: item.file,
                label: item.id ? `vanilla::${vanillaType}:${item.id}` : `vanilla::${vanillaType}`,
                desc: item.file ? `${vanillaType} in ${item.file}` : `vanilla ${vanillaType}`,
                vanillaType,
                vanillaId: item.id ?? vanillaId,
                cacheStatus: 'cached' as const,
            }));
        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Vanilla mention search failed', e);
            return [{
                type: 'vanilla',
                label: `vanilla::${vanillaType}${vanillaId ? `:${vanillaId}` : ''}`,
                desc: 'Vanilla cache reference; query will be resolved in the prompt',
                vanillaType,
                vanillaId,
                cacheStatus: 'cached',
            }];
        }
    }

    private searchBlackboard(query: string): MentionSearchResult[] {
        const bb = this.getBlackboard();
        if (!bb) return [];
        const q = query.trim();
        const entries = q ? bb.search(q, 12) : bb.queryByPrefix('').slice(0, 12);
        return entries.map(entry => ({
            type: 'blackboard' as const,
            label: `blackboard:${entry.key}`,
            desc: `${entry.type} v${entry.version} by ${entry.authorAgentId}`,
            key: entry.key,
            tokenEstimate: this.estimateTokens(entry.value),
            cacheStatus: 'cached' as const,
        }));
    }

    private async resolveLiveCodeContext(uriStr: string, startLine: number, endLine: number): Promise<string> {
        try {
            const targetPath = this.resolveWorkspacePath(uriStr);
            if (!targetPath) return `// [Context file is outside the workspace]`;
            const targetUri = vs.Uri.file(targetPath);

            const activeDoc = vs.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === targetUri.fsPath.toLowerCase());
            if (activeDoc) {
                let text = '';
                const start = Math.max(0, startLine - 1);
                const end = Math.min(activeDoc.lineCount - 1, endLine - 1);
                for (let i = start; i <= end; i++) text += activeDoc.lineAt(i).text + '\n';
                return text.trimEnd();
            }

            const data = await vs.workspace.fs.readFile(targetUri);
            const content = new TextDecoder('utf-8').decode(data);
            const lines = content.split(/\r?\n/);
            const start = Math.max(0, startLine - 1);
            const end = Math.min(lines.length - 1, endLine - 1);
            return lines.slice(start, end + 1).join('\n').trimEnd();
        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to resolve live code context', e);
            return `// [Failed to read context]`;
        }
    }

    private async readReferencedFilePreview(refPath: string | undefined): Promise<string> {
        const targetPath = this.resolveWorkspacePath(refPath);
        if (!targetPath) {
            return `Reference unavailable: ${refPath || '(missing path)'} is outside the workspace or no workspace is open.`;
        }

        try {
            const targetUri = vs.Uri.file(targetPath);
            const openDoc = vs.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === targetPath.toLowerCase());
            let content: string;
            if (openDoc) {
                content = openDoc.getText();
            } else {
                const stat = await vs.workspace.fs.stat(targetUri);
                if (stat.type === vs.FileType.Directory) {
                    return await this.listReferencedFolderPreview(targetPath);
                }
                if (stat.size > 1_000_000) {
                    return `File: ${this.workspaceLabel(targetPath)}\n[File is ${stat.size} bytes. Use read_file with a range or centerLine/radius for targeted context.]`;
                }
                content = new TextDecoder('utf-8').decode(await vs.workspace.fs.readFile(targetUri));
            }

            const lines = content.split(/\r?\n/);
            const maxLines = 220;
            const maxChars = 24_000;
            let preview = lines.slice(0, maxLines).join('\n');
            let truncated = lines.length > maxLines;
            if (preview.length > maxChars) {
                preview = preview.slice(0, maxChars);
                truncated = true;
            }

            return [
                `File: ${this.workspaceLabel(targetPath)} (${lines.length} lines)`,
                '```',
                preview,
                '```',
                truncated ? '[Truncated. Use read_file with an exact range or centerLine/radius if needed.]' : '',
            ].filter(Boolean).join('\n');
        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, `Failed to read referenced file '${refPath}'`, e);
            return `Reference unavailable: failed to read ${refPath || '(missing path)'}.`;
        }
    }

    private async listReferencedFolderPreview(refPath: string | undefined): Promise<string> {
        const targetPath = this.resolveWorkspacePath(refPath);
        if (!targetPath) {
            return `Folder reference unavailable: ${refPath || '(missing path)'} is outside the workspace or no workspace is open.`;
        }

        try {
            const entries = await vs.workspace.fs.readDirectory(vs.Uri.file(targetPath));
            const visible = entries
                .filter(([name]) => !name.startsWith('.') && name !== 'node_modules')
                .slice(0, 80)
                .map(([name, type]) => `${type === vs.FileType.Directory ? '[dir] ' : '      '}${name}`);

            return [
                `Folder: ${this.workspaceLabel(targetPath)}`,
                visible.join('\n') || '(empty folder)',
                entries.length > visible.length ? `[${entries.length - visible.length} entries omitted.]` : '',
            ].filter(Boolean).join('\n');
        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, `Failed to list referenced folder '${refPath}'`, e);
            return `Folder reference unavailable: failed to list ${refPath || '(missing path)'}.`;
        }
    }

    private formatReferencedDiagnostics(refPath?: string): string {
        const targetPath = this.resolveWorkspacePath(refPath);
        const pairs = targetPath
            ? [[vs.Uri.file(targetPath), vs.languages.getDiagnostics(vs.Uri.file(targetPath))] as [vs.Uri, vs.Diagnostic[]]]
            : vs.languages.getDiagnostics();

        const entries: string[] = [];
        let total = 0;
        for (const [uri, diagnostics] of pairs) {
            if (isAgentTempPath(uri.fsPath)) continue;
            for (const diag of diagnostics) {
                total++;
                if (entries.length >= 60) continue;
                const severity = diag.severity === vs.DiagnosticSeverity.Error ? 'error'
                    : diag.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                        : diag.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint';
                const loc = `${this.workspaceLabel(uri.fsPath)}:${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
                const codeValue = diagnosticCodeString(diag.code);
                const code = codeValue !== undefined ? ` [${codeValue}]` : '';
                entries.push(`- ${severity} ${loc}${code}: ${diag.message.replace(/\s+/g, ' ')}`);
            }
        }

        if (entries.length === 0) {
            return targetPath
                ? `Diagnostics: no current VS Code diagnostics for ${this.workspaceLabel(targetPath)}.`
                : 'Diagnostics: no current VS Code diagnostics in the workspace.';
        }

        return [
            targetPath ? `Diagnostics for ${this.workspaceLabel(targetPath)}:` : 'Workspace diagnostics:',
            ...entries,
            total > entries.length ? `[${total - entries.length} diagnostics omitted.]` : '',
        ].filter(Boolean).join('\n');
    }

    private async formatReferencedScope(refPath?: string, line?: number, column?: number): Promise<string> {
        const editor = vs.window.activeTextEditor;
        const targetPath = this.resolveWorkspacePath(refPath) || editor?.document.uri.fsPath;
        if (!targetPath) return 'Scope reference unavailable: no active editor or referenced file.';

        const zeroLine = typeof line === 'number' ? line : (editor && editor.document.uri.fsPath === targetPath ? editor.selection.active.line : 0);
        const zeroColumn = typeof column === 'number' ? column : (editor && editor.document.uri.fsPath === targetPath ? editor.selection.active.character : 0);
        const uri = vs.Uri.file(targetPath);

        try {
            const result = await vs.commands.executeCommand<any>(
                'cwtools.ai.getScopeAtPosition',
                uri.toString(),
                zeroLine,
                zeroColumn,
            );
            if (result && result.ok === true) {
                const lines = [
                    `Scope at ${this.workspaceLabel(targetPath)}:${zeroLine + 1}:${zeroColumn + 1}`,
                    `currentScope: ${result.thisScope ?? 'unknown'}`,
                    `root: ${result.root ?? 'unknown'}`,
                    `prevChain: ${Array.isArray(result.prevChain) ? result.prevChain.join(' -> ') : 'unknown'}`,
                    `fromChain: ${Array.isArray(result.fromChain) ? result.fromChain.join(' -> ') : 'unknown'}`,
                ];
                if (result.eventTarget && typeof result.eventTarget === 'object') {
                    const alternatives = Array.isArray(result.eventTarget.alternatives)
                        ? result.eventTarget.alternatives.join(' | ')
                        : '';
                    lines.push(
                        `eventTarget: ${result.eventTarget.name ?? 'unknown'} -> ${result.eventTarget.scope ?? 'unknown'} (${result.eventTarget.certainty ?? 'unresolved'})`,
                    );
                    if (alternatives) lines.push(`eventTargetAlternatives: ${alternatives}`);
                }
                return lines.join('\n');
            }
        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Scope reference lookup failed', e);
        }

        return `Scope reference at ${this.workspaceLabel(targetPath)}:${zeroLine + 1}:${zeroColumn + 1}. If exact scope is needed, call query_scope for this file and position.`;
    }

    private async formatReferencedSymbol(ref: { name?: string; kind?: string; uri?: string; line?: number; column?: number; label: string }): Promise<string> {
        const name = ref.name || ref.label;
        const location = ref.uri ? `${this.workspaceLabel(ref.uri)}:${(ref.line ?? 0) + 1}` : 'workspace';
        const snippet = ref.uri && typeof ref.line === 'number'
            ? await this.readLineWindow(ref.uri, ref.line, 8)
            : '';
        return [
            `Symbol: ${name}`,
            `kind: ${ref.kind ?? 'unknown'}`,
            `location: ${location}`,
            snippet ? ['```', snippet, '```'].join('\n') : 'Use document_symbols/workspace_symbols for deeper symbol analysis.',
        ].join('\n');
    }

    private async formatReferencedVanilla(ref: { vanillaType?: string; vanillaId?: string; label: string }): Promise<string> {
        const vanillaType = ref.vanillaType || ref.label.replace(/^vanilla::/, '').split(':')[0] || '';
        const vanillaId = ref.vanillaId || ref.label.split(':').pop() || '';
        if (!vanillaType) return `Vanilla reference unavailable: missing type in ${ref.label}.`;
        try {
            const raw = await vs.commands.executeCommand<any>(
                'cwtools.ai.queryTypes',
                vanillaType,
                vanillaId,
                20,
                true,
            );
            return [
                `Vanilla cache reference: ${vanillaType}${vanillaId ? `:${vanillaId}` : ''}`,
                '```json',
                JSON.stringify(raw ?? { ok: false, error: 'No result' }, null, 2).slice(0, 20_000),
                '```',
            ].join('\n');
        } catch (e) {
            return `Vanilla reference ${vanillaType}:${vanillaId} could not be resolved directly. Use query_types({ typeName: "${vanillaType}", filter: "${vanillaId}", vanillaOnly: true }). Error: ${String(e)}`;
        }
    }

    private async formatReferencedBlackboard(key?: string): Promise<string> {
        const bb = this.getBlackboard();
        if (!bb || !key) return `Blackboard reference unavailable: ${key || '(missing key)'}.`;
        const entry = bb.read(key);
        if (!entry) return `Blackboard key '${key}' was not found.`;
        const value = await this.resolveBlackboardValue(entry);
        return [
            `Blackboard: ${entry.key}`,
            `type: ${entry.type}, version: ${entry.version}, author: ${entry.authorAgentId}`,
            '```',
            value,
            '```',
        ].join('\n');
    }

    private async openBlackboardReference(key?: string): Promise<void> {
        const bb = this.getBlackboard();
        const entry = key ? bb?.read(key) : undefined;
        if (!entry) {
            vs.window.showWarningMessage(`Blackboard key '${key || ''}' was not found.`);
            return;
        }
        if (entry.value.startsWith('file://')) {
            const filePath = entry.value.slice(7);
            if (fs.existsSync(filePath)) {
                await vs.window.showTextDocument(await vs.workspace.openTextDocument(vs.Uri.file(filePath)), { preview: true });
                return;
            }
        }
        const doc = await vs.workspace.openTextDocument({
            content: await this.resolveBlackboardValue(entry),
            language: 'markdown',
        });
        await vs.window.showTextDocument(doc, { preview: true });
    }

    private async resolveBlackboardValue(entry: BlackboardEntry): Promise<string> {
        if (entry.value.startsWith('file://')) {
            const filePath = entry.value.slice(7);
            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                return content.length > 24_000
                    ? content.slice(0, 24_000) + `\n...[truncated, full ${content.length} chars at ${filePath}]`
                    : content;
            } catch {
                return entry.value;
            }
        }
        return entry.value.length > 24_000 ? entry.value.slice(0, 24_000) + '\n...[truncated]' : entry.value;
    }

    private async readLineWindow(refPath: string, zeroLine: number, radius: number): Promise<string> {
        const targetPath = this.resolveWorkspacePath(refPath);
        if (!targetPath) return '';
        const doc = vs.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === targetPath.toLowerCase());
        const content = doc ? doc.getText() : await fs.promises.readFile(targetPath, 'utf-8').catch(() => '');
        if (!content) return '';
        const lines = content.split(/\r?\n/);
        const start = Math.max(0, zeroLine - radius);
        const end = Math.min(lines.length - 1, zeroLine + radius);
        return lines.slice(start, end + 1).map((line, idx) => `${start + idx + 1}: ${line}`).join('\n');
    }

    private estimateTokens(text: string): number {
        if (!text) return 0;
        return Math.max(1, Math.ceil(text.length / 4));
    }
}
