# Agent Note: 全局舰船设计可视化工作台

Status: implemented

## Problem

Mod 的 `common/global_ship_designs` 把设计元数据、区段、部件和核心组件写在重复 PDX 块中。手工编辑时，作者需要同时追查船型槽位、区段模板、部件槽模板、文化实体名、mesh locator、科技前置和本地化 key；纯文本无法直观发现模型错装、空槽、能量不足或名称对应关系。现有 GUI Preview 提供工作台交互，Entity Preview 提供三维资源能力，舰船图标命令提供分层目录，但三者之间缺少一个只编辑 global design 的安全闭环。

本变更与 [舰船模型顶部图标](./2026-10-22-ship-icon-sheet-from-models.md)、[实体定位器旋转](../bug-fix/2026-09-11-entity-preview-locator-pitch-roll-mirror.md) 和 [GUI Host 事实源](./2026-11-17-agent-manager-gui-development-preview.md) 交叉链接。图标生成的“分段不施加 locator 平移”只适用于其正交剪影，不是本工作台的组装规则。

## Decision

### 1. Host 拥有文档、目录、草稿和资源

`ShipDesignPanel` 只接受工作区内 `common/global_ship_designs/*.txt`。命令、编辑器菜单、三份 NLS 和 Rollup 入口共同暴露 `cwtools.shipDesign.open`，并在当前编辑器列打开，不再固定拆分到 `Beside`。面板持有当前 TextDocument、选中设计、预览文化和模型代际；`ShipDesignDraftSession` 独立保存草稿文本、版本和撤销/重做历史。普通操作只修改草稿，保存是唯一通过一次 `WorkspaceEdit` 应用草稿并调用 `document.save()` 的路径。

工作区设计发现最多扫描 128 个文件并返回 512 个设计。跨文件 URI 在打开前重新校验 file 协议、工作区包含关系和目录类型；当前工作台有未保存草稿时，切换必须经用户确认并明确放弃草稿。纯 `visualEditorSafety.ts` 同时服务 GUI 与舰船设计；面板把 Host 草稿暴露为虚拟脏文档，Agent 写入保护同时检查 TextDocument 与该状态，不能利用干净源文档绕过。

### 2. 结构化投影与最小补丁

`designDocument.ts` 使用共享 `pdxTokenizer` 记录原文范围，以出现序号生成 `design:n/section:n/slot:n` 等稳定结构 ID。重复设计名和重复槽位不靠显示名唯一寻址；歧义字段拒绝猜测。新建、复制、删除、字段修改、区段/部件变更、核心组件和整套装载都生成原文补丁，其他设计、注释、未知字段、BOM、换行与成长阶段保持原样。

括号损坏禁止可视写回。成长阶段配装只读，通用元数据仍可编辑。语义无效组合仍允许保存，诊断数据只在后台参与校验，不在工作台渲染；语法、版本、歧义和边界错误 fail closed。

### 3. 分层定义、候选和静态属性

`definitions.ts` 复用 `loadShipIconCatalog` 的文化/实体索引，并补充无 icon 船型、区段细节、任意根 key 的槽位模板、部件、核心集合和科技。变量采用“`common/scripted_variables` 全局值 + 当前文件局部覆盖”，避免一个文件的局部 `@corvette_hp` 污染其他文件。CSV 只补明确的 `power` 字段，不把每轮攻击伤害冒充日均伤害。

`slots.ts` 生成区段与 utility 槽位、兼容原因、填槽操作和声明式模型树。尺寸、类型、船级、船型、互斥与数量限制都返回具体原因；UI 只请求并显示兼容项，没有“显示不兼容选项”开关。填槽只修改兼容空槽。拖放使用独立的 `shipDesignDropCompatibility`，额外拒绝固定落点；Host 重建当前视图并校验后才把 `drop-component` 转换为 `set-component`，不信任 Webview 状态。

`stats.ts` 汇总船型、区段、已装部件和核心组件的费用、维护、建造时间、能量、船体、防御、闪避、速度、传感和有依据的日均伤害。每项返回 `known/partial/unknown`、已知小计、来源和未解析表达式；动态国家修正与未知公式不按零处理。

### 4. 可解释的离线草稿

`generator.ts` 按角色标签、可静态求值的权重、科技 tier 和允许集合内的升级链选择区段与部件。科技范围支持全部、初始和自定义前置闭包；升级环与能量修复有固定上限。特殊核心集合之外的现有 required components 被保留，能量修复仍受科技、船型和船级约束。

条件 `ai_weight` 只使用静态基础分并给出警告，运行时 `potential/valid_for_country` 不伪装求值。生成结果通过同一个 `replace-loadout` 操作应用到 Host 草稿，设置 `auto_gen_design=yes`；只有显式保存才写回源文档，也不声称复刻引擎 auto-best。

### 5. 本地化显示与原始 key 写回分离

`localisation.ts` 先查 `IndexService`，再按既有语言优先级扫描分层语言文件，支持原样/大写 key、`$reference$` 展开、富文本清理和缺失回退。每个语言最多读取 512 个文件、缓存 200000 条；Host 跨候选请求复用缓存，保存本地化文件时失效。

设计下拉/树、船型、区段、槽位芯片、属性和候选显示译文；候选可同时显示原 key。编辑表单、操作载荷和写回始终使用原始脚本 key，不把译文写进 PDX。

### 6. 共享三维运行时与真实 locator 组装

`entityModelRuntime.ts` 从 Entity Preview 抽取 DDS、材质、几何和定位器公共实现，旧面板改为导入共享模块。`shipDesignScene.ts` 不新增 pdxmesh 解析器，使用既有 `pdxMeshParser`、`pdxLocatorRotation` 和 `SkyboxEnvironment`。

模型数据流为：`global_ship_design` → 设计/区段/槽位视图 → `ship_size` 根组/根实体 → `section_slots` locator → section entity → `component_slot` locator → 武器 entity；同一视图同步驱动设计树、槽位带和属性，Host 按代际提供 mesh、纹理和 attach。诊断仍随协议传递供后台校验，但不渲染成面板或视口列表。

根实体存在时，区段必须按 `section_slots` locator 挂载；只有声明根实体却缺 locator 才警告。护卫舰这类单区段船体使用合法空根组，区段直接位于原点，不制造“root 不可用”或“缺 part1”误报。部件按 `tags` 中的 `weapon_type_*` 选择槽位实体映射，`type=instant` 不再误用为模型类型。二维槽位 `position/rotation` 永不进入世界矩阵。

同一设计的草稿刷新采用增量组装：共享 `shipDesignModelNodeKeys` 把节点自身字段与父节点键组合成身份键，区段变化会自然传导到其子部件。场景在设计 ID 与 `assetRevision` 不变时保留“已加载且键未变”的节点，只回收和重建其余节点，不重置 `autoFit`、不重新取景；Host 用同一键记录已发送资源，只发送新键，Webview `ready`、切换设计或资源缓存失效（`assetRevision` 递增）时整体重建。Webview 在同设计快照到达时保留旧视图和场景直到新视图到来，组件库刷新期间保留原列表与滚动位置。否决方案：继续整体 `clearDesign()` 后依赖缓存加速——仍会销毁全部 GPU 资源并出现加载遮罩。

网格传输：`ShipDesignResourceLoader` 优先用数据源 `resolvePath` 生成受 `localResourceRoots` 限制的 Webview URI（`meshUri`），仅在无法解析路径时回退为 base64。场景在构建前按 URI 拉取实体树内全部网格，对同一 URI 的并发请求去重，并以 128 MiB 总量、单个 32 MiB 为上限缓存（超大船体只拉取不常驻）；下载期间节点被新视图替换时丢弃结果。增量组装保留“键未变但仍在下载或等待父节点”的节点，并把旧队列中的待挂载资源转移到新队列，因为 Host 不会重发已送达的键。否决方案：提高 64 MiB 二进制上限——仍会把数十 MB 网格读入 Host 内存并以 base64 经 postMessage 复制。真实 Kuat Mod 中执行者（nebula_executor）的 75.8 MB 主网格此前因超限显示“没有可显示的模型几何体”，修复后正常渲染，见 `ship-design-real-executor-after-1920.png` 与 `ship-design-real-verification.json`。

国际化：命令标题在 `package.nls.json`、`package.nls.zh-cn.json`、`package.nls.zh.json` 三份清单中同步；Webview 文案全部经 `tr(en, zh)` 按 `<html lang>` 切换，场景内部提示经 `text(en, zh)`。Host 侧纯模块保持无 `vscode` 依赖：`ShipDesignEditError` 只携带稳定错误码与英文细节，面板通过 `shipDesign/messages.ts` 的 `shipDesignErrorText` 按错误码映射到显示语言（未知码与普通错误保留原文）；`generateShipDesignDraft` 接收可选 `ShipDesignText` 翻译函数（默认英文），面板传入 `panelI18n.localize`，使草稿说明与警告随 VS Code 显示语言输出；外部修改冲突、填充结果、切换确认与“仅限工作区”警告同样走 `localize`。兼容原因与资源加载警告只用于 Host 内部判断或日志，不在界面展示，因此保持英文。

Host 资源加载支持默认 state、材质覆盖、纹理、scale 与递归 attach，目录、网格、纹理、attach 数量和深度均有界。Webview 资产按节点 ID 和视图 epoch 暂存，乱序到达也能组装；旧代际、未知节点和过期材质任务被丢弃。非致命环境/locator 警告只在场景内部记录，不再显示警告列表或“模型预览受限”；实际资产或操作失败使用可关闭的简短错误条。

### 7. 游戏式 HUD 与组件图标

布局以游戏舰船设计器为参考，而不是 VS Code 通用三栏表单：中央全幅星云视口承载模型，武器槽位在上、utility 槽位在下；右侧只保留设计名、生产、舰船数据和设计级编辑属性，不显示选中部件详情或候选。点击槽位后，左下面板从设计树切换为组件库，可返回设计；组件库只含兼容项，并显示图标、右侧尺寸徽章和译名，原 key 位于 tooltip。桌面组件库宽 340–420px、接近全高，候选为 40px 单行；中央视口在组件库打开时让出相应宽度，避免槽位被遮挡。普通设计树仍保持紧凑。工具栏按钮采用 GUI 编辑器式 VS Code 中性色和 5px 圆角，保存仅在可保存时突出主色。

`shipDesign/sprites.ts` 以同一套 PDX 定义节点解析直接 sprite 和 `sprite_sheet_sprite_type` 引用，按 `default_frame/icon_frame` 取帧，使用既有 DDS/TGA 解码器输出 data URI。图标缓存最多 256 项、纹理缓存最多 16 MiB，Mod 优先、缺失时回退到尺寸徽章与空槽提示，不影响组件 key 或写回。

整体布局参照游戏舰船设计器：组件库为左侧全高“增加部件”面板（标题栏关闭按钮、提示、填充按钮、筛选区，控件只建一次以保持搜索框焦点），未选槽位时隐藏；设计列表改为视口下方按船型分组的卡片条（含其他工作区文件，最多 100 张），由工具栏“设计列表”开关；原左下设计树与槽位树移除，区段与槽位从视口槽位条进入。“填充全部”是组件库标题区的拖放按钮，默认覆盖已装备槽位，勾选“仅填充空槽”时保留；Host 的 `fillShipDesignSlots` 在工作副本上逐槽校验，固定槽位不动。组件库筛选在 Webview 完成：名称/键搜索、按 `shipDesignComponentTiers`（`upgrades_to` 链深度，循环与超长链有界）筛等级、隐藏列表中已有升级版的淘汰部件、按名称或等级排序，以及“隐藏原版部件”：目录为每个部件记录 `sourceFile`，Host 通过分层数据源的 `resolvePath` 定位实际文件，落在任一工作区根内为 `mod`（Mod 覆盖原版同路径文件时也算 Mod），否则为 `vanilla`，按文件缓存并随目录重建清空；筛选条件写入 Webview 状态。真实 Kuat Mod 的 1631 个部件中 125 个判定为 Mod、1506 个为原版、0 个未知。否决方案：保留中央“填满空槽”投放区——与游戏位置不一致且只能填空槽。

手持放置：组件库中点击“部件”类候选不再立即装备，而是进入手持状态——光标旁的 `.sd-cursor-icon` 跟随指针，Webview 发送 `request-compatible-slots`，Host 用 `shipDesignPlaceableSlotIds`（放置校验通过且未装同一部件）返回槽位 ID 并高亮，其余槽位变暗；点击高亮槽位发送 `drop-component`，草稿刷新后重新请求高亮，可连续放置；右键、Esc、关闭组件库或选择必需部件时取消。从底部卡片切换设计时保留组件库：快照记录原目标，新视图到达后按同名同尺寸、同类型同尺寸、同类型、首个槽位的顺序重新定位（必需部件按同集合，分段按同槽位），定位期间组件库只显示加载提示，避免对旧设计的目标写入。视口顶部“船型 · 文化”标签移除，区段槽位与视角按钮上移；槽位层使用 `justify-content: safe center`，区段溢出时首列不会被裁切到不可滚动区域。否决方案：保留“点击即装备”——无法连续装备多个槽位，也与游戏交互不一致。

必需部件以视口右侧竖排图标栏呈现：`buildShipDesignRequiredSlots` 先按船型 `required_component_set` 顺序生成 `required:set:<集合>` 位（未填为空位），再把其余 `required_component` 列为 `required:extra:<n>`；无集合的条目只读。点击图标打开同集合候选，拖放或点击发送 Host 专用的 `set-required-component`，Host 重建槽位并校验集合、隐藏和船级/船型限制后改写列表。检查器中的必需部件文本框已移除，左右区段槽位为图标栏让出右侧空间。否决方案：保留文本框——无法提示集合与图标，也不能拖放。

槽位使用 46px 图标按钮、S/M/L/A 等尺寸徽章和键盘选择；tooltip 只含槽位与当前部件，不含诊断原因。组件可拖到空槽或已装备槽位进行添加/替换，也可拖到中央“填满空槽”投放区批量填入兼容空槽；点击候选保留为键盘和无拖动环境回退。多个区段按列从左到右排列，每列内部每行最多 5 个组件，14 个组件显示为 5/5/4，空间不足时横向滚动。上下槽位层各以 `calc(50% - 6px)` 为最大高度并保持 `pointer-events: none` 与横向滚动；每个 `.sd-strip` 零件簇以 `max-block-size: 100%`、纵向 `overflow-y: auto` 和 `overscroll-behavior: contain` 提供可拖拽滚动条，让 30 个以上组件形成的多行网格可滚动选择，簇间空白仍穿透到三维 CANVAS。视口与右侧均不显示诊断列表。默认相机距离系数为 1.28，并将观察中心下移 `radius * 0.12`，使模型略缩小、上移，避免左下设计面板遮住船头。样式保留 VS Code 焦点和 reduced-motion 行为，窄视口改用上下分区。

### 8. inline 参数化组件与区段分组

`common/inline_scripts` 先建立 `InlineScriptTemplate` 注册表，`extractTargetingFields` 提供模板块调用，`expandInlineScriptFields` 回填参数化 key。另建通用原始字段映射，因为索敌专用注册表不保留 icon/size，并且通用 tokenizer 会略去 `$`；原始行解析只收顶层标量，保留 `$param$` 和 `@[...]` 原文，再复用 `resolveInlineText` 与 `evaluateInlineExpression`。顶层显式 key/size/icon/power 始终优先，无法收敛的表达式进入目录警告。

区段按列从左到右排列，列内按 5 个组件分组换行，避免把 14 个组件压成一长行，也避免把区段按上下行堆叠。该分组只改变展示，槽位 ID、候选与写回顺序不变。

真实 Kuat Mod 验证中，`ED_HEAVY_TURBO_3_B` 从 `KEY = "ED_HEAVY_TURBO_3_B"`、`SIZE = large`、`ICON = "GFX_ship_part_sws_quad_turbolaser_green_05"`、`SET = "ED_HEAVY_TURBO_3_B"`、`MULT = 8` 展开为 size=large、componentSet=ED_HEAVY_TURBO_3_B、power=-24；未知组件与尺寸不兼容诊断均为空。

## Alternatives considered

- **调用游戏内原生 auto-best**：否决。离线 Mod 编辑不应依赖游戏、DLL 注入或 Named Pipe；原生算法和动态作用域也不能在未取证时伪造。
- **整份文件重新序列化**：否决。会破坏注释、未知字段、成长阶段和无关格式，并使多设计文件的最小 diff 无法保证。
- **照搬舰船图标的原点合并**：否决。该简化只服务剪影；真实 Mod locator 可以非零，必须按根与区段的实际变换组装。
- **复制 Entity Preview 的 mesh/材质代码**：否决。多份实现已在 locator 和 shader 修复中产生漂移风险，因此抽取共享运行时并保留旧面板回归。
- **禁止一切无效设计保存**：否决。用户明确需要自由构造无效组合；工作台只提供兼容候选且不再显示诊断，但后台仍计算兼容性，语法与版本校验继续 fail closed。
- **把本地化译文作为设计名写回**：否决。`name/template` 是脚本 key，译文只用于显示，写回必须保持引用稳定。
- **用通用 tokenizer 直接展开 inline 通用字段**：否决。它会略去 `$`，把 `$ICON$` 变成字面量 `ICON`；通用原始行映射保留参数文本，索敌专用展开与通用字段补全分开处理。
- **每个区段只占一行或把每个组件单独成一列**：否决。前者在大量组件时挤压成不可读长行，后者破坏区段列结构；改为区段列内每行最多 5 个。
- **新增第四套 pdxmesh 解析器或公开 MCP 工具**：否决。本功能是内部可视编辑器，复用现有解析与 Host 边界，不改变 MCP schema 或发布子模块。

## Consequences

- 用户可以在同一工作台完成工作区设计切换、模型检查、区段/部件拖放或点击编辑、中央批量填槽、离线草稿、属性来源检查和显式保存；中文设计与部件名不再裸露为 key。
- 原版实载验证覆盖 319 个船型、483 个区段、1394 个部件和 679 项科技。示例护卫舰得到 7 个槽位、1 个区段与 3 个正确定位器武器模型，无诊断；建造时间 60、船体 200、护甲 200、护盾 100、能量 +10 均为已知静态值，日均伤害保持未知。
- 自动化覆盖文档补丁、变量作用域、CSV power、候选/填槽、拖放协议、固定落点拒绝、生成器、资源循环、本地化、属性、层级矩阵和脏文档安全。`ShipDesignDraftSession` 回归验证编辑/撤销不写源文档、外部冲突保留草稿，面板契约验证保存是唯一写回入口。舰船测试共 41 项；三维共享重构同时运行 Entity 相关回归。
- 视觉证据为 `artifacts/ui/ship-design-after-1920.png`、`ship-design-after-1280.png` 和 `entity-preview-after-1280.png`，均使用真实原版网格与纹理；新工作台验证简中名称且控制台零错误，Entity After 显示真实实体树、1924 个三角形、2119 个顶点和 6 个 locator，控制台仅有既有 Three.js Clock 弃用警告。新工作台和 Entity Preview 都没有可靠的同场景历史 Before，因此明确采用 After-only，不伪造基线；Entity 共享重构另由同面板相关回归守护。
- 游戏式 HUD 的 Before/After 为 `ship-design-before-hud-1920.png`、`ship-design-before-hud-1280.png` 对比 `ship-design-hud-after-1920.png`、`ship-design-hud-after-1280.png`，使用同一护卫舰、真实组件图标和 `ship_designer` 星云。CDP 精确选择验收 URL 并等待异步解码后截图，避免 worker 尚未完成时的假黑底，也不以静态背景替代真实运行时。
- 组件库重构沿用上述 HUD 截图作为 Before，After 为 `ship-design-library-tree-after-1280.png`、`ship-design-library-tree-after-1920.png`、`ship-design-library-after-1280.png` 和 `ship-design-library-after-1920.png`。CDP 原生鼠标拖放分别产生 `drop-component` 与 `fill-empty-slots`，点击回退产生 `set-component`；两种分辨率均只显示两个兼容候选、无诊断 DOM、右侧无部件详情、控制台零错误，14 个武器槽位仍为 5/5/4。机器可读结果保存在 `ship-design-library-verification.json`。
- 隐藏原版部件：勾选后 Mock 候选从 11 个降为 8 个（隐藏 3 个原版），刷新页面后勾选状态保留，控制台零错误，见 `ship-design-hide-vanilla-1280.png` 与 `ship-design-hide-vanilla-verification.json`。
- 手持放置 Before 为 `ship-design-game-ui-library-1920.png`，After 为 `ship-design-place-armed-1280.png` 与 `ship-design-place-switch-1280.png`：手持后 42 个可放置槽位高亮、其余变暗，连续两次点击各发出一次 `drop-component` 且保持手持，右键取消后高亮清零；切换到第二个设计后组件库仍打开并定位到同名槽位，源写入为 0，控制台零错误，见 `ship-design-place-verification.json`。
- 游戏式布局 Before 为 `ship-design-required-after-2000.png`、`ship-design-required-library-1280.png`，After 为 `ship-design-game-ui-1280.png`、`ship-design-game-ui-1920.png`、`ship-design-game-ui-library-1920.png`：组件库标题/提示/填充按钮/筛选正确，隐藏淘汰后显示 11/12，搜索与等级筛选生效，拖入与点击填充分别发出 `replaceEquipped: true/false`，源写入为 0，控制台零错误，见 `ship-design-game-ui-verification.json`。
- 必需部件栏 Before 为 `ship-design-draft-library-after-1280.png`（检查器文本框），After 为 `ship-design-required-after-1280.png`、`ship-design-required-after-2000.png` 与 `ship-design-required-library-1280.png`：6 个图标竖排、与上下槽位重叠 0、检查器无文本框；拖放与点击均发出 `set-required-component`，组件库保持打开，源写入为 0，控制台零错误，见 `ship-design-required-verification.json`。
- 增量组装 Before/After 由 `ship-design-incremental-verify.js` 通过 WebGL 缓冲计数采集：修改前替换一个武器删除并重建全部 25 个模型缓冲，出现加载遮罩且组件库清空；修改后替换与撤销均只删除/重建 5 个（单个武器），场景隐藏、加载遮罩、组件库清空次数均为 0，源文档写入仍为 0。结果见 `ship-design-incremental-before.json`、`ship-design-incremental-after.json`。
- 草稿事务与紧凑布局的 Before 使用 `ship-design-library-height-after-2000.png`，After 为 `ship-design-draft-library-after-1280.png` 和 `ship-design-draft-library-after-2000.png`。12 个候选均为 40px 单行，1280 下面板为 340×730，2000 下为 340×1055；拖放、批量填槽、点击编辑、撤销和重做后的 `sourceEditCount` 均为 0，保存后为 1，组件库始终打开且控制台零错误。结果保存在 `ship-design-draft-verification.json`。
- 大槽位滚动回归使用 45 个武器槽与 12 个公用槽、1280×800 同场景 Before/After：修复前原始 43%/hidden 几何无滚动条、滚轮与拖拽后 scrollTop 均为 0 且 GUN_45 被裁切；修复后零件簇 clientHeight/scrollHeight 为 301/450、滚动条宽 10px，滚轮和原生拖拽后 scrollTop 均为 149，GUN_45 可见且可打开候选。三段布局的簇间空白命中 CANVAS，控制台无错误。证据为 `ship-design-slot-scroll-before.png`、`ship-design-slot-scroll-after.png` 与 `ship-design-slot-scroll-verification.json`。
- 发布布局修复：实际扩展根与仓库开发根不同，Webview 必须沿用 GUI/Entity 的 `extensionPath/bin/client/webview`，不能写成 `extensionPath/release/bin/client/webview`。错误路径会让实际 HTML 的 JS/CSS 全部 404，表现为无工具栏的整页黑屏；`shipDesignPanelContract.test.ts` 同时守住路径一致性和发布资产存在性。
- 已知边界：不编辑船型/区段/部件模板和资产 locator，不编辑成长阶段配装，不实现玩家存档设计、游戏内 auto-best、动态国家属性完全复刻或逐像素游戏 Shader。无 WebGL 时仍保留二维编辑；实际资源或操作失败才显示简短错误。