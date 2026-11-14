/**
 * WorkBuddy / CodeBuddy 离线兜底模型清单（转录自 2026-11-04 真实网关 `/v3/config`）。
 *
 * 多区域冲突裁决规则（对称但保守）：
 * - 对发送上限/能力声明字段（默认窗口 `contextWindow`、最大输出 `maxTokens`、思考阶梯
 *   `reasoningEfforts`、视觉 `supportsImage`、关闭思考能力 `canDisableThinking`），在多区均有
 *   发布时取**交集/最小值**，防止发往一区触发 400 拒绝；
 * - 仅最大允许上下文 `maxContextWindow` 取较大值；
 * - 积分倍率 `credits` 分区保留原始声明，未发布时不强置 `'0'`。
 */

import {
    convergeWorkBuddyEffort,
    type WorkBuddyModelEntry,
    type WorkBuddyRegion,
} from './types';

export type { WorkBuddyModelEntry };

/** 网关已服务但尚未在 `/v3/config` 公布的额外模型留白表（2026-11-04 已全部入表，当前为空）。 */
export const UNPUBLISHED_MODELS: readonly WorkBuddyModelEntry[] = [];

/** 离线兜底全量 49 条模型目录（按 2026-11-04 `/v3/config` 实测合并）。 */
export const FALLBACK_MODELS: readonly WorkBuddyModelEntry[] = [
    {
        id: 'default-model',
        name: 'Auto',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 24000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '优秀的编码模型，适合日常使用',
    },
    {
        id: 'fast-model',
        name: 'Fast',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 32000,
        regions: ['intl'],
        credits: { intl: '0.34' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '响应快，适合简单任务',
    },
    {
        id: 'balanced-model',
        name: 'Balanced',
        contextWindow: 256000,
        maxContextWindow: 256000,
        maxTokens: 32000,
        regions: ['intl'],
        credits: { intl: '0.59' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '速度与质量兼顾，日常工作首选',
    },
    {
        id: 'primary-model',
        name: 'Primary',
        contextWindow: 272000,
        maxContextWindow: 272000,
        maxTokens: 72000,
        regions: ['intl'],
        credits: { intl: '3.31' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '高质量输出，胜任复杂任务',
    },
    {
        id: 'deepseek-v4.1-flash',
        name: 'Deepseek-V4.1-Flash',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl', 'cn'],
        credits: { cn: '0.11', intl: '0.00' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态',
    },
    {
        id: 'deepseek-v4.1-flash-sg',
        name: 'Deepseek-V4.1-Flash',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '0.03' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态',
    },
    {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['intl', 'cn'],
        credits: { cn: '0.08', intl: '0.08' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '原生多模态模型，擅长视觉理解与专业任务',
    },
    {
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        contextWindow: 400000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '6.67' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
    },
    {
        id: 'hy4-preview',
        name: 'Hy4 Preview',
        contextWindow: 200000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['intl'],
        credits: { intl: '0.29' },
        supportsImage: true,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '混元思考模型，具有增强的推理能力',
    },
    {
        id: 'hy3',
        name: 'Hy3',
        contextWindow: 192000,
        maxContextWindow: 192000,
        maxTokens: 64000,
        regions: ['intl', 'cn'],
        credits: { cn: '0.00', intl: '0.00' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '混元思考模型，具有增强的推理能力',
    },
    {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '3.47' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
    },
    {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6-Terra',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '1.39' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 均衡模型，兼顾能力、速度与成本',
    },
    {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6-Luna',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '0.14' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 轻量模型，响应快速，适合日常任务',
    },
    {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '3.31' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'OpenAI 旗舰编码模型，擅长长程任务',
    },
    {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        contextWindow: 272000,
        maxContextWindow: 272000,
        maxTokens: 72000,
        regions: ['intl'],
        credits: { intl: '1.65' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'OpenAI 旗舰编码模型，擅长长程任务',
    },
    {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 48000,
        regions: ['intl', 'cn'],
        credits: { cn: '0.69', intl: '0.69' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '能力均衡，适合日常使用',
    },
    {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 48000,
        regions: ['intl', 'cn'],
        credits: { cn: '0.79', intl: '0.79' },
        supportsImage: true,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '1M 上下文，擅长长程任务',
    },
    {
        id: 'minimax-m3.1-flash',
        name: 'MiniMax-M3.1-Flash',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl', 'cn'],
        credits: { cn: '0.08', intl: '0.08' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'max',
        canDisableThinking: false,
        description: '原生多模态，擅长office、agentic、编程任务，推理速度优异',
    },
    {
        id: 'kimi-k3.1-pro',
        name: 'Kimi-K3.1-Pro',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['intl', 'cn'],
        credits: { cn: '0.97', intl: '0.97' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'Kimi 全新旗舰模型，3万亿级参数。办公、代码、3D 创作与长程 Agent 能力全面升级。',
    },
    {
        id: 'kimi-k3.1-pro-highspeed',
        name: 'Kimi-K3.1-Pro-Highspeed',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['intl'],
        credits: { intl: '1.56' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'K3.1 Pro 高速版本，响应速度提升至 K3.1 Pro 的 2–3 倍，交互更流畅。',
    },
    {
        id: 'kimi-k3',
        name: 'Kimi-K3',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['intl'],
        credits: { intl: '1.62' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
    },
    {
        id: 'grok-4.7',
        name: 'Grok-4.7',
        contextWindow: 200000,
        maxContextWindow: 500000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '1.90' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'SpaceXAI 打造的前沿模型，专为编程、智能体任务及知识型工作而设计。',
    },
    {
        id: 'gemini-3.8-flash',
        name: 'Gemini-3.8-Flash',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 65536,
        regions: ['intl'],
        credits: { intl: '0.95' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '能力均衡，适合日常使用',
    },
    {
        id: 'gpt-6-sol',
        name: 'GPT-6-Sol',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '1.33' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '专为复杂编码和智能体工作流构建的模型',
    },
    {
        id: 'gpt-6-luna',
        name: 'GPT-6-Luna',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '0.07' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '专为单一聚焦、高吞吐量任务打造的高效模型',
    },
    {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1-Sol',
        contextWindow: 272000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        credits: { intl: '1.33' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '专为复杂编码和智能体工作流构建的模型',
    },
    {
        id: 'default',
        name: 'Default',
        contextWindow: 56000,
        maxContextWindow: 56000,
        maxTokens: 24000,
        regions: ['cn'],
        credits: { cn: '2.00' },
        supportsImage: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['cn'],
        credits: { cn: '0.51' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'deepseek-v4-flash',
        name: 'Deepseek-V4-Flash',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 50000,
        regions: ['cn'],
        credits: { cn: '0.17' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'deepseek-v3-2-volc',
        name: 'DeepSeek-V3.2',
        contextWindow: 96000,
        maxContextWindow: 96000,
        maxTokens: 32000,
        regions: ['cn'],
        credits: { cn: '0.29' },
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'minimax-m2.5',
        name: 'MiniMax-M2.5',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 48000,
        regions: ['cn'],
        credits: { cn: '0.18' },
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'minimax-m2.7',
        name: 'MiniMax-M2.7',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 48000,
        regions: ['cn'],
        credits: { cn: '0.19' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'glm-5.0',
        name: 'GLM-5.0',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 48000,
        regions: ['cn'],
        credits: { cn: '0.80' },
        supportsImage: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'glm-5.0-turbo',
        name: 'GLM-5.0-Turbo',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 48000,
        regions: ['cn'],
        credits: { cn: '0.95' },
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 48000,
        regions: ['cn'],
        credits: { cn: '0.23' },
        supportsImage: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'glm-4.6',
        name: 'GLM-4.6',
        contextWindow: 168000,
        maxContextWindow: 168000,
        maxTokens: 32000,
        regions: ['cn'],
        credits: { cn: '0.23' },
        supportsImage: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'glm-4.6v',
        name: 'GLM-4.6V',
        contextWindow: 128000,
        maxContextWindow: 128000,
        maxTokens: 32000,
        regions: ['cn'],
        credits: { cn: '0.11' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'kimi-k3-1',
        name: 'Kimi-K3',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['cn'],
        credits: { cn: '1.62' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
    },
    {
        id: 'kimi-k2.8-preview',
        name: 'Kimi-K2.8-Preview',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['cn'],
        credits: { cn: '0.77' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'Moonshot AI · 擅长复杂长程自主任务、知识工作与科研推理，前端开发突出',
    },
    {
        id: 'kimi-k2.5',
        name: 'Kimi-K2.5',
        contextWindow: 164000,
        maxContextWindow: 164000,
        maxTokens: 32000,
        regions: ['cn'],
        credits: { cn: '0.45' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'kimi-k2-thinking',
        name: 'Kimi-K2-Thinking',
        contextWindow: 164000,
        maxContextWindow: 164000,
        maxTokens: 32000,
        regions: ['cn'],
        credits: { cn: '0.54' },
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'hy3-x',
        name: 'Hy3',
        contextWindow: 192000,
        maxContextWindow: 192000,
        maxTokens: 64000,
        regions: ['cn'],
        credits: { cn: '0.05' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '混元思考模型，具有增强的推理能力',
    },
    {
        id: 'hy4-preview-x',
        name: 'Hy4 preview',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['cn'],
        credits: { cn: '0.29' },
        supportsImage: true,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '混元思考模型，具有增强的推理能力',
    },
    {
        id: 'hunyuan-chat',
        name: 'Hunyuan-Turbos',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 8192,
        regions: ['cn'],
        credits: { cn: '0.10' },
        supportsImage: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'space-bunny',
        name: 'Space-Bunny',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['cn'],
        credits: { cn: '0.08' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'max',
        canDisableThinking: false,
        description: '推理速度极快，编码能力强劲，并支持原生多模态输入的匿名大模型',
    },
    {
        id: 'step-5-preview',
        name: 'Step-5-Preview',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['cn'],
        credits: { cn: '0.33' },
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '阶跃 StepFun 面向真实任务的新一代旗舰基模',
    },
    {
        id: 'mimo-v2.6-pro',
        name: 'Xiaomi MiMo-V2.6-Pro',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['cn'],
        credits: { cn: '0.13' },
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'Xiaomi · 旗舰推理模型，面向专业、复杂长程工作流，兼顾高阶科研与网络安全',
    },
    {
        id: 'hy4free',
        name: 'Hy4 Free',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['cn'],
        credits: { cn: '0.00' },
        supportsImage: true,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '最新旗舰模型，Agent与多模专长',
    },
    {
        id: 'hy4std',
        name: 'Hy4',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['cn'],
        credits: { cn: '0.29' },
        supportsImage: true,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '最新旗舰模型，Agent与多模专长',
    },
];

/** 内置表知道的每一个 id，按声明顺序。 */
export const WORKBUDDY_MODEL_IDS: readonly string[] = FALLBACK_MODELS.map(model => model.id);

/** 首次安装时默认推荐并展示的代表模型 id。 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = [
    'glm-5.3',
    'deepseek-v4.1-flash',
    'hy4std',
    'kimi-k3.1-pro',
];

const WORKBUDDY_VENDOR_RULES: ReadonlyArray<{ re: RegExp; family: string }> = [
    { re: /^(default|fast|balanced|primary|deep)(-model)?$/, family: 'alias' },
    { re: /^gpt-/, family: 'openai' },
    { re: /^gemini-/, family: 'google' },
    { re: /^glm-/, family: 'zhipu' },
    { re: /^kimi-/, family: 'moonshot' },
    { re: /^deepseek-/, family: 'deepseek' },
    { re: /^hy[0-9]/, family: 'tencent' },
    { re: /^hunyuan/, family: 'tencent' },
    { re: /^minimax-/, family: 'minimax' },
    { re: /^mimo-/, family: 'xiaomi' },
    { re: /^step-/, family: 'stepfun' },
    { re: /^grok-/, family: 'xai' },
    { re: /^space-bunny$/, family: 'space-bunny' },
];

/** 获取模型所属厂商家族名。 */
export function workBuddyModelVendor(id: string): string {
    const value = id.toLowerCase();
    for (const rule of WORKBUDDY_VENDOR_RULES) {
        if (rule.re.test(value)) return rule.family;
    }
    return id;
}

function versionSegments(id: string): number[] {
    return [...id.toLowerCase().matchAll(/\d+/g)].map(match => Number(match[0]));
}

function compareWithinFamily(a: { id: string }, b: { id: string }): number {
    const left = versionSegments(a.id);
    const right = versionSegments(b.id);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const x = left[index];
        const y = right[index];
        if (x === undefined) return 1;
        if (y === undefined) return -1;
        if (x !== y) return y - x;
    }
    return 0;
}

/**
 * 将模型按首次出现的厂商家族聚类，并在每个家族内部按主版本号降序排列。
 */
export function groupWorkBuddyModelsByVendor<T extends { id: string }>(models: readonly T[]): T[] {
    const families = new Map<string, T[]>();
    for (const model of models) {
        const family = workBuddyModelVendor(model.id);
        const bucket = families.get(family);
        if (bucket === undefined) families.set(family, [model]);
        else bucket.push(model);
    }
    return [...families.values()]
        .map(bucket => [...bucket].sort(compareWithinFamily))
        .flat();
}

function builtinWorkBuddyModels(): readonly WorkBuddyModelEntry[] {
    const known = new Set<string>();
    const merged: WorkBuddyModelEntry[] = [];
    for (const model of [...FALLBACK_MODELS, ...UNPUBLISHED_MODELS]) {
        if (known.has(model.id)) continue;
        known.add(model.id);
        merged.push(model);
    }
    return merged;
}

const BUILTIN_MODELS: readonly WorkBuddyModelEntry[] = builtinWorkBuddyModels();

/**
 * 内置表里某个区域的模型清单（按厂商分族且新代际优先）。
 * `region` 为 `undefined` 时返回两区并集。
 */
export function builtinWorkBuddyModelsForRegion(region?: WorkBuddyRegion): WorkBuddyModelEntry[] {
    const filtered = region === undefined
        ? [...BUILTIN_MODELS]
        : BUILTIN_MODELS.filter(model => model.regions.includes(region));
    return groupWorkBuddyModelsByVendor(filtered);
}

/** 将网关实际服务但未在 `/v3/config` 发布的模型并入目录（始终优先保留已发布条目）。 */
export function withUnpublishedWorkBuddyModels(
    catalog: readonly WorkBuddyModelEntry[],
    region: WorkBuddyRegion,
): WorkBuddyModelEntry[] {
    const known = new Set(catalog.map(model => model.id));
    const extra = UNPUBLISHED_MODELS.filter(
        model => model.regions.includes(region) && !known.has(model.id),
    );
    return extra.length > 0 ? [...catalog, ...extra] : [...catalog];
}

/**
 * 按 ID 检索 WorkBuddy 模型条目：实时目录优先，再退回内置表。
 * 同时将落于阶梯之外的声明默认档就地收敛，防止请求遗漏 `reasoning_effort`。
 */
export function resolveWorkBuddyModelEntry(
    id: string,
    liveCatalog?: readonly WorkBuddyModelEntry[],
): WorkBuddyModelEntry | undefined {
    const key = id.trim();
    if (key === '') return undefined;
    const found = liveCatalog?.find(model => model.id === key)
        ?? BUILTIN_MODELS.find(model => model.id === key);
    if (found === undefined) return undefined;
    const ladder = found.reasoningEfforts;
    const declared = found.defaultReasoningEffort;
    if (declared === null || ladder.includes(declared)) return found;
    return { ...found, defaultReasoningEffort: convergeWorkBuddyEffort(declared, ladder) };
}
