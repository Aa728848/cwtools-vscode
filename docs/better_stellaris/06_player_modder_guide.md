# 06 不改引擎也能做的事：玩家与 mod 作者指南

每条都标出了依据的发现编号，详见对应文件。

## 玩家

| 做法 | 原因 | 依据 |
|---|---|---|
| 折叠大纲里的"星球"和"舰队"分组，或在大纲设置里关掉 | 展开时每帧都对每个殖民地做本地化和字符串拼接，对舰队排序；折叠后只做计数 | 01-U2 |
| 不用的时候关掉领袖、派系、星球等窗口 | 打开的窗口每帧 Update，没有节流 | 01-U5/U6/U7 |
| 鼠标不要长时间停在复杂对象上 | tooltip 每帧重新生成 | 01-U1 |
| 缩放星图时减少同屏舰队数，或合并舰队 | 舰队图标每帧线性匹配 | 01-U3 |
| 星球很多时，只对确实需要的星球开启星球自动化 | 自动化每月在主线程上串行、逐个殖民地执行 | 12-AI5 |
| 不用时关掉舰队管理器窗口 | 打开期间每秒要把全国舰船按设计重数 7–18 次，每帧还有按尺寸计数 | 08-E2/E3 |
| 调低自动存档频率 | 存档时模拟暂停，而且序列化是单线程的 | 05-E3 |
| 少建或不建星门、跃迁中继；选小一些的星图 | bypass 会让距离查询绕过 O(1) 矩阵 | 04-F1 |
| 月初的卡顿基本是岗位重算（每月两遍）造成的，属于正常现象 | — | 03-P1 |

## mod 作者：脚本

| 不要这样写 | 应该这样写 | 依据 |
|---|---|---|
| 带 `modifier = { … }` 的 `mean_time_to_happen` | `is_triggered_only = yes`，从 `on_monthly_pulse`/`on_yearly_pulse` 触发，概率用 `random`/`random_list` 控制 | 02-S1 |
| `random_galaxy_planet = { limit = { 复杂条件 } }` | 用范围最小的列表（`random_owned_planet`、`random_system_within_border`、`random_neighbor_system`）；先给候选打 flag，`limit` 只查 flag | 02-S2 |
| 在按人口组或按星球求值的 trigger 里写 `owner = { any_owned_pop_group = … }` | 每月算一次，把结果存到变量或 flag 里 | 02-S7 |
| 在 `every_*` 循环里反复 `add_modifier` | 用 `set_update_modifiers_batch = begin` … `= end` 包住（注意：批处理期间 `limit` 读到的是旧的 modifier 值） | 02-S4 |
| 用了 `save_event_target_as` 或 `local_` 变量的事件里，大量嵌套 `any_`/`every_` | 在热点迭代器里少用 saved event target 和 local 变量 | 02-S3 |
| 权重块里堆很多 `modifier = { factor = 0 … }` | 把硬性排除条件放进 `potential`/`allow`/`limit`，这些会短路 | 02-S8 |
| 大量 `fire_only_once` 事件 | 数量控制在合理范围内，因为已触发列表是线性扫描的 | 02-S6 |

| 动态名的基础名以数字结尾（`wave1@this`、`wave12@this`） | **已实测**：动态名是"基础名 + 十进制 ID"直接拼接，没有分隔符，`wave1`+`23` 和 `wave12`+`3` 都是 `wave123`；基础名末尾加一个非数字字符 | 08-B8-(6) |
| 长时间游玩或反复读档时，mod 不断生成新的动态名 | **已实测**：名字表是进程级的，65535 满了之后，新 flag 静默丢失、事件目标串号，只有重启游戏才能恢复 | 08-B8-(6) |
| 同一个事件里多次写 `prev.prev.from = { … }` | 每次引用都要递归解析整条链，每一段都构造并拷贝一次作用域；合并成一个块，或者嵌套写 `prev = { prev = { from = { … } } }` | 08-B8 |
| 事件里存很多局部事件目标和 `local_` 变量，同时又做大量作用域跳转 | 根作用域一旦带有容器，之后每一跳都要把它整份深拷贝一遍 | 08-B8 |
| 可能不存在的跳转不写 `?` | 失败时会把整个作用域序列化进内存文件并写错误日志；写成 `from.from? = { }` 或先判断 `exists` | 08-B8 |
| 用大量 `has_global_flag` 做一次性开关，从不清理 | global flag 共用一个线性数组；用完就 `remove_global_flag`，或者改用 global 事件目标（排序数组、二分查找） | 08-A1 |
| `set_flag = foo@this` 或 `save_event_target_as = x@this` 打在每个星球或人口上 | 每个对象都会永久占用一个 flag 名，上限 65535，表满后所有新 flag 静默冲突；改用变量，或者打静态 flag | 08-A3/B5 |
| 在高频 trigger 里写 `check_variable = { which = owner.var }` 这类跨作用域读取 | 每次求值都会完整拷贝一次作用域；先切换作用域 `owner = { check_variable = … }`，或者把值缓存到当前作用域 | 08-B3 |
| 在高频 trigger 或权重里写 `num_researched_techs` / `num_researched_techs_of_tier` | 每次都扫描全部已研究科技；能用 `has_technology`（O(1)）判断的就用它 | 08-D |
| 国家作用域的 `num_ships` | 逐船计数；尽量改用 O(1) 的 `fleet_size`、`used_naval_capacity_integer` | 08-E5 |
| `game_rules` 里写复杂脚本 | 规则完全不缓存，而且可能每帧、每次命中都被调用；规则必须写得极其便宜 | 08-C |
| 连锁武器 `chain_count` 设得很高、装在大量小船上；`collateral_range` 设得很大 | 连锁每跳都重扫整个星系；AoE 半径越大命中越多，每次命中都要求值 `is_country_psionic` | 08-F |

| 用 `inline_script` 当函数，在几百个地方调用同一段逻辑 | 改用 scripted_trigger/scripted_effect：运行时一样快，加载只解析一次，内存只有一份（inline_script 每个调用点都要重新解析并生成一份独立副本） | 09 |
| 以为把 scripted_trigger 展开成内联代码能提速 | 没用：运行时只差 1–2 次虚调用；该优化的是里面的内容 | 09 |
| 带参数的 scripted_* 用大量不同的参数值实例化，模板里还塞满 `[[宏]]` | 每组不同参数都要完整生成源码并重新解析；尽量减少参数组合数，拆出无参数的公共部分 | 09 |

| 在人口组或星球级循环里调用 `modify_species` | 每次都是 O(物种数×特质²) 的查重，国家作用域还要全帝国重新分组；在国家作用域调用一次，多个特质修改合并到同一个 block | 10-1 |
| 按人口或舰船批量派发 `days=` 延迟事件，还带复杂的 `abort_trigger` | 每个都要一次堆分配和作用域深拷贝，每天都要全量扫描一遍并求值 abort_trigger；改为在国家作用域派发一次 | 10-5 |
| `every_owned_planet = { add_building/add_district }` 放在频繁的 pulse 里 | 每次调用都同步重分配整颗星球的岗位 | 10-3 |
| `spawn_system` 不用批处理包起来；航道编辑分散在多个 tick 里 | 每次都重建一次 O(N²) 距离矩阵；用 spawn-system 批处理包起来，编辑集中在同一个 tick | 10-4 |
| 在循环里用 `create_country`，或者对恒星基地 `set_owner` | 每次都强制同步重建数据库数组，或同步重算全图边界 | 10-7、04-F2 |
| 重复施加的 modifier 放在星系或舰队作用域 | 星系作用域会同步重算，舰队作用域要逐船处理；改放国家或星球作用域（相同的值重复施加几乎没有开销） | 10-6 |

| 在 `every_owned_pop_group` 里写 `check_variable = { which = x value = owner.y }` | 每次都要拷贝作用域并递归解析链；先在外层 `set_variable = { which = tmp value = owner.y }` 读一次，循环里只和 `tmp` 比较 | 08-A5 |
| 变量名很长（≥16 个字符），并在大量对象上设置 | 每个对象、每个变量都要堆分配一个字符串键，每次访问都要哈希整个名字；变量名尽量短 | 08-A5 |
| 用 `change_variable` 不断累加，又不做钳制 | 裸 64 位加法没有溢出检查，超出约 9.2×10¹³ 后会静默变成负数；自己用 `clamp_variable` | 08-A5 |
| `can_join_faction`、派系 `is_potential`、`can_pop_group_join_factions` 写得很复杂 | 每天对每个人口组 × 每种派系类型都要求值一次 | 11-D1 |
| pulse 里的 `every_country` / `any_country` 中用 `opinion` trigger | 在 AI 作用域之外没有缓存，每次都完整计算约 20 个好感 modifier；先用便宜的检查过滤 | 11-D5 |

| 决议的 `potential` 写得很复杂 | 每个 AI 每周要对它拥有的每个星球（包括未殖民的）× 全部决议判断一次；开头放星球类别、`has_owner`、flag 这类便宜的检查 | 12-AI4 |
| 新增大量宣战理由，`potential` 又很重 | 每天对"国家 × 已接触国家"逐对求值；便宜的排除条件放前面，重的检查挪到 `is_valid` | 13-S1 |
| 特殊项目、局势的 `abort_trigger`/`fail_trigger`，遗址的 `visible`，焦点卡的完成条件写得很重 | 每天都要轮询（部分还是串行） | 13-S3/S4/S8 |
| `can_colonize_planet` 规则、物种特质上的宜居度 trigger 写得很重 | AI 殖民评估会按"全银河星球 × 可殖民物种"的倍数反复求值 | 12-AI1 |

## mod 作者：经济与岗位

| 注意事项 | 依据 |
|---|---|
| 岗位的 `weight`/`possible` **每月要执行约 360 万次**（每个人口组 × 每个岗位 × 2 遍），必须极其便宜，绝对不要在里面写迭代器 | 03-P1 |
| 建筑、区划、岗位上的 `triggered_*_modifier` 每天都会全部重算，调大 `TRIGGERED_MODIFIER_UPDATE_DELAY` 对它们**无效**；这里的 trigger 要写得便宜 | 03-P6 |
| 岗位类型带国家级 modifier 时，分配人口一变就会使整个国家的 modifier 失效；这类岗位尽量少用 | 03-P3 |
| 移民规则 `CanColonyReceiveAutoMigration` 要对"来源 × 目的地"逐对执行，写得便宜一些 | 03-P7 |

## mod 作者：UI / GUI

| 注意事项 | 依据 |
|---|---|
| **不要删除或改名引擎会按名查找的 GUI 元素**（如舰队图标里的 `cloaked_state`），要隐藏就把大小设为 0 或移到屏幕外。否则每支可见舰队每帧都会写一行错误日志并刷盘，造成严重卡顿 | 01-U4 |
| `custom_tooltip`、scripted_loc、按钮的 `potential`/`allow` 在悬停时每帧都会执行，不要在里面写 `any_*`/`count_*` 大列表 | 01-U1 |
| 派系的诉求和行动 trigger 在窗口打开期间按帧率执行 | 01-U6 |

## mod 作者：加载时间

| 注意事项 | 依据 |
|---|---|
| 本地化覆盖已有键（`replace/`）时，每个键都要对全部键做一次线性扫描；只覆盖真正需要改的键，不要整份文件复制过来再覆盖 | 05-E5 |
| 脚本文件总大小直接决定加载时间（单线程逐字符词法分析）；删掉注释掉的大段代码、无用的文件 | 05-E1/E2 |

## defines 可调项

| define | 作用 | 依据 |
|---|---|---|
| `NAI.FLEET_MAX_DISTANCE_LOOKUP` / `_LARGE` / `_HUGE` | 调低可以减少 AI 每周军事距离计算的开销 | 04-F10 |
| `NInterface.TOOLTIP_TIME` | 调大只能省下延迟窗口内的那些帧，延迟到期后仍然每帧重建 | 01-U1 |
| `NGameplay.TRIGGERED_MODIFIER_UPDATE_DELAY` | 只影响殖民地、人口组、国家自身的 triggered modifier，对建筑和岗位上的无效 | 03-P6 |
