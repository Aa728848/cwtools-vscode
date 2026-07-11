import * as path from 'path';
import * as vs from 'vscode';
import type { ChatMessage } from '../types';

export const LIVE_CONTEXT_MARKER = '[LIVE VS CODE CONTEXT]';

export function collectLiveVsCodeContext(): ChatMessage {
    const editor = vs.window.activeTextEditor;
    const dirtyDocuments = vs.workspace.textDocuments.filter(document => document.isDirty && !document.isUntitled);
    const diagnostics = vs.languages.getDiagnostics()
        .flatMap(([uri, entries]) => entries
            .filter(entry => entry.severity === vs.DiagnosticSeverity.Error || entry.severity === vs.DiagnosticSeverity.Warning)
            .slice(0, 5)
            .map(entry => `${path.basename(uri.fsPath)}:${entry.range.start.line + 1} ${entry.message}`))
        .slice(0, 12);
    const lines = [
        LIVE_CONTEXT_MARKER,
        `Refreshed: ${new Date().toISOString()}`,
        `Workspace trusted: ${vs.workspace.isTrusted !== false}`,
        `Workspace folders: ${(vs.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath).join(', ') || '(none)'}`,
        editor
            ? `Active editor: ${editor.document.uri.fsPath}:${editor.selection.active.line + 1}:${editor.selection.active.character + 1}; dirty=${editor.document.isDirty}; selection=${editor.document.getText(editor.selection).slice(0, 1000) || '(none)'}`
            : 'Active editor: (none)',
        `Dirty documents: ${dirtyDocuments.map(document => document.uri.fsPath).join(', ') || '(none)'}`,
        `Current diagnostics: ${diagnostics.length > 0 ? diagnostics.join(' | ') : '(none)'}`,
    ];
    return { role: 'system', content: lines.join('\n') };
}

export function refreshLiveVsCodeContext(messages: ChatMessage[]): void {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'system' && String(messages[index]?.content).startsWith(LIVE_CONTEXT_MARKER)) {
            messages.splice(index, 1);
        }
    }
    const insertionIndex = messages[0]?.role === 'system' ? 1 : 0;
    messages.splice(insertionIndex, 0, collectLiveVsCodeContext());
}
