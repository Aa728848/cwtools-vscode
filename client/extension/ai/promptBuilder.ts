/**
 * Eddy CWTool Code Module — Prompt Builder
 *
 * Constructs system prompts and contextual information for the AI agent,
 * injecting game-specific PDXScript knowledge based on the active languageId.
 *
 * Aligned with OpenCode's multi-mode prompt design (build / plan / explore / general).
 */

import * as vs from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, AgentMode, ToolDefinition } from './types';
import { getGameKnowledge, getGameDisplayName } from './gameKnowledge';
import { MemoryParser } from './memoryParser';
import { ErrorReporter } from './errorReporter';
import { SOURCE, aiText, getAiMessageLocale } from './messages';
import { getExistingTopicFilePath, getPrivateTopicStorageDir } from './workspacePaths';
import {
    buildProfileSummary,
    getProjectProfilePath,
    getPromptCardForMode,
    readProjectProfile,
} from './projectProfile';
import { buildProjectKnowledgePrompt, readProjectKnowledgeManifest } from './projectKnowledge';
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
    /** Current user task used only for relevance-ranked memory retrieval. */
    taskText?: string;
    /** Active/recent files used as path-scope hints for memory retrieval. */
    pathScope?: string[];
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
import { buildSkillIndexPrompt, listSkills } from './skills';

// ─── Frozen prompt fingerprint (plan §7.1) ──────────────────────────────────

/**
 * Manual version counter for the frozen system prompt template. Bump this
 * whenever the prompt structure changes (sections added/removed/reordered, or
 * shared policy text edited) so prompts cached by older builds are never
 * reused across extension updates (plan §7.1).
 */
export const PROMPT_TEMPLATE_VERSION = 2;

/**
 * Why a frozen system prompt lookup missed. Process-local diagnostics only —
 * see PromptBuilder.getFrozenPromptCacheStats().
 */
export type FrozenPromptMissReason =
    | 'cold'               // first build for this identity (mode/provider/game/locale)
    | 'template_version'   // PROMPT_TEMPLATE_VERSION changed
    | 'rules_changed'      // CWTOOLS.md content hash changed
    | 'profile_changed'    // .cwtools/project/profile.json content hash changed
    | 'skills_changed'     // installed skill index changed
    | 'toolset_changed'    // filtered tool definition set changed
    | 'flag_changed'       // prompt-affecting feature flag changed
    | 'fingerprint_missing'// a fingerprint component could not be computed
    | 'evicted'            // same fingerprint but the LRU entry was gone
    | 'rebuild';           // explicit AgentRunnerOptions.rebuildSystemPrompt

interface FrozenPromptFingerprintComponents {
    templateVersion: number;
    mode: AgentMode;
    providerId: string;
    gameId: string;
    locale: string;
    rulesHash: string;
    profileHash: string;
    skillsHash: string;
    toolsetHash: string;
    flagsHash: string;
}

interface FrozenPromptFingerprint {
    /** sha256 (truncated) over the serialized components — the cache key. */
    hash: string;
    /** Identity dimensions only (mode/provider/game/locale), for miss classification. */
    baseKey: string;
    /** Resolved game language id (never undefined — fixes the old `languageId ?? ''` key). */
    gameId: string;
    components: FrozenPromptFingerprintComponents;
    /** True when one or more components could not be computed. */
    incomplete: boolean;
}

/** sha256 hex digest truncated for cache keys/hashes (cache identity only, not security-sensitive). */
function shortSha256(content: string, length = 16): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, length);
}

/**
 * Fingerprint the model-visible tool definitions for the frozen prompt cache
 * key. Only tool names and `required` parameter lists are hashed: description
 * text churn is covered by PROMPT_TEMPLATE_VERSION, so editing a description
 * does not needlessly invalidate cached prompts (plan §7.1).
 */
export function hashToolDefinitionsForFingerprint(tools: readonly ToolDefinition[]): string {
    const stable = tools.map(tool => ({
        name: tool.function.name,
        required: (tool.function.parameters as { required?: unknown }).required ?? [],
    }));
    return shortSha256(JSON.stringify(stable));
}

/**
 * Order the initial request messages for provider prefix caching (plan §7.2):
 * the stable system prompt stays at the head, cacheable (possibly compacted)
 * history follows, and dynamic editor/project state sits immediately before
 * the user turn so the long static prefix remains byte-stable. The OpenAI
 * Responses API merges system messages into top-level instructions preserving
 * their relative order (aiService buildOpenAIResponsesPayload), so this
 * ordering does not conflict with that merge.
 */
export function orderMessagesForStablePrefix(parts: {
    systemPrompt: string;
    compactedHistory: ChatMessage[];
    contextMessages: ChatMessage[];
    dynamicBlock: ChatMessage[];
    userContent: ChatMessage['content'];
}): ChatMessage[] {
    return [
        { role: 'system', content: parts.systemPrompt },
        ...parts.compactedHistory,
        ...parts.contextMessages,
        ...parts.dynamicBlock,
        { role: 'user', content: parts.userContent },
    ];
}

// ─── Model-specific instruction supplements ───────────────────────────────────

/** Anthropic Claude: encourage parallel tool batching, leverage extended thinking */
const ANTHROPIC_SUPPLEMENT = `
<system-reminder>
You are using Claude. Batch independent tool calls in a single response. Use extended thinking for complex scope chains.
</system-reminder>`;

/** Gemini: prefer direct answers, avoid over-tooling */
const GEMINI_SUPPLEMENT = `
<system-reminder>
You are using Gemini. Prefer direct answers for simple questions. Only call tools when you genuinely need external information. For PDXScript constructs, CWT/LSP verification counts as genuinely needed external information.
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
     *  Key: sha256 over the structured prompt fingerprint (template version,
     *  mode, provider, resolved game id, locale, CWTOOLS.md / project profile
     *  content hashes, skill index hash, toolset hash, prompt-affecting flags)
     *  — value is the cached prompt string (plan §7.1).
     *  Bounded by FROZEN_PROMPT_CACHE_MAX to guard against runaway growth from
     *  unexpected key explosion (e.g. providerId variations). LRU eviction relies
     *  on Map's insertion-order semantics. */
    private static readonly FROZEN_PROMPT_CACHE_MAX = 32;
    private _frozenPromptCache = new Map<string, string>();
    /** Last-seen fingerprint components per identity key (mode|provider|game|locale),
     *  used to classify cache misses. Bounded, insertion-order trimmed. */
    private static readonly FROZEN_FINGERPRINT_HISTORY_MAX = 64;
    private _frozenFingerprintHistory = new Map<string, FrozenPromptFingerprintComponents>();
    /** Process-local hit/miss counters; deliberately not persisted — see
     *  getFrozenPromptCacheStats() for the rationale. */
    private _frozenPromptHits = 0;
    private _frozenPromptMisses = new Map<FrozenPromptMissReason, number>();
    private _lastFrozenPromptLookup?: { hit: boolean; missReason?: FrozenPromptMissReason };
    private _lastFrozenPromptFingerprint: FrozenPromptFingerprint | undefined;

    constructor(
        private workspaceRoot: string,
        private globalStoragePath?: string,
        private extensionPath?: string
    ) {
        this.memoryParser = new MemoryParser(workspaceRoot);
    }

    /** Invalidate project-derived long-term memory after project/rule mutations. */
    public markProjectMemoryStale(): number {
        return MemoryParser.markWorkspaceProjectFactsStale(this.workspaceRoot);
    }

    /**
     * Detect the active game languageId from the currently open editor.
     * Falls back to generic Paradox rules if nothing is detected.
     */
    private detectGameLanguageId(): string {
        const editor = vs.window.activeTextEditor;
        if (editor) {
            const langId = editor.document.languageId;
            const knownLangs = ['stellaris', 'hoi4', 'eu4', 'ck2', 'ck3', 'vic2', 'vic3', 'imperator', 'eu5', 'paradox'];
            if (knownLangs.includes(langId)) return langId;
        }
        const knownLangs = ['stellaris', 'hoi4', 'eu4', 'ck2', 'ck3', 'vic2', 'vic3', 'imperator', 'eu5', 'paradox'];
        const profileGame = readProjectProfile(this.workspaceRoot)?.game?.id;
        if (profileGame && knownLangs.includes(profileGame)) return profileGame;
        const knowledgeGame = readProjectKnowledgeManifest(this.workspaceRoot)?.game;
        if (knowledgeGame && knownLangs.includes(knowledgeGame)) return knowledgeGame;
        // Fallback: avoid leaking Stellaris-specific rules into other PDX games.
        return 'paradox';
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
        },
        includeMemory = true,
        includeProjectKnowledge = true
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
            const summaryMdPath = path.join(getPrivateTopicStorageDir(topicId, wsRoot), 'runs', runId, 'summary.md');
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
            let pinnedText = aiText('## Pinned Context\n', '## 📌 活跃钉选状态与实时断点 (Pinned Context)\n');
            let hasPinned = false;

            if (pinned.pendingInteractions && pinned.pendingInteractions.length > 0) {
                pinnedText += aiText(
                    `### Pending Approvals\n${pinned.pendingInteractions.map(pi => `- ${pi}`).join('\n')}\n`,
                    `### ⏳ 挂起中的交互操作 (Pending Approvals)\n${pinned.pendingInteractions.map(pi => `- ${pi}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.todos && pinned.todos.length > 0) {
                const activeTodos = pinned.todos.filter(t => t.status === 'pending');
                if (activeTodos.length > 0) {
                    pinnedText += aiText(
                        `### Remaining Todos\n${activeTodos.map(t => `- [ ] ${t.content}${(t as any).filePath ? ` (related file: ${(t as any).filePath})` : ''}`).join('\n')}\n`,
                        `### 📋 剩余待完成子任务 (Remaining Todos)\n${activeTodos.map(t => `- [ ] ${t.content}${(t as any).filePath ? ` (关联文件: ${(t as any).filePath})` : ''}`).join('\n')}\n`,
                    );
                    hasPinned = true;
                }
            }

            if (pinned.diagnostics && pinned.diagnostics.length > 0) {
                pinnedText += aiText(
                    `### Active Diagnostics\n${pinned.diagnostics.map(d => `- **${path.basename(d.file)}** [line ${d.line}]: ${d.message}`).join('\n')}\n`,
                    `### ⚠️ 未解决的代码诊断报错 (Active Diagnostics)\n${pinned.diagnostics.map(d => `- **${path.basename(d.file)}** [第 ${d.line} 行]: ${d.message}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.recentWrittenFiles && pinned.recentWrittenFiles.length > 0) {
                pinnedText += aiText(
                    `### Recent Written Files\n${pinned.recentWrittenFiles.map(f => `- ${path.basename(f)}`).join('\n')}\n`,
                    `### 📝 最近写入的文件 (Recent Written Files)\n${pinned.recentWrittenFiles.map(f => `- ${path.basename(f)}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.blockedSubAgents && pinned.blockedSubAgents.length > 0) {
                pinnedText += aiText(
                    `### Blocked Sub-Agent Clarifications\n${pinned.blockedSubAgents.map(b => `- ${b}`).join('\n')}\n`,
                    `### 🚧 子 Agent 阻塞待决 (Blocked Sub-Agent Clarifications)\n${pinned.blockedSubAgents.map(b => `- ${b}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.decisions && pinned.decisions.length > 0) {
                pinnedText += aiText(
                    `### Key Decisions\n${pinned.decisions.map(d => `- ${d}`).join('\n')}\n`,
                    `### 💡 关键技术决策 (Key Decisions)\n${pinned.decisions.map(d => `- ${d}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (hasPinned) {
                finalPrompt += `<pinned-context>\n\n${pinnedText.trim()}\n\n</pinned-context>\n\n`;
            }
        }
        if (projectRules) finalPrompt += projectRules + '\n';
        if (includeProjectKnowledge) {
            const projectKnowledge = buildProjectKnowledgePrompt(this.workspaceRoot);
            if (projectKnowledge) finalPrompt += projectKnowledge + '\n';
        }

        if (includeMemory) {
            // Direct prompt-builder callers may not have a current user task.
            // AgentRunner keeps includeMemory=false here and supplies task/path
            // retrieval context through buildDynamicPromptBlock instead.
            const memoryPrompt = this.memoryParser.getMemoryPrompt(topicId, { gameId });
            if (memoryPrompt) finalPrompt += memoryPrompt + '\n';
        }

        // Inject approved design blueprint in Build mode
        if (mode === 'build') {
            const blueprintPrompt = this.getDesignBlueprintPrompt(topicId);
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
     *
     * The cache key is a sha256 over a structured fingerprint (plan §7.1):
     * PROMPT_TEMPLATE_VERSION, mode, providerId, the RESOLVED game language id
     * (never undefined — auto-detection used to leave the key segment empty),
     * locale, CWTOOLS.md and project-profile content hashes, skill index hash,
     * the filtered toolset hash, and prompt-affecting feature flags. Any
     * component change therefore produces a distinct entry instead of reusing a
     * stale prompt.
     *
     * @param options.toolsetHash - hashToolDefinitionsForFingerprint() of the run's tool set
     * @param options.rebuild - AgentRunnerOptions.rebuildSystemPrompt: drop this
     *   fingerprint's entry and rebuild (counts as a 'rebuild' miss).
     */
    buildFrozenSystemPrompt(
        mode: AgentMode = 'build',
        providerId?: string,
        languageId?: string,
        options?: { toolsetHash?: string; rebuild?: boolean }
    ): string {
        const fingerprint = this.computeFrozenPromptFingerprint(mode, providerId, languageId, options?.toolsetHash);
        if (options?.rebuild) {
            // Precise invalidation: only this fingerprint's entry is dropped;
            // other modes/providers keep their cached prompts.
            this._frozenPromptCache.delete(fingerprint.hash);
            this.recordFrozenPromptMiss('rebuild');
            this._lastFrozenPromptLookup = { hit: false, missReason: 'rebuild' };
            return this.buildAndStoreFrozenPrompt(mode, providerId, fingerprint);
        }
        const cached = this._frozenPromptCache.get(fingerprint.hash);
        if (cached !== undefined) {
            this._frozenPromptHits++;
            this._lastFrozenPromptLookup = { hit: true };
            this._lastFrozenPromptFingerprint = fingerprint;
            this.rememberFrozenFingerprint(fingerprint);
            return cached;
        }
        const missReason = this.classifyFrozenPromptMiss(fingerprint);
        this.recordFrozenPromptMiss(missReason);
        this._lastFrozenPromptLookup = { hit: false, missReason };
        return this.buildAndStoreFrozenPrompt(mode, providerId, fingerprint);
    }

    private buildAndStoreFrozenPrompt(mode: AgentMode, providerId: string | undefined, fingerprint: FrozenPromptFingerprint): string {
        // Force stable mode by leaving topicId, runId, pinned, and memory undefined.
        // The resolved gameId is passed explicitly so the built prompt and the
        // fingerprint always describe the same game.
        const prompt = this.buildSystemPromptForMode(mode, providerId, fingerprint.gameId, undefined, undefined, undefined, false, false);
        // LRU eviction: drop oldest entry once we exceed the cap (Map iterates in insertion order).
        if (this._frozenPromptCache.size >= PromptBuilder.FROZEN_PROMPT_CACHE_MAX) {
            const oldestKey = this._frozenPromptCache.keys().next().value;
            if (oldestKey !== undefined) {
                this._frozenPromptCache.delete(oldestKey);
            }
        }
        this._frozenPromptCache.set(fingerprint.hash, prompt);
        this._lastFrozenPromptFingerprint = fingerprint;
        this.rememberFrozenFingerprint(fingerprint);
        return prompt;
    }

    private rememberFrozenFingerprint(fingerprint: FrozenPromptFingerprint): void {
        this._frozenFingerprintHistory.delete(fingerprint.baseKey);
        this._frozenFingerprintHistory.set(fingerprint.baseKey, fingerprint.components);
        while (this._frozenFingerprintHistory.size > PromptBuilder.FROZEN_FINGERPRINT_HISTORY_MAX) {
            const oldestKey = this._frozenFingerprintHistory.keys().next().value;
            if (oldestKey === undefined) break;
            this._frozenFingerprintHistory.delete(oldestKey);
        }
    }

    private recordFrozenPromptMiss(reason: FrozenPromptMissReason): void {
        this._frozenPromptMisses.set(reason, (this._frozenPromptMisses.get(reason) ?? 0) + 1);
    }

    private classifyFrozenPromptMiss(fingerprint: FrozenPromptFingerprint): FrozenPromptMissReason {
        if (fingerprint.incomplete) return 'fingerprint_missing';
        const previous = this._frozenFingerprintHistory.get(fingerprint.baseKey);
        if (!previous) return 'cold';
        if (previous.templateVersion !== fingerprint.components.templateVersion) return 'template_version';
        if (previous.rulesHash !== fingerprint.components.rulesHash) return 'rules_changed';
        if (previous.profileHash !== fingerprint.components.profileHash) return 'profile_changed';
        if (previous.skillsHash !== fingerprint.components.skillsHash) return 'skills_changed';
        if (previous.toolsetHash !== fingerprint.components.toolsetHash) return 'toolset_changed';
        if (previous.flagsHash !== fingerprint.components.flagsHash) return 'flag_changed';
        // Identical fingerprint but no cache entry: the LRU evicted it (or it was cleared).
        return 'evicted';
    }

    private computeFrozenPromptFingerprint(mode: AgentMode, providerId: string | undefined, languageId: string | undefined, toolsetHash?: string): FrozenPromptFingerprint {
        let incomplete = false;
        let gameId = 'unknown';
        let locale = 'unknown';
        let rulesHash = 'unknown';
        let profileHash = 'unknown';
        let skillsHash = 'unknown';
        let flagsHash = 'unknown';
        try { gameId = languageId ?? this.detectGameLanguageId(); } catch { incomplete = true; }
        try { locale = getAiMessageLocale(); } catch { incomplete = true; }
        try {
            const rules = this.parseProjectRules();
            rulesHash = rules ? shortSha256(rules.raw) : 'none';
        } catch { incomplete = true; }
        try {
            const profile = this.parseProjectProfile();
            profileHash = profile ? shortSha256(JSON.stringify(profile)) : 'none';
        } catch { incomplete = true; }
        try { skillsHash = this.computeSkillsIndexHash(); } catch { incomplete = true; }
        try { flagsHash = this.computePromptFlagsHash(); } catch { incomplete = true; }
        const components: FrozenPromptFingerprintComponents = {
            templateVersion: PROMPT_TEMPLATE_VERSION,
            mode,
            providerId: providerId ?? '',
            gameId,
            locale,
            rulesHash,
            profileHash,
            skillsHash,
            toolsetHash: toolsetHash ?? '',
            flagsHash,
        };
        return {
            hash: shortSha256(JSON.stringify(components), 24),
            baseKey: `${mode}|${providerId ?? ''}|${gameId}|${locale}`,
            gameId,
            components,
            incomplete,
        };
    }

    /**
     * Hash the installed skill index: frontmatter fields plus file mtime/size,
     * so SKILL.md body edits without frontmatter changes still invalidate the
     * frozen prompt (plan §7.1). listSkills() is sorted by name, so the hash
     * is deterministic.
     */
    private computeSkillsIndexHash(): string {
        const skills = listSkills({
            workspaceRoot: this.workspaceRoot,
            globalStoragePath: this.globalStoragePath,
            extensionPath: this.extensionPath,
        });
        if (skills.length === 0) return 'none';
        const parts = skills.map(skill => {
            let fileSig = 'unreadable';
            try {
                const stat = fs.statSync(skill.filePath);
                fileSig = `${stat.mtimeMs}:${stat.size}`;
            } catch { /* keep fallback marker */ }
            return [skill.name, skill.description, skill.runAs ?? '', (skill.allowedTools ?? []).join(','), fileSig].join('|');
        });
        return shortSha256(parts.join('\n'));
    }

    /**
     * Feature flags that change prompt or tool message content (plan §7.1).
     * legacyFullToolset does not alter the prompt text itself but gates the
     * tool set, so flipping it must rebuild the frozen prompt together with
     * the toolset hash. Read directly from configuration (no new settings).
     */
    private computePromptFlagsHash(): string {
        const perfConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance');
        return shortSha256(JSON.stringify({
            fullProjectRulesInBuild: perfConfig.get<boolean>('fullProjectRulesInBuild') === true,
            includeFullSmallFiles: perfConfig.get<boolean>('includeFullSmallFiles') === true,
            legacyFullToolset: perfConfig.get<boolean>('legacyFullToolset') === true,
        }));
    }

    /** Short fingerprint hash of the most recently served frozen prompt, for usage records (plan §7.3). */
    getLastFrozenPromptFingerprintHash(): string | undefined {
        return this._lastFrozenPromptFingerprint?.hash;
    }

    /** Result of the most recent frozen-prompt lookup for persisted invalidation diagnostics. */
    getLastFrozenPromptLookup(): { hit: boolean; missReason?: FrozenPromptMissReason } | undefined {
        return this._lastFrozenPromptLookup ? { ...this._lastFrozenPromptLookup } : undefined;
    }

    /**
     * Process-local frozen prompt cache diagnostics (plan §7.3). Deliberately
     * not persisted to globalState: these are session-scoped cache-correctness
     * counters, not billing data, so they live next to the cache itself
     * instead of inside UsageTracker's persisted store.
     */
    getFrozenPromptCacheStats(): { size: number; hits: number; misses: number; missReasons: Record<string, number> } {
        const missReasons: Record<string, number> = {};
        let misses = 0;
        for (const [reason, count] of this._frozenPromptMisses) {
            missReasons[reason] = count;
            misses += count;
        }
        return { size: this._frozenPromptCache.size, hits: this._frozenPromptHits, misses, missReasons };
    }

    /**
     * Drop the parsed CWTOOLS.md / project profile mtime caches so the next
     * prompt build re-reads them from disk. Frozen prompt entries key on
     * content hashes and therefore miss naturally; called by file watchers on
     * those inputs (plan §7.1).
     */
    invalidateProjectPromptInputs(): void {
        this._parsedRulesCache = null;
        this._parsedRulesMtime = 0;
        this._projectProfileCache = null;
        this._projectProfileMtime = 0;
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
        const projectKnowledge = buildProjectKnowledgePrompt(this.workspaceRoot);
        if (projectKnowledge) dynamicParts.push(projectKnowledge);
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

        if (runtime?.mode === 'build') {
            const blueprintPrompt = this.getDesignBlueprintPrompt(topicId);
            if (blueprintPrompt) dynamicParts.push(blueprintPrompt);
        }

        const memoryPrompt = this.memoryParser.getMemoryPrompt(topicId, {
            taskText: runtime?.taskText,
            gameId: this.detectGameLanguageId(),
            pathScope: runtime?.pathScope,
        });
        if (memoryPrompt) dynamicParts.push(memoryPrompt);

        // 1. Compacted Summary (来自历史会话看板的压缩)
        if (topicId && runId) {
            const wsRoot = this.workspaceRoot;
            const summaryMdPath = path.join(getPrivateTopicStorageDir(topicId, wsRoot), 'runs', runId, 'summary.md');
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
            let pinnedText = aiText('## Pinned Context\n', '## 📌 活跃钉选状态与实时断点 (Pinned Context)\n');
            let hasPinned = false;

            if (pinned.pendingInteractions && pinned.pendingInteractions.length > 0) {
                pinnedText += aiText(
                    `### Pending Approvals\n${pinned.pendingInteractions.map(pi => `- ${pi}`).join('\n')}\n`,
                    `### ⏳ 挂起中的交互操作 (Pending Approvals)\n${pinned.pendingInteractions.map(pi => `- ${pi}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.todos && pinned.todos.length > 0) {
                const activeTodos = pinned.todos.filter(t => t.status === 'pending');
                if (activeTodos.length > 0) {
                    pinnedText += aiText(
                        `### Remaining Todos\n${activeTodos.map(t => `- [ ] ${t.content}${(t as any).filePath ? ` (related file: ${(t as any).filePath})` : ''}`).join('\n')}\n`,
                        `### 📋 剩余待完成子任务 (Remaining Todos)\n${activeTodos.map(t => `- [ ] ${t.content}${(t as any).filePath ? ` (关联文件: ${(t as any).filePath})` : ''}`).join('\n')}\n`,
                    );
                    hasPinned = true;
                }
            }

            if (pinned.diagnostics && pinned.diagnostics.length > 0) {
                pinnedText += aiText(
                    `### Active Diagnostics\n${pinned.diagnostics.map(d => `- **${path.basename(d.file)}** [line ${d.line}]: ${d.message}`).join('\n')}\n`,
                    `### ⚠️ 未解决的代码诊断报错 (Active Diagnostics)\n${pinned.diagnostics.map(d => `- **${path.basename(d.file)}** [第 ${d.line} 行]: ${d.message}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.recentWrittenFiles && pinned.recentWrittenFiles.length > 0) {
                pinnedText += aiText(
                    `### Recent Written Files\n${pinned.recentWrittenFiles.map(f => `- ${path.basename(f)}`).join('\n')}\n`,
                    `### 📝 最近写入的文件 (Recent Written Files)\n${pinned.recentWrittenFiles.map(f => `- ${path.basename(f)}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.blockedSubAgents && pinned.blockedSubAgents.length > 0) {
                pinnedText += aiText(
                    `### Blocked Sub-Agent Clarifications\n${pinned.blockedSubAgents.map(b => `- ${b}`).join('\n')}\n`,
                    `### 🚧 子 Agent 阻塞待决 (Blocked Sub-Agent Clarifications)\n${pinned.blockedSubAgents.map(b => `- ${b}`).join('\n')}\n`,
                );
                hasPinned = true;
            }

            if (pinned.decisions && pinned.decisions.length > 0) {
                pinnedText += aiText(
                    `### Key Decisions\n${pinned.decisions.map(d => `- ${d}`).join('\n')}\n`,
                    `### 💡 关键技术决策 (Key Decisions)\n${pinned.decisions.map(d => `- ${d}`).join('\n')}\n`,
                );
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
    buildSlimSystemPromptForMode(mode: AgentMode, providerId?: string, languageId?: string, topicId?: string): string {
        const gameId = languageId ?? this.detectGameLanguageId();
        const gameKnowledge = getGameKnowledge(gameId);
        const gameName = getGameDisplayName(gameId);
        const basePrompt = this.getModePrompt(mode, gameKnowledge, gameName, true);
        const supplement = this.getModelSupplement(providerId);
        const slimRules = this.getSlimProjectRulesPrompt();
        
        let finalPrompt = '';
        if (slimRules) finalPrompt += slimRules + '\n';
        if (mode === 'build') {
            const blueprintPrompt = this.getDesignBlueprintPrompt(topicId);
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
        return `<project-premise>\n# PROJECT PROFILE (from .cwtools/project/profile.json)\nUse this compact profile for routing and project convention hints. Do not broad-scan the workspace until you have checked the profile and the relevant indexed tools. Cross-check profile facts against current files and CWT/LSP evidence before treating them as binding. For more details, call \`query_project_profile\` with a targeted section.\n\n## Summary\n${buildProfileSummary(profile)}\n\n## Active Mode Card\n${this.truncateProjectRuleSection(promptCard || 'No mode-specific project card was generated.', 1800)}\n\n## Recommended Workflows\n${workflowHints || '- No workflow recommendations generated.'}\n\n## Efficiency Hints\n${profile.efficiencyHints.slice(0, 5).map(hint => `- ${hint}`).join('\n')}${custom}\n</project-premise>\n`;
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
        // still available through stellarisLanguageServices.ai.performance.fullProjectRulesInBuild.
        if (mode === 'build' || !mode) {
            const fullBuildRules = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
                .get<boolean>('fullProjectRulesInBuild') === true;
            if (fullBuildRules) {
                return `<project-premise>\n# PROJECT RULES & CONTEXT (From CWTOOLS.md)\nRead these project-specific rules before attempting the task. Follow them when consistent with the current user request, current files, and CWT/LSP evidence; they never override tool safety, current diagnostics, or verified game rules:\n\n${parsed.raw}\n</project-premise>\n`;
            }

            const buildSections: string[] = [];
            if (parsed.modInfo) buildSections.push(`## Mod Info\n${this.truncateProjectRuleSection(parsed.modInfo, 1200)}`);
            if (parsed.projectStructure) buildSections.push(`## Project Structure\n${this.truncateProjectRuleSection(parsed.projectStructure, 1800)}`);
            if (parsed.namespaces?.length) buildSections.push(`### Event Namespaces\n${parsed.namespaces.slice(0, 80).map(ns => `- \`${ns}\``).join('\n')}`);
            if (parsed.agentGuidelines) buildSections.push(`## Agent Guidelines\n${this.truncateProjectRuleSection(parsed.agentGuidelines, 2600)}`);
            if (parsed.customRules) buildSections.push(`## Custom Rules\n${this.truncateProjectRuleSection(parsed.customRules, 2200)}`);
            if (buildSections.length === 0) return '';
            return `<project-premise>\n# PROJECT RULES SUMMARY (From CWTOOLS.md)\nFollow these project-specific rules when they are consistent with the current user request, current files, and CWT/LSP evidence. If the task depends on omitted details or the user explicitly asks for full project policy, read CWTOOLS.md before editing.\n\n${buildSections.join('\n\n')}\n</project-premise>\n`;
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
        return `<project-premise>\n# PROJECT CONTEXT (From CWTOOLS.md)\nTreat this as project convention context and cross-check it against current files and CWT/LSP evidence.\n\n${sections.join('\n\n')}\n</project-premise>\n`;
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
     * Read the current topic's design_blueprint.md and return it as a directive for Build mode.
     * The blueprint is produced by Plan Mode's write_design_blueprint tool and guides code generation.
     */
    private getDesignBlueprintPrompt(topicId?: string): string {
        try {
            if (!this.workspaceRoot || !topicId) return '';
            const blueprintPath = getExistingTopicFilePath(topicId, 'design_blueprint.md', this.workspaceRoot);
            if (!blueprintPath || !fs.existsSync(blueprintPath)) return '';
            const content = fs.readFileSync(blueprintPath, 'utf-8').trim();
            if (!content) return '';
            const relativePath = path.relative(this.workspaceRoot, blueprintPath).replace(/\\/g, '/');
            // Keep both the head and tail so dependency order, cleanup, and risk sections survive truncation.
            const maxChars = 12_000;
            const trimmed = content.length > maxChars
                ? `${content.substring(0, 8_000)}\n\n... [blueprint middle truncated; read ${relativePath} for the full current-topic blueprint] ...\n\n${content.substring(content.length - 3_000)}`
                : content;
            return `<design-blueprint>
## Current Topic Design Blueprint (MANDATORY - Follow This Architecture)
This blueprint belongs to topic \`${topicId}\` and is stored at \`${relativePath}\`. You MUST:
1. Create files in the exact dependency order listed
2. Use the exact entity IDs, event IDs, and scope contexts specified
3. Verify scope transitions at every subsystem boundary (especially site -> project -> reward)
4. Preserve the selected common/ subsystem plan, reward plan, trigger plan, and cleanup plan
5. Reference this blueprint when making ANY architectural decision

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
            contextParts.push(`**Agent Workspace Dir**: \`.cwtools/${options.topicId}/\``);
            contextParts.push(`**Agent Scratch Dir**: \`.cwtools/${options.topicId}/scratch/\``);
            if (commandToolsAvailable) {
                contextParts.push(`**Agent Helper Script**: \`.cwtools/${options.topicId}/scratch/agent_helper.py\` (reuse/overwrite for temporary Python helpers; delete only temporary execution/verification helpers, never user-requested deliverables)`);
            }
            contextParts.push(`**Agent Media Dir**: \`.cwtools/${options.topicId}/media/\``);
        }

        if (options.activeFile) {
            const relPath = path.relative(this.workspaceRoot, options.activeFile).replace(/\\/g, '/');
            contextParts.push(`**Current file**: \`${relPath}\``);

            // Determine file type (compare case-insensitively against lowercase Paradox dir conventions)
            const relLower = relPath.toLowerCase();
            if (relLower.startsWith('events/')) {
                contextParts.push('**File type**: Event definitions');
            } else if (relLower.includes('common/scripted_triggers')) {
                contextParts.push('**File type**: Scripted triggers');
            } else if (relLower.includes('common/scripted_effects')) {
                contextParts.push('**File type**: Scripted effects');
            } else if (relLower.startsWith('localisation/') || relLower.startsWith('localization/')) {
                contextParts.push('**File type**: Localisation');
            } else if (relLower.includes('common/')) {
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
            const includeFullSmallFiles = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
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
            content: `The code you generated has validation errors. Please fix ONLY the specific error lines listed below using \`replace_lines\` with expectedContent/start-end guards when the line range is clear, or \`edit_file\` only after copying the exact current text into oldString — do NOT rewrite the entire file.\n\n**Errors:**\n${errorList}${spriteGuidance}${soundGuidance}\nFix each error individually. After fixing, call \`get_diagnostics\` to verify.`,
        };
    }
}
