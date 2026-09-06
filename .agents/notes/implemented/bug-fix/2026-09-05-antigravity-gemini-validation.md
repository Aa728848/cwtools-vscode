# Agent Note: Antigravity 渠道 Gemini 请求校验与错误诊断改进

Status: implemented

## Problem
在请求路由与工具调用续接过程中，Gemini 3.8 Flash 出现 HTTP 400 校验错误。原因是 Antigravity 适配层在分级 Gemini 3.7/3.8 运行时中，对于“禁用/极简思考”（disabled/minimal thinking）发送了上游不接受的 `MINIMAL` 思考档位；此外，在回放 Gemini 函数调用时保留了上游生成的 ID，但在函数执行结果（function response）中却遗漏了这些 ID；而在发生 HTTP 错误时，原有逻辑直接丢弃了上游返回的具体校验错误信息。

## Decision
1. 在分级运行时上，将“禁用/极简思考”映射为 `LOW`，同时对于禁用思考模式保持 `includeThoughts: false`。
2. 在工具执行结果中透传回显原生的 function-call ID，对于较早版本无 ID 的 Gemini 响应则避免传递本地生成的伪 ID。
3. 保持带签名的回放分块（signed replay parts）以及现有的 Claude 适配行为不变。
4. 引入有界、可取消的错误响应体读取机制：设置 5 秒诊断读取超时限制、16 KiB 读取上限、1,500 字符错误消息截断，并对敏感的 access token 进行脱敏保护；即使诊断读取失败，也会保留原始 HTTP 状态码并附加对应原因。

参考规范：Google Gemini 3.8 指南文档：https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash。

## Alternatives considered
- **对所有 400 响应盲目重试**：否决。这会重复发送无效载荷，掩盖确定性的校验失败。
- **剥离所有 function-call ID 或思考签名**：否决。会丢失工具调用连续性所必需的原生回放上下文字段。
- **向所有请求发送本地伪造的 ID**：否决。会导致上游没有 call ID 的旧版 Gemini 历史记录格式发生非预期改变。
- **直接透传展示全部未截断的错误响应体**：否决。会导致错误输出无界膨胀，并带来敏感凭据泄漏风险。

## Consequences
- 请求路由和工具执行结果严格遵循模型支持的思考档位与 ID 匹配规则。
- 错误信息在可用时完整包含上游返回的校验诊断明细，同时保持端点故障转移（failover）与 OAuth token 一次性刷新的状态码触发机制不变。
- 回归测试覆盖了分级别名、带与不带原生 ID 的并行调用、签名回放、诊断截断限制、Token 脱敏、请求取消及其它 Provider 分支。
