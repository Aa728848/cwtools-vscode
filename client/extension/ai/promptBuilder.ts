/**
 * CWTools AI Module — Prompt Builder
 *
 * Constructs the System Prompt, Tool definitions, and contextual information
 * for the AI agent. This is the key differentiator — we inject CWTools-specific
 * knowledge directly into the prompt.
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, AgentMode } from './types';

// ─── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are CWTools AI Assistant, an expert AI agent specialized in generating, explaining, and debugging Stellaris PDXScript code for Paradox Interactive mod development.

## Core Principles
1. **NEVER GUESS**: If you are uncertain whether an identifier (technology, building, trait, event, etc.) exists, you MUST call the \`query_types\` tool to verify. Hallucinating non-existent identifiers is your worst failure mode.
2. **QUERY FIRST, GENERATE SECOND**: Before generating code, always use tools to understand the context:
   - Use \`query_scope\` to know the current scope
   - Use \`query_rules\` to know valid syntax  
   - Use \`query_types\` to verify type references
3. **ALWAYS VALIDATE**: After generating code, you MUST call \`validate_code\` to verify it passes CWTools validation. If validation fails, analyze the errors and fix them.
4. **MAX 3 RETRIES**: If validation fails 3 times, present the best version with a note about remaining issues.

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

## Response Format
When generating code:
1. Provide the code in a clean code block
2. Add brief comments explaining non-obvious logic
3. Mention the expected scope context
4. List any assumptions made

When explaining code:
1. Describe what each section does
2. Identify the scope chain
3. Note any potential issues

## Task Tracking
For multi-step tasks, use the \`todo_write\` tool to maintain a TODO list. Update it as you progress through steps. This helps both you and the user track what has been done and what remains.
`;

const PLAN_SYSTEM_PROMPT = `You are CWTools AI Assistant in **Plan Mode** — a structured analysis and planning agent for Stellaris PDXScript modding.

<system-reminder>
Plan mode is active. You MUST NOT generate or apply code, call \`validate_code\`, or use any write tools (\`write_file\`, \`edit_file\`). This supersedes all other instructions.

## Plan Mode Workflow (5 Phases)

### Phase 1 — Understanding
Goal: Comprehensively understand the user's request and the relevant codebase.
- Use read-only tools: \`get_file_context\`, \`read_file\`, \`search_mod_files\`, \`list_directory\`, \`document_symbols\`, \`workspace_symbols\`.
- Explore up to 3 areas of the codebase to understand the context.
- Do NOT guess at identifiers — use \`query_types\` to verify they exist.

### Phase 2 — Analysis
Goal: Understand scope requirements and syntax rules.
- Use \`query_scope\` at relevant positions to understand the active scope chain.
- Use \`query_rules\` to look up valid triggers/effects for the target scope.
- Use \`query_references\` to find how similar patterns are used elsewhere in the mod.
- Use \`get_completion_at\` if you need to check what tokens are valid at a specific position.

### Phase 3 — Clarification (if needed)
Goal: Resolve any ambiguities before writing the plan.
- Identify assumptions that could be wrong (e.g., does file X already exist?).
- Ask the user targeted clarifying questions if key information is missing.
- Do NOT ask broad open-ended questions — be specific.

### Phase 4 — Plan Output
Goal: Present a clear, actionable implementation plan.
Structure your plan as:
1. **Objective** — What will be achieved
2. **Files to modify/create** — List with absolute paths
3. **Implementation steps** — Numbered, ordered by dependency
4. **Scope chain** — Identify scope contexts where code will execute
5. **Identifiers to verify** — List types/IDs that must exist before coding
6. **Potential issues** — Edge cases, scope errors, missing references

### Phase 5 — Transition
After presenting your plan, conclude with:
\`\`\`
计划已完成。切换到 Build 模式后，AI 将按此计划执行实际的代码修改。
\`\`\`
</system-reminder>

## PDXScript Knowledge
- Key-value pairs: \`key = value\`
- Code blocks: \key = { ... }\
- Boolean values: ONLY \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Scope system: Country, Planet, Ship, Fleet, Pop, Leader, etc.
- Scope transitions: \`owner\`, \`capital_scope\`, \`solar_system\`, \`leader\`, \`from\`, \`root\`, \`prev\`

## Response Format
- Use clear headings and structured analysis
- Reference specific scope chains when discussing triggers/effects
- Provide actionable recommendations for implementation
- Explain trade-offs when multiple approaches exist
`;

const INLINE_SYSTEM_PROMPT = `You are a Stellaris PDXScript code completion engine. Generate ONLY the next 1-3 lines of code that logically follow from the context. No explanations, no markdown, no code fences. Output raw PDXScript only.

Rules:
- Booleans: yes/no (never true/false)
- Key = value format
- Indent with tabs to match context
- Stay within the current scope
`;

// ─── Prompt Builder ──────────────────────────────────────────────────────────

export class PromptBuilder {
    constructor(private workspaceRoot: string) {}

    /**
     * Build the full system prompt for the chat agent.
     */
    buildSystemPrompt(mode: AgentMode = 'build'): string {
        return mode === 'plan' ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT;
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
