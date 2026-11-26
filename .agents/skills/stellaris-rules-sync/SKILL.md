---
name: stellaris-rules-sync
description: >-
  Stellaris 规则与 CWT 语法更新的标准作业规范（SOP）。用于同步游戏脚本文档日志、生成与更新 CWT 规则、严禁滥用 scalar、深入原版反查强类型、补全 Common 字段级与 GUI 未覆盖参数、通过 CWToolsCLI 原版全量实跑区分解析器/引擎漏洞与规则缺陷及原版自身 Bug，并完成全套验证门禁。
---

# Stellaris 规则同步与 CWT 规则库维护技能 (Stellaris Rules Sync Skill)

本技能定义了当 Stellaris（群星）游戏版本更新或脚本文档漂移时，CWTools VSCode 扩展中 CWT 规则库从日志提取、差异对比、强类型定义补全、原版全量实跑三分类归因，到最终校验的完整标准作业规范（SOP）。

---

## 核心原则与底层机制

1. **三阶段更新路径（Three-Phase Path）**：
   - **第一阶段（Log 结合文档同步）**：先同步原版脚本文档中的 Trigger、Effect、Modifier、Scope、Localisation 变动至 `config/logs/` 中的日志文件。严格**仅更新报告中检测到的变动条目**，禁止全量盲目替换，以避免冲掉人工维护的注释排版、裁剪基线与自定义修正。
   - **第二阶段（CWT 语法规则更新）**：在 Log 同步完成后，再同步更新 CWT 规则文件（`triggers.cwt`、`effects.cwt`、`scope_changes.cwt`、`links.cwt`、`common/*.cwt`、`interface/*.cwt`、`gfx/*.cwt`）。
   - **第三阶段（原版全量实跑与三分类归因闭环）**：`rules-sync report` 只检查文档 Diff、Common 顶层键与 GUI 属性，**无法发现**嵌套作用域契约、参数类型标错（`<type>` vs `scope[type]`）、`ordered_*` 可选基数遗漏、`inline_script` 展开异常、`.cwt` 语法破坏，或 CWTools 解析器/验证引擎自身缺陷。必须在第二阶段之后，使用 `CWToolsCLI` 对真实 Stellaris 原版目录执行全量校验，逐簇归因并收口。

2. **Trigger / Effect 支持定义域（Supported Scopes）机制**：
   - 在 `triggers.cwt` 和 `effects.cwt` 中，普通的 trigger 和 effect 的 alias 上**不需要**额外手动标注 `## supported_scopes`。
   - **底层机制**：CWTools 语言服务器在加载配置时，会**自动从 `config/logs/trigger_docs.log`（以及内置日志）中读取每个 Trigger/Effect 的 `Supported Scopes: ...` 字段**，并在内存中完成作用域约束的绑定。
   - **规范约束**：必须确保 `config/logs/trigger_docs.log` 中的 `Supported Scopes` 保持准确；CWT 规则内部只需声明语法参数结构与强类型，无需冗余声明作用域标注（除非该条目为游戏 log 未收录的伪触发器/脚本触发器，或需人工覆盖原版作用域限制）。

3. **严禁滥用 `scalar`，必须深入原版反查强类型**：
   - 严禁为了快速消除扫描警告或字段缺失报错而随意使用 `scalar`！
   - 必须深入原版游戏目录（`<Stellaris 安装目录>/common`、`00_defines.txt` 或 `README` 文档）反查实际调用：
     - 若为特定游戏对象（如 `preset_vassal`、`SMELTING`、超频模式等），必须绑定为具体的强类型 `<type>`（如 `<agreement_preset>`、`<mega_overclock>`、`<tradable_actions>`）；
     - 若为同类对象分组标识符（如 `overclock_group`），必须定义为 `value_set[...]`（如 `value_set[megastructure_overclock_group]`）；
     - 若为动态本地化拼接前缀或键名，定义为 `localisation`；
     - 若为精灵图标键名（如 `icon = "trade_protection"`），定义为 `<sprite>`；
     - 若仅为数值计算或布尔开关，使用 `value_field` / `int` / `float` / `bool`。

4. **引擎事实注释必须原样保留（禁止手改行号）**：
   - `triggers.cwt` / `effects.cwt` 中的 `## cost` / `## engine` / `## engine_evidence` **不是文档注释，而是反编译派生的引擎事实**，由 `tools/engine-cost/` 单独维护，与规则同步是两条链路。
   - 同步规则时：新增 alias **不强制**补标注（覆盖率由成本工具单独负责）；**严禁删除或改写已有的 `## engine_evidence`**。
   - 其中的 `dump L<行号>` 指向某个**特定反编译 dump 版本**。游戏更新后这些行号会整体失效，但**不能手改单条**——必须用 `merge-engine-cost.cjs` 整批重锚（见 [tools/engine-cost/README.md](../../../tools/engine-cost/README.md)）。
   - 成本类标注只允许经 `tools/engine-cost/merge-engine-cost.cjs` 写入：它会在反编译结论与人工细分冲突时**保留人工值**，直接覆盖会把 `o(n)_galaxy`/`script_eval` 等细分降级为普通 `o(n)`。

5. **严格核实属性层级结构**：
   - 在复杂定义（如 `megastructures`、`planet_classes`、`ship_sizes` 等）中添加字段时，必须核实该字段属于根级属性还是子块属性。
   - 例如：巨构的 `nomad_reactivatable`、`custom_tooltip_with_modifiers`、`overclock_loc_key`、`overclock_cooldown` 均为 `megastructure` 的**顶层属性**，绝不可错误嵌套入 `overclock_types = { ... }` 列表子块内。

6. **严守三分类红线，绝不为迁就原版脚本真实 Bug 而放宽规则**：
   - 原版全量实跑暴露的报错必须先读取原版脚本上下文与 `script_documentation` 实证核查，再严格归入以下三类之一：
     - **CWTools 解析器 / 验证引擎漏洞**（修复于 `submodules/cwtools` 并补回归单测）：解析器语法边界限制（如多位数本地化版本号）、宏/条件参数分支 `[[PARAM] ...]` 误报最大基数、合取触发器块 `is_scope_type` 作用域窄化缺失、事件图谱/作用域解析链未读取 CWT 迭代器 `push_scope` 等。
     - **Stellaris CWT 规则 / 日志缺陷**（修复于 `submodules/cwtools-stellaris-config`）：如 4.6 作用域链接漏配、`scope[x]` 误标为 `<x>`、可选字段缺 `## cardinality = 0..1`、嵌套块作用域契约错误、动态/静态 modifier 漏配等。
     - **原版 Stellaris 脚本自身真实 Bug**（**保留报错，禁止放宽规则**）：原版缺失 `}` 语法错、拼写错误、废弃建筑/不存在的 trait/贴图引用、跨作用域误调命令（如 `Colony` 调 `Planet`-only 命令、`Ideology` 漏切 scope 调 `add_modifier`）、effect 块误写 `potential`、无条件块重复键，以及 `CW272` 等有意引擎风险警告。

---

## 标准执行流程

### 步骤 1：运行规则同步扫描与生成报告

```powershell
# 运行规则扫描并生成报告（不自动弹出浏览器）
node tools/rules-sync/stellaris-rules-sync.js report --no-open
```

读取 `.rules-sync/stellaris/report/rules-sync-report.json`，关注以下指标：
- `trigger` / `effect` / `modifier` 的变动数量（`+新增 -移除 ~修改`）；
- `trigger parameters` / `effect parameters`（**命令块内参数键**的漂移，见下方"参数级漂移"）；
- `folders with findings`（未覆盖的 Common 目录或字段）；
- `scope contracts`（缺失的作用域契约）；
- `stale fields`（反向审计：`config/common/*.cwt` 中已被引擎移除或原版不再使用的陈旧字段，需标注 `## severity = warning` + `## error_if_only_match` 或移除）；
- `gui`（原版 `interface/**/*.gui` 未覆盖的控件类型/属性键，以及 7 个关键外交与 Mod `custom_gui` 事件窗口的新增/移除控件）。

#### 参数级漂移（`parameters`）

`diffKind` 除了比对 name / Supported Scopes / Output Scope / 分类 / 描述之外，还比对**命令块内第一层花括号的参数键集合**（`extractBlockParameters`）：同名命令在文档里新增或删除一个参数（如 `limit`、`surveyor`），文档块内容变化但描述不变，此时**只会**出现在 `parameterDrift` 里，不会进 `changed`。

- 报告字段：`diffs[].parameterDrift[]`，每条含 `changes[{field:'parameters'}]` 的 before/after 参数键列表；
- 基线是**人工维护**的镜像，允许比原版文档更全（例如原版脚本仍在用、但文档没列出的字段），因此参数漂移是**逐条人工复核清单**，而非必须清零的硬门禁；核对后按"原版是否还能解析"决定补规则还是同步基线；
- 同一行出现多个并列块（`{ owner = <target> } or { id = <id> }`）时解析器会合并所有并列块的键，不要把它们当成漂移。

**文档滞后是常态**：Paradox 有时只改引擎与 changelog、不重新生成 `script_documentation`。此时扫描器**看不到任何信号**（`effect: +0 -0 ~0`、`parameters: ~0` 同时成立），必须靠官方 changelog / patch notes 人工补规则。判断依据是原版脚本里是否已经开始使用该参数（如 `keep_automodding`）；若既无文档、脚本也尚未使用，仍应按公告在 CWT 中补上可选字段，避免玩家照公告书写时报未知字段。

---

### 步骤 2：第一阶段 —— 同步命令与修饰符 Log 文件

根据报告中的 Diff 差异，精准更新以下文件，**只更新差异项**：

1. **`submodules/cwtools-stellaris-config/config/logs/trigger_docs.log`**：
   - 新增 Trigger：追加至文件末尾，严格保留格式（`Trigger: <name>`, `Supported Scopes: ...`, `Supported Targets: ...`, 描述）。
   - 移除 Trigger：仅当确认原版已完全废弃时移除。
   - 作用域变更：如原版调整了作用域，更新对应词条下的 `Supported Scopes`。
2. **`submodules/cwtools-stellaris-config/config/logs/modifiers.log`**：
   - 严格遵循 [引擎文档日志与 CWT 生成边界](../../notes/implemented/process/2026-10-07-engine-doc-log-generated-boundary.md)：凡可由 CWT 类型模式动态生成的 modifier（如 `council_agenda`、`ethos`、`district` 等）必须写入对应 `common/*.cwt` 的 `modifiers` 块；仅将无法动态生成的静态 modifier 逐字核对游戏日志后精准追加至裁剪基线 `modifiers.log`，严禁整量覆盖。
3. **`submodules/cwtools-stellaris-config/config/logs/scopes.log`**：
   - 新增作用域或链接时，确保条目位于 `=================` 分隔符内部且无重复分隔符，同时同步核对 `config/links.cwt` 的 `input_scopes` 与 `output_scope`。
4. **`submodules/cwtools-stellaris-config/config/logs/localizations.log`**：
   - 补充新增的本地化数据提取命令（如 `GetPopsGuidingEthic`）。

---

### 步骤 3：第二阶段 —— 更新 CWT 基础语法规则

1. **`triggers.cwt` 与 `effects.cwt`**：
   - 新增 alias 定义，如：
     ```cwt
     ###Checks which overclock mode the scoped megastructure is currently using.
     alias[trigger:has_overclock] = <mega_overclock>
     ```
   - 严禁在 alias 上写 `## supported_scopes`，保持与引擎自动读取 log 机制一致；
   - 参数结构必须强类型化（使用 `<type>`、`scope[...]`、`value_field` 等）。
2. **废弃命令处理**：
   - 若原版已完全移除且不再允许使用（如 `pop_event`），应从 CWT 文件中硬删除。

---

### 步骤 4：第二阶段 —— 覆盖 Common 字段级参数、目录与 Interface GUI 控件

针对 `folders with findings` 与 `gui` 中报告的每一项进行针对性覆盖：

1. **未覆盖的全新目录（Missing Rule Path）**：
   - 在 `submodules/cwtools-stellaris-config/config/common/` 新建对应的 `.cwt` 文件（如 `policy_categories.cwt`、`resource_regions.cwt`）。
   - 声明 `types = { type[...] = { path = "game/common/..." } }` 及基础参数规则。
2. **缺失的 Subtype**：
   - 在 `game_rules.cwt` 或 `on_actions.cwt` 中补齐 subtype（如 `can_pop_group_auto_migrate_abroad`、`on_cosmogenesis_exodus_fleet_reached`），并配置好 `## replace_scope` 契约。
3. **未覆盖的字段属性（Uncovered Fields）**：
   - 前往原版游戏目录 `<Stellaris 安装目录>/common/<folder>/` 搜索该字段的全部用法；
   - 确认层级位置与类型定义（查验是否已有对应 type，严禁写 `scalar`）；
   - 在对应的 `.cwt` 文件中添加：
     ```cwt
     ## cardinality = 0..1
     field_name = <exact_type>
     ```
4. **Interface GUI 控件类型、属性与外交窗口基线（`gui` 审计）**：
   - 若 `uncovered_types > 0` 或 `uncovered_props > 0`，前往原版 `<Stellaris 安装目录>/interface/` 核实实际用法与所属控件，补入 `submodules/cwtools-stellaris-config/config/interface/gui_types.cwt`（强类型声明，如 `float` / `{ x = int y = int }`，严禁滥用 `scalar`）。
   - 若 7 个关键窗口（`diplomacy_event_view.gui` / `eventwindow.gui` 的 `custom_gui` 契约窗口，以及 `diplomacy_view` / `federation_view` / `galactic_community_view`）检出控件增删（`+N -M`），先核实是否影响 Mod `custom_gui` 契约或外交界面覆写，确认处理完毕后运行：
     ```powershell
     npm run rules:stellaris:gui -- --update-baseline
     ```
     将 `tools/rules-sync/gui-window-baseline.json` 刷新至当前版本。
5. **陈旧 / 引擎已移除字段（`stale-fields` 反向审计）**：
   - 凡 `removed_from_engine > 0` 的字段（或 `unused_in_vanilla` 中确认已在当前版本改名/废弃的跨系统同名键，如区划中的 `is_capped_by_modifier`），不得静默保留为正常有效字段。
   - 优先保留规则并添加 `## severity = warning` 与 `## error_if_only_match = "Deprecated ...: use <new_key> instead"`，使编辑器对旧 Mod 给出明确迁移警告且不在自动补全中推荐该旧键；如确认仅为笔误（如漏写 `##` 的伪字段），直接修正。

---

### 步骤 5：全面排查与清理残余 `scalar`

在修改完成后，运行以下命令全量核查新增内容中是否残留 `scalar`：

```powershell
node -e "
const cp = require('child_process');
const diff = cp.execSync('git -C submodules/cwtools-stellaris-config diff -U0', { encoding: 'utf-8' });
diff.split('\n').forEach(l => {
  if (l.startsWith('+') && !l.startsWith('+++') && l.includes('scalar')) console.log(l);
});
"
```

若存在残留，必须逐一查证并替换为强类型。

---

### 步骤 6：第三阶段 —— 原版全量实跑校验与三分类归因闭环

完成上述规则同步并清理 `scalar` 后，**必须**对本机真实 Stellaris 原版目录执行端到端全量校验，捕获静态扫描器无法发现的深层规则漏洞与解析器/引擎缺陷（参考实战范例：[2026-11-26-vanilla-4.6-parser-engine-and-cwt-fixes.md](../../notes/implemented/bug-fix/2026-11-26-vanilla-4.6-parser-engine-and-cwt-fixes.md)）：

1. **跑出修复前原版全量诊断基线（CSV）**：
   > 输出文件必须写入临时/scratch 目录，严禁落入 git 仓库。原版存在自身脚本错误时 `CWToolsCLI` 以退出码 `1` 结束属正常现象。
   ```powershell
   dotnet run --project submodules/cwtools/CWToolsCLI/CWToolsCLI.fsproj -c Release -- `
     --directory "<Stellaris 安装目录>" `
     --game stl `
     --rulespath "submodules/cwtools-stellaris-config/config" `
     --scope vanilla `
     validate all --reporttype csv --outputfile "<临时目录>/vanilla_before.csv" --languages english
   ```

2. **优先排查 CWT 自身解析崩溃（雪崩自检）**：
   - 若 CSV 中出现数千/数万条 `Unknown type referenced <type>` 级联报错，通常说明某个 `.cwt` 文件存在语法错误（`CWT001`）导致整文件规则未能加载（例如在 `sprites.cwt` 中写了带裸前缀键却缺少 `=` 的块）。
   - 立刻运行 `dotnet fsi src/Main/CwtLanguageSemantics.Tests.fsx` 精确定位并修复损坏的 `.cwt` 文件，再重新采集基线。

3. **聚合分簇与三分类逐项核实**：
   - 过滤掉低优先噪音（如 `CW100` 缺失本地化键），按**错误码 + 消息模板 + 所在文件**聚合统计以下核心指标：
     - **非本地化 Error**（排除 `CW100`/`CW101`/`CW225`/`CW226`）；
     - **`CW274`**（`inline_script` 展开报错，往往由底层字段/作用域/条件分支错误放大而来）；
     - **`CW268`**（YAML 本地化解析中断，会导致同一文件后续所有行失去校验）；
     - **非 `CW100` Warning**（重点关注 `CW242` 基数、`CW240` 类型/枚举值、`CW264`/`CW265` 等）。
   - 按命中频次从高到低逐簇核查，**每簇必须先读原版脚本现场（及本机 `script_documentation` 日志）再定性**：
     - **确认为解析器/验证引擎漏洞**：在 `submodules/cwtools` 中实施最小声音性修复（如作用域窄化仅限确定合取块、条件宏分支仅豁免 `opts.max`），并在 `CWToolsTests` 中补充覆盖正反路径的回归单测。
     - **确认为 CWT 规则/日志漏洞**：在 `submodules/cwtools-stellaris-config` 精准修复（重点排查 `scope[x]` vs `<x>`、`links.cwt` 缺失输入作用域、`ordered_*` 等迭代器的可选基数、`subtype` 拆分及嵌套块 `## replace_scope`、动态/静态 modifier 边界）。
     - **确认为原版脚本自身真实 Bug**：记录归档原因并**保留告警**，严禁靠放宽规则或引入 `scalar` 强行消错。

4. **复跑原版全量校验并做差集审计（Before vs After）**：
   - 全部修复落地后，重新执行第 1 步导出 `<临时目录>/vanilla_after.csv`，对照 `vanilla_before.csv` 核查：
     - 统计总诊断数、非本地化 Error、非 `CW100` Warning、`CW274`、`CW268` 的净消减幅度；
     - **必须检查差集 `after - before` 中的每一条新增诊断**：确认零非预期回归；仅允许因修正作用域契约或修复解析中断后**新暴露的原版真实脚本 Bug** 存在，并逐条核实。

---

### 步骤 7：全套验证门禁（Verification Gate）

1. **规则报告、陈旧字段与 GUI 审计指标验证**：
   ```powershell
   node tools/rules-sync/stellaris-rules-sync.js report --no-open
   node tools/rules-sync/stellaris-rules-sync.js gui --ci
   node tools/rules-sync/stellaris-rules-sync.js stale-fields --ci
   ```
   **合格标准**：
   - `folders with findings: 0`（所有字段级缺失清零）；
   - `scope contracts missing: 0`；
   - `trigger parameters: ~0` 与 `effect parameters: ~0`（参数级漂移已逐条核对，或确认原版文档滞后）；
   - `trigger` / `effect` / `scope` 差异均为 `+0 -0 ~0`；
   - `modifier` 无未处理的真实新增/移除项（已知分类差异需人工核实）；
   - `stale fields: removed_from_engine=0`（并人工复核 `unused_in_vanilla` 中的跨子系统改名项）；
   - `gui: uncovered_types=0 uncovered_props=0` 且 7 个追踪窗口 `(+0 -0)`（变动已核对并更新基线）。

2. **F# CWT 语义与日志加载校验**：
   ```powershell
   dotnet fsi src/Main/CwtLanguageSemantics.Tests.fsx
   dotnet fsi src/Main/StellarisConfigLogs.Tests.fsx
   ```
   确保全量 `.cwt` 文件零语法/语义诊断，且 `config/logs/trigger_docs.log` / `scopes.log` / `modifiers.log` 的分隔符与裁剪边界检查全部通过。

3. **引擎/后端构建与测试门禁（凡改动 `submodules/cwtools` 时必跑）**：
   ```powershell
   dotnet test submodules/cwtools/CWToolsTests/CWToolsTests.fsproj -c Release
   dotnet build src/LSP/ -c Release
   dotnet build src/Main/ -c Release
   npm run test:fsx
   ```
   确保 `CWToolsTests` 0 失败（含新增回归单测；默认跳过的旧版 vanilla shader 基线测试不计为失败），`LSP` 与 `Main` 0 警告 0 错误，`test:fsx` 全部通过。

4. **TypeScript 编译、类型安全与规则工具单测**：
   ```powershell
   npm run compile
   npm run typecheck:test
   npm run test:rules-sync
   ```
   确保退出码均为 0，无任何 TypeScript 类型错误或回归失败；同时检查 `git status` 确认仓库内无临时 CSV 或分析脚本残留。

5. **撰写 Agent Note 归档**：
   根据 `AGENTS.md` 要求，在 `.agents/notes/implemented/feature/`（版本同步）或 `.agents/notes/implemented/bug-fix/`（报错归因与引擎/规则修复）创建或更新简体中文实施记录，详述背景、三分类归因与设计决策、拒绝方案、原版全量对比数据及验证指标。如同时改动了子模块，提交时须先提交子模块再更新主仓库指针。
