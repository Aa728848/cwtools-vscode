# 15 静默数据损坏类 bug（与 flag 名字表耗尽同级）

这一篇不是性能问题，而是**不崩溃、不写日志、结果悄悄错掉、还可能写进存档**的正确性 bug。✅ 表示我亲自复核过代码；🎮 表示已在游戏里实测。
- 原点：08-A3 / B8-(6)，全局 flag 名字表耗尽（🎮 已实测）。
- 控制台测试：`console_tests/silent_corruption_tests.md`。

## 严重程度总览

| # | bug | 原版能否触发 | 后果 | 进存档 | 状态 |
|---|---|---|---|---|---|
| C1 | 全局 flag 名字表 65535 耗尽 | 需要大量动态名，或长时间会话；**tooltip 和渲染也会消耗名字** | 新 flag 静默丢失、事件目标串号、**读档丢 flag**、**POI 被批量删除并永久合并**、可能导致多人不同步 | ✅ 永久 | 🎮 + ✅ |
| **C2** | **`set_design_flag` 实际写入全局 flag** | **能：原版专家特权** | **停用特权时删掉一个随机设计**；`has_design_flag` 对所有国家的所有设计都为真 | ✅ | ✅ 代码确认，待实测 |
| C3 | `TPdxRef` 8 位代号回绕，空闲槽 LIFO 复用 | 能：长局、高频生灭的对象 | 旧引用（事件目标、延迟事件作用域、变量里的对象）指向一个不相干的新对象 | ✅（代号随存档保存） | ✅ 机制确认，触发概率待测 |
| C4 | 读档时 `0xffff` 事件目标无名保存、重复追加 | 依赖 C1 | 无法清除的"幽灵"目标越积越多 | ✅ | ✅ |
| C5 | `copy_flags_and_variables_from` 写入共享的空对象 | 需 mod 对已失效目标调用 | 所有无效引用共享被污染的 flag 和变量 | 间接 | ✅ 代码确认 |
| C6 | AI 外交提案依赖线程完成顺序；AI 送礼用系统时间作种子 | 能 | 同一存档同一种子，AI 行为不可复现；如果 AI 在每个客户端上都运行，会导致多人不同步 | — | ✅ 代码确认 |
| C7 | `set_closed_borders` 对无效目标创建一条指向国家 0xFFFFFFFF 的孤儿关系 | 需脚本传入无效目标 | 存档里残留垃圾数据 | ✅ | 代码确认 |
| C8 | 读档后 root/from/prev 不再共享同一个作用域 | 能：延迟事件跨存档 | 读档前后事件链行为不一致 | — | 可能 |
| C9 | `CFixedPoint::RoundTo` 截断为 int32；`change_variable` 溢出 | 极少 | 数值变号 | ✅ | 代码确认 |

---

## C1 补充：flag 名字表耗尽还会连带出的问题

- **✅ 读档时 flag 被静默丢弃**：`CPdxIntegerFlags::ReadMember`（7062284 / 7062294）只在 `sVar2 != -1` 时才插入；这时再存档，丢失就是永久的。
- **✅ POI（兴趣点）被批量删除，并且永久合并**：
  - `CPointOfInterest::SetIDIfInvalid`（1038351）和 `ReadMember`（约 1038317）用 `CreateFlagIndex(name)` 作为 POI 的 ID（`+0x3f0`），**不检查 `0xffff`**；
  - `CCountryEventManager::RemovePointOfInterest(short)`（2171035）遍历整个数组，**删除所有 ID 匹配的 POI**；`AccessPointOfInterest`（2171099）返回最后一个匹配的；
  - 所以表满后，所有新的动态 POI（`id = x@root`）ID 都是 `0xffff`：删除其中一个，同一国家里所有卡在 `0xffff` 的 POI 会**一起被删掉**；访问其中一个，拿到的可能是另一个；
  - 存档时 `WriteMembers`（1038384）写出的是 `GetFlagString(0xffff)`，即 **`ERROR_FLAG_STRING`**（7062728）。读档后，这些 POI 会共享同一个名字，**即使重启游戏也永久合并在一起**。
- **名字不只由游戏逻辑申请，界面和渲染也会申请，而且是各个客户端各自申请**（置信度中高）：
  - trigger 解析（`CFlagTrigger::Assign` 6751287）；
  - tooltip（`CSetLeaderEffect::GetDesc` 5998899、`CReturnLeaderFromExileEffect::GetDesc`、`CKillExiledLeaderEffect::GetDesc`）；
  - 渲染（`CPsionicAuraHyperlaneGraphics` 4795587 会为每个星系拼出 `<星系ID>` + `AURA_CLASHING_FLAG`；`CAmbientObjectGraphicsManager::Update` 3650671）。
  - 所以悬停 tooltip、渲染画面也会消耗 ID。由于名字表是进程级的，**主机和每个客户端耗尽的时刻各不相同**，耗尽之后 `SetFlag`、保存事件目标在不同客户端上的结果也就不同，**这很可能是多人游戏不同步的一个来源**（未实测）。
- **引擎内置 flag 在第一次使用时才申请**，例如 `"has_uplifted_species"`（1301288）、`"fruitful_seeded_critter"`（3016673）、`"has_ever_appeared"`。如果第一次使用发生在表满之后，**这个机制会在整个游戏范围内静默失效**。

## C10 `CStaticLexer::AddDynamicToken` 用 0 作为失败值（中低，会写日志）
- `AddDynamicToken`（8099848）对以数字或 `-` 开头的名字返回 0；`CModifier::TryAddDynamicModifier`（911909）等调用方直接把 0 当作真实的 token 使用，于是这些 modifier 都串到了第一个以 token 0 注册的那个上，之后的都报"已存在"。会写错误日志。
- 查找时会对每个字符做 `tolower`（8099935），**只有大小写不同的名字会共用同一个 token**。
- token ID 是 `int`，没有上限，所以不会耗尽；但读档会永久新增 token（SStackID 2732259、政策 flag 1998081），属于泄漏，不是溢出。

## C11 其他（低）
- 本地化只按 32 位哈希匹配（`Localize` 约 8066683）：30 万个键时预计约 10 次碰撞，大型 mod 合集可能上百次，碰撞的键会显示错误的文字。加载时会写日志（`LocalizeReportHashCollisions` 8057390），调用方几乎都是界面文字，没有发现影响游戏逻辑的情况。
- `CGameState::CreateNewPopGroup`（434066）在创建失败时退回空对象，并对它调用 `Initialize`、注册进维护表，会污染共享的空对象。只有内存耗尽或用满 1670 万个槽位时才会发生，实际无法触发。
- 1202 处按运行时数量分配栈空间（`alloca`），例如 `ListColonizerSpecies`（物种数 × 8）、`CanRetrofit`（设计数 × 0x538）。Windows 版主线程的栈预留是 4 MB，要约 50 万个物种或单个国家约 3100 个设计才会溢出，风险低；工作线程的栈大小没有确认。

## C2 ✅ `set_design_flag` / `has_design_flag` 实际上读写的是全局 flag（原版可触发）

**代码**：`CEventScope::AccessFlags`（2470291）/ `GetFlags`（2469830）按作用域类型分支，找到对应对象的 flag 容器。在 `0x800~0x7fff` 这一段只处理了三种类型：
```c
if (lVar2 != 0x800) {                                   // 0x800 = 物种
  if (lVar2 != 0x4000) goto switchD_0266d6e3_caseD_3;   // 0x4000 = 派系；0x8000 = 战争在上一层处理
…
switchD_0266d6e3_caseD_3:
  return g_CurrentGameState + 0x490;                    // ← 全局 flag（has_global_flag 用的同一个容器）
```
- **design 作用域的类型是 `0x2000`**（`CScopeObjectReference::SetDesign` 2463951：`*(this+8) = 0x2000`），没有对应的分支。**bypass 作用域 `0x1000`** 也一样。
- `CSetDesignFlagEffect` / `CRemoveDesignFlagEffect`（5942638 / 5942756）和 `CHasDesignFlagTrigger`（6773636）都没有覆盖 `AccessFlags` / `GetFlags`，所以全都落到了全局 flag 上。

**后果**：
- `set_design_flag = X` 等于 `set_global_flag = X`；
- 之后，`has_design_flag = X` 对**所有国家的所有设计**都为真，`has_global_flag = X` 也为真；
- 这个"flag"会随存档保存。

**原版触发**（`common/specialist_subject_perks/00_specialist_subject_perks.txt`，`bulwark_3_battlewright` 约 221–230 行，`scholarium_3_arctrellis` 约 450–459 行）：
```
activate_effect   = { target = { create_ship_design = {…}  last_created_design = { set_design_flag = bulwark_battlewright }  add_ship_design = last_created_design } }
deactivate_effect = { target = {
    every_owned_design = { limit = { has_design_flag = bulwark_battlewright } save_event_target_as = remove_this_design }
    remove_ship_design = event_target:remove_this_design } }
```
- 停用时，`limit` 对每个设计都判定为真，`save_event_target_as` 被反复覆盖，最后保存的是**最后遍历到的那个设计**；
- 于是 `remove_ship_design` **删掉了一个不相干的设计**，特权对应的那个设计反而留了下来；
- 因为 flag 是全局的，**任何一个国家激活过一次之后，所有国家在停用时都会受影响**。

**同一个根因的其他表现**：
- `set_saved_date` 在 bypass 等没有分支的作用域里执行，会写进全局 flag；
- 在 design 或 bypass 作用域里执行 `copy_flags_and_variables_from`，也会复制进全局 flag。

**修复**：给 `0x2000`（design）和 `0x1000`（bypass）加上各自的 flag 容器分支；兜底分支应该返回 nullptr 并报错，而不是返回全局 flag。
**mod 侧**：**不要使用 `set_design_flag` / `has_design_flag`**。改用"保存设计本身"（`save_global_event_target_as`），或者在国家上存 flag 或变量来标识设计。

---

## C3 ✅ `TPdxRef` 8 位代号回绕，空闲槽位后进先出（LIFO）复用

- **ID 结构**：低 24 位是槽位下标，高 8 位是代号。所有 `TPdxRefDatabase<T,8u>::CreateNewObject`（共 71 处实例化，例如舰队 519352）都这样计算：
  ```c
  uVar10 = (uVar10 | 0xffffff) + 1 | uVar11;   // 旧 ID 的代号 + 1，0xff 之后回到 0x00
  ```
- **释放**：`TPdxRef<CShip>::Kill`（516320–516341）把对象清零，保留 `id | 0xffffff`，然后把槽位**压入空闲链表头部**（`*(db+0x2c) = slot`）。下一次分配就先复用它，所以**同一个槽位在频繁生灭时会快速地消耗代号**。
- **Windows 4.5.1 同样如此**（RVA 0x2665db：`and esi,0xff000000; add esi,0x1000000; or edx,esi`），57 处实例化都是这对指令。
- **最快会在什么时候回绕**：导弹（CMissile）和攻击机（CStrikeCraft）每一轮齐射都要创建和销毁，**在一场后期大战里，热点槽位就可能转满一圈**；舰船、舰队、建造项目每次建造或死亡，都会反复使用链表头部的那个槽位。
- **存读档会保留代号**（`WriteMembers` 562730 / `RegisterEmptySlot` 562975，`param_1 | 0xffffff`），回绕的进度不会因为读档而清零。
- **查找只比较完整的 32 位 ID**（`obj->id == ref`，例如 516315）。所以一个槽位复用满 256 次之后，**仍然持有旧 ID 的引用会解析到这个槽位上的新对象**，既不报错，也不崩溃。
- **只保存 ID 的引用**：`CSavedEventTarget`（2478385–2479270，涵盖舰船、舰队、领袖、人口组、岗位、陆军、战争等）、延迟事件和存档作用域里的 `CScopeObjectReference`（`WriteMembers` 2463179 只写 ID）、变量值里的对象引用。
- **生灭最频繁的数据库**：CPopGroup、CPopJob、CFleet（新船、拆分、合并都要 `CreateNewFleet` 434181）、CConstructionQueueItem、CShip、CArmy、CMissile、CStrikeCraft。
- **实际概率**：已确认的是机制本身。在长局里，一个没被清除的 global 事件目标，其槽位每被复用 256 次，就有一次机会串到新对象上；是否能触发，取决于该槽位的复用频率。**待实测**：统计后期存档里各数据库对象 ID 的高 8 位分布（见测试文档）。
- 注：引擎还有一整套 `CDead*` 数据库（`CDeadFleet`、`CDeadShip`、`CDeadLeader`……），对象死亡时会建立死亡记录，可能部分缓解了这个问题，还没有核实它和查找逻辑的关系。

## C4 ✅ 读档时，`0xffff` 事件目标以无名形式保存，并且不断重复追加
- `CSavedEventTarget::WriteMembers`（2479355）：`if (flag == GetErrorFlag()) return;`，键为 `0xffff` 的目标**不写名字**。
- 读档时，`CEventScope::ReadMember`（2468235–2468244）默认键为 `0xffff`；`CGameState` 读取（407942–407946）调用 `SaveEventTarget(CSavedEventTarget const&)`，**直接追加、不查重**（2468312、408316）。
- `ClearSavedEventTargetFromArray`（437217）只删除第一个匹配项。所以这些无名目标**每存读一次档就多一批**，而且没有名字可以用来清除它们；`GetSavedEventTarget(0xffff)` 返回排在最前面的那个。

## C5 ✅ `copy_flags_and_variables_from` 会写进共享的空对象
- 这个 effect 的 `GetSupportedScopes` 返回 0。在 `CEffect::Execute`（2375361）→ `IsScopeOk`（2375960）→ `CheckScopeTypeForScope`（1206512）里，掩码为 0 时**跳过了对象有效性检查**。
- `ExecuteActual`（6113483–6113512）通过 `AccessFlags` / `AccessSavedVariables` 拿到的是 `TPdxNullObject<T>::_pInstance + offset`（例如 2469394、2469473），然后直接 `SetFlag` / `SetVariable`。
- **后果**：flag 和变量被写进全进程共享的"空 CFleet / CShip / CLeader…"对象。之后对**任何**失效引用做 `has_*_flag` 或变量检查，都会读到这些污染数据；再对失效目标执行 `copy_flags_and_variables_from`，还会把污染复制到活着的对象上，并随存档保存。空对象本身不存档，污染会一直持续到重启游戏。
- 其他写入路径都有保护：`set_variable` 会检查空指针（6106974），有类型要求的 effect 会通过 `IsScopeOk` 检查有效性。

## C6 ✅ AI 行为不可复现 / 可能导致多人不同步
- **外交提案**：`MakeAIDiplomaticAction`（2974471）用 ParallelFor 并行构建提案，各线程在互斥锁下**按完成顺序**追加到同一个数组（`BuildProposalList` 2972575–2972584）。之后逐个取随机数（`% 100`），并按严格小于（`<`）挑最优，所以**平分时先出现的获胜**。结果依赖线程调度。
- **送礼**：`SendGift`（2973634）使用 `time(NULL) * 国家A_ID * 国家B_ID` 作为种子（2973815–2973816），结果取决于系统时间；玩家国家 ID 为 0 时，种子恒为 0。
- 其他用 `time()` 作种子的地方：`CCrudeRandom::Seed()`（`srand(time(0))`，7952493）、星球命名（937419、932939）、恒星命名（2216027）、舰船设计生成（4874322 / 4874363）。
- `CRandom::GetIntegerForMacro`（7071434–7071470）对"非主线程调用"和"禁用区调用"只写日志，不阻止，全局 `_Random` 也没有加锁。另外有三处把"禁用"标志保存后恢复到了"允许多线程"标志上（`ApplySaveGameFixes` 412008→413228、`GenerateNewGalaxy` 429060→429616、`CIngameLobby::OnGameStart` 742285→742377），属于复制粘贴错误。
- 如果 AI 在每个客户端上都运行（没有核实），这就是多人不同步的来源；即使不是，同一存档同一种子的行为也不可复现。

## C7 `set_closed_borders` 对无效目标创建孤儿关系
- `CSetClosedBordersEffect::ExecuteActual`（6033853–6033870）把 `AccessTargetCountryWithErrorLogging` 的结果直接传给 `AccessOrCreateNewRelation`；目标无效时，前者写日志后仍然返回空国家（2472085–2472101）。
- `AccessOrCreateRelation`（2201041–2201127）只排除"自己"，于是 `new CRelation(owner, 空国家)`，键为 0xFFFFFFFF，并写入边境关闭的标志和日期。留下一条永久的孤儿关系，很可能会被存档；不会串到真实国家。

## C8（可能）读档后 root/from/prev 不再共享
- `CEventScope::WriteMembers`（2468040–2468090）只在 `this+0x38 == this` 时写事件目标和变量，把 from/root/prev 当成完整的嵌套作用域写出；`ReadMember`（2468100–2468255）为它们各自分配一个**独立的** `CEventScope`。
- 于是读档后，延迟事件的 `from.root` 和它自己的 `root` 变成了两份不同的拷贝，一边设置的事件目标或变量，另一边看不到。

## C9 数值截断
- `CFixedPoint::RoundTo`（7957876 起）：`iVar2 = (int)lVar4`，步长超过约 21474.8 时会变号，只有很大的 `round_to` 步长才会触发。
- `change_variable` 是裸 64 位加法（08-A5）。
- `StringToFixedPoint`（7983102）在小数超过 5 位时可能没有正确缩放（"0.123456" 可能被解析成 1.23456），无法排除是反编译造成的假象，待实测。

## 检查过、排除的假设
- 游戏数据里没有"只用 32 位哈希做键、不比较完整字符串"的容器（`CPdxUnorderedMap<CString,…>` 都会比较完整的键）；只有 triggered modifier 的变化检测用了哈希，碰撞概率约 2⁻³²。
- 流亡领袖用完整字符串比较，动态名不走 flag 表。
- `CShip::MicroUpdateParallel` 按舰船下标确定性地播种；`CStarbase::MonthlyUpdateParallel`、`CAstralRift::DailyUpdateThreaded`、`CDelayedEventManager::DailyUpdateThreaded` 都只写各自的数据。
- 存档里的定点数写 5 位小数，精度没有损失；`CVariables`、`CTimedModifier`、`CDelayedEvent` 的读写是对称的。
