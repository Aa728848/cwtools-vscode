/**
 * WorkBuddy / CodeBuddy 订阅的内置模型表。
 *
 * 网关的 `/v3/config` 才是权威目录，但在**首次运行尚未登录**或**网关不可达**时它读不到，
 * 而设置卡片的模型下拉与思考档位都必须有内容。这张表逐字转录自一次真实的
 * `/v3/config` 读取，不是按厂商宣传推算的：早期按名字猜窗口在两个方向上都错了
 * （`glm-5.3` 与 `kimi-k3` 是 1M，不是 200K/256K）。
 *
 * 一个条目同时服务两个区，因此两区不一致的模型需要合并后的数字。合并规则是刻意不对称的：
 * **模型上限取较大者**，而**默认服务长度与输出上限取较小者**。高报这两个值都是硬失败——
 * DSH 会发出网关拒绝的请求——而低报只是比需要更早压缩对话；两者都可以在设置卡片里
 * 逐模型覆盖。实测的分歧（`glm-5.3-flash`/`glm-5.3`/`glm-5.2`/`kimi-k2.8-preview`
 * 国际区服务 300000/48000/48000/32000，国区为 1000000/64000/64000/64000）按此规则合并。
 *
 * 两区服务的 id 也不同。国际区有 `gemini-3.5-flash`、`kimi-k3` 与 `*-model` 别名；
 * 国区有 `glm-5.1`、`kimi-k3-1`、`hy4-preview-f`、`space-bunny`、`minimax-*` 与它自己的
 * `-x` 变体。**`regions` 是路由事实而不是偏好**：向不服务该模型的一区发请求返回 400
 * `code 11102`。
 *
 * 同一个 11102 还有第二个来源，这里**刻意不过滤**：网关会列出当前账号无权调用的模型
 * （免费套餐下 `glm-5.0`、`glm-4.7`、`glm-4.6`、`glm-4.6v`、`kimi-k2-thinking`、
 * `hy4-preview-f`、`minimax-m2.5` 都公布了窗口然后答 11102）。这些条目保留，因为门控是
 * 按账号而不是按模型的（付费套餐可能服务它们），且默认选择本来就把它们排除在外。
 *
 * `reasoningEfforts` 是模型接受的档位表，转录自网关自己的声明。网关用两种形状公布它，
 * 两者曾被弄混且方向相反：单独的 `{ effort: 'high' }`（没有 `supportedEfforts`）先是变成
 * 单档表，从而拒掉了调用方显式的 `low`；放宽到本线路能叫出名字的每一档后，又在一个只有
 * 三档的模型上宣传 `minimal`/`xhigh`。这类模型恰好接受 `low`/`high`/`max`
 * （在 `deepseek-v4.1-flash` 上实测），与网关为 `glm-5.3-flash`、`kimi-k2.8-preview`
 * 显式声明的一致，其余取值被路由到最近的一档。
 *
 * 表里出现过的档位只有 low/medium/high/xhigh/max，全部落在控制面能表达的档位词汇内。
 *
 * 有 14 个条目的 `defaultReasoningEffort` **落在自己的档位表之外**——档位表是
 * `low`/`high`/`max`，默认档却写着 `medium`。这不是笔误，而是网关的真实行为（它用比
 * 档位表更宽的词汇表命名默认档）。表里因此**原样保留**该值，由消费者在**读取时**用
 * convergeWorkBuddyEffort 收敛（见 `resolveWorkBuddyModelEntry`）。理由是硬约束：若把
 * `medium` 原样当成请求的默认档送出去，档位解析会丢弃它 -> 请求不带 reasoning_effort ->
 * 模型返回空的 reasoning_content（在 `minimax-m3` 上实测 0 字符 vs 带字段 282-659 字符）。
 *
 * 这张表是**离线兜底**：只要网关可达，实时目录永远优先，本表只负责回答实时目录没
 * 提到的 id（见 {@link resolveWorkBuddyModelEntry}）。
 *
 * 表里出现的**唯一 id 共 47 个**：含国区 30 个、含国际区 25 个、两区共有 8 个。
 * {@link UNPUBLISHED_MODELS} 的三个 id 在这 47 个里已经存在（数值一致），因此按 id 去重后
 * 总数仍是 47，不是 50。
 */

import { convergeWorkBuddyEffort, type WorkBuddyRegion } from './types';
import type { WorkBuddyModelEntry } from './modelCatalog';

/**
 * 网关实际服务、但**不在 `/v3/config` 里公布**的模型。
 *
 * 目录是一份「已公布」的清单，而不是「已服务」的清单：在国际区后端实测，`gpt-6-sol`、
 * `gpt-6-luna`、`gemini-3.8-flash` 都能用普通流式补全答 200，却完全不在 `/v3/config` 里，
 * 而一个可达的网关会**用公布的清单替换掉内置表**。没有这些条目，选择器就永远不会显示它们，
 * 所以它们既在这里声明，也会被并入实时目录（见 {@link withUnpublishedWorkBuddyModels}）。
 *
 * 各行记录的内容及其确定方式按字段区分：
 *
 * - **存在性、档位表、图片支持**是对活端点实测的，不是从名字推断的。被拒的档位返回 400
 *   `code 11133` 与 `extError` `400002`；`gpt-6-sol` 恰好接受 `gpt-6-astra` 公布的档位表
 *   （拒 `minimal`，接受 `low`/`medium`/`high`/`xhigh`/`max`），两者都接受 1x1 PNG。
 * - **上下文窗口、输出上限与 `canDisableThinking` 继承自同家族已公布的兄弟条目**——
 *   `gpt-6-sol` 与 `gpt-6-luna` 取自 `gpt-6-astra`，`gemini-3.8-flash` 取自
 *   `gemini-3.5-flash`。它们在这里被标记而不是被实测，是因为网关对这些 id 什么都不公布，
 *   也没有廉价的办法读到真实数字。
 *
 * 注意 `gemini-3.8-flash` 与 `gpt-6-sol`/`gpt-6-luna` 在 {@link FALLBACK_MODELS} 里已有同名条目，
 * 这不矛盾：内置表按 id 去重，两处数值一致，重复声明是为了让「未公布」这一事实单独可见。
 */
export const UNPUBLISHED_MODELS: readonly WorkBuddyModelEntry[] = [
    {
        id: 'gpt-6-sol',
        name: 'GPT-6-Sol',
        contextWindow: 400000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
    },
    {
        id: 'gpt-6-luna',
        name: 'GPT-6-Luna',
        contextWindow: 400000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 轻量模型，响应快速，适合日常任务',
    },
    {
        id: 'gemini-3.8-flash',
        name: 'Gemini-3.8-Flash',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 65536,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '能力均衡，适合日常使用',
    },
];

/**
 * 离线兜底目录，转录自一次真实的 `/v3/config` 读取。
 *
 * 用于网关不可达时（首次运行尚未登录，或网络故障）；只要网关可达就永远以实时目录为准。
 */
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
        id: 'default',
        name: 'Default',
        contextWindow: 56000,
        maxContextWindow: 56000,
        maxTokens: 24000,
        regions: ['cn'],
        supportsImage: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'fast-model',
        name: 'Fast',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 32000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
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
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
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
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '高质量输出，胜任复杂任务',
    },
    {
        id: 'deep-model',
        name: 'Deep',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 24000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '深度推理，适合深度分析与难题',
    },
    {
        id: 'gpt-6-sol',
        name: 'GPT-6-Sol',
        contextWindow: 400000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
    },
    {
        id: 'gpt-6-luna',
        name: 'GPT-6-Luna',
        contextWindow: 400000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 轻量模型，响应快速，适合日常任务',
    },
    {
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        contextWindow: 400000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
    },
    {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl'],
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
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: '能力均衡，适合日常使用',
    },
    {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['intl', 'cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: '原生多模态模型，擅长视觉理解与专业任务',
    },
    {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 48000,
        regions: ['intl', 'cn'],
        supportsImage: true,
        reasoningEfforts: ['high', 'xhigh'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: '1M 上下文，擅长长程任务',
    },
    {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 48000,
        regions: ['cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'glm-5v-turbo',
        name: 'GLM-5v-Turbo',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 64000,
        regions: ['cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
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
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
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
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
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
        supportsImage: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'kimi-k3',
        name: 'Kimi-K3',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
    },
    {
        id: 'kimi-k3-1',
        name: 'Kimi-K3',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
    },
    {
        id: 'kimi-k2.8-preview',
        name: 'Kimi-K2.8-Preview',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 32000,
        regions: ['intl', 'cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: true,
        description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
    },
    {
        id: 'kimi-k2.7',
        name: 'Kimi-K2.7-Code',
        contextWindow: 256000,
        maxContextWindow: 256000,
        maxTokens: 32000,
        regions: ['cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'kimi-k2.6',
        name: 'Kimi-K2.6',
        contextWindow: 256000,
        maxContextWindow: 256000,
        maxTokens: 32000,
        regions: ['intl', 'cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '多模态模型，适合日常任务',
    },
    {
        id: 'kimi-k2.5',
        name: 'Kimi-K2.5',
        contextWindow: 164000,
        maxContextWindow: 164000,
        maxTokens: 32000,
        regions: ['cn'],
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
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'deepseek-v4.1-flash',
        name: 'Deepseek-V4.1-Flash',
        contextWindow: 300000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['intl', 'cn'],
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
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态',
    },
    {
        id: 'deepseek-v4-pro',
        name: 'Deepseek-V4-Pro',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 128000,
        regions: ['cn'],
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
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'hy4-preview',
        name: 'Hy4 preview',
        contextWindow: 200000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['intl', 'cn'],
        supportsImage: true,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '混元思考模型，具有增强的推理能力',
    },
    {
        id: 'hy4-preview-f',
        name: 'Hy4 preview',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 64000,
        regions: ['cn'],
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
        supportsImage: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '混元思考模型，具有增强的推理能力',
    },
    {
        id: 'hy3-x',
        name: 'Hy3',
        contextWindow: 192000,
        maxContextWindow: 192000,
        maxTokens: 64000,
        regions: ['cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
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
        supportsImage: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'max',
        canDisableThinking: false,
        description: '推理速度极快，编码能力强劲，并支持原生多模态输入的匿名大模型',
    },
    {
        id: 'minimax-m3',
        name: 'MiniMax-M3',
        contextWindow: 512000,
        maxContextWindow: 512000,
        maxTokens: 64000,
        regions: ['cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '原生多模态，擅长代码、智能体任务',
    },
    {
        id: 'minimax-m2.7',
        name: 'MiniMax-M2.7',
        contextWindow: 200000,
        maxContextWindow: 200000,
        maxTokens: 48000,
        regions: ['cn'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
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
        supportsImage: false,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        canDisableThinking: false,
        description: '',
    },
    {
        id: 'gemini-3.8-flash',
        name: 'Gemini-3.8-Flash',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 65536,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '能力均衡，适合日常使用',
    },
    {
        id: 'gemini-3.5-flash',
        name: 'Gemini-3.5-Flash',
        contextWindow: 1000000,
        maxContextWindow: 1000000,
        maxTokens: 65536,
        regions: ['intl'],
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        canDisableThinking: false,
        description: '能力均衡，适合日常使用',
    },
];

/** 内置表知道的每一个 id，按声明顺序。 */
export const WORKBUDDY_MODEL_IDS: readonly string[] = FALLBACK_MODELS.map(model => model.id);

/**
 * 新安装时选择器默认展示的模型。
 *
 * 刻意很短：内置表持有订阅服务的全部 id，而选择器只有寥寥几个通用模型时才真正好用。
 * 卡片允许用户添加其余模型。
 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = [
    'glm-5.3',
    'deepseek-v4.1-flash',
    'hy4-preview',
    'kimi-k2.6',
];

/**
 * 内置表 + 未公布模型，按 id 去重后的完整清单。
 *
 * `/v3/config` 里已经有 `gpt-6-sol`、`gpt-6-luna`、`gemini-3.8-flash`，因此直接拼接
 * {@link UNPUBLISHED_MODELS} 会产生重复 id——选择器会显示两遍，按 id 取模型也会在前者处
 * 命中。这里以 {@link FALLBACK_MODELS} 为准，只追加内置表没提到的 id。
 */
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

/** 去重后的完整内置清单；已缓存，避免每次查档位都重建。 */
const BUILTIN_MODELS: readonly WorkBuddyModelEntry[] = builtinWorkBuddyModels();

/**
 * 内置表里某个区域的模型清单。
 *
 * `region` 为 `undefined` 表示**区域未知**（尚未登录、或网关读不到），此时返回**两区并集**：
 * 两区清单不是包含关系（国区独有 `glm-5.1`/`deepseek-v4-pro`/`kimi-k2.5`/`hy4-preview-f`/
 * `space-bunny`/`minimax-*`，国际区独有 `gpt-6-*`/`gemini-*`/`kimi-k3`/
 * `deepseek-v4.1-flash-sg`），只给一区会让另一区的账号在登录前看不到自己唯一能用的模型。
 * 一旦区域能确定（凭据在手），必须按该区域过滤：跨区发模型会被网关以 400 `code 11102` 拒绝。
 */
export function builtinWorkBuddyModelsForRegion(region?: WorkBuddyRegion): WorkBuddyModelEntry[] {
    if (region === undefined) return [...BUILTIN_MODELS];
    return BUILTIN_MODELS.filter(model => model.regions.includes(region));
}

/**
 * 把网关服务的、但没公布的模型并入实时目录。
 *
 * 可达的网关会用自己公布的清单替换内置表，因此一个它服务却不列出的模型
 * （{@link UNPUBLISHED_MODELS}）会在目录加载完成的瞬间从选择器里消失。在这里合并即可让它
 * 保持可选。
 *
 * **已公布的条目永远优先**：凡是网关描述过的东西，网关就是权威，这些行只填负载没有提到的 id。
 */
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
 * 一个 id 的条目：先查实时目录，再退回内置表。
 *
 * 两个来源都查不到时返回 `undefined`，而不是借用一个邻居条目的能力——把真实模型的图片支持
 * 报给一个它并不描述的 id，就是把请求路由到 400。调用方据此判断「这个 id 谁都不认识」。
 *
 * 命中的条目会**在读取时归一化默认档**：网关用比档位表更宽的词汇命名默认档（`medium` 配
 * `low`/`high`/`max`），原样保留会让档位解析步骤丢弃它、请求不带 `reasoning_effort`，
 * 而这条线路在不带该字段时返回**空的 reasoning_content**。归一化放在读取处而不是改表，
 * 内置表才能保持逐字转录。
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
