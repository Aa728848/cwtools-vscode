# Agent Note: 文档可选字段自动探测与 CW242 误报修复

Status: implemented

## Problem

用户反馈：在 F# 事件中写

    num_pops_assigned_to_job = { value > 0 }

稳定报 **CW242 `Missing pop_group, expecting at least 1`**，且补写
`pop_group = { ... }` 又变成 CW263，怀疑是误报。

根因链条：

1. 原版脚本文档 `config/logs/trigger_docs.log` 把该字段标注为可选：

       num_pops_assigned_to_job = {
           pop_group = <target> (if not specified, check total number)
           value < 300
       }

2. `config/triggers.cwt` 里的 alias 是

       alias[trigger:num_pops_assigned_to_job] = {
           pop_group = scope_group[target_pop_job] 
           value = int_value_field
       }

   `pop_group` 没有 `## cardinality`。

3. CWT 的默认基数由 `RulesTypes.fs` 的 `Options.DefaultOptions`（min = 1, max = 1）
   决定，`RuleValidationService.fs` 的 `checkCardinality` 在 `opts.min > total` 时报
   CW242。于是「文档说可选、规则却必填」的字段，在所有**合法省略**写法上都会误报。

同一个探测器还发现第二个同源缺陷：`has_opinion_modifier` 的文档写作
`who = <target (optional)>`，而规则里的 `who` 同样是默认必填，因此
`has_opinion_modifier = { modifier = encroaching_colony }` 也会误报 CW242。

## Decision

### 1. 规则修复：把文档标注为可选的字段显式标成 0..1

在 `submodules/cwtools-stellaris-config/config/triggers.cwt` 中为两处补上
`## cardinality = 0..1`，与同文件既有可选字段（`count_starbase_modules.type`、
`num_buildings.disabled` 等）写法一致。

### 2. 用自动探测取代人工字段穷举

新增 `tools/rules-sync/optional-fields.ts`：

- **证据来源是文档而不是硬编码清单**：解析 `config/logs/trigger_docs.log`
  （以及 `effect_docs.log`）每个条目的用法块，只取第一个 `= { ... }` 块里
  **深度 1** 的键，用 `(optional)`、`if not specified`、`if omitted`、
  `(default)`、`default:`、`defaults to` 等行内标注判断可选性。
- **扫描时屏蔽 <...> 作用域引用**：像 `who = <target (optional)>` 这种把标注写在
  尖括号里的写法，如果把 `target` 也当成字段，就会把可选性错误地挂到一个嵌套名字上；
  用尖括号深度跳过 `<...>` 后，标注仍归属 `who`。同理跳过引号与圆括号内容，
  避免 `disabled = <any(default)/yes(only)>` 里的 `only` 被误判。
- **逐变体比对**：`alias[kind:name]` 在同一文件里可以有多个变体，每个变体独立校验；
  解析器保留变体边界，字段基数取字段行上方最近的一条 `## cardinality`。
- **输出两类结果**：`findings`（文档说可选、规则仍必填 → 应补 0..1）与
  `unmodeled`（文档标注的可选字段在规则里根本没有声明 → 需人工确认）。

### 3. 三个入口消费同一份审计

- `npm run rules:stellaris:optional-fields`：独立审计（`--ci` 时有 findings 退出码 2）。
- `check` / `update`：`update-rules.ts` 以新 action `optional_field` 写入报告，
  并纳入 `hasCheckDrift`，因此 `--ci` 下漂移会以退出码 2 拦截，规则刷新无法悄悄
  重新引入误报。
- `report`：`ReportData` 增加 `optionalFields`，HTML 新增「可选字段契约」页签与卡片。

此外 `parse-log.ts` 把每个 trigger 的可选字段名作为注释写进生成的候选 CWT，
提示补全规则时不要把这些字段算进必填。

## Alternatives considered

1. **逐个手工补 `## cardinality = 0..1`，不改工具**：被否决。用户明确要求改成自动探测；
   而且这次就是漏了一个字段才出的问题，手工清单在下一次规则刷新后必然重新漂移。
2. **让引擎把「文档可选」作为默认基数**（在 F# 侧按 `trigger_docs.log` 推导默认值）：
   被否决。文档标注是自然语言，误判会静默放宽**所有**规则的真实必填校验，
   代价远大于收益；保持「规则文件是显式契约、文档只是证据来源」这条既有边界。
3. **把 `pop_group` 从规则里删掉**：被否决。该字段确实存在且合法（CW263 证明引擎
   认不出它是因为类型是 `scope_group[target_pop_job]` 而非内联作用域），删掉会同时
   丢失校验与补全。
4. **在文档与规则不一致时自动改写 CWT**：被否决。`update` 既有契约是只产出候选、
   绝不静默替换维护中的规则；审计同样只报告。
5. **把可选性判断写成字段名白名单**：被否决。白名单与本次「自动探测」的诉求相反，
   且无法覆盖 `effect_docs.log` 等其它同源文件。

## Consequences

- 用户报告的写法不再报 CW242；CWToolsCLI 实机对照：同一 mod 事件修复前
  `CW242 Missing pop_group`，修复后消失且其它诊断（作用域、类型）不变。
- `has_opinion_modifier` 省略 `who` 的合法写法同样不再误报。
- 审计当前在完整维护基线上为 `documented-but-required=0`，
  `documented-but-unmodeled=1`（`num_buildings.category`；`unmodeled` 不计入漂移、
  不改退出码，留给人工确认是否补字段）。
- 规则改动落在 `submodules/cwtools-stellaris-config`，需要在该仓库提交后推进根仓库与
  `submodules/cwtools-mcp` 的子模块指针；`release/rules/stellaris-rules.zip` 由
  `package.ps1` 从该子模块重新打包（本次按同样流程刷新）。
- 新增回归测试 `tools/rules-sync/optional-fields.test.ts`（9 例）：可选标记的识别、
  `<...>` 屏蔽、变体隔离、漂移检出与消除、以及维护基线零漂移的守门断言。
- 审计依赖 `config/logs/*_docs.log`：`effect_docs.log` 目前未随包提供，
  缺失时按空结果跳过；一旦补入该文件，effects 侧会自动纳入同一审计。
