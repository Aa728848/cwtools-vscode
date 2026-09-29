# 12 AI 经济、殖民、决议、自动化、自动设计、建造队列

**AI 的调度方式**（决定了下面所有开销的频率）：每个国家的 AI 各有自己错开的倒计时，每周在 `id%7` 那天执行，每月在 `id%30` 那天，每年在 `id%360` 那天（`CAICore` 构造函数 7878815–7878825）。所以"每月"或"每周"的工作被分散到了不同的日子，但它们仍在每个国家各自的并行 job 里执行，**最贵的那个国家就是当天 AI 阶段的关键路径**。

✅ 表示我亲自读过代码确认。

### AI1 `CreateColonizeData` 每个 AI 都扫描全银河的星球，宜居度不走缓存，还要调用脚本（影响：高；开销置信度高，频率置信度中）
- 外层遍历**全部星系**（`g_CurrentGameState+0x578/0x584`，2763232 / 2763326）；每个星系先 `HasAccess`、`CalcIsBorderingSystem`，再遍历其中所有星球。
- 每个已勘测的星球执行：
  - `CPlanet::CanColonize`（2763455），它会调用 `can_colonize_planet` 游戏规则（`CScriptedRule::Evaluate`，372249，不缓存）；
  - `NAIUtil::ShouldColonizePlanet`（2966302）：在 `AI_BUDGETING_LATE_YEARS` 之前**直接**调用 `NHabitability::CalcHighestHabitability`，**不走缓存**；还要**遍历全部国家**，对每个堕落帝国求值一次 `will_anger_fallen_empire` 规则。
- `CalcHighestHabitabilityWithPlanetClass` 对每个可殖民物种调用 `CalcHabitability`：构建 `CModifier`，执行 `ApplyTriggeredColonyModifiersValueOnly`，求值特质 trigger（2705300–2705320）；前面还有 11-D4 描述的全人口组扫描。
- **开销**：每个 AI 约 1000 个星系 × 5000–10000 个星球 × 可殖民物种数（后期 5–30）× 特质 trigger。
- **频率**：在 `CreateStrategicData`（2761103–2761115）里执行，条件是 `id%12 == month` 或某个字段已置位；但在 `START_YEAR + AI_BUDGETING_START_YEARS`（15 年）之前、或 AI 标志 0x820 未置位时，**每次战略更新都会执行**。
- **修复**：改用已有的 `CColonyCarrier::GetCachedHabitability`（3155168）；只遍历扩张半径内的星系，或者维护一个增量的"已勘测且可殖民"集合；把堕落帝国列表提到星球循环外面。
- **mod 侧**：`game_rules` 里的 `can_colonize_planet` 和 `will_anger_fallen_empire` 要写得便宜；物种特质上不要挂带昂贵 trigger 的宜居度 modifier；不要调大 `AI_BUDGETING_START_YEARS`。

### AI2 AI 路径绕过宜居度缓存；缓存本身在持锁期间做计算（影响：中高）
- `GetCachedHabitability` 无论命中与否都要拿一次每个载体的 `CPdxMutex`；未命中时**在持锁期间**执行完整的 `CalcHighestHabitability`（3155187–3155210），其他线程只能等。
- 直接调用无缓存版本的有：`ShouldColonizePlanet`；`CGalacticObject::HasColonizablePlanet`（逐星球，2586020，由 `NAIUtil::CalcExpansionValue`、`CAIInteriorMinister::SurveySystems`、`CalcStarbaseSystemScore` 调用）；`CFormMigrationPactAction::IsPossible`。
- **修复**：AI 调用统一走缓存；先在锁外算好再插入（compute-then-CAS）；在相关科技、特质或星球类别变化时失效。

### AI3 殖民地"专业化"配对搜索是 O(K²)，最内层还要调用 `CanAddBuilding`（影响：大 AI 中高）
- `CAIEconomicStrategy::SpecializeAllBuildables`（2793696）最深处有 7 层循环。配对部分（2794355–2794869）：对所有 `i<j` 的殖民地对 × i 的区划 × j 的区划（类型相同）× i 的建筑 × j 的建筑，最内层调用 `CColony::CanAddBuilding(..., false, country)`，再调用两次 `CalcCost` 和一次 `CanAffordExpenditure`。
- `SpecializeBuildables<SAiBuildingBuildable>`（2830611，配对循环在 2830895）也是同样的两两配对结构，谓词里调用 `CanAddBuilding(this, zone, type, true, ...)`。
- **频率**：每个 AI 每月一次（`CAIInteriorMinister::MonthlyUpdate` → `CAIEconomicStrategy::MonthlyUpdate` 2784494 → `CreateBuildPlan` → `FillBuildPlan`）。
- **最坏情况**：只有当建造计划为空时才会执行（2790138），而这**恰好是后期"已经建满"的常态**；只有找到可交换的组合才提前退出，找不到就每月完整扫一遍 K²。
- **规模**：大 AI 有 K = 50–150 个殖民地，即 1200–11000 对 × 约 10×10 次建筑类型比较，类型匹配时还要求值脚本。
- **修复**：按区划或建筑类型给殖民地分桶，只在桶内比较；缓存"无可交换"的结论，直到殖民地发生变化。
- **mod 侧**：建筑的 `potential`/`allow` 要写得便宜；大量共享同一根类型的建筑变体会让这里更慢。

### AI4 ✅ `HandleDecisions` 每周对所拥有星系里的**每个星球 × 每个决议**做一次判断（影响：中高）
- 2847625–2847665：国家拥有星系时，遍历每个所拥有星系里的每个星球（**包括未殖民的星球**）；否则遍历殖民地列表。
- 每个星球调用一次 lambda `$_45`（2869977）：构造两个 `CEventScope`，**遍历整个 `CDecisionsDatabase`**（原版 112 个决议），对每个决议调用 `CDecision::IsAllowed(scope, true, ...)`，再调用 `GetAIWeight`（2870028）。
- **规模**：150 个星系 × 6 个星球 × 112 个决议，每个 AI 每周约 10 万次 trigger 求值；50 个 AI 每周约 70 万次，平均每天约 10 万次。
- **修复**：按目标作用域和星球类型预先划分决议；除非有决议面向未殖民星球，否则跳过它们；`potential` 里国家层面的部分每个国家只算一次。
- **mod 侧**：决议的 `potential` 开头放便宜且选择性强的检查（星球类别、`has_owner`、flag），不要在 `potential` 里写 `any_*` 扫描。**每加一个 mod 决议，所有 AI 每周就要对它们拥有的每个星球多判断一次。**

### AI5 ✅ 玩家的星球自动化每月在主线程串行执行，逐个殖民地处理（影响：200+ 殖民地的玩家中等）
- `CCountry::HandlePlanetAutomation`（2023466）只对人类玩家执行（`+0x31dc==0` 时直接返回，2023513），由 `CCountry::MonthlyUpdateSerial`（2022603）调用，**不是并行的**。
- 对每个开启自动化的殖民地：`CalcBaseSpeciesGrowthData`，然后 `CColonyAutomationManager::Update`（3483474）：对原版全部 27 个自动化逐个 `IsAvailable`，对每个建筑执行 `CollectTypesToUpgradeTo` 和 `ShouldUpgrade`，再做一轮"人口组 × 岗位"的 `CanWorkJob`，最后 `ShouldColonyAutomate`。
- 所有殖民地在同一帧里处理完，大帝国每月都会卡一下。
- **修复**：挪到并行的月更阶段（它本来就只是发命令），或者把各个殖民地错开到当月不同的日子。
- **mod 侧**：`common/colony_automation` 里的 `available` 和 `potential` 要写得便宜。
- **玩家侧**：星球多的话，只对确实需要的星球开启自动化。

### AI6 每月建造计划：并行做得好，但总量很重（影响：中；置信度：中）
- `CreateBuildPlan` 执行 `CalcBestEconomicPlan`（对所有计划做 `IsPotential`、MTTH、`CalculateIncomeTarget`）和 `CalculateIncomeTargetBasedOnForecast`。
- `FillBuildPlan`（2789321）派出 8 个 `CStealTask`（区划、建筑、区域、升级等），并用 ParallelFor 执行 `UpdatePlanetDesignations`，然后在 AI 工作线程里 `CTask::Wait` 8 次。这是嵌套等待，会阻塞那个工作线程。
- 开销与"殖民地数 × 可建造类型数"（原版约 498 种建筑，经 `HasColonyCap`/`HasEmpireLimit`/`CanAddBuilding` 过滤）成正比。
- **好的设计**：计划每月算一次，每周的 `BuildAndUpgradeDistrictsAndBuildings`（2864870）只是消费这个计划。

### AI7 科技选择：设计上就很便宜，只有重抽时有开销（影响：低到中）
- `CAIInteriorMinister::UnlockTechnologies`（2842024）**每天**对 3 个领域调用 `GetTechToResearch`，正在研究有效科技时立即返回（1509823）。真要选择时，只对当前的 3–5 个候选求值 `GetAIWeight`。
- `UpdateTechAlternatives`（1506490）会缓存候选项，只有所有候选都失效时才重抽（1506512–1506530）。重抽时要对该领域的**全部科技**（原版 677 个，分成 3 个领域）执行 `CanResearch` 和 `GetTechWeight`（543 行的脚本权重计算）；候选项去重用线性查找。
- 每天真正浪费的只有每个 AI 3 次 `CEventScope` 构造。
- **mod 侧**：科技的 `weight_modifier` 和 `potential` 要写得便宜，每研究完成一项，就要对整个领域的全部科技求值一遍（每个国家都是）。

### AI8 自动设计和自动升级：设计良好（影响：低）
- 由 dirty 标志驱动。AI 国家只在每月第 `id%30` 天执行 `SetDefaultShipDesigns`（2017241–2017249），人类玩家立即执行。
- `SetDefaultShipDesignsForOwnerType`（2002334）遍历舰船尺寸，用固定种子的 `CCrudeRandom` 随机选择区块和组件，开销和"尺寸 × 阶段 × 槽位"成线性，**不是组合爆炸**。
- 之后 `UpgradeShipsWithLatestDesign`（2178553）遍历舰队 × 舰船。

### AI9 建造队列：日更设计良好，有一个小问题（影响：低）
- `CConstructionQueueManager::DailyUpdate`（1641716）对队列做 ParallelFor；每个队列只推进"可同时建造数"以内的项目。
- 小问题：`CalcShipsUnderConstructionOfSize`（2178848）要**线性扫描两次**国家索引数组，才能找到这个国家的槽位，本可以直接下标访问（每次 O(C)）。

### AI10 `BuildShipOfOwnerType` 在内层循环里重复计算不变量（影响：低）
- 在"队列 × 自有舰队"的内层循环里，每支舰队都要调用一次 `CCountry::CalcCommandLimit(country)`（2857205），而它的值在循环里不变。提到循环外即可。

### AI11 外交等其他小循环（影响：低）
- `CAIForeignMinister::HandleRelations` 每天执行，O(关系数 × 提案数)；`CCountryAI::MonthlyUpdate` 对每个协议伙伴执行一次 `HasPossibleAgreementProposal`；`FillPlanetsRecursively`（2870085）有深度限制，每 4 个月执行一次。

### mod 作者的"倍数点"汇总
这些块会被 AI 以"国家数 × 星球数"或"国家数 × 殖民地对数"的倍数反复执行，务必写成能短路、且不含 `any_*` 扫描的形式：
- `game_rules`：`can_colonize_planet`、`will_anger_fallen_empire`、`can_colony_receive_auto_migration`；
- 物种特质上带 trigger 的宜居度或 triggered modifier；
- 建筑的 `potential`/`allow`；
- 决议的 `potential`（每个 AI 每周要对每个自有星球判断一次）；
- `colony_automation` 的 `available`；
- 科技的 `weight_modifier`。
