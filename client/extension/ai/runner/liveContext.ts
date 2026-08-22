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
    const next = collectLiveVsCodeContext();
    const content = `<system-reminder>\n${String(next.content)}\n</system-reminder>`;
    const liveIndexes = messages
        .map((message, index) => String(message.content).includes(LIVE_CONTEXT_MARKER) ? index : -1)
        .filter(index => index >= 0);
    if (liveIndexes.length === 1
        && liveIndexes[0] === messages.length - 1
        && messages.at(-1)?.role === 'user'
        && messages.at(-1)?.content === content) return;
    for (let index = liveIndexes.length - 1; index >= 0; index--) {
        messages.splice(liveIndexes[index]!, 1);
    }

    // Keep volatile editor state after the cacheable transcript. A user-role
    // reminder avoids introducing a late system message on strict providers.
    messages.push({ role: 'user', content });
}
