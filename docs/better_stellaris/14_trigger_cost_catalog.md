# 14 trigger 开销目录（给 mod 作者查表用）

**名字 → 类的映射方法**：
- 静态初始化代码（约 104697–119165 行）逐个 `CTriggerDatabase::RegisterTriggerEntry(db, token, entry)`，每项附带描述文本。
- 把这些描述与游戏自己生成的 `Documents/Paradox Interactive/Stellaris/logs/script_documentation/triggers.log` 比对，匹配上了 1096 个里的 879 个。
- 再利用"entry 的 vtable 恰好位于 trigger 的 vtable 之前 0x40 字节"这一规律，把其中 643 个对应到具体的 C++ 类。
- 列表类的 `any_`/`count_`/`every_` 由 `CScriptListsRegistryHelper<Builder>(…, "owned_planet", …)` 生成。
- 数据库里找不到的 token，会被 `CTriggerCollectionBase::ReadMember`（1578790）当成作用域切换（`CContextTrigger`，每次求值都构造一个 `CEventScope`，见 08-B8），或者 scripted_trigger 占位符。

**有些常见写法其实不是引擎 trigger**：
- `pop_amount`、`sapient_pop_amount`、`psionic_pop_amount` 是原版的 **scripted_trigger**（`00_scripted_triggers_pop.txt:49`），内部是 `count_owned_pop_amount`，见 T1。
- `is_gestalt`、`is_machine_empire`、`is_hive_empire` 是对 `has_ethic`/`has_authority` 的 scripted 包装，很便宜。

**记号**：C = 自有殖民地（10–150）；G = 人口组（每个星球 10–60，整个帝国数千）；N = 银河中的国家（100–300+，含非可玩国家）；S = 舰船；F = 舰队；R = 资源种类（约 20–30）；M = 对象 modifier 数组的条目数（国家有数百条）。
"作用域拷贝"指构造一个完整的 `CEventScope`（约 0x190 字节），是常数开销，但并不便宜；带事件目标或局部变量时还要深拷贝（08-B8）。

✅ 表示我亲自复核过代码；其余来自分析 agent 读到的代码，我没有逐条复核。置信度：H 高 / M 中。

## 一、便宜：O(1)

| trigger | 类 | 行 | 开销 | 备注 | 置信度 |
|---|---|---|---|---|---|
| ✅ `has_technology` | CHasTechnologyTrigger | 6768498 | O(1) | 下标表直接定位（1504245） | H |
| `is_country_type` | CIsCountryTypeTrigger | 6837908 | O(1) | 指针比较 | H |
| `is_ai` | CAiTrigger | 6757994 | O(1) | | H |
| `has_origin` / `has_authority` / `has_government` | … | 6906545 / 6887924 / 6781407 | O(1) | | H |
| `is_planet_class` / `planet_size` | … | 6764866 / 6838933 | O(1) | | H |
| `has_job_type` | CHasJobType | 6982793 | O(1) | | H |
| `has_base_skill` / `has_total_skill` | … | 6871846 / 6872009 | O(1) | | H |
| `num_owned_planets` / `num_owned_colonies` | CNumOwnedColoniesTrigger | 6778260 | O(1) | 直接读数组大小 | H |
| `empire_size` | CEmpireSizeTrigger | 6838341 | O(1) | 读缓存字段（每天重算，见 03-P8） | H |
| ✅ `used_naval_capacity_integer` / `fleet_size` | … | 6873549 / 6807139 | O(1) | 读缓存字段 | H |
| `has_monthly_income` | … | 6857192 | O(1) | 上月净收入 | H |
| `resource_stockpile_compare` | … | 6895309 | O(1)（`>=`/`>` 时还要在栈上建一张 O(R) 的表） | | H |
| `has_resource`（指定资源） | CHasResourceTrigger | 6824958 | O(1)；国家作用域没指定资源时是 O(R) | | M |
| `has_country_resource` | … | 6850606 | O(R) | 每次都在栈上建整张资源表 | H |
| `is_capital` / `has_owner` / `is_owned_by` | … | 6774651 / 6757056 / 6761757 | O(1) | | H |
| `is_ruler` / `leader_class` | … | 6927931 / 6834706 | O(1) | | H |
| `is_robotic` / `is_species_class` / `is_same_species` / `is_same_species_class` | … | 6991973 / 6992049 / 6762532 / 6762819 | O(1) | | H |
| `has_citizenship_type` / `has_living_standard` | CHasSpeciesRightsTrigger<…> | 6994518 / 6995146 | 均摊 O(1) | FNV 哈希查找（1379137） | H |
| `is_at_war` | CIsAtWar | 6775445 | O(1) | | H |
| `is_at_war_with` | CIsAtWarWithTrigger | 6763274 | O(log N) | 关系二分查找（2200926） | H |
| `exists` | CExistsTrigger | 6829424 | O(1) + **作用域拷贝** | 要调用 `GetScope` | H |
| `distance` | CDistanceTrigger | 6795718 | O(1)（欧氏距离，或查预算的航道矩阵） | 国家有 bypass 时要加读锁查缓存，未命中跑 A*（04-F1） | M |

## 二、线性，n 很小

| trigger | 类 | 行 | 开销 | n 是什么（实际规模） | 置信度 |
|---|---|---|---|---|---|
| `has_trait` | CHasTrait | 6760360 | O(k) | 物种特质 5–15 / 领袖特质 3–10（指针比较） | H |
| `has_ethic` / `has_civic` | … | 6759378 / 6888690 | O(k) | 最多 4 个思潮 / 最多 5 个国策 | H |
| `has_ethos` | CHasEthosTrigger | 6758961 | O(a·b) | 最多 4×4，两层循环 | H |
| `has_tradition` / `has_ascension_perk` | CHasTraditionTrigger<…> | 6885631 / ~6886051 | O(k) | 已采纳传统 0–80 / 飞升天赋最多约 12 | H |
| `has_policy_flag` / `has_edict` | … | 6812858 / 6829840 | O(k) | 政策 flag 20–40 / 生效法令 | H |
| ✅ `has_*_flag` | CHasFlagTrigger | 6751401 | O(k) | 对象上的 flag 数；**global flag 可以有数百个**；`flag@目标` 每次都要拼字符串（08-A） | H |
| `has_relation_flag` | … | 6828507 | O(log N + k) | | H |
| `has_modifier` | CHasModifierTrigger | 6769011 | O(k) | 对象上的计时 modifier（国家 10–60 个）；舰队作用域见 T8 | H |
| `has_planet_modifier` | … | 6839016 | O(k) | 最多约 5 个 | H |
| `has_building` | CHasBuildingTrigger | 6807868 | O(B)，写 `= yes` 时 O(D·Z) | 单个星球 | H |
| `has_district` / `has_deposit` | … | 6810266 / 6836681 | O(k) | 单个星球 | H |
| `num_districts` / `num_zones` / `num_buildings`（**星球**作用域） | … | 6811486 / 6811842 / 6809223 | O(D·Z·B) | 单个星球，几十个 | H |
| `num_assigned_jobs`（星球） | … | 6871283 | O(J + 该岗位的人口组) | | H |
| `free_jobs` / `num_unemployed`（星球） | … | 6778429 / 6778749 | O(1)–O(J) | | H |
| `has_megastructure` / `has_starbase_building` | … | 6882912 / 6941738 | O(k) | | M |
| `intel` | CIntelTrigger | 6970136 | O(N) | 情报条目，每个已知国家一条；`GetIntelData`（767107）是线性扫描 | H |
| `has_active_event` | CHasActiveEventTrigger | 6903276 | O(列出的事件 × 打开的事件窗口 × 事件历史) | 通常很小 | M |
| `check_modifier_value` | … | 6803608 | O(M) | modifier 条目有数百条，线性查找 | H |
| `has_claim`（星系/星球目标） | … | 6894088 | O(宣称数) + 作用域拷贝 | | H |
| `is_hostile` | CIsHostileTrigger | 6847710 | 大多 O(1) | 会沿宗主国递归；叛军路径要调用游戏规则 `AreRebelsHostile` | M |

## 三、线性且 n 很大，或者藏着循环

| trigger | 类 | 行 | 开销 | 备注 | 置信度 |
|---|---|---|---|---|---|
| `num_buildings`（**国家**） | CNumBuildingsTrigger | 6809223 | O(C·(limit + D·Z·B)) | 每个殖民地都要**拷贝一次作用域**并求值 `limit`（6809264、6809654） | H |
| `num_districts`（国家） | … | 6811486 | O(C·D) | | H |
| ✅ `num_zones`（国家） | CNumZonesTrigger | 6811842 | O(C·D·Z) | **疑似 bug**：见 T2 | H |
| `num_assigned_jobs` / `num_unemployed`（国家） | … | | O(C·J) / O(C) | | H |
| ✅ `num_ships`（国家） | CNumShipsTrigger | 6839977 | O(F·S) | 每艘船一次虚调用（08-E5） | H |
| `count_used_naval_cap` | … | 6926030 | O(S) + 堆分配数组 | | H |
| `max_naval_capacity` / `used_naval_capacity_percent` | … | 6873279 / 6873414 | O(M·(1+附庸数)) + 游戏规则 | **每次都重算**，见 T7 | H |
| ✅ `ethos`（星球） | CEthosTrigger | 6816520 | O(人口组 × 组思潮 × 国家思潮) | 3 层循环，循环条件里还有虚调用 | H |
| `has_valid_civic` | CHasValidCivicTrigger | 6889991 | 构建配置 + 4 个堆数组 | 见 T5 | M |
| `has_claim`（国家目标） | `HasClaim` 2325170 | O(目标国家的星系 × 宣称数) | | H |
| `any_/count_owned_planet` | CAnyInScriptedListTrigger<COwnedPlanetListBuilder> | 6549730 | 复制 O(C) + C × 内部 | 复制预建的 ID 数组（`country+0x2750`），一次作用域拷贝；`any_` 命中即停 | H |
| ✅ `any_/count_owned_pop_group` | COwnedPopGroupListBuilder::CountAndList | 6583329 | O(C + G) + G × 内部 | **国家层面没有现成数组**：遍历殖民地，把每个殖民地的人口组列表拼起来 | H |
| ✅ `count_owned_pop_amount`（即 `pop_amount`、`sapient_pop_amount`） | CCountInScriptedListTrigger<COwnedPopAmountListBuilder> | 6587938 | **2 × O(C + G)** + G × limit | 见 T1 | H |
| `any_neighbor_country` | CNeighborCountryListBuilder | 6337186 | O(N log N) | 见 T6 | H |
| `any_species_pop_group` | CSpeciesPopGroupListBuilder | ~6589276 | O(全银河的人口组) | 扫描 `gamestate+0x628`，triggers.log 本身就注明了 "resource-intensive" | H |
| `any_owned_ship` / `any_country` / `any_galaxy_planet` | … | 6615414 / 6328023 / 6566149 | O(F·S) / O(N) / O(全部星球) | | M |

## 四、非常贵（求值脚本或重算派生状态）

| trigger | 类 | 行 | 开销 | 置信度 |
|---|---|---|---|---|
| `habitability` | CHabitabilityTrigger | 6807412 | 2 次作用域拷贝 + `CalcHabitability`（2705233）：构建 `CModifier`，堆分配 modifier 类型数组，`ApplyTriggeredColonyModifiersValueOnly`（再构造 3 个作用域，**求值每个特质上的 triggered 星球 modifier**）。见 T3 | H |
| `opinion` | COpinionTrigger | 6787968 | 只有线程局部的好感缓存处于启用状态时才走缓存；否则调用 `CalcOurOpinionOfOther`（2035328），构造 2 个作用域，求值全部好感 modifier 的 trigger 和脚本值。见 11-D5 | H |
| `pop_amount_percentage` | … | 6980944 | G × (`limit` + `exclude` 各一次 trigger 求值)；国家作用域下 G 是全部自有人口组 | H |
| 失败的作用域切换（目标无效，且没写 `?`） | CContextTrigger | 6747690 | **每次**都把整个作用域序列化进错误日志（08-B8-(3)）；目标有效时只有一次作用域拷贝 | H |

## 最出乎意料的发现

- **T1 ✅ `pop_amount` / `sapient_pop_amount` 是 scripted_trigger，而且要把全部人口组遍历两遍**：
  - 它们展开成 `count_owned_pop_amount`，其 `CalculateCount` 两次调用 `COwnedPopGroupListBuilder::CountAndList`，第一次数数量（6587977），第二次填充（6588006）。
  - 只有累计值超过阈值时才提前退出（6588067）：`if (local_1ac < iVar6) break;`。**结果为假时总是全部遍历。**
  - `sapient_pop_amount` 还要对每个人口组求值一次 `is_sapient`。
- **T2 ✅ 国家作用域的 `num_zones` 疑似有 bug**：同样的循环里，`num_districts` 写的是 `*param_2 = *param_2 + iVar4`（累加），而 `num_zones` 在 6811875 写的是 `*param_2 = iVar3`（覆盖）。付出了 O(C·D·Z) 的开销，得到的却似乎只是最后一个殖民地的数量。**这是仅凭反编译得出的判断，使用前请在游戏里验证。**
- **T3 `habitability` 要求值脚本**：构造 5 个作用域，有堆分配，并对物种的每个特质求值 triggered modifier（`AddModifierValueOnlyIfPotential`，1325857）。
- **T4 `opinion` 在 AI 作用域之外每次都完整重算**（见 11-D5）。
- **T5 `has_valid_civic` 比 `has_civic` 重得多**：要构建 `SEthicGovernmentConfiguration`（之后有 4 次 `operator_delete__`），再调用 `CGovernmentCivicType::IsPossible`。原版的 `is_homicidal` 要调用它 5 次。
- **T6 `any_neighbor_country` 会扫描银河里的每个国家**（`g_CurrentGameState+0x548`，6337263），对每个国家调用 `IsBorderingCountry`（关系二分查找）。这一遍扫描完成之后，才开始求值内部的 trigger。
- **T7 `max_naval_capacity` / `used_naval_capacity_percent` 每次都重算**：线性查找 modifier 数组（2071647），递归计算每个附庸的海军容量（2071662），还要求值游戏规则 `IsMercenary`。只有 `used_naval_capacity_integer` 读的是缓存。
- **T8 舰队作用域的 `has_modifier` 可能有堆分配**：某个分支复制了舰队的整个舰船数组（6769130），只为了取第 0 个元素。这里的控制流不太清楚，置信度中。
- **作用域拷贝藏在"简单"的 trigger 里**：`exists`、`has_claim`、每次作用域切换，以及国家作用域 `num_buildings` 的每个殖民地，都会构造一个完整的 `CEventScope`。

## 替换建议（贵 → 便宜）

| 想判断的事 | 不要用 | 改用 |
|---|---|---|
| 国家规模、人口多少 | `pop_amount`/`sapient_pop_amount`（两遍全人口组）、`pop_amount_percentage` | `num_owned_colonies`、`empire_size`（O(1)）；或者在星球作用域里判断 |
| 海军规模 | `used_naval_capacity_percent`、`max_naval_capacity`、`count_used_naval_cap`、国家作用域的 `num_ships` | `used_naval_capacity_integer`、`fleet_size`（O(1)） |
| 国策 | `has_valid_civic`（除非真的需要验证有效性） | `has_civic` |
| 政体类型 | —— | `is_gestalt`、`is_machine_empire`、`has_authority`（O(1) 或很小） |
| 建筑、区划、岗位数量 | 国家作用域的 `num_buildings`（每个殖民地拷贝一次作用域）、`num_districts`、`num_assigned_jobs`；国家作用域的 `num_zones`（疑似 bug） | `any_owned_planet = { 星球作用域的 has_building / num_buildings … }`（命中即停） |
| 邻国 | `any_neighbor_country`（全银河扫描） | `any_relation`、`any_subject` 等基于关系列表的迭代器，再加条件 |
| 某物种的人口 | `any_species_pop_group`（全银河的人口组） | 从自己的殖民地出发迭代 |
| 宜居度、好感度 | 放在最前面 | **把便宜的过滤放在前面**（`CAnyTrigger` 在第一个 false 就返回，6749371）：`is_planet_class`、`planet_size`、`has_owner`、`is_ai`、`is_country_type`、`is_at_war_with`、`has_relation_flag` |
| 切换到可能不存在的作用域 | 直接写 `owner = { … }` | 先用 `exists = owner` / `has_owner = yes` 判断，或者写 `owner? = { }` |
