# Agent Note: 悬停显示脚本命令的引擎开销与硬编码行为

Status: implemented

## Problem

CWTools 的悬停此前只展示规则文件能提供的信息（`##` 描述、作用域、本地化、事件目标解析）。规则文件描述的是**语法**，不描述**引擎实现**，于是两类关键信息对 mod 作者完全不可见：

1. **性能复杂度**：`has_tradition` 与 `num_ships` 写法几乎一样，引擎代价却相差一个数量级；写进逐日 `on_action` 后后果完全不同。
2. **反常识的硬编码行为**：如 `set_update_modifiers_batch` 的 begin/end 语义、`is_designable` 对自动设计生成的门控、`has_any_flag` 只读计数不做搜索。

同时有两个方法论陷阱，本变更的核心价值就是绕开它们：

- **"查不到"不是"不存在"**。用游戏自带 `modifiers.log` 里的真实修饰符做对照，5 个里有 4 个（`pop_workforce_mult`、`create_debris_chance`、`ship_armor_add`、`job_max_workforce_mult`）在 319 MB 反编译 dump 中同样一个字符串都搜不到。因此不能以 dump 缺失作为否定证据。
- **"有循环"不等于"命令是 O(n)"**。日志构造、性能计时器、字符串分配器等基础设施自身带循环，若不过滤会把几乎所有命令都误判为 O(n)。

## Decision

事实**声明在 CWT 规则里**，后端只负责呈现与匹配；提取过程脚本化、可复现。

### 1. 提取器（可复现，唯一事实来源）

[tools/engine-cost/extract-engine-cost.cjs](../../../../tools/engine-cost/extract-engine-cost.cjs)：扫描 dump，为每条命令定位其引擎实现并给出复杂度等级。

- 解析 **113,740 个函数块**（含多行签名注释），按花括号深度记录循环嵌套。
- 命令→实现类的链接：类名由命令名 PascalCase 推导（`num_ships` → `CNumShipsTrigger`），失败时按前缀回退；命中率 **76%**。
- **同类别名解析**：Ghidra 会把长调用折行（`CountShipsInScope` 与 `(` 分行），因此调用必须从函数体拼接文本中提取，否则会漏掉整个调用链。
- **基础设施黑名单**：`CPdxLog*`、`CScopedStartProfile`、`CScopedProfile`、`CLogStream`、`CString`、`std::*` 等不计入扫描证据。
- **mod 自撰链排除**：`CFixedPointVariableValue::GetValue` 等值表达式求值器遍历的是脚本写的事件目标链（`owner.capital_scope.solar_system`），长度由 mod 作者决定而非游戏状态，不算容器扫描。
- **共享实现映射**：所有 `*_flag` 命令共用 `CHasFlagTrigger`/`CRemoveFlagEffect`，作用域家族只决定虚调用返回哪个数组。
- **控制流关键字跳过**：`if`/`switch`/`while`/`random_list` 等的"n"是嵌套子句数量，不是引擎扫描的容器，标注会误导，故不输出。
- **保守嵌套判定**：仅当函数自身含嵌套循环才判 O(n²)；同一函数内两个互斥分支上的循环（如 `CHasCivicTrigger`）保持线性。
- 无法链接实现或证据不明确的命令**直接省略**，不猜测。

### 2. CWT 侧新增三个指令（cwtools 子模块）

- [RulesTypes.fs](../../../../submodules/cwtools/CWTools/Rules/RulesTypes.fs) 的 `Options` 增加 `cost` / `engine` / `engineEvidence`。
- [RulesParser.fs](../../../../submodules/cwtools/CWTools/Rules/RulesParser.fs) 解析 `## cost` / `## engine` / `## engine_evidence`，并把这些键从 `description` 中排除以免污染既有悬停文案。
- [CwtLanguageSchema.fs](../../../../submodules/cwtools/CWTools/Rules/CwtLanguageSchema.fs) 注册三个指令（否则报 CWT101）。

### 3. 规则侧写事实（cwtools-stellaris-config 子模块）

**1248 条命令**已标注（`o(n)` 718、`o(1)` 523、`o(n^2)` 2、`o(log n)` 2、`o(n)_owned` 1、`semantics` 1、`refresh_batch` 1），覆盖率 **1248 / 1657 = 75%**。全部 3759 行新增内容均为 `##` 注释，**未改动任何 `alias` 语义**。

### 4. 后端只做呈现（src/Main）

[HoverPerformance.fs](../../../../src/Main/HoverPerformance.fs) 收敛为词表与匹配：10 类 `PerfClass`（含新增 `Quadratic`）、`tryParseClass`、`classToken`、`describe`、`resolve`，**不含任何具体命令的事实**。[GameTypes.fs](../../../../submodules/cwtools/CWTools/Game/GameTypes.fs) 的 `SymbolInformation` 增加三个字段承载规则事实；[LanguageServerFeatures.fs](../../../../src/Main/LanguageServerFeatures.fs) 的 `hoverDocument` 渲染为独立区块。

### 5. 已验证 / 未确认二分

`## engine_evidence` 存在即已验证（显示函数名 + dump 行号）；缺失则显示"未确认，仅作提示"。`## cost` 取值无法解析时 `tryParseClass` 返回 `None`，规则写错只会退化为"无标注"。

## 本次核对中被推翻的结论

- **`has_tradition` 不是 O(1)，是 O(n)**：`CCountry::HasTradition`（dump L2079989）对 `CPdxArray` 逐指针比较（循环 L2080010），由 `CHasTraditionTrigger`（L6885645）调用。
- **`num_researched_techs` 不是 O(1)，是 O(n)**：`CNumResearchedTechsTrigger::GetTriggerValue`（L6853583）调用 `CTechnologyStatus::CalcTotalTechLevels`（L1504171），后者遍历状态数组。我此前基于 `GetResearchedTechIndex` 判为 O(1) 是**错误的**——那只回答"某科技是否已研究"，与"计数"是不同函数，已修正。
- **`has_technology` 确为 O(1)**：`CTechnologyStatus::HasTechnology`（L1504242）按科技 id 直接索引，无循环。
- **`has_any_flag` 是 O(1)**：`CHasAnyFlagTrigger::ActualEvaluate`（L6773813）只比较 flag 数组长度（L6773819）。
- **`has_*_flag` / `set_*_flag` / `remove_*_flag` 是 O(n)**：`CHasFlagTrigger::ActualEvaluate`（L6751399，循环 L6751417）、`CPdxIntegerFlags::SetFlag`（L7062093）、`ClearFlag`（L7062161）均线性。名称→ID 是哈希，扫描才是开销。
- **`force_disparity_fire_rate_mult` 的 BASE=20 / MAX=5 是游戏 define**：`FORCE_DISPARITY_BASE` / `FORCE_DISPARITY_MAX_EFFECT` 位于 `common/defines/00_defines.txt` L1871-1872，静态修正在 `02_static_modifiers.txt` L1007-1010。
- **`optimize_memory` / `good_enough_weight` / `also_automate` / `combat_size_multiplier` / `chain_range` 全部真实存在**，证据见游戏自带文档（`99_advanced_documentation.txt` L70-83、`99_README_SCRIPTED_ACTIONS.txt` L55-57/L133-138、`000_documentation.txt` L166-172）。

## Alternatives considered

- **把事实表硬编码在 F# 后端**：否决。开销等级属于规则内容，硬编码会导致每次游戏版本更新都要改代码发版，规则维护者也无法参与。
- **以"dump 中查无此串"作为否定证据**：否决。对照组已证明该推论无效（5 个真实修饰符中 4 个同样查不到）。
- **全量传递闭包分析调用图**：否决。`has_tradition` 的传递闭包会累加出 114 个循环、嵌套深度 6，得出 `O(n^6)` 之类无意义结论；改用**深度 1 直接调用**+基础设施黑名单，结果与人工核对一致。
- **对全部 1657 条命令都标注**：否决。25% 无法链接到命名实现类（dump 中注册虚表被标为 `PTR__CTriggerEntryBase_<addr>` 而不含类名），强行标注必然引入错误。宁可留白。
- **只显示裸的大 O**：否决。复杂度符号离开机制说明无法行动。
- **对所有条目都显示证据行**：否决。会把无法证实的转述包装成"引擎证据"。

## Consequences

- 悬停对 75% 的命令额外给出：引擎开销类别、硬编码行为一句话、以及**已验证时的函数级证据**或**未确认时的显式声明**。
- **新增事实无需改代码**：在 CWT 写 `## cost` / `## engine` / `## engine_evidence` 即可。
- 提取器可复现：`node tools/engine-cost/extract-engine-cost.cjs <dump> --rules <config>` 输出与规则文件中的标注**逐条一致**（已验证 0 差异，14 条人工覆盖除外）。
- 回归测试：[HoverPerformance.Tests.fsx](../../../../src/Main/HoverPerformance.Tests.fsx)（59 项：词表/解析/渲染/回退）与 [EngineCostRuleParsing.Tests.fsx](../../../../src/Main/EngineCostRuleParsing.Tests.fsx)（26 项：**解析真实规则文件**，断言 1248 条 `## cost` 全部为合法类别、证据行不泄漏进描述、未标注命令保持未标注）。均由 `npm run test:fsx` 自动发现。
- `Options` 与 `SymbolInformation` 是跨仓库共享类型，**cwtools 与 cwtools-stellaris-config 两个子模块必须先行提交，再更新根指针**。
- 已知局限：复杂度是**实现形态**的推断而非基准测试；调用深度 1 之外若有扫描会被漏判为 O(1)（实测该比例约 35%，故对"O(1)"保守取"命令及其直接调用者均无循环"）。
