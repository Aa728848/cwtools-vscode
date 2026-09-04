# Agent Note: Backend LSP Review Closure and Hygiene Convergence

Status: implemented

## Problem
在后端与 LSP 协议层审查文档（`docs/backend-lsp-review-handover.md`）的排查中，发现如下悬挂问题与代码卫生隐患：
1. **测试盲区**：`LanguageServer.fs:242-248` 中的 `responseAgent` 超时处理（`Expire` -> 答复 `null`）缺乏专门的自动化回归测试，行为未锁定。
2. **边缘切片越界风险**：`src/Main/Tokenizer.fs:65-69` 在跳过首字节空白时直接取 `byteLength - 1`，当文件内容为极端单字符或全空白时存在潜在切片越界/截断风险。
3. **微模块碎片**：`PureDecisions.fs` 仅约 20 行，仅声明了 `computeChangeType` 和 `validateResponseTimeout`，却作为一个独立的源文件被引入 `CWTools.Main.fsproj`，增加了模块碎裂程度。
4. **冗余重复逻辑**：`LanguageServer.fs` 内部局部重复定义了 `normalizePath` 等小工具函数。
5. **深水区未裁决**：审查文档中提及的深水区议题（递归深度限制 20 层、23 处 `match json` 模式匹配、跨平台路径大小写）缺乏明确的架构裁决，导致交接文档长期处于“未闭环”状态。

## Decision
1. **补齐并发与超时回归测试**：
   - 新建 `src/Main/test_response_agent_timeout.fsx`，针对 `LanguageServer.fs` 的 `responseAgent` 进行并发调度、正常结果投递与超时过期（返回 `null`）测试，验证全部 5 个测试用例通过。
   - 将其正式纳入 `npm run test:fsx` 测试集合，使全仓 `.fsx` 回归测试达到 29 项且 100% 通过。
2. **修复 Tokenizer 截断边界**：
   - 调整 `src/Main/Tokenizer.fs` 针对首字节为空白时的切片逻辑，消除 `byteLength - 1` 潜在截断隐患。
3. **消除微模块并入内聚**：
   - 将 `PureDecisions.fs` 中的纯函数内聚移动到 `LanguageServer.fs` 顶部，物理删除 `PureDecisions.fs` 并在 `src/Main/CWTools.Main.fsproj` 中移除该编译项，提升代码局部内聚性。
4. **统一 Helper 引用**：
   - 统一使用规范的路径与参数解析辅助函数，清除 `LanguageServer.fs` 中的冗余重复实现。
5. **深水区明确结项与裁决**：
   - 递归深度限制（深度 ≥20 返回空）作为防御恶意超深 AST 的安全熔断机制，具备工程合理性，予以保留。
   - 23 处 `match json` 属于各 LSP 指令与 MCP 参数的直接类型模式匹配，具备充分的静态检查与测试覆盖，不进行过度抽象。
   - 跨平台路径比较保持当前的 `Platform.isWindows` 分支处理。
   - 在 `docs/backend-lsp-review-handover.md` 顶端写入全案结项声明，正式归档。

## Alternatives considered
- **备选方案 1：为全仓 23 处 `match json` 构建通用的泛型解包反序列化框架**。
  - *未采纳原因*：这 23 处模式匹配分布在各个具体的 LSP 命令分发分支，各自结构差异大。强行引入通用动态反射或泛型反序列化层不仅增加运行时代价和心智负担，更容易在未覆盖的分支引入隐蔽 regression。保持明确的模式匹配更符合 F# 惯例且零抽象开销。
- **备选方案 2：保留 `PureDecisions.fs` 并继续向其迁移其他逻辑**。
  - *未采纳原因*：这些函数仅供 `LanguageServer.fs` 的消息循环使用，与领域核心规则无关联。单独建立微小文件反而在 IDE 和项目配置中增加了寻址成本，内聚在主文件中更为清晰。
- **备选方案 3：不修复 Tokenizer 首字节空白跳过逻辑**。
  - *未采纳原因*：虽然真实游戏文件中极少遇到单空白字符文件，但作为语言服务器需要应对编辑器中实时的任意输入。及早修复边界截断能够避免偶发的非预期异常。

## Consequences
- **收益**：
  - 后端 F# 工程与前端 TypeScript 工程全部编译通过，0 警告 0 错误。
  - `npm run test:fsx` 29/29 项回归测试全部 PASS。
  - `LanguageServer.fs` 职责更加内聚清晰，超时逻辑得到长效自动化测试保护。
  - 历史 LSP 审查遗留议题彻底清零并闭环结项。
- **权衡与后续约束**：
  - AST 序列化深度上限仍受 20 层限制，未来若支持更复杂的嵌套语法树时需关注该硬编码阈值。
