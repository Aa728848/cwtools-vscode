# Better Stellaris：Stellaris 4.5 性能问题分析

对 `source/stellaris_4.5_source.cpp`（Stellaris 4.5 **Linux 版** Ghidra 反编译，约 870 万行、13.9 万个函数）的静态性能审查，重点关注玩家、mod 开发者和引擎日常都会走到的热点路径。

- 分析日期：2026-09-29
- 方法：按函数建索引，再分 5 个方向并行审查（UI/逐帧、脚本引擎、人口/经济/modifier、舰队/寻路/AI、引擎基础设施）。影响最大的若干条由人工复读代码核对（下文标 ✅）。
- **只做了静态分析，没有做 profiling。** "代码确实如此"的置信度较高；"有多慢"是按后期规模估算的，不是实测数据。
- 行号全部指 `stellaris_4.5_source.cpp`。偏移是 GCC 布局，与 Windows 版不同。
- 后期规模假设：国家 50–100 个（算上非可玩国家有数百个）；星系 1000–2000 个；星球 5000–10000 个；殖民地约 2000 个；人口组 1–3 万个；舰船 1–4 万艘。

## 文件目录

| 文件 | 内容 |
|---|---|
| [01_ui_per_frame.md](01_ui_per_frame.md) | 逐帧 / UI：tooltip、大纲、地图图标、窗口 Update |
| [02_script_engine.md](02_script_engine.md) | 脚本引擎：trigger/effect、作用域迭代、MTTH 事件、on_action、变量 |
| [03_pops_economy_modifiers.md](03_pops_economy_modifiers.md) | 人口/岗位/殖民地/经济/modifier 系统 |
| [04_fleet_pathfinding_ai.md](04_fleet_pathfinding_ai.md) | 舰队、寻路、边界、战斗、AI |
| [05_engine_core_load_save.md](05_engine_core_load_save.md) | 线程调度、容器、存档、加载、本地化 |
| [06_player_modder_guide.md](06_player_modder_guide.md) | 不改引擎的前提下，玩家和 mod 作者能做的事 |
| [07_good_designs.md](07_good_designs.md) | 已确认做得好的部分，避免误判 |
| [08_flags_targets_rules_combat.md](08_flags_targets_rules_combat.md) | 补充：flag 与变量、事件目标、GameRule、科技计数、舰队管理器、AoE/连锁武器 |
| [09_scripted_trigger_inline_script.md](09_scripted_trigger_inline_script.md) | scripted_trigger / scripted_effect / inline_script 的加载时与运行时成本对比 |
| [11_species_leaders_diplomacy.md](11_species_leaders_diplomacy.md) | 物种查重与按名查找、派系缓存、殖民物种列表、好感度缓存、外交月更、领袖 modifier |
| [12_ai_economy_automation.md](12_ai_economy_automation.md) | AI 殖民评估、宜居度缓存、专业化配对搜索、决议判断、星球自动化、自动设计、建造队列 |
| [13_daily_subsystems.md](13_daily_subsystems.md) | 宣战理由、舰船日更、特殊项目/局势、考古与裂隙、法令、月更阶段结构、宇宙风暴、灵能光环 |
| [15_silent_corruption_bugs.md](15_silent_corruption_bugs.md) | ⚠️ **静默数据损坏类 bug**（不是性能问题）：flag 名字表耗尽、`set_design_flag` 写进全局 flag（原版专家特权会删错设计）、TPdxRef 代号回绕、空对象被污染、AI 结果不可复现 |
| [14_trigger_cost_catalog.md](14_trigger_cost_catalog.md) | **trigger 开销速查表**（约 100 个常用 trigger，按 O(1) / 线性 / 隐藏循环 / 求值脚本分级，附"贵 → 便宜"替换表） |
| [10_effect_side_costs.md](10_effect_side_costs.md) | 约 40 个常用 effect 的直接开销与隐藏副作用（同步/延后），含物种爆炸、延迟事件队列、建筑与岗位重算 |
| [16_combat_damage_resolution.md](16_combat_damage_resolution.md) | ⚠️ **伤害结算公式**（不是性能问题）：4.5.2 `CalcDamage` 三层分配模型、武器字段 ↔ 结构偏移对照、23 组算例；2026-10-08 已完成逐条源码核验 |
| [tools/](tools/) | 分析工具：建索引、按函数名提取函数体或调用序列 |

## Top 18 汇总（按估计的实际影响排序）

| # | 问题 | 位置 | 受影响方 | 置信度 |
|---|---|---|---|---|
| 1 ✅ | 每月岗位分配无条件对全部殖民地跑两遍 `UpdatePopJobs`，每遍都对每个（人口组×岗位）求值 `possible` 和 `weight` 脚本 | `NColonyUpdate::MonthlyUpdate` 3172940 | 玩家（月初卡顿）、mod | 高 |
| 2 | 国家级 modifier 失效时传全类别掩码，级联到整个帝国，然后清空重建 | `CCountry::InvalidateModifier` 598843 | 玩家、引擎 | 机制高 / 频率中 |
| 3 | modifier 容器是无序数组，查找线性、合并 O(n·M)；每个人口组重复合并整颗殖民地的建筑和区划 modifier | `ApplyModifierMult` 911634、`AddModifierInternal` 247641、`CPopGroup::CalculateModifier` 1047638 | 引擎 | 高 |
| 4 ✅ | 有 bypass 的国家跳过 O(1) 距离矩阵，改走"读锁 + 哈希查找 + 未命中时全图 Dijkstra" | `CGalacticDistanceCache::GetDistance` 2567483 | 引擎 | 高 |
| 5 | 恒星基地每易主一次，就同步重算一次全图边界（含 O(V·C) 线性查找和"边境×边境"两两距离计算） | `CStarbase::SetOwner` 1402428 → `CalcBorders` 419969 | 玩家（战争卡顿） | 高 |
| 6 ✅ | tooltip 在显示延迟到期前就每帧完整生成，生成完又丢弃 | `CTooltipManager::Update` 5148919 / 5149563 | 所有人、mod 放大 | 高 |
| 7 | 大纲每帧全量更新：舰队每帧排序，星球每帧本地化和字符串拼接；折叠时也每帧计数 | `COutlinerListViewBase::InternalUpdate` 4555365 | 玩家 | 高 |
| 8 | 舰队地图图标：每帧扫描全部舰队，并做 O(可见×图标) 的线性匹配 | `CMapIconManager::UpdateFleetIcons` 5561377 | 玩家 | 高 |
| 9 ✅ | 带 `modifier` 的 MTTH 事件先完整求值 trigger 再掷骰（无 modifier 时顺序相反） | `CheckEvents` 3474947、`CStandardEventCountryModule` 2444603 | mod | 高 |
| 10 | `random_*` 先对全部候选求值 `limit`，再挑一个 | `CScriptedListEffect<CRandomInScriptedListEffect,…>::BuildList` 6564744 | mod | 高 |
| 11 ✅ | 每个 `any_`/`every_`/`count_`/`random_` 块都深拷贝事件目标和变量容器，而拷贝永远不会被读取 | `CEventScope::Copy` 2467811、`GetVariables` 2479665 | mod | 中高 |
| 12 | 自动存档期间模拟暂停，序列化单线程；每个字符串都复制并做两次 `ReplaceAll` | `CSaveGameTaskManager::Update` 1203400、`CWriter::WriteString` 8113403 | 玩家 | 高 |
| 13 | 战斗簿记每 tick 串行遍历全部舰队；同一场战斗里每支舰队都重建同一份目标列表 | `CGameState::MicroUpdate` 415998 | 玩家（大战） | 中高 |
| 14 | 建筑、区划、岗位的 triggered modifier 每天全量重算，没有分摊到不同日期 | `CColony::DailyUpdateSelfDontReadOthers` 3081378 | mod、引擎 | 高 |
| 15 ✅ | `FleetPathFindCache` 是死代码（标志只写不读）；可达性检查每次都跑完整 A* | `ResetFleetPathFindCache` 3375667、`CalcCanMoveTo` 3299645 | 引擎 | 高 |
| 16 | 约 180 个脚本数据库全部在主线程串行加载；词法分析器每读一个字符做 2 次虚调用和一次 `iswspace` | `SetupDatabases` 196820、`CTextLexer::GetTok` 8100439 | 所有人（加载时间） | 高 |
| 17 ✅ | 本地化 `replace/` 的开销是 O(覆盖条数 × 全部键数) | `SLanguageData::ChangeKeyValuePair` 8071291 | mod（加载时间） | 高 |
| 18 | 全图距离矩阵：任何超空间航道一变动就 O(N²) 全量重建，并且每个源点单独做一次 fork/join | `BuildHyperlaneDistances` 2567816 | 引擎、大星图 mod | 中高 |

### 补充发现（详见 08）

| # | 问题 | 位置 | 受影响方 | 置信度 |
|---|---|---|---|---|
| 19 ✅ | `has_flag` / `set_flag` 都是无序数组线性扫描；**全部 global flag 共用一个数组**，每次 `has_global_flag` 都扫全表 | `CHasFlagTrigger::ActualEvaluate` 6751401、`CPdxIntegerFlags::SetFlag` 7062097、`CGameState+0x490` | mod | 高 |
| 20 ✅ | 动态 flag 和动态事件目标名（`x@scope`）每次使用都要构造作用域、拼字符串、做哈希；名字永久驻留，上限 65535，表满后静默返回 `0xffff` 并互相冲突 | `ProcessDynamicFlag` 1584280、`CreateFlagIndex` 7062405 | mod（性能 + 正确性） | 高 |
| 21 ✅ | 跨作用域读取变量（`owner.var`）时，每次求值都完整深拷贝一次调用方的作用域 | `CFixedPointVariableValue::GetValue` 1595036 | mod | 高 |
| 22 | 延迟事件、on_action、事件链快照要为 root/from/prev 各深拷贝一次作用域（包括事件目标和局部变量） | `CEventScope::CopyInternalScopes` 2468427（约 106 个调用点） | mod | 中高 |
| 22b ✅ | 作用域跳转（`prev`/`from`/`event_target:`/`owner`…）每一段都递归调用 `GetScope`：约 1.8 KB 栈帧，完整构造并拷贝一次 `CEventScope`（根作用域带目标或局部变量时要深拷贝容器），再 move 赋值并析构；每次引用都重新解析整条链；失败且没写 `?` 时序列化整个作用域写日志。事件目标本可以按 16 位 ID 直接索引做到 O(1) | Windows `GetScope` RVA 0x352950（Linux 版没反编译出来）、`CContextTrigger::Evaluate` 6747690 | mod | 高 |
| 22c ✅ | `inline_script` 在每个调用点都要复制整份源码、对每个参数做一次全文 `ReplaceAll`、再完整重新解析，而且不去重（N 个调用点就生成 N 棵对象树）；带参数的 scripted_* 每组不同参数都要生成一次源码（O(宏数×长度) 的整串重建，加 4 次无条件的转义 `ReplaceAll`）并重新解析。运行时 scripted_* 只多 1–2 次虚调用 | `CreateInlineScriptReader` 8096479、`CMetaScriptTemplate::GenerateSource` 893150、`CScriptedTrigger::ActualEvaluate` 6750319 | mod（加载时间、内存） | 高 |
| 22d ✅ | `modify_species`/`create_species` 查重是 O(物种数 × 特质²) 的线性扫描，国家作用域还要把全帝国的人口组重新分组；`add_building`/`add_district`/`set_controller` **同步**重分配整颗星球的岗位；`days=` 延迟事件每个都要堆分配并深拷贝作用域，并且**每天**把全部挂起事件扫一遍（包括 abort_trigger）；`spawn_system` 不用批处理包起来，每次都同步做 O(N²) 的距离重建 | `CreateNewSpecies` 408141、`EnsurePopJobsAreUpToDate` 3064005、`CDelayedEventManager::AddEvent` 2289766 | mod | 高 |
| 22e ✅ | 派系"潜在成员缓存"**每天**对每个人口组求值一次游戏规则，再对每种派系类型各求值一次 `can_join_faction` 脚本（真正的成员变动是 30 天轮一次）；好感度计算（1372 行，还会顺手构建 `CGameText`）只在 AI 作用域内缓存，事件里的 `opinion` trigger 和 UI 排序每次都完整重算 | `UpdateFactionsPopsCache` 1100540、`CalcOurOpinionOfOtherNoScopeCopy` 2035390 | 玩家、mod | 高 |
| 22f ✅ | 同作用域读变量（`value = my_var`）也要先完整拷贝一次作用域；跨作用域读取还要每段递归一次加拷贝赋值。`change_variable` 是裸 64 位加法，溢出后静默回绕（变量数量没有上限；数值是 int64 按 10⁵ 缩放） | `CFixedPointVariableValue::GetValue` 1595062、`CChangeVariableEffect` 6107468 | mod | 高 |
| 22g ✅ | AI：每个 AI 每周对所拥有星系里的**每个星球 × 全部决议**做 `IsAllowed` 和 `GetAIWeight` 判断（每天约 10 万次）；殖民评估扫描全银河星球，宜居度不走缓存；专业化配对搜索每月 O(殖民地²)（建满以后正是最坏情况）。玩家星球自动化在主线程串行执行 | `HandleDecisions` 2847625、`CreateColonizeData` 2763232、`SpecializeAllBuildables` 2793696、`HandlePlanetAutomation` 2023466 | 玩家、mod | 高 |
| 22h ✅ | 宣战理由每天按"国家 × 理由类型 × 全部国家"重建，每一对求值 2 个 trigger；特殊项目、局势、法令、考古可见性、焦点卡每天轮询 trigger；舰船自修复每天对每艘船重算 6 个整局不变的静态 modifier 值 | `UpdateCasusBelliOnlyChangeSafePrivateWithTypeAgainst` 2324251、`CShip::DailyUpdateRepair` 3520460 | 玩家、mod | 高 |
| 22i ✅🎮 | `@` 动态 flag 和事件目标：每次使用都要 `GetScope` 加字符串拼接和哈希；名字是"基础名 + 十进制 ID"**直接拼接、没有分隔符**（`a1@23` 和 `a12@3` 撞名）；每个不同的名字永久占用全局 65535 空间，**进程级**，只有重启才清空。**实测**：表满时不写日志，新 flag 静默设置失败，**事件目标串号** | `ReadAsDynamicFlag` 1584003、`ProcessDynamicFlag` 1584280、`CreateFlagIndex`（Windows 0x1a7da20）；实测见 `console_tests/` | mod | 高（已实测） |
| 22j ✅ | `pop_amount`/`sapient_pop_amount` 是 scripted_trigger，要两遍遍历全部人口组；国家作用域的 `num_zones` 是覆盖赋值而不是累加（疑似 bug）；`habitability`、`opinion`、`has_valid_civic`、`max_naval_capacity`、`any_neighbor_country` 都比看上去重得多 | 见 14 | mod | 高 |
| 23 ✅ | `CGameRules` 的 80 多个规则全部不缓存，每次调用都构造两个作用域再求值脚本 | `CGameRules::*` 369903 起 | mod、引擎 | 高 |
| 24 ✅ | `num_researched_techs` / `_of_tier` 每次都全量扫描已研究数组（`has_technology` 是 O(1)，没问题） | `CTechnologyStatus::CalcTotalTechLevels` 1504173、`CalcNumTechsOfTier` 1504302 | mod | 高 |
| 25 ✅ | 舰队管理器：按设计计数不缓存，`CalcAllShipsToReinforce` 的开销是 Σ模板 D×(S+2R)，窗口打开时按时间节流每秒重算 7–18 次（不管有没有变化）。注意：舰船**总数**和舰队规模是缓存的 | `CountShipsForDesign` 3418183、`CFleetManagerView::Update` 4069992、`ShouldUpdateExpensiveThisFrame` 4345938 | 玩家 | 高 |
| 26 ✅ | AoE：O(星系舰船数) 次廉价检查 + O(命中数 × 受击方的特质/传统扫描 + 脚本规则)；连锁：O(连锁次数 × 星系舰船数)。整条路径单线程执行，也没有缓存 | `CWeaponComponent::Shoot` 1965405、`IsCountryPsionic` 384894 | mod（连锁武器）、大战 | 高 |

## 引擎侧修复优先级建议

1. **每月岗位分配**：只处理人口或岗位组成、modifier 校验和发生变化的殖民地；第二遍改为只在第一遍改动了分配时才跑。
2. **modifier 系统**：容器改成稠密数组或哈希表；失效时传真实的类别掩码，或改为增量（减旧值、加新值）更新。
3. **距离查询**：没有 bypass 能缩短路线时直接读矩阵；对 bypass 入口节点另外预算一张小矩阵。
4. **边界重算**：批量化到每 tick 一次，只重算受影响的邻域。
5. **UI**：tooltip 延迟到期后才生成，并做节流；大纲只更新可见行或按日更新；舰队图标改用下标索引，并像星系图标那样每帧只更新 1/4。
6. **脚本**：MTTH 用上界做拒绝采样；`random_` 做洗牌后第一个命中即停；子作用域不拷贝 `+0x48`。
7. **加载**：按 `CanInitialize` 的依赖关系并行加载；词法分析改成直接扫缓冲区。

## 正确性问题（顺带发现）

- flag 名（包括动态的 `x@scope` 和事件目标名）都是 `ushort` ID，全局上限 65535，而且永不回收。表满后 `CreateFlagIndex`（7062405）静默返回 `0xffff`，`save_event_target_as` 等调用方也不检查，于是所有新名字都落到同一个键上互相覆盖（见 08-A3/B5）。

- 本地化 `Localize` 只按 32 位 Murmur 哈希匹配，不比对原始键名。30 万个键时预计约 10 次冲突，冲突时会返回错误文本（8066683）。
- `CModifierNodeBase::Update`（247526）的双重检查 dirty 位在重算之前就被清除，并发读者可能读到算到一半的值。
- `RenderFrameInParallelFor`（403985）在 worker 线程写游戏状态的同时渲染并读取这些状态，存在数据竞争。
- `AddModifierInternal`（247700）在并行 job 里对全局 modifier 定义表做 `|=` 写入，属于良性数据竞争，同时造成缓存行乒乓。
