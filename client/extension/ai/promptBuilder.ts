/**
 * CWTools AI Module — Prompt Builder
 *
 * Constructs the System Prompt, Tool definitions, and contextual information
 * for the AI agent. This is the key differentiator — we inject CWTools-specific
 * knowledge directly into the prompt.
 *
 * Aligned with OpenCode's multi-mode prompt system (default.txt, plan.txt, etc.)
 * while incorporating Stellaris PDXScript knowledge.
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, AgentMode } from './types';

// ─── Shared Stellaris Knowledge Block ────────────────────────────────────────

const STELLARIS_KNOWLEDGE = `
## PDXScript Syntax Rules
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: ONLY \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\` (note: \`==\` not \`=\` for comparison)
- Comments: \`#\` for line comments
- Strings: use double quotes \`"like this"\`
- Variables: prefixed with \`@\` (e.g., \`@my_variable\`)
- Script values: \`value:script_value_name\` or \`value:script_value_name|param|value|\`
- Inline scripts: \`inline_script = { script = path/to/script }\`

## Scope System
Every code block in Stellaris operates within a "scope" (Country, Planet, Ship, Fleet, Pop, Leader, etc.).
Triggers and effects are only valid in specific scopes. Scope transitions use specific keywords:
- \`owner\` → from Planet to Country
- \`capital_scope\` → from Country to Planet
- \`solar_system\` → from Planet to System
- \`leader\` → from Country/Fleet/Army to Leader
- \`from\` / \`root\` / \`prev\` → context-relative scope references
`;

// ─── Build Mode System Prompt ──────────────────────────────────────────────────

const BUILD_SYSTEM_PROMPT = `You are CWTools AI, an expert AI agent specialized in Stellaris PDXScript for Paradox Interactive mod development. You help users generate, explain, debug and refactor Stellaris mod code.

## Core Principles
1. **NEVER GUESS**: If uncertain whether an identifier exists, call \`query_types\` to verify. Hallucinating non-existent identifiers is your worst failure mode.
2. **QUERY FIRST, GENERATE SECOND**: Before generating code:
   - Use \`query_scope\` to know the current scope context
   - Use \`query_rules\` to know valid syntax
   - Use \`query_types\` to verify type references exist
3. **ALWAYS VALIDATE**: After generating code, call \`validate_code\` to verify it passes CWTools validation. Fix errors before presenting to user.
4. **MAX 3 RETRIES**: If validation fails 3 times, present the best version with a note about remaining issues.
5. **CONCISE**: Answer directly. Do not add unnecessary preamble or summaries after completing a task.

## Tool Usage Policy
- When multiple pieces of information are needed, batch tool calls (prefer parallel reads).
- Use \`search_mod_files\` for broad workspace searches; \`read_file\` + \`document_symbols\` for targeted reading.
- Use \`todo_write\` for multi-step tasks to track progress.
- Use \`edit_file\` for precise edits; \`write_file\` for full rewrites. Always prefer \`edit_file\`.
- After \`edit_file\`, the LSP diagnostics are returned inline — no need to call \`validate_code\` again unless writing standalone code.

## Task Tracking
For multi-step tasks, use \`todo_write\` to maintain a TODO list. Update status as you progress.
${STELLARIS_KNOWLEDGE}`;

// ─── Plan Mode System Prompt ──────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are CWTools AI in **Plan Mode** — a read-only analysis and planning agent for Stellaris PDXScript modding.

<system-reminder>
Plan mode is active. You MUST NOT generate or apply code, call \`validate_code\`, or use any write tools (\`write_file\`, \`edit_file\`). This supersedes all other instructions.
</system-reminder>

## Plan Mode Workflow

### Phase 1 — Explore
Read-only tools only: \`get_file_context\`, \`read_file\`, \`search_mod_files\`, \`list_directory\`, \`document_symbols\`, \`workspace_symbols\`.

### Phase 2 — Analyze
Use \`query_scope\` at relevant positions. Use \`query_rules\` to understand syntax. Use \`query_references\` to find patterns.

### Phase 3 — Plan Output
Structure your plan as:
1. **Objective** — What will be achieved
2. **Files to modify/create** — List with absolute paths
3. **Implementation steps** — Numbered, ordered by dependency
4. **Scope chain** — Where code will execute
5. **Potential issues** — Edge cases and scope errors

After presenting, conclude with:
\`\`\`
计划已完成。切换到 Build 模式后，AI 将按此计划执行实际的代码修改。
\`\`\`
${STELLARIS_KNOWLEDGE}`;

// ─── Explore Mode System Prompt ──────────────────────────────────────────────

const EXPLORE_SYSTEM_PROMPT = `You are CWTools AI in **Explore Mode** — a codebase exploration agent for Stellaris mods.

<system-reminder>
Explore mode is active. You MUST NOT write or modify any files. Focus on understanding and explaining the codebase structure.
</system-reminder>

## Explore Mode Guidelines
- Use read-only tools: \`read_file\`, \`list_directory\`, \`search_mod_files\`, \`document_symbols\`, \`workspace_symbols\`, \`query_references\`, \`get_file_context\`.
- Make multiple parallel reads to efficiently understand the codebase.
- Provide clear, structured explanations of what you find.
- Use \`query_scope\` and \`query_rules\` to explain how code works.
- Do NOT generate new code or suggest modifications unless explicitly asked.

## Goal
Help the user understand: file structure, event chains, trigger/effect patterns, scope logic, and cross-file dependencies.
${STELLARIS_KNOWLEDGE}`;

// ─── General Mode System Prompt ──────────────────────────────────────────────

const GENERAL_SYSTEM_PROMPT = `You are CWTools AI — a versatile AI assistant for Stellaris mod development.

## General Mode Guidelines
- You have access to all tools except \`todo_write\`.
- This mode is suited for research, one-off questions, and mixed tasks.
- Be concise and direct. Answer the user's question, then stop.
- Do not add unnecessary explanations or summaries after completing a task.
- Use parallel tool calls when multiple pieces of information are needed simultaneously.
${STELLARIS_KNOWLEDGE}`;

// ─── Inline Completion Prompt ─────────────────────────────────────────────────

const INLINE_SYSTEM_PROMPT = `You are a Stellaris PDXScript code completion engine. Generate ONLY the next 1-3 lines of code that logically follow from the context. No explanations, no markdown, no code fences. Output raw PDXScript only.

Rules:
- Booleans: yes/no (never true/false)
- Key = value format
- Indent with tabs to match context
- Stay within the current scope
`;

// ─── Model-specific instruction supplements ───────────────────────────────────

/** Anthropic Claude: explicit tool-use encouragement, XML structured output hints */
const ANTHROPIC_SUPPLEMENT = `
<system-reminder>
You are using Claude. When calling multiple independent tools, batch them in a single response. Use your extended thinking capability when reasoning about complex scope chains.
</system-reminder>`;

/** Gemini: avoid over-tooling, prefer direct answers when possible */
const GEMINI_SUPPLEMENT = `
<system-reminder>
You are using Gemini. Prefer direct answers when the question is simple. Only call tools when you genuinely need external information. Do not call tools just to appear thorough.
</system-reminder>`;

/** GPT/OpenAI: standard JSON tool calling, parallel calls preferred */
const OPENAI_SUPPLEMENT = `
<system-reminder>
When multiple independent pieces of information are needed, batch your tool calls in a single step for maximum efficiency.
</system-reminder>`;

// ─── Prompt Builder ──────────────────────────────────────────────────────────

export class PromptBuilder {
    constructor(private workspaceRoot: string) {}

    /**
     * Build the system prompt for the given mode (model-aware).
     * This is the primary entry point used by AgentRunner.
     * @param mode - agent mode
     * @param providerId - provider id for model-specific supplements
     */
    buildSystemPromptForMode(mode: AgentMode = 'build', providerId?: string): string {
        const basePrompt = this.getModePrompt(mode);
        const supplement = this.getModelSupplement(providerId);
        return supplement ? basePrompt + '\n' + supplement : basePrompt;
    }

    private getModePrompt(mode: AgentMode): string {
        switch (mode) {
            case 'plan':    return PLAN_SYSTEM_PROMPT;
            case 'explore': return EXPLORE_SYSTEM_PROMPT;
            case 'general': return GENERAL_SYSTEM_PROMPT;
            default:        return BUILD_SYSTEM_PROMPT;
        }
    }

    private getModelSupplement(providerId?: string): string {
        if (!providerId) return '';
        const id = providerId.toLowerCase();
        if (id === 'claude' || id.includes('anthropic')) return ANTHROPIC_SUPPLEMENT;
        if (id === 'gemini' || id.includes('google'))    return GEMINI_SUPPLEMENT;
        return OPENAI_SUPPLEMENT;
    }

    /**
     * @deprecated Use buildSystemPromptForMode instead.
     * Kept for backward compatibility.
     */
    buildSystemPrompt(mode: AgentMode = 'build'): string {
        return this.getModePrompt(mode);
    }

    /**
     * Build a lightweight system prompt for inline completion.
     */
    buildInlineSystemPrompt(): string {
        return INLINE_SYSTEM_PROMPT;
    }

    /**
     * Build context messages for the current editor state.
     * These are injected before the user's message.
     */
    buildContextMessages(options: {
        activeFile?: string;
        cursorLine?: number;
        cursorColumn?: number;
        selectedText?: string;
        fileContent?: string;
    }): ChatMessage[] {
        const contextParts: string[] = [];

        if (options.activeFile) {
            const relPath = path.relative(this.workspaceRoot, options.activeFile).replace(/\\/g, '/');
            contextParts.push(`**Current file**: \`${relPath}\``);

            // Determine file type
            if (relPath.startsWith('events/')) {
                contextParts.push('**File type**: Event definitions');
            } else if (relPath.includes('common/scripted_triggers')) {
                contextParts.push('**File type**: Scripted triggers');
            } else if (relPath.includes('common/scripted_effects')) {
                contextParts.push('**File type**: Scripted effects');
            } else if (relPath.includes('common/')) {
                const parts = relPath.split('/');
                contextParts.push(`**File type**: ${parts[1] ?? 'common'}`);
            }
        }

        if (options.cursorLine !== undefined) {
            contextParts.push(`**Cursor position**: line ${options.cursorLine + 1}`);
        }

        // Include surrounding code context
        if (options.fileContent && options.cursorLine !== undefined) {
            const lines = options.fileContent.split('\n');
            const startLine = Math.max(0, options.cursorLine - 15);
            const endLine = Math.min(lines.length - 1, options.cursorLine + 15);
            const contextCode = lines.slice(startLine, endLine + 1).join('\n');

            if (contextCode.trim().length > 0) {
                contextParts.push(`\n**Surrounding code** (lines ${startLine + 1}-${endLine + 1}):\n\`\`\`pdx\n${contextCode}\n\`\`\``);
            }
        }

        if (options.selectedText && options.selectedText.trim().length > 0) {
            contextParts.push(`\n**Selected code**:\n\`\`\`pdx\n${options.selectedText}\n\`\`\``);
        }

        if (contextParts.length === 0) {
            return [];
        }

        return [{
            role: 'system',
            content: `## Current Editor Context\n${contextParts.join('\n')}`,
        }];
    }

    /**
     * Build a prompt for inline completion (lightweight, no tool use).
     */
    buildInlinePrompt(options: {
        fileContent: string;
        cursorLine: number;
        cursorColumn: number;
        filePath: string;
    }): ChatMessage[] {
        const lines = options.fileContent.split('\n');
        const startLine = Math.max(0, options.cursorLine - 10);
        const endLine = options.cursorLine;

        // Get code before cursor
        const codeBefore = lines.slice(startLine, endLine + 1).join('\n');

        // Get a few lines after cursor for context
        const linesAfter = lines.slice(endLine + 1, endLine + 4).join('\n');

        // Analyze indentation level
        const currentLine = lines[options.cursorLine] ?? '';
        const indent = currentLine.match(/^(\s*)/)?.[1] ?? '';

        // Detect current block context
        let blockContext = '';
        let braceDepth = 0;
        for (let i = endLine; i >= Math.max(0, endLine - 30); i--) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '}') braceDepth++;
                if (ch === '{') braceDepth--;
            }
            if (braceDepth < 0) {
                // Found opening brace - this is our block
                const blockMatch = line.match(/^\s*(\w[\w.]*)\s*=/);
                if (blockMatch) {
                    blockContext = `Current block: ${blockMatch[1]}`;
                }
                break;
            }
        }

        const prompt = [
            `File: ${path.basename(options.filePath)}`,
            blockContext,
            `\nCode before cursor:`,
            codeBefore,
            `\n[CURSOR HERE - generate next line(s)]`,
            linesAfter ? `\nCode after cursor:\n${linesAfter}` : '',
        ].filter(Boolean).join('\n');

        return [
            { role: 'system', content: INLINE_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ];
    }

    /**
     * Build a validation error context message for retry.
     */
    buildValidationRetryMessage(code: string, errors: Array<{ message: string; line: number }>): ChatMessage {
        const errorList = errors.map(e => `  - Line ${e.line}: ${e.message}`).join('\n');
        return {
            role: 'user',
            content: `The code you generated has validation errors. Please fix them:\n\n**Errors:**\n${errorList}\n\n**Code that failed:**\n\`\`\`pdx\n${code}\n\`\`\`\n\nPlease output the corrected code. Use the \`validate_code\` tool again after fixing.`,
        };
    }
}
