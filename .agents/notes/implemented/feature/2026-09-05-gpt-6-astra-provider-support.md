# Agent Note: 增加 GPT-6 Astra 模型支持与参数契约适配

Status: implemented

## Problem
OpenAI API 与 ChatGPT Codex 订阅渠道目录此前均未提供 `gpt-6-astra` 模型选项。现有的模型属性匹配遗漏了该模型的图像视觉输入能力与上限配置，且 Responses API 推理档位映射错误地将原生的 `max` 降级为了 `xhigh`。

## Decision
1. **接入模型目录与属性声明**：在保留现有默认模型的前提下，向两个目录同时添加 Astra。注册其图像输入支持、API 模式下的 1,050,000 Token 上下文窗口、128,000 Token 输出上限，以及从 `low` 到 `max` 的全套推理档位控制。
2. **推理与采样参数适配**：显式降低思考档位的请求映射为 `low`；根据模型规范自动省略采样温度（temperature）；保持原有的 Responses 路由与 OAuth 端点隔离机制。
3. **Token 定价表更新**：录入标准 API Token 定价（输入每百万 Token $10 / 输出每百万 Token $50），沿用汇率（6.82 CNY）及 10% 缓存输入折扣比例。

参考来源：[官方模型技术规范](https://developers.openai.com/api/docs/models/gpt-6-astra) 及 [模型接入指引](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)。

## Alternatives considered
- **仅在下拉菜单添加一个名字**：否决。会导致错误的推理档位映射、非法的温度参数、错误的输出上限和失真的缓存计费。
- **直接替换现有默认模型**：否决。不可在未明确要求的情况下更改现有用户的模型选择和调用成本。
- **将 API 上下文直接套用于订阅请求**：否决。Codex 订阅渠道存在 272,000 Token 的服务硬限制，Astra 在该渠道应继承该限制。

## Consequences
- 两个 Provider 的模型选择器及 OAuth 账号状态均可正常使用 Astra。
- 回归测试覆盖目录可用性、Provider 专属上下文上限、推理档位控制、请求路由与温度省略、以及定价查询。
- 编译、类型检查与全量单元测试（2,287 个单元测试 + 35 个规则同步测试）全部通过。
