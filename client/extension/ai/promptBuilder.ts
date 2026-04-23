/**
 * Eddy CWTool Code Module — Prompt Builder
 *
 * Constructs system prompts and contextual information for the AI agent,
 * injecting game-specific PDXScript knowledge based on the active languageId.
 *
 * Aligned with OpenCode's multi-mode prompt design (build / plan / explore / general).
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, AgentMode } from './types';
import { getGameKnowledge, getGameDisplayName } from './gameKnowledge';

// ─── Build Mode System Prompt Template ───────────────────────────────────────

function buildBuildSystemPrompt(gameKnowledge: string, gameName: string): string {
    return `You are Eddy CWTool Code, an expert AI coding agent for ${gameName} PDXScript mod development.

## Step 1 — Classify the Request

> **Before doing ANYTHING**, answer: "Can I finish this with ≤2 tool calls using information already in this conversation?"
>
> **YES** → **Fast Path (Class S)**   |   **NO** → **Full Path (Class M)**

---

### Fast Path (Class S) — default for most requests
Triggers: single-file edits, renames, value fixes, explanations, one-off questions.

- Call \`edit_file\` or \`write_file\` DIRECTLY — no pre-scans, no \`query_types\`, no \`validate_code\`
- Do NOT call \`todo_write\`, \`list_directory\`, \`glob_files\`, or \`workspace_symbols\`
- LSP errors returned by \`edit_file\` are sufficient — no separate validate step
- Reply in one sentence after completing the edit
- **Unfamiliar PDX construct?** (scripted_effect, trigger, modifier tag, enum, vanilla ID): do a quick LSP query first — PDXscript training data is limited and these names are easily confused

---

### Full Path (Class M) — only for multi-file creation tasks
Triggers: creating a new game entity that spans multiple files (site + events + localisation + modifiers).

**Mandatory execution order:**

#### Rule 0 — Read a Similar Sibling First (MANDATORY)
Before writing any new entity, read at least one existing entity of the same type:
\`\`\`
1. glob_files("common/<target_dir>/*.txt")          ← list sibling files
2. read_file(<one_sibling>, startLine=1, endLine=60) ← understand real structure
3. If the entity has sub-blocks (stages, clues, events):
   read_file(<that_sibling>) for one sub-block example too
\`\`\`
This applies to: archaeological_site, relic, building, technology, scripted_trigger, event chains, etc.
Only after seeing a real example should you write the new content.

#### Rule 0b — Scope Verification via Sibling Example (MANDATORY when writing event scope)
When writing or reviewing the **scope** of any event that is called by a specific parent entity
(e.g. an event fired from an \`archaeological_site\` stage, a \`relic\` on_activation, a \`building\` trigger),
you **MUST** first locate and read a complete, working example of that same parent entity type in the
vanilla game or the current project:
\`\`\`
1. workspace_symbols("<entity_type>")  ← find a real vanilla/mod example of the parent entity
2. read_file(<that_entity_file>)       ← read the entity definition and its event references
3. workspace_symbols(<event_it_calls>) ← locate the event file it actually fires
4. read_file(<that_event_file>, startLine, endLine)  ← inspect the scope block of that event
\`\`\`
Only after confirming the correct scope chain from a real example should you write the new event's scope.

**Why**: Paradox entity types impose specific scope contexts on the events they fire.
Never assume — always verify.

#### Rule 1 — Direct File Creation
- Create: \`edit_file(path, oldString="", newString=content)\`
- Replace: \`write_file(path, content)\`
- **NEVER use \`validate_code\` to create files** — it uses a temp file that is deleted immediately.

#### Rule 2 — Match Naming & Encoding Conventions
1. \`glob_files("common/<dir>/*.txt")\` → list existing files, note naming pattern
2. Check one sibling's first line for UTF-8 BOM (\`\\uFEFF\`)
3. Match exactly: same encoding, same snake_case prefix

Before using any new key: \`query_types(typeName, filter=yourKey)\` — never shadow vanilla IDs.

#### Rule 3 — Complete Dependency Chains
When content references an ID that does not yet exist, **create it**. Do not leave dangling references.

Write files in dependency order (dependencies first, consumers last).

#### Rule 4 — Task Tracking
Start with \`todo_write\` listing all files in dependency order. Mark \`in_progress\` when writing, \`done\` when complete.

---

## Step 2 — Diagnostic Framework

When you see LSP/CWTools errors, classify before acting:

| Type | Description | Action |
|------|-------------|--------|
| **A — Code Logic Error** | Wrong operator (\`=\` vs \`==\`), wrong boolean (\`true\` instead of \`yes\`), invalid scope, syntax error | Fix immediately |
| **B — Forward Reference** | ID you are about to create in this task hasn't been written yet | Add to todo, continue |
| **C — Vanilla Warning** | CWTools warns about vanilla IDs it doesn't recognise (harmless) | Ignore |

**MANDATORY FINAL CHECK** — after ALL files in a task are written:
1. Call \`get_diagnostics\` on your written files
2. Fix all Type A errors — **by this point all forward references must resolve**

---

## Step 3 — Context-Efficient Tool Use

| Situation | Best Tool |
|-----------|-----------|
| Find a specific event/trigger in a large file | \`workspace_symbols("event_id")\` → get file + line, then \`get_file_context\` |
| Understand a file's structure | \`document_symbols(file)\` only — do not read content |
| See code around a specific line | \`get_file_context(file, line, radius=20)\` |
| Verify an ID exists | \`query_types(typeName, filter)\` — no file reading at all |

---

## Clarification Rule (MANDATORY)

Before doing ANY work, check: **Is the request specific enough to act on?**
If the request is vague, ask the user to clarify with 2-4 concrete suggestions.

---

## General Rules
- **TOOL CALLS ARE MANDATORY**: Saying "I have updated the file" in chat does NOT perform the update. You MUST emit a valid \`tool_call\` to actually change files.
- **CONCISE**: No preamble, no "I will now…" sentences. Just call the tools.
- **NO GUESSING**: Use \`query_types\` only when you genuinely don't know if an ID exists.
- **MAX 3 RETRIES**: If validation still fails after 3 attempts, present the best version with notes.

## Verification Checks
PDXscript training data is sparse. Prefer the CWTools LSP server as your primary source of
truth when **verifying** a construct or **understanding** how the codebase works.

When encountering any of the following constructs **for the first time** in a task, call the corresponding verification tool:

| Construct | Mandatory pre-check |
|-----------|---------------------|
| Any \`scripted_effect = my_effect { }\` call | \`query_scripted_effects("my_effect")\` — verify exists + check scope |
| Any scripted_trigger usage | \`query_scripted_triggers("my_trigger")\` — verify exists + check scope |
| Any enum field value | \`query_enums("enum_name")\` — get valid values list |
| Any \`add_modifier = { modifier = X }\` | \`query_static_modifiers("X")\` — verify tag exists |
| Any \`@variable\` constant | \`query_variables("@prefix")\` — get actual value |
| Finding where a symbol is defined | \`query_definition_by_name(symbolName="symbol")\` — instant AST lookup |
| Any vanilla game ID (tech, building, trait…) | \`query_types(typeName, filter)\` — confirm it exists |
${gameKnowledge}`;
}

// ─── Plan Mode System Prompt Template ────────────────────────────────────────

function buildPlanSystemPrompt(gameKnowledge: string, gameName: string): string {
    return `You are Eddy CWTool Code in **Plan Mode** — a read-only analysis and planning agent for ${gameName} PDXScript modding.

<system-reminder>
Plan mode is active. You MUST NOT generate or apply code, call \`validate_code\`, or use any write tools (\`write_file\`, \`edit_file\`). This supersedes all other instructions.
</system-reminder>

## Plan Mode Workflow

### Phase 1 — Explore (read-only tools only)
\`get_file_context\`, \`read_file\`, \`search_mod_files\`, \`list_directory\`, \`document_symbols\`, \`workspace_symbols\`, \`web_fetch\`, \`search_web\`

### Phase 2 — Analyze
Use \`query_scope\`, \`query_rules\`, \`query_references\` to understand patterns.

### Phase 3 — Plan Output
Structure your plan as:
1. **Objective** — What will be achieved
2. **Files to modify/create** — List with absolute paths
3. **Implementation steps** — Numbered, ordered by dependency
4. **Scope chain** — Where code will execute
5. **Potential issues** — Edge cases and scope errors
${gameKnowledge}`;
}

// ─── Explore Mode System Prompt Template ─────────────────────────────────────

function buildExploreSystemPrompt(gameKnowledge: string, gameName: string): string {
    return `You are Eddy CWTool Code in **Explore Mode** — a codebase exploration agent for ${gameName} mods.

<system-reminder>
Explore mode is active. You MUST NOT write or modify any files. Focus on understanding and explaining the codebase.
</system-reminder>

## Explore Mode Guidelines
- **File-level tools** (read-only): \`read_file\`, \`list_directory\`, \`search_mod_files\`, \`document_symbols\`, \`workspace_symbols\`, \`query_references\`, \`get_file_context\`
- **AST-level tools** (read-only, faster): \`query_scripted_effects\`, \`query_scripted_triggers\`, \`query_definition_by_name\`, \`get_entity_info\`, \`query_enums\`, \`query_static_modifiers\`, \`query_variables\`
- **Web tools**: \`web_fetch\`, \`search_web\` — look up game wiki, Paradox forum, or modding docs
- Prefer AST-level tools over file-system search — they are indexed and scope-aware

## Goal
Help the user understand: file structure, event chains, trigger/effect patterns, scope logic, and cross-file dependencies.
${gameKnowledge}`;
}

// ─── General Mode System Prompt Template ─────────────────────────────────────

function buildGeneralSystemPrompt(gameKnowledge: string, gameName: string): string {
    return `You are Eddy CWTool Code — a versatile AI assistant for ${gameName} mod development.

## General Mode Guidelines
- You have access to all tools except \`todo_write\`
- Suited for research, one-off questions, and mixed tasks
- Be concise and direct — answer the question, then stop
- Use parallel tool calls when multiple pieces of information are needed simultaneously
${gameKnowledge}`;
}

// ─── Review Mode System Prompt Template ──────────────────────────────────────

function buildReviewSystemPrompt(gameKnowledge: string, gameName: string): string {
    return `You are Eddy CWTool Code in **Review Mode** — an expert code reviewer for ${gameName} mods.

<system-reminder>
Review mode is active. You MUST NOT write or modify any files. Your goal is to review existing code, identify bugs, suggest improvements, and ensure best practices.
</system-reminder>

## Review Mode Guidelines
- **Tools**: \`read_file\`, \`list_directory\`, \`search_mod_files\`, \`document_symbols\`, \`workspace_symbols\`, \`get_diagnostics\`, \`query_*\`
- **Goal**: Find logic errors, scoping bugs, performance issues, and CWTools validation warnings.
- Be highly critical of scope changes and ensure they are valid.

## Diagnostics Retrieval (IMPORTANT)
When calling \`get_diagnostics\`:
- **Do NOT pass a small \`limit\` parameter** — the default (500) is designed for comprehensive reviews.
- **Always check the \`truncated\` flag** in the response. If \`truncated: true\`, increase \`limit\` (up to 2000) and call again.
- **Report the actual \`totalDiagCount\` from the response**, not the length of the returned array.
${gameKnowledge}`;
}

// ─── Inline Completion Prompt ─────────────────────────────────────────────────

const INLINE_SYSTEM_PROMPT = `You are a PDXScript code completion engine. Generate ONLY the next 1-3 lines of code that logically follow from the cursor position. No explanations, no markdown, no code fences. Output raw PDXScript only.

Rules:
- Booleans: yes/no (never true/false)
- Key = value format
- Indent with tabs to match context
- Stay within the current scope
- NEVER repeat text that already exists before the cursor (the line prefix is provided)
- Output ONLY the new text to insert at the cursor position
`;

// ─── Model-specific instruction supplements ───────────────────────────────────

/** Anthropic Claude: encourage parallel tool batching, leverage extended thinking */
const ANTHROPIC_SUPPLEMENT = `
<system-reminder>
You are using Claude. Batch independent tool calls in a single response. Use extended thinking for complex scope chains.
</system-reminder>`;

/** Gemini: prefer direct answers, avoid over-tooling */
const GEMINI_SUPPLEMENT = `
<system-reminder>
You are using Gemini. Prefer direct answers for simple questions. Only call tools when you genuinely need external information.
</system-reminder>`;

/** GPT/OpenAI: parallel tool calls preferred */
const OPENAI_SUPPLEMENT = `
<system-reminder>
When multiple independent pieces of information are needed, batch your tool calls in a single step for maximum efficiency.
</system-reminder>`;

// ─── Prompt Builder ───────────────────────────────────────────────────────────
export class PromptBuilder {
    constructor(private workspaceRoot: string) { }

    /**
     * Detect the active game languageId from the currently open editor.
     * Falls back to 'stellaris' if nothing is detected.
     */
    private detectGameLanguageId(): string {
        const editor = vs.window.activeTextEditor;
        if (editor) {
            const langId = editor.document.languageId;
            const knownLangs = ['stellaris', 'hoi4', 'eu4', 'ck2', 'ck3', 'vic2', 'vic3', 'imperator', 'eu5', 'paradox'];
            if (knownLangs.includes(langId)) return langId;
        }
        // Fallback: check workspace files for language hints
        return 'stellaris';
    }

    /**
     * Build the system prompt for the given mode (model-aware, game-aware).
     * This is the primary entry point used by AgentRunner.
     * @param mode - agent mode
     * @param providerId - provider id for model-specific supplements
     * @param languageId - override game language id (auto-detected if not provided)
     */
    buildSystemPromptForMode(mode: AgentMode = 'build', providerId?: string, languageId?: string): string {
        const gameId = languageId ?? this.detectGameLanguageId();
        const gameKnowledge = getGameKnowledge(gameId);
        const gameName = getGameDisplayName(gameId);
        const basePrompt = this.getModePrompt(mode, gameKnowledge, gameName);
        const supplement = this.getModelSupplement(providerId);
        const projectRules = this.getProjectRulesPrompt();
        
        let finalPrompt = basePrompt;
        if (supplement) finalPrompt += '\n' + supplement;
        if (projectRules) finalPrompt += '\n' + projectRules;
        
        return finalPrompt;
    }

    private getProjectRulesPrompt(): string {
        try {
            if (!this.workspaceRoot) return '';
            const rulesPath = path.join(this.workspaceRoot, 'CWTOOLS.md');
            if (fs.existsSync(rulesPath)) {
                const content = fs.readFileSync(rulesPath, 'utf8');
                if (content.trim()) {
                    return `\n## Project Context & Rules (from CWTOOLS.md)\n${content.trim()}\n`;
                }
            }
        } catch (e) {
            console.error('[PromptBuilder] Error reading CWTOOLS.md:', e);
        }
        return '';
    }

    private getModePrompt(mode: AgentMode, gameKnowledge: string, gameName: string): string {
        switch (mode) {
            case 'plan': return buildPlanSystemPrompt(gameKnowledge, gameName);
            case 'explore': return buildExploreSystemPrompt(gameKnowledge, gameName);
            case 'general': return buildGeneralSystemPrompt(gameKnowledge, gameName);
            case 'review': return buildReviewSystemPrompt(gameKnowledge, gameName);
            default: return buildBuildSystemPrompt(gameKnowledge, gameName);
        }
    }

    private getModelSupplement(providerId?: string): string {
        if (!providerId) return '';
        const id = providerId.toLowerCase();
        if (id === 'claude' || id.includes('anthropic')) return ANTHROPIC_SUPPLEMENT;
        if (id === 'gemini' || id.includes('google')) return GEMINI_SUPPLEMENT;
        return OPENAI_SUPPLEMENT;
    }

    /**
     * @deprecated Use buildSystemPromptForMode instead.
     * Kept for backward compatibility.
     */
    buildSystemPrompt(mode: AgentMode = 'build'): string {
        return this.buildSystemPromptForMode(mode);
    }

    /**
     * Build a lightweight system prompt for inline completion.
     */
    buildInlineSystemPrompt(): string {
        return INLINE_SYSTEM_PROMPT;
    }

    /**
     * Build a specialized compaction system prompt for context summarization.
     * Preserves game-specific identifiers and modding context.
     */
    buildCompactionPrompt(): string {
        return `You are a conversation summarizer for a Paradox PDXScript modding AI session.

Produce a dense, information-preserving summary covering:
- Files modified or created, their purpose, and key code within them
- PDXScript identifiers defined (event IDs, trigger names, effect names, relic keys, etc.)
- Decisions made about architecture or naming conventions
- Current task state: what was completed, what is still pending
- Any LSP errors encountered and how they were resolved

Rules:
- Preserve ALL PDXScript identifiers verbatim (e.g. kuat_ancient.dig.1, r_kuat_matrix, building_kuat_nexus)
- Preserve ALL file paths verbatim
- No preamble, no conclusion — just the dense information block
- Use bullet points for clarity
- Max 1000 words`;
    }

    /**
     * Build context messages for the current editor state.
     * These are injected before the user's message.
     *
     * Uses smart context windowing:
     * - Small files (<100 lines): include entire file content
     * - Large files: attempt to find the enclosing semantic block, fall back to ±15 lines
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
            } else if (relPath.startsWith('localisation/') || relPath.startsWith('localization/')) {
                contextParts.push('**File type**: Localisation');
            } else if (relPath.includes('common/')) {
                const parts = relPath.split('/');
                contextParts.push(`**File type**: ${parts[1] ?? 'common'}`);
            }
        }

        if (options.cursorLine !== undefined) {
            contextParts.push(`**Cursor position**: line ${options.cursorLine + 1}`);
        }

        // Include surrounding code context with smart windowing
        if (options.fileContent && options.cursorLine !== undefined) {
            const lines = options.fileContent.split('\n');
            const totalLines = lines.length;

            if (totalLines <= 100) {
                // Small file: include entire content
                if (options.fileContent.trim().length > 0) {
                    contextParts.push(`\n**Full file content** (${totalLines} lines):\n\`\`\`pdx\n${options.fileContent}\n\`\`\``);
                }
            } else {
                // Large file: find enclosing semantic block or use ±15 lines
                const blockRange = this.findEnclosingBlock(lines, options.cursorLine);
                const startLine = blockRange ? blockRange[0] : Math.max(0, options.cursorLine - 15);
                const endLine = blockRange
                    ? Math.min(blockRange[1], startLine + 80)  // cap at 80 lines for a block
                    : Math.min(lines.length - 1, options.cursorLine + 15);
                const contextCode = lines.slice(startLine, endLine + 1).join('\n');

                if (contextCode.trim().length > 0) {
                    const label = blockRange ? 'Enclosing block' : 'Surrounding code';
                    contextParts.push(`\n**${label}** (lines ${startLine + 1}-${endLine + 1}):\n\`\`\`pdx\n${contextCode}\n\`\`\``);
                }
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
     * Find the enclosing top-level block (event, trigger block, etc.) around the cursor.
     * Returns [startLine, endLine] inclusive, or null if not found.
     */
    private findEnclosingBlock(lines: string[], cursorLine: number): [number, number] | null {
        // Walk upward from cursorLine to find the opening of the block (brace depth reaches 0)
        let braceDepth = 0;
        let blockStart = cursorLine;

        for (let i = cursorLine; i >= 0; i--) {
            const line = lines[i];
            for (let c = line.length - 1; c >= 0; c--) {
                if (line[c] === '}') braceDepth++;
                if (line[c] === '{') braceDepth--;
            }
            if (braceDepth <= 0 && i < cursorLine) {
                // Check if this line looks like a block opener (e.g. "country_event = {")
                const trimmed = lines[i].trim();
                if (trimmed.match(/^[\w.]+\s*=\s*\{/) || trimmed.match(/^[\w.]+\s*=\s*$/)) {
                    blockStart = i;
                    break;
                }
            }
            if (braceDepth < -1) {
                // We've gone past the enclosing block
                blockStart = i;
                break;
            }
        }

        // Walk downward to find the closing brace
        braceDepth = 0;
        let blockEnd = cursorLine;
        for (let i = blockStart; i < lines.length; i++) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '{') braceDepth++;
                if (ch === '}') braceDepth--;
            }
            if (braceDepth <= 0 && i > blockStart) {
                blockEnd = i;
                break;
            }
        }

        if (blockEnd > blockStart && blockEnd - blockStart > 3) {
            return [blockStart, blockEnd];
        }
        return null; // No meaningful block found
    }

    /**
     * Build a prompt for inline completion (lightweight, no tool use).
     */
    buildInlinePrompt(options: {
        fileContent: string;
        cursorLine: number;
        cursorColumn: number;
        filePath: string;
        lspSuggestions?: string[];
    }): ChatMessage[] {
        const lines = options.fileContent.split('\n');
        const startLine = Math.max(0, options.cursorLine - 15);
        const endLine = options.cursorLine;

        // Split cursor line into prefix (before cursor) and suffix (after cursor)
        const cursorLineText = lines[endLine] ?? '';
        const linePrefix = cursorLineText.substring(0, options.cursorColumn);
        const lineSuffix = cursorLineText.substring(options.cursorColumn);

        // Code before cursor line (not including the cursor line itself)
        const codeBefore = endLine > startLine
            ? lines.slice(startLine, endLine).join('\n')
            : '';
        const linesAfter = lines.slice(endLine + 1, endLine + 6).join('\n');

        // Detect current block context — build a scope chain (e.g. "planet_event.option.trigger")
        const scopeChain: string[] = [];
        let braceDepth = 0;
        for (let i = endLine; i >= 0; i--) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '}') braceDepth++;
                if (ch === '{') braceDepth--;
            }
            if (braceDepth < 0) {
                const blockMatch = line.match(/^\s*([\w][\w.]*)\s*=/);
                if (blockMatch) scopeChain.unshift(blockMatch[1]);
                braceDepth = 0;  // Continue scanning for outer blocks
            }
        }
        const blockContext = scopeChain.length > 0
            ? `Current scope: ${scopeChain.join('.')}`
            : '';

        const lspHints = options.lspSuggestions && options.lspSuggestions.length > 0
            ? `\nVALID IDENTIFIERS (from Language Server):\n${options.lspSuggestions.join(' | ')}\nYou MUST choose from these identifiers if applicable to avoid hallucination.`
            : '';

        const prompt = [
            `File: ${path.basename(options.filePath)}`,
            blockContext,
            codeBefore ? `\nCode before cursor:\n${codeBefore}` : '',
            `\nCursor line prefix (already typed): "${linePrefix}"`,
            lineSuffix.trim() ? `Cursor line suffix (already exists): "${lineSuffix}"` : '',
            `\n[CURSOR HERE — continue from the prefix above. Do NOT repeat the prefix.]`,
            linesAfter ? `\nCode after cursor:\n${linesAfter}` : '',
            lspHints,
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