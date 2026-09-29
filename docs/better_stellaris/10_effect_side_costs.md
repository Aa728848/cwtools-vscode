# 10 effect 副作用开销目录

每个 effect 都列出：它自己的开销，以及它**顺带触发了什么**（同步还是延后、影响范围）。行号是 `ExecuteActual` 的位置。

- **"失效"**：给对象的 modifier 节点置 dirty，调用 `InvalidateChildren(0xffffffff)`，并把 ID 加入 dirty 集合；真正的重算**延后**到 `CModifierNodeManager::Update`。
- **倍数**：放在 `every_owned_pop_group` 这类循环里，下表的开销就是每次迭代都完整付一遍。只有 4 种东西会在同一个 tick 内被合并：数据库数组重建、航道距离重建、星系所有者 dirty 标记、modifier 节点重算。
- ✅ 表示我亲自读过代码确认。

## 总表

| effect | 位置 | 自身开销 | 顺带触发的开销 | 置信度 |
|---|---|---|---|---|
| `add_modifier`（国家） | `CAddModifierEffect` 6159979 | `AddTimedModifier`：线性扫描计时 modifier 数组（916001–916041），然后追加 | **只有真的变了**（新 modifier，或倍数、标志不同）才会 `CCountry::InvalidateModifier`，即国家级级联（03-P3），延后执行。用相同的值再加一次只会延长天数，**不会**触发失效 | 高 |
| `add_modifier`（星球/舰船/殖民地/人口组） | 同上 | 同上 | 各自节点失效，延后执行 | 高 |
| `add_modifier`（**舰队**） | 同上 | **遍历每艘船**，对每艘船都执行一次 `AddTimedModifier`（6160243–6160269） | 每艘船都失效；满足条件时**同步**执行 `CFleet::UpdateCachedValues` | 高 |
| `add_modifier`（**星系**） | 同上 | 扫描 | **同步**执行 `CGalacticObject::CalculateModifier`（2589249）：用全部计时和静态列表重建星系 modifier，再对星区节点**同步** `Update`（2575668） | 高 |
| `remove_modifier` | `CRemoveModifierEffect` 6160624 | 线性查找后删除 | 同上；舰队作用域**无条件**执行 `UpdateCachedValues` | 高 |
| `set_timed_*_flag` | `CSetTimedFlagEffect` 6000614 | O(n) 的 `SetFlag`；动态名要拼字符串 | 无全局副作用（见 08-A） | 高 |
| `add_resource` | `CAddResourceEffect` 6906531 | O(资源种类) | 无失效 | 高 |
| `set_variable`/`change_variable` | 6106967 / 6107455 | 构造 `"local_"` 并 `StartsWith`，再对名字算 `PMurHash32`；`change_variable` 要哈希两次（Get 一次、Set 一次） | 无 | 高 |
| `fire_on_action` | `CFireOnActionEffect` 5917016 | 每个作用域参数都在堆上分配一个 `CEventScope`（0x170 字节）；每次调用都用 Murmur 哈希查一次 on_action 名字 | **同步**：对列表中的每个事件执行 `IsValid` → `TriggerEvent`；再由 `GetRandomValidEvent` 求值所有权重 | 高 |
| `*_event`（没有 `days`） | `CFireEventEffect` 5905103 | 同步执行 immediate | `fire_only_once` 事件要线性扫描**全局已触发列表**（`HasEventFired` 431988） | 高 |
| ✅ `*_event`（带 `days =`） | → `CDelayedEventManager::AddEvent` 2289766 | `operator_new(0x188)`，完整拷贝一次作用域，`CopyInternalScopes` 为 root/from/prev 各拷贝一次，`TrimFroms(8)`，然后**不排序地追加**到末尾 | **每天**对所有挂起的延迟事件逐个执行：`ShouldAbort`（事件有 `abort_trigger` 就求值）→ 计数减一；到期后再执行 `PreCalcScopeValues` 和 `IsValid` | 高 |
| `add_trait`/`remove_trait`（领袖） | 6010361 / 6011349 | 有序数组：二分查找，再移位插入或删除 | 领袖的两个节点失效；同步执行 on_trait_gained；`RerollInvalidTraitPicks` 是 O(国家领袖数)。**不涉及物种** | 高 |
| ✅ `modify_species` | `CModifySpecies` 5984254 | 在栈上复制一份物种，然后调用 **`CGameState::CreateNewSpecies`**，线性查重（见 1） | 国家作用域下：**每个殖民地的每个人口组、每个领袖、每支舰队的每艘船**都要重新指向新物种；每个人口组执行 `UpdateKey`，线性查找同键的组，合并时同步触发 `on_pop_group_added`；最后执行 `ClearInvalidSlaves` | 高 |
| `create_species` | `CCreateSpecies` 5923429 | 同样调用 `CreateNewSpecies` 查重 | — | 高 |
| `change_species` | 5969395 | 直接赋值，不新建物种 | `UpdateKey`（可能合并并触发 on_action），殖民地失效 | 高 |
| `mutate_species` | 6035231 | **原地**修改特质集合，O(T) | 不新建物种，也不重新分组 | 中 |
| `merge_species`/`integrate_species` | 6135004 / 6134936 | `HandleIdenticalSpeciesMerge`：两两比较物种，再遍历殖民地 × 人口组 × 物种对 | 约 O(S² + 殖民地·人口组·物种对) | 中 |
| ✅ `create_pop_group` | 6169143 | 在殖民地的人口组里线性查找同键组，然后 AddSize | 同步执行：殖民地节点 `Update`、`MicroUpdateCachedValues`、`on_pop_group_added`，然后是**完整的 `AssignPopsToJobs`**（6169499） | 高 |
| `add/remove/kill_pop_amount`、`kill_pop_group` | 6168285 等 | `AddSize(±n)` | `OnAddPops`/`OnRemovePops`（同步节点 Update；增加人口时触发 on_action）；岗位**只置 dirty 标志**（0x10），延后重算 | 高 |
| `transfer_pop_amount` | 6168640 | `MoveSizeFrom` | 目的地 `OnAddPops`（触发 on_action），来源地 `OnRemovePops` | 高 |
| `set_owner`（星球） | 5922284 → `CPlanet::SetOwner` 3469135 | 遍历人口组、殖民地列表、星区 | 同步触发 on_action；星系所有者只置 dirty（延后）；**不重算边界** | 高 |
| ✅ `set_owner`（**恒星基地**） | → `CStarbase::SetOwner(..,6)` 1402243 | 更换所有者和队列 | 两个国家都失效；**同步执行全图 `CalcBorders`**（1402422–1402428，见 04-F2） | 高 |
| `set_controller`（星球） | 5922563 | O(1) | **同步** `EnsurePopJobsAreUpToDate`（3056653） | 高 |
| ✅ `add_building`/`remove_building` | 6124289 / 6126985 | 扫描区域和区划 | **同步 `CColony::EnsurePopJobsAreUpToDate`**（3088359 / 3089570）：triggered modifier、2 次节点 Update、2 次 `MicroUpdateCachedValues`、`CollapsePopGroups`、`UpdateAvailableJobs`、`AssignPopsToJobs` | 高 |
| ✅ `add_district`/`remove_district` | 5992323 / 5992643 | 新建或升降级 | `UpdateBuildings` 加上**同步 `EnsurePopJobsAreUpToDate`**（3061537 / 3061166） | 高 |
| `change_pc` | 5956570 → `SetPlanetClass` 3468880 | 类别没变就直接返回 | 更新星球管理器数组，清理不合法的建筑和区划，触发 `on_planet_class_changed`，重建图形 | 中 |
| `set_planet_entity` | 6045045 | 设置字符串 | 只影响图形 | 高 |
| `add_hyperlane`/`remove_hyperlane` | 6062089 / 6062445 | O(度数) | 置 `CGalacticMapCache::_Update \|= 1` → 下一个 tick **延后执行一次全图 O(N²) 的 `BuildHyperlaneDistances`**；**同一 tick 内的多次编辑只重建一次** | 高 |
| `spawn_system` | 6184773 | 放置位置搜索，然后 `SpawnSystem` | **每次调用都同步** `CGalacticMapCache::Update()`（6185043–6185046），除非用 spawn-system 批处理（`CSetSpawnSystemBatch` 6183872）包起来 | 高 |
| `spawn_planet` | 6038003 | 新建并初始化 | 没看到全局副作用 | 中 |
| 生成巨构 | 6038712 | `CreateNewMegaStructure` → `OnBuildComplete` | 可能创建恒星基地，并对**一个**国家执行 `NBordersUtil::CalcBorders` | 中 |
| `create_ship` | 5930337 | 新建数据库槽位；`CFleet::AddShip` 先二分再 O(n) 插入 | 舰船数据库置 dirty（**延后，同 tick 合并**）；某些标志下同步 `UpdateCachedValues` | 高 |
| `create_fleet` | 5925333 | 新建并初始化 | 舰队数据库置 dirty（延后） | 高 |
| `destroy_ship`/`destroy_fleet` | 5981385 / 5979347 | 逐艘 `SetToBeKilled` | 同步：处理领袖、殖民船、`OnShipKilled`；恒星基地的舰船会立即 `DestroyStarbase`；对象删除延后 | 高 |
| **`create_country`** | 5944752（约 2000 行） | 新建国家，可能新建物种，复制科技、设计、勘测、传统，创建 AI | 对**所有国家**逐个执行 `Contact`；完整的缓存值流水线；`CreateAIAfterGameStart`；`UpdateBorderDistanceCache`；**强制同步 `UpdateDatabaseArrays`**（5946707） | 高 |
| `create_leader` | 6080783 | 新建并初始化 | 同步触发 `on_leader_spawned` | 高 |
| `add_skill`/`add_experience` | 5959863 / 5958226 | 调用 n 次 `LevelUp` | **每升一级触发一次 `on_leader_level_up`**，然后领袖节点失效 | 高 |
| `set_policy` | 6019106 | 线性查找政策数组 | 只有真的变了才执行：`UpdatePolicyFlags`（舰队、物种权利）、`on_policy_changed`、**对全部派系执行 `UpdateSupportAndApproval`**，modifier 变了就让国家失效 | 高 |
| `shift_ethic`/`country_add_ethic` | 5968850 / 5999582 | 修改思潮 | `CalcCountryPopsAttraction`：**每个星球的每个人口组**，可能要算好几遍；`OnEthosChanged`：政府类型、物种权利、国家失效、AI 性格 | 中高 |
| `change_government`/`add_civic`/`remove_civic` | 5971993 / 5958618 / 5958985 | 复制国策数组 | 没变就直接返回；否则**重置政府冷却**（2003684），触发前后两次政府变更 on_action，重新安排所有议会席位，校验物种权利，国家失效 | 高 |
| `add_opinion_modifier` | 5987257 | 只有 accumulative 或 unique 的才查重；**其他情况每次调用都新 `new(0x28)` 追加一条** | 不失效，好感总和增量更新 | 高 |

## 关键发现

### 1. ✅ 物种爆炸确实存在，而且去重是线性扫描加 O(T²) 比较
- 只有 `modify_species` 和 `create_species` 会新建物种，两者都走 `CGameState::CreateNewSpecies`（408141）。它扫描缓存的物种数组，逐个调用 `CSpecies::IsEqual`：
  ```c
  } while (((cVar4 != '\0') || (cVar4 = CSpecies::IsEqual(pCVar8,param_1,param_3), cVar4 == '\0')) && …   // 408174
  ```
- `IsEqual`（1328442）比较基础物种、名字（`bcmp`）、特质和标志（`IsPermutation`）。**特质比较是 O(T²) 的嵌套循环**（1328492）。
- 所以每次调用是 **O(S·T²)**（S 为物种数，可达数百到数千；T 为特质数，约 5–15）。
- 找不到匹配时新建物种；数据库 dirty 后，整个物种缓存数组要遍历全部槽位重建（408197–408229）。
- **`modify_species` 永远不会原地修改**：它总是先在栈上复制一份，再走 `CreateNewSpecies`（5984596）。只有 `mutate_species` 是原地修改。
- **引擎修复**：用（基础物种、排序后的特质 ID 数组、标志）的哈希作为键建一张表，查重做到 O(1)；特质集合排序后比较，O(T)。
- **mod 侧**：`modify_species` 在国家或星球作用域调用一次就够了，**绝不要**在每个人口组上调用；多个特质修改合并到同一个 block 里；能用 `mutate_species` 的尽量用。

### 2. 物种变更后要在全帝国范围重新分组
- 国家作用域的 `modify_species` 对每个自有殖民地调用 `ReplaceAllPopGroupSpecies`（5984669）。
- `CPopGroup::UpdateKey`（1058773）在殖民地里线性查找同键的组，找到就合并（`AddSize` + `RemovePopGroup`），并**总是**调用 `CColony::InvalidateModifier`（1058853）。
- 每合并一次，就同步触发一次 `on_pop_group_added`（`OnAddPops` → `ExecuteAddPopOnAction` 3066804）。

### 3. ✅ 建筑、区划、控制者变更：**同步**重分配整颗星球的岗位
- `CColony::EnsurePopJobsAreUpToDate`（3064005）会依次执行 triggered modifier、两次殖民地节点 `Update`、两次 `MicroUpdateCachedValues`，以及完整的 `UpdatePopJobs` 流水线。
- 被 `AddBuilding`（3088359）、`RemoveBuildingType`（3089570）、`AddDistrict`（3061537）、`RemoveDistrict`（3061166）、`SetController`（3056653）直接调用；`create_pop_group` 也会直接调用 `AssignPopsToJobs`（6169499）。
- 普通的加减人口只置 dirty 标志，岗位留到常规更新时再算。
- **mod 侧**：每次加建筑或区划都会让整颗星球的岗位重新分配一遍。尽量少调用，避免在频繁的 pulse 里写 `every_owned_planet = { add_building = … }`。

### 4. 航道编辑：O(N²) 重建成立，但会延后并在同一 tick 内合并；`spawn_system` 例外
- `AddHyperlane` 置 `_Update |= 1`（2583479），下一次 `MicroUpdate`（415683）或 `UpdateDatabaseArrays`（409311）时才重建。所以**同一 tick 内的多次编辑只重建一次**，分散到多个 tick 就要重建多次。
- `spawn_system` 每次调用都同步重建：`if (!CGameState::ShouldOptimize(g_CurrentGameState,1)) CGalacticMapCache::Update();`（6185043–6185046）。唯一的例外是用 spawn-system 批处理包起来（`CSetSpawnSystemBatch` 6183872：开始时 `EnableOptimization(1)`，结束时 `GenerateGalacticMap`）。
- **mod 侧**：批量生成星系时，一定要用批处理 effect 包起来；航道编辑尽量集中在同一个 tick 内完成。

### 5. ✅ 延迟事件队列：按所有者存放、不排序、每天全量扫描
- 队列挂在所有者对象上：星球 `+0x4e0`、国家事件模块 `+0x128`，以及星系、领袖、恒星基地、局势等。**舰船的 `days=` 事件挂在其控制国的队列上；人口组的挂在所在星球上。**
- `AddEvent`（2289766）：`operator_new(0x188)`，完整拷贝一次作用域，`CopyInternalScopes`（root/from/prev 各拷贝一次，见 08-B2），然后追加到末尾。
- `DailyUpdateThreaded`（2289613）**每天访问每一个**挂起的延迟事件：先 `ShouldAbort`（有 `abort_trigger` 就求值），再计数减一；到期后执行 `PreCalcScopeValues` 和 `IsValid`。
- **每天的开销是 O(全部挂起的延迟事件)，再加上每个事件的 abort_trigger 求值开销。**
- **引擎修复**：改用按到期日分桶的时间轮，或者最小堆；每天只处理当天到期的；`abort_trigger` 改为到期时再判断，或者降低判断频率。
- **mod 侧**：不要按人口或舰船批量派发 `days=` 延迟事件（每个都要一次堆分配和作用域深拷贝，而且每天都要访问一遍）；改为在国家作用域派发一次，到期后在事件里再迭代。`abort_trigger` 要写得便宜。

### 6. 星系和舰队作用域的 modifier 不会延后
- 星系作用域的增删会**同步**执行 `CalculateModifier`，并对星区节点同步 `Update`。舰队作用域要遍历每艘船，还要调用 `UpdateCachedValues`（删除时无条件调用）。
- 用完全相同的值重新加一次，扫描时就会发现没变化，**不会触发失效**（916063–916080），几乎没有开销。
- **mod 侧**：频繁重复施加的 modifier，优先放在国家或星球作用域。

### 7. `create_country` 是最重的单个 effect
- 对所有国家执行 `Contact`，创建 AI，建立边境距离缓存，还会**强制同步 `UpdateDatabaseArrays`**（5946707）。`create_ship`/`create_fleet` 的同类重建是延后合并的，这里却是强制同步。**绝不要在循环里用。**

### 8. 藏着脚本扇出的 effect
- `add_skill = n` 会触发 n 次 `on_leader_level_up`。
- `add_civic`/`remove_civic`：两次政府 on_action，重新安排议会席位，还会**重置政府冷却**（2003684–2003686），这可能不是 mod 作者想要的。
- 非 accumulative、非 unique 的 `add_opinion_modifier` 每次调用都追加一条新记录（1159638–1159653），关系里的记录会越积越多。

## 未能确认的部分
- 载体对象的 vtable `+0x390` 推断是 `InvalidateModifier`（布局吻合，但没有从 vtable 证实）。
- `change_pc` 末尾的虚调用（0x330、0xa0）。
- `add_deposit` 持有者的 add 调用。
- `destroy_*` 之后死对象回收的开销。
