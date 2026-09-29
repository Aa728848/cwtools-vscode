# 07 已确认设计良好的部分（避免误判）

下面这些都是读过代码后确认**不是**性能问题的。写报告或向官方反馈时，不要把它们当成问题。

| 领域 | 设计 | 位置 |
|---|---|---|
| UI | 警报系统每帧只轮询 66 类警报中的 1 类（按 0x42 取模递增），每类约每秒一次 | `CAlertManager::Update` 968402–968548 |
| UI | 边界渲染由 dirty flag 驱动，形状在异步任务里计算 | `CGraphicalMap::Update` 4322046、`CBordersGraphics::PerFrameUpdate` 3693795 |
| UI | 星系图标只在 dirty 或 `(frame+id)&3==0` 时更新，每帧只更新 1/4 | `CGalacticObjectMapIcon::Update` 5601862 |
| UI | 文本框在字符串没变时直接返回，不重新排版 | `CInstantTextBox::ChangeString` 8268643 |
| UI | 派系列表项轮转刷新，每帧一个 | `CTopBarFactionsViewImp::Update` ~5159905 |
| 脚本 | `any_` 短路，`count_` 有提前退出，AND/OR 短路 | 6566340、6568605、1579479、6743525 |
| 脚本 | 迭代器用的 ID 数组来自线程局部池，稳态下没有堆分配 | `NScriptList::AquireIdArray` 6742484 |
| 脚本 | 带参数的 scripted trigger/effect 在加载时展开并去重 | `CMetaScriptObjectInstanceRepository`、6750319 |
| 脚本 | 不带 modifier 的 MTTH 先掷骰（用预生成的随机表），星球事件用预筛选掩码 | `CheckEvents` 3474858–3474941 |
| 经济 | 日更分三段（只写自身并行 → 只读自身 → 串行），职责划分清楚 | `NColonyUpdate::DailyParallelUpdate` 3172479 |
| 经济 | modifier 图只重算 dirty 节点，并行执行 | `CModifierNodeManager::Update` 515091 |
| 经济 | 日更的岗位重分配有 dirty 门控；产出按校验和门控 | 3084354、~2716560 |
| 经济 | 殖民地、人口组、国家的 triggered modifier 按 `TRIGGERED_MODIFIER_UPDATE_DELAY` 分摊 | 3081160、1054148、2012927 |
| 寻路 | 全图距离矩阵并行构建，由 dirty 驱动 | `BuildHyperlaneDistances` 2567816 |
| 寻路 | A* 用二叉堆加 decrease-key；bypass 缓存包括"不可达"的结果 | 2965647、2098535 |
| 战斗 | 战斗检测按星系分桶；选目标每 10 或 50 tick 按船 ID 错开重扫 | 3282868、1477471 |
| AI | 计数器按国家 ID 错开（`id%7`、`id%30`、`id%360`），国家间并行；殖民评估按 `id%12` 分到不同月份 | 7878818、`CreateColonizeData` |
| 核心 | `TPdxRef` 按 ID 查对象是 O(1)（槽位表加代号校验），对象在 slab 里分配 | 3180918、517771 |
| 核心 | `CPdxArray`、`CBlob` 按 1.5 倍几何增长 | 143772 |
| 核心 | 脚本数据库查重用 robin-hood 哈希，是 O(1) | 1492147 |
| 核心 | 本地化"先全部追加，最后排序"，查找二分 | `SLanguageData::SortKeys` 8071632 |
| 核心 | 任务调度器用无锁队列、工作窃取、原子计数器动态领块；空闲线程阻塞而不是空转 | 8046642 |
| 核心 | 存档的压缩和写盘是异步的 | `ZipAndWrite` 1204408 |
| 核心 | 随机日志关闭时开销很小；flag 过期用交换删除 | 7976712、7062208 |
| 脚本 | 静态 `event_target:x` 在解析时就转成 16 位 ID；global 事件目标存在排序数组里，用二分查找 | 2482032、437384 |
| 脚本 | `has_technology` 通过下标表直接定位，是 O(1) | `CTechnologyStatus::HasTechnology` 1504273 |
| 舰队 | 舰队规模、舰队战力、国家已用海军容量都有缓存，并增量维护；`fleet_size` 和 `used_naval_capacity_integer` trigger 是 O(1) | `fleet+0x1280/+0x308`、`country+0x2fe8/+0x2ff0` |
| 战斗 | AoE 和连锁用的敌对检查 `IsHostileCached` 是 O(1) 字节表 | 2033764 |
