# Agent Note: Antigravity 工具传输采用标准 JSON Schema

Status: implemented

## Problem
Antigravity 渠道在接收完整的 CWTools 工具列表时拒绝了请求并报错 HTTP 400：函数声明参数内出现 `Unknown name "propertyNames"`。原因是适配层此前通过 Google 的强类型 `parameters` 字段发送了完整的 JSON Schema，而旧有的元数据递归过滤不仅无法让该 Schema 与强类型解析器兼容，还会意外破坏或删除诸如 `$id` 等合法的属性名或字面量数据。

## Decision
1. 将 Antigravity 函数声明切换为使用 `parametersJsonSchema` 字段，遵循 Google Gemini CLI 工具和 Code Assist 官方请求路径标准。
2. Antigravity 请求载荷中完整保留原始 Schema，包括 `propertyNames` 约束、联合类型、引用（references）、元数据及字面量默认值。
3. 彻底移除原先有损的递归元数据过滤器。其他 Provider 的传输协议格式以及标准工具定义保持不变。

参考实现：[Google Gemini CLI tool schemas](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/tools.ts) 与 [Code Assist request conversion](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/converter.ts)。

## Alternatives considered
- **仅剔除 `propertyNames` 字段**：否决。这会丢失校验约束，且无法解决 JSON Schema 其他关键字暴露给 typed Schema parser 时引发的潜在报错。
- **维护一套有损的 JSON Schema 到 typed Schema 转换器**：否决。上游既已原生支持 `parametersJsonSchema`，额外维护转换器会带来持续的关键字兼容与引用处理负担。
- **直接修改共享的工具定义**：否决。会削弱本地运行时以及其他 Provider 的校验契约，并波及独立维护的 MCP schema。

## Consequences
- 该 Provider 每个工具稳定输出一个完整的 JSON Schema 字段，且不会篡改底层工具目录。
- 回归测试通过 AIService 针对 Antigravity 上的 Gemini 与 Claude 完整模拟了最终 HTTP 请求，覆盖所有内置工具、蓝图 schema 以及包含嵌套引用、联合类型、`propertyNames` 和关键字属性的外部复杂 schema，成功复现并验证修复了原有的 400 异常。
