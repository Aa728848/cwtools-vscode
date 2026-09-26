# Agent Note: 静态星系连线的 ID 引号形式与标本规则误报修复

Status: implemented

## Problem

用户反馈两个互不相同的缺陷：

1. **静态星系预览/编辑器新增连线时丢失引号**：在 Preview / Editor 中右键新增
   Hyperlane 时，生成的声明写成裸整数形式
   （`add_hyperlane = { from = 3215 to = 2834 }`），而 vanilla
   `map/setup_scenarios/static_galaxy_example.txt` 中该语法一律使用带引号的 ID
   （`add_hyperlane = { from = "3215" to = "2834" }`）。
   `staticGalaxyEditBuilder` 的 `formatPdxScalar` 会把纯数字当作合法标量直接原样输出，
   路径同时影响 `buildHyperlaneEdit`、`buildAddLanesEdit` 与
   `buildSpraySystemsEdit`（后者写出 `system = { id = 6 ... }`）。

2. **Stellaris v4.5 标本（specimen）规则误报 CW242**：
   `submodules/cwtools-stellaris-config/config/common/specimens.cwt` 中
   `resources` 块内的 `category = <economic_category>` 没有声明 cardinality，
   而 CWT 默认 cardinality 是 `1..1`（见 `RulesTypes.fs` 的
   `Options.DefaultOptions` 与 `RulesParser.fs` 的
   `match commentSetting "cardinality" with | None -> 1, 1, true`），
   于是每个带 `resources` 块的标本都会报
   `Missing category, expecting at least 1`（CW242）。

   用 CWToolsCLI 对完整原版目录复核：修复前
   `common/specimens/specimens.txt` 产生 **64 条** CW242
   （全部为 `Missing category`）。对原版 3462 行的
   `common/specimens/specimens.txt` 做逐块结构分析：258 个标本中有 64 个带
   `resources` 块，其直接子键**只有** `produces`（共 65 个 `produces`，
   其中 `infernal_burning_gem` 有两个），**没有任何** `category` 字段。

## Decision

1. **连线与系统 ID 统一按 vanilla 引号形式写出**：
   在 `client/extension/staticGalaxyEditBuilder.ts` 中用 `formatPdxId` 取代
   `formatPdxScalar`，无条件给 ID 加引号并转义，应用于：
   - `buildHyperlaneEdit` 的新增 `add_hyperlane` 声明；
   - `buildAddLanesEdit` 的链式新增声明；
   - `buildSpraySystemsEdit` 的 `system = { id = ... }`。

   仅改「写出」而非「解析」：`staticGalaxyParser` 早已通过
   `pdxTokenizer` 的 `TokenType.String` 读取引号内容，因此重新解析得到的
   `fromId`/`toId`/`id` 仍是纯数字，端点匹配、去重与幂等重连行为不变。
   CWT 层面 `map.cwt` 把 `add_hyperlane.from/to` 与 `system.id` 都定义为 `int`，
   而 CWTools 的整型校验按 CWT 值比较、不区分引号形式，
   实测带引号与不带引号的场景均 0 诊断，故引号形式不影响校验。

2. **标本 `resources.category` 显式声明为可选**：
   在 `specimens.cwt` 的 `category` 上方补
   `## cardinality = 0..1`，与同文件其它可选字段
   （`icon`、`RARITY`、`is_tradable` 等）保持一致；
   `resources` 块本身继续保持 `0..inf`（原注释已说明 `0..1` 会导致误报）。

## Alternatives considered

1. **让 `formatPdxScalar` 对数字继续输出裸值，只在编辑器侧接受两种形式**：
   被否决。用户明确要求与 vanilla 一致；裸数字形式虽能被游戏与 CWT 接受，
   但会让模组作者的文件风格与官方示例文件产生无谓差异。
2. **把 ID 一律写成 `"..."` 之外再保留一个「原样输出」分支**：
   被否决。ID 在 `map.cwt` 中就是整数语义，统一加引号即可，
   多一个分支只会增加测试矩阵而不带来任何表达能力。
3. **在标本规则中删除 `category` 字段**：
   被否决。原版 `resources_template_optional` 等别名确实支持 `category`，
   且 `specimens.cwt` 是有意跟随 `common_economic_templates.cwt` 的
   `category + economic_template` 结构；`category` 是「可选」而不是「不存在」，
   删除会丢失对合法写法的校验与补全。
4. **把 `resources` 的 `0..inf` 改成 `0..1` 来绕过**：
   被否决。原注释指出 `0..1` 在这个块上会触发其它误报，且与本次根因无关。

## Consequences

- 预览器新增/链式连线写出的声明与 vanilla 风格一致；
  `from`/`to` 引号形式在重新解析后仍归一化为数字，端点匹配与「重连不产生重复声明」
  的既有契约不变（已由回归测试覆盖）。
- 原版标本文件不再产生 CW242；完整原版校验中该文件的诊断数由 **64 降为 0**
  （全库总数 4259 → 4195）。
- 规则修复落在 `submodules/cwtools-stellaris-config` 子模块内，
  需要在该仓库提交并推进根仓库与 `submodules/cwtools-mcp` 的子模块指针；
  `release/rules/stellaris-rules.zip` 由 `package.ps1` 从该子模块重新打包。
- 新增回归测试：
  `client/test/unit/staticGalaxyEditBuilder.test.ts`（引号写出 + 重新解析往返）、
  `client/test/unit/specimenCwtContract.test.ts`（category 可选性与 economic_template 委托）。
