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
import { diagnosticCodeString } from './diagnosticI18n';

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
        // Accept all diagnostics within our supported languages; Rust protocol
        // diagnostics preserve the stable CW code used by these actions.
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
            await sendProgrammaticMessage(buildSingleDiagnosticFixPrompt(relPath, diag));
        })
    );

    // Explain single diagnostic
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.ai.codeAction.explain', async (uri: vs.Uri, diag: vs.Diagnostic) => {
            const relPath = vs.workspace.asRelativePath(uri);
            await sendProgrammaticMessage(buildSingleDiagnosticExplainPrompt(relPath, diag));
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

function buildSingleDiagnosticFixPrompt(relPath: string, diag: vs.Diagnostic): string {
    const code = diagnosticCodeString(diag.code) ?? 'N/A';
    const range = diagnosticRangeText(diag);

    return isChinese()
        ? [
            '请修复下面这一个 CWTools 诊断。',
            '',
            '目标诊断：',
            `- 文件：\`${relPath}\``,
            `- 位置：${range}`,
            `- 错误代码：${code}`,
            `- 消息：\`${diag.message}\``,
            '',
            '范围限制：只修复这一个诊断，不要修复同一文件中的其它诊断。可以使用 `get_diagnostics` 验证目标是否消失，但该工具返回的其它诊断都属于本次 quick fix 的范围外问题，请保留给用户后续单独处理。不要执行“修复所有错误”的宽范围任务。',
            '本次 quick fix 的完成标准是该目标诊断被解决；同文件其它既有诊断仍存在时，也应停止并汇报为范围外。',
            '请优先使用目标行或目标块附近的最小安全修改；只有解决这个诊断确实需要时，才扩大到紧邻上下文。',
            '如果这是缺失本地化键诊断，只创建或更新诊断消息明确点名的那个键；不要顺手创建同一文件中其它缺失键、`_desc` 配对键或相邻概念的本地化。',
        ].join('\n')
        : [
            'Fix only this one CWTools diagnostic.',
            '',
            'Target diagnostic:',
            `- File: \`${relPath}\``,
            `- Range: ${range}`,
            `- Code: ${code}`,
            `- Message: \`${diag.message}\``,
            '',
            'Scope limit: fix only this one diagnostic. Do not fix other diagnostics in the same file. You may use `get_diagnostics` to verify that the target disappeared, but any other diagnostics returned by that tool are out of scope for this quick fix and should be left for the user to address separately. Do not run a broad "fix all errors" task.',
            'Completion criterion for this quick fix is that the target diagnostic is resolved; if other pre-existing diagnostics remain in the same file, stop and report them as out of scope.',
            'Prefer the smallest safe edit around the target line or target block; expand to adjacent context only when required to resolve this diagnostic.',
            'If this is a missing-localisation diagnostic, create or update only the exact key named by this diagnostic message; do not also create other missing keys, `_desc` companion keys, or neighbouring concept localisation in the same file.',
        ].join('\n');
}

function buildSingleDiagnosticExplainPrompt(relPath: string, diag: vs.Diagnostic): string {
    const code = diagnosticCodeString(diag.code) ?? 'N/A';
    const range = diagnosticRangeText(diag);

    return isChinese()
        ? [
            '请只解释下面这一个 CWTools 诊断，不要修复文件，也不要解释同一文件中的其它诊断。',
            '',
            '目标诊断：',
            `- 文件：\`${relPath}\``,
            `- 位置：${range}`,
            `- 错误代码：${code}`,
            `- 消息：\`${diag.message}\``,
            '',
            '说明原因、影响和可选修复方法。若看到其它诊断，请只在必要时说明它们不属于本次解释范围。',
        ].join('\n')
        : [
            'Explain only this one CWTools diagnostic. Do not modify files and do not explain other diagnostics in the same file.',
            '',
            'Target diagnostic:',
            `- File: \`${relPath}\``,
            `- Range: ${range}`,
            `- Code: ${code}`,
            `- Message: \`${diag.message}\``,
            '',
            'Describe the cause, impact, and possible fix. If you see other diagnostics, mention only when necessary that they are outside this explanation scope.',
        ].join('\n');
}

function diagnosticRangeText(diag: vs.Diagnostic): string {
    const start = diag.range.start;
    const end = diag.range.end;
    const startText = `${start.line + 1}:${start.character + 1}`;
    const endText = `${end.line + 1}:${end.character + 1}`;
    return startText === endText ? startText : `${startText}-${endText}`;
}
