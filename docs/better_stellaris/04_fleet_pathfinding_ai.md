# 04 舰队 / 寻路 / 边界 / 战斗 / AI

置信度指的是"代码确实如此"；运行开销是估算，不是 profiling 的结果。V 表示星系数（1000–2000）。

### F1 ✅ 有 bypass 的国家绕过预计算距离矩阵，改走哈希缓存加 Dijkstra（影响：高；置信度：高）
- `CGalacticDistanceCache::GetDistance`（2567483–2567530）和 `GetJumps`（2567601–2567655）对合法国家（`vtbl+0x58`）**先**调用 `CCountry::GetBypassPathDistanceInfo`，只有它返回 `-100000`（表示无 bypass）时，才去读 O(1) 的三角矩阵：
  ```c
  if (((cVar2 != '\0') && …) &&
     (lVar3 = CCountry::GetBypassPathDistanceInfo((CGalacticObject *)param_1,param_2),
     lVar3 != -100000)) {
    return lVar3;
  }
  uVar4 = *(uint *)(param_2 + 8) & 0xffffff;   // 之后才查矩阵
  ```
- `GetBypassPathInfoInternal<…>`（2098535–2098657）：只要该国可用的 bypass 数（`this+0x375c`）不为 0，就执行 `CPdxReadWriteLock::LockRead`，做一次 FNV 哈希查找；未命中时运行一次完整的 `CAStarAlgorithm<…SNoHeuristics…>::Find`。没有启发函数，实际就是 Dijkstra。
- `BuildResult`（约 2142860–2143005）把找到的路径的**每一对子路径**都插入缓存，每对都要 `LockRead → UnlockRead → LockWrite → EmplaceWithHash`。长度为 L 的路径需要 O(L²) 次锁和哈希操作。
- `CCountry::DailyUpdateBypassDistanceCache`（2014705–2014800）每天重建可用 bypass 列表并 `__stable_sort`；只要列表有任何变化，`ClearBypassCaches`（2076164）就清空该国的全部三个缓存。
- **影响**：后期几乎每个国家都能用星门、虫洞或跃迁中继。于是边界、宣称、AI、风暴、`CalcNumJumpsFromBorder` 等的每次距离查询都变成"锁 + 哈希"，未命中时再加一次全图 Dijkstra。每新建一座中继或星门，该国的缓存就被整个清空。
- **修复**：
  - 只有 bypass 可能缩短路线时才走 bypass 路径，可以用"到最近 bypass 入口的航道距离"作下界来判断；
  - 或者在 bypass 集合变化时，对 bypass 入口节点预算一张小矩阵；
  - 把逐对的锁升级改成线程局部写缓冲，最后统一合并。

### F2 恒星基地每易主一次，就同步重算全图边界（影响：高到中；置信度：高）
- `CStarbase::SetOwner`（1402428）立即调用 `CGameState::CalcBorders(g_CurrentGameState,true,false,true)`。`CalcBorders`（419969–420369）依次执行：
  1. 对全部星系做 `CGalacticObject::UpdateOwnership`（并行，2584020）；
  2. `NBordersUtil::CalcBorders`（1825027）**串行**遍历 V 个星系，每个星系都在完整的国家数组里线性查找所有者（1825149–1825173：`if (*(CCountry **)(local_50 + uVar11 * 8) == pCVar10)`），合计 O(V·C)；
  3. 对每个国家执行 `UpdateBorderCacheIfNeeded`；
  4. `$_28` 对 dirty 的国家对做并行循环。每一对调用 `NDiplomacyUtil::CalcBorderDistanceBetween`（2330477），它在两个方向上各算一次"A 的边境星系 × B 的边境星系"，每次都调用 `GetDistance`（2154271–2154360），而 `GetDistance` 正是 F1 那条慢路径。
- **开销**：每次易主约 10⁵–10⁶ 次 `GetDistance`。后期战争中每天会有几十次易主。
- **修复**：`SetOwner` 里只标记 dirty，每 tick 统一重算一次；用表把所有者映射到下标；只重算受影响的邻域；两国间距离改用以 A 的边境集合为多源的 Dijkstra（O(V log V)），而且只算一次，不要每个方向各算一次。

### F3 每次寻路都要 O(V) 重置，路径的每一步都单独堆分配（影响：中；置信度：高）
- AI 用的 A*（`CAStarAlgorithm<…NAIUtil…>::Find`，2965647+）每次调用都要 alloca 并填充按星系的数组：一个循环填 0xffff，再 `memset(__s,0,V<<5)`，V=2000 时约 72 KB。bypass A*（2142391+）也一样。
- 结果是 `CList` 链表，每个节点一次 `operator_new(0x20)`，各调用方再逐个 `operator_delete`（998312、2685990、3299770 等）。
- **修复**：用线程局部、带代号标记（generation-stamped）的节点数组，重置变成 O(1)；路径改用连续数组。

### F4 ✅ `FleetPathFindCache` 是死代码，可达性检查跑完整 A*（影响：中；置信度：高）
- 全文件 grep：`g_bUseFleetPathFindCache` 只在 53297（控制台变量注册）、2022107/2022620（`MonthlyUpdateSerial`）、2986410/2986417（`UpdateAIParallel`）处被写入或保存恢复，**没有任何读取**。`g_nFleetPathFindTick` 只在 `ResetFleetPathFindCache`（3375668）里自增。
- `CFleetMovementManager::CalcCanMoveTo`（3299645+）在没有 AI 缓存时执行 `::FindPath(...)`，构建完整的 `CList`，只为了返回一个 bool。
- `CFollowFleetOrder::PerformPrePassPathFind`（3327623–3327680）每天为每支执行跟随指令的舰队调用它；许多 `C*Command::IsValid` 和 UI 检查也会调用。
- **修复**：用按国家划分的连通分量或访问位图回答可达性（`UpdateSystemStatusCache` 已经有所需数据），或者重新启用一个按 tick 标记的路径缓存。

### F5 战斗簿记每 tick 串行遍历全部舰队（影响：中；置信度：中高）
- `CGameState::MicroUpdate`（415591）由 `HandleTurnTick`（415122）调用，遍历的是全部舰队（`this+0x4e8`，数量 `+0x4f4`）。
- 并行阶段（`MicroUpdateParallel`）之后，有两个串行循环：
  - 第一个调用 `CFleet::MicroCombatSerial` → `CheckForNewCombats`（约 415930）；
  - 第二个对每支舰队执行 `GetUpdatedCombatParticipants` → `CTargeting::BuildPotentialTargetsData`（1476137，860 行，内部还有自己的并行循环和 `CJob::WaitAndClear`），再执行 `CFleet::MicroUpdateSerial`；之后无条件地往哈希表里 `CombatParticipantsPerFleet.SetEmplace`，并释放 7 个 `CPdxArray`（416013–416060）。
- 同一场战斗中每支舰队都重建同一份敌舰列表，开销是 O(参战舰队数 × 星系内舰船数)。
- **修复**：每个星系（或每一方）只构建一次目标列表并共享；不在战斗中的舰队跳过这些操作；只遍历"正在战斗的舰队"列表。

### F6 `UpdateSystemStatusCache` 每天对每个国家 × 每个星系全量重建（影响：中到低；置信度：高）
- `CCountry::UpdateSystemStatusCache`（2014470–2014593）经 `DailyUpdatePathfindingCache` 由 `DailyUpdate $_119`（485757）调用。对每个星系：
  - 线性查找受限星系列表（`+0x27e0`）和 `+0xe0` 列表；
  - 调用 `HasKnownHostiles`，在传感器范围内时，对该星系的舰队执行 `FindFirstFleetPresenceOfAlignment`；
  - 调用 `RequiresExplorationToAccess` 和 `GetIsOccludedByStorm`；
  - 调用 6 次 `HasAccess`。
- **开销**：O(C·V·(6 + 星系内舰队数))，每天约 2×10⁵ 次星系评估，跨国家并行。
- **修复**：由所有权、通行权、敌对关系、舰队到达等事件驱动增量更新；访问标志只取决于所有者，可以按（国家，所有者）对缓存。

### F7 `CShip::DailyUpdateRepair` 对维修中的舰队是 O(n²)（影响：低到中；置信度：高）
- 维修中的舰队（`fleet[0x1262]&4`）里，每一艘受损舰船都调用一次 `CFleet::CalcHitPointsPercent` 和 `CalcArmorPercent`（3520955–3520968），而这两个函数都要遍历整支舰队（3239871）。
- 一支 500 艘的 mod 大舰队，每天约 25 万次舰船访问。
- **修复**：船循环结束后，每支舰队只做一次"是否修满"检查。

### F8 `CShip::DailyUpdateCollectStockpile` 对每个采集者扫描全星系的船（影响：低，小众；置信度：高）
- 3521207–3521277：对每艘采集船（成长型舰船），遍历星系内全部舰队 × 全部舰船 × 采集类型。只有成长型或生物船停在拥挤星系时才明显。

### F9 情报系统每天对每个国家对做更新，还有字符串复制（影响：低到中；置信度：高）
- `CIntelManager::DailyUpdate`（766605）在每个国家的并行日更 job 里，再对情报条目做嵌套并行（`CIntelData::DailyUpdateThreaded` 759015），总计每天 O(C²)。
- `UpdateCachedValues`（759595–759634）对每个国家对的每份情报报告，都 `strlen` 并把报告键复制成 `std::string`（超过 15 个字符就会堆分配），只为了调用 `GetAvailableInformation(string)`。
- 每月的变化量每天都重算一次再除以 30（759085–759095）。
- **修复**：存类别下标而不是字符串；目标值改为每月或在变化时重算。

### F10 AI 军事距离表每周重建（影响：中；置信度：中）
- `CAIMilitaryMinister::CalcDistanceToObjectives`（2904609，由 `WeeklyUpdate` 2904550 调用）：
  - 对每支可用的军事舰队执行 `CalculateDistanceToSystems`，搜索范围受 `NAI::FLEET_MAX_DISTANCE_LOOKUP[_LARGE|_HUGE]` 限制，星系数 ≥1000 时用 HUGE（2905019）；
  - 结果存进"舰队 → `CPdxUnorderedMap<system,int>`"，每支舰队新分配一个；
  - 再对每个星系用 memmove 插入的方式构建排序好的 `CPdxHybridArray`（2905173–2905336）。
- **mod 侧**：调低 `NAI.FLEET_MAX_DISTANCE_LOOKUP*`。
- **修复**：每个舰队组做一次多源 Dijkstra，而不是每支舰队一次；复用容器。

### F11 AI 路径缓存是线性查找（影响：低；置信度：高）
- `CPathCache::_FindCacheRef`（2686023）每次查询都扫描整个缓存数组；未命中时用 `InsertAtEmplace` 插入一个包含 `CList` 的 `SCachedPath`。
- `CAICacheHelper` 的缓存在每次 `CCountryAI::Update` 时清空（2760278）；国家的 `CFleetTemplateManager` 缓存每天清空（2017173）。
- **修复**：用（起点，终点，flags）做哈希键。

### F12 AI 并行粒度是每个国家一个任务（影响：对 tick 时间中等；置信度：中）
- `UpdateAIParallel`（2986395）用 `ParallelForRenderFrameIfNeeded<CUpdateAIFunctor>`，一个 `CCountryAI` 一个工作项。最大的帝国和危机 AI 处在关键路径上，它们内部的循环都是串行的。
- **修复**：把重的 minister 阶段（殖民、军事距离、经济规划）拆成子任务。

## 设计良好的部分（本方向）
- **全图距离矩阵**：`BuildHyperlaneDistances`（2567816）并行构建，只在 `CGalacticMapCache::Update`（2572967）检测到 dirty 时才重建（但重建本身是全量的，见 05-E4）。
- **A\***：用二叉堆，带 decrease-key 的位置索引；bypass 缓存也会缓存"不可达"结果。
- **指令寻路并行**：`DailyUpdateHandleOrderPathfinding`（498293）。
- **战斗检测按星系分桶**：`CheckForNewCombatsParallel`（3282868）只比较同一星系内的舰队。
- **选目标节流**：`CShipTargeting::CalcBestTarget`（1477471）保留有效目标，只在 `(ticks + shipId) % 10|50 == 0` 时重新搜索。
- **边界由 dirty flag 驱动**，国家对去重后并行处理。
- **AI 分摊到不同时间**：`CAICore` 的计数器用国家 ID 做种子（7878818–7878825：`id%7`、`id%30`、`id%360`）；`CreateColonizeData` 每年执行一次，按 `id % 12 == month` 分摊。
- bypass 缓存只在排序后的列表**真的变化**时才清空。
