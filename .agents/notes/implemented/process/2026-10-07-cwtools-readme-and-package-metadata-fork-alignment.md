# Agent Note: CWTools README 与 NuGet 发布元数据对齐 fork 归属

Status: implemented

## Problem
`submodules/cwtools` 是 fork（Aa728848/cwtools）维护并发布的独立仓库，但对外发布元数据仍全部指向上游作者 tboby，且 README 第 3 行声明 `targets .net standard 2.0`——该声明自 `9ba27862 feat: migrate project structure to .NET 10.0` 起即为虚假信息：全仓 8 个工程中 7 个是 net10.0，仅 `Shared/Shared.fsproj` 是 netstandard2.0。声明 netstandard2.0 意味着「几乎任何宿主都能引用」，而实际 .NET 8/9 使用者装不上，会把外部使用者挡在第一道门；nuspec/fsproj 中的主页、许可证与图标 URL 指向上游，则让 fork 发布的 NuGet 包在 NuGet.org 上显示他人主页。

## Decision
子模块提交 `f83f4326`（`docs: align README and NuGet package metadata with Aa728848 fork`）：

- `README.md:3`：改为如实声明 targets .net 10.0，并注明仅 Shared 工程为 netstandard2.0；`README.md:5` 贡献链接指向 fork。
- `CWToolsCLI/cwtoolscli.nuspec`：projectUrl / licenseUrl → `Aa728848/cwtools`，iconUrl → `Aa728848/cwtools-vscode`。
- `CWToolsCLI/CWToolsCLI.fsproj`：PackageIconUrl / PackageLicenseUrl / RepositoryUrl 同步指向 fork；**`Authors` 保持 `tboby` 不动**——Authors 是代码署名事实，发布者身份由 NuGet 账号决定，不由该字段决定。

验证除 `dotnet build cwtools.slnx`（0 错误）外，直接执行了 FAKE 打包链实际调用的 `dotnet pack` 并**解包 nupkg 读取真实发布的 .nuspec**，逐字确认 URL 指向 fork。

本次查明但**未改动**的既有事实（记录备查）：

1. `cwtoolscli.nuspec` 是死模板：fsproj 无 `NuspecFile` 引用、FAKE 脚本不消费它，发布的包实际**没有 projectUrl**。要让包带上主页需在 fsproj 加 `<PackageProjectUrl>`。
2. 发布流水线 `PackTools` 处于基线断裂状态：前置目标 `CheckFormat`（全仓 fantomas 漂移）卡死 Test→PackLibs→PackTools 整条链；且非发版上下文的兜底版本号 `LocalBuild` 不是合法 semver，即便格式修好本地 `PackTools` 仍会失败。
3. 打包存在既有弃用警告 NU5125（licenseUrl → 应改 license 表达式）与 NU5048（PackageIconUrl → 应改内嵌 PackageIcon）。

## Alternatives considered
1. **连 `Authors` 也改成 fork 维护者**：未采纳。Authors 表述代码作者归属，fork 发布不转移著作权；发布者身份由推送包的 NuGet 账号体现。
2. **顺手迁移 NU5125/NU5048（license 表达式 + 内嵌图标）**：未采纳。属打包元数据格式迁移，超出「归属对齐」范围，且内嵌图标需要把 png 纳入包内并验证渲染，应独立决策。
3. **补 `<PackageProjectUrl>` 让包真有主页**：未采纳。nuspec 死模板与 fsproj 双轨并存是打包结构问题，与 CheckFormat 断裂、semver 兜底同属「发布流水线整修」议题，一并留给后续，不在文档对齐提交里夹带。
4. **同步修改 `CWToolsDocs/testconfig/cwtools-ir-config/README.md` 的 tboby wiki 链接**：未采纳。那是样例配置目录的说明文档，不属对外发布元数据。

## Consequences
- README 不再把 .NET 8/9 使用者误导进门；NuGet 包页 Repository 链接与图标指向 fork。
- nuspec 的改动当前是**惰性**的（模板无人消费），但消除了「两轨元数据内容互相矛盾」的隐患。
- 发布流水线整修（CheckFormat 漂移、`LocalBuild` semver、NU5125/NU5048、PackageProjectUrl）已成为明确的后续事项，与本笔记记录的事实一一对应。
