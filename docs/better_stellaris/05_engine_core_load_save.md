# 05 引擎基础设施：线程、容器、存档、加载、本地化

### E1 约 180 个脚本数据库全部在主线程串行加载（加载时间；置信度：高）
- **位置**：`NNullObjAndDatabaseInitUtil::SetupDatabases`（196820–199551），由 `CGameApplication::InitGame`（193451）调用。
- **流程**：先建一张表，每项是 `{name, CreateInstance, DestroyInstance, CanInitialize, InitInstance, PostReadInitInstance}`，共约 376 个函数指针。然后循环：挑一个 `CanInitialize` 通过的数据库，直接调用 `InitInstance` 和 `PostReadInit`（约 199155–199160），再用移位的方式把它从数组里删掉。
- **证据**：整个函数里没有任何 task、`CJob` 或 `ParallelFor` 调用。`InitGame` 里唯一的任务是 `$_7`（193498），它只负责渲染加载画面。
- **单个数据库内部也是串行的**：例如 `TSingleObjectGameDatabase<CTechnologyDatabase,...>::Init`（1489034）先调用 `VFSGetEnumeratedFiles`，再串行地对每个文件执行 `LoadFile`。
- **修复**：依赖关系已经通过 `CanInitialize` 显式表达，可以直接按这个依赖图并行调度。退一步，至少可以并行地把文件词法分析、解析成 AST，最后再串行插入。

### E2 词法分析器每读一个字符要做 2 次虚调用和一次 `iswspace`（加载时间；置信度：高）
- **位置**：`CTextLexer::GetTok`（8100439–8100673）。
- **每个字符**：
  - 两次虚调用：`+0x10`（读字符）和 `+0x58`（EOF/状态检查），见 8100464、8100520、8100562、8100626；
  - 一次带区域设置的 `iswspace`（8100469、8100603）；
  - 一次没有内联的 `CToken::SetCharInString`（8100561、8100625）。
- **每个标识符**：还要经 `CStaticLexer` 做一次虚函数的关键字查找（8100655）。
- **开销**：每字节约 4 次函数调用。几十到几百 MB 的脚本文本，就是 10⁸–10⁹ 次调用，也就是若干秒。
- **修复**：直接用指针扫描整个文件缓冲区；用 256 项的 ASCII 字符分类表代替 `iswspace`；字符串和注释用 `memchr` 或 SIMD 扫描；token 用 string view 切片。

### E3 自动存档时模拟暂停，全部游戏状态单线程序列化（后期卡顿；置信度：高）
- **流程**（`CSaveGameTaskManager::Update` 1203259–1203516）：
  - 任务 `$_0` → `CreateMemoryFiles`（1202906）→ `CWriter::WriteTopLevelList`，写 "gamestate" 和 "meta"，这是一个单独的任务。
  - 主线程在 `while(!done){ RenderFrameIfNeeded; nanosleep(1ms); }`（1203400–1203415）里等待。UI 继续渲染，但游戏不推进。
- **做得好的地方**：压缩和写盘在 `$_1` → `ZipAndWrite`（1204408）里，是另一个后台任务，主线程不等它。
- **序列化的额外开销**：
  - `CWriter::WriteString(char*)`（8113403–8113482）为每个带引号的字符串复制一份 `CString`，即使没有需要转义的字符，也执行两遍完整的 `ReplaceAll`（`\\` 和 `\"`，8113423–8113426）；
  - 之后为了写一个分隔符，还要构造一个带 `CPdxHybridArray` 的 `CToken`（8113469–8113476）；
  - 每个 token 都通过虚函数 `WriteData`/`WriteByte` 输出；
  - 输出的 `CBlob` 按 1.5 倍增长并 `memcpy`，没有预留空间（`CBlob::Append` 7941367）。100–300 MB 的存档，内存复制量约为 3 倍。
- **修复**：各数据库分段并行序列化到独立缓冲区，最后拼接；没有转义字符时走快速路径（先用 `strpbrk` 检查）；按上一次存档的大小预留空间；长期看，用快照或写时复制，让模拟可以在序列化期间继续运行。

### E4 全图距离矩阵：任何航道变化都 O(N²) 全量重建（加载、星系生成、大星图 mod；置信度：中高）
- **位置**：`CGalacticDistanceCache::BuildHyperlaneDistances`（2567816–2568038）。
- **它做什么**：
  - 把两张严格上三角的 N×N 表重置为"未设置"（2567874、2567884）。N=1000 时约 5 MB，N=3000 时约 45 MB。
  - **对每个源点 i 各做一次** `NThreadUtil::ParallelFor(..., 0, row_len, 1, ...)`（2567981）。这样一共有 N 次 fork/join 屏障，而且三角形越往后行越短，后面的屏障几乎没有活可干。
  - 工作函数（`CUpdateNonInitializedWithPathfind::operator()` 2568763）对每个仍未设置的点对跑一次 `CAStarAlgorithm::Find`。
- **触发条件**：
  - `UpdateDatabaseArrays` **每 tick** 都对全部星系的航道校验和（+0x5a0）做 XOR（409273–409300）；
  - 校验和不匹配，或 `CGalacticObject` 数据库 dirty 时，置位 `CGalacticMapCache::_Update |= 1`，于是 `CGalacticMapCache::Update`（2572967）调用 `BuildHyperlaneDistances` 和 `UpdateEndCycleSystems`；
  - 校验和包含航道 flag 和长度（`CHyperlane::CalcChecksum` 697090），所以任何一次增删航道（如 `AddHyperlane` 2583509–2583537）都会触发全量重建。
- **修复**：每个源点做一次 Dijkstra/BFS，一次就能填满一整行（O(E log N)），并把所有源点放进同一个 `ParallelFor`；单条航道变化时增量更新；也可以考虑按需计算加 LRU 行缓存。

### E5 ✅ 本地化 `replace/` 覆盖是 O(K·N)（加载时间，mod；置信度：复杂度高，量级中）
- **调用路径**：`ReadLocalizationFolderHelper`（8057180）先加载普通文件，再调用 `LocalizeSortKeys`，最后带 replace 标志加载 `replace/` 文件：`LocalizeYmlAddKey`（8064964）→ `SLanguageData::AddKeyValuePair`（8071480）。后者先二分查找，键已存在时调用 `ChangeKeyValuePair`。
- **线性扫描**：`SLanguageData::ChangeKeyValuePair`（8071291）在 O(log N) 的二分查找之后，又线性扫描了整个 `SKeyValueData` 数组（函数内第 78–91 行）：
  ```c
  piVar14 = (int *)(*(long *)(this + 0x50) + 0x14);
  do { if ((*(ulong *)(piVar14 + -5) == local_58) && (piVar14[-1] == param_3)) {...}
       piVar14 = piVar14 + 6; } while (uVar5 != uVar13);
  ```
  这个数组里每个加过的键占一项 24 字节，N 约为 10⁵–5×10⁵。每覆盖一个键就是 O(N)。例如覆盖 2 万个键 × 30 万个键 = 6×10⁹ 次比较，约数秒。
- **另外**：
  - `ChangeKeyValuePair` 会把新值追加进字符串池，旧值要到重新加载才释放（内存泄漏）；
  - `SLanguageData::AddFile`（8071194）用 strcmp 扫描全部文件名。
- **修复**：为 `SKeyValueData` 维护一张哈希 → 下标的映射，或者直接复用排序键数组里的下标。
- **正确性问题**：`Localize`/`LocalizeString`（8066683、8066087）只按 32 位 Murmur 哈希匹配，不比对原始键名。30 万个键时预计约 10 次冲突，冲突时会返回错误的字符串。游戏本身有 `LocalizeReportHashCollisions` 日志可以查到。

### E6 等待 join 时空转占满一个核，主线程也不帮忙干活（置信度：中高）
- `CJob::WaitAndClear`（8043852）只窃取属于自己这个 job、还没开始的任务。
- 之后 `CTask::Wait`（196747–196792）带退避地自旋（最多 30 轮，每轮最多 512 次 pause），然后进入 `while(!done) sched_yield();`（196786–196788）。`WaitAndClearNoSteal`（8043907）也一样。
- 日更里有约 15 个 `ParallelFor` 阶段（`$_113`–`$_135`），另外还有按国家的嵌套 job（E7）和 E4 的 N 个屏障。一旦某个任务特别长（比如大国的 AI），主线程就在那里 yield 空转，而不是去执行队列里的其他任务。在超线程（SMT）上，它还会和那个慢任务抢同一个物理核。
- **做得好的地方**：空闲的工作线程会阻塞在信号队列上（`CPdxTaskScheduler::WaitForNewTask` 8046642）。
- **修复**：等待时帮忙执行任意队列里的任务；短暂自旋后改为阻塞在 futex 或条件变量上。

### E7 大部分 ParallelFor 静态分块偏粗，串行循环里还有嵌套 fork/join（置信度：中）
- **分块策略**：`CPdxParallelForDescriptor`（8042538）算出每块大小 = 范围 ÷ (线程数+1)，再 ÷3（策略 1）或 ÷7（策略 2）（`CalcParallelForGrainSize` 8042497）。调用点中策略 1 有 134 处，策略 0 有 14 处，策略 2 有 6 处。所以大多数循环每个线程只分到约 3 块，工作量不均匀的实体（AI 国家、巨型殖民地、大舰队）在每个屏障都会造成负载不均。
- **嵌套 fork/join**：`CCountry::MonthlyUpdateSerial`（2022050）是在 `CGameState::MonthlyUpdate` 的串行按国家循环（418140–418162）里被调用的。每次调用都新建一个 `CJob` 去并行更新外交关系，再 `WaitAndClear`（2022197–2022390）。结果每月要做 100–300 次范围很小的 fork/join。
- **修复**：工作量不均的实体改用更细的粒度或按开销加权；把关系更新提出来，对所有国家的所有关系做一次扁平的并行循环。

### E8 在 ParallelFor 里渲染帧，拉长了模拟的屏障（置信度：中）
- `SParallelForRenderFrameIfNeeded<CColonyUpdateParallelFunc>`（3181852–3181929）和 `<CUpdateAIFunctor>`（2988950）：主线程每做完一块，就调用 `RenderFrameInParallelFor`（403985）。后者置 `g_AllowGlobalGameStateAccess=1`，然后执行 `CGameState::RenderFrame`，而此时工作线程还在改游戏状态。
- **后果**：
  - 即使工作线程都做完了，屏障也要等这一帧渲染完，每个 ParallelFor 最多多等约 16 ms；
  - 渲染器读的是正在被并发写入的实时状态，存在数据竞争。
- 串行循环里也有同样的"顺便渲染一帧"：`MicroUpdate` 每 1000 艘船一次（416141–416149），`MonthlyUpdate` 每 3 个国家一次（418164）。
- 这是为了 UI 流畅度而做的权衡，代价是高速游戏时的模拟吞吐量。
- **修复**：在专门的线程上从快照渲染；或者只在没有剩余任务可窃取时才在 ParallelFor 里渲染。

### E9 固定 511 个桶、永不 rehash 的链式哈希表（置信度：设计中，影响低）
- 头部为 `0x1ff00000000`、紧接 `operator_new__(0xff8)` 的模式，出现在 `COnActionDatabase::CreateInstance`（954757）、`COpinionModifierDatabase`、`CEventManager`（事件命名空间）、`CNameListDatabase`、`CPlanetClassDatabase`、`CLogger` 类别等处。
- `COnActionDatabase::AddList`（955427）按 `hash % 511` 插入，从不扩容。每次 `PerformEvent` / `GetOnActionList` 都要用 Murmur 重新哈希名称字符串，再沿链 `bcmp`。
- mod 有数千个 on_action 时，链长约 2–10。影响不大，但修起来很容易：换成引擎自己的 `CPdxRobinHoodTable`，或者在加载时就把 on_action 名称解析成指针。

### E10 `UpdateDatabaseArrays` 对每个 dirty 类型按容量全量重建，每天约 11 次（置信度：高，影响低）
- `HandleTurnTick` 每 tick 调用一次（415119），`DailyUpdate` 之前再调用一次（415178）。
- 每个 dirty 类型都要扫描全部槽位，再逐个 `InsertAtEmplace` 重建整个 `TPdxRef` 数组（例如舰船 409104–409137）。战争期间舰船不断增减，1–3 万艘船的数组每 tick 都重建。
- 还有每 tick 无条件的全星系 XOR 哈希（409273–409300），每 tick 约 10–100 µs。
- **修复**：增量增删（存下每个元素的下标，删除时与末尾交换）；航道变化改用 dirty flag，不要每 tick 轮询哈希。

### E11 小问题
- **OOS 校验（仅多人游戏）**：`NOosChecksums::MakeSyncCheck`（957530）/ `CalcChecksums`（956037，1160 行）串行全量遍历，甚至还用 `GetFlagString` 构建 flag 字符串（956871）。只在收到校验请求时执行（415000–415003），并按级别分层。可以按实体类型并行。
- **在锁内做堆分配**：`BuildProposalList`（2972030）持有共享 `CPdxMutex` 时调用 `Clone()`（2972122–2972130），应该把 Clone 移到锁外。
- **正确性问题**：`CModifierNodeBase::Update`（247526）的双重检查 dirty 位在重算**之前**就被清除，并发读者看到位已清除就跳过加锁，可能读到算到一半的值。

## 设计良好的部分（本方向）
- **`CPdxArray` 按 1.5 倍几何增长**，不是每次 +1（如 143772–143777）；`CBlob`、`CToken`、`UpdateDatabaseArrays` 也一样。
- **`TPdxRef<T>` 查找是 O(1)**：用 `id & 0xFFFFFF` 直接索引槽位表，再校验完整 id 的代号（3180918）。对象放在每块 1024 个的 slab 里，带空闲链表（`TPdxRefDatabase<CShip>::CreateNewObject` 517771）。
- **脚本数据库查重是 O(1)**：用 `CPdxRobinHoodTable`（1492147），不是 O(n²)。
- **本地化插入是"先全部追加，最后排序"**（`SortKeys` 8071632），查找用二分，不是每插一次排一次序。
- **任务调度器设计合理**：无锁 `atomic_queue`，下标打散以防伪共享，支持工作窃取和原子计数器动态领块；空闲线程阻塞而不是空转。
- **随机日志关闭时开销很小**：`CRandom::SetForbidden` 只是一个全局标志；`CRandomLog::IsEnabled` 是便宜的判断。
- **存档的压缩和写盘是异步的**。
- **flag 过期是 O(flag 数)**：`CPdxIntegerFlags::UpdateFlags`（7062208）用交换删除。
- **字符串分配器的全局自旋锁影响不大**：只有很少使用的帧分配器（约 8 个调用点）会用到它，普通字符串直接走 `operator_new`。
