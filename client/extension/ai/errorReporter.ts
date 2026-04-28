/**
 * CWTools AI Module — Unified Error Reporter
 *
 * Replaces ad-hoc console.error/warn patterns with a structured, severity-based
 * error reporting service.  Three levels:
 *
 *   fatal  → VS Code notification (window.showErrorMessage) + output channel
 *   warn   → status bar flash + output channel
 *   debug  → output channel only (silent in normal use)
 *
 * All messages are prefixed with `[Eddy]` for easy filtering.
 */

import * as vs from 'vscode';

let _channel: vs.OutputChannel | undefined;

function getChannel(): vs.OutputChannel {
    if (!_channel) {
        _channel = vs.window.createOutputChannel('Eddy CWTool Code');
    }
    return _channel;
}

const PREFIX = '[Eddy]';

/**
 * Unified error reporter for CWTools AI module.
 *
 * Usage:
 *   import { ErrorReporter } from './errorReporter';
 *   ErrorReporter.warn('PromptBuilder', 'CWTOOLS.md not found');
 *   ErrorReporter.fatal('AgentRunner', 'Transaction commit failed', error);
 */
export const ErrorReporter = {
    /**
     * FATAL — user-visible notification + output channel.
     * Use when the error directly blocks the user's workflow.
     */
    fatal(source: string, message: string, error?: unknown): void {
        const detail = error instanceof Error ? error.message : error ? String(error) : '';
        const full = detail ? `${message}: ${detail}` : message;
        getChannel().appendLine(`${PREFIX} [FATAL] [${source}] ${full}`);
        if (error instanceof Error && error.stack) {
            getChannel().appendLine(error.stack);
        }
        void vs.window.showErrorMessage(`${PREFIX} ${full}`);
    },

    /**
     * WARN — status bar flash (5s) + output channel.
     * Use for recoverable degradation that the user might want to know about.
     */
    warn(source: string, message: string, error?: unknown): void {
        const detail = error instanceof Error ? error.message : error ? String(error) : '';
        const full = detail ? `${message}: ${detail}` : message;
        getChannel().appendLine(`${PREFIX} [WARN] [${source}] ${full}`);
        if (error instanceof Error && error.stack) {
            getChannel().appendLine(error.stack);
        }
        // Show in status bar briefly so user is aware but not interrupted
        void vs.window.setStatusBarMessage(`$(warning) ${PREFIX} ${message}`, 5000);
    },

    /**
     * DEBUG — output channel only.
     * Use for developer-interest information that shouldn't bother the user.
     */
    debug(source: string, message: string, error?: unknown): void {
        const detail = error instanceof Error ? error.message : error ? String(error) : '';
        const full = detail ? `${message}: ${detail}` : message;
        getChannel().appendLine(`${PREFIX} [DEBUG] [${source}] ${full}`);
    },

    /**
     * Dispose the output channel (call on extension deactivation).
     */
    dispose(): void {
        _channel?.dispose();
        _channel = undefined;
    },
};
