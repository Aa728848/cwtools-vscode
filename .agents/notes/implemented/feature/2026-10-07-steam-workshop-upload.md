# Agent Note: Steam 创意工坊 Mod 上传（扩展内 steamworks.js 实现）

Status: implemented

## Problem

用户希望在 VS Code 扩展内直接把当前 Mod 上传到 Steam 创意工坊（新建 + 更新），参考外部项目 stellaris-launcher（Rust）的上传实现。该启动器不使用任何 SDK 绑定库，而是手写 FFI 加载游戏目录的 `steam_api64.dll` 调扁平 C 导出（ISteamUGC：CreateItem → StartItemUpdate → Set* → SubmitItemUpdate，轮询 GetItemUpdateProgress），本功能以其流程与约定为蓝本，但按用户决策在扩展内用 Node 库重新实现，而非调用启动器 CLI。

仓库此前没有任何上传链路（upload/publish/steamcmd 全仓零命中），只有工坊路径检测（workshopDetection.ts）。

## Decision

- **库选型：steamworks.js@0.4.0（精确锁版，MIT，N-API）**。单 npm tarball 自带 win32-x64/linux-x64/darwin-x64/darwin-arm64 的 .node 与 Steam 重分发库（dist/{win64,linux64,osx}），universal VSIX 直接随包分发，无 postinstall 联网。N-API 的 ABI 稳定，规避了 VS Code 官方文档点名的「原生模块随宿主升级需重编译」问题。
- **薄适配层**：`client/extension/workshopUpload.ts` 的 `SteamUgcClient` 接口是唯一替换缝；`require('steamworks.js')` 全代码库唯一且只在真正上传时执行（lazy require）——该包 require 即 dlopen，不支持的平台直接 throw，绝不允许出现在激活路径上。`init(appId)` 显式传数字 appid，绝不调用 restartAppIfNecessary（会在扩展宿主里重启进程）。
- **上传流程**（对齐启动器蓝本）：createItem（仅无 remote_file_id 时）→ updateItemWithCallback（title/description/contentPath/previewPath/tags/visibility/changeNote 一次提交），进度回调映射 UpdateStatus 1..5 → preparingConfig/preparingContent/uploadingContent/uploadingPreview/committing。进程内单飞行互斥。
- **约定沿用启动器**：新建默认 Private；预览图取 descriptor `picture=` → thumbnail.png → thumbnail.jpg（<1MB）；新建成功后 `writeRemoteFileId` 回写 descriptor.mod（modDescriptor.ts，共享纯逻辑模块，从 ai/projectProfile.ts 提取）；needs_agreement 单独提示。与启动器不同：更新时也允许修改描述（用户决策）。
- **appid 决策链**：gameProfiles.ts 的 profile.install.steamAppId → 为 '0'/缺失时读设置项 `stellarisLanguageServices.workshop.appIdOverride` → 仍无则报错。所有已知游戏 profile 可用（用户决策，非仅 Stellaris）。
- **入口**：命令 `cwtools.workshop.upload`（命令面板 + editor/title，`cwtools.workspaceIsMod` 上下文键门控）+ 侧边栏视图 `cwtools.workshopUpload`（独立 activitybar 容器 `cwtools-workshop-panel`，图标 `$(cloud-upload)`——初版曾挂 cwtools-ai-panel 与 AI 聊天挤在一起，按用户反馈拆出）。宿主与 Webview 之间的消息协议（ready/prefill/pickPreview/previewPicked/upload/busy/progress/result）逐字固定；Webview 前端 `client/webview/workshopUpload.ts` 无 Node API、双语、主题变量。
- **更新预填**：descriptor 有 remote_file_id 时，`fetchExistingItemDetails` 通过适配层 `getItemDetails`（steamworks.js `getItem` + `includeLongDescription`）从工坊页面读回描述预填表单——描述是唯一只存在于 Steam、不在本地的字段；读取失败（Steam 未运行等）静默回退本地数据，不阻断表单。Steam API 会话按 appid 缓存（`getSteamworksSession`），避免同进程重复 init。
- **注册位置**：activate 顶层（registerImageTools 之后），不在 init() 内——init 可能被工坊 consent 门禁跳过。
- **打包**：本仓库扩展宿主无 bundler（纯 tsc CommonJS），external 天然成立；rollup（只管 webview）与 esbuild（仅 MCP opt-in）均加 external 防护；package.ps1 新增 4b 步把 node_modules/steamworks.js（连同 @types/node、undici-types 满足 vsce 的 npm list --production 校验）暂存进 release/，.vscodeignore 排除两个纯类型包。VSIX 实测 150.2MB 含 15 个 steamworks.js 文件。
- **Web 宿主降级**：release/package.json 当前无 browser 入口；上传逻辑仍先查 `vscode.env.uiKind === UIKind.Web` 并优雅拒绝，未来加 browser 入口无需改动。

## Alternatives considered

- **调用启动器 CLI（stl mod upload）**：零改动复用完整实现，但要求 mod 位于游戏 mod 目录且为 Local 类、无 description 支持、本机未安装启动器、输出非结构化；且用户明确选择在扩展内实现。
- **@node-3d/steam-api**：UGC API 最完整、维护最活跃，但 tarball 内无二进制（postinstall 联网下载，VSIX 需 vendor）、纯 ESM 与 engines 要求同扩展宿主 Node 版本不匹配、项目过新（单维护者、构建不可复现）、需自写回调泵。作为换库 Plan B 保留。
- **greenworks / node-steamworks**：NAN 绑定（ABI 锁死 Electron）且完全没有现代 ISteamUGC 更新 API（源码实测无 StartItemUpdate/SetItemTitle/SubmitItemUpdate 等），只有 NW.js 预编译包。排除。
- **启动器常驻 + 本地 HTTP/IPC**：灵活但两边都要加服务端/客户端代码，复杂度最高，且启动器无任何 server 代码。排除。

## Consequences

- **收益**：用户在扩展内一站式完成工坊新建/更新；三平台 universal VSIX 无需分平台发包；协议与适配层使未来换库成本局限于单文件。
- **已知风险与换库触发条件**：steamworks.js 维护停滞（npm 停在 2024-08，issue #199 求接手）；上传 bug #197（error 5）未修复——适配层已做错误码可读化，若实测命中则先尝试不设 preview 缩小失败面；缺 KV tag / fileType / deleteItem，若后续需要这些能力即为换库硬触发条件。
- **后续约束**：`release-extension` 流程依赖 package.ps1 4b 步暂存 node_modules/steamworks.js，打包前必须先 npm install；不要为省体积裁剪 dist/ 平台目录（通用包全平台是刻意选择）。steamworks.js 把 @types/node 声明为生产依赖，若其范围从 "*" 收紧会导致 vsce 的 npm list 校验失败。
- **测试状态**：modDescriptor 18 例单测全绿；Webview 前端经仓库外一次性 DOM 垫片 14 项行为检查；宿主侧为代码审查级正确性（本机无 Steam 登录态，未做真实上传），首次真实上传需人工验证。
