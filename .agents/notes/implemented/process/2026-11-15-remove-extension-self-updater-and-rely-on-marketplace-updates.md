# Agent Note: 移除扩展自建自动更新，统一改用市场更新

Status: implemented

## Problem

扩展在激活时会自行请求 GitHub 的 `releases/latest`，发现新版本后下载 VSIX 并用 VS Code CLI（`code --install-extension --force`）安装，目的是给「从 Releases 下载 VSIX」的用户提供一条升级路径。这条链路完全绕开市场：

- 每次激活都要访问 `api.github.com`，网络受限环境下要付出查询 5 秒、下载 10 秒的超时代价，虽然放在后台但仍是常驻的失败面。
- 下载与安装跑在扩展自己的进程里：同版本覆盖安装必须先停掉 F# 语言服务再调用外部 CLI，而 CLI 探测要覆盖 Code / Code Insiders / Codium / Codium Insiders / Code OSS 以及 Windows、macOS、Linux 的不同安装布局，属于长期维护负担。
- 版本比较、忽略状态与「已知 VSIX 资产时间戳」散落在 `globalState` 的多个键中，与市场自身的升级判断构成两套真相。

扩展本身通过 `vsce publish` 发布到 VS Code Marketplace，检查更新、下载与安装已经由 VS Code 负责。

## Decision

1. 删除 `client/extension/updateChecker.ts` 与 `client/test/unit/updateChecker.test.ts`。随之一并移除 GitHub Releases 查询、VSIX 资产选择（`selectReleaseVsixAsset` / `extractVsixVersion`）、下载器、`workbench.extensions.installExtension` 与 `code --install-extension --force` 两条安装路径，以及 `beforeInstall` 钩子。
2. `client/extension/extension.ts` 的激活流程不再调用 `checkForUpdates`，也不再为同版本重装去停止语言服务；`ai/messages.ts` 中的 `SOURCE.UPDATE_CHECKER` 一并删除。
3. 发布清单删除用户设置 `stellarisLanguageServices.checkForUpdates`，`package.nls.json`、`package.nls.zh.json`、`package.nls.zh-cn.json` 同步删除对应描述。用户设置里遗留的该键由 VS Code 忽略，不做迁移。
4. GitHub Releases 继续发布挂载 VSIX 的版本，作为离线与手动安装渠道；扩展不再主动提示或代装升级，`package.ps1` 的发布流程保持不变。
5. README 双语安装章节各补一句：市场安装随 VS Code 自动更新，`.vsix` 安装需要重新下载新版本再装。
6. `client/test/unit/updatePolicy.test.ts` 守住下线面：发布清单不得再出现该设置、三份 NLS 不得再出现对应描述、`updateChecker.ts` 不得回归、激活流程不得再引用 `checkForUpdates`。

## Alternatives considered

1. **保留检查，只把「立即更新」改成跳转市场页面**：否决。VS Code 已经内置扩展更新提示与自动更新，再叠一层自定义提示只会重复打扰，同时仍要维护 `/releases/latest` 请求与版本比较代码。
2. **只对 VSIX 安装路径保留自更新，市场安装跳过**：否决。可靠判断安装来源没有公开契约（`extensionPath` 形态与扩展元数据都不是稳定 API），判定失败会让市场用户被要求手动重装，比彻底删除更容易出错。
3. **保留设置项但默认值改为 `false`**：否决。留一个默认关闭的开关等于把死代码、跨平台 CLI 探测与三份 NLS 文案长期留在发布产物里。
4. **改用 `vscode.extensions` 或 `workbench.extensions.action.*` 命令触发市场更新**：否决。VS Code 没有提供「检查并安装指定扩展更新」的稳定 API，能做的只是再发一条提示，而该提示已被市场覆盖。

## Consequences

- 用户侧：升级路径只剩市场自动更新，或手动重新下载 VSIX。从 Releases 安装的用户不再收到扩展内提示，README 已说明这一差异。
- 激活开销：激活期不再有 GitHub 请求、进度通知与临时 VSIX 文件，网络受限环境下少一处超时等待与告警。
- 发布侧：`release/package.json` 少一项配置，三份 NLS 各少一条键；`npm run check:release` 的 NLS 键完整性校验仍然通过。
- 后续约束：若将来需要「检查更新」类能力，应优先依赖市场 UI；重新引入自更新必须同时恢复设置项、NLS 文案、安装来源判断，并重新评估跨平台 CLI 探测成本。
