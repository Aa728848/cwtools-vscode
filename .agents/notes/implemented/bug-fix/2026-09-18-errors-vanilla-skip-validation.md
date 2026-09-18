# Agent Note: errors.vanilla 设置语义落地——vanilla 文件不校验、不发布诊断

Status: implemented

## Problem

用户反馈设置 `stellarisLanguageServices.errors.vanilla`（文案「是否显示原版文件的错误」，默认 `false`）「不起作用」，且启动时状态栏长时间停留在 `CWTools: Validating files... (151/1605)`，校验数千个文件很慢。

事实核查确认该设置并非未接线，而是语义错位：

1. 链路完整存在：客户端整节同步（`extension.ts` `configurationSection: 'stellarisLanguageServices'`）→ `Program.fs` `didChangeConfiguration` 解析 `errors.vanilla` → `validateVanilla` → `GameLoader.fs` `ValidationSettings` → 上游 `Game.fs`。
2. 但 `validateVanilla=false` 的唯一实际效果是把 `scope="vanilla"` 实体的 `validate` 标志置 `false`，该标志只抑制文件内解析错误（CW001）；后台全量校验循环（`Program.fs` `startFullWorkspaceBackgroundValidation`，对 `game.AllFiles()` 按 30 个一批跑 `ValidateFilesLocalCancellable`）与诊断发布过滤器（`diagnosticFilter`）都不检查 vanilla 来源。
3. 于是 vanilla 安装目录约 4500 个文件（151 批 × 30）照常被全量校验并发布诊断——用户看到的就是设置完全无效且启动缓慢。

## Decision

让设置兑现其文案语义：`false`（默认）时 vanilla 文件不参与后台全量校验、不发布任何诊断；`true` 时维持原行为。vanilla 的索引、引用解析与 Compare with Vanilla 不受影响。改动全部在主仓库，未动子模块：

1. **纯函数判定**（`src/LSP/PathIdentity.fs`）：新增 `isUnderRootFor platform path root` / `isUnderRoot`，目录边界前缀匹配（先统一斜杠方向，大小写规则随平台），空 root 不匹配任何路径。vanilla 身份必须按路径判定——缓存资源的 scope 会被改写为 `embedded`，不能依赖 `scope = "vanilla"`。
2. **门禁谓词**（`Program.fs` `normaliseCachePath` 旁）：`isVanillaFilePath` 对 `vanillaPathMap`（9 个游戏的 vanilla 路径设置）逐一判定；`shouldSkipVanillaFile = not validateVanilla && not isVanillaFolder && isVanillaFilePath`（工作区本身就是游戏目录时绝不过滤）。
3. **校验侧**：后台循环只对过滤后的 `validationFileEntries` 分批预热校验（`fileEntries` 本身保留 vanilla，供发布循环清理旧状态），并输出一条跳过数量的 `logDiag`；初始加载的 `priorityFilePaths`（打开的文件优先校验）同样过滤。
4. **发布侧双保险**：`diagnosticFilter` 增加 vanilla 条款（覆盖 `sendDiagnostics` 与初始诊断）；`publishFileDiagnostics` 收口点对 vanilla 文件改写为空数组发布——保证同一会话内早前发布的 vanilla 诊断被客户端清除，跨文件发布路径也被覆盖。
5. **状态清理**：后台发布循环遇到被门禁的 vanilla 文件时，发布空诊断清掉非空旧诊断、`removeFileDiagnosticState` 移除跟踪、`diagnosticInvalidation.Delete` 移除 admission 状态，避免悬挂 pending admission 影响日后重新开启设置。
6. **文案三语同步**（`release/package.nls.json` / `zh` / `zh-cn`）：说明新语义「默认关闭：后台校验跳过原版文件，且不显示其诊断」。

## Alternatives considered

- **仅在客户端 `handleDiagnostics` 按路径丢弃 vanilla 诊断**：只遮 UI，不解决校验耗时，否决。
- **改 cwtools 子模块让 `ValidateFilesLocalCancellable` / `CachedResourceInput` 尊重 `validate` 标志**：防线更深，但需在子模块独立提交再 bump 指针；本轮在主仓库校验循环入口过滤即可获得绝大部分收益，子模块加固留作后续，否决本轮混入。
- **客户端把 `errors.vanilla` 映射到 `isVanillaFolder`**：`isVanillaFolder=true` 会让 `GameLoader` 跳过 vanilla 缓存加载，索引与引用解析退化，有害，否决。
- **新增独立设置（如 `validation.skipVanilla`）**：两个键语义重叠且用户仍需发现新键；现有键的文案本来就是此承诺，直接重定义，否决新键。
- **从 `fileEntries` 移除 vanilla 后让发布循环不触碰它们**：早前会话/开启状态下发布的 vanilla 诊断会残留在客户端，故保留遍历并显式清理，否决。

## Consequences

- 默认配置下后台校验批次从约 151 批（约 4500 个文件，绝大部分为 vanilla）降到仅 mod 文件的个位数批次，启动期 CPU/锁占用显著下降；vanilla 文件不再出现在 Problems 面板。
- `validateVanilla=true` 时行为与原实现逐字节一致；维护者做 vanilla 基线校验时手动开启即可。
- 缓存预热不再覆盖 vanilla 文件：vanilla 文件无需交互校验，可接受；索引与引用解析照常。
- 设置切换走既有 `updateIfChanged`/`requiresReload` 通道，重载后按新语义执行并清理旧诊断。
- 回归覆盖：`src/Main/PathIdentity.Tests.fsx` 新增 15 个 `isUnderRootFor` 用例（Windows/Unix 大小写、斜杠方向、兄弟前缀、空 root、null 拒绝）。
- 已知边界：vanilla 判定依赖 vanilla 路径设置；未配置路径但缓存存在时（罕见）vanilla 文件不会被过滤，行为退化为原状而非出错。子模块级 `validate` 贯通是后续加固项。
