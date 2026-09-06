import { expect } from 'chai';
import type * as vs from 'vscode';
import type { AIService } from '../../extension/ai/aiService';
import type { AIUserConfig } from '../../extension/ai/types';
import { createVscodeRunnerStub, loadModuleWithVscodeStub } from './runnerTestFixtures';

class Position {
    constructor(readonly line: number, readonly character: number) {}
}
class Range {
    constructor(readonly start: Position, readonly end: Position) {}
}
class Selection extends Range {
    get active() { return this.end; }
    isEqual(other: Selection) { return this.start.line === other.start.line && this.start.character === other.start.character && this.end.line === other.end.line && this.end.character === other.end.character; }
}
class InlineCompletionItem {
    constructor(readonly insertText: string, readonly range: Range) {}
}
class SnippetString { constructor(readonly value: string) {} }
const disposable = { dispose() {} };
const token = { isCancellationRequested: false, onCancellationRequested: () => disposable } as vs.CancellationToken;

function fixture(text: string) {
    const document = {
        version: 1, languageId: 'stellaris', uri: { fsPath: '/synthetic/current.txt', toString: () => 'file:///synthetic/current.txt' },
        get lineCount() { return text.split('\n').length; },
        getText: (range?: Range) => range ? text.slice(document.offsetAt(range.start), document.offsetAt(range.end)) : text,
        lineAt: (line: number) => ({ text: text.split('\n')[line]?.replace(/\r$/, '') || '' }),
        offsetAt: (position: Position) => text.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
        positionAt: (offset: number) => { const lines = text.slice(0, offset).split('\n'); return new Position(lines.length - 1, lines[lines.length - 1]?.length || 0); },
    };
    const editor = { document, selection: new Selection(new Position(0, 0), new Position(0, 0)), revealRange() {} };
    const base = createVscodeRunnerStub();
    const stub = { ...base, Position, Range, Selection, InlineCompletionItem, SnippetString,
        InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 }, ProgressLocation: { Notification: 15 }, TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
        workspace: { ...base.workspace, onDidChangeConfiguration: () => disposable, onDidChangeTextDocument: () => disposable },
        commands: { ...base.commands, registerCommand: () => disposable },
        window: { ...base.window, activeTextEditor: editor, onDidChangeActiveTextEditor: () => disposable, onDidChangeTextEditorSelection: () => disposable,
            withProgress: (_options: unknown, task: (progress: unknown, token: vs.CancellationToken) => Promise<void>) => task({}, token),
        },
    };
    const config = { enabled: true, provider: 'antigravity', mcp: { servers: [] }, inlineCompletion: {
        enabled: true, provider: 'antigravity', model: 'tab_flash_lite_preview', debounceMs: 0, includeMcpContext: false,
        lspFastPath: false, contextBeforeLines: 20, contextAfterLines: 10, requestTimeoutMs: 1000, maxTokens: 128, overlapStripping: true,
    } } as unknown as AIUserConfig;
    return { document, editor, stub, config };
}

describe('Antigravity editor integration', () => {
    it('preserves native indentation in ghost text and discards results for an edited document', async () => {
        const f = fixture('immediate = {\r\n}\r\n');
        let finish: (value: string) => void = () => undefined;
        let started: () => void = () => undefined;
        let waiting = false;
        const ai = { getConfig: () => f.config, fimCompletion: async () => {
            if (!waiting) return '    value = 1\r\n';
            started(); return new Promise<string>(resolve => { finish = resolve; });
        } } as unknown as AIService;
        const { AIInlineCompletionProvider } = loadModuleWithVscodeStub<typeof import('../../extension/ai/inlineProvider')>('../../extension/ai/inlineProvider', f.stub);
        const provider = new AIInlineCompletionProvider(ai, {} as import('../../extension/ai/promptBuilder').PromptBuilder, {} as import('../../extension/ai/usageTracker').UsageTracker);
        try {
            const position = new Position(1, 0) as vs.Position;
            const context = { triggerKind: 1, selectedCompletionInfo: undefined };
            const items = await provider.provideInlineCompletionItems(f.document as unknown as vs.TextDocument, position, context, token);
            expect(items?.[0]?.insertText).to.equal('    value = 1\r\n');
            waiting = true;
            f.document.version++;
            const ready = new Promise<void>(resolve => { started = resolve; });
            const pending = provider.provideInlineCompletionItems(f.document as unknown as vs.TextDocument, position, context, token);
            await ready;
            f.document.version++;
            finish('stale');
            expect(await pending).to.equal(undefined);
        } finally { provider.dispose(); }
    });

    for (const stale of [false, true]) {
        it(stale ? 'leaves the cursor in place when selection changes during a jump request' : 'jumps to a predicted edit without changing the source', async () => {
            const f = fixture('amount = 1\n\nresult = value\n');
            const source = f.document.getText();
            const initial = f.editor.selection;
            let started: () => void = () => undefined;
            let finish: () => void = () => undefined;
            const ready = new Promise<void>(resolve => { started = resolve; });
            const fetchFn: typeof fetch = async () => {
                started(); await new Promise<void>(resolve => { finish = resolve; });
                const output = '": "value", "ReplacementContent": "amount"}]}</replace_file_content>';
                return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: output }] }, finishReason: 'STOP' }] } }), { headers: { 'Content-Type': 'application/json' } });
            };
            const ai = { getConfig: () => f.config, getAntigravityOAuthService: () => ({ getRequestContext: async () => ({ token: 'test', projectId: 'project-test' }) }), getSubscriptionProxyService: () => ({ fetch: fetchFn }) } as unknown as AIService;
            const { AntigravityTabJump } = loadModuleWithVscodeStub<typeof import('../../extension/ai/antigravity/tabJump')>('../../extension/ai/antigravity/tabJump', f.stub);
            const jump = new AntigravityTabJump(ai);
            try {
                const pending = jump.jump();
                await ready;
                if (stale) f.editor.selection = new Selection(new Position(1, 0), new Position(1, 0));
                finish();
                await pending;
                expect(f.document.getText()).to.equal(source);
                expect(f.editor.selection.active).to.deep.equal(stale ? new Position(1, 0) : new Position(2, 9));
                expect(f.editor.selection).not.to.equal(initial);
            } finally { jump.dispose(); }
        });
    }
});
