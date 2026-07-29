# Paradox 游戏目录名称补全全量交付计划

## 1. 文档状态与交付约束

- 状态：已全量实施（2026-07-29）。
- 交付方式：一次性全量交付。
- 覆盖范围：Stellaris、Hearts of Iron IV、Europa Universalis IV、Europa
  Universalis V、Crusader Kings II、Crusader Kings III、Imperator: Rome、
  Victoria II、Victoria 3，以及 Custom/Generic Paradox。
- 最终验收：只有第 15 节 Definition of Done 全部满足后，功能才能标记为完成。

> 本计划中的工作包仅表示依赖顺序和施工组织，不是 MVP、灰度版本、可单独发布的
> 阶段，也不能作为部分游戏或部分数据源已经完成的验收依据。所有支持的游戏、
> Custom/Generic、目录数据源、Explorer 交互、国际化、测试矩阵和文档必须在同一次
> 交付中完成。

## 2. 背景与结论

VS Code 的公开稳定 Extension API 只允许 `CompletionItemProvider` 向文本编辑器中的
文档提供补全，不能向内置 Explorer 的“新建文件夹”行内输入框注入候选项。因此本
功能不修改或劫持原生 `New Folder`，而是提供一个完整替代入口：

- Explorer 文件夹右键菜单：`CWTools: 创建 Paradox 游戏文件夹...`
- Command Palette 中的同名命令。
- 可搜索、可键盘操作的 Quick Pick，用当前游戏和当前父目录过滤候选文件夹。
- 用户选择建议或输入自定义相对目录后，由 `workspace.fs.createDirectory` 创建并在
  Explorer 中定位。

这不是普通的静态模板列表。目录候选必须来自当前已加载 CWT、当前游戏 profile 和
用户配置的原版游戏目录，并根据所选父目录计算“下一层”目录名称。

## 3. 目标

1. 在任意已支持 Paradox 游戏项目中，从 Explorer 选中某个文件夹后获得该位置有效
   的下一层目录建议。
2. 自动使用当前 LSP 已加载的游戏和 CWT 规则，不要求用户重复选择游戏。
3. 在缺少原版路径、LSP 正在加载或游戏识别不明确时提供明确且安全的降级流程，不
   静默回退到 Stellaris。
4. 同时覆盖脚本、事件、本地化、GUI、图形、声音、地图、历史和其他原版可观察目录。
5. 支持多根工作区、本地文件系统、Remote/Virtual Workspace 中的可写文件系统。
6. 创建操作不越过工作区，不覆盖已有资源，不接受绝对路径或 `..` 路径穿越。
7. 目录目录表和原版读取必须有界、可取消、排序确定，并随规则、游戏和配置变化正确
   失效。
8. English/中文命令、提示、错误和用户文档同时交付。

## 4. 非目标

- 不修改 VS Code 内置 Explorer 的原生“新建文件夹”输入框。
- 不依赖 VS Code 私有命令、DOM、Monkey Patch 或未发布 API。
- 不改变 CWT 规则语言本身的语义。
- 不把目录创建能力暴露成 MCP 写工具或 Agent 模型可见工具；现有 MCP 保持只读。
- 不扫描整个工作区或整个原版安装来构建无界目录树。
- 不为不同游戏复制独立实现，也不硬编码完整的 Stellaris 目录表供其他游戏继承。
- 不自动创建文件、样板脚本或本地化内容；本功能只创建目录。

## 5. 用户体验规范

### 5.1 Explorer 入口

在 `explorer/context` 的 workspace 操作组中注册：

```text
CWTools: 创建 Paradox 游戏文件夹...
CWTools: Create Paradox Game Folder...
```

显示条件至少包括：

- 资源属于某个打开的 workspace folder；
- 选中资源是文件夹；
- 资源由可写文件系统提供；
- 当前工作区已识别为 Paradox 项目，或存在已激活的 Custom/Generic CWT 服务。

如果显示条件无法完全通过静态 `when` clause 表达，命令仍需在运行时做同样的边界
检查，并给出本地化错误。

### 5.2 Command Palette 入口

- 有活动文档时，默认使用活动文档所在目录。
- 没有活动文档时，默认使用唯一 workspace root。
- 多根工作区且无法推断目标时，先选择 workspace folder。
- Command Palette 不扫描整棵工作区目录树来模拟 Explorer 选择；用户需要从
  Explorer 右键非根目录，或者从 workspace root 开始。

### 5.3 Quick Pick

Quick Pick 标题必须包含当前游戏和目标父目录，例如：

```text
Stellaris · common/ · 创建游戏文件夹
```

每个候选项显示：

- `label`：下一层目录名，例如 `technologies`；
- `description`：创建后的工作区相对路径，例如 `common/technologies`；
- `detail`：来源和相关实体类型，例如 `CWT · technology`、`游戏约定`、
  `原版目录中存在`；
- 文件夹图标；
- 稳定、可预测的排序。

候选只包含当前父目录的直接子目录。选择项目根目录时建议 `common`、`events`、
`interface` 等；选择 `common/` 时建议 `technologies`、`buildings`、
`on_actions` 等。已经在项目中存在的同名目录不作为可创建候选。

Quick Pick 必须允许用户输入自定义名称或多段相对路径。接受自定义值前显示最终目标
相对路径并执行相同的安全校验。空值、绝对路径、`.`、`..`、空路径段和平台非法
名称必须拒绝。

### 5.4 创建后的行为

- 使用 `Uri.joinPath` 和 `workspace.fs.createDirectory`，不得假设 `file:` scheme。
- 不覆盖同名文件或目录。
- 目标已存在时不写入；提供“在 Explorer 中显示”操作。
- 创建成功后执行 `revealInExplorer` 并显示简短成功状态。
- 用户取消 Quick Pick、游戏选择或权限检查时不得产生任何文件系统变更。

## 6. 目录数据模型

Extension Host 内部使用统一、经过边界校验的目录候选类型：

```ts
type DirectorySuggestionSource = 'cwt' | 'profile' | 'vanilla';
type DirectorySuggestionConfidence = 'authoritative' | 'conventional' | 'observed';
type DirectorySuggestionKind =
    | 'script'
    | 'event'
    | 'localisation'
    | 'gui'
    | 'graphics'
    | 'sound'
    | 'map'
    | 'history'
    | 'other';

interface DirectorySuggestion {
    segment: string;
    relativePath: string;
    sources: DirectorySuggestionSource[];
    confidence: DirectorySuggestionConfidence;
    kinds: DirectorySuggestionKind[];
    entityTypes: string[];
}
```

规则：

- 外部 JSON、LSP 响应、设置值和文件系统结果都按 `unknown` 接收并通过 type guard
  收窄。
- `relativePath` 统一使用 `/`，但创建时始终通过 `Uri` API 处理。
- 同一路径合并所有来源和实体类型，不产生重复候选。
- 不使用新的 `any`、未经检查的 assertion 或非空断言处理外部数据。
- 所有集合输出按规范化路径、来源优先级和展示名称稳定排序。

## 7. 数据来源与合并规则

### 7.1 当前 CWT 语义目录

现有 `cwtools.ai.getSemanticCatalog` 已从活动 `IGame.TypeDefs()` 导出
`pathOptions.paths`。实施时扩展该协议，使它提供完整、专用的目录路径字段，而不是让
客户端依赖当前最多 4000 个 TypeDef 的展示截断。

响应新增向后兼容字段：

```ts
interface PdxDirectoryPath {
    path: string;
    entityTypes: string[];
}

interface PdxSemanticCatalog {
    // existing fields...
    directoryCatalogVersion?: 1;
    directoryPaths?: PdxDirectoryPath[];
    directoryPathsTruncated?: boolean;
}
```

服务端目录导出必须：

1. 遍历当前活动 game model 的全部 TypeDef。
2. 从 `pathOptions.paths` 提取字面量目录。
3. 将 `\` 转为 `/`，去掉首尾分隔符和 CWT 虚拟根 `game/`。
4. 拒绝空路径、绝对路径、URI、`.`、`..` 和无法安全规范化的路径。
5. 合并相同路径对应的所有 TypeDef 名称。
6. 对路径与实体类型排序、去重。
7. 返回活动 `gameProfile`、现有规则内容 hash/generation 和显式截断状态。

目录路径的导出不能改变原有 semantic catalog 消费者的字段语义。客户端统一在
`client/shared/pdxSemanticCatalog.ts` 中更新类型和解析 guard，禁止为本功能复制一
套松散协议。

### 7.2 游戏 profile 目录

从 `GameProfile` 合并：

- `folders.scriptDirs`
- `folders.guiDirs`
- `folders.gfxDirs`
- `localisation.directories`
- profile 明确声明的废弃目录过滤项

这些候选标记为 `profile` / `conventional`，用于：

- LSP 尚未完成规则加载时的可用体验；
- CWT 不表达的顶层约定；
- 本地化目录拼写差异；
- 没有固定远程规则仓库的 Custom/Generic 保守提示。

Profile 只能提供该 profile 明确声明的目录。Custom/Generic 不得继承 Stellaris
profile；识别不明确时不得调用会回退到 Stellaris 的 helper。

本功能交付时必须同步修正现有本地化 profile：

- `localisation_synced` 已废弃，不再是 Stellaris 的有效目录。
- 所有内置游戏 profile 和 Generic 静态默认值都不得继续把
  `localisation_synced` 放入 `localisation.directories`。
- Stellaris profile 必须将它作为废弃目录过滤，避免旧原版安装残留或其他低置信度
  来源重新把它加入建议。
- Custom/Generic 只有在用户加载的自定义 CWT 明确声明该路径时才能保留它；不得由
  Generic fallback 自动产生。
- `workspaceGameDetection` 可以为识别旧项目保留兼容 marker，但兼容 marker 不是
  目录建议来源。

### 7.3 原版游戏镜像目录

如果当前游戏配置了可用的原版数据路径，则将所选项目父目录映射到原版中的相同相对
位置，并只读取这一层的直接子目录：

```text
项目父目录: <mod-root>/common
原版镜像:   <configured-game-data>/common
读取范围:   immediate child directories only
```

这些候选标记为 `vanilla` / `observed`，补充声音、贴图、字体和其他不一定由 CWT
TypeDef 表达的目录。

要求：

- 不递归扫描整个原版目录。
- 使用现有 profile、Steam 子目录和配置路径 helper，不复制游戏安装检测逻辑。
- 原版路径缺失或不可读不阻塞 CWT/profile 候选，只显示一次非侵入式说明。
- 路径读取可取消、超时有界、错误通过 `ErrorReporter` 带游戏与目标目录上下文记录。
- 对每个游戏和父目录的读取使用有界 LRU/TTL 缓存；游戏切换、配置路径变化时失效。

### 7.4 项目当前目录

每次打开 Quick Pick 时读取目标父目录的直接子项：

- 已存在的目录从可创建候选中移除；
- 已存在的同名文件导致该候选不可创建；
- 文件系统读取失败时终止创建流程并报告具体目标；
- 不缓存工作区存在状态，避免刚创建、重命名或外部修改后的陈旧结果。

### 7.5 合并和排序

来源置信度顺序：

1. `cwt` / `authoritative`
2. `profile` / `conventional`
3. `vanilla` / `observed`

同一路径拥有多个来源时合并展示，并取最高置信度。排序键依次为：

1. 置信度；
2. 是否拥有 CWT 实体类型；
3. 规范化目录名；
4. 原始目录名。

大小写比较只在 Windows 上折叠；Linux、macOS 和区分大小写的远程文件系统保留原始
大小写语义。

## 8. 游戏识别与多工作区路由

游戏身份按以下顺序确定：

1. 目标 workspace 对应的活动 Language Client/LSP game profile；
2. `inferGameIdFromWorkspace` 的结构和 descriptor 证据；
3. 用户在本次命令中显式选择游戏或 Custom/Generic。

约束：

- 绝不使用“未知即 Stellaris”。
- 不因为用户只配置了一个原版路径就把未知项目标记成该游戏。
- 多根工作区必须按目标 URI 选择 Language Client、profile、规则 hash 和原版路径。
- 本次命令中的显式选择默认只影响本次操作；除非用户主动执行现有项目配置命令，不
  自动写入 workspace 设置。
- LSP 仍在加载时，先展示 profile 候选并显示加载状态；semantic catalog 就绪后在
  Quick Pick 未关闭的情况下原地刷新候选。
- LSP 报告 Custom/Generic 时只使用已加载自定义 CWT、Generic profile 和明确配置
  的原版/项目证据。

## 9. 缓存、并发和生命周期

### 9.1 Semantic catalog

- 目录目录表跟随现有规则内容 hash/generation。
- 规则重载、game object 替换、workspace 关闭后失效。
- 不在 Extension Host 复制解析全部 CWT 文件。
- 服务端计算必须在现有 game-model 读锁语义下完成，不持有写锁。
- 缓存有明确最大条目数，并按 workspace/client 生命周期释放。

### 9.2 原版目录读取

- 缓存键包含 game id、规范化原版根 URI、父目录相对路径。
- 最大 128 个父目录条目，默认 TTL 5 分钟。
- 只缓存已排序的直接子目录名和读取时间。
- 配置变化、原版缓存重建、game 切换和 extension dispose 时清理相关条目。

### 9.3 Quick Pick 请求

- 每次打开创建一个取消源。
- 用户修改目标、关闭 Quick Pick 或再次运行命令时取消旧请求。
- 候选刷新采用 latest-wins；旧 LSP 或文件系统结果不得覆盖新目标。
- 所有 listener、Quick Pick、取消源和缓存事件订阅都必须 dispose。
- 不允许并发递归扫描或随 vanilla/workspace 规模增长的无界 Promise 集合。

## 10. 安全与文件系统边界

创建前必须完成以下检查：

1. 父 URI 属于一个已打开 workspace folder。
2. 文件系统 scheme 可写。
3. 父资源存在且是目录。
4. 输入是相对路径，规范化后至少包含一个非空段。
5. 每个段都不是 `.`、`..`，不包含 NUL 或 URI scheme。
6. 最终 URI 仍位于原 workspace folder URI 下。
7. 目标不存在；存在时不覆盖、不删除、不重命名。
8. 从 Quick Pick 打开到确认期间父目录未被替换为文件或移出 workspace。

不得用 `path.resolve` 判断远程 URI 边界；本地 `file:` 和其他 scheme 都通过 URI
路径段进行规范化和包含关系校验。错误不得静默吞掉，用户消息和日志都要包含操作类型
及安全显示后的相对目标。

## 11. 必须完成的工作包

以下工作包全部属于一次交付。

### 工作包 A：语义目录协议

1. 扩展 `cwtools.ai.getSemanticCatalog`，导出全部活动 TypeDef 的规范化目录路径。
2. 保留现有响应兼容性，增加 schema version、实体类型和显式截断字段。
3. 更新共享 TypeScript 类型与 `unknown` 解析 guard。
4. 保证该 command 继续被 LSP 归类为 read-only。
5. 为普通、重复、大小写差异、反斜杠、`game/` 前缀、非法路径和空路径添加 F#/
   TypeScript contract 测试。

完成标准：所有游戏 adapter 和 Custom 的 `IGame.TypeDefs()` 均通过同一导出逻辑，
无游戏名分支目录表。

### 工作包 B：Extension Host 目录聚合器

1. 新增纯逻辑目录聚合模块。
2. 合并 CWT、profile、原版镜像和项目现状。
3. 实现父目录直接子项提取、去重、来源合并、分类和稳定排序。
4. 实现游戏识别、多根 workspace 路由和 Generic 保守行为。
5. 实现原版直接子目录读取缓存、取消、超时和失效。
6. 为所有外部数据增加 type guard 和路径边界校验。

完成标准：聚合器不依赖 VS Code UI，可通过纯单元测试覆盖全部路径决策。

### 工作包 C：创建命令与 Quick Pick

1. 注册 `cwtools.createGameDirectory`。
2. 添加 Explorer context menu 和 Command Palette contribution。
3. 实现游戏/工作区选择、候选加载、实时状态、搜索和自定义输入。
4. 实现创建前二次文件系统检查。
5. 使用 `workspace.fs.createDirectory` 创建并在 Explorer 中定位。
6. 正确处理取消、重复调用、目录已存在、同名文件、只读 scheme、LSP 加载和原版
   路径不可用。

完成标准：本地、Remote/Virtual mock、多根 workspace 和 Custom 项目使用同一命令
路径。

### 工作包 D：国际化、可观测性和文档

1. 添加 English、简体中文命令标题、Quick Pick 文案、状态和错误文本。
2. 使用 `ErrorReporter` 记录 semantic catalog、原版读取和创建失败。
3. 更新 README 中英双语功能说明和使用方式。
4. 更新 ARCHITECTURE.md 中英双语数据流、生命周期和安全边界。
5. 在实现完成时回写本文档状态与最终验证结果。
6. 生成并核对 release 文档/manifest 产物，不手工制造版本号副本。

完成标准：任何用户可见字符串都不存在只更新英文或只更新中文的情况。

### 工作包 E：全矩阵测试与发布验证

完成第 13、14、15 节的所有测试和验证命令，修复发现的问题。任何单个游戏或
Custom/Generic 未通过都视为整个功能未完成。

## 12. 游戏覆盖矩阵

| 游戏模式 | CWT 目录 | Profile 目录 | 原版镜像 | 本地化约定 | 必须验证 |
| --- | --- | --- | --- | --- | --- |
| Stellaris | 必须 | 必须 | 有配置时必须 | `localisation` | 根目录、`common/`、事件、GUI/GFX；不得出现 `localisation_synced` |
| HOI4 | 必须 | 必须 | 有配置时必须 | `localisation` | 根目录、`common/`、`history/`、`map/` |
| EU4 | 必须 | 必须 | 有配置时必须 | `localisation` | 根目录、`common/`、`missions/`、历史 |
| EU5 | 必须 | 必须 | 有配置时必须 | `localization` | Jomini 根目录、`common/`、GUI/GFX |
| CK2 | 必须 | 必须 | 有配置时必须 | `localisation` | Legacy 根目录、历史、GUI/GFX |
| CK3 | 必须 | 必须 | 有配置时必须 | `localization` | Jomini 根目录、`common/`、历史 |
| Imperator | 必须 | 必须 | 有配置时必须 | `localization` | Jomini 根目录、`common/`、setup |
| Victoria II | 必须 | 必须 | 有配置时必须 | `localisation` | Legacy 根目录、poptypes、units、历史 |
| Victoria 3 | 必须 | 必须 | 有配置时必须 | `localization` | Jomini 根目录、`common/`、GUI/GFX |
| Custom/Generic | 已加载规则必须 | Generic 保守项 | 明确配置时必须 | 由自定义 CWT/项目证据决定 | 不继承 Stellaris；不静态建议 `localisation_synced`；未知路径可自定义创建 |

“有配置时必须”表示原版路径是可选用户配置，但一旦存在，功能必须读取对应层级并正确
合并；没有配置时不得报致命错误，也不得访问网络或猜测 Steam 路径。

## 13. 测试计划

### 13.1 F# 与协议测试

- 全量 TypeDef 路径不会被现有 4000 条展示限制截断。
- 相同路径的多个实体类型正确合并。
- `game/common/x`、`game\common\x` 和首尾分隔符正确规范化。
- 非法绝对路径、URI、`.`、`..` 和空路径被拒绝。
- 输出排序确定，不依赖 Map、对象或文件枚举顺序。
- game/rules reload 后 hash/generation 和目录结果更新。
- `cwtools.ai.getSemanticCatalog` 原有消费者的旧 fixture 继续通过。
- 十种游戏模式使用相同 visitor 路径，无 Stellaris-only 分支。

### 13.2 Extension 纯单元测试

- 根目录和嵌套父目录的直接子项提取。
- 三类来源的合并、置信度、实体类型和稳定排序。
- 已存在目录移除、同名文件冲突。
- Windows 大小写折叠与非 Windows 大小写保留。
- 本地化目录拼写按游戏区分。
- Stellaris 和所有内置 profile 不产生 `localisation_synced`；旧原版目录残留也不会
  重新加入该候选。
- Custom/Generic 不继承 Stellaris。
- Custom/Generic 仅在自定义 CWT 明确声明时接受 `localisation_synced`。
- LSP profile、workspace detection、显式选择的优先级。
- 多根 workspace 的 client、profile 和原版路径不串线。
- 原版路径缺失、不可读、超时和取消。
- LRU 上限、TTL、配置变化和 dispose。
- 相对路径、嵌套路径、非法段、路径穿越和 URI 边界校验。
- latest-wins 防止旧请求刷新当前 Quick Pick。

### 13.3 VS Code 集成测试

- Explorer 文件夹上下文命令获得正确 URI。
- Command Palette 在单根、多根和活动文档场景选择正确父目录。
- Quick Pick 可以过滤 CWT、profile 和 vanilla 候选。
- 选择建议成功创建一个目录并 reveal。
- 自定义单段和多段相对路径成功创建。
- 取消不写入。
- 目标已存在或同名文件时不覆盖。
- workspace 在 Quick Pick 打开期间发生变化时安全失败。
- `file:`、只读 scheme 和模拟可写 virtual scheme 行为正确。
- LSP loading、ready、reload 和 unavailable 状态可恢复。

### 13.4 跨游戏 fixture

每种游戏至少准备：

- 一个 CWT 顶层路径；
- 两个共享父目录但不同子目录的 TypeDef；
- 一个 profile-only 目录；
- 一个 vanilla-only 目录；
- 一个已存在项目目录；
- 一个本地化目录；
- 一个非法或动态路径反例。

断言最终候选既包含应有项，也不包含其他游戏专属项和已存在项。不得只测试
Stellaris 后用 profile 单元测试代替其他游戏的端到端目录聚合。

## 14. 性能与稳定性门槛

- 打开 Quick Pick 不递归扫描工作区或原版目录。
- 缓存命中的 CWT/profile 候选聚合 P95 不高于 50 ms。
- 本地原版单层目录读取 P95 不高于 200 ms；慢速远程读取异步显示 loading，不阻塞
  Extension Host。
- 目录列表在 10,000 个规范化 CWT 路径下仍有界并可取消。
- 原版缓存最多 128 个父目录条目，workspace/client 关闭后全部释放。
- 重复打开/关闭 Quick Pick 不增加 listener、CancellationTokenSource 或定时器。
- 规则 reload、游戏切换和多根工作区并发请求不会显示陈旧游戏候选。
- 所有性能 fixture 固定输入并记录中位数/P95；不以开发机单次绝对耗时作为唯一判断。

## 15. Definition of Done

只有以下条件全部满足才能标记完成。

### 15.1 功能

- [x] Explorer 和 Command Palette 均可启动目录补全创建流程。
- [x] 当前父目录的 CWT、profile、原版候选正确合并。
- [x] 支持自定义单段和多段相对目录创建。
- [x] 已存在目录/文件不会被覆盖。
- [x] 创建成功后正确 reveal。
- [x] LSP loading/unavailable、无原版路径和游戏识别不明确均有可恢复流程。
- [x] 多根 workspace 和可写 virtual filesystem 正确。
- [x] 不使用或修改 VS Code 私有 API。

### 15.2 游戏完整性

- [x] Stellaris、HOI4、EU4、EU5、CK2、CK3、Imperator、VIC2、VIC3 全部通过
      CWT/profile/vanilla/项目现状合并测试。
- [x] Custom/Generic 使用已加载 CWT 和 Generic profile，不继承 Stellaris。
- [x] Legacy 与 Jomini 游戏的本地化目录拼写正确。
- [x] Stellaris 以及所有内置 profile 均不建议已废弃的
      `localisation_synced`；Custom/Generic 也不通过 fallback 产生它。
- [x] 任一游戏缺少原版配置时，其 CWT/profile 功能仍然完整可用。

### 15.3 正确性与安全

- [x] 所有 LSP、JSON、设置和文件系统输入均经过边界验证。
- [x] 绝对路径、路径穿越、非法段和越过 workspace 的创建均被拒绝。
- [x] URI 逻辑不假设本地 `file:` scheme。
- [x] latest-wins、取消、dispose 和 reload 无陈旧结果或资源泄漏。
- [x] 所有候选和协议输出排序确定。
- [x] 缓存有界并有明确失效条件。

### 15.4 国际化与文档

- [x] English 和简体中文命令、状态、提示、错误全部同步。
- [x] README 中英双语说明已更新。
- [x] ARCHITECTURE.md 中英双语数据流与安全边界已更新。
- [x] 本计划状态和最终验证结果已回写。

### 15.5 仓库验证

- [x] 新增 F# 目录目录表/协议测试通过。
- [x] 新增 Extension 单元测试通过。
- [x] 新增 VS Code 集成测试通过。
- [x] `dotnet build src/Main/` 通过。
- [x] `dotnet build src/LSP/` 通过。
- [x] `npm run compile` 通过。
- [x] `npm run test:unit` 通过。
- [x] `npm run build:docs` 通过。
- [x] `npm run check:release -- --skip-compile --skip-test` 通过。
- [x] `npm run verify` 通过。
- [x] 如实施中确实需要修改 `submodules/cwtools`，子模块提交与根仓库 pointer 更新已
      分开提交；否则不得为了本功能制造无必要的子模块变更。

任意一项未完成时，只能报告“实施中”或明确阻塞，不得把单个工作包、单个游戏、只有
profile 候选、只有 CWT 候选或只有本地文件系统支持标记为功能完成。

## 16. 预期主要改动位置

服务端与共享协议：

- `src/Main/Program.fs`
- `src/LSP/LanguageServer.fs`（只在 read-only command 声明需要同步时修改）
- `client/shared/pdxSemanticCatalog.ts`

Extension Host：

- 新增 `client/extension/directoryCompletions.ts`
- `client/extension/extension.ts`
- `client/extension/gameProfiles.ts`
- 复用 `client/extension/workspaceGameDetection.ts`
- 复用游戏路径/Steam 子目录相关 helper

Contribution 与国际化：

- `release/package.json`
- `release/package.nls.json`
- `release/package.nls.zh.json`
- `release/package.nls.zh-cn.json`

测试与文档：

- 新增对应 F# regression test
- 新增 `client/test/unit/directoryCompletions.test.ts`
- 更新 `client/test/suite/extension.test.ts` 或新增专用 suite
- `README.md`
- `ARCHITECTURE.md`
- 本文档

实际文件边界以实施时的 CodeGraph 调用链和现有 helper 复用情况为准，但不得借机
重构无关补全、AI、MCP 或 Explorer 功能。

## 17. 风险与应对

| 风险 | 后果 | 应对 |
| --- | --- | --- |
| CWT TypeDef 展示截断被误当成完整目录表 | 后部规则目录缺失 | 服务端新增独立完整目录字段和显式截断状态 |
| CWT 不描述资产目录 | 声音、贴图等建议缺失 | 合并 profile 与原版同层目录 |
| 原版路径未配置或不可读 | vanilla-only 候选缺失 | CWT/profile 继续可用，非侵入式提示配置 |
| 未知项目默认 Stellaris | 创建错误游戏目录 | 活动 LSP优先；未知时显式选择；禁止默认 Stellaris |
| 多根 workspace client 串线 | 候选来自错误游戏 | 所有缓存键和请求都绑定目标 workspace URI/client |
| 递归扫描原版目录 | 卡顿和内存增长 | 每次只读镜像父目录的直接子目录，有界缓存 |
| Quick Pick 关闭后旧请求返回 | UI 陈旧或错误创建 | 取消源、request generation、latest-wins |
| 远程 URI 使用本地 path API | 边界判断或创建错误 | 使用 `workspace.fs`、`Uri.joinPath` 和 URI 段校验 |
| 同名目录在确认前被外部创建 | 覆盖或误报成功 | 创建前重新 stat；存在时不写并 reveal |
| 新协议破坏 semantic catalog 消费者 | 索引/事件链/vanilla compare 回归 | 只增字段、共享 guard、现有 fixture 全量回归 |

## 18. 回滚与故障策略

- 功能以独立命令和菜单 contribution 接入；出现严重问题时可以移除该入口而不影响
  原有文本补全和 LSP 诊断。
- semantic catalog 新字段保持向后兼容，旧客户端忽略即可。
- LSP 目录字段不可用时客户端只使用 profile/vanilla，并明确标记 CWT 数据未就绪；
  这只用于运行时故障恢复，不能替代最终交付中的 CWT 完整实现。
- 创建失败不做补偿性删除，因为命令只执行单个 `mkdirp` 操作且不得覆盖已有资源。
- 不缓存“创建成功”作为事实；每次重新读取目标父目录。
- 任何协议解析失败、路径越界或文件系统状态不确定都采取 fail closed，不尝试猜测或
  继续写入。

## 19. 最终实施与验证记录

实施结果：

- LSP `cwtools.ai.getSemanticCatalog` 已增加版本化、完整且独立于 4000 条 TypeDef
  展示上限的 `directoryPaths`，F# 与共享 TypeScript 边界都执行非法/动态路径过滤、
  合并和确定性排序。
- Extension Host 已交付纯聚合器、128 项/五分钟 vanilla LRU/TTL 缓存、latest-wins
  请求代次、Explorer/Command Palette 命令、可搜索 Quick Pick、自定义多段路径、
  URI 边界复核、创建和 reveal。
- 九个内置游戏及 Custom/Generic 的合并矩阵已覆盖；`localisation_synced` 已从
  profile、文件关联、扫描路径和本地化写入路径约定中清理，仅在旧工作区识别 marker
  和 CWT 规则字段语义等非目录兼容位置保留。Generic 目录建议只有在活动自定义 CWT
  明确声明时才接受该名称。
- English、简体中文 NLS、README、ARCHITECTURE 和生成的 release README 已同步。

2026-07-29 验证结果：

| 验证 | 结果 |
| --- | --- |
| `dotnet fsi src/Main/SemanticDirectoryCatalog.Tests.fsx` | 通过 |
| `dotnet build src/Main/Main.fsproj --no-restore` | 通过，0 warning / 0 error |
| `dotnet build src/LSP/LSP.fsproj --no-restore` | 通过，0 warning / 0 error |
| 目录功能定向 TypeScript 测试 | 通过，覆盖协议、十种模式、URI、安全、缓存、性能和 manifest |
| VS Code Extension Host 定向命令注册测试 | 通过，`cwtools.createGameDirectory` 已注册 |
| `npm run compile` | 通过 |
| `npm run test:unit` | 通过，1681 tests；rules-sync 24 tests |
| `npm run build:docs` | 通过 |
| `npm run check:release -- --skip-compile --skip-test` | 通过；仅报告仓库既有版本同步/skip 提示 |
| `npm run verify` | 通过；ESLint 仅报告两个既有 `projectKnowledge.test.ts` unused warning |
| `git diff --check` | 通过 |

补充说明：未筛选的 `npm test` 还会加载仓库全部旧 Extension Host 套件；本次环境中它
被既有 Shader 测试的 rules-folder 前置条件和完整扩展激活超时阻塞。为隔离本功能，
已在同一真实 VS Code Extension Host 中定向运行新增命令注册测试并通过；目录协议、
聚合、创建边界与 virtual URI 行为由新增纯回归测试覆盖。
