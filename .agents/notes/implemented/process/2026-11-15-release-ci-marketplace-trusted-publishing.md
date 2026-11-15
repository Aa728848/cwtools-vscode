# Agent Note: 发布 CI 自动构建并发布到 VS Code 市场（Trusted Publishing）

Status: implemented

## Problem

发版此前是一条纯手工链路：本地 `package.ps1` 打出三平台自包含 VSIX，再由 `build/Program.fs` 的 `vsce publish`（交互式输入 token，或读 `vsce-token` 环境变量）推到市场，最后用 `gh release create` 发 GitHub Release。三个动作分散在不同工具里，容易只做一半——例如 Release 已经发出，市场仍停在上一版。

认证侧还有一条硬约束：那条 `vsce publish` 依赖 Azure DevOps 个人访问令牌。官方公告自 2026-12-01 起退役全局 PAT，并改为推荐 GitHub Actions 的 OIDC Trusted Publishing；把长期令牌继续放进仓库或本机脚本，等于在退役前夕再欠一次迁移。

仓库 CI 只有 `.github/workflows/ci.yml`（校验为主），没有任何发布作业。

## Decision

新增 `.github/workflows/release.yml`，把「打标签」变成唯一的发布动作：

1. **触发**：推送 `v*` 标签自动发布；同时提供 `workflow_dispatch`，输入已有标签即可重跑，`publish_marketplace` 布尔入参可关掉市场发布、只重建 VSIX 与 GitHub Release。并发组不取消正在进行的发布。
2. **运行环境**：`windows-latest`（与本地验证过的打包环境一致，win-x64 ReadyToRun 原生构建），超时 90 分钟。
3. **版本守卫**：标签必须匹配 `^v\d+\.\d+\.\d+$`，且与 `package.json`、`release/package.json` 的 `version` 完全一致，否则在任何上传之前失败。
4. **构建**：`npm ci` → `cd submodules/cwtools-mcp && npm ci && npm run build -w cwtools-shared` → `cd release && npm ci` → `package.ps1`（三个自包含 F# 服务端、tsc、Rollup、规则 zip、steamworks 原生依赖暂存、`vsce package`）。
   中间两步补的是此前只存在于本地预置状态的隐式前提：`cwtools-mcp` 的 `dist/` 被 gitignore，而 `package.ps1` 只在打包暂存阶段兜底构建，`tsc` 会先失败；`release/package-lock.json` 虽受版本控制，但 `package.ps1` 从不执行 `npm ci`，而 vsce 会用 `npm list --production` 校验该清单声明的运行时依赖闭包。
5. **门禁**：打包之后运行 `npm run check:release -- --skip-compile --skip-test`，因为它检查 webview bundle 与服务端二进制是否就位，必须在构建后执行。
6. **市场发布**：`npx --yes @vscode/vsce@4.1.1 publish --oidc --packagePath <vsix>`。仓库锁定的 vsce 3.6.0 不支持 `--oidc`，因此 CI 固定 4.1.1 仅承担上传；打包仍由 3.6.0 完成，避免本地与 CI 的打包行为分叉。
7. **留档**：VSIX 作为工作流产物上传，保留 14 天。
8. **GitHub Release**：先用 `gh release view` 判断是否已存在；已存在则 `gh release upload --clobber`，否则 `gh release create --verify-tag --notes-file`，说明取自 `release/CHANGELOG.md` 中该版本的区块。
9. **权限**：作业级 `contents: write`（创建 Release）与 `id-token: write`（换取市场短期凭据）。

一次性人工配置（只能由发布者属主完成）：在市场发布者管理页面为 `ForeverSkywalker` 创建 Trusted Publishing 策略，仓库属主 `Aa728848`、仓库 `cwtools-vscode`、workflow `release.yml`、environment 留空；私有仓库需在策略创建后 48 小时内跑一次工作流以激活。

## Alternatives considered

1. **PAT 放进 GitHub Secrets（`VSCE_PAT`）**：否决。全局 PAT 2026-12-01 退役，等于把迁移推迟一个月，还引入一条需要轮换的长期密钥。
2. **改用 Azure Pipelines + Microsoft Entra ID 托管标识**：否决。仓库其余 CI 全在 GitHub Actions，为一个发布作业再建一套外部队列与身份配置不划算。
3. **在 ubuntu runner 上交叉构建三平台**：否决。win-x64 ReadyToRun 交叉编译虽可行，但与已经验证过的 Windows 打包路径不一致，等于在发布链路上引入未验证变量。
4. **CI 用 vsce 4 重新打包（不传 `--packagePath`）**：否决。会与本地 3.6.0 的打包结果分叉，还要把 154 MB 的包再打一遍。
5. **保留本地 `gh release create` 为主流程、CI 只发市场**：否决。同一份 VSIX 要构建两次，且「打标签即发布」的目标落空。

## Consequences

- 打一次标签即可同时完成市场发布、GitHub Release 与产物留档；失败可从 Actions 页面重跑，不必移动标签。
- 版本守卫让「忘记 bump 版本」在发布前失败，而不是在市场上产生错误版本。
- 发布顺序为市场优先：市场失败时不会创建 Release，避免出现「Releases 有包、市场没有」的割裂状态。
- 市场已发过同一版本时重跑会被市场拒绝；此时勾掉 `publish_marketplace` 才能只刷新 Release。
- 本地 `package.ps1 -Publish` 与 `build/Program.fs` 的 `publishToGallery` 保留为回退路径，不再是主流程。
- 后续若改工作流文件名或引入 environment，必须同步更新发布者页面上的 Trusted Publishing 策略，否则 OIDC 交换会被拒绝。
- 单次发布预计占用 Windows runner 20–40 分钟（三个自包含 .NET 发布是主要耗时）。
- 首次冒烟运行（`v2.36.0`，市场侧因版本已存在而被拒）证实链路可用：版本守卫、工作区构建、打包、门禁、OIDC 换取凭据、产物留档全部通过；`ci.yml` 仍因缺少 `cwtools-shared` 构建步骤而红，属于同一既有缺口，未在本次改动范围内。
