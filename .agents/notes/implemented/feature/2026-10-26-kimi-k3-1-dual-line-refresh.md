# Agent Note: Kimi K3.1 双线模型与线路协议刷新

Status: implemented

## Problem

Kimi 在 2026-10-26 前发布 K3.1 Pro 与高速版，开放平台的 `kimi-k2.5` 已经下线。当前项目的
`kimi` 与 `kimi-code-plan` 仍分别以 K3 和 `kimi-for-coding` 为默认模型，且内置清单继续提供
K2.5，旧配置会把失效 id 直接发给上游。

线路对照还暴露出几类互相放大的问题：订阅兜底目录把全部模型都当成 1M；实时目录没有真正
驱动模型选择；目录的输入上限与思考声明没有进入设置和请求；两条 Kimi 线路仍发 legacy
`max_tokens`，官方国际区域名不在 usage 能力范围内。参考项目
`dsh-chatgpt-subscription/src/host/kimi-code/` 有可借鉴实现，但其套餐元数据、协议支持和
部分模型声明不能与官方文档混为一谈。

官方证据采用 [模型列表](https://platform.kimi.com/docs/models.md)、
[K3.1 Pro 快速开始](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart.md)、
[官方价格](https://platform.kimi.com/docs/pricing/chat) 以及 Kimi Code 的
[kosong Kimi provider](https://github.com/MoonshotAI/kimi-code/blob/main/packages/kosong/src/providers/kimi.ts)
和 [reasoning-key](https://github.com/MoonshotAI/kimi-code/blob/main/packages/kosong/src/providers/reasoning-key.ts)。

## Decision

### 模型、窗口与价格

- `kimi` 默认改为 `kimi-k3.1-pro`，新增 `kimi-k3.1-pro-highspeed`；只从该线路的内置选项
  移除 K2.5，K2.6/K2.7 和其他供应商的兼容条目保持原样。
- `kimi-code-plan` 默认改为 `k3.1-pro`，新增 `k3.1-pro-highspeed`，保留 K3、K3-256K 和
  `kimi-for-coding(-highspeed)`。账号目录不含默认模型时才回落到目录提供的模型。
- 开放平台 K3.1 按官方声明使用 1M 窗口、视觉、始终思考、`low/high/max`（默认 `max`）和
  131072 默认输出预算，不显式发送固定采样参数。订阅静态元数据按用户指定的参考实现：
  普通 Pro 默认 256K（1M 是可解锁上限）、高速版 1M，二者默认输出均为 32768。
- 官方价格按 MTok 记为 Pro 输入/输出 ¥13/¥68、高速版 ¥26/¥136；缓存命中比例分别是
  0.1 和 0.05，不能因命中价同为 ¥1.30 而共用一个比例。

### 实时目录与思考能力

- `kimi/catalog.ts` 的随包表改为逐模型窗口和能力，实时目录真正驱动订阅模型清单。
  解析 `limit.context/input`、`think_efforts`、`reasoning_options` 与
  `supports_thinking_type`；输入预算取窗口和输入上限的较小值。
- 目录显式 `no` 才覆盖成无思考；空档位不臆造 `high`、fixed 或 toggle，而是安全回落到
  静态能力。目录提供档位但未给默认值时继承该模型的静态默认值，因此 K3.1 不会从
  `max` 被悄悄降为 `high`。
- 设置页、快捷档位切换和 `chatCompletion` 使用同一目录解析结果。目录独有的有效档位
  原样进入 `reasoning_effort`，不再被静态规则二次映射；目录失败时记录带模型名和错误
  详情的 debug 后回退静态能力。

### 请求协议与迁移

- 两条 Kimi 线路的全部模型统一发送 `max_completion_tokens`，显式 `maxTokens` 仍优先；
  其他供应商的 `max_tokens` 行为不变。开放平台和订阅的默认值各取本线路能力表，不把
  订阅的 32768 强抬为开放平台的 131072。
- 复用已有 reasoning 三键检测与 `message.reasoning_key` 回写，不另建全局 dialect。
  K3.1 在两条线都保留每条 assistant 的 reasoning 字段；Kimi 的空正文工具调用省略
  `content`，普通文本消息保留。usage 接受顶层和 `choices[0].usage`，缓存数量不重复累加，
  官方 `api.moonshot.ai` 与 `api.kimi.ai` 也启用相应能力。
- 保留 `for-coding` 的 `thinking.keep: "all"`，并修复实际内置 id `kimi-for-coding`
  因规则只匹配缩短名而未命中该字段的问题。
- K2.5 迁移只在 `provider === 'kimi'` 且 id 精确匹配时执行，目标为 `kimi-k3.1-pro`。
  主模型、快速切换、inline、翻译和 orchestrator 指派都在读取有效配置时迁移，不写回用户
  文件；兼容档位保留，K3.1 不可关闭思考，因此 `none` 映射为 `low`。

### 回归覆盖

新增/更新目录解析、模型元数据、价格、快捷档位、请求装配、usage、缓存区域和迁移测试。
测试使用真实公开方法与真实请求装配，覆盖目录失败、未知动态模型、实际 `kimi-for-coding`
id 以及非 Kimi 线路不回归。

## Alternatives considered

1. **两条线都继续旧默认或都改用稳定别名**：未采用。用户明确选择两条线默认都升至 K3.1 Pro；
   `kimi-for-coding` 仍保留为可选项。
2. **保留 K2.5 等上游报错，或读取配置时直接写盘迁移**：未采用。前者必失败，后者在只读
   `getConfig` 中制造副作用；采用无写回的有效配置迁移。
3. **把参考项目的 Anthropic、视频存储、bytes/token 折算和响应头缓存分层全部搬入**：未采用。
   本次确认的是高价值 OpenAI 兼容对齐，不引入新协议和部署耦合。
4. **全部模型/线路统一 1M 或 131072**：未采用。模型能力、套餐窗口和输出预算必须分线路，
   否则会把本地预算变成上游硬失败。
5. **另写一套全局 reasoning 方言管理**：未采用。现有按消息保存 `reasoning_key` 的机制
   已覆盖三种键，重复实现只会增加跨供应商污染面。
6. **空目录声明也推断一个 high 开关**：未采用。没有依据的档位可能直接被上游拒绝，安全
   回退比发明能力更可靠。

## Consequences

- 新配置和未显式选型的用户默认进入 K3.1 Pro；已有 K2.5 配置在内存中自动落到继任模型，
  但磁盘里的旧值不会被擅自重写。
- 实时目录能驱动模型、输入预算和推理档位，账号之间仍按现有缓存与号池边界隔离；目录不可
  读不会阻断聊天，且回退可诊断。
- Kimi 的 OpenAI 兼容请求与官方字段保持一致，其它供应商不做连带变化。未新增 Anthropic
  Messages 或视频协议。
- 本次验证使用 mock transport 与真实请求装配，未使用真实 Kimi 订阅或开放平台账号做端到端
  调用；真实套餐可用模型仍以账号实时目录为准。
