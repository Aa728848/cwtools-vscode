# 02 脚本引擎（trigger / effect / 事件）

这部分是 mod 开发者最直接能影响的。规模记号：P 为星球数（5000–10000），S 为舰船数（1–4 万），C 为国家数，G 为人口组数（1–3 万）。

### S1 ✅ 带 `modifier` 的 MTTH 事件每天都先完整求值 trigger 再掷骰（置信度：高）
- **星球事件**：`CheckEvents`（3474803–3475019）读取 modifier 数量 `iVar1 = *(int*)(mtth+0x2c)`（3474886）。
  - **没有 modifier**：先掷骰（`GetDailyChanceNoModifiers` 3474927，随机数从预生成的 1000 项表里取），失败就跳走（3474941）。这是好的设计。
  - **有 modifier**：直接调用 `CEvent::IsValid(this, scope)`（3474947），再调用 `GetDailyChance`（3474986）把所有 modifier 的 trigger 求值一遍，最后才掷骰。
- **国家、舰船、舰队、派系事件**（`CStandardEventCountryModule::DailyUpdateOnlyChangeSafePrivate` 2444523–2445372）：
  - 国家事件：`iVar13 == 0 || IsValid`（2444603），然后 `GetChance`（2444605）。
  - 舰船事件：对每个国家、每个舰船事件、每支自有舰队的每一艘船，先 `SetShip`（2444691），再 `GetChance`（2444693，先求值 modifier），最后 `IsValid`（2444703）。
  - 舰队事件（2444922）和派系事件（2445145）同理。
- **开销**：每天 O(事件数 × 作用域数) 次完整 trigger 求值。一个带 modifier 的 mod 星球事件，每天约 1 万次；一个带 modifier 的舰船事件，每天约 3 万次。
- **引擎修复**：加载时算出概率上界（基础概率除以所有小于 1 的 factor 之积）。先按上界掷骰，命中后再求值 `IsValid` 和精确概率，并以"精确值 ÷ 上界"的概率接受（拒绝采样）。
- **mod 侧**：不要写带 `modifier` 的 `mean_time_to_happen`。改用 `is_triggered_only` 事件，从 `on_monthly_pulse` 或 `on_yearly_pulse` 触发，概率用 `random` 或 `random_list` 控制。

### S2 `random_*` 先对全部候选求值 `limit` 再挑一个（置信度：高）
- `CScriptedListEffect<CRandomInScriptedListEffect,CPlanetListBuilder>::BuildList`（6564744–6564880）先复制全部星球 ID（`g_CurrentGameState+0x5b0`），逐个执行 `CTrigger::Evaluate(this+0xb8)`，再用交换删除的方式剔除不满足的（约 6564857–6564875）。
- 之后 `CRandomInListEffect::ExecuteActual`（5901493）才挑一个下标。带权重的版本还要对每个幸存者计算一次 `CScriptableValue::GetValue`（`GetRandomIndex` 5901651）。
- **开销**：一次 `random_galaxy_planet = { limit = … }` 约等于 1 万次 trigger 求值，哪怕一半星球都满足条件。`random_country`、`random_system` 等同理。
- **引擎修复**：不带权重时做部分 Fisher–Yates 洗牌，第一个满足 `limit` 的就返回。期望开销从 N 降到 N ÷ 命中数。
- **mod 侧**：尽量用范围最小的列表（`random_owned_planet`、`random_system_within_border`、`random_neighbor_system`）；提前给候选对象打 flag，让 `limit` 只需要查 flag。

### S3 ✅ 作用域迭代器每次都深拷贝事件目标和变量容器，拷贝却从不被读取（置信度：中高）
- `CAnyInScriptedListTrigger::ActualEvaluate`、`CalculateCount`、`CEveryInListEffect::ExecuteActual`、`CRandomInListEffect::ExecuteActual` 开头都会执行 `CEventScope::CEventScope(local, param_1)`，进而调用 `CEventScope::Copy`。
- `Copy`（2467761–2467837）：
  - 2467771 把源作用域的 `+0x38`（根作用域指针）复制过来，所以子作用域不是根。
  - 2467811 只要源作用域有 `+0x48` 容器，就执行 `PdxMakeScopedPtr<CEventTargetContainer>`：`operator_new(0x50)`，复制两个 `CPdxArray<CSavedEventTarget>`，再复制一张 robin-hood `CString→CFixedPoint` 表。
- 读取方只看根作用域：`GetVariables`（2479665）只有在 `this+0x38 == this` 时才读自己的 `+0x48`，否则沿 `+0x38` 回溯到根。`GetSavedEventTarget`（2476257）和 `SwapEventTargetContainerWithBaseScope`（2476128）也一样。**所以子作用域里的那份拷贝永远不会被读到。**
- **开销**：只要当前事件或 effect 用过 `save_event_target_as` 或 `local_` 变量，其中的每个 `any_`/`every_`/`count_`/`random_` 块都会做堆分配和字符串复制，嵌套时成倍增长。
- **引擎修复**：子作用域（`this+0x38 != this`）不复制 `+0x48`，或者改成懒复制、引用计数。
- **mod 侧**：在热点迭代器里少用 saved event target 和 `local_` 变量；需要存值时优先用真实作用域上的 `set_variable`。
- **未验证**：普通的作用域切换（如 `owner = {}`，经过 `CContextTrigger::Evaluate` → `CEventTarget::GetScope`，6747690）是否也会走 `Copy`。`GetScope` 没有反编译出来。

### S4 `every_*` 和 `random_*` 开始前会强制刷新 modifier 图（置信度：机制高，开销中）
- `CEveryInListEffect::ExecuteActual`（5900439）、`CRandomInListEffect::ExecuteActual`（5901493），以及 `CRootEffect`、`COrderedListEffect`、`CClosestSystemEffect`、`CRandomStationEffect`，都会调用 `CModifierNodeManager<…>::Update()`。
- `Update`（515091）在 dirty 位 `+0x941` 被置位时，会执行 `CPdxGraphJob` 和 `AddTasksDetached`，即一次同步的多线程扇出。
- **开销**：`every_owned_planet = { add_modifier = … every_owned_pop_group = {…} }` 这种写法，外层每迭代一次就要做一次完整的并行刷新。
- **引擎已有的绕过办法**：`set_update_modifiers_batch = begin/end`（`CSetUpdateModifiersBatch::ExecuteActual` 6161096）会置位 `+0x969`，让 `Update` 变成空操作。代价是批处理期间 `limit` 读到的是旧的 modifier 值。

### S5 国家、舰队、舰船、派系事件轮询不做预筛选（置信度：中）
- 星球事件的 `CheckEvents` 会先用 `SPreTriggerValues` 掩码和 `CEvent+0x550/0x552` 做预筛选（3474858–3474880）；on_action 的 random_events（954371）和延迟事件（2289678）也会。
- 国家模块的几个循环（2444595、2444654、2444905、2445153）只检查 `fire_only_once`（`+0x66a`），然后就直接调用 `GetChance`/`IsValid`。
- 舰船事件即使没有 modifier，也要对每艘船调用一次 `GetChance` 并取一次随机数。
- **修复**：把 `CPreTriggers` 扩展到国家、舰队、舰船作用域；无 modifier 的 MTTH 改用预生成的随机表。

### S6 `HasEventFired` 是线性扫描（置信度：代码高，影响低到中）
- `CGameState::HasEventFired`（431982）遍历 `+0xb0/+0xbc` 数组；`SetEventFired`（432005）只在末尾追加，不排序。
- 每个 `fire_only_once` 事件在每个星球、每个国家每天都要查一次，每次 `TriggerEvent`（约 2455825）也要查。列表在整局游戏里只增不减，大型 mod 下可达数千条。
- **修复**：在 `CEventHandle` 上加一个"已触发"位，或者改用哈希集合。

### S7 `any_`/`count_` 在第一次求值前先付出 O(N) 物化开销（置信度：高，影响低到中）
- `CAnyInScriptedListTrigger<CPlanetListBuilder>::ActualEvaluate`（6566149）会先把全部星球 ID 复制到池化数组里，然后才进入短路循环。
- `CAnyInScriptedListTrigger<COwnedPopGroupListBuilder>`（6584826）调用 `CountAndList` 两次（6583333，850 行）：第一次计数，第二次填充。
- 嵌套时代价会爆炸。例如在每个人口组的 trigger 里写 `owner = { any_owned_pop_group = … }`，就是 O(G²)；G = 1 万时，一轮约 10⁸ 次 ID 复制。
- **修复**：改成惰性迭代器。
- **mod 侧**：不要在按人口组或按星球求值的 trigger 里嵌套国家级的 `any_owned_pop_group` 或 `any_galaxy_planet`；改为每月把结果缓存到变量或 flag 里。

### S8 权重类 modifier 在 `factor = 0` 后不会提前退出（置信度：中）
- `CMeanTimeToHappen::GetRawFactor` / `GetRawFactorNoScopeCopy`（868476–868522）和 `CScriptableValue::GetValue`（869070），在累积因子已经为 0 之后仍会把剩下的 modifier 逐个求值。
- 对比：`GetChance` / `GetDailyChance`（868334、868408）有 `if (cVar2 && local_38 == 0) return 1000000` 这样的提前退出。
- **影响范围**：AI 权重、on_action 的 `random_events` 权重（954371）、带权重的 `random_`。
- **mod 侧**：把硬性排除条件放进 `potential`、`allow` 或 `limit`，这些会短路。

### S9 on_action 分发的冗余（置信度：高，影响低）
- `COnActionDatabase::PerformEvent`（954594）对 `GetRandomValidEvent` 已经验证过的事件，又执行了一次 `IsValid`。
- C++ 代码里有 329 处按名称分发 on_action，每次都构造 `CString`（如 `CGameState::MonthlyUpdate` 按国家循环里的 `"on_biomass_monthly"`，约 418373），再计算 `PMurHash32` 并逐桶 `bcmp`（954497–954590）。其中少数热点已经改用缓存好的 `COnActionList*`（如 418420）。

### S10 `check_variable` / `set_variable` 每次调用都有字符串开销（置信度：高，影响低）
- `GetVariablePointer`（1584602）每次求值都构造 `CString("local_")` 并调用 `StartsWith`。
- `CVariables::GetVariable` / `SetVariable`（1596830–1596895）每次都对变量名计算 `PMurHash32`。存储本身是 robin-hood 哈希表，这一点没问题。
- **修复**：解析时预先算好哈希和 `local_` 标志。

## 设计良好的部分（本方向）
- 池化 ID 数组：`NScriptList::AquireIdArray` / `ReleaseIdArray`（6742484–6742664）使用线程局部池，稳态下没有堆分配。
- `any_` 在第一个命中时就短路（6566340）。
- `count_` 有提前退出（`CalculateCount` 6568605–6568825）。唯一缺的是"已经不可能达到目标值"时的提前退出。
- AND/OR 会短路：`CAndTrigger`（1579479）、`COrTrigger`（6743525）。
- 延迟事件先倒计时，再做预筛选和 `IsValid`（2289615）。
- 各国的事件轮询在并行 job 里执行。
- 带参数的 scripted trigger/effect 在**加载时**展开，并通过 `CMetaScriptObjectInstanceRepository` 去重；运行时就是一次虚调用（6750319）。
- 性能分析器相关的字符串只有在 `g_ScriptProfiler` 打开时才构建。
