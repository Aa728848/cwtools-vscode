# Agent Note: 规范化 Antigravity Pro 模型别名并在 Chat 列表中过滤编辑器模型

Status: implemented

## Problem
Antigravity 模型动态发现机制此前将运行时的内部 Pro 别名和仅供编辑器使用的 Tab 补全 ID 直接暴露在 Chat 模型选择器中。如果直接过滤后端 Pro ID，可能导致账号仅有的 Pro 入口被误删；而仅根据 Tab 模型名称无法确定其是否与现有 FIM（Fill-In-the-Middle）代码补全接口兼容。

## Decision
1. **模型别名规范化与过滤**：在去重之前，将 Gemini 3.1 Pro 运行时别名统一规范化，并过滤所有以 `chat_` 和 `tab_` 开头的内部条目。
2. **统一配置项名称**：AI 配置中心在保存所选模型时对外暴露规范的 Pro 命名。运行时推理分档（reasoning mapping）保持原有逻辑。
3. **空目录回退保护**：当账号有效但没有可用的 Chat 模型时保持为空，不再盲目回退到硬编码的默认广告目录。
4. **测试与文档解耦**：原生 Tab 补全协议调研与编辑器集成在独立笔记 `../feature/2026-09-06-antigravity-tab-editing.md` 及 `docs/antigravity-tab-protocol.md` 中记录。
5. **回归测试覆盖**：覆盖仅含别名发现、去重机制、内部及 Tab 过滤、纯编辑器账号目录、以及 Provider 作用域内的选中模型规范化。

## Alternatives considered
- **直接丢弃 `gemini-pro-agent` 且不作映射**：否决。当后端仅返回该运行时 ID 时，会导致账号丢失 Pro 模型的可用选项。
- **依据 HTTP 200 响应盲目开启 FIM 补全**：否决。实际请求会返回未转义代码、后缀回显或错误预测，暴露出未经校验的兼容契约。
- **使用通用 Chat Prompt 进行代码补全**：否决。语义和框架校验不达标，应采用后续验证过的原生补全协议。

## Consequences
- Chat 列表清晰展示单一的 Pro 选项，隐藏内部编辑器专用模型，同时完整保留基于思考档位的模型路由能力。
- Tab 代码补全与 Chat 目录彻底解耦，无需引入任何额外运行时依赖。
