# Agent Note: CWTools 子模块发布工作流的 SDK 版本对齐

Status: implemented

## Problem
`submodules/cwtools` 是独立的 F# 规则内核仓库，拥有自己的 GitHub Actions 流水线。其中测试流水线 `.github/workflows/test.yml` 已经使用 `dotnet-version: 10.0.x`，但发布流水线 `.github/workflows/release.yml` 仍停留在 `dotnet-version: 9.0.x`，而该仓库**全部工程**（`CWTools`、`CWToolsCLI`、`CWToolsTests`、`CWToolsPerformanceCLI`、`CWToolsScripts`、`CWToolsDocs`，以及作为 `build.sh` 入口的 `build/build.fsproj`）的目标框架都是 `net10.0`。

两者不一致导致发布流水线必然失败，本地以 SDK 9.0.312 复现的报错为：

```text
error NETSDK1045: 当前 .NET SDK 不支持面向 .NET 10.0。请面向 .NET 9.0 或更低版本，或者使用支持 .NET 10 的 SDK。
```

该缺陷之所以长期未暴露，是因为 `release.yml` 由 `workflow_dispatch` 手动触发，不在 PR 门禁路径上，而 `test.yml` 的门禁只覆盖测试流水线。

## Decision
将 `.github/workflows/release.yml` 中 `actions/setup-dotnet` 的 `dotnet-version` 由 `9.0.x` 改为 `10.0.x`，与工程目标框架以及同仓库 `test.yml` 的取值对齐。两个工作流现在使用同一 SDK 版本线。

## Alternatives considered
1. **把工程目标框架回退到 `net9.0`**：
   - *未采纳原因*：目标框架升级是刻意的库能力演进（`.NET 10` 提供了更新的运行时与 FSharp.Core 10.1.301），为迁就一条滞后的流水线配置而回退全仓库目标框架属于本末倒置，且会波及父仓库 `src/Main`、`src/LSP` 的构建基线。
2. **在 `build/build.fsproj` 中通过多目标框架或条件属性兼容 SDK 9**：
   - *未采纳原因*：FAKE 构建脚本自身也是 `net10.0`，在 SDK 9 下连构建脚本都无法编译，不存在只降级子工程的可维护路径。
3. **让 `release.yml` 复用 `test.yml` 的工作流或新增共享的 reusable workflow**：
   - *未采纳原因*：两个工作流的触发方式（push/PR vs 手动 dispatch）、产物（测试结论 vs NuGet 包与 GitHub Release）和权限需求都不同，此处仅一行版本漂移，不值得引入工作流重构。

## Consequences
- 发布流水线恢复可执行：SDK 10 具备 `net10.0` 目标框架的构建能力，`build.sh PackTools` 与 `ReleaseGitHub` 不再因 `NETSDK1045` 中断。
- 子模块内部两个工作流的 SDK 版本不再漂移，后续升级 `.NET` 时只需改动两处且取值必然一致。
- 本次变更不触及任何运行时代码，仅调整 CI 配置；父仓库通过 `submodules/cwtools` 指针同步获得该修复。
