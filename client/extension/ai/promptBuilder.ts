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
import { MemoryParser } from './memoryParser';
import { ErrorReporter } from './errorReporter';
import { SOURCE } from './messages';
import { getAiStorageRootCandidates } from './workspacePaths';
import {
    buildProfileSummary,
    getProjectProfilePath,
    getPromptCardForMode,
    readProjectProfile,
} from './projectProfile';
import type { ProjectProfile } from './types';

// ─── Parsed CWTOOLS.md Structure ─────────────────────────────────────────────

interface ParsedProjectRules {
    raw: string;
    modInfo?: string;
    projectStructure?: string;
    knownIdentifiers?: string;
    agentGuidelines?: string;
    customRules?: string;
    namespaces?: string[];
}

interface RuntimePromptState {
    mode?: AgentMode;
    workflow?: {
        id: string;
        title: string;
        promptSupplement?: string;
    };
}

import {
    SPRITE_DIAGNOSTIC_REPAIR_PROTOCOL,
    SOUND_DIAGNOSTIC_REPAIR_PROTOCOL
} from './prompt/sections/baseSystem';

import {
    buildBuildSystemPrompt,
    buildPlanModeSystemPrompt,
    buildExploreModeSystemPrompt,
    buildGeneralModeSystemPrompt,
    buildUtilityModeSystemPrompt,
    buildReviewModeSystemPrompt,
    buildGuiExpertSystemPrompt,
    buildScriptReviewerSystemPrompt,
    buildLocTranslatorSystemPrompt,
    buildLocWriterSystemPrompt,
    buildOrchestratorSystemPrompt,
    buildScriptModeSystemPrompt
} from './prompt/sections/modePrompts';
import { buildSkillIndexPrompt } from './skills';

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
    private memoryParser: MemoryParser;

    /** Frozen system prompt cache for prefix-cache optimization (DeepSeek etc.).
     *  Key: `${mode}|${providerId}` — value is the cached prompt string.
     *  Once built, the same string is returned on subsequent calls within the session. */
    /** Frozen system prompt cache for prefix-cache optimization (DeepSeek etc.).
     *  Key: `${mode}|${providerId}|${languageId}` — value is the cached prompt string.
     *  Bounded by FROZEN_PROMPT_CACHE_MAX to guard against runaway growth from
     *  unexpected key explosion (e.g. providerId variations). LRU eviction relies
     *  on Map's insertion-order semantics. */
    private static readonly FROZEN_PROMPT_CACHE_MAX = 32;
    private _frozenPromptCache = new Map<string, string>();

    constructor(
        private workspaceRoot: string,
        private globalStoragePath?: string,
        private extensionPath?: string
    ) {
        this.memoryParser = new MemoryParser(workspaceRoot);
    }

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
    buildSystemPromptForMode(
        mode: AgentMode = 'build', 
        providerId?: string, 
        languageId?: string,
        topicId?: string,
        runId?: string,
        pinned?: {
            todos?: import('./types').TodoItem[];
            diagnostics?: Array<{ file: string; message: string; line: number }>;
            pendingInteractions?: string[];
            recentWrittenFiles?: string[];
            blockedSubAgents?: string[];
            decisions?: string[];
        }
    ): string {
        const gameId = languageId ?? this.detectGameLanguageId();
        const gameKnowledge = getGameKnowledge(gameId);
        const gameName = getGameDisplayName(gameId);
        const basePrompt = this.getModePrompt(mode, gameKnowledge, gameName);
        const supplement = this.getModelSupplement(providerId);
        const projectRules = this.getProjectRulesPrompt(mode);
        
        let finalPrompt = '';

        // 2. Compacted Summary (来自 Phase 4 结构化记忆压缩)
        if (topicId && runId) {
            const wsRoot = this.workspaceRoot;
            const summaryMdPath = path.join(wsRoot, '.cwtools-ai', topicId, 'runs', runId, 'summary.md');
            if (fs.existsSync(summaryMdPath)) {
                try {
                    const summaryContent = fs.readFileSync(summaryMdPath, 'utf8').trim();
                    if (summaryContent) {
                        finalPrompt += `<compacted-summary>\n\n${summaryContent}\n\n</compacted-summary>\n\n`;
                    }
                } catch {
                    // Ignore summary read error
                }
            }
        }

        // 3. Pinned Context (活跃钉选状态与实时断点)
        if (pinned) {
            let pinnedText = '## 📌 活跃钉选状态与实时断点 (Pinned Context)\n';
            let hasPinned = false;

            if (pinned.pendingInteractions && pinned.pendingInteractions.length > 0) {
                pinnedText += `### ⏳ 挂起中的交互操作 (Pending Approvals)\n${pinned.pendingInteractions.map(pi => `- ${pi}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.todos && pinned.todos.length > 0) {
                const activeTodos = pinned.todos.filter(t => t.status === 'pending');
                if (activeTodos.length > 0) {
                    pinnedText += `### 📋 剩余待完成子任务 (Remaining Todos)\n${activeTodos.map(t => `- [ ] ${t.content}${(t as any).filePath ? ` (关联文件: ${(t as any).filePath})` : ''}`).join('\n')}\n`;
                    hasPinned = true;
                }
            }

            if (pinned.diagnostics && pinned.diagnostics.length > 0) {
                pinnedText += `### ⚠️ 未解决的代码诊断报错 (Active Diagnostics)\n${pinned.diagnostics.map(d => `- **${path.basename(d.file)}** [第 ${d.line} 行]: ${d.message}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.recentWrittenFiles && pinned.recentWrittenFiles.length > 0) {
                pinnedText += `### 📝 最近写入的文件 (Recent Written Files)\n${pinned.recentWrittenFiles.map(f => `- ${path.basename(f)}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.blockedSubAgents && pinned.blockedSubAgents.length > 0) {
                pinnedText += `### 🚧 子 Agent 阻塞待决 (Blocked Sub-Agent Clarifications)\n${pinned.blockedSubAgents.map(b => `- ${b}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.decisions && pinned.decisions.length > 0) {
                pinnedText += `### 💡 关键技术决策 (Key Decisions)\n${pinned.decisions.map(d => `- ${d}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (hasPinned) {
                finalPrompt += `<pinned-context>\n\n${pinnedText.trim()}\n\n</pinned-context>\n\n`;
            }
        }
        if (projectRules) finalPrompt += projectRules + '\n';

        const memoryPrompt = this.memoryParser.getMemoryPrompt();
        if (memoryPrompt) finalPrompt += memoryPrompt + '\n';

        // Inject approved design blueprint in Build mode
        if (mode === 'build') {
            const blueprintPrompt = this.getDesignBlueprintPrompt();
            if (blueprintPrompt) finalPrompt += blueprintPrompt + '\n';
        }

        finalPrompt += basePrompt;
        if (supplement) finalPrompt += '\n' + supplement;
        
        const skillsPrompt = this.getAgentSkillsPrompt();
        if (skillsPrompt) finalPrompt += '\n' + skillsPrompt;

        return finalPrompt;
    }

    /**
     * Build a frozen (session-cached) system prompt for DeepSeek prefix-cache optimization.
     * The first call builds and caches the prompt; subsequent calls return the cached string
     * verbatim, ensuring byte-level stability across API calls for prefix cache hits.
     * 
     * Kept byte-stable by excluding transient/dynamic parameters (pinned context, topic, run summaries).
     */
    buildFrozenSystemPrompt(
        mode: AgentMode = 'build', 
        providerId?: string, 
        languageId?: string
    ): string {
        const cacheKey = `${mode}|${providerId ?? ''}|${languageId ?? ''}`;
        const cached = this._frozenPromptCache.get(cacheKey);
        if (cached !== undefined) return cached;

        // Force stable mode by leaving topicId, runId, and pinned undefined
        const prompt = this.buildSystemPromptForMode(mode, providerId, languageId);
        // LRU eviction: drop oldest entry once we exceed the cap (Map iterates in insertion order).
        if (this._frozenPromptCache.size >= PromptBuilder.FROZEN_PROMPT_CACHE_MAX) {
            const oldestKey = this._frozenPromptCache.keys().next().value;
            if (oldestKey !== undefined) {
                this._frozenPromptCache.delete(oldestKey);
            }
        }
        this._frozenPromptCache.set(cacheKey, prompt);
        return prompt;
    }

    /**
     * Build the dynamic prompt block containing pinned context and compacted run summary.
     * This block is appended after the static system prompt to maximize prefix caching.
     * Wrapped in a <system-reminder> user message to maintain high cognitive weight for the LLM.
     */
    buildDynamicPromptBlock(
        pinned?: {
            todos?: import('./types').TodoItem[];
            diagnostics?: Array<{ file: string; message: string; line: number }>;
            pendingInteractions?: string[];
            recentWrittenFiles?: string[];
            blockedSubAgents?: string[];
            decisions?: string[];
        },
        topicId?: string,
        runId?: string,
        runtime?: RuntimePromptState
    ): ChatMessage[] {
        const dynamicParts: string[] = [];
        if (runtime?.mode || runtime?.workflow) {
            const lines: string[] = [];
            if (runtime.mode) {
                lines.push(`mode: ${runtime.mode}`);
                if (runtime.mode === 'plan') {
                    lines.push('plan-write-policy: Only write_design_blueprint and topic-scoped Agent Workspace card artifacts (Implementation_Plan.md, design_blueprint.md, walkthrough.md, task.md, annotation files, and tmp/artifact previews) may be written. Project file mutations are blocked at runtime.');
                }
            }
            if (runtime.workflow) {
                lines.push(`workflow: ${runtime.workflow.id} (${runtime.workflow.title})`);
                if (runtime.workflow.promptSupplement) {
                    lines.push(`workflow-instructions:\n${runtime.workflow.promptSupplement}`);
                }
            }
            dynamicParts.push(`<runtime-state>\n${lines.join('\n')}\n</runtime-state>`);
        }

        // 1. Compacted Summary (来自历史会话看板的压缩)
        if (topicId && runId) {
            const wsRoot = this.workspaceRoot;
            const summaryMdPath = path.join(wsRoot, '.cwtools-ai', topicId, 'runs', runId, 'summary.md');
            if (fs.existsSync(summaryMdPath)) {
                try {
                    const summaryContent = fs.readFileSync(summaryMdPath, 'utf8').trim();
                    if (summaryContent) {
                        dynamicParts.push(`<compacted-summary>\n\n${summaryContent}\n\n</compacted-summary>`);
                    }
                } catch {
                    // Ignore summary read error
                }
            }
        }

        // 2. Pinned Context (活跃钉选状态与实时断点)
        if (pinned) {
            let pinnedText = '## 📌 活跃钉选状态与实时断点 (Pinned Context)\n';
            let hasPinned = false;

            if (pinned.pendingInteractions && pinned.pendingInteractions.length > 0) {
                pinnedText += `### ⏳ 挂起中的交互操作 (Pending Approvals)\n${pinned.pendingInteractions.map(pi => `- ${pi}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.todos && pinned.todos.length > 0) {
                const activeTodos = pinned.todos.filter(t => t.status === 'pending');
                if (activeTodos.length > 0) {
                    pinnedText += `### 📋 剩余待完成子任务 (Remaining Todos)\n${activeTodos.map(t => `- [ ] ${t.content}${(t as any).filePath ? ` (关联文件: ${(t as any).filePath})` : ''}`).join('\n')}\n`;
                    hasPinned = true;
                }
            }

            if (pinned.diagnostics && pinned.diagnostics.length > 0) {
                pinnedText += `### ⚠️ 未解决的代码诊断报错 (Active Diagnostics)\n${pinned.diagnostics.map(d => `- **${path.basename(d.file)}** [第 ${d.line} 行]: ${d.message}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.recentWrittenFiles && pinned.recentWrittenFiles.length > 0) {
                pinnedText += `### 📝 最近写入的文件 (Recent Written Files)\n${pinned.recentWrittenFiles.map(f => `- ${path.basename(f)}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.blockedSubAgents && pinned.blockedSubAgents.length > 0) {
                pinnedText += `### 🚧 子 Agent 阻塞待决 (Blocked Sub-Agent Clarifications)\n${pinned.blockedSubAgents.map(b => `- ${b}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (pinned.decisions && pinned.decisions.length > 0) {
                pinnedText += `### 💡 关键技术决策 (Key Decisions)\n${pinned.decisions.map(d => `- ${d}`).join('\n')}\n`;
                hasPinned = true;
            }

            if (hasPinned) {
                dynamicParts.push(`<pinned-context>\n\n${pinnedText.trim()}\n\n</pinned-context>`);
            }
        }

        if (dynamicParts.length === 0) return [];

        const reminderContent = `<system-reminder>\n\n${dynamicParts.join('\n\n')}\n\n</system-reminder>`;
        return [{ role: 'user', content: reminderContent }];
    }

    /** Clear the frozen prompt cache (e.g., when starting a new session). */
    clearFrozenPromptCache(): void {
        this._frozenPromptCache.clear();
        this._parsedRulesCache = null;
        this._parsedRulesMtime = 0;
        this._projectProfileCache = null;
        this._projectProfileMtime = 0;
    }

    /**
     * Build a slim system prompt for sub-agents — includes only mod info + namespaces
     * from CWTOOLS.md to avoid bloating narrow-scope sub-agent contexts.
     */
    buildSlimSystemPromptForMode(mode: AgentMode, providerId?: string, languageId?: string): string {
        const gameId = languageId ?? this.detectGameLanguageId();
        const gameKnowledge = getGameKnowledge(gameId);
        const gameName = getGameDisplayName(gameId);
        const basePrompt = this.getModePrompt(mode, gameKnowledge, gameName, true);
        const supplement = this.getModelSupplement(providerId);
        const slimRules = this.getSlimProjectRulesPrompt();
        
        let finalPrompt = '';
        if (slimRules) finalPrompt += slimRules + '\n';
        if (mode === 'build') {
            const blueprintPrompt = this.getDesignBlueprintPrompt();
            if (blueprintPrompt) finalPrompt += blueprintPrompt + '\n';
        }
        finalPrompt += basePrompt;
        if (supplement) finalPrompt += '\n' + supplement;
        
        // Installed skills are invoked through run_command, which is intentionally
        // unavailable to slim orchestrator sub-agents.

        return finalPrompt;
    }

    /** Parsed CWTOOLS.md cache — invalidated when file mtime changes */
    private _parsedRulesCache: ParsedProjectRules | null = null;
    private _parsedRulesMtime: number = 0;
    private _projectProfileCache: ProjectProfile | null = null;
    private _projectProfileMtime: number = 0;

    private parseProjectProfile(): ProjectProfile | null {
        try {
            if (!this.workspaceRoot) return null;
            const profilePath = getProjectProfilePath(this.workspaceRoot);
            if (!fs.existsSync(profilePath)) {
                this._projectProfileCache = null;
                return null;
            }
            const mtime = fs.statSync(profilePath).mtimeMs;
            if (this._projectProfileCache && mtime === this._projectProfileMtime) {
                return this._projectProfileCache;
            }
            const profile = readProjectProfile(this.workspaceRoot);
            this._projectProfileCache = profile;
            this._projectProfileMtime = mtime;
            return profile;
        } catch (e) {
            ErrorReporter.debug(SOURCE.PROMPT_BUILDER, 'Error reading project profile', e);
            this._projectProfileCache = null;
            return null;
        }
    }

    /**
     * Parse CWTOOLS.md into structured sections for selective injection.
     * Returns null if file doesn't exist or is empty.
     */
    private parseProjectRules(): ParsedProjectRules | null {
        try {
            if (!this.workspaceRoot) return null;
            const rulesPath = path.join(this.workspaceRoot, 'CWTOOLS.md');
            if (!fs.existsSync(rulesPath)) { this._parsedRulesCache = null; return null; }

            // Check mtime — return cached if file hasn't changed
            const mtime = fs.statSync(rulesPath).mtimeMs;
            if (this._parsedRulesCache && mtime === this._parsedRulesMtime) {
                return this._parsedRulesCache;
            }

            const content = fs.readFileSync(rulesPath, 'utf8').trim();
            if (!content) { this._parsedRulesCache = null; return null; }

            const parsed: ParsedProjectRules = { raw: content };

            // Extract sections by ## headers
            const modInfoMatch = content.match(/## Mod Info\n([\s\S]*?)(?=\n## |$)/);
            if (modInfoMatch) parsed.modInfo = modInfoMatch[1]!.trim();  

            const structureMatch = content.match(/## Project Structure\n([\s\S]*?)(?=\n## |$)/);
            if (structureMatch) parsed.projectStructure = structureMatch[1]!.trim();  

            const idsMatch = content.match(/## Known Identifiers\n([\s\S]*?)(?=\n## |$)/);
            if (idsMatch) parsed.knownIdentifiers = idsMatch[1]!.trim();  

            const guidelinesMatch = content.match(/## Agent Guidelines\n([\s\S]*?)(?=\n## |$)/);
            if (guidelinesMatch) parsed.agentGuidelines = guidelinesMatch[1]!.trim();  

            const customMatch = content.match(/## Custom Rules\n([\s\S]*)/);
            if (customMatch && customMatch[1]!.trim() && !customMatch[1]!.includes('<!-- Add')) {  
                parsed.customRules = customMatch[1]!.trim();  
            }

            // Extract namespaces list
            const nsMatch = content.match(/### Event Namespaces\n([\s\S]*?)(?=\n### |\n## |$)/);
            if (nsMatch) {
                 
                parsed.namespaces = (nsMatch[1]!.match(/`([^`]+)`/g) || []).map(s => s.replace(/`/g, ''));
            }

            this._parsedRulesCache = parsed;
            this._parsedRulesMtime = mtime;
            return parsed;
        } catch (e) {
            ErrorReporter.debug(SOURCE.PROMPT_BUILDER, 'Error reading CWTOOLS.md', e);
            this._parsedRulesCache = null;
            return null;
        }
    }

    private truncateProjectRuleSection(content: string, maxChars: number): string {
        if (content.length <= maxChars) return content;
        return content.slice(0, maxChars).trimEnd() + '\n...[truncated; read CWTOOLS.md for the full project rules]';
    }

    private buildProjectProfilePrompt(mode: AgentMode | undefined, profile: ProjectProfile, customRules?: string): string {
        const activeMode = mode ?? 'build';
        const promptCard = getPromptCardForMode(profile, activeMode);
        const workflowHints = profile.routing.recommendedWorkflowByIntent
            .slice(0, 5)
            .map(item => `- ${item.intent}: ${item.workflowId} (${item.mode})`)
            .join('\n');
        const custom = customRules?.trim()
            ? `\n\n## Custom Rules (from CWTOOLS.md)\n${this.truncateProjectRuleSection(customRules.trim(), 1800)}`
            : '';
        return `<project-premise>\n# PROJECT PROFILE (from .cwtools-ai/project/profile.json)\nUse this compact profile for routing. Do not broad-scan the workspace until you have checked the profile and the relevant indexed tools. For more details, call \`query_project_profile\` with a targeted section.\n\n## Summary\n${buildProfileSummary(profile)}\n\n## Active Mode Card\n${this.truncateProjectRuleSection(promptCard || 'No mode-specific project card was generated.', 1800)}\n\n## Recommended Workflows\n${workflowHints || '- No workflow recommendations generated.'}\n\n## Efficiency Hints\n${profile.efficiencyHints.slice(0, 5).map(hint => `- ${hint}`).join('\n')}${custom}\n</project-premise>\n`;
    }

    /**
     * Build mode-aware project rules prompt.
     * Different modes include different subsets of CWTOOLS.md to optimize context usage.
     */
    private getProjectRulesPrompt(mode?: AgentMode): string {
        const profile = this.parseProjectProfile();
        const parsed = this.parseProjectRules();
        if (profile) return this.buildProjectProfilePrompt(mode, profile, parsed?.customRules);
        if (!parsed) return '';

        // Build mode uses a compact summary by default. Full CWTOOLS.md injection is
        // still available through cwtools.ai.performance.fullProjectRulesInBuild.
        if (mode === 'build' || !mode) {
            const fullBuildRules = vs.workspace.getConfiguration('cwtools.ai.performance')
                .get<boolean>('fullProjectRulesInBuild') === true;
            if (fullBuildRules) {
                return `<project-premise>\n# MANDATORY PROJECT RULES & CONTEXT (From CWTOOLS.md)\nYou MUST strictly read and follow these rules before attempting any task. These project-specific rules supersede all general instructions:\n\n${parsed.raw}\n</project-premise>\n`;
            }

            const buildSections: string[] = [];
            if (parsed.modInfo) buildSections.push(`## Mod Info\n${this.truncateProjectRuleSection(parsed.modInfo, 1200)}`);
            if (parsed.projectStructure) buildSections.push(`## Project Structure\n${this.truncateProjectRuleSection(parsed.projectStructure, 1800)}`);
            if (parsed.namespaces?.length) buildSections.push(`### Event Namespaces\n${parsed.namespaces.slice(0, 80).map(ns => `- \`${ns}\``).join('\n')}`);
            if (parsed.agentGuidelines) buildSections.push(`## Agent Guidelines\n${this.truncateProjectRuleSection(parsed.agentGuidelines, 2600)}`);
            if (parsed.customRules) buildSections.push(`## Custom Rules\n${this.truncateProjectRuleSection(parsed.customRules, 2200)}`);
            if (buildSections.length === 0) return '';
            return `<project-premise>\n# PROJECT RULES SUMMARY (From CWTOOLS.md)\nFollow these project-specific rules. If the task depends on omitted details or the user explicitly asks for full project policy, read CWTOOLS.md before editing.\n\n${buildSections.join('\n\n')}\n</project-premise>\n`;
        }

        const sections: string[] = [];
        // All modes get mod info and custom rules
        if (parsed.modInfo) sections.push(`## Mod Info\n${parsed.modInfo}`);

        if (mode === 'plan') {
            if (parsed.projectStructure) sections.push(`## Project Structure\n${parsed.projectStructure}`);
            if (parsed.namespaces?.length) sections.push(`### Event Namespaces\n${parsed.namespaces.map(ns => `- \`${ns}\``).join('\n')}`);
            if (parsed.agentGuidelines) sections.push(`## Agent Guidelines\n${parsed.agentGuidelines}`);
        } else if (mode === 'explore') {
            if (parsed.knownIdentifiers) sections.push(`## Known Identifiers\n${parsed.knownIdentifiers}`);
        } else if (mode === 'review') {
            if (parsed.knownIdentifiers) sections.push(`## Known Identifiers\n${parsed.knownIdentifiers}`);
            if (parsed.agentGuidelines) sections.push(`## Agent Guidelines\n${parsed.agentGuidelines}`);
        } else if (mode === 'general' || mode === 'utility') {
            if (parsed.agentGuidelines) sections.push(`## Agent Guidelines\n${parsed.agentGuidelines}`);
        }

        if (parsed.customRules) sections.push(`## Custom Rules\n${parsed.customRules}`);

        if (sections.length === 0) return '';
        return `<project-premise>\n# PROJECT CONTEXT (From CWTOOLS.md)\n${sections.join('\n\n')}\n</project-premise>\n`;
    }

    /**
     * Build a slim project rules prompt for sub-agents — only mod info + namespaces.
     */
    private getSlimProjectRulesPrompt(): string {
        const profile = this.parseProjectProfile();
        if (profile) {
            const namespaces = profile.identifiers.namespaces.slice(0, 30);
            const parts: string[] = [
                `Project: ${profile.projectName}`,
                `Kind: ${profile.workspaceKind}`,
                `Game: ${profile.game.displayName}`,
            ];
            if (namespaces.length) parts.push(`Namespaces: ${namespaces.join(', ')}`);
            if (profile.localisation.languages.length) parts.push(`Localisation: ${profile.localisation.languages.join(', ')}`);
            return `<project-hint>${parts.join(' | ')}</project-hint>`;
        }
        const parsed = this.parseProjectRules();
        if (!parsed) return '';
        const parts: string[] = [];
        if (parsed.modInfo) parts.push(`Mod: ${parsed.modInfo.replace(/\n/g, ' | ').replace(/- \*\*/g, '').replace(/\*\*/g, '')}`);
        if (parsed.namespaces?.length) parts.push(`Namespaces: ${parsed.namespaces.join(', ')}`);
        if (parts.length === 0) return '';
        return `<project-hint>${parts.join(' | ')}</project-hint>`;
    }

    /**
     * Read .cwtools-ai/design_blueprint.md and return it as a system directive for Build mode.
     * The blueprint is produced by Plan Mode's write_design_blueprint tool and guides code generation.
     */
    private getDesignBlueprintPrompt(): string {
        try {
            if (!this.workspaceRoot) return '';
            // Scan topic directories for the most recently modified blueprint
            let bestPath = '';
            let bestMtime = 0;
            for (const aiDir of getAiStorageRootCandidates(this.workspaceRoot)) {
                if (!fs.existsSync(aiDir)) continue;
                const entries = fs.readdirSync(aiDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory() || !entry.name.startsWith('topic_')) continue;
                    const bp = path.join(aiDir, entry.name, 'design_blueprint.md');
                    if (fs.existsSync(bp)) {
                        const stat = fs.statSync(bp);
                        if (stat.mtimeMs > bestMtime) {
                            bestMtime = stat.mtimeMs;
                            bestPath = bp;
                        }
                    }
                }
            }
            if (!bestPath) return '';
            const content = fs.readFileSync(bestPath, 'utf-8').trim();
            if (!content) return '';
            // Cap the blueprint injection at 4000 chars to avoid context bloat
            const trimmed = content.length > 4000 ? content.substring(0, 4000) + '\n\n... [blueprint truncated] ...' : content;
            return `<design-blueprint>
## Approved Design Blueprint (MANDATORY — Follow This Architecture)
The following architecture blueprint was approved during the Plan phase. You MUST:
1. Create files in the exact dependency order listed
2. Use the exact entity IDs, event IDs, and scope contexts specified
3. Verify scope transitions at every subsystem boundary (especially site → project → reward)
4. Reference this blueprint when making ANY architectural decision

${trimmed}
</design-blueprint>`;
        } catch {
            return '';
        }
    }

    private getModePrompt(mode: AgentMode, gameKnowledge: string, gameName: string, isSlim: boolean = false): string {
        switch (mode) {
            case 'plan': return buildPlanModeSystemPrompt(gameKnowledge, gameName, isSlim);
            case 'explore': return buildExploreModeSystemPrompt(gameKnowledge, gameName, isSlim);
            case 'general': return buildGeneralModeSystemPrompt(gameKnowledge, gameName); // general never slim
            case 'utility': return buildUtilityModeSystemPrompt(gameKnowledge, gameName); // utility never slim
            case 'review': return buildReviewModeSystemPrompt(gameKnowledge, gameName, isSlim);
            case 'gui_expert': return buildGuiExpertSystemPrompt(gameKnowledge, gameName);
            case 'script_reviewer': return buildScriptReviewerSystemPrompt(gameKnowledge, gameName);
            case 'loc_translator': return buildLocTranslatorSystemPrompt(gameKnowledge, gameName);
            case 'loc_writer': return buildLocWriterSystemPrompt(gameKnowledge, gameName, isSlim);
            case 'orchestrator': return buildOrchestratorSystemPrompt(gameKnowledge, gameName);
            case 'script': return buildScriptModeSystemPrompt(gameKnowledge, gameName);
            default: return buildBuildSystemPrompt(gameKnowledge, gameName, isSlim);
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
     * Scans installed Agent Skills and exposes only a compact index.
     * Full SKILL.md bodies are loaded on demand through run_skill.
     */
    private getAgentSkillsPrompt(): string {
        try {
            return buildSkillIndexPrompt({
                workspaceRoot: this.workspaceRoot,
                globalStoragePath: this.globalStoragePath,
                extensionPath: this.extensionPath,
            });
        } catch (e) {
            ErrorReporter.debug(SOURCE.PROMPT_BUILDER, 'Error reading agent skills', e);
            return '';
        }
    }



    /**
     * Build a specialized compaction system prompt for context summarization.
     * Preserves game-specific identifiers and modding context.
     */
    buildCompactionPrompt(): string {
        // Inject project entity protection hints from CWTOOLS.md
        const profile = this.parseProjectProfile();
        if (profile) {
            return `You are a conversation summarizer. Follow the template in the user message exactly. Output ONLY the filled template, no preamble, no commentary.${this.buildCompactionProtectionHintFromProfile(profile)}`;
        }
        const parsed = this.parseProjectRules();
        const projectProtection = parsed ? this.buildCompactionProtectionHint(parsed) : '';

        return `You are a conversation summarizer. Follow the template in the user message exactly. Output ONLY the filled template, no preamble, no commentary.${projectProtection}`;
    }

    private buildCompactionProtectionHintFromProfile(profile: ProjectProfile): string {
        const parts: string[] = [];
        if (profile.identifiers.namespaces.length) {
            parts.push(`Event namespaces: ${profile.identifiers.namespaces.join(', ')}`);
        }
        const ids = [
            ...profile.identifiers.scriptedTriggers,
            ...profile.identifiers.scriptedEffects,
            ...profile.identifiers.events,
        ].filter(Boolean).slice(0, 20);
        if (ids.length) parts.push(`Key IDs: ${ids.join(', ')}`);
        if (parts.length === 0) return '';
        return `\n\nCRITICAL - These project-specific identifiers MUST be preserved verbatim in the summary (never omit or rephrase):\n${parts.join('\n')}`;
    }

    /**
     * Build compaction protection hint from CWTOOLS.md — instructs the summarizer
     * to always preserve project-specific identifiers and namespaces.
     */
    private buildCompactionProtectionHint(parsed: ParsedProjectRules): string {
        const parts: string[] = [];
        if (parsed.namespaces?.length) {
            parts.push(`Event namespaces: ${parsed.namespaces.join(', ')}`);
        }
        // Extract key identifier names to protect
        if (parsed.knownIdentifiers) {
            const ids = (parsed.knownIdentifiers.match(/`([^`]+)`/g) || [])
                .map((s: string) => s.replace(/`/g, ''))
                .filter((s: string) => s.length > 3)
                .slice(0, 15);
            if (ids.length > 0) parts.push(`Key IDs: ${ids.join(', ')}`);
        }
        if (parts.length === 0) return '';
        return `\n\nCRITICAL — These project-specific identifiers MUST be preserved verbatim in the summary (never omit or rephrase):\n${parts.join('\n')}`;
    }

    /**
     * Build context messages for the current editor state.
     * These are injected before the user's message.
     *
     * Uses smart context windowing:
     * - Small files: include header + current block unless the compatibility setting asks for full content
     * - Large files: attempt to find the enclosing semantic block, fall back to +/-15 lines
     */
    buildContextMessages(options: {
        activeFile?: string;
        cursorLine?: number;
        cursorColumn?: number;
        selectedText?: string;
        fileContent?: string;
        topicId?: string;
        commandToolsAvailable?: boolean;
    }): ChatMessage[] {
        const contextParts: string[] = [];
        const workspaceRel = this.workspaceRoot.replace(/\\/g, '/');
        contextParts.push(`**Project Workspace Root**: \`${workspaceRel}\``);
        const commandToolsAvailable = options.commandToolsAvailable !== false;
        if (commandToolsAvailable) {
            contextParts.push('**run_command cwd**: defaults to Project Workspace Root. Agent Workspace Dir is for temporary artifacts only.');
        }

        if (options.topicId) {
            contextParts.push(`**Agent Workspace Dir**: \`.cwtools-ai/${options.topicId}/\``);
            contextParts.push(`**Agent Scratch Dir**: \`.cwtools-ai/${options.topicId}/scratch/\``);
            if (commandToolsAvailable) {
                contextParts.push(`**Agent Helper Script**: \`.cwtools-ai/${options.topicId}/scratch/agent_helper.py\` (reuse/overwrite for temporary Python helpers; delete only temporary execution/verification helpers, never user-requested deliverables)`);
            }
            contextParts.push(`**Agent Media Dir**: \`.cwtools-ai/${options.topicId}/media/\``);
        }

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
            const includeFullSmallFiles = vs.workspace.getConfiguration('cwtools.ai.performance')
                .get<boolean>('includeFullSmallFiles') === true;

            if (totalLines <= 100 && includeFullSmallFiles) {
                if (options.fileContent.trim().length > 0) {
                    contextParts.push(`\n**Full file content** (${totalLines} lines):\n\`\`\`pdx\n${options.fileContent}\n\`\`\``);
                }
            } else {
                if (totalLines <= 100) {
                    const headerEnd = Math.min(20, totalLines);
                    const headerCode = lines.slice(0, headerEnd).join('\n');
                    if (headerCode.trim().length > 0) {
                        contextParts.push(`\n**File header excerpt** (lines 1-${headerEnd} of ${totalLines}):\n\`\`\`pdx\n${headerCode}\n\`\`\``);
                    }
                }

                const blockRange = this.findEnclosingBlock(lines, options.cursorLine);
                const radius = totalLines <= 100 ? 12 : 15;
                const maxBlockLines = totalLines <= 100 ? 45 : 80;
                const startLine = blockRange ? blockRange[0] : Math.max(0, options.cursorLine - radius);
                const endLine = blockRange
                    ? Math.min(blockRange[1], startLine + maxBlockLines)
                    : Math.min(lines.length - 1, options.cursorLine + radius);
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
             
            const line = lines[i]!;
            for (let c = line.length - 1; c >= 0; c--) {
                 
                if (line[c]! === '}') braceDepth++;
                 
                if (line[c]! === '{') braceDepth--;
            }
            if (braceDepth <= 0 && i < cursorLine) {
                // Check if this line looks like a block opener (e.g. "country_event = {")
                 
                const trimmed = lines[i]!.trim();
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
             
            const line = lines[i]!;
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



    // W6 fix: no longer inject complete code blocks repeatedly (AI has already seen its own generated code in the previous round).
    //Only list the error lines and guide the AI   to use replace_lines for directed repair to avoid wasting thousands of tokens on large files.
    buildValidationRetryMessage(code: string, errors: Array<{ message: string; line: number }>, diagnosticAdvice?: string): ChatMessage {
        const errorList = errors.map(e => `  - Line ${e.line}: ${e.message}`).join('\n');
        const hasSpriteError = errors.some(e => /Expected value of type sprite|type sprite|spriteType|picture|GFX_/i.test(e.message));
        const hasSoundError = errors.some(e => /show_sound|Expected value of type sound|type sound|sound\s*=|music|\.asset/i.test(e.message));
        const spriteGuidance = hasSpriteError
            ? `\n\n${SPRITE_DIAGNOSTIC_REPAIR_PROTOCOL}\n`
            : '';
        let soundGuidance = hasSoundError
            ? `\n\n${SOUND_DIAGNOSTIC_REPAIR_PROTOCOL}\n`
            : '';
        soundGuidance += diagnosticAdvice
            ? `\n\n**Diagnostic routing advice:**\n${diagnosticAdvice}\n`
            : '';
        return {
            role: 'user',
            content: `The code you generated has validation errors. Please fix ONLY the specific error lines listed below using \`replace_lines\` with expectedContent/start-end guards when the line range is clear, or \`multi_replace_file_content\` only after copying exact current TargetContent — do NOT rewrite the entire file.\n\n**Errors:**\n${errorList}${spriteGuidance}${soundGuidance}\nFix each error individually. After fixing, call \`get_diagnostics\` to verify.`,
        };
    }
}
