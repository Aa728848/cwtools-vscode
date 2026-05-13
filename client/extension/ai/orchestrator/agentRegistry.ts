/**
 * Eddy CWTool Code — Agent 角色注册表
 *
 * 定义每种 Agent 角色的默认配置（模式、工具预算、迭代上限）。
 * 模型选择默认继承用户在设置面板中配置的供应商/模型。
 * suggestedModel / suggestedProvider 仅作为建议值，可被 TaskNode 覆盖。
 */

import type { AgentProfile, ToolBudget } from './types';

/**
 * Agent 角色注册表。
 *
 * 每个角色定义了其职责边界和资源限制：
 * - mode: 映射到 AgentRunner 的 AgentMode，决定系统提示词和工具集
 * - suggestedModel/Provider: 建议的模型（undefined = 继承用户设置）
 * - maxIterations: 推理循环最大迭代次数
 * - toolBudget: 工具权限等级
 * - description: 角色描述，供 Orchestrator 在任务分解时参考
 */
export const AGENT_REGISTRY: Record<string, AgentProfile> = {
    /**
     * 探索者 — 项目结构扫描、依赖图绘制、上下文收集。
     * 只读操作，适合用轻量模型快速执行。
     */
    explorer: {
        mode: 'explore',
        // 继承用户配置的供应商/模型（不指定 suggestedModel）
        maxIterations: 20,
        toolBudget: 'read_only',
        description: '扫描项目结构、收集文件和实体信息、构建依赖图。只读操作，不会修改任何文件。',
    },

    /**
     * 架构师 — 实体蓝图设计、事件链编排、实施计划制定。
     * 需要较强的推理能力进行复杂规划。
     */
    architect: {
        mode: 'plan',
        // 建议使用更强的模型进行规划（用户可覆盖）
        maxIterations: 15,
        toolBudget: 'plan',
        description: '分析需求、设计实体蓝图、规划事件链和文件依赖。只读 + 蓝图输出，不写代码。',
    },

    /**
     * 构建者 — 代码生成、文件写入、错误修复。
     * 核心执行角色，需要全部工具权限。
     */
    builder: {
        mode: 'build',
        maxIterations: 40,
        toolBudget: 'full',
        description: '根据蓝图或指令生成 PDXScript 代码、写入文件、修复 LSP 错误。全功能 Agent。',
    },

    /**
     * 本地化编写者 — 多语言本地化文件创建和翻译。
     * 模板化任务，适合轻量模型。
     */
    locWriter: {
        mode: 'loc_writer',
        maxIterations: 20,
        toolBudget: 'loc',
        description: '创建和翻译 YML 本地化文件。专注于文本质量和格式合规。',
    },

    /**
     * 审查者 — 代码审查、诊断验证、质量把关。
     * 只读操作，专注于发现问题。
     */
    reviewer: {
        mode: 'review',
        maxIterations: 15,
        toolBudget: 'read_only',
        description: '审查代码质量、验证 LSP 诊断、检查作用域链和跨文件引用一致性。只读操作。',
    },

    /**
     * 资产生成者 — 图标、音效等媒体资产生成和转换。
     * 受限的 build 模式，仅有媒体相关工具。
     */
    assetGen: {
        mode: 'build',
        maxIterations: 10,
        toolBudget: 'media_only',
        description: '生成图标、音效等媒体资产，进行 DDS/OGG 格式转换，部署到 mod 目录。',
    },

    /**
     * GUI 专家 — 处理 Stellaris 或其他 P 社游戏的复杂 UI 界面排版计算。
     * 需要极强的像素计算和图层推演能力。
     */
    guiExpert: {
        mode: 'gui_expert',
        maxIterations: 30,
        toolBudget: 'full',
        description: '编辑 .gui 界面文件，处理复杂的 UI 坐标、锚点与容器排版。',
    },

    /**
     * 本地化翻译者 — 专注于跨语言的严格格式翻译。
     * 仅在明确指示为【翻译】任务时使用，区别于从零创作的 locWriter。
     */
    locTranslator: {
        mode: 'loc_translator',
        maxIterations: 20,
        toolBudget: 'loc',
        description: '将现有的 YML 本地化条目翻译为其他语言。必须且仅能在用户明确要求【翻译】已有文本时使用，严禁自行创作。',
    },
};

// W10 修复：AgentMode 与注册表 key 的别名映射。
// Orchestrator 使用 AgentMode 值（如 'explore', 'build'）查询配置，
// 但注册表 key 使用的是角色名（如 'explorer', 'builder'）。
// 此映射确保两套命名体系正确对接。
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
 * 获取 Agent 角色配置。
 * 支持通过角色名（explorer）或模式名（explore）查询。
 * 如果都不存在于注册表中，返回默认的 builder 配置。
 */
export function getAgentProfile(role: string): AgentProfile {
    return AGENT_REGISTRY[role]
        ?? AGENT_REGISTRY[MODE_TO_ROLE_ALIAS[role] ?? '']
        ?? AGENT_REGISTRY['builder']!;
}

/**
 * 获取所有可用的 Agent 角色名称列表。
 * 供 Orchestrator 在任务分解时参考。
 */
export function getAvailableRoles(): string[] {
    return Object.keys(AGENT_REGISTRY);
}

/**
 * 生成角色描述摘要（供 Orchestrator 系统提示词使用）。
 * 格式：每行一个 "- role: description"
 */
export function getRoleDescriptions(): string {
    return Object.entries(AGENT_REGISTRY)
        .map(([role, profile]) => `- **${role}** (${profile.mode}): ${profile.description}`)
        .join('\n');
}

/**
 * 应用用户在设置面板中配置的子 Agent 模型覆盖。
 * 将用户指定的 provider/model 写入对应角色的 suggestedProvider/suggestedModel。
 *
 * @param overrides 角色名 → { provider, model } 的映射
 */
export function applyUserModelOverrides(overrides: Record<string, { provider: string; model: string }>): void {
    for (const [role, config] of Object.entries(overrides)) {
        const profile = AGENT_REGISTRY[role];
        if (!profile) continue;
        if (config.provider && config.provider !== '__inherit__') {
            profile.suggestedProvider = config.provider;
        } else {
            // 清除建议值，回退到继承用户主设置
            profile.suggestedProvider = undefined;
        }
        if (config.model && config.model !== '__inherit__') {
            profile.suggestedModel = config.model;
        } else {
            profile.suggestedModel = undefined;
        }
    }
}
