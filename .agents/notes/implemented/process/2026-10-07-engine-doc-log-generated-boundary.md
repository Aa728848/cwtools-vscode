# Agent Note: 引擎文档日志的"动态生成"边界与审计口径修正

Status: implemented

## Problem

在一次"刷新随包引擎文档"的改动中，`config/logs/modifiers.log` 被从 4.5.2 游戏日志整体重新生成（**3,149 → 45,583** 条），理由是"引擎自带文档严重滞后，42,435 个合法 modifier 键被判为未知"。

**这个改动是错的，已回滚。** 原因：本项目**本来就会动态生成**大量 modifier 键，而随包日志是**刻意裁剪过**的——两者是互补关系，不是"旧数据 vs 新数据"。

## Decision

### 1. 回滚 `config/logs/modifiers.log`

`git checkout -- config/logs/modifiers.log`，回到 3,149 条的裁剪基线。

### 2. 记录证据（这是本次真正的产出）

**证据 A：裁剪是刻意行为，不是滞后。** 追踪该文件历史，条目数：

| revision | 日期 | 条目数 |
|---|---|---:|
| `82bae5f` (4.3.0) | 2026-03-12 | **33,705** |
| `843eebe` | 2026-06-24 | 3,134 |
| `bbc36f8` (4.4.5) | 2026-07-07 | 3,138 |
| `f9d8e6f` | 2026-09-23 | 3,141 |
| `7857883` | 2026-10-06 | 3,149 |

从 4.3.0 的 33,705 条**主动删到**约 3,140 条，并在后续 4 个版本里保持。若是滞后，数字应单调增长。

**证据 B：删掉的正是"生成族"。** 4.3.0 → 裁剪版的 30,887 条删除中，**30,368 条（98.3%）在 4.5.2 游戏日志里依然存在**——说明它们不是被游戏删除的，而是**被规则侧判定为可生成、无需列举**。

**证据 C：本项目有两条独立的生成通道。**

- **CWT 类型模式（主力）**：`.cwt` 的 `type[...] = { modifiers = { "shipsize_$_hull_mult" = Ships } }`。全部 `.cwt` 中共 **154 个 distinct 类型模式**，运行时按 vanilla 的 `common/*` 实例展开（`RulesHelpers.generateModifiersFromTypes` / `generateModifierRulesFromTypes`）。
- **CWTools 硬编码生成器**：`STLValidation.fs` 的 `addGeneratedModifiers`，按 `ship_sizes` / `economic_categories` / `strategic_resources` / `pop_categories` / `pop_jobs` / `planet_classes` / `country_types` / `species_archetypes` / `districts` / `ethics` / `technology/category` / `component_tags` / `building_tags` / `espionage_*` 的键生成。

**覆盖率实测**：那 42,435 条"新增"中，**34,668 条（81.7%）已被上述 CWT 类型模式覆盖**，其余多由硬编码生成器覆盖。

**证据 D：语言服务确实拿得到生成结果。** `STLGame.fs:375-384` 把生成结果并入 `lookup.coreModifiers`：

```fsharp
let typeGeneratedModifiers = RulesHelpers.generateModifiersFromTypes lookup.typeDefs lookup.typeDefInfo
let current = (embeddedSettings.modifiers |> List.ofArray) @ typeGeneratedModifiers
lookup.coreModifiers <- addGeneratedModifiers current (EntitySet(resources.AllEntities())) |> List.toArray
```

即 `embedded.modifiers`（来自 `setup.log`/`modifiers.log`）+ 类型生成 + 硬编码生成，三者取并集。

### 3. 修正审计工具的口径

`tools/engine-cost/audit-config-logs.cjs` 原来的实现把"随包日志 vs 游戏日志"的差集一律报为 `missing`，**这正是本次误判的根源**。已改为区分：

- `generated`：差集里能被 **CWT 类型模式**或 **CWTools 硬编码生成器**解释的键——**预期缺失，不是问题**；
- `missing`：两条通道都解释不了的键——**这才是真正的覆盖缺口**，值得人工判断是"该补进日志"还是"该补一条类型模式"。

工具现在输出 `generated / missing / removed` 三分类，并对"整族缺失"给出提示。

## Alternatives considered

- **把 45,583 条全量写进日志**：已实施后回滚。除了体积（+4 MB）与重复定义风险，更根本的问题是**它把"生成"降级成"枚举"**：规则里已有的 154 个类型模式会继续按 vanilla 实例展开，而日志又静态列举同一批键，两边一旦不同步就会产生难以定位的漂移。**动态能力应当保持动态。**
- **只保留"生成器解释不了"的 7,767 条**：否决。这个数字来自我**自己重写的**生成器复现（只覆盖 7.8%），与仓库里真正的生成逻辑（CWT 类型模式为主）不同源；用一份不完整的复现去裁剪数据，等于把复现的缺陷固化成规则。正确的判据是 CWT 类型模式（81.7% 覆盖），而剩余部分的归属需要逐个核对，不能自动写入。
- **删除 `modifiers.log`，完全依赖 `setup.log`**：否决。`STLGame.fs:2286` 优先读 `modifiers.log`，缺失才回退 `setup.log`；且 `setup.log` 是玩家本机产物，规则仓库不能依赖它。

## Consequences

- `config/logs/modifiers.log` 保持 3,149 条裁剪基线，**未改动**。
- 审计工具不再把生成族误报为缺失；运行它会明确区分"预期缺失"与"真缺口"。
- **教训**：本项目对 Stellaris 规则做了大量动态生成（CWT 类型模式 + 硬编码生成器）。任何"把游戏日志/原版数据整体搬进规则"的想法，都必须先回答"这个键是不是已经被生成了"，否则会把设计好的动态能力覆盖成静态枚举。
- 待办（未做，需人工）：那 7,767 条里有多少是 4.5.x 新增的静态 modifier、值得补进日志或补一条类型模式，需要逐族核对。**不应自动写入。**
