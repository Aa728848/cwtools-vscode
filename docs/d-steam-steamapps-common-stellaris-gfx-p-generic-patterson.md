# Stellaris 粒子特效 可视化 + 编辑器

## Context（背景与目标）

Stellaris 的粒子特效（`gfx/particles/**/*.asset` 中的 `particle={...}` 定义）目前在本插件里只有语法校验，没有任何可视化。游戏内置的 Particle Editor（见 `docs/ui_picture.png`：三栏布局——左侧控制 + 动画曲线编辑器、中间 3D 视口、右侧属性面板）封闭在 exe 内无法调用，模组作者只能盲改文本。

目标：在插件内独立复刻一个**完整的粒子可视化 + 编辑器**——既能实时渲染粒子模拟预览，又能像游戏内编辑器一样编辑全部参数、动画曲线、增删子系统，并写回 `.asset` 文件。它作为一个独立的 Webview 侧栏面板，**克隆现有 `EntityPanel ↔ entityPreview` 的成熟模式**（Three.js 0.184 webview 栈），而不是新造架构。

**用户已确认的三项决策：**
1. **交付范围 = 完整编辑器**：预览 + 右侧属性编辑 + 动画曲线编辑器 + 子系统增删改 + 写回保存，一次性对标游戏内编辑器全部能力（下方"构建顺序"是单次工程内的实现阶段，而非分批交付）。
2. **Vanilla 文件 = 引导另存到 mod**：只读 Stellaris 安装目录下的文件可预览；一旦编辑，引导"另存副本到当前 mod 的 `gfx/particles/`"，绝不直接改写游戏本体。复用 `EntityPanel` 的 workspace 写守卫。
3. **UI 风格 = VS Code 原生改编**：沿用游戏内编辑器的三栏信息架构与字段分组，但用 VS Code 主题色、可折叠分组、原生控件，融入编辑器（不做像素级还原）。

## 技术路线

- **宿主侧（Node/Extension Host）**：解析 `.asset` → 类型化模型；用 `ddsDecoder` 解码粒子贴图 → data URL；`graphicsFeatures` 搜索根（workspace + vanilla `cwtools.cache.stellaris`）解析贴图路径；通过 `WebviewPanel.postMessage` 下发模型 + 贴图；接收编辑消息并以 `WorkspaceEdit` 写回。
- **Webview 侧（浏览器沙箱，Three.js）**：纯 CPU 粒子模拟 + `InstancedBufferGeometry`/`ShaderMaterial` 实例化渲染（每个 subsystem 一次 draw call）；Canvas 2D 动画曲线编辑器；右侧属性面板。所有文件 I/O / DDS 解码留在宿主侧（webview 不碰 fs）。
- **写回策略 = 混合**：数值微调走**外科式行内替换**（每个叶子值带 `span`，保留该字段原始数字格式风格）；结构性增删/重排走**整块 `particle={}` 重序列化**。原因：真实 vanilla 文件数字格式不统一（`255` / `255.000` / `1.000000` 并存），整文件重排版会污染 diff。

## 新增模块

### 宿主侧 `client/extension/`
| 文件 | 职责 |
| --- | --- |
| `particlePanel.ts` | `class ParticlePanel`：克隆 `EntityPanel`——拥有 WebviewPanel、生命周期、消息总线、加载文件 + 解析后贴图 map、Save/写回、vanilla 另存守卫 |
| `particleAssetParser.ts` | `parseParticleFile(text, filePath) → ParticleParseResult`：token → 类型化 `ParticleEffect[]`，处理 `,curve` 后缀与 `{ a b }` 范围；每个叶子带行/偏移 `span` |
| `particleAssetSerializer.ts` | 忠实 Paradox 格式化器 + 外科助手：`serializeEffect/Subsystem/Animation/Force`、`formatNumber(n, style)`、`serializeAnimatedValue/Range`、`replaceFieldSpan()` |
| `particleSniff.ts` | `classifyAssetFile(text) → 'particle' \| 'entity' \| 'unknown'`：换行容忍正则/分词，区分共享 `.asset` 的两类文件 |

### Webview 侧 `client/webview/`
| 文件 | 职责 |
| --- | --- |
| `particlePreview.ts` | 入口：三栏 DOM、Three.js 场景/网格/Orbit、`acquireVsCodeApi` 桥、播放控制、逐帧 update→render、全局 dispose、i18n（沿用 entityPreview 的 `body.dataset.locale` + `i18n{en,zh}` + `data-i18n`） |
| `particleSimulation.ts` | 纯 CPU 模拟：每 subsystem 一个 `ParticleSystemSim`（SoA 池、spawn/emission/life/duration、yaw/pitch+spread 求速度、力积分、曲线采样）。**不 import THREE**，可单测 |
| `particleRenderer.ts` | THREE 桥：每 subsystem 一个 `InstancedBufferGeometry + ShaderMaterial`；混合模式、flipbook UV、billboard vs 朝向；GPU 资源 dispose |
| `curveEditor.ts` | Canvas 2D 交互曲线编辑器 + `evalCurve(points, t)`（**与 simulation 共享**的唯一求值实现） |
| `inspector.ts` | 由 `Subsystem` 构建右栏控件，发出类型化 `fieldEdit` 增量（步进器、枚举下拉、复选框、范围 a/b、颜色选择、`,curve` 绑定下拉） |
| `particleTypes.ts` | 共享接口（见下），零依赖，宿主与 webview 同时 import |
| `particlePreview.css` | 三栏 grid 布局，全部用 VS Code 主题变量 |

### 配置
- `.config/tsconfig.webview-particle.json`：克隆 `tsconfig.webview-entity.json`，`include` 上述 webview 模块 + `vscode.d.ts`，并在 `exclude` 互斥其它 webview 入口（同时把 `particlePreview.ts` 加入其它 webview tsconfig 的 exclude）。

## 数据模型（`particleTypes.ts`）

每个数值字段都是 `AnimatedValue`（任何标量都可带 `,curve`）；每个范围字段是两者的 `Range`；颜色通道本身也是 `Scalar`。每个叶子挂 `Span` 用于外科编辑与诊断。

```ts
interface Span { line: number; endLine: number; startOffset: number; endOffset: number; }
interface AnimatedValue { value: number; curve?: string; rawStyle?: 'int'|'fixed3'|'fixed6'|'raw'; span?: Span; }
interface Range { a: AnimatedValue; b: AnimatedValue; span?: Span; }
type Scalar = AnimatedValue | Range;
interface ParticleColor { r: Scalar; g: Scalar; b: Scalar; alpha: Scalar; span?: Span; } // x/y/z=RGB 0-255
interface ParticleTexture { file: string; x: number; y: number; shader: string; span?: Span; }
interface Subsystem { /* name,maxAmount,emitterType,sort,布尔组,position,sphere/box发射器,
  emitterYaw/Pitch,texture,color,start,duration(-1=无限),life,emission,
  emissionPulse*,velocity(+Yaw/Pitch),size,mass,rotation+particleYaw/Pitch/Roll,
  rotationSpeed(+Yaw/Pitch/Roll),force(名),childsystem?,unknown[](round-trip兜底),span */ }
interface AnimationCurve { name; start; duration; repeat; minValue; maxValue;
  points:{x:number;y:number}[]; op:'MUL'|string; time:'life'|'life_abs'|'system'|'spawn'|string; span }
interface Force { name; type:'planar'|'friction'|'point'|'spin'|'turbulence'|'vortex'|string;
  position?:[number,number,number]; direction?:[number,number,number]; localForce?; yaw?; division?; amount?:Scalar; span }
interface ParticleEffect { name; scale?; subsystems:Subsystem[]; animations:AnimationCurve[]; forces:Force[]; span }
interface ParticleParseResult { effects:ParticleEffect[]; diagnostics:{message;line;severity}[] }
```

字段全集以 `submodules/cwtools-stellaris-config/config/gfx/particles.cwt` 为准（含 `sort`/`spritesheet_animation(_loop)`/`mass`/`box_emitter_*`/`emission_pulse_*`/`rotation_speed_yaw/pitch/roll`/`start`/`particle_roll`/`childsystem`，力类型 6 种，`animation.time`/`op` 枚举）。**模型必须无损保存全部字段**（即便模拟只近似其中一部分），未识别键塞进 `unknown[]` 原样回写。

## 解析器（`particleAssetParser.ts`）

- 复用 `client/extension/pdxTokenizer.ts` 的 `tokenize()` 与 `client/extension/entityAssetParser.ts` 的递归下降骨架（`ParseCtx{tokens,pos}` + `peek/advance/expect/skipBlock`）。
- **给 `tokenize()` 增加可选 `comma?: boolean` 标志**（默认 false → `guiParser`/`entityAssetParser`/`solarSystemParser` 完全不受影响）：开启后把 `,` 作为 `Comma` token 发出，使 `value,curve` 与范围成员明确可分。粒子解析器调用 `tokenize(text, { comma: true })`。同时给 `Token` 加 `startOffset/endOffset`（小改动）以支持精确 span。
- 核心通用读取（贯穿所有数值字段）：`readScalar`（遇 `{` → `readRange`，否则 `readAnimatedValue`）；`readAnimatedValue` 读数字后若紧跟 `Comma` 则吞掉并读曲线名；`readRange` 读 `{ a [b] }`，容忍少见 3–4 元素。
- `color={...}` 子键 `x/y/z/alpha` 各走 `readScalar`（覆盖 `x={ 80 10 }`、`alpha=255,flare_fade`）；`texture` 读 `file/x/y/shader`；`curve={ ... }` 扁平数列配对成点；`force` 的 `position/direction` 是 3 浮点块。
- 顶层 dispatch 仿 `parseAssetFile`：遇 `particle` + `=` 解析一个 effect，内部分发 `subsystem/animation/force/name/scale`。每块 try/catch → 推诊断 + `skipBlock` 继续（对 mod 笔误鲁棒）。支持一个文件多个 `particle={}`（少见）→ effect 选择器（仿 EntityPanel 的实体下拉），默认首个。

## 模拟与渲染引擎（webview）

**模拟（`particleSimulation.ts`，CPU）**：每 subsystem 一个 `ParticleSystemSim`，固定 SoA 池（容量 = `maxAmount`，封顶 ~256），逐帧 `update(dt)` 做 spawn + 积分 + 退役，`writeInstances(out)` 写实例缓冲。语义（**均为对封闭引擎的近似，视口需标注"近似模拟"**）：
- 发射：`emissionAcc += sample(emission)*dt`；尊重 `start` 延迟、`duration`（`-1`=持续，>0=爆发后停）、`emission_pulse_*` 占空比。
- 生命：`life = base + (seed*2-1)*spread`，`age>=life` 退役。
- 初始位置：按 `emitter_type`（point=`position`；sphere=`sphere_emitter_*` 锥内随机；box=`box_emitter_*` 均匀）。
- 初速：`velocity_yaw/pitch{base spread}` 球→笛卡尔方向 × `velocity` 大小；`emitter_yaw/pitch` 旋转基。
- 力（逐帧求和）：`friction`→`v*=(1-amount*dt)`；`planar`→沿 `direction` 恒定加速；其余（point/spin/turbulence/vortex）v1 占位但保留数据。
- 曲线：有效值 = `base * evalCurve(curve.points, clamp01(age/life))`（`op=MUL`），作用于 size/alpha/color；`evalCurve` 从 `curveEditor.ts` **共享**。
- 旋转：`rot += rotSpeed*dt`；flipbook 帧 = `floor(progress * x*y)`；`billboard=yes` 朝相机，`billboard=no` 按 `particle_yaw/pitch/roll` 朝向；每粒子 seed 保证拖动滑块不重洗粒子场。

**渲染（`particleRenderer.ts`）= 每 subsystem 一个 `InstancedBufferGeometry + 自定义 ShaderMaterial`（一次 draw call）**。逐实例属性：`instancePos/Size/Rot/Color/Alpha/Frame`。顶点着色器构建 billboard/朝向四边形并按 `instanceFrame`+网格 uniform 选 flipbook 子矩形；片元采样 × color/alpha。混合：`ParticleAdditive`→`AdditiveBlending`，`ParticleAlphaBlend`→预乘 `NormalBlending`；`depthWrite=false; transparent=true`。
- **为何不用** `THREE.Points`（无逐粒子旋转/非方形/flipbook UV 受限）或 `THREE.Sprite`（每粒子一 draw call + 逐帧矩阵）：粒子数为数百，实例化四边形是正确量级。
- 逐帧：`sim.update` → `writeInstances` → 实例属性 `needsUpdate=true` → render。复用 entityPreview 的可见性暂停（`document.hidden`）与 `textureCache`；每张 flipbook DDS 仅解码一次。

## 曲线编辑器（`curveEditor.ts`）

- **Canvas 2D**（非 SVG）：拖拽时低成本重绘。画轴/网格/插值折线/可拖手柄；X/Y 归一 [0,1]，`minValue/maxValue` 标注 Y；`start/duration/repeat` 为旁置数值输入。
- 交互：拖动（x 夹在邻点间、y∈[0,1]）；双击空白加点；右键/Del 删点；首末 x 锁 0/1。
- **共享求值（唯一真相源）** `evalCurve(points, t)`：**单调三次插值（Fritsch–Carlson）**——过每个控制点且不过冲（避免 alpha>1 / 负 size 闪烁）。端点 clamp。拖点发去抖 `curveEdit`，同时驱动实时模拟与待写回模型。

## 属性面板与写回（`inspector.ts` + `particleAssetSerializer.ts` + panel）

**两类编辑：**
1. **数值微调**（步进器/曲线拖动/复选框）→ **外科式 span 替换**：叶子的 `span` + `formatNumber` 保留该字段实测风格（int 维持 int、`fixed3` 维持 `fixed3`），`WorkspaceEdit.replace` + `doc.save()`。完全复刻 `EntityPanel` 的 locator 写回（`Range` replace + `applyEdit` + `save` + `_skipNextReload`）。保留注释/花括号风格/无关格式。
2. **结构性操作**（增/克隆/删/重排 subsystem，增删 animation/force）→ **仅重序列化受影响的 `particle={}` 块**，替换 effect 的 `span`。把重排版限制在被改的块内，兄弟 `entity={}`/其它粒子保持字节一致。

**忠实格式化器**：Tab 缩进、一字段一行、嵌套 +1；`formatNumber(n, style)` 按字段捕获风格；`serializeAnimatedValue` 输出 `value` 或 `value,curve`（逗号无空格）；`serializeRange` 输出 `{ a b }`；`curve` 由点扁平化；bool→`yes/no`；`unknown[]` 原样回写。

**保存流**：webview 攒待写模型 → 发 `fieldEdit`/`curveEdit`/结构消息（实时驱动模拟，无需 render 往返）→ `ParticlePanel.onDidReceiveMessage` 应用 `WorkspaceEdit`（置 `_skipNextReload`）→ `onDidSaveTextDocument` 监听重解析重推 `render`（除非 skip 标志）。Undo/Redo 按钮聚焦文档跑 VS Code `undo`/`redo` 再重渲染（原生撤销栈为真相源，复刻 EntityPanel）。

**Vanilla 另存**：复用 `EntityPanel` 守卫（`pathScope.ts` 的 `isPathInsideOrEqual` 比对 `workspace.workspaceFolders`）。对非 workspace 文件首次编辑：拦截写入 → 警告 → `showSaveDialog` 默认 `<modRoot>/gfx/particles/<name>.asset` → 写完整序列化文件 → 打开并把面板重指向新文件。3D 预览始终允许（只读）。

## 面板接入与命令

- **命令** `cwtools.previewParticle`（title 走 `%commands.cwtools.previewParticle.title%`、category `cwtools`、icon `$(sparkle)`），在 `client/extension/extension.ts` 用 `safeRegisterCommand` 紧挨 `previewEntity` 注册。
- **内容嗅探**：handler 读 `doc.getText()`，要求 `classifyAssetFile()==='particle'`，否则提示"该 .asset 不含粒子定义（可能是实体资源）"并退出。**菜单 `when` 不能按路径判断**——`gfx/particles/_particle_entities.asset` 全是 `entity={}`，必须运行时按内容嗅探（换行容忍正则，兼容 Allman `particle=\n{`）。
- **菜单**：`release/package.json`（**确认：命令/菜单/title 贡献都在 `release/package.json`，根 `package.json` 不含**）→ `contributes.menus.editor/title` 加 `{ "command":"cwtools.previewParticle", "when":"resourceExtname == .asset", "group":"navigation" }` + `contributes.commands` 加条目。与现有 `previewEntity` 共存于 `.asset`（VS Code `when` 读不到内容，按扩展名共存 + 运行时嗅探消歧）。
- **双向实时同步**：`fieldEdit`/`curveEdit`/结构消息就地修改 webview 内存里的 `ParticleEffect` 与对应 `ParticleSystemSim`（改 `emission` 下帧即生效；加 subsystem 新建 sim+渲染批；删则 dispose 该批）。仅外部保存后宿主才重推 `render`。
- **Rollup**：`rollup.config.mjs` 克隆 Entity 块（含 `resolve({browser:true})` + `commonjs()` + `copyFile('...particlePreview.css', ...)`），输出 `release/bin/client/webview/particlePreview.js`。
- **能力开关**：`client/extension/gameProfiles.ts` 的 `PreviewCapabilityProfile` 加 `particlePreview: boolean`（Stellaris=true，其余=false，更新 `NO_PREVIEWS` 常量）。
- **Dispose**：webview `command:'dispose'` 停 RAF + dispose 每 subsystem 的 geometry/material/texture（复刻 `entityPreview.ts#disposeAll`）；宿主 `ParticlePanel.dispose()` 清静态 `currentPanel`、发 dispose、销毁 panel + `_disposables`。

## UI 风格（VS Code 原生改编）

三栏 grid：左=子系统下拉 + 主控（Save/Undo/Redo/Exit）+ 子系统操作（Add/Clone/Forward/Back/Remove）+ 动画曲线编辑器 + Force 区；中=网格地面 + Orbit + 实时模拟 + 播放条（play/pause/restart/loop/timeline）；右=选中 subsystem 的属性面板（可折叠分组：General / Emitter Position & Rotation / Particle / Behavior，步进器/枚举下拉/复选框/范围对/颜色选择/`,curve` 绑定）。**全部用 VS Code 主题变量**（不硬编码颜色），支持 `prefers-reduced-motion`。

## 构建顺序（单次工程内的实现阶段）

- **P0 骨架 + 解析**：建空文件 + `particleTypes.ts`；`tokenize({comma})`；`particleAssetParser.ts`；命令/菜单/rollup/tsconfig/能力开关；面板能打开空三栏（网格+Orbit+子系统下拉）。可测：打开真实 vanilla 文件 → 子系统列表 + 只读值正确，实体资源被拒。**对 `arc_emitter_muzzle`/`advanced_railgun_hit_effect`/`aquatic_dragon_wing_projectile` 写解析器单测**（断言 `,curve`、`{ a b }`、颜色范围、空 `position`、`duration=-1`、box 发射器）。
- **P1 预览 MVP**：模拟（point + life/emission/velocity）+ 渲染（实例化 additive 四边形、单贴图、billboard）+ 播放控制。可测：glow trail 发射/移动/消亡，播放可控，`max_amount` 下 FPS 正常。
- **P2 曲线 + 完整外观**：`curveEditor` + 共享 `evalCurve` 接入 size/alpha/color；flipbook UV；`ParticleAlphaBlend`；sphere/box 发射器；朝向粒子。可测：`fade_alpha`/`grow`/`lightning_alpha` 生效，拖点即时改模拟，flipbook 动画。
- **P3 属性编辑 + 写回**：`inspector` 控件；外科 `fieldEdit` 写回（风格保留 `formatNumber`）；Save；Undo/Redo；vanilla 另存到 mod。可测：改值产生最小单行 diff、注释保留；parse→serialize 黄金往返测试。
- **P4 结构操作 + 力 + 打磨 + i18n**：增/克隆/前后移/删 subsystem，增删 animation/force，块重序列化；`friction`/`planar` 入模拟（余者占位保留）；Force 区 UI；截图；en/zh i18n。可测：克隆+重排输出可重解析，拖力向量改变运动，全 UI 本地化。

## 复用清单（关键文件与路径）

| 复用 | 路径 | 用途 |
| --- | --- | --- |
| 面板模式 | `client/extension/entityPanel.ts` | 克隆生命周期/消息总线/`WorkspaceEdit`+save+`_skipNextReload`/vanilla 守卫(`isPathInsideOrEqual`)/undo-redo/dispose |
| Three.js webview | `client/webview/entityPreview.ts` | `initThree/animate`、可见性暂停、`loadDDSTexture`+`textureCache`、`i18n{en,zh}`+`data-i18n`、`disposeAll` |
| 递归下降 + 分词 | `client/extension/entityAssetParser.ts`、`pdxTokenizer.ts` | 解析骨架 + 待加 `comma` 标志的分词器 |
| 贴图解码 | `client/extension/ddsDecoder.ts` | `decodeDds/decodeTga → {dataUri,width,height}`（宿主侧） |
| 贴图路径 | `client/extension/graphicsFeatures.ts`、`fsCaseInsensitive.ts` | `resolveAssetPath/getSearchRoots`（workspace+vanilla）、大小写无关回退 |
| 字段全集 | `submodules/cwtools-stellaris-config/config/gfx/particles.cwt` | 数据模型/枚举权威来源 |
| 接入模板 | `rollup.config.mjs`、`release/package.json`、`.config/tsconfig.webview-entity.json`、`client/extension/gameProfiles.ts` | bundle 入口 + 命令/菜单 + tsconfig + 能力开关 |

约束：用 `ErrorReporter`（非 `console.error`）；不硬编码 webview 颜色；写 `.asset` 经 `WorkspaceEdit` 保留编码。

## 文档更新

新增文件后同步：`CHANGELOG.md`、`ARCHITECTURE.md`、`CLAUDE.md` 的 High-Value Paths 表（加 `particlePanel.ts`/`particlePreview.ts` 等行）、`README.md` 功能列表；命令/菜单加入 `release/package.json` 的 i18n title 键（`package.nls.json` / `package.nls.zh-cn.json` 若存在）。

## 验证

- `npm run compile`（TS + Rollup，确认新 webview 入口 bundle 出 `release/bin/client/webview/particlePreview.js`）。
- `npm run lint`、`npm run test:unit`（含新增解析器/序列化器/曲线求值单测）。
- Extension Development Host 端到端：打开 `D:\Steam\steamapps\common\Stellaris\gfx\particles\combat\arc_emitter_muzzle.asset` → 点标题栏 `$(sparkle)` → 三栏面板、粒子渲染、播放；编辑数值/拖曲线 → 视口即时变化；Save → 文件最小 diff；在 vanilla 文件上编辑 → 弹"另存到 mod"；打开 `_particle_entities.asset` → 粒子命令拒绝（仍走实体预览）。
- 关闭面板 → 确认无 WebGL/纹理泄漏（Three.js 资源全部 dispose）。

## 风险与开放问题

1. **模拟保真度**（最高）：spawn 节奏、spread 分布、力常数、`time` 语义为推断。缓解：视口标"近似"、常数可调、逐阶段目视校验、模型无损。**精确复刻非目标**。
2. **往返/格式丢失**：整文件重序列化会改数字格式并丢 `#` 注释 → 故采外科数值编辑 + 块级重序列化 + 逐字段风格捕获 + `unknown[]` 透传 + 黄金往返测试。
3. **`,curve` 歧义**：依赖 `{comma:true}` 标志；兜底（数字后裸标识符即曲线）对所有实测 vanilla 正确。
4. **flipbook 语义**：帧推进规则（按 life 循环？一次？`spritesheet_animation_loop`？）与行列序为猜测 → 暴露 loop/once + 行/列主序开关。
5. **共享 `.asset`**：两个预览命令同现于 `.asset` → 标题清晰 + 嗅探警告互导。
6. **`childsystem` 嵌套与 planar/friction 外的力**：v1 解析+保留但只近似子集，按需再深化。
