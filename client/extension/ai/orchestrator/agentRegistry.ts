/** 
 * Eddy CWTool Code — Agent role registration form 
 * 
 * Define the default configuration (mode, tool budget, iteration limit) for each Agent role. 
 * Model selection inherits the supplier/model configured by the user in the settings panel by default. 
 * suggestedModel / suggestedProvider are only suggested values and can be overridden by TaskNode. 
 */

import type { AgentProfile } from './types';
import { aiText } from '../messages';

/** 
 * Agent role registry. 
 * 
 * Each role defines its responsibility boundaries and resource limits: 
 * - mode: AgentMode mapped to AgentRunner, which determines the system prompt words and tool set 
 * - suggestedModel/Provider: suggested model (undefined = inherit user settings) 
 * - maxIterations: healthy-progress window; the Orchestrator renews it while the child remains healthy
 * - toolBudget: tool permission level 
 * - description: role description for Orchestrator to refer to when decomposing tasks 
 */
export const AGENT_REGISTRY: Record<string, AgentProfile> = {
    /** 
     * Explorer - project structure scanning, dependency graph drawing, context collection. 
     * Read-only operation, suitable for fast execution with lightweight models. 
     */
    explorer: {
        mode: 'explore',
        maxIterations: 40,
        toolBudget: 'read_only',
        get description() {
            return aiText(
                'Scan project structure, collect file and entity information, and build dependency graphs. Read-only; does not modify files.',
                '扫描项目结构、收集文件和实体信息、构建依赖图。只读操作，不会修改任何文件。',
            );
        },
    },

    /** 
     * Architect - entity blueprint design, event chain orchestration, and implementation plan formulation. 
     * Requires strong reasoning skills for complex planning. 
     */
    architect: {
        mode: 'plan',
        maxIterations: 30,
        toolBudget: 'plan',
        get description() {
            return aiText(
                'Analyze requirements, design entity blueprints, and plan event chains plus file dependencies. Read-only with blueprint output; does not write code.',
                '分析需求、设计实体蓝图、规划事件链和文件依赖。只读 + 蓝图输出，不写代码。',
            );
        },
    },

    /** 
     * Builder - code generation, file writing, bug fixing. 
     * Core execution role, requires full tool permissions. 
     */
    builder: {
        mode: 'build',
        maxIterations: 80,
        toolBudget: 'full',
        get description() {
            return aiText(
                'Generate PDXScript from a blueprint or instruction, write files, and fix LSP errors. Full-capability agent.',
                '根据蓝图或指令生成 PDXScript 代码、写入文件、修复 LSP 错误。全功能 Agent。',
            );
        },
    },

    /** General-purpose repository coder used by domain-neutral orchestration. */
    utilityCoder: {
        mode: 'utility',
        maxIterations: 80,
        toolBudget: 'full',
        get description() {
            return aiText(
                'Implement ordinary repository code, tests, configuration, documentation, and tooling; run scoped builds or tests when needed.',
                '实现通用仓库代码、测试、配置、文档和工具；按需运行范围明确的构建或测试。',
            );
        },
    },

    /** 
     * Localization Writer - Multi-language localization file creation and translation. 
     * Template tasks, suitable for lightweight models. 
     */
    locWriter: {
        mode: 'loc_writer',
        maxIterations: 50,
        toolBudget: 'loc',
        get description() {
            return aiText(
                'Create and translate YML localisation files, focusing on text quality and format correctness.',
                '创建和翻译 YML 本地化文件。专注于文本质量和格式合规。',
            );
        },
    },

    /** 
     * Reviewer - code review, diagnostic verification, quality control. 
     * Read-only operation, focus on finding problems. 
     */
    reviewer: {
        mode: 'review',
        maxIterations: 30,
        toolBudget: 'read_only',
        get description() {
            return aiText(
                'Review code quality, verify LSP diagnostics, and check scope chains plus cross-file reference consistency. Read-only.',
                '审查代码质量、验证 LSP 诊断、检查作用域链和跨文件引用一致性。只读操作。',
            );
        },
    },

    /** 
     * Asset Selector - Search and select suitable media assets from original game and project files. 
     * Restricted build mode, no build/conversion/deployment tools are used, asset selection is done only via search and file references. 
     */
    assetGen: {
        mode: 'build',
        maxIterations: 20,
        toolBudget: 'media_only',
        get description() {
            return aiText(
                'Search vanilla game files and existing project resources for suitable icons, sounds, and other media assets; configure them by reference or copy. Does not generate new assets or call external tools.',
                '从原版游戏文件和项目已有资源中搜索、选择合适的图标/音效等媒体资产，通过文件引用或复制完成资产配置。不生成新资产，不调用外部工具。',
            );
        },
    },

    /** 
     * GUI Expert - handles complex UI interface layout calculations for Stellaris or other Paradox games. 
     * Requires extremely strong pixel calculation and layer deduction capabilities. 
     */
    guiExpert: {
        mode: 'gui_expert',
        maxIterations: 60,
        toolBudget: 'full',
        get description() {
            return aiText(
                'Edit .gui interface files and handle complex UI coordinates, anchors, and container layout.',
                '编辑 .gui 界面文件，处理复杂的 UI 坐标、锚点与容器排版。',
            );
        },
    },

    /** 
     * Localization translator - specializes in strict format translation across languages. 
     * Only used when explicitly indicated as a [Translation] task, which is different from locWriter created from scratch. 
     */
    locTranslator: {
        mode: 'loc_translator',
        maxIterations: 50,
        toolBudget: 'loc',
        get description() {
            return aiText(
                'Translate existing YML localisation entries into other languages. Use only when the user explicitly asks to translate existing text; do not invent new copy.',
                '将现有的 YML 本地化条目翻译为其他语言。必须且仅能在用户明确要求【翻译】已有文本时使用，严禁自行创作。',
            );
        },
    },
};

// W10 fix: alias mapping of AgentMode to registry keys.
// Orchestrator uses AgentMode values (such as 'explore', 'build') to query the configuration,
// But the registry key uses the role name (such as 'explorer', 'builder').
// This mapping ensures that the two naming systems are correctly connected.
const MODE_TO_ROLE_ALIAS: Record<string, string> = {
    'explore': 'explorer',
    'build': 'builder',
    'utility': 'utilityCoder',
    'plan': 'architect',
    'review': 'reviewer',
    'loc_writer': 'locWriter',
    'loc_translator': 'locTranslator',
    'gui_expert': 'guiExpert',
};

/** 
 * Get Agent role configuration. 
 * Supports querying by role name (explorer) or schema name (explore). 
 * If neither exists in the registry, return the default builder configuration. 
 */
export function getAgentProfile(role: string): AgentProfile {
    return AGENT_REGISTRY[role]
        ?? AGENT_REGISTRY[MODE_TO_ROLE_ALIAS[role] ?? '']
        ?? AGENT_REGISTRY['builder']!;
}

/** 
 * Get a list of all available Agent role names. 
 * For Orchestrator's reference when decomposing tasks. 
 */
export function getAvailableRoles(): string[] {
    return Object.keys(AGENT_REGISTRY);
}

/** 
 * Generate role description summaries (for use by Orchestrator system prompts). 
 * Format: one "- role: description" per line 
 */
export function getRoleDescriptions(): string {
    return Object.entries(AGENT_REGISTRY)
        .map(([role, profile]) => `- **${role}** (${profile.mode}): ${profile.description}`)
        .join('\n');
}

/** 
 * Apply child Agent model overrides configured by the user in the settings panel. 
 * Write the user-specified provider/model into suggestedProvider/suggestedModel of the corresponding role. 
 * 
 * @param overrides role name → mapping of { provider, model } 
 */
export function applyUserModelOverrides(overrides: Record<string, { provider: string; model: string }>): void {
    for (const [role, config] of Object.entries(overrides)) {
        const profile = AGENT_REGISTRY[role];
        if (!profile) continue;
        if (config.provider && config.provider !== '__inherit__') {
            profile.suggestedProvider = config.provider;
        } else {
            // Clear the recommended values and fall back to inheriting the user's main settings
            profile.suggestedProvider = undefined;
        }
        if (config.model && config.model !== '__inherit__') {
            profile.suggestedModel = config.model;
        } else {
            profile.suggestedModel = undefined;
        }
    }
}
