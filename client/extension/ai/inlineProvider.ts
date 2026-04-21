/**
 * CWTools AI Module — Inline Completion Provider
 *
 * Provides AI-powered inline code completion for PDXScript files.
 * Uses a lightweight prompt (no tool calls) for fast response times.
 * Supports independent model/provider configuration from the chat panel.
 */

import * as vs from 'vscode';
import type { ChatCompletionResponse } from './types';
import { AIService } from './aiService';
import { PromptBuilder } from './promptBuilder';

export class AIInlineCompletionProvider implements vs.InlineCompletionItemProvider {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastRequestId = 0;
    private isEnabled = false;
    /** Track cursor line between calls to detect Enter key press */
    private lastSeenLine = -1;
    private lastSeenUri = '';

    constructor(
        private aiService: AIService,
        private promptBuilder: PromptBuilder
    ) {
        // Watch for configuration changes
        vs.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('cwtools.ai')) {
                this.updateEnabled();
            }
        });
        this.updateEnabled();
    }

    private updateEnabled(): void {
        const config = this.aiService.getConfig();
        this.isEnabled = config.enabled && config.inlineCompletion.enabled;
    }

    async provideInlineCompletionItems(
        document: vs.TextDocument,
        position: vs.Position,
        context: vs.InlineCompletionContext,
        token: vs.CancellationToken
    ): Promise<vs.InlineCompletionItem[] | undefined> {
        if (!this.isEnabled) return undefined;

        // Only provide completions for paradox/stellaris language files
        if (document.languageId !== 'paradox' && document.languageId !== 'stellaris') {
            return undefined;
        }

        // Auto-trigger on Enter (line number increased), Space, or Tab.
        // Explicit trigger (e.g. editor.action.inlineSuggest.trigger) always proceeds.
        if (context.triggerKind === vs.InlineCompletionTriggerKind.Automatic) {
            const uri = document.uri.toString();
            const enteredNewLine = uri === this.lastSeenUri && position.line > this.lastSeenLine;
            this.lastSeenLine = position.line;
            this.lastSeenUri = uri;
            const lineText = document.lineAt(position.line).text;
            const charBefore = position.character > 0 ? lineText.charAt(position.character - 1) : '';
            const isSpace = charBefore === ' ';
            const isTab   = charBefore === '\t';
            if (!enteredNewLine && !isSpace && !isTab) return undefined;
        }

        // Don't complete in comments
        const lineText = document.lineAt(position.line).text;
        const textBeforeCursor = lineText.substring(0, position.character).trimStart();
        if (textBeforeCursor.startsWith('#')) return undefined;

        // Debounce to avoid excessive API calls
        const config = this.aiService.getConfig();
        const debounceMs = config.inlineCompletion.debounceMs;

        return new Promise((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            const requestId = ++this.lastRequestId;

            this.debounceTimer = setTimeout(async () => {
                // Check if this request is still current
                if (requestId !== this.lastRequestId || token.isCancellationRequested) {
                    resolve(undefined);
                    return;
                }

                try {
                    const completion = await this.getCompletion(document, position, token);
                    if (token.isCancellationRequested || requestId !== this.lastRequestId) {
                        resolve(undefined);
                        return;
                    }
                    resolve(completion);
                } catch {
                    resolve(undefined);
                }
            }, debounceMs);
        });
    }

    private async getCompletion(
        document: vs.TextDocument,
        position: vs.Position,
        token: vs.CancellationToken
    ): Promise<vs.InlineCompletionItem[] | undefined> {
        const config = this.aiService.getConfig();

        // Build the lightweight inline prompt
        const messages = this.promptBuilder.buildInlinePrompt({
            fileContent: document.getText(),
            cursorLine: position.line,
            cursorColumn: position.character,
            filePath: document.uri.fsPath,
        });

        // Determine provider and model for inline completion
        const inlineProvider = config.inlineCompletion.provider || config.provider;
        const inlineModel = config.inlineCompletion.model || undefined;

        try {
            const response = await this.aiService.chatCompletion(messages, {
                providerId: inlineProvider,
                model: inlineModel,
                temperature: 0.2,
                maxTokens: 200,  // Keep responses short for inline
            });

            if (token.isCancellationRequested) return undefined;

            const content = response.choices[0]?.message?.content;
            const contentStr = typeof content === 'string' ? content : '';
            if (!contentStr || contentStr.trim().length === 0) return undefined;

            // Clean up the response
            let completionText = contentStr.trim();

            // Remove markdown code fences if present
            completionText = completionText
                .replace(/^```\w*\n?/, '')
                .replace(/\n?```$/, '')
                .trim();

            if (completionText.length === 0) return undefined;

            // Create inline completion item
            const item = new vs.InlineCompletionItem(
                completionText,
                new vs.Range(position, position)
            );

            return [item];
        } catch {
            return undefined;
        }
    }
}
