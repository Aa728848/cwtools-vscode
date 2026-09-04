# Agent Note: FSX Test Runner and TestHelpers Scaffolding

Status: implemented

## Problem
在后端 F# 代码库中，长期存在着一批以 `.fsx` 脚本形式存在的针对性回归测试，但面临以下工程化痛点：
1. **脚手架冗余散乱**：每个 `.fsx` 脚本都在头部自行编写加载程序集、引用外部依赖和定义断言逻辑的代码，版本不一。
2. **缺乏全自动化门禁**：没有统一的自动化测试调度器，测试需要开发者在各个脚本目录下手动逐个调用 `dotnet fsi` 执行，导致脚本测试实际上脱离了日常验证流程。
3. **偶发失败难以阻断**：部分脚本即使内部逻辑异常也未严格抛出非 0 退出码，存在静默假绿风险。

## Decision
1. **建立统一脚手架 `TestHelpers.fsx`**：
   - 抽象通用测试初始化、程序集加载、彩色断言结果打印及异常捕获工具，供所有 `.fsx` 脚本统一引用。
2. **构建统一运行器 `tools/run-all-fsx-tests.cjs`**：
   - 采用 Node.js 实现跨平台的自动化测试调度器，自动检索全仓 `.fsx` 脚本，逐个调用 `dotnet fsi` 执行，并在任何单个测试失败时立刻记录详细错误并最终返回非 0 退出码。
3. **集成统一 NPM 命令**：
   - 在 `package.json` 中注册 `npm run test:fsx`，将其确立为核心回归门禁之一。

## Alternatives considered
- **将所有 `.fsx` 彻底重写并迁移为 xUnit/NUnit 编译型测试工程**：
  - *未采纳原因*：这批脚本针对特定文件解析器、LSP 局部交互等场景，具备快速独立验证和零编译负担的优势；强行全量重构成测试工程不仅耗时巨大，而且会增加构建依赖树的复杂度。
- **使用平台特定的 Bash/PowerShell 脚本调度**：
  - *未采纳原因*：Bash 在 Windows 下需要额外环境，PowerShell 在 Linux/macOS CI 下配置繁琐；Node.js 运行器具备天然的跨平台一致性。

## Consequences
- 成功激活并统一纳管了 28+ 项核心 F# 功能测试脚本。
- 为后端的持续重构提供了即时、低成本、高确定性的回归防线。
