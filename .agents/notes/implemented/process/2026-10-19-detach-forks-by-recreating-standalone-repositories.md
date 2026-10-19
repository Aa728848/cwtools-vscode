# Agent Note: 以同名删除重建完成三个仓库脱离 fork 网络

Status: implemented

## Problem

主仓库 `cwtools-vscode` 与两个子模块仓库 `submodules/cwtools`、`submodules/cwtools-stellaris-config` 都是 `cwtools` 组织同名仓库的 fork。前序笔记 `2026-09-11-detach-forks-and-drop-gitee-mirror.md` 只完成了本地远端收口，GitHub 侧始终没有落地，三个仓库仍是 fork 网络成员。

本轮的三条硬约束决定了可用路径：

1. GitHub 自助「Leave fork network」要求仓库 public、体积小于 1 GB 且**没有任何子 fork**；主仓库挂着一个外部子 fork `cowcat-box/cwtools-vscode`，入口被禁用。
2. 无论自助入口还是 Support 工单，都**不保留** issues、PR、wiki、star、watcher 等元数据。
3. 主仓库有 132 个 Release、约 18 GB 的 `.vsix` 资产只存在于 GitHub，删库即永久丢失。

属主的决策：放弃全部 Release（两个子仓库连 tag 一并放弃），**同名删除重建，从零重新开始**。

## Decision

四个仓库分两类处理：`cwtools-mcp` 本来就是独立仓库，不参与删除重建。

| 仓库 | 处理 | 结果 |
| --- | --- | --- |
| `Aa728848/cwtools-vscode` | 删除后同名重建 | 32 分支 + 161 tag ref，无 Release |
| `Aa728848/cwtools` | 删除后同名重建 | 36 分支，无 tag、无 Release |
| `Aa728848/cwtools-stellaris-config` | 删除后同名重建 | 11 分支，无 tag、无 Release |
| `Aa728848/cwtools-mcp` | 仅更新 LICENSE | 本来就是独立仓库 |

执行顺序：

1. **备份**：三个仓库各做 `git clone --mirror` 到 `C:/Users/A/Documents/_repo-detach-backup`，并导出 132 条 Release 元数据 JSON；`git fsck` 校验无损坏。
2. **删除**：`delete_repo` scope 不在 `gh` 令牌内，由属主在网页 Danger Zone 逐个删除（同名 URL 不变）。
3. **重建**：`gh repo create Aa728848/<name> --public`，不初始化 README / LICENSE / .gitignore，保证回灌时无冲突。
4. **回灌**：从 mirror 直接 `git push <url> "refs/heads/*:refs/heads/*"`；主仓库额外推送 `refs/tags/*`，两个子仓库按决策不推 tag。
5. **恢复仓库设置**：默认分支（根 `main`、两个子仓库 `master`）、描述、`has_issues` / `has_wiki` / `has_projects` 开关、合并策略，并重新邀请协作者 `Koishi-Satori`。
6. **更新许可**：5 个 LICENSE 文件统一采用「保留上游原署名 + 追加 `Copyright (c) 2026 EDDYCRAZY-CC`」的双署名结构，主仓库 LICENSE 额外列出四个衍生来源；子仓库先提交推送，再回推主仓库 gitlink 指针。
7. **本地收口**：移除三个仓库残留的 `upstream` 远程，本地只剩单一 `origin`。

`.gitmodules`、三个子模块 gitlink、以及全部 `Aa728848/*` 链接引用均未改动，因此 URL、父子仓库关系与发布链路保持原样。

## Alternatives considered

1. **GitHub Support 工单原地解除**：否决。官方文档明示 issues / star 等元数据照样丢失，18 GB Release 是否保留没有书面保证，且工单需要排队；胜出的方案对元数据损失可控且可验证。
2. **自助 Leave fork network**：不可行。主仓库被外部子 fork 阻断，需要先让第三方删 fork 或由 Support 介入，且同样丢失元数据。
3. **改名到新仓库并批量改链接**：否决。项目内 60 余处 `Aa728848/*` 引用，其中 `updateChecker.ts`、`gameProfiles.ts`、`package.ps1`、`release/package.json` 处在运行时与发布链路上；改地址会引入大面积回归，也不符合「父子仓库关系保持不变」的前提。
4. **保留 fork 现状**：否决。属主明确要求三个仓库成为独立仓库。

## Consequences

- 三个仓库现在都是独立仓库：`fork: false`、`parent: null`，不再出现在 `cwtools` 的 fork 网络里，也不会再显示 "forked from" 标记。
- **Release 清零是可见影响**：`client/extension/updateChecker.ts` 请求的 `/releases/latest` 在发布新版本前会 404，README 与 `docs/marketplace-readme.md` 的 Releases 下载链接同样 404。发布下一个版本后自动恢复，无需改代码。
- 已丢失且不可恢复：主仓库 17 个 star、issue #6（`Compare with vanilla command not working`）、外部子 fork；`cwtools-stellaris-config` 的 1 个 star；两个 Gitee 遗留 Actions 密钥 `GITEE_PRIVATE_KEY` / `GITEE_TOKEN`（`ci.yml` 未引用，属于废弃项）。
- 两个子仓库的 tag 已丢弃。本地克隆仍保留 24 / 28 个 tag，需要时执行 `git push origin --tags` 即可恢复。
- 完整备份保留在 `C:/Users/A/Documents/_repo-detach-backup`，确认无误后可整目录删除。
- 父子仓库关系不受影响：`.gitmodules` 与 gitlink 未变，`git submodule update --init --recursive` 仍正常。
- 重新邀请的协作者需要 `Koishi-Satori` 自行接受，否则不会出现在协作者列表中。

## 关联

- 前序与已取代的路径评估：`2026-09-11-detach-forks-and-drop-gitee-mirror.md`
- 许可文本：`LICENSE.md`、`release/LICENSE.md`、`submodules/cwtools/LICENSE`、`submodules/cwtools-stellaris-config/LICENSE`、`submodules/cwtools-mcp/LICENSE.md`
