/** 
* Eddy CWTool Code — Agent role registration form 
* 
* Define the default configuration (mode, tool budget, iteration limit) for each Agent role. 
* Model selection inherits the supplier/model configured by the user in the settings panel by default. 
* suggestedModel / suggestedProvider are only suggested values ​​and can be overridden by TaskNode. 
*/

import type { AgentProfile, ToolBudget } from './types';

/** 
* Agent role registry. 
* 
* Each role defines its responsibility boundaries and resource limits: 
* - mode: AgentMode mapped to AgentRunner, which determines the system prompt words and tool set 
* - suggestedModel/Provider: suggested model (undefined = inherit user settings) 
* - maxIterations: the maximum number of iterations of the inference loop 
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
        // Inherit user-configured provider/model (without specifying suggestedModel)
        maxIterations: 20,
        toolBudget: 'read_only',
        description: '扫描项目结构、收集文件和实体信息、构建依赖图。只读操作，不会修改任何文件。',
    },

    /** 
* Architect - entity blueprint design, event chain orchestration, and implementation plan formulation. 
* Requires strong reasoning skills for complex planning. 
*/
    architect: {
        mode: 'plan',
        // It is recommended to use a stronger model for planning (user can override)
        maxIterations: 15,
        toolBudget: 'plan',
        description: '分析需求、设计实体蓝图、规划事件链和文件依赖。只读 + 蓝图输出，不写代码。',
    },

    /** 
* Builder - code generation, file writing, bug fixing. 
* Core execution role, requires full tool permissions. 
*/
    builder: {
        mode: 'build',
        maxIterations: 40,
        toolBudget: 'full',
        description: '根据蓝图或指令生成 PDXScript 代码、写入文件、修复 LSP 错误。全功能 Agent。',
    },

    /** 
* Localization Writer - Multi-language localization file creation and translation. 
* Template tasks, suitable for lightweight models. 
*/
    locWriter: {
        mode: 'loc_writer',
        maxIterations: 20,
        toolBudget: 'loc',
        description: '创建和翻译 YML 本地化文件。专注于文本质量和格式合规。',
    },

    /** 
* Reviewer - code review, diagnostic verification, quality control. 
* Read-only operation, focus on finding problems. 
*/
    reviewer: {
        mode: 'review',
        maxIterations: 15,
        toolBudget: 'read_only',
        description: '审查代码质量、验证 LSP 诊断、检查作用域链和跨文件引用一致性。只读操作。',
    },

    /** 
* Asset Selector - Search and select suitable media assets from original game and project files. 
* Restricted build mode, no build/conversion/deployment tools are used, asset selection is done only via search and file references. 
*/
    assetGen: {
        mode: 'build',
        maxIterations: 10,
        toolBudget: 'media_only',
        description: '从原版游戏文件和项目已有资源中搜索、选择合适的图标/音效等媒体资产，通过文件引用或复制完成资产配置。不生成新资产，不调用外部工具。',
    },

    /** 
* GUI Expert - handles complex UI interface layout calculations for Stellaris or other Paradox games. 
* Requires extremely strong pixel calculation and layer deduction capabilities. 
*/
    guiExpert: {
        mode: 'gui_expert',
        maxIterations: 30,
        toolBudget: 'full',
        description: '编辑 .gui 界面文件，处理复杂的 UI 坐标、锚点与容器排版。',
    },

    /** 
* Localization translator - specializes in strict format translation across languages. 
* Only used when explicitly indicated as a [Translation] task, which is different from locWriter created from scratch. 
*/
    locTranslator: {
        mode: 'loc_translator',
        maxIterations: 20,
        toolBudget: 'loc',
        description: '将现有的 YML 本地化条目翻译为其他语言。必须且仅能在用户明确要求【翻译】已有文本时使用，严禁自行创作。',
    },
};

// W10 fix: alias mapping of AgentMode to registry keys.
// Orchestrator uses AgentMode values ​​(such as 'explore', 'build') to query the configuration,
// But the registry key uses the role name (such as 'explorer', 'builder').
// This mapping ensures that the two naming systems are correctly connected.
const MODE_TO_ROLE_ALIAS: Record<string, string> = {
    'explore': 'explorer',
    'build': 'builder',
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
            // Clear the recommended values ​​and fall back to inheriting the user's main settings
            profile.suggestedProvider = undefined;
        }
        if (config.model && config.model !== '__inherit__') {
            profile.suggestedModel = config.model;
        } else {
            profile.suggestedModel = undefined;
        }
    }
}
