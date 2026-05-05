# Changelog

## [1.9.6] - 2026-05-06

### 🔄 时间线交织修复 (Chronological Interleaving)
- **[P0 修复] 完成消息丢失交织布局**
  - 修复了 AI 输出时正常交织显示（think→text→tool→think→tool→text），但完成后变为分组排列的 Bug
  - 根因：`flushText()` 把中间文本追加到 `content` 变量延迟到底部渲染，而非在当前位置创建 `msg-bubble`
  - 现在完成消息与流式消息保持一致的时间线交织顺序

### 📁 工具文件名保留 (Tool Args Preservation)
- **[修复] tool_result 更新时丢失文件名**
  - 修复了流式渲染中 `tool_result` 回调创建 `fakeCall` 时使用空 `toolArgs: {}` 导致文件名丢失的问题
  - 新方案：将 `toolArgs` 序列化存储到 `data-call-args` 属性中，`tool_result` 到达时反序列化恢复
  - `read_file`、`edit_file` 等工具现在在结果返回后仍能正确显示操作的文件名

### ❓ 问题卡片重设计 (Question Card Redesign)
- **[UI] Claude Code 风格问题决策卡**
  - 问题卡片使用蓝色边框替代金色，配合脉冲动画吸引注意力
  - 新增「⏳ 等待你的选择…」提示标签
  - 选项按钮增大触控区域和 hover 微动画，提升交互反馈
  - 选项描述增加缩进对齐

## [1.9.5] - 2026-05-05

### 🎨 AI 代理 UI/UX 架构重构 (Agent UI Refactoring)
- **[P0 修复] Thinking/text_delta 路由混淆 Bug**
  - 修复了 `text_delta`（最终回复流）被错误路由到 Thinking 折叠块的严重显示 Bug
  - AI 的推理过程与最终回复现在正确分离显示
- **[新架构] 纯函数渲染模块 `messageRenderer.ts`**
  - 从 167KB 的 `chatPanel.ts` 单体中提取 8 个可测试纯函数
  - 新增 54 个单元测试（`messageRenderer.test.ts`），总测试 85 个全部通过
- **[新特性] Claude Code 风格线性工具时间线**
  - 工具执行从折叠式列表改为线性时间线，每步显示 `1. 2. 3.` 编号
  - 实时显示工具执行耗时（45ms / 2.5s / 2m 5s）
  - `edit_file` 工具显示参数摘要（old/new 内容预览）
- **[新特性] 内联 Diff 预览**
  - 工具执行结果中的代码变更直接内联显示（最多 20 行，超出折叠）
  - 绿色高亮新增行、红色高亮删除行，附带行号
- **[新特性] 权限确认内联化**
  - 权限请求按钮（允许/拒绝/始终允许）直接嵌入工具时间线步骤中
  - 使用事件委托模式，无需为每个按钮单独绑定事件
- **[优化] 进度指示元数据**
  - `AgentStep` 新增 `stepIndex`、`durationMs`、`iterationInfo` 字段
  - `agentRunner` 全局计数器跨迭代跟踪工具调用序号
- **[优化] 空间利用**
  - Todo 面板改为折叠式 `<details>` 元素，默认收起
  - 聊天区域间距紧凑化（gap 20→14px, padding 16→12px）

## [1.9.4] - 2026-05-04

### ✨ 新特性 (Features)
- **[新功能] 原版代码智能对比 (Vanilla Code Comparison)**
  - 支持跨平台解析游戏原版文件（通过 `cwtools.cache.*` 路径设定）
  - 引入 CodeLens 内联提示，直观显示代码块与原版的匹配及修改状态
  - 支持块级差异查看（通过 CodeLens 或右键菜单触发单个代码块 Diff）
  - 支持文件级差异查看（自动搜集并组合所有被修改的代码块展开 Diff）
  - 采用 LRU 高速缓存与基于 tokenizer 的花括号深度解析，保障性能与鲁棒性
  - （可选）新增行级 Gutter Decorations 高亮显示

### 🐛 Bug 修复与体验优化 (Bug Fixes & UX)
- **[修复] 原版对比的跨对象错乱匹配 Bug**（通过严格鉴权提取 `id` 和 `name` 属性，彻底消除无 ID 事件导致的错误合并 Diff）

## [1.9.3] - 2026-05-04

### 🐛 Bug 修复与 UI 重构 (Bug Fixes & UI Refactoring)
- **[重构] 全面迁移 UI 图标至 SVG 系统 (Emoji to SVG Migration)**，解决在不同平台与字体下的渲染不一致问题
- **[修复] `guiPanel` 与 `solarSystemPanel` 编辑模式静默失效 (Maximum call stack size exceeded) 的严重漏洞**（修复了因 `_saveSnapshot` 无限递归导致的编辑器崩溃问题）


## [1.9.2] - 2026-05-02

### ✨ AI Agent Skills 管理系统本地化隔离 (Local Agent Skills Isolation)
- **[重构] 本地化技能存储**
- **[新功能] 技能可视化 UI 面板**

## [1.9.1] - 2026-05-02

### ✨ 体验优化 (UX Improvements)
- **[修复] AI 提供商注册引导链接 (Provider Hint)**

## [1.9.0] - 2026-05-02

### 🛡️ AI 补全系统硬核重构 (Completion Architecture Refactor)
- **[安全升级] FIM 能力白名单严格过滤**
- **[架构重组] 抛弃聊天模拟 FIM (Legacy Chat Fallback Removal)**

## [1.8.9] - 2026-05-02

### 🐛 Bug 修复与体验优化 (Bug Fixes & UX Improvements)
- **[修复] Minimax 模型内联补全被误拦截**
- **[优化] 内联补全的错误诊断体验**

## [1.8.8] - 2026-05-02

### 🛡️ AI 代理可靠性与技术债务修复 (Audit Hardening)
- **[修复] Claude SSE Thinking Token 路由错误**
- **[清理] AI 核心工具流代码净化**
- **[优化] 代理资源池配置隔离**
- **[完善] 上下文预算池单元测试**

## [1.8.7] - 2026-04-30

### ✨ 用户体验与性能优化 (UX & Performance)
- **精准的 AI 报错白名单审查机制**
- **智能报错隐匿报告 (Smart Negatives Reversal)**

## [1.8.6] - 2026-04-30

### ✨ 新特性 (Features)
- **行级 Diff 可视化**
- **快速修复与代码解释 (CodeActionProvider)**
- **跨会话持久记忆 (Persistent Memory)**

### 🐛 Bug 修复与清理
- **移除上游遗留流水线**
- **修复 Gitee 同步发布 Bug**

## [1.8.5] - 2026-04-29

### ✨ 新特性 (Features)
- **科技树与事件链全景可视化**
  - **新增科技树可视化（Tech Tree Visualizer）**
  - **事件链系统大成**

### 🐛 Bug 修复与体验优化
- **[重大修复] 星系轨道漂移 Bug**

## [1.8.4] - 2026-04-29

### ✨ 新特性 (Features)
- **强化事件链解析能力**
## [1.8.3] - 2026-04-29

### ✨ 新特性 (Features)
- **新增了事件预览相关内容**
## [1.8.2] — 2026-04-28

### 🐛 Bug 修复与体验优化

- **[修复] 预缓存界面持续挂起 Bug**

## [1.8.1] — 2026-04-28

### ⚡ 性能优化 (Performance)

- **[重大优化] CodeLens 零阻塞零 I/O 预加载**

## [1.8.0] — 2026-04-28

### ⚡ 性能优化与 LSP 增量流 (Performance & LSP Delta)

- **[重大优化] SemanticTokens 增量解析下发 (`full/delta`)**
- **[重大优化] F# 后端无锁安全并发**
- **[系统升级] 自适应智能内存防溢出淘汰策略**
- **[架构级重构] 后端数据驱动流路由**

## [1.7.0] — 2026-04-28

### ✨ 用户体验与稳定性优化 (UX & Stability)

- **[重大优化] Chat 滚动条体验升级**
- **[重大优化] 交互卡片生命周期管束**
- **[安全扩容] 写入工具降级授权**
- **[系统升级] 执行守卫系统提示**

## [1.6.9] — 2026-04-27

### 🤖 多智能体架构加固与原子化事务 (Multi-Agent Concurrency Hardening)

- **[重大更新] 挂载 VFS 事务管理器**
- **[重大更新] VFS 异步互斥锁逻辑**
- **[增强] 子任务自愈机制 (Node-Level Self-Healing)**
- **[新功能] 语义化 Blackboard 内存检索**
- **[修复] `ExternalToolContext` 类型对齐**

## [1.6.8] — 2026-04-27

### 🛡️ 核心工具层隐患排除与体验优化 (Agent Resilience & Quality of Life)

- **[P0 安全] 封禁 `write_file` 覆写越权**
- **[P1 安全] 阻断动态 SSRF 内网穿透**
- **[P1 修复] 毁灭震荡打断 (Doom-Loop)**
- **[优化] 搜寻爆破硬截断机制**
- **[优化] `astMutate` 智能排版融合**
- **[优化] LSP 污染警报器降噪处理**

## 1.6.7
- **架构与修复**
  - 重构了 `AgentRunner` 执行管线，解决由于写入队列错误引发的重复执行和丢失子代理快照的漏洞。
  - 修复 `fileTools.ts` 中的局域文件读取缓存脏污染漏洞，禁止对被指定 `endLine` 裁剪的内容进行错误全局缓存。
  - 在 `promptBuilder.ts` 中恢复了 Paradox Namespace、Entity IDs 的强制压缩保护层，防止因为多轮对话长记忆被遗忘。
  - 下载和更新链接中的镜像代理域名升级为最新的 `gh-proxy.org` 及相关加速网络。

## 1.6.6
  - 通过将服务可释放物绑定到 VSCode 扩展垃圾回收生命周期，消除了 MCP 客户端状态持久性问题，确保在编辑器重新加载时优雅地拆除模型上下文协议。
  - 重新调整了多代理循环的内部调度模式子类型边界，以便正确路由 `build` 命令。

## [1.6.5] — 2026-04-26

### 🛡️ 安全加固与缺陷修复 (Audit Hardening)

- **[P0 修复] `multiEdit` TOCTOU 竞态消除**
- **[P0 修复] 9-Slice Canvas DOM 泄漏**
- **[P1 修复] LSP 超时定时器泄漏**
- **[P1 修复] `retractMessage` 硬编码 `-2` 偏移**
- **[P1 修复] `applyPatch` 快照时机**
- **[P1 修复] `contentToString` 去重**

### ⚡ 性能优化

- **Levenshtein 滚动数组**
- **CJK 自适应 Token 估算**

### 🔧 改进

- **命令安全白名单 (P2-11)**
- **增量验证 (C3)**
- **子代理任务隔离 (C5)**


### 🐛 Bug 修复与体验优化

- **[修复] AI 模型列表界面空白**
- **[修复] AI 设置强制刷新导致的代码冻结**
- **[优化] 模块编译可视化提示**
- **[优化] 版本更新进度条显示**
- **[修复] Token 数据防呆清空阻断**

## [1.6.2] — 2026-04-26

### 🤖 Agentic 2.0 架构升级与新特性

- **[重大升级] 引入 AST Mutator 前端修饰器**
- **[重大升级] 并发子代理 (Sub-Agent Orchestration)**
- **[修复] UI 上下文满血解封 (L9)**
- **[修复] 上下文压缩条显示对齐 (UI)**
- **[优化] 启动规则与更新校验提前**

## [1.6.1] — 2026-04-25

### 🏗️ 架构与维护性优化 (Architecture & Maintainability)

- **[重构] F# LSP 后端多态重构**
- **[重构] AI Agent 调度器拆解**

## [1.6.0] — 2026-04-23

### 🤖 AI Agent — 新功能与深度集成

- **[新功能] 会话 JSON 完整导出/导入 (Feature 1)**
- **[新功能] 多文件 Diff 预览 (Feature 2)**
- **[新功能] MCP (Model Context Protocol) 客户端 (Feature 3)**
- **[增强] Sub-Agent 并行编排 (Feature 4)**
- **[增强] 全项目本地化索引 (Feature 5)**
- **[新功能] Review Mode 代码审查 (Feature 6)**
- **[新功能] 性能监控 Dashboard (Feature 7)**
- **[新功能] 多游戏 AI 知识库与 Prompt 支持**
- **[新功能] 上下文窗口智能化 (Smart Windowing)**
- **[增强] 打字机流式输出体验**
- **[增强] AI 对话全文快速检索引擎**
- **[增强] AI 常用命令全局快捷键**
- **[增强] 子任务 (Sub-Task) 执行进度投屏**
## [1.5.0] — 2026-04-21

### 🔒 LSP 服务端 — 稳定性与并发

- **[修复] Tokenizer CRLF 安全性**
- **[修复] Tokenizer Content-Length 守卫**
- **[修复] LanguageServer 进程队列无界化**
- **[修复] LanguageServer ReaderWriterLockSlim 并发**
- **[修复] LanguageServer 请求 ID 原子递增**
- **[修复] LanguageServer 响应通道泄漏**
- **[修复] Program.fs UNC/符号链接路径**
- **[修复] Program.fs 孤儿命令响应**
- **[修复] Program.fs GC 压力**
- **[性能] DocumentStore O(n)→O(1) 范围查找**

### 🤖 AI Agent — 可靠性与正确性

- **[修复] AbortController 并发安全 (C1)**
- **[修复] 并行 tool_call 索引碰撞 (M1)**
- **[修复] 默认 max_tokens 提升至 8192 (M5)**
- **[新功能] Claude SSE 流式传输 (L4)**
- **[修复] Doom-loop 检测 (M2)**
- **[修复] 最终 API 调用前中止信号检查 (C2)**
- **[修复] `validate_code` 串行执行 (M6)**
- **[修复] 子 Agent token 用量传播 (L8)**
- **[修复] 压缩过滤系统消息 (L3)**
- **[修复] 压缩截断限制 (M4)**
- **[修复] PDXScript 启发式假阳性 (L2)**
- **[修复] Fence 模式去重 (L1)**
- **[修复] `multiedit`/`patch` 纳入写工具集 (L6)**
- **[修复] Claude ContentPart[] 系统提示序列化 (L5)**
- **[修复] 动态 provider 导入移除 (M3)**

### 1.4.0
#### 新功能
* **AI 助手 Agent 架构升级** — 工具栏与 Chat Panel 完成双模式升级与深层 Agent 增强体验：
  - **Build / Plan 双模式**
  - **上下文智能压缩**
  - **任务看板工具 (TodoWrite)**
  - **工作区深层检索**
* **模型与性能体验** — 参数配置面板迎来全面革新：
  - **Ollama 本地接入**
  - **自定义上下文上限**

### 1.3.0
#### 新功能
* **星系可视化预览** — 在 `solar_system_initializers/` 下的 `.txt` 文件中，点击编辑器标题栏的望远镜图标打开星系可视化预览面板。
  - 支持 3D 透视投影渲染恒星、行星、卫星及其轨道
  - 支持递归层级：行星 → 卫星 → 子卫星（任意嵌套深度）
  - 环形世界（Ring World）完整支持：分段渲染、弧形显示、拖拽扩缩
  - 累积轨道系统正确解析 `orbit_distance`、`change_orbit`、`orbit_angle`
* **星系可视化编辑** — 在编辑模式下直接拖拽天体修改其轨道参数，修改实时同步到脚本文件。
  - 右键菜单创建：恒星、行星、卫星、环形世界、同轨道兄弟天体
  - 拖拽编辑轨道距离和角度，支持跨轨道重排序
  - 同轨道天体（orbit_distance=0）沿轨道圈拖拽、锁定半径
  - 环形世界拖拽缩放自动吸附到有效分段数（360的因子）
  - 删除天体、撤销操作（Ctrl+Z）
  - 双列网格右键菜单，紧凑高效
* **视图控制** — 鼠标滚轮缩放、右键拖拽平移、Alt+拖拽旋转视角（水平360°、垂直5°-175°）。

### 1.2.0
#### 新功能
* **GUI Preview 多分辨率切换** — 工具栏新增分辨率选择器（自适应 / 1920×1080 / 2560×1440 / 3840×2160），可在不同分辨率下预览 GUI 布局效果。
* **GUI Preview 动画预览** — 支持多帧 Sprite 自动循环播放，工具栏可控制播放/暂停，帧间隔 200ms。
* **本地化装饰增强** — 代码行内本地化文本显示支持切换开关，可通过编辑器标题栏按钮快速启用/禁用。
* **安全重命名** — 重命名操作移除了回车直接确认机制，改为预览后手动确认，避免误操作。

#### 移除
* **事件流程图** — 移除了基于 Cytoscape.js 的事件链可视化功能（`showGraph`、`setGraphDepth`、`graphFromJson` 等命令），简化插件体积与维护成本。
* **性能分析器** — 移除了冗余的 AND/OR 性能提示功能。

#### 修复
* **编译流程修正** — 修复了仅运行 TSC 而未执行 Rollup 导致 Webview 脚本未正确打包的部署问题。
* **构建产物清理** — 清理了已移除功能的残留编译产物，避免部署目录中存在过时文件。

### 1.1.5
#### 修复
* **Event Target 验证降噪** — 系统性扩展了 Event Target 扫描边界，包含工作区所有 `save_event_target_as` 的目标名称，防止局部分析时在别处设置但此事件链未检测到导致的假阳性报错引发满屏红色警报。
* **解析器增强** — 将 `+` 号添加入允许字符（idCharArray），修复例如 `xxx_+1m_button` 等名称含有 `+` 的标识符被截断导致的异常语法报错（CW001）。
* **UI 面板解析容错** — 修复了从本地读取 GUI 文件时诸如 `center_up` 等非全大写的对齐方式（Orientation），由于属性面板匹配严格大小写导致页面选项显示空白 `(无)` 的问题。
* **拖拽坐标偏移问题修复** — 修复了对具有额外中心点原点偏移（Orientation 或 Origo 设置不位于左上角）的元素调整位置拖拽时产生的坐标计算偏差机制。新基准剥离了 DOM 内实时拖拽相对于父窗口的 `Left/Top` 渲染和回推入 AST 代码（相对 `x/y`）保存的系统隔离绑定，解决任意异型控件设置好缩放且保存后重新加载时位置错断、乱窜飞天的问题。

### 1.1.4
#### 修复
* **缩放处理机制重构** — 彻底抛弃使用 CSS `transform` 进行引擎组件（Button, Icon 等子控件）属性可视缩放的方案，换为其原生同步计算视觉宽高的算法（解决原先因子组件拖拽棒跟随缩放导致过小无法使用的问题）。
* **规模尺寸架构统一** — 增强创建新子组件流程和判定体系。限制 `size` 类型只服务于特定全屏和容器组合层类型（`containerWindowType`系列），剥除 `IconType` 和按钮元素受限于错误 `Size` 参数导致的不正常拉动生效并强行转化只使用 `Scale` 输出。
* **连贯性二次缩放** — 修复二次缩放后使用原始宽高直接累进缩放值导致的不准弹跳缩放回初始实际大小时错误的视觉刷新重渲染回源的问题。

### 1.1.3
#### 新功能
* **更多的创建按钮支持** — 在右键菜单中新增了创建 `effectButtonType` 和 `guiButtonType` 类型的选项

#### 修复
* 修复在连续调整属性（如多次缩放同时触发 `position` 和 `scale` 变化）时，由于异步处理延迟导致旧属性找不到从而错误生成重复属性代码的问题（加入了操作队列串行处理与就近扫描替换策略）
* 修复编辑任意内容后 `_loadAndRender` 会导致预览画布重置到中心的问题，现在仅在首次加载时应用自适应居中，之后的修改将保留用户的平移/缩放视角

### 1.1.2
#### 修复
* 修复多选元素时拖拽缩放边界（resize）无效的问题，现在所有选中的元素会同步改变大小
* 修复由于 `size` 导致重复插入代码的 bug，将其从实时事件触发改为失去焦点后触发
* 修复多元素操作时撤回（undo）导致的状态快照重复问题，添加了操作防抖处理
* 修复无显式 `size`（自动采用纹理大小）的控件（如 `iconType`）缩放时应使用 `scale` 进行调整的问题

### 1.1.1
#### 新功能
* **贴图选择器** — 属性面板中的贴图属性支持搜索式下拉补全，数据来源于工作区和游戏目录的 `.gfx` 文件
* **Effect 属性编辑** — effectButtonType 类型新增 effect 属性输入框，支持 `common/button_effects/` 中定义的效果名称补全
* **多选可见性切换** — 图层面板中多选元素后，点击眼睛图标可批量切换可见性
* **属性修改撤销** — 属性面板中的所有修改（帧、贴图、位置、大小等）均支持 Ctrl+Z 撤销

#### 修复
* 修复帧属性修改在单行格式元素上会重复插入 `frame` 代码的 bug
* 修复帧属性 spinner 点击触发两次更新的问题（移除冗余 input 事件）
* 修复单行格式元素属性编辑现在正确使用行内正则替换而非插入新行
* 修复贴图选择器下拉框被属性面板 overflow 裁剪导致不可见
* 修复输入框中按方向键会同时移动画布元素的键盘冲突
* 修复图层面板多选时高亮状态不同步

### 1.1.0
#### 新功能
* **GUI 预览** — 在 VS Code 中实时预览 `.gui` 文件渲染效果
  - 支持所有主要控件类型（containerWindowType、iconType、buttonType、effectButtonType 等）
  - DDS 纹理解码（BC1/BC2/BC3/BC7、未压缩 BGRA/BGR）
  - TGA 纹理解码（未压缩、RLE 压缩，24/32bpp）
  - corneredTileSpriteType 的 Canvas 9-切片渲染
  - 多帧精灵裁切（noOfFrames）
  - 百分比尺寸继承（`width = 100%`）
  - PDX 布局系统支持（orientation、origo、centerPosition）
  - 图层面板、元素搜索（Ctrl+F）、缩放/平移
  - 离屏元素自动过滤（坐标 > 5000）
* **CodeLens 本地化文本** — 在代码上方显示对应的本地化文本
* **Inline Script 导航** — Ctrl+Click 跳转到 inline_script 文件定义
* **文件悬浮预览** — 鼠标悬浮显示 inline_script 引用文件的内容
* **算术表达式求值** — 悬浮显示 `value:xxx|` 表达式的计算结果

#### 修复
* 修复 scale 属性的双重缩放 bug（同时在布局和 CSS transform 中应用）
* 修复 scale 不应对 containerWindowType/windowType 生效
* 修复 centerPosition + scale 的变换原点应为 center
* 修复 corneredTileSpriteType 在 Webview 中无法渲染的问题
* 修复 portraitType 的 masking_texture 字段未被索引
* 修复百分比尺寸（`100%`）被错误转为数字的解析 bug
* 修复无显式 size 的容器应继承父容器尺寸而非自动收缩
* 修复 background 中 spriteType 应使用原始纹理尺寸显示

#### 性能
* 纹理缓存添加 50MB LRU 上限，防止内存无限增长
* 插件重载时正确停止 Language Server 并清理资源
* 离屏元素和 size=0 容器从渲染和图层面板中过滤

### 1.0.0
* Stellaris: Allow "(", ")" as values, to allow parsing (but not proper support for) `@[()]`
* Fix a bug with document symbols