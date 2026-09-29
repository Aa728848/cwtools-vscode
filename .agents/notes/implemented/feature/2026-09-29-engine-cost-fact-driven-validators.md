# Agent Note: 引擎事实驱动校验器 CW279/CW280/CW281 与规则注释增强

Status: implemented

## Problem

[2026-09-28 悬停引擎开销 note](2026-09-28-hover-engine-cost-and-hardcoded-behaviour.md) 把引擎事实（`## cost` / `## engine` / `## engine_evidence`）呈现给了 mod 作者，但存在三个覆盖缺口：

1. **被动呈现不拦截错误写法**：作者不会逐行悬停；把全银河级开销命令写进逐日/逐月求值块（岗位 weight、决议 potential 等）时没有任何主动警告。
2. **MTTH modifier 语义陷阱**：事件的 `mean_time_to_happen` 带 `modifier` 块时，引擎会在掷骰**之前**完整求值整个 trigger，再按修正后的 MTTH 掷骰。作者普遍误以为 modifier 是"掷骰后的概率微调"，在高频事件里堆叠昂贵 trigger。
3. **动态名静默碰撞**：`set_*_flag` / `save_event_target_as` / `save_scope_as` 写入的名字是「基础名 + 十进制 ID」无分隔符拼接（`name@123`）。基础名以数字结尾时不同 ID 可生成同一名字（`a1@23` 与 `a12@3`），属静默正确性 bug，此前无任何检查。

另有一条规则侧增强动机：`set_design_flag` / `has_design_flag` 存在引擎 bug（`CAccessFlags` 把 design 作用域 0x2000 的 flag 请求落到全局 flag 容器，原版中曾因此删除无关舰船设计），规则此前仅标 `## severity = warning`，不足以阻止使用。

## Decision

沿用悬停 note 确立的分工：**事实声明在 CWT 规则，代码只做分类与匹配**，不硬编码任何具体命令的事实。cwtools 子模块新增三个校验器，cwtools-stellaris-config 子模块增强注释与严重度：

1. **CW279 `HotContextCost`（Information，参数化消息）**：昂贵类别集合 `hotContextExpensiveCosts = { o(n)_galaxy, o(n^2), combat }` 硬编码在 [STLValidation.fs](../../../../submodules/cwtools/CWTools/Validation/Stellaris/STLValidation.fs)（仅是事实的"分类"，不是事实本身）；逐命令成本事实来自 `engineCostMap`——扫描已加载规则中 trigger/effect alias 的 `## cost` 元数据构建。命中块（结构性事实，硬编码）：`common/jobs` 的 `weight`/`possible`、`common/decisions` 的 `potential`/`allow`、`common/casus_belli` 的 `potential`、`common/buildings`/`common/districts` 中含 `trigger` 的 `triggered_*` modifier 块、事件的 `mean_time_to_happen` 的 `modifier` 块。规则未标注任何 cost 时校验器静默返回 OK；inline_script 文件整体排除。
2. **CW280 `MtthWithModifier`（Information）**：事件含带 `modifier` 块的 `mean_time_to_happen` 即在该块上报，建议 `is_triggered_only` 加周期性 `on_action` pulse。
3. **CW281 `DynamicNameDigitSuffix`（Warning，参数化消息）**：`foldNode7` 全实体一次扫描，凡叶子键以 `_flag` 结尾、含 `event_target`、或为 `save_scope_as`，且值为 `base@id` 形式而 `base` 以数字结尾即报警。
4. **规则侧（cwtools-stellaris-config）**：`set_design_flag`（effect）与 `has_design_flag`（trigger）升级为 `## severity = error` + `## error_if_only_match`（证据指向 `docs/better_stellaris/15_silent_corruption_bugs.md` C2）；`triggers.cwt` / `effects.cwt` / `scope_changes.cwt` 共 31 处 `## engine` 注释增强，其中 17 处追加 Cheaper 替代建议（如 `any_neighbor_country` / `any_species_pop_group` 的全银河扫描警告），全部只改 `##` 注释与 severity，未动 alias 语义。

三个新错误码定义在 cwtools 子模块 [Validation.fs](../../../../submodules/cwtools/CWTools/Validation/Validation.fs) 的 `ErrorCodes`（CW279/280/281），根仓库侧仅做消费方配套：登记 [diagnostic-codes.md](../../../../docs/diagnostic-codes.md) 并接入 [diagnosticI18n.ts](../../../../client/extension/diagnosticI18n.ts) 中文翻译。

## Alternatives considered

- **在每处高频块用 `## error_if_only_match` 手写警告**：否决。块清单与成本分级是结构性事实，在 26+ 个 alias 处复制会随游戏版本漂移；集中在分类集合一处维护，新增命令只需在规则补 `## cost` 即自动纳入检查。
- **把昂贵类别集合也搬进 CWT 规则**：否决。与悬停模块保持同一分工（事实在规则、分类在代码）；该集合当前仅 3 类，为它设计规则 DSL 与解析路径的收益低于成本。
- **CW281 只对显式 `set_*_flag` 键报警**：否决。`save_event_target_as` / `save_scope_as` / event_target 系列同样生成「基础名+ID」名字；`foldNode7` 一次全实体扫描即可覆盖所有动态名写入键，按键名白名单反而会漏。
- **把 CW280 并入 CW279 的 MTTH modifier 上下文**：否决。「先求值后掷骰」是独立于开销的语义陷阱，单独码号便于按码过滤与忽略管理。
- **CW279 覆盖全部 `o(n)` 类开销**：否决。`o(n)_owned` 等 owned 级扫描在高频块中的代价通常可接受，全银河级（`o(n)_galaxy` / `o(n^2)` / `combat`）才是主要热点；全量告警会淹没真正昂贵的写法（误报优先于漏报的方向选择）。

## Consequences

- 诊断码 CW279/280/281 已登记 [diagnostic-codes.md](../../../../docs/diagnostic-codes.md)，中文翻译与单元测试同步加入 [diagnosticI18n.test.ts](../../../../client/test/unit/diagnosticI18n.test.ts)；`Performance / style hints` 分组的码列表注释同步更新。
- 校验器消费规则 `## cost` 元数据：规则作者为新命令标注 cost 即自动进入 CW279 检查，无需改代码；规则未标注时校验器静默通过，不会误报。
- `Options.cost` 等共享类型跨仓库：cwtools 与 cwtools-stellaris-config 两个子模块必须先行提交，再更新根指针（与悬停 note 同一约束）。
- 已知局限：CW279 的昂贵集合是硬编码分类（暂不含 `o(n)_owned`）；CW281 只识别字面 `base@id` 形式，经变量/拼接构造的动态名不在检查范围。
