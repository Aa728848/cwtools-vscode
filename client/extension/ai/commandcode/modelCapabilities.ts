/**
 * Command Code 的**逐模型能力表**。
 *
 * 转录自官方 CLI 自己的模型注册表——那是「哪些模型接受图片输入、各自暴露哪些思考档位」的唯一
 * 权威来源。公开的 `/provider/v1/models` 目录只带 id、显示名与上下文长度，对模态与思考档位**什么
 * 都不说**。
 *
 * **按厂商/模型名前缀推断是不行的**：同一厂商内部就会自相矛盾——实测
 * `deepseek/deepseek-v4-flash` 纯文本，而 `deepseek/deepseek-v4.1-flash` 与
 * `deepseek/deepseek-v4-flash-vision-exp` 接受图片；`z-ai/glm-5.3-flash` 接受图片而
 * `zai-org/GLM-5.3` 不接受。因此能力按**精确 id 查表**，未知 id 回落到纯文本 + 无档位。
 *
 * 转录的是**整张表**，不是「有人用过的那几项」：表里没有的 id 不是「未知」，而是「没有图片、
 * 没有思考档位」——一个真实模型漏在这里就会静默失去图片输入与档位选择器。
 *
 * 注册表的 `off` 档**不逐字带出**：Command Code 把「不思考」写成一个叫 `off` 的档位，而 DSH
 * 把同一件事写成 `none`。翻译发生在 `commandCodeReasoningEfforts`，因此下面的表保持对来源的
 * 忠实转录、把 `off` 留在注册表放它的地方。两个方向都不该发原生的 `off`：OpenAI 族线协议没有
 * 这个档位，所以它在请求构造时被丢弃（`commandCodeWireEffort`）。
 */

export interface CommandCodeModelDef {
    id: string;
    name: string;
    /** 接受的输入模态，与注册表声明的一致。 */
    inputModalities: Array<'text' | 'image'>;
    /** 可选思考档位；该模型不暴露档位时为空。 */
    reasoningEfforts: string[];
    /** 注册表声明的上下文窗口；未声明为 null。 */
    contextWindow: number | null;
    /** 注册表声明的输出上限；未声明为 null。 */
    maxTokens: number | null;
}

/** DSH 用来表示「尽量少思考」的档位名，与 Kimi / Claude 线路一致。 */
export const COMMAND_CODE_DISABLED_EFFORT = 'none';

/** Command Code 注册表描述的每个模型，按注册表顺序。 */
export const COMMAND_CODE_MODELS: readonly CommandCodeModelDef[] = [
    {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 200000,
        maxTokens: null,
    },
    {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxTokens: null,
    },
    {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxTokens: null,
    },
    {
        id: 'gpt-6-sol',
        name: 'GPT-6 Sol',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxTokens: null,
    },
    {
        id: 'gpt-6-luna',
        name: 'GPT-6 Luna',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxTokens: null,
    },
    {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxTokens: null,
    },
    {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxTokens: null,
    },
    {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1050000,
        maxTokens: null,
    },
    {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 400000,
        maxTokens: null,
    },
    {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 400000,
        maxTokens: null,
    },
    {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 400000,
        maxTokens: null,
    },
    {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 400000,
        maxTokens: null,
    },
    {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro (latest)',
        inputModalities: ['text'],
        reasoningEfforts: ['off', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash (latest)',
        inputModalities: ['text'],
        reasoningEfforts: ['off', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'deepseek/deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision (exp)',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['off', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'deepseek/deepseek-v4-flash-fast',
        name: 'DeepSeek V4 Flash Fast',
        inputModalities: ['text'],
        reasoningEfforts: ['low', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'deepseek/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['off', 'low', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'deepseek/deepseek-v4.1-flash-fast',
        name: 'DeepSeek V4.1 Flash Fast',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['off', 'low', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'moonshotai/Kimi-K3',
        name: 'Kimi K3',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'moonshotai/Kimi-K2.7-Code',
        name: 'Kimi K2.7 Code',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 256000,
        maxTokens: null,
    },
    {
        id: 'moonshotai/Kimi-K2.7-Code-Highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 262000,
        maxTokens: null,
    },
    {
        id: 'moonshotai/Kimi-K2.6',
        name: 'Kimi K2.6',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 256000,
        maxTokens: null,
    },
    {
        id: 'moonshotai/Kimi-K2.5',
        name: 'Kimi K2.5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 256000,
        maxTokens: null,
    },
    {
        id: 'z-ai/glm-5.3-flash',
        name: 'GLM-5.3 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'high', 'max'],
        contextWindow: 1048576,
        maxTokens: 131072,
    },
    {
        id: 'z-ai/glm-5.3-flashx',
        name: 'GLM-5.3 FlashX',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: 131072,
    },
    {
        id: 'zai-org/GLM-5.3',
        name: 'GLM-5.3',
        inputModalities: ['text'],
        reasoningEfforts: ['low', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'zai-org/GLM-5.2',
        name: 'GLM-5.2',
        inputModalities: ['text'],
        reasoningEfforts: ['high', 'max'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'zai-org/GLM-5.2-Fast',
        name: 'GLM-5.2 Fast',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'zai-org/GLM-5.1',
        name: 'GLM-5.1',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 200000,
        maxTokens: null,
    },
    {
        id: 'zai-org/GLM-5',
        name: 'GLM-5',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 200000,
        maxTokens: null,
    },
    {
        id: 'MiniMaxAI/MiniMax-M3',
        name: 'MiniMax M3',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'MiniMaxAI/MiniMax-M2.7',
        name: 'MiniMax M2.7',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 200000,
        maxTokens: null,
    },
    {
        id: 'MiniMaxAI/MiniMax-M2.5',
        name: 'MiniMax M2.5',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 200000,
        maxTokens: null,
    },
    {
        id: 'xiaomi/mimo-v2.6-pro',
        name: 'MiMo V2.6 Pro',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'xiaomi/mimo-v2.6-pro-ultraspeed',
        name: 'MiMo V2.6 Pro UltraSpeed',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'xiaomi/mimo-v2.6-flash',
        name: 'MiMo V2.6 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'xiaomi/mimo-v2.5-pro',
        name: 'MiMo V2.5 Pro',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'xiaomi/mimo-v2.5',
        name: 'MiMo V2.5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.8-Omni-Flash',
        name: 'Qwen 3.8 Omni Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'xhigh'],
        contextWindow: 1000000,
        maxTokens: 131072,
    },
    {
        id: 'Qwen/Qwen3.8-Max-0902',
        name: 'Qwen 3.8 Max 0902',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'xhigh'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.8-Max',
        name: 'Qwen 3.8 Max',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'xhigh'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.8-27B',
        name: 'Qwen 3.8 27B',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'xhigh'],
        contextWindow: 262144,
        maxTokens: 32768,
    },
    {
        id: 'Qwen/Qwen3.8-Flash',
        name: 'Qwen 3.8 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'xhigh'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.7-Max',
        name: 'Qwen 3.7 Max',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.7-Plus',
        name: 'Qwen 3.7 Plus',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.7-Flash',
        name: 'Qwen 3.7 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.6-Max-Preview',
        name: 'Qwen 3.6 Max Preview',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 200000,
        maxTokens: null,
    },
    {
        id: 'Qwen/Qwen3.6-Plus',
        name: 'Qwen 3.6 Plus',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 200000,
        maxTokens: null,
    },
    {
        id: 'meituan/LongCat-2.0',
        name: 'LongCat 2.0',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'stepfun/Step-5-Preview',
        name: 'Step 5 Preview',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'stepfun/Step-3.7-Flash',
        name: 'Step 3.7 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 256000,
        maxTokens: null,
    },
    {
        id: 'stepfun/Step-3.5-Flash',
        name: 'Step 3.5 Flash',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 262144,
        maxTokens: null,
    },
    {
        id: 'tencent/hy3-paid',
        name: 'Tencent Hy3',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 262144,
        maxTokens: null,
    },
    {
        id: 'tencent/hy4-preview',
        name: 'Tencent Hy4 Preview',
        inputModalities: ['text'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'google/gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'google/gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'google/gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'google/gemini-3.5-flash',
        name: 'Gemini 3.5 Flash',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'google/gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash Lite',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'google/gemini-3.1-flash-lite',
        name: 'Gemini 3.1 Flash Lite',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'sakana/fugu-ultra',
        name: 'Fugu Ultra',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['high', 'xhigh'],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'nvidia/nemotron-3-ultra-550b-a55b',
        name: 'Nemotron 3 Ultra',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'thinkingmachines/inkling',
        name: 'Inkling',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 256000,
        maxTokens: null,
    },
    {
        id: 'thinkingmachines/inkling-small',
        name: 'Inkling Small',
        inputModalities: ['text', 'image'],
        reasoningEfforts: [],
        contextWindow: 1000000,
        maxTokens: null,
    },
    {
        id: 'stealth/space-bunny-alpha',
        name: 'Space Bunny Alpha',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'max'],
        contextWindow: 1000000,
        maxTokens: 524288,
    },
    {
        id: 'poolside/laguna-s-2.1-free',
        name: 'Laguna S 2.1',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 256000,
        maxTokens: 32768,
    },
    {
        id: 'inclusionai/ling-3.0-flash-sante:free',
        name: 'Ling 3.0 Flash Sante',
        inputModalities: ['text'],
        reasoningEfforts: [],
        contextWindow: 262144,
        maxTokens: 32768,
    },
    {
        id: 'inclusionai/ling-3.1-flash:free',
        name: 'Ling 3.1 Flash',
        inputModalities: ['text'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 262144,
        maxTokens: 32768,
    },
    {
        id: 'meta/muse-spark-1.1',
        name: 'Muse Spark 1.1',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'meta/muse-spark-1.2',
        name: 'Muse Spark 1.2',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'meta/muse-spark-1.2-contributor',
        name: 'Muse Spark 1.2 Contributor',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'meta/muse-spark-1.3',
        name: 'Muse Spark 1.3',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'meta/muse-spark-1.3-contributor',
        name: 'Muse Spark 1.3 Contributor',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 1048576,
        maxTokens: null,
    },
    {
        id: 'xai/grok-4.5',
        name: 'Grok 4.5',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 500000,
        maxTokens: null,
    },
    {
        id: 'xai/grok-4.6',
        name: 'Grok 4.6',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 500000,
        maxTokens: null,
    },
    {
        id: 'xai/grok-4.7',
        name: 'Grok 4.7',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 500000,
        maxTokens: null,
    },
];

const COMMAND_CODE_BY_ID = new Map(COMMAND_CODE_MODELS.map(model => [model.id, model]));

/**
 * 免费档后缀。
 *
 * 公开目录与注册表对**同一个模型**的拼写不一致：目录列出
 * `meituan/LongCat-2.0:free`，而注册表写成 `meituan/LongCat-2.0`。两者是同一个模型，
 * `:free` 只是计费档后缀。查表时精确匹配优先，**未命中才**剥掉该后缀再查——否则用户在
 * 选择器里挑中那个 id 时会静默失去图片输入与思考档位，而现场没有任何线索指向原因。
 */
const COMMAND_CODE_FREE_SUFFIX = ':free';

/**
 * 某个模型 id 的注册表条目；未描述该模型时返回 undefined。
 *
 * 精确 id 优先；未命中时按免费档后缀重试一次（见 {@link COMMAND_CODE_FREE_SUFFIX}）。
 */
export function commandCodeModelDef(modelId: string): CommandCodeModelDef | undefined {
    const trimmed = modelId.trim();
    const exact = COMMAND_CODE_BY_ID.get(trimmed);
    if (exact !== undefined) return exact;
    if (trimmed.endsWith(COMMAND_CODE_FREE_SUFFIX)) {
        return COMMAND_CODE_BY_ID.get(trimmed.slice(0, -COMMAND_CODE_FREE_SUFFIX.length));
    }
    return undefined;
}

/**
 * 某个模型可选的思考档位，已把注册表的 `off` 翻译成 DSH 的 `none`。
 *
 * 两种拼写都接受（存储的选择或别处开始的会话可能带任一种），但本线路**只对外声明 `none`**，
 * 所以选择器显示的是 DSH 能理解的档位。
 */
export function commandCodeReasoningEfforts(modelId: string): string[] {
    const declared = commandCodeModelDef(modelId)?.reasoningEfforts ?? [];
    return declared.map(effort => (effort === 'off' ? COMMAND_CODE_DISABLED_EFFORT : effort));
}

/**
 * 某个档位是否会上到供给方线协议。
 *
 * `none` 是真实的 DSH 档位但**不是** Command Code 的档位：它由**省略该字段**表达，这正是官方
 * CLI 在其档位为 `off` 时所做的事。本线路声明的其余档位原样通过。
 */
export function commandCodeWireEffort(effort: string | undefined | null): string | undefined {
    if (effort === undefined || effort === null) return undefined;
    const value = String(effort).trim();
    if (value === '' || value === COMMAND_CODE_DISABLED_EFFORT || value === 'off') return undefined;
    return value;
}

/**
 * 某个模型接受的输入模态。
 *
 * 未知模型回落到**纯文本**：DSH 会把「不支持图片」变成一个用户可以换模型纠正的可见占位，而
 * 「支持图片」的错误会把字节发给一个拒绝整个请求的端点。
 */
export function commandCodeInputModalities(modelId: string): Array<'text' | 'image'> {
    return [...(commandCodeModelDef(modelId)?.inputModalities ?? ['text'])];
}

/** 某个模型是否接受图片输入（精确 id 查表）。 */
export function commandCodeModelSupportsImage(modelId: string): boolean {
    return commandCodeInputModalities(modelId).includes('image');
}
