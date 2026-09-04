# Agent Note: Cross-Platform Path Injection Security and DocumentStore Offsets

Status: implemented

## Problem
在跨平台安全性、CI 兼容性与基础文档结构处理中，存在三项技术隐患与缺陷：
1. **上游 CWT 规则路径注入越权隐患**：在上游内核 `submodules/cwtools` 的 `CwtProjectIndex.fs:tryResolveInjectSource` 中，未能有效拦截 Windows 盘符根（如 `C:\`）与 UNC 局域网网络路径（如 `\\server\share`），恶意 CWT 规则可能构造特殊路径突破沙箱读取宿主系统文件。
2. **跨平台单元测试路径解析失效**：`configuredGameRoots.ts` 在检测多平台用户目录时直接调用 Node.js 的环境宿主 `path` 模块；在 Linux/macOS 环境下运行模拟 Windows 路径的单测时，由于分隔符不同造成解析失真，导致 CI 测试偶发失败。
3. **FSI 下 `buildLineOffsets` 索引计算异常**：`DocumentStore.fs` 中的行偏移表生成逻辑 `buildLineOffsets` 使用 `for i = 0 to text.Length - 1 do`，在特定 F# Interactive 运行环境中，`text.Length - 1` 的减法与索引类型推断偶发溢出或不匹配。

## Decision
1. **在上游严格防御跨平台注入攻击**：
   - 在 `submodules/cwtools` 中提交 `10146930`，针对注入源路径加入显式安全断言，跨平台全量拦截并拒绝 Windows 盘符根与 UNC 路径。
   - 主仓将子模块指针升级至包含该安全补丁的版本（提交 `d8aea563`）。
2. **抽象平台感知的路径工具 `pathApi`**：
   - 在 `configuredGameRoots.ts` 中根据传入的模拟平台参数动态选取 `path.win32` 或 `path.posix`，并在单测中统一切换，确保无论在何种操作系统上运行测试，路径解析行为均具备可预测性。
3. **将行偏移量计算重写为显式 While 循环**：
   - 在 `src/LSP/DocumentStore.fs` 中将循环迭代统一重构为显式的 `let mutable i = 0; while i < textLen do ...; i <- i + 1`，彻底消除语法糖循环在不同编译器环境下的推断异构。

## Alternatives considered
- **仅在主仓层对 CWT 注入路径进行字符串清洗**：
  - *未采纳原因*：`cwtools` 作为底层 F# 引擎，在 CLI、其他编辑器或直接集成场景下都会独立运行；安全边界必须收紧在最底层的规则解析引擎本身。
- **使用正则表达式全局替换跨平台路径斜杠**：
  - *未采纳原因*：单纯替换反斜杠与正斜杠在面对带盘符的 Windows 路径和根路径时存在语义歧义；使用 Node 官方提供的 `path.win32` / `path.posix` 才是标准解法。

## Consequences
- 彻底消除了 CWT 规则可能携带的跨平台越权注入安全风险。
- 保证了跨平台 CI（GitHub Actions 的 Linux/macOS/Windows Runner）单测结果的绝对一致性。
- 增强了语言服务器底层文本行号偏移索引生成的确定性。
