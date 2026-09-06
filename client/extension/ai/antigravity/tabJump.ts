import * as vs from 'vscode';
import type { AIService } from '../aiService';
import { ErrorReporter } from '../errorReporter';
import { aiText, SOURCE } from '../messages';
import { callAntigravityTab } from './tabCompletion';

/** A manual cursor jump; predicted edits are never applied to the document. */
export class AntigravityTabJump implements vs.Disposable {
    private snapshot: { uri: string; text: string; previousText?: string } | undefined;
    private controller: AbortController | undefined;
    private readonly disposables: vs.Disposable[];

    constructor(private readonly aiService: AIService) {
        this.capture(vs.window.activeTextEditor?.document);
        this.disposables = [
            vs.window.onDidChangeActiveTextEditor(editor => {
                this.controller?.abort();
                this.snapshot = undefined;
                this.capture(editor?.document);
            }),
            vs.workspace.onDidChangeTextDocument(event => {
                if (event.document !== vs.window.activeTextEditor?.document || !event.contentChanges.length) return;
                this.controller?.abort();
                this.capture(event.document);
            }),
            vs.window.onDidChangeTextEditorSelection(() => this.controller?.abort()),
        ];
    }

    private capture(document: vs.TextDocument | undefined): void {
        if (!document || !['stellaris', 'paradox'].includes(document.languageId)) return;
        const text = document.getText();
        const uri = document.uri.toString();
        const previousText = this.snapshot?.uri === uri ? this.snapshot.text : undefined;
        this.snapshot = text.length <= 64_000 ? { uri, text, previousText } : undefined;
    }

    async jump(): Promise<void> {
        const editor = vs.window.activeTextEditor;
        if (!editor || !['stellaris', 'paradox'].includes(editor.document.languageId)) return;
        const config = this.aiService.getConfig();
        if (!config.enabled || (config.inlineCompletion.provider || config.provider) !== 'antigravity') {
            await vs.window.showInformationMessage(aiText('Select Antigravity in AI inline completion settings first.', '请先在 AI 行内补全设置中选择 Antigravity。'));
            return;
        }
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const document = editor.document;
        const version = document.version;
        const selection = editor.selection;
        const cursor = document.offsetAt(selection.active);
        const source = document.getText();
        let start = Math.max(0, cursor - 3000);
        let end = Math.min(source.length, cursor + 3000);
        if (/[\uDC00-\uDFFF]/.test(source.charAt(start))) start++;
        if (/[\uDC00-\uDFFF]/.test(source.charAt(end))) end--;
        const previousText = this.snapshot?.uri === document.uri.toString() ? this.snapshot.previousText?.slice(start, end) : undefined;
        try {
            await vs.window.withProgress({
                location: vs.ProgressLocation.Notification,
                title: aiText('Finding the next edit…', '正在查找下一处编辑位置…'),
                cancellable: true,
            }, async (_progress, token) => {
                const cancellation = token.onCancellationRequested(() => controller.abort());
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
                try {
                    if (token.isCancellationRequested) controller.abort();
                    const edit = await callAntigravityTab(this.aiService.getAntigravityOAuthService(),
                        this.aiService.getSubscriptionProxyService().fetch,
                        { prefix: source.slice(start, cursor), suffix: source.slice(cursor, end), languageId: document.languageId, previousText }, signal, true);
                    if (signal.aborted || document.version !== version || editor !== vs.window.activeTextEditor || !editor.selection.isEqual(selection)) return;
                    if (!edit || start + edit.start === cursor) {
                        await vs.window.showInformationMessage(aiText('No next edit location found nearby.', '附近未找到下一处编辑位置。'));
                        return;
                    }
                    const position = document.positionAt(start + edit.start);
                    editor.selection = new vs.Selection(position, position);
                    editor.revealRange(new vs.Range(position, position), vs.TextEditorRevealType.InCenterIfOutsideViewport);
                } finally {
                    cancellation.dispose();
                }
            });
        } catch (error) {
            if (!controller.signal.aborted) {
                ErrorReporter.warn(SOURCE.INLINE_PROVIDER, 'Antigravity Tab Jump failed', error);
                await vs.window.showErrorMessage(aiText('Antigravity could not find the next edit. Check the AI output log.', 'Antigravity 未能定位下一处编辑，请查看 AI 输出日志。'));
            }
        } finally {
            if (this.controller === controller) this.controller = undefined;
        }
    }

    dispose(): void {
        this.controller?.abort();
        this.disposables.forEach(disposable => disposable.dispose());
        this.snapshot = undefined;
    }
}
