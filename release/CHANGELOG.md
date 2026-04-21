# Changelog

## [1.5.0] - 2026-04-21
### AI Agent — 架构全面重构
#### 并发架构（LSP 服务端）
- **读写锁并发**：引入 `ReaderWriterLockSlim`，只读请求（Hover、Completion、AI 查询等）线程池并发执行，写操作（DidChange、UpdateFile）串行独占执行
- **validateCode 竞态修复**：`cwtools.ai.validateCode` 命令内的 `UpdateFile` 调用现在持有写锁保护，防止并发验证产生 AST 状态竞争

#### 8 个新增 AI 专用 LSP 命令（Program.fs）
所有新命令均注册为只读并发命令，不阻塞 LSP 主线程：

| 命令 | 功能 | 底层 API |
|------|------|---------|
| `cwtools.ai.queryDefinition` | 按坐标跳转定义 / 查找引用 | `GoToType` + `FindAllRefs` |
| `cwtools.ai.queryDefinitionByName` | **按名称**直接定位符号定义，无需知道坐标 | `AllEntities` AST 搜索 |
| `cwtools.ai.queryScriptedEffects` | 列出所有 scripted_effect 及 scope 约束 | `ScriptedEffects()` |
| `cwtools.ai.queryScriptedTriggers` | 列出所有 scripted_trigger 及 scope 约束 | `ScriptedTriggers()` |
| `cwtools.ai.queryEnums` | 查询枚举合法值 | `GetEmbeddedMetadata().enumDefs` |
| `cwtools.ai.queryStaticModifiers` | 列出所有 static modifier 及类别 | `StaticModifiers()` |
| `cwtools.ai.queryVariables` | 列出所有 `@variable` 定义 | `ScriptedVariables()` |
| `cwtools.ai.getEntityInfo` | 获取文件的引用类型、定义变量、effect/trigger 块、event_target | `ComputedData` 缓存 |

#### TypeScript 客户端增强（agentTools.ts）
- 8 个新工具的完整定义（tool schema）、dispatch 注册和实现方法
- **5秒 TTL 缓存**：`cachedLspRead<T>()` 通用缓存，ScriptedEffects/Triggers/Enums/StaticModifiers 重复调用直接命中缓存，大幅降低 LSP 轮询频率
- `AgentToolName` 联合类型同步更新（types.ts）

#### AI 系统提示强化（promptBuilder.ts）
- **反幻觉强制检查规则**（Build 模式）：使用 scripted_effect/trigger/@variable/modifier 前**必须**先调用对应 AST 查询工具
- **深层 API 工具表格**（所有模式 STELLARIS_KNOWLEDGE）：明确各工具使用时机，AST 工具优先于文件系统搜索
- **Explore 模式**：区分文件级工具与 AST 级工具，标注 AST 工具更快且具 scope 感知能力

### 1.4.0
#### 新功能
* **AI 助手 Agent 架构升级** — 工具栏与 Chat Panel 完成双模式升级与深层 Agent 增强体验：
  - **Build / Plan 双模式**：新增模式切换（Build 模式支持全自动生成验证，Plan 模式专注只读分析不改动文件），适应不同复杂度的 Prompt 任务。
  - **上下文智能压缩**：当长程对话 token 量超过模型处理极限的 70% 时，AI 自动生成压缩摘要取代旧记录。
  - **任务看板工具 (TodoWrite)**：AI 此刻能自发维护执行中的步骤，并向用户实时展示它的 `Todo` 清单可视化追踪进度。
  - **工作区深层检索**：新增 `workspace_symbols` 和 `document_symbols` 工具跨项目联调上下文定义。
* **模型与性能体验** — 参数配置面板迎来全面革新：
  - **Ollama 本地接入**：免 Key 直接零配置调用本地大语言模型服务，并且支持 `fetchOllamaModels` 自动呈现环境内装载模型名单及其参数容量。
  - **自定义上下文上限**：设置选项支持直接修改任意大语言模型 token 携带阈值（原厂 API 提供商选项同样全部上调对标 2026 年最新规格极限：GPT-5.4(400K), Claude Opus(1M), Qwen3(256K)）。

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