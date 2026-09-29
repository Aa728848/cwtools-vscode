# 03 人口 / 岗位 / 殖民地 / 经济 / modifier

这是后期卡顿的经典来源。

### P1 ✅ 每月岗位分配无条件对全部殖民地跑两遍（置信度：高）
- **位置**：`NColonyUpdate::MonthlyUpdate`（3172855），3172940–3172946：
  ```c
  if (*(char *)(lVar2 + 0x9e) == '\0') {
    NPlanetJobs::UpdatePopJobs((NPlanetJobs *)local_30, colonies_begin, colonies_end);
    NPlanetJobs::UpdatePopJobs((NPlanetJobs *)local_30, colonies_begin, colonies_end);
  }
  ```
  `MonthlyOrDailyUpdatePopJobsInColony`（3172828）里也有同样的双重调用（`param_2 == 0` 时执行第二次）。
- **每遍做什么**：`NPlanetJobs::UpdatePopJobs`（2714467）依次执行：
  1. 对每个殖民地调用 `CColony::UpdateModifier`；
  2. `BuildUpdateData`；
  3. `CollapsePopGroups`；
  4. `CalculatePopGroupPossiblePreCalcFlags`；
  5. `UpdatePopGroupsWithPossiblePreCalcFlags`；
  6. `UpdateAvailableJobs`；
  7. `AssignPopsToJobs`。
- **不做过滤**：`BuildUpdateData`（2722928）对每个殖民地的每个（人口组 × 岗位）都生成一条 24 字节的 `SPopGroupJobWeight`，不看重算标志 `0xe70`/`0x1060`（这些标志要到之后的 `ClearRecalcPopJobFlags` 2723427 才清除）。
- **每一对的开销**：在权重 lambda（2716972）里，构造并析构一个 `CEventScope`，执行 `CPopJob::IsPossible`（脚本 trigger），再执行 `CPopJob::CalcWeight` → `CJobType::CalcWeight`（脚本 weight）。
- **复杂度**：每月 2 × Σ(G × J) 次脚本求值。约 2000 个殖民地 × 30 × 30，每遍约 180 万对，每月约 360 万次。**很可能就是"月初卡一下"的主因。**
- **已有的缓解**：权重计算是并行的；`SPreTriggerValues` 预先缓存了部分标志。
- **引擎修复**：只处理人口或岗位组成、modifier 校验和发生变化的殖民地；第二遍只在第一遍改动了分配时才跑；按（岗位类型，人口组特征）缓存权重。第二遍可能是为了收敛而有意设计的，但完全可以加条件。
- **mod 侧**：岗位的 `weight` 和 `possible` 每月要执行约 360 万次，务必写得便宜，不要在里面写 `any_owned_pop_group` 这类迭代器。

### P2 岗位排序串行、每殖民地一次堆分配，日更路径不批处理（置信度：中高）
- **排序**：`AssignPopsToJobs`（2715450）在并行权重阶段结束后，**在单线程里**对每个殖民地的 G×J 权重数组做 `std::__stable_sort_adaptive`（约 2716386–2716438），并为每个殖民地分配一次临时缓冲区（`operator_new(nothrow)` / `operator_delete`）。每遍约 2000–4000 万次比较。
- **日更路径**：工作数据保存在函数内的 `static UpdateData`（2714478–2714490）里，整条流水线不可重入。`CColony::DailyUpdateSerial`（3084354）在串行循环 `NColonyUpdate::DailySerialUpdate`（3172762）中逐个殖民地调用 `UpdatePopJobs(date, this)`。每个 dirty 殖民地都要付一次完整的准备开销，包括为一个殖民地创建一次并行 `CJob`。
- **修复**：先收集所有 dirty 殖民地，再批量调用一次；各殖民地互相独立，排序可以并行，并使用线程局部的临时缓冲区；去掉函数内的 static 状态。

### P3 国家级 modifier 失效会级联到整个帝国（置信度：机制高，频率中）
- `CCountry::InvalidateModifier`（598843）对两个国家节点调用 `InvalidateChildren(node, 0xffffffff)`。`CColony::InvalidateModifier`（3063756）和人口组的失效也一样。
- `InvalidateChildren`（240326）先拿写锁，再递归使所有子节点失效。重算时（`CModifierNodeBase::Update`，约 247520）清空后从头重建，不做增量。
- 其实已经存在按类别过滤的 `Invalidate(ModifierCategory)`（掩码在 `this+0xdc`），但这些调用方都绕开了它。
- **调用方**：共 72 处，例如 `CFleet::SetMission`、`CLeader::InvalidateLocationModifier`、战争增减、`CStarbase::SetOwner`、`CAstralRift::HandleModifierDailyUpdate`（3038945）、`CPlanet::DailyUpdateHabitableSerial`（3477303，有 flag 门控）。`AssignPopsToJobs`（约 2716564）在岗位的已分配人口校验和变化、且该岗位类型带国家级 modifier 时，也会使整个国家失效。
- **开销**：一次调用就要为该帝国的全部殖民地、人口组和岗位重新合并 modifier，大帝国是数万个节点。重算本身是并行的（`CPdxGraphJob` 515091）。
- **修复**：传入真实的类别掩码（发生变化的 modifier 所属类别的并集）；更好的做法是对父节点做增量（减旧值、加新值）。

### P4 modifier 容器：无序数组，查找线性，合并 O(n·M)（置信度：高）
- **布局**：`CModifier` 由无序的 int 键数组（`+0x10`，数量 `+0x1c`；殖民地偏移 `+0x160/+0x16c`）和并行的值数组（`+0x38`，步长 16）组成。
- **查找**：`ApplyModifierMult`（911634）写的是 `do { if (keys[i]==type) {...;break;} } while(++i<count)`。同样的模式到处被内联：
  - `AssignPopsToJobs`（2715791–2715932）对每个岗位要扫描 3 次（键 0xa8、0xa9 和岗位的劳动力键）；
  - `CalcAutoMigration`（3078314）扫描键 0xa5。
- **合并**：`CPdxModifier::AddModifierInternal`（247641）对源的每一项都在目标里线性查找；当 `this+0xa8>0` 时还会克隆父记录，也就是一次堆分配。
- **复杂度**：查找 O(M)，后期殖民地、人口组、国家的 M 在数百级；合并 O(n·M)，每次节点重建要合并几十个来源。
- **修复**：改成按 modifier id 下标的稠密数组、哈希表，或排序后二分查找；把循环内的重复查找提到循环外。

### P5 每个人口组都把所在殖民地的建筑、区划、区域 modifier 重新合并一遍（置信度：中高）
- **位置**：`CPopGroup::CalculateModifier`（1047638），循环在 1047912–1048284。对每个建筑（`colony+0x58`）、区域建筑（`+0x70`）、区划（`+0x88`）和区域，每个人口组都执行一次 `AddModifierInternal(pg, building+0x30, …, uVar10)`，其中 `uVar10 = pops*1e10/total`，即该组的人口占比。
- **复杂度**：一个殖民地重建一次是 G × B × (n·M)，同一批殖民地级来源被重复合并 G 次；再乘上 P3 的国家级级联。
- **修复**：先把殖民地级、按人口缩放的来源汇总到一个中间节点，每个人口组只按比例加一次。`AddModifierInternal` 本来就支持缩放参数。

### P6 建筑、区划、岗位的 triggered modifier 每天全量重算，不分摊（置信度：高）
- **位置**：`CColony::DailyUpdateSelfDontReadOthers`（3081115）每天都调用 `CalculatePopTriggeredModifiersForAll`（3081378）。
- **它做什么**：调用 `CBuilding::CalcTriggeredModifier`（1825939），`CDistrict`/`CZone`/`CDeposit` 各自的 `CalcTriggeredModifier`，`CalcDesignationTriggeredModifiers`，`CalcDoubleScaledTriggeredModifiers`，以及 `CPopJob::CalcTriggeredModifier`（1110197）。每一个都会清空两个 `CModifier`，构造一个 `CEventScope`，并对每个 triggered modifier 求值 `IsPotential`。
- **对比**：殖民地自身的 triggered modifier 是分摊的：`(day+id) % NDefines::NGameplay::TRIGGERED_MODIFIER_UPDATE_DELAY == 0`（约 3081160）。人口组（1054148）和国家（2012927）也分摊。
- **规模**：每天约 2000 个殖民地 × 每个 60–100 个实体 × 各自的 trigger。这一步是并行的（`DailyParallelUpdate` 3172479）。
- **修复**：套用同一个 `TRIGGERED_MODIFIER_UPDATE_DELAY` 分摊，或只在作用域变化时重算。
- **mod 注意**：调大 `TRIGGERED_MODIFIER_UPDATE_DELAY` 对这一条**无效**。建筑和岗位上的 triggered modifier 要写得便宜。

### P7 自动迁移：每个来源殖民地都对所有目的地打分（置信度：复杂度高）
- **位置**：`CColony::CalcAutoMigrationSafePrivate`（3078095），被内联进 `MonthlyUpdateOnlyChangeSafePrivate`（3084893）。
- **循环**：每个有可迁移失业人口的来源殖民地，遍历所有者的全部殖民地（3078409–3078444）；有移民协议时，还要遍历每个协议伙伴的全部殖民地（3078453–3078589）。对每个目的地：
  - 调用 `CanReceiveAutoMigration`：遍历岗位，并执行脚本规则 `CanColonyReceiveAutoMigration`；
  - 调用 `CalcAutoMigrationDestinationScore`（3077659）：再遍历一次岗位，并做线性 modifier 查找。
- **问题**：目的地得分只取决于目的地本身，却对每个来源都重算一遍。移民协议多时，每月可达数十万次规则求值。
- **修复**：每个国家每月只算一次"有效目的地 + 得分"列表，然后复用。

### P8 帝国规模每天从头重算（置信度：中）
- `CCountry::CalcCachedEmpireData`（2016390）由 `DailyUpdateSelfDontReadOthers`（2015185）调用，每天执行一次 `CalcEmpireSize`（2050603）：遍历全部殖民地和人口组，调用 `CPopGroup::CalcEmpireSprawl`（内含 modifier 查找）。
- **复杂度**：每天 O(人口组数)。虽然跨国家并行，但最大的帝国处在关键路径上。
- **修复**：在人口、殖民地、区划变化时做增量更新，或改为每月更新。

### P9 并行合并中写全局表（置信度：中）
- `AddModifierInternal` 247700–247703：`*(uint*)(DAT_0553d538 + 0xa8 + type*0xb0) |= 0x20000000`，每插入一个新键都执行一次。
- 这是在 graph job 的工作线程里写全局 modifier 定义表，会导致缓存行乒乓，也是一个良性数据竞争。
- **修复**：在加载时就设好这个标志，或者先读、未设置时才写。

### P10 小问题（置信度：低到中）
- `CPopGroup::DailyUpdateSelfDoNotReadOthers`（1055068–1055175）最多会调用 4 次 `InvalidateChildren`（每个变化的缓存字段一次），每次都拿写锁。合并成一次就够了。
- `CheckPopFactionChange`（1052506）在循环条件里调用虚访问器，编译器无法把它提到循环外。
- `CPlanetManager::DailyUpdate`（3497985）的串行尾段（3498766）对全部星球逐个执行，但每个星球的工作量很小。

## 设计良好的部分（本方向）
- **三段式日更**：殖民地、人口组、国家都按 `OnlyChangeSafePrivate` / `SelfDontReadOthers`（并行）→ `Serial` 的顺序执行（`NColonyUpdate::DailyParallelUpdate` 3172479，`DailyUpdate $_129/$_130`）。
- **modifier 图只重算 dirty 节点，并且并行**：`CModifierNodeManager::Update`（515091），每个节点有原子 dirty 位和互斥锁。
- **日更的岗位重分配有 dirty 门控**：`0xe70 & 0x14`（3084354）。只有月更那两遍（P1）没有门控。
- **岗位产出按校验和门控**：`UpdateAPGChecksum` / `UpdateAutomatedChecksum` 驱动 `UpdateEconomicResources`，没变化就不重算产出。
- **人口组用 `PMurHash32` 做变化检测**（约 1054136），失效前先比较缓存值（1055068）。
- **派系有缓存**：`CPopFaction::MonthlyUpdateSerial`（1086950）用栈上排好序的缓存加二分查找；派系资格有按国家的备忘录（1052650）。
