# 01 逐帧 / UI 开销

## 帧循环是怎么驱动 Update 的（证据）

- **帧函数**（`CGameIdler`，约 400540–400640）：先用 `g_vMaxFPS` 限帧（`nanosleep`），把 dt 钳到 0.1，调用 `CApplication::SubsystemUpdate`；**每帧调用一次 `CTooltipManager::Update`**（400600）；最后经 idler 虚表进入 `CInGameIdler::UpdateInternal`。
- **`CInGameIdler::UpdateInternal`**（710799–711322），每帧执行：
  - 710976–710984：遍历 78 个顶层 view，执行 `if (view->vtbl[0x80]()) view->vtbl[0x28]()`，即先 ShouldUpdate 再 Update。
  - 711050–711058：对已显示的 view 执行 PostCameraUpdate，`CMapIconManager::PostCameraUpdate` 就在这一步。
  - 711022 调用 `CGraphicalMap::UpdateShips`，711047 调用 `CGraphicalMap::Update`，都是无条件调用。
- **默认的 ShouldUpdate 就是 IsShown**（`CGuiView::ShouldUpdate` 7130768）。所以**窗口只要打开着就每帧 Update，没有任何节流**。
- **永远返回 1、始终每帧更新的 view**：`CAlertManager`（968237）、`COutlinerListViewBase`（4570886）、`CTooltipView`（5156941）、`CAdvisorWindow`、`CAllianceButton`、`CGalacticCommunityButton`。

## 问题列表

### U1 ✅ tooltip 在显示延迟到期前就每帧完整生成（置信度：高）
- **位置**：`CTooltipManager::Update`（5148797–5149776）。
- **流程**：
  - 5148907 取得 provider。
  - 5148919 生成文本：`(**(code **)*puVar17)(puVar17,pCVar28,0x58deca8)`；失败时退回 `g_CurrentIdler->vtbl[0x108]`，即地图对象的 tooltip。
  - 5149553–5149567 才检查 `TOOLTIP_TIME`。未到期时 `if (fVar31 < fVar32) _M_replace(s_TooltipManagerHolder,…,"",0)`，把刚生成的文本清空。
  - 延迟到期后，Trim 并拼接文本，再用 `bcmp` 和上一帧比较（5149593）。只有文本变了才重建窗口，这一步是好的。
- **为什么慢**：生成 tooltip 是游戏里最贵的文本路径。它要求值 `potential`/`allow`/`custom_tooltip` 里的 trigger 树，运行 scripted_loc，展开 modifier 明细，做本地化。只要鼠标停在某个东西上，这些工作就以 60–144 Hz 的频率重复执行，悬停在星图上也一样。
- **修复**：`TOOLTIP_TIME` 到期前不生成文本；到期后缓存结果，最多每约 250 ms，或在日期或悬停对象变化时才重建。
- **mod 侧**：`custom_tooltip` 和 scripted_loc 里不要写 `any_*`/`count_*` 这类大列表迭代。

### U2 大纲每帧全量更新（置信度：高）
- **位置**：`COutlinerListViewBase::InternalUpdate`（4555365–4555560）。ShouldUpdate 恒返回 1。
- **大纲隐藏时**（4555396–4555424）：仍然对每个分组调用计数模式的 `vtbl[0x188](group,1)`；舰队分组的实现会遍历全部自有舰队（4585524–4585564）。
- **大纲显示时**（4555442）：每个分组都执行 `UpdateEntry`。`COutlinerGroup::UpdateEntry`（4554250）会用构造出来的字符串 `"title"`/`"amount"` 按名称查找子控件。
- **展开的舰队分组**（`COutlinerGroupFleet::UpdateInternal` 4585477–4585702），每帧：复制舰队数组，执行 `RemoveIf`，调用 `std::__stable_sort<..SSortFleets>`（4585642），再对每支舰队执行 `UpdateEntry`。
- **展开的星球分组**（4578940–4579099），每帧：调用 `CCountry::ReorderColoniesByDisplayOrder`，再对每个殖民地调用 `COutlinerMemberPlanet::UpdateEntry`（4580340–4581232，约 890 行）。这个函数每次都：
  - 重建名称字符串；
  - 调用 `PdxLocalize("SECTOR_CAPITAL_NAME_WITH_FLAG")`、`"OUTLINER_LOYALTY_VALUE"`（会先算 `CalcLoyaltyGainFromBuildings`）、`"OUTLINER_BRANCH_OFFICE_VALUE"`（会先算 `CalcBranchOfficeValue`）；
  - 调用 `CalcColonizationProgressPerc`；
  - 执行 7 次 `ChangeString`。
- **做得好的地方**：`CInstantTextBox::ChangeString`（8268643）在字符串没变时直接返回，不会重新排版；整个列表的 `MergeSort`（4555493）只在分组有变化或 dirty 时才执行。
- **开销**：每帧 O(殖民地数 + 舰队数·log 舰队数)，每行还有若干次本地化和字符串分配。后期大约每帧 1000–3000 次字符串构建。
- **修复**：按轮转方式或只更新可见行，或按日、按 dirty 更新；按数值缓存本地化字符串；只在成员或排序键变化时才排序。
- **玩家侧**：折叠大纲里的"星球"和"舰队"分组。折叠后走计数路径，只会遍历，不再逐行重建。

### U3 舰队地图图标：每帧全扫描加线性匹配（置信度：高）
- **位置**：`CMapIconManager::UpdateFleetIcons`（5561377–5561565），由 `PostCameraUpdate`（5560561）每帧调用。
- **外层**：银河视图下遍历全局舰队列表 `g_CurrentGameState + 0x4e0`（5561419）。每支舰队都要查一次数据库，做 `GetOrigin`、裁剪网格检查和 `ShouldShowIconForFleet`。
- **内层**：对每个候选舰队，在已有图标数组里线性查找（5561507–5561513）：
  ```
  do { if (*(int *)(*(long *)(*(long *)(in_RDI + 0x58) + uVar11 * 8) + 0x498) ==
           *(int *)(local_240 + uVar16 * 4)) goto LAB_035ff34c; ...} while (uVar10 != uVar11);
  ```
  每次比较都要解引用一次图标指针，缓存未命中很多。
- **删除**：`UpdateIcons<CFleetMapIcon>`（5567047–5567085）从全局 `CMapIcon*` 数组中移除图标时，也是线性移除。
- **开销**：每帧 O(全部舰队 + 可见舰队 × 舰队图标数)。缩小视图时，大约每帧 10⁵–10⁶ 次指针跳转比较。
- **对比**：`UpdateGalacticObjectIcons`（5561943–5561981）已经先 `memset` 一张下标到图标的表，再直接按下标取，是 O(n)。
- **修复**：照搬星系图标的做法，用 `id & 0xffffff` 作为下标建稠密数组。

### U4 每个可见舰队图标每帧按名查找子控件并重建文本（置信度：高）
- **位置**：`CFleetMapIcon::Update`（5553742–5554168）。
- **每个图标每帧**：
  - 构造 `CString "cloaked_state"`，再用 `GetIconRecursive` 递归按名查找（5553867）；
  - 计算 HP、护盾、装甲百分比；
  - 调用 `CalcMilitaryPower`；
  - 格式化文本，执行 `ChangeString`。
- **陷阱**：名称找不到时，`GetIconRecursive`（8200512–8200538）会写日志 `"Could not find icon ..."`，而且**带 `ostream::flush()`**。GUI mod 一旦删除或改名 `cloaked_state`，每帧每支可见舰队都写一行并刷盘，会造成严重卡顿。
- **对比**：`CGalacticObjectMapIcon::Update`（5601862）只在 dirty 或 `(frameCounter + id) & 3 == 0` 时才做重活，即每帧只更新 1/4 的图标。
- **修复**：在构造或 SetFleet 时就把子控件指针缓存下来，并套用同样的 `&3` 分摊。

### U5 领袖顶栏窗口：打开期间每帧收集位置、校验指令、排序（置信度：高）
- **位置**：`CTopBarLeadersView::Update`（5170291–5171371）调用 `CAssignableJobExpandableContainer::PopulateItems`（5172311–5172455）。
- **每帧**：调用 `CLeaderLocation::CollectLocations`（总督类会遍历全部殖民地，并调用 `CanAiAssignGovernor`，847710）；对每个位置构造一个 `CAssignLeaderCommand` 并执行 `IsValid`（5172366–5172387）。
- **做得好的地方**：只有结果的 `PMurHash32` 变了才重建网格（5172417），但前面的计算照算不误。
- **修复**：把已有的这个哈希当作 dirty 信号，改为按日重算。

### U6 派系窗口：每帧求值诉求和行动的 trigger（置信度：中高）
- **位置**：`CTopBarFactionsViewImp::Update`（5159488–5160281）。
- **做得好的地方**：派系列表项按轮转方式刷新，每帧只刷一个（约 5159905–5159935）。
- **不轮转、每帧都做的**：
  - 重建思潮吸引力数组并 `Sort`（5160232）；
  - `UpdateDemands`：调用 `GetListOfActiveDemands` → `IsPotential`/`IsFulfilled`，都是脚本 trigger（1093271）；
  - `UpdateActions`：对每个行动调用 `CPopFactionAction::IsPotential`（5163206）。
- **mod 侧**：派系诉求和行动的 trigger 要写得便宜，因为窗口打开期间它们按帧率执行。

### U7 窗口越多越慢：没有按 view 节流（置信度：机制中，总体影响中）
- 任何打开的 view 都按帧率执行 Update。例如星球窗口会调用 `CParagonPortraitContainer::Update(true,true)`（1983 行，4651160–4658714）。
- **修复**：给每个 view 设更新间隔，例如数据密集型 view 用 4–10 Hz，遇到用户输入时立即刷新。

## 核实过、影响很小或设计良好的
- **`CAlertManager::Update`**：每帧只求值 66 类警报中的 1 类（`switch(*(uint*)(this+0x6338))`，按 0x42 取模递增，968402–968548），也就是每类大约每秒一次，不是性能问题。
- **边界渲染**：由 dirty flag 驱动（4322046），计算在异步 `CBorderShapeCalculator` 里完成，不会每帧重建。
- **`CSensorRangeGraphics::Update`**：只处理选中的本地舰队，并有 `SRangeCache` 缓存。
- **`CAmbientObjectGraphicsManager::Update`**：只处理当前星系的对象，n 很小。
- **图标裁剪**：用 frustum 和网格做 `CullIcons`，2D 坐标计算用了 `PdxParallelFor`。
