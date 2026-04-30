/**
 * CWTools — CodeActionProvider for AI Quick Fix
 *
 * Registers a CodeActionProvider that surfaces "AI: Fix" and "AI: Explain"
 * actions on CWTools diagnostics. When triggered, these actions send a
 * programmatic message to the AI chat panel to perform the fix or explanation.
 *
 * Localization: uses vscode.env.language to select between Chinese and English.
 */

import * as vs from 'vscode';

// ── i18n ─────────────────────────────────────────────────────────────────────

const isChinese = () => vs.env.language.startsWith('zh');

const i18n = {
    fixTitle: () => isChinese() ? 'AI: 修复此错误' : 'AI: Fix this error',
    explainTitle: () => isChinese() ? 'AI: 解释此错误' : 'AI: Explain this error',
    fixAllTitle: () => isChinese() ? 'AI: 修复文件中所有错误' : 'AI: Fix all errors in file',
};

// ── Provider ─────────────────────────────────────────────────────────────────

export class CWToolsCodeActionProvider implements vs.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vs.CodeActionKind.QuickFix,
    ];

    provideCodeActions(
        document: vs.TextDocument,
        _range: vs.Range | vs.Selection,
        context: vs.CodeActionContext,
        _token: vs.CancellationToken
    ): vs.CodeAction[] {
        // Accept all diagnostics within our supported languages.
        // CWTools F# backend sets both 'code' and 'source' to the error code itself (e.g. "CW001").
        const cwDiags = context.diagnostics;

        if (cwDiags.length === 0) return [];

        const actions: vs.CodeAction[] = [];

        // Per-diagnostic actions
        for (const diag of cwDiags) {
            // "Fix this error"
            const fixAction = new vs.CodeAction(
                `${i18n.fixTitle()} — ${truncate(diag.message, 50)}`,
                vs.CodeActionKind.QuickFix
            );
            fixAction.command = {
                command: 'cwtools.ai.codeAction.fix',
                title: i18n.fixTitle(),
                arguments: [document.uri, diag],
            };
            fixAction.diagnostics = [diag];
            fixAction.isPreferred = true;
            actions.push(fixAction);

            // "Explain this error"
            const explainAction = new vs.CodeAction(
                `${i18n.explainTitle()} — ${truncate(diag.message, 50)}`,
                vs.CodeActionKind.QuickFix
            );
            explainAction.command = {
                command: 'cwtools.ai.codeAction.explain',
                title: i18n.explainTitle(),
                arguments: [document.uri, diag],
            };
            explainAction.diagnostics = [diag];
            actions.push(explainAction);
        }

        // "Fix all" action if multiple diagnostics
        if (cwDiags.length > 1) {
            const fixAllAction = new vs.CodeAction(
                `${i18n.fixAllTitle()} (${cwDiags.length})`,
                vs.CodeActionKind.QuickFix
            );
            fixAllAction.command = {
                command: 'cwtools.ai.codeAction.fixAll',
                title: i18n.fixAllTitle(),
                arguments: [document.uri],
            };
            actions.push(fixAllAction);
        }

        return actions;
    }
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the CodeActionProvider and its associated commands.
 * Call this from extension.ts activate().
 *
 * @param context - ExtensionContext
 * @param sendProgrammaticMessage - function to send a message to the AI chat panel
 * @param supportedLanguageIds - list of language IDs to register for (e.g. ['stellaris'])
 */
export function registerCodeActions(
    context: vs.ExtensionContext,
    sendProgrammaticMessage: (msg: string) => Promise<void>,
    supportedLanguageIds: string[] = ['stellaris']
): void {
    // Register provider for all supported languages
    const selector: vs.DocumentSelector = supportedLanguageIds.map(lang => ({ language: lang }));
    context.subscriptions.push(
        vs.languages.registerCodeActionsProvider(
            selector,
            new CWToolsCodeActionProvider(),
            { providedCodeActionKinds: CWToolsCodeActionProvider.providedCodeActionKinds }
        )
    );

    // Fix single diagnostic
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.ai.codeAction.fix', async (uri: vs.Uri, diag: vs.Diagnostic) => {
            const relPath = vs.workspace.asRelativePath(uri);
            const line = diag.range.start.line + 1;
            await sendProgrammaticMessage(
                isChinese()
                    ? `请修复文件 \`${relPath}\` 第 ${line} 行的 CWTools 错误：\`${diag.message}\`（错误代码：${diag.code ?? 'N/A'}）`
                    : `Fix the CWTools error in \`${relPath}\` at line ${line}: \`${diag.message}\` (code: ${diag.code ?? 'N/A'})`
            );
        })
    );

    // Explain single diagnostic
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.ai.codeAction.explain', async (uri: vs.Uri, diag: vs.Diagnostic) => {
            const relPath = vs.workspace.asRelativePath(uri);
            const line = diag.range.start.line + 1;
            await sendProgrammaticMessage(
                isChinese()
                    ? `请解释文件 \`${relPath}\` 第 ${line} 行的 CWTools 错误：\`${diag.message}\`（错误代码：${diag.code ?? 'N/A'}）。说明原因、影响和修复方法。`
                    : `Explain the CWTools error in \`${relPath}\` at line ${line}: \`${diag.message}\` (code: ${diag.code ?? 'N/A'}). Describe the cause, impact, and how to fix it.`
            );
        })
    );

    // Fix all diagnostics in file
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.ai.codeAction.fixAll', async (uri: vs.Uri) => {
            const relPath = vs.workspace.asRelativePath(uri);
            await sendProgrammaticMessage(
                isChinese()
                    ? `请获取并修复当前文件 \`${relPath}\` 中的所有 CWTools 诊断错误。`
                    : `Get and fix all CWTools diagnostic errors in \`${relPath}\`.`
            );
        })
    );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '…';
}
