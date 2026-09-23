---
name: stellaris-rules-sync
description: >-
  Stellaris 规则与 CWT 语法更新的标准作业规范（SOP）。用于同步游戏脚本文档日志、生成与更新 CWT 规则、严禁滥用 scalar、深入原版反查强类型、补全 Common 字段级未覆盖参数，并完成全套验证门禁。
---

# Stellaris 规则同步与 CWT 规则库维护技能 (Stellaris Rules Sync Skill)

本技能定义了当 Stellaris（群星）游戏版本更新或脚本文档漂移时，CWTools VSCode 扩展中 CWT 规则库从日志提取、差异对比、强类型定义补全，到最终校验的完整标准作业规范（SOP）。

---

## 核心原则与底层机制

1. **两阶段更新路径（Two-Phase Path）**：
   - **第一阶段（Log 结合文档同步）**：先同步原版脚本文档中的 Trigger、Effect、Modifier、Localisation 变动至 `config/logs/` 中的日志文件。严格**仅更新报告中检测到的变动条目**，禁止全量盲目替换，以避免冲掉人工维护的注释排版与自定义修正。
   - **第二阶段（CWT 语法规则更新）**：在 Log 同步完成后，再同步更新 CWT 规则文件（`triggers.cwt`、`effects.cwt`、`scope_changes.cwt` 及 `common/*.cwt`）。

2. **Trigger / Effect 支持定义域（Supported Scopes）机制**：
   - 在 `triggers.cwt` 和 `effects.cwt` 中，普通的 trigger 和 effect 的 alias 上**不需要**额外手动标注 `## supported_scopes`。
   - **底层机制**：CWTools 语言服务器在加载配置时，会**自动从 `config/logs/trigger_docs.log`（以及内置日志）中读取每个 Trigger/Effect 的 `Supported Scopes: ...` 字段**，并在内存中完成作用域约束的绑定。
   - **规范约束**：必须确保 `config/logs/trigger_docs.log` 中的 `Supported Scopes` 保持准确；CWT 规则内部只需声明语法参数结构与强类型，无需冗余声明作用域标注（除非该条目为游戏 log 未收录的伪触发器/脚本触发器，或需人工覆盖原版作用域限制）。

3. **严禁滥用 `scalar`，必须深入原版反查强类型**：
   - 严禁为了快速消除扫描警告或字段缺失报错而随意使用 `scalar`！
   - 必须深入原版游戏目录（`D:\Steam\steamapps\common\Stellaris\common`、`00_defines.txt` 或 `README` 文档）反查实际调用：
     - 若为特定游戏对象（如 `preset_vassal`、`SMELTING`、超频模式等），必须绑定为具体的强类型 `<type>`（如 `<agreement_preset>`、`<mega_overclock>`、`<tradable_actions>`）；
     - 若为同类对象分组标识符（如 `overclock_group`），必须定义为 `value_set[...]`（如 `value_set[megastructure_overclock_group]`）；
     - 若为动态本地化拼接前缀或键名，定义为 `localisation`；
     - 若为精灵图标键名（如 `icon = "trade_protection"`），定义为 `<sprite>`；
     - 若仅为数值计算或布尔开关，使用 `value_field` / `int` / `float` / `bool`。

4. **严格核实属性层级结构**：
   - 在复杂定义（如 `megastructures`、`planet_classes`、`ship_sizes` 等）中添加字段时，必须核实该字段属于根级属性还是子块属性。
   - 例如：巨构的 `nomad_reactivatable`、`custom_tooltip_with_modifiers`、`overclock_loc_key`、`overclock_cooldown` 均为 `megastructure` 的**顶层属性**，绝不可错误嵌套入 `overclock_types = { ... }` 列表子块内。

---

## 标准执行流程

### 步骤 1：运行规则同步扫描与生成报告

```powershell
# 运行规则扫描并生成报告（不自动弹出浏览器）
node tools/rules-sync/stellaris-rules-sync.js report --no-open
```

读取 `.rules-sync/stellaris/report/rules-sync-report.json`，关注以下指标：
- `trigger` / `effect` / `modifier` 的变动数量（`+新增 -移除 ~修改`）；
- `folders with findings`（未覆盖的 Common 目录或字段）；
- `scope contracts`（缺失的作用域契约）。

---

### 步骤 2：第一阶段 —— 同步命令与修饰符 Log 文件

根据报告中的 Diff 差异，精准更新以下文件，**只更新差异项**：

1. **`submodules/cwtools-stellaris-config/config/logs/trigger_docs.log`**：
   - 新增 Trigger：追加至文件末尾，严格保留格式（`Trigger: <name>`, `Supported Scopes: ...`, `Supported Targets: ...`, 描述）。
   - 移除 Trigger：仅当确认原版已完全废弃时移除。
   - 作用域变更：如原版调整了作用域，更新对应词条下的 `Supported Scopes`。
2. **`submodules/cwtools-stellaris-config/config/logs/modifiers.log`**：
   - 新增/移除修饰符：更新对应的 Category 分类块。
3. **`submodules/cwtools-stellaris-config/config/logs/localizations.log`**：
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

### 步骤 4：第二阶段 —— 覆盖 Common 字段级参数与目录

针对 `folders with findings` 中报告的每一项进行针对性覆盖：

1. **未覆盖的全新目录（Missing Rule Path）**：
   - 在 `submodules/cwtools-stellaris-config/config/common/` 新建对应的 `.cwt` 文件（如 `policy_categories.cwt`、`resource_regions.cwt`）。
   - 声明 `types = { type[...] = { path = "game/common/..." } }` 及基础参数规则。
2. **缺失的 Subtype**：
   - 在 `game_rules.cwt` 或 `on_actions.cwt` 中补齐 subtype（如 `can_pop_group_auto_migrate_abroad`、`on_cosmogenesis_exodus_fleet_reached`），并配置好 `## replace_scope` 契约。
3. **未覆盖的字段属性（Uncovered Fields）**：
   - 前往原版游戏目录 `D:\Steam\steamapps\common\Stellaris\common\<folder>\` 搜索该字段的全部用法；
   - 确认层级位置与类型定义（查验是否已有对应 type，严禁写 `scalar`）；
   - 在对应的 `.cwt` 文件中添加：
     ```cwt
     ## cardinality = 0..1
     field_name = <exact_type>
     ```

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

### 步骤 6：全套验证门禁（Verification Gate）

1. **规则报告指标验证**：
   ```powershell
   node tools/rules-sync/stellaris-rules-sync.js report --no-open
   ```
   **合格标准**：
   - `folders with findings: 0`（所有字段级缺失清零）；
   - `scope contracts missing: 0`；
   - `effect: +0 -0 ~0`；
   - `modifier: +0 -0 ~0`。

2. **代码编译与类型安全**：
   ```powershell
   npm run compile
   npm run typecheck:test
   ```
   确保退出码均为 0，无任何 TypeScript 类型错误。

3. **撰写 Agent Note 归档**：
   根据 `AGENTS.md` 要求，在 `.agents/notes/implemented/feature/` 创建或更新实施记录（使用简体中文），详述背景、设计决策、拒绝方案与验证指标。
