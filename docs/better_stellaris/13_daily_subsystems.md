# 13 其他日更 / 月更子系统

**总体结论**：没有灾难性的问题。反复出现的开销是：**脚本有效性 trigger 每天都要对"实体 × 国家"全量轮询**，而这些结果其实很少变化，其中很多还是在主线程上串行执行的。宇宙风暴和灵能光环这两个新 DLC 系统反而都很便宜。注意：顶层的 `DailyUpdate` 没能反编译出来，阶段顺序是推断的。

✅ 表示我亲自读过代码确认。

### S1 ✅ 宣战理由每天都按"国家 × 理由类型 × 其他国家"全量重建（影响：高）
- `CDiplomacyCountryModule::UpdateCasusBelliOnlyChangeSafePrivateWithTypeAgainst`（2324251–2324628），每天由 `DailyUpdateOnlyChangeSafePrivate`（2325249）调用。
- 外层遍历全部理由类型（数量在 `CCasusBelliTypeDatabase+0x5c`），内层遍历**全局国家列表**（`g_CurrentGameState+0x548/+0x554`）。每一对：
  - `CCasusBelli::AllowCasusBelliBetween`（检查是否建立通讯，再看国家类型 flag）；
  - 通过后求值 `CCasusBelliType::IsPotential`（`casus_belli.X.potential` 这个 trigger），再求值 `IsValidAsDynamic`（第二个 trigger）；
  - 然后对已找到的理由做一次线性去重。
- **开销**：廉价过滤约 O(C × T × C)，大约每天 30 × 300 × 300 ≈ 270 万次；约 50 个已接触帝国 × 30 种理由，每天 7.5 万–15 万次 trigger 求值。按国家并行。
- **修复**：交换循环顺序（外层国家对），把 `AllowCasusBelliBetween` 提到类型循环外；按 `(国家ID + 天) % N` 错开，或者只在战争、宣称、思潮、附庸关系变化时重算对应的国家对。
- **mod 侧**：宣战理由的 `potential` 开头放便宜的排除条件，把昂贵的检查挪到 `is_valid`。**每加一种宣战理由，每天就多"国家数 × 已接触国家数"次 trigger 求值。**

### S2 `CShip::DailyUpdateSerial`：每艘船每天串行执行（影响：中高；置信度：中）
- 每艘存活的舰船每天都要执行 `UpdateDailyDamageFromAuras`、`CColonyCarrier::DailyUpdate`、`DailyUpdateRepair`、`DailyUpdateUpgrade`、`DailyUpdateCollectStockpile`、`TickLandArmy`（3520028）。
- `DailyUpdateRepair`（3520460）：`ShouldSelfRepair` 对任何能移动的非空间站舰船都为真，**不管有没有受损**。之后在计算回复量之前，要调用 6 次 `CShipSize::GetModifierValue(size, 静态modifier, id)`（id 0x20/0x22/0x27/0x29/0x31/0x33）。
  - `GetModifierValue`（3612679）先线性扫描 modifier 数组，再查一次哈希表。
  - 输入是静态 modifier 加舰船尺寸，**结果在整局游戏里恒定**，却每艘船每天都要重算一遍。
- 另见 04-F7：舰队维修完成当天，是 O(舰队规模²)。
- **开销**：约 2 万艘船 × 6 次线性查找，每天几毫秒，串行。
- **修复**：把自修复相关的静态值缓存在 `CShipSize` 上；船体和装甲都满时直接返回；把纯数值计算挪到并行阶段。

### S3 `CCountryEventManager::DailyUpdateSerial`：特殊项目、事件链、局势每天轮询 trigger（影响：中）
- 2172871–2173402，由 `CCountry::DailyUpdateSerial` 调用，**按国家串行**。
- 每个特殊项目执行 `ShouldAbort`（trigger）、`CanProgress`、`ShouldFail`（trigger）；每条事件链执行 `ShouldAbort`；每个 POI 执行 `ToBeKilled`；每个局势执行 `CSituation::CheckValidity`（1278018），里面每天都要求值 `CSituationType::IsPotential` 和 `ShouldAbort`。
- **开销**：Σ国家(项目数 × 2–3 + 事件链数 + 局势数 × 2)，每天可达数千次串行求值（AI 会囤积大量未完成的项目）。
- **修复**：中止和失败条件改为每周或每月检查，或者由事件触发；局势本来就有月更（`HandleMonthlyTickSerial`），可以放在那里。
- **mod 侧**：特殊项目和局势的 `abort_trigger`/`fail_trigger` 要写得便宜，不要用 `any_galaxy_planet` 这类全局扫描。

### S4 考古遗址和星界裂隙：每天对"每个遗址 × 每个国家"重新判断可见性（影响：中低）
- **考古**（`CArchaeologicalSite::DailyUpdateSerial` 1773707）：遍历**全局国家列表**，在检查"这个国家是不是已经能看到它"**之前**，就先求值遗址类型的 `visible` trigger，然后重建可见列表。开销是"遗址数（20–60）× 国家数（最多约 300）"次 trigger 求值，每天串行执行。
  - 管理器（`CArchaeologicalSiteManager::DailyUpdate` 1782825）预先抽好了随机数种子，本意是让每个遗址的计算可以确定性地多线程执行，**但实际上还是在普通的串行循环里调用 `DailyUpdateThreaded`**，这个多线程设计没有用上。
- **星界裂隙**（`CAstralRift::DailyUpdateThreaded` 3038601）：裂隙数 × 全部国家 × 两个游戏规则（`CanInteractWithAstralRift`、`CanExploreAstralRift`），每天执行，并行。
- **修复**：跳过已经能看到的国家；只考虑有相关存在的国家；错开执行；考古的线程阶段改为 ParallelFor。
- **mod 侧**：`visible` 和裂隙相关的游戏规则要写得极其便宜。

### S5 法令每天都检查有效性（影响：中低）
- `CCountry::DailyUpdateSerial`（2016814）每天对每个国家的每个生效法令执行 `IsAllowed`、`IsPotential`、`HasPrereqs`，即 3 个 trigger，串行执行。
- 同一个函数里的 `UpdateRelayNetwork` 和 `UpdateWaystationNetworks` 就做得很好：只在 `countryID % 30 == 当月第几天` 时执行。
- **修复**：改为每月检查，或者照中继网络那样按 ID 错开。

### S6 `CGameState::MonthlyUpdate`（416529）：阶段结构与串行热点（影响：中低）
- **并行阶段**：国家的 `MonthlyUpdateOnlyChangeSafePrivate` / `SelfDontReadOthers` / `MonthlyUpdateStrategy`（带 `COpinionCache`）/ `MonthlyCopyAttitudes`，舰船 `MonthlyUpdateSelfDontReadOthers`，`CStarbase::MonthlyUpdateParallel`，`CPsionicAuraManager`。
- **串行循环**：
  - `CTradeDeal::MonthlyUpdateSerial`、`CGalacticCommunity::MonthlyUpdate`、`CMarket::MonthlyUpdate`；
  - 对每个存活国家执行 `CCountry::MonthlyUpdateSerial`（418159），其中包括 03 号文件里那两遍岗位分配所在的调用链，以及 12-AI5 的星球自动化；
  - `CAgreementManager`、`CPlanetManager`、`NColonyUpdate::MonthlyUpdate`、`CStarbaseManager`；
  - 所有联邦、所有战争、**所有舰船**（`CShip::MonthlyUpdateSerial` 418284）、**所有舰队**（`CFleet::MonthlyUpdateSerial` 418316）；
  - 每个国家触发一次 `on_biomass_monthly`。
- **嵌套 fork/join**（见 05-E7）：`CCountry::MonthlyUpdateSerial`（2022050）在串行的国家循环里，还会对自己的关系单独开一个 `CJob` 并行循环（`CRelation::MonthlyUpdateRelationValue` → `CalcRelationValue`）。结果每月最多 C 轮 fork/join，每轮只有 O(C) 个元素，总计 O(C²)，批处理效率很差。
- 每个国家每月还要串行执行 `CAIPersonality::CalcWeight`（脚本权重）、`HandleForcedSpeciesIntegration`，以及 `UpdateIsUnderCrisisAttackStatus`（2023162）：危机期间要遍历全部国家做 `IsHostile` + `IsBorderingCountry`，再遍历自有星系 × 舰队。
- **修复**：所有关系放进一个全局的并行循环；AI 性格和危机状态检查挪到并行阶段。

### S7 `CMarket::DailyUpdate`：每天对每个市场国家求值一次游戏规则（影响：低到中）
- 860022：对每个市场国家执行 `CGameRules::EvaluateWithCountryAsThis(规则 0x50, country)`（脚本，不缓存），再执行 `UpdateInternalMarketFluctuations`（O(资源数)）。很可能是串行的。
- **修复**：按月缓存规则结果。

### S8 焦点卡：每天轮询完成条件（影响：低）
- `CCountryFocusManager::DailyUpdate`（2189859）每天对每个国家的每张生效卡片调用一次完成条件 trigger 的 `Evaluate`。**mod 侧**：完成条件 trigger 要写得便宜。

### S9 宇宙风暴：设计良好（影响：低）
- `CCosmicStormManager::DailyUpdate`（3192630）对风暴做一次稳定排序，再逐个串行执行 `DailyUpdateSerial`（3185682）。
- 每个风暴的"范围内星系 × 国家列表"循环**先按人类玩家标志（`+0x31dc`）过滤**，只有人类玩家才要付 `CalcNumJumpsFromBorder` 的开销（边境星系 × `GetJumps`，没有 bypass 时是 O(1) 查表；有 bypass 时见 04-F1）。
- `HandleCollisions` 是 O(风暴数²)，风暴只有 10–20 个，可以忽略；路径是链表，每天从头遍历一次，也可以忽略。
- **好的设计**：影响场只在开局或通过 `CRecalculateStormInfluenceFieldsEffect` 重算；图形重建由 `CalcIsSystemsDirty` 控制；破坏效果每月结算。

### S10 灵能光环：设计良好（影响：低）
- `CPsionicAuraManager::DailyUpdate` / `MonthlyUpdate`（3510042 / 3510494）：先并行计算，再串行应用。
- 光环是按国家存储的 Shroud 状态，**不是空间性的**，所以**不存在"光环 × 光环"或"光环 × 星系"的重叠计算**。每天只有 `GetDailyDecrease`（一个 script value），每月一次 `OnMonthly`，都是 O(光环数)。

### S11 其他检查过的系统，都很轻
- **巨构**（`CMegaStructure::DailyUpdateSerial` 3440967）：每天对当前的超频执行一次 `COverclockType::IsPotential`，超频失效时扫描一遍超频类型。
- **地面战**（`CGroundCombat::DailyUpdateInternalSide` 690770）：每场战斗每天 O(陆军数)，外加一次 `CalcCombatWidth`。
- **战争**：`CWar::DailyUpdateSerial` 很轻（两次 `CalcCachedWarExhaustion`）。
- **联邦**、**间谍**、**预算**（`CCountryBudget::EndMonthlyUpdate`，O(条目 × 资源)）：都很小。
- **恒星基地**（`CStarbase::MonthlyUpdateParallel` 1412909）：对星系内每个殖民地求值抢夺相关的 trigger，并调用 `CalcProducesIncludePops`，每月执行，并行。
- **事件历史**（`CEventHistoryManager::DailyUpdate` 2447609）：超过 1024 条时裁剪到 512 条，但每次裁剪都要把整个列表拼成字符串写两次日志。均摊后影响低。
- **年更**（`CGameState::YearlyUpdate` 418457）：年度 on_action，加上 `CShipDesignManager::ClearUnusedShipDesigns`（1252794，用位图标记，O(舰船 + 设计)，设计良好）。

### 通用模式与修复
- **主要开销**：每天轮询脚本有效性 trigger，包括宣战理由的 potential/valid、项目和局势的 abort、法令、遗址和裂隙的可见性、焦点卡、市场规则。复杂度大多是 O(实体 × 国家)，而且很多是串行的。
- **通用修复**：按 ID 取模 7 或 30 错开执行（中继网络就已经这么做了）；跳过已经处于目标状态的组合；改用事件驱动的 dirty 标志；把串行循环（舰船、考古）挪进已有的并行阶段。
- **通用 mod 建议**：`potential`、`abort`、`visible`、`is_valid` 这类 trigger 要写得便宜，**第一个条件放最快的排除项**。
