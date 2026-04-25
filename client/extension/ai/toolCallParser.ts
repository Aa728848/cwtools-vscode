/**
 * CWTools AI Module — Tool Call Parser
 *
 * Extracted from agentRunner.ts to reduce god-object complexity.
 * Handles parsing of text-format tool calls from various LLM output formats:
 *   - DeepSeek DSML (V3.2+)
 *   - Qwen / Hermes / Minimax <tool_call> JSON
 *   - Qwen-Coder <function=fn> XML
 *   - Generic XML (Claude antml_, simple <invoke>)
 */

import type { ToolCall } from './types';
import * as crypto from 'crypto';

/**
 * Parse text-format tool calls from a model response.
 * Uses a state-machine approach for robustness against nested brackets,
 * code blocks, and escaped sequences.
 */
export function parseDsmlToolCalls(content: string, depth: number = 0): ToolCall[] {
    // Safety valve: prevent unbounded recursion from deeply-nested tool_call/function tags
    if (depth > 3) return [];
    const calls: ToolCall[] = [];

    // Normalize full-width pipes common in DeepSeek
    let norm = content.replace(/\uFF5C/g, '|');
    // Unify tag formats by normalizing them to standard <invoke name="...">...</invoke>
    norm = norm.replace(/<\|DSML\|invoke\s+name=/gi, '<invoke name=');
    norm = norm.replace(/<\/\|DSML\|invoke>/gi, '</invoke>');
    norm = norm.replace(/<\|DSML\|parameter\s+name=/gi, '<parameter name=');
    norm = norm.replace(/<\/\|DSML\|parameter>/gi, '</parameter>');

    norm = norm.replace(/<\s*(?:antml_)?invoke\s+name=/gi, '<invoke name=');
    norm = norm.replace(/<\/\s*(?:antml_)?invoke\s*>/gi, '</invoke>');
    norm = norm.replace(/<\s*(?:antml_)?parameter\s+name=/gi, '<parameter name=');
    norm = norm.replace(/<\/\s*(?:antml_)?parameter\s*>/gi, '</parameter>');

    // Qwen Format adaptation
    norm = norm.replace(/<function[= ]["']?([\w.-]+)["']?>/gi, '<invoke name="$1">');
    norm = norm.replace(/<\/function>/gi, '</invoke>');
    norm = norm.replace(/<parameter[= ]["']?([\w.-]+)["']?>/gi, '<parameter name="$1">');

    // State Machine Extractors
    const invokeRe = /<invoke\s+name=["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/invoke>/gi;
    invokeRe.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = invokeRe.exec(norm)) !== null) {
        const toolName = im[1];
        const body = im[2];
        const args: Record<string, string> = {};

        // Extract parameters
        const paramRe = /<parameter\s+name=["']?([\w.-]+)["']?(?:\s+(?:type|string)=["']?[\w]+["']?)?\s*>([\s\S]*?)<\/parameter>/gi;
        paramRe.lastIndex = 0;
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(body)) !== null) {
            args[pm[1]] = pm[2];
        }
        calls.push({
            id: `sm_${crypto.randomUUID()}`, type: 'function',
            function: { name: toolName, arguments: JSON.stringify(args) }
        });
    }
    if (calls.length > 0) return calls;

    // 2. Qwen/Hermes/Minimax JSON in <tool_call>
    const toolCallJsonRe = /<\s*(?:[\w-]+:)?tool_call(?:\s[^>]*)?\s*>([\s\S]*?)<\/\s*(?:[\w-]+:)?tool_call\s*>/gi;
    toolCallJsonRe.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = toolCallJsonRe.exec(content)) !== null) {
        const raw = tm[1];
        // If it contains embedded <function> tag
        if (raw.trimStart().startsWith('<function=') || raw.trimStart().startsWith('<function ')) {
            // Re-process recursively or rely on the normalized XML flow
            const parsed = parseDsmlToolCalls(raw, depth + 1);
            calls.push(...parsed);
        } else {
            try {
                const obj = JSON.parse(raw) as { name?: string; arguments?: unknown };
                if (obj.name) {
                    calls.push({
                        id: `tc_${crypto.randomUUID()}`, type: 'function',
                        function: {
                            name: obj.name,
                            arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments ?? {})
                        }
                    });
                }
            } catch { /* ignore */ }
        }
    }

    return calls;
}

/**
 * Strip all known text-format tool call markup from text.
 * Runs multiple passes; final pass also cleans orphaned lone tags.
 */
export function stripDsmlMarkup(content: string): string {
    // Normalize full-width | first (DeepSeek DSML uses U+FF5C)
    let s = content.replace(/\uFF5C/g, '|');

    // Run up to 4 passes - each pass strips paired open/close blocks
    for (let pass = 0; pass < 4; pass++) {
        const before = s;
        s = s
            // DeepSeek DSML: <|DSML|function_calls>...</|DSML|function_calls>
            .replace(/<\|DSML\|function_calls>[\s\S]*?<\/\|DSML\|function_calls>/gi, '')
            .replace(/<\|DSML\|invoke(?:\s[^>]*)?>[\s\S]*?<\/\|DSML\|invoke>/gi, '')
            // Qwen / Hermes / Minimax: <tool_call>...</tool_call>
            .replace(/<\s*(?:[\w-]+:)?tool_call(?:\s[^>]*)?>[\s\S]*?<\/\s*(?:[\w-]+:)?tool_call\s*>/gi, '')
            // Generic XML / Claude antml_
            .replace(/<\s*(?:antml_)?function_calls\s*>[\s\S]*?<\/\s*(?:antml_)?function_calls\s*>/gi, '')
            .replace(/<\s*(?:antml_)?invoke(?:\s[^>]*)?\s*>[\s\S]*?<\/\s*(?:antml_)?invoke\s*>/gi, '')
            // Orphaned lone open/close tags (safety net for unmatched pairs or broken tags)
            .replace(/<\/?\s*(?:[\w-]+:)?tool_call(?:\s[^>]*)?\s*>/gi, '')
            .replace(/<\/?\s*(?:antml_)?function_calls\s*>/gi, '')
            .replace(/<\/?\s*(?:antml_)?invoke(?:\s[^>]*)?\s*>/gi, '')
            .replace(/<\/?\s*(?:antml_)?parameter(?:\s[^>]*)?\s*>/gi, '')
            // Strip leftover DSML pipe tags
            .replace(/<\/?\s*\|DSML\|[^>]*>/gi, '');
        if (s === before) break; // Stable - stop early
    }

    return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Strip <think>...</think> blocks from text (already emitted as thinking_content steps) */
export function stripThinkBlocks(content: string): string {
    return content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Full clean pipeline for final user-visible content:
 * strip think blocks → strip DSML/XML → normalize whitespace.
 */
export function cleanFinalContent(content: string): string {
    if (!content) return content;
    return stripThinkBlocks(stripDsmlMarkup(content));
}
