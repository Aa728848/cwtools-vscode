# 11 物种、领袖、外交、派系、银河议会

规模假设：C（国家）100–300；S（物种）后期 500–5000；P（人口组）1–3 万；L（领袖）2000–6000。✅ 表示我亲自读过代码确认。

### D1 ✅ 派系潜在成员缓存：每天对每个人口组都重建一遍（影响：高）
- `CPopFactionsCountryModule::DailyUpdateSelfDontReadOthers`（1103028）每天对每个国家执行：先对每种派系类型求值 `CPopFactionType::IsPotential`，然后**无条件**调用 `UpdateFactionsPopsCache`（1100540，调用点在 1103090）。
- `UpdateFactionsPopsCache` 遍历每个殖民地的每个人口组，对每个人口组执行：
  - `CPopGroup::CanJoinFactions`：求值游戏规则 `CGameRules::CanPopGroupJoinFactions`（1054839，完全不缓存，见 08-C）；
  - `FillPopGroupPotentialMembers`（1101313）：对**每种**可能的派系类型调用 `CPopGroup::CanJoinFaction`，每次都构造一个 `CEventScope` 并执行 `can_join_faction` 脚本 trigger（1059040 起）；
  - `CountEligiblePops`，再对每个派系线性扫描一遍派系类型。
- **对比**：真正的成员变动（`CheckPopFactionChange` → `FillWantedFactionsFor`）是按殖民地每 30 天轮一次（`(day + colonyId) % 30`，约 1052735）。**只有这个"潜在成员缓存"每天对全部人口组都算一遍。**
- 每国用到的临时数组按全局的 `GetHighestPopFactionIndex` 分配，每天分配一次。
- **开销**：每天约 P × (1 次游戏规则 + F 次 trigger 作用域)，后期每天 20 万–40 万次 trigger 求值。虽然在并行的国家阶段执行，墙钟时间仍然很重。
- **修复**：套用同样的 30 天殖民地轮转，或者只在人口组变化（dirty）时重算。
- **mod 侧**：`can_join_faction`、`is_potential` 和 `can_pop_group_join_factions` 游戏规则必须写得极其便宜；便宜的人口类别或思潮检查放在最前面。

### D2 ✅ 物种查重是线性扫描，单次比较还很重（影响：中高）
- 详见 10-1。`CGameState::CreateNewSpecies`（408141）和 `FindSpecies(const CSpecies&)`（432050）都逐个比较全部物种：先 `IsDummySpecies`，再 `CSpecies::IsEqual`（1328442）。
- `IsEqual` **先调用** `IsBaseSpeciesEqual`（一个 243 行的函数），之后才做名字比较等便宜的检查；特质匹配是 O(T²)；flag 用 `IsPermutation` 比较。**便宜的检查放在了昂贵的检查后面。**
- 物种数据库 dirty 后（`+0x1676`），每新建一个物种都要 O(S) 重建一遍物种引用数组。
- **调用方**：`modify_species`、`create_species`、`create_country`、叛乱、提升、基因改造模板等。
- **开销**：每次 O(S·T²)。如果在 on_action 里大量 `modify_species`，整局累计会接近 O(S²)。
- **修复**：用（基础物种、类别、立绘、排序后的特质指针、名字、flag）做哈希键，只在哈希碰撞时才调用完整的 `IsEqual`；或者至少先比较便宜的字段。

### D3 按名字查物种：每个物种都要现场构建一次名字键（影响：中）
- `CGameState::FindSpecies(CString)`（432092）对**每个物种**都调用一次 `GetBaseNameKey` → `CalcBaseNameKey`（938113）：`strlen`、名字超过 15 个字符时堆分配、`DoForVariables`，然后 `memcmp`。
- **调用方**：按名字指定物种的 `create_pop_group`（`CCreatePopGroupEffect::CalcSpecies` 6169583）、`add_pops`、建立殖民地、`change_dominant_species`、`create_country`。
- **修复**：维护"名字键 → 物种"的哈希表，或者把名字键缓存在 `CSpecies` 上。

### D4 殖民物种列表：扫描全部人口组，逐个调用游戏规则，缓冲区按全局物种数分配（影响：中）
- `NHabitability::CalcHighestHabitabilityWithPlanetClass`（2705515）分配并 memset 一个长度为**全局物种总数**（`g_CurrentGameState+0x1fc`）的数组；它调用的 `CCountry::ListColonizerSpecies` / `ListExactSpecies`（2026281 / 1993360）还要在栈上 alloca 一块"物种总数 × 8 字节"的缓冲区。
- `_ListSpecies<SExactSpeciesComp>`（2096513）遍历每个殖民地的每个人口组，线性去重。**在殖民模式下，它在去重之前就对每个人口组调用 `CGameRules::CanColonizeWithSpecies`**，同一个物种会被反复判断很多次。
- **调用方**：AI 的 `NAIUtil::ShouldColonizePlanet`（`CreateColonizeData` 对每个候选星球调用一次）、`CGalacticObject::HasColonizablePlanet`、自动化（3333734）、`CFormMigrationPactAction::IsPossible`，以及每个载体的缓存 `CColonyCarrier::GetCachedHabitability` 未命中时。
- **开销**：每次 AI 刷新约"国家人口组数 × 候选星球数"次脚本规则求值；后期每次调用在栈上 alloca 约 8·S 字节，栈帧很大。
- **修复**：按国家维护一份物种多重集合（人口变化时更新），**先去重再求值规则**，并在同一个 tick 内按物种缓存规则结果。

### D5 好感度计算很贵，而且只在 AI 作用域里缓存（影响：中）
- `CCountry::CalcOurOpinionOfOtherNoScopeCopy`（2035390，1372 行）：
  - **即使不需要 tooltip，也每次都构建一个 `CGameText`**（2035525）；
  - 通过 `COpinionModifier::GetValueNoScopeCopy` 求值约 20 个写死的好感 modifier（都是 script value 和 trigger）；
  - 遍历全部政策。
- **好的设计**：`COpinionCache` 是一个懒填充的 N×N 稠密矩阵，用 `0x7fffffff` 表示"未计算"（962429）。
- **缺口**：这个缓存**只在** `UpdateAIParallel`（2986422）和 AI minister 的日更、周更里通过 `CSharedCacheScope` 启用。在这些作用域之外，`COpinionCalculator` 每次都从头完整重算（962771）。
- **受影响的调用**：事件、pulse、决议里的 `opinion` / `opinion_level` / `their_opinion` trigger（6787982 起）；UI 排序比较器（`SFederationTheirOpinionSorter`、`CCountryOurOpinionComparator`），它们在 std::sort 内部每比较一次就完整算一次。
- **修复**：每个 tick 启用一个共享缓存（每天重置）；不需要 tooltip 时（`param_3 == null`）跳过 `CGameText`。
- **mod 侧**：不要在 pulse 里的 `every_country` / `any_country` 中用 `opinion` trigger；先用 `has_communications`、`is_country_type` 这类便宜的检查过滤。

### D6 每月逐关系重算外交数据（影响：中；置信度：中高）
- `CDiplomacyCountryModule::MonthlyUpdateSerial`（2319304）在**串行阶段**对每个国家的每条关系执行，约 C × R ≈ C²：
  - `CCountry::CalcMonthlyTrustChange`（611 行）；
  - `CRelation::GetMaxTrust`（406 行），信任被钳制时要调用两次；
  - 双向各一次 `CalcNumBorderingSystems`：对方每个星系 × `CalcIsBorderingSystem`；
  - 双向各一次 `CalcNumClaims`；
  - 线性扫描 modifier 数组，找摩擦和宿敌 modifier；
  - 线性查找威胁列表。
- **好的设计**：好感衰减用 `CRelation::UpdateOpinions`（1159708）维护的累计和（`+0x28`）；增长率 modifier 按 12 个月的周期重算。
- **修复**：已知"不接壤"时跳过接壤星系计数；缓存 `GetMaxTrust` 的结果；在国家之间错开执行。

### D7 领袖的 triggered 星系和统治者 modifier 每天对每个领袖都算一遍，不分摊（影响：中）
- `CLeader::DailyUpdateOnlyChangeSafePrivate`（813305）：`UpdateTriggeredSelfModifiers` 按 `(day + id) % TRIGGERED_MODIFIER_UPDATE_DELAY` 分摊；**但 `UpdateTriggeredSystemModifiers`（813538）和 `UpdateRulerTriggeredModifiers` 每天都执行**。
- `UpdateTriggeredSystemModifiers` 会构建一个临时 `CModifier`，对物种特质执行 `CTraitSet::ApplyTriggeredLeaderModifiers`（脚本），解析领袖位置（将军还要 `CGroundCombat::FindBestGeneral`），对每个领袖特质执行 `CalculateTriggeredSystemModifier`（脚本），最后算一次 MurHash 做比较。
- **好的设计**：有哈希比较，只有真的变化才会让 modifier 节点失效（`DailyUpdateSerial` 814144）。
- **开销**：每天约 L × (物种特质数 + 领袖特质数) 次 trigger 求值。
- **修复**：套用同样的分摊，或只在位置或特质变化时重算。
- **mod 侧**：物种和领袖特质上的 `triggered_*_modifier` 里的 trigger 要写得便宜。

### D8 领袖池：基本没问题，mod 有一个注意点（影响：低）
- 刷新由 `LEADER_POOL_REFRESH_TIME` 和开局年份判断控制（840296）。
- `AddToLeaderPool` 对**每个**生成的领袖触发一次 `on_added_to_leader_pool`（840146）。如果 mod 在这里挂了重脚本，每次刷新都要乘上"国家数 × 领袖类别数"。

### D9 思潮吸引力：大体设计良好（影响：低）
- 国家层面的吸引力按国家缓存（`UpdateCountryEthicsSafePrivate` 2013518）。
- 人口组的思潮偏移按 `POP_ETHOS_DIVERGENCE_INTERVAL` 加 ID 偏移分摊，再加一次随机判定（约 1054950）；每个人口组的吸引力缓存在 `+0x328`。
- 小浪费：`CEthic::CalcCountryPopsAttraction`（2416978）对每个人口组重新执行脚本吸引力计算，没有读缓存。但它只在 `RemoveOrDowngradeEthics` 里调用，很少发生。另外 10 号文件里提到的 `shift_ethic` 也会走这条路径。

### D10 物种权利、`has_trait`、宜居度：设计良好
- `CSpeciesRightsModule::GetSpeciesRightsConfig` / `CalcSpeciesRights`（1379137）：每个物种用 FNV / robin-hood 哈希查找，基础物种回退有上限。
- `CHasTrait::ActualEvaluate`（6760358）：在特质列表里做指针比较，列表很短。
- 宜居度按"载体 × 国家"缓存（`GetCachedHabitability`），未命中时走 D4 的慢路径。

### D11 银河议会与联邦：大多不重（影响：低）
- `CGalacticCommunity::DailyUpdate`（2539810）：
  - 每天对成员做一次稳定排序，但比较器读的是缓存的外交权重（`+0x3000`），很便宜；
  - `ValidateVoters` 用线性的 `IsMember`，最坏每天 O(投票者 × 成员) ≈ C²；
  - 议会资格的游戏规则（通过 `CGameRules::EvaluateWithCountryAsThis` 读取）每天对每个议员求值一次；
  - 银河焦点的二分插入在每一步都要对候选和基准各求值一次 `CMeanTimeToHappen::GetRawFactor`。
- `CResolution::CalcSupport` 对每个投票者调用一次 `CalcTotalDiplomacyWeightBorrowed`（只在 AI 和 UI 中）。
- `CFederation::DailyUpdateSerial` 很轻。

### 优先级建议
D1（派系缓存）> D4（殖民物种列表）> D5（好感缓存范围）> D2/D3（物种查重和按名查找）> D7（领袖 modifier）> D6（每月外交重算）。
