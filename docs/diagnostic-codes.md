# CWTools Diagnostic Codes / CWTools 诊断码

[Project Overview / 项目介绍](../README.md) | [Contribution Guide / 贡献指南](../CONTRIBUTING.md) | [Architecture / 架构文档](../ARCHITECTURE.md) | [CWT Rule Guide / CWT 规则指南](cwt-rule-config.md)

This is the reference for `CWxxx` validation codes and `CWFXxxx` Shader codes.
The code link in VS Code's Problems panel opens the matching section. If you
arrived here directly, use the page search to jump to a code.

本页收录 `CWxxx` 校验诊断和 `CWFXxxx` Shader 诊断。VS Code 问题面板中的
错误码链接会直接打开对应小节；如果从文档首页进入，可以用页面搜索查找编号。

Severity / 严重度：**E** Error，**W** Warning，**I** Information，**H** Hint。

Fix syntax and parse errors before investigating later semantic diagnostics in
the same file. Parser recovery can make follow-up messages incomplete.

同一文件中应先修复语法和解析错误，再处理后续语义诊断；解析恢复期间，后续消息
可能不完整。

---

## CW001

**Syntax / parse error (E)** — the file could not be parsed. Variants:
`CW001_MISSING_CLOSE_BRACE` (an opened `{` is never closed),
`CW001_UNMATCHED_CLOSE_BRACE` (a `}` has no matching `{`),
`CW001_RECOVERY_SKIPPED_BLOCK` / `CW001_STRUCTURAL_RECOVERY` (the parser
skipped broken top-level blocks; other diagnostics may be incomplete until fixed).

语法/解析错误:文件无法解析。常见为花括号不配对(漏写或多写 `{`/`}`)。
出现此错误时,本文件其余规则报错可能不完整或失真——**永远先修语法错误**。

## CW002

**Mixed block (E)** — a block contains both `key = value` pairs and bare
values, usually a missing `=` on one line.

块内同时混有 `键 = 值` 和裸值,通常是某行漏写了等号 `=`。

## CW100

**Missing localisation (W)** — a referenced localisation key is not defined
for the listed language. Add the key to the corresponding `.yml` file under
`localisation/`.

引用的本地化键在该语言下未定义。在 `localisation/` 对应语言的 `.yml` 文件中补上该键。

## CW101

**Undefined variable (E)** — the referenced variable is never defined.

引用的变量从未被定义。检查拼写,或先用 `set_variable` 等方式定义它。

## CW102

**Unknown trigger (E)** — the name is not a known trigger in this context.
Check spelling; it may be an effect misplaced in a trigger block, a scripted
trigger that isn't loaded, or content from a missing DLC/dependency mod.

未知触发条件(trigger)。检查拼写;也可能是把效果(effect)写进了触发块,
或者它是未加载的 scripted_trigger / 缺失前置模组提供的内容。

## CW103

**Unknown effect (E)** — the name is not a known effect in this context.
Check spelling; it may be a trigger misplaced in an effect block, a scripted
effect that isn't loaded, or content from a missing DLC/dependency mod.

未知效果(effect)。检查拼写;也可能是把触发条件写进了效果块,
或者它是未加载的 scripted_effect / 缺失前置模组提供的内容。

## CW104

**Trigger in wrong scope (E)** — the trigger exists but is not valid in the
current scope. Use a scope change (`owner`, `from`, `prev`, `any_*` ...) to
reach the expected scope, or move the line into the right block.

触发条件用在了错误的作用域。用作用域切换(`owner`、`from`、`prev`、`any_*` 等)
进入报错中给出的预期作用域,或把这一行移到正确的块里。

## CW105

**Effect in wrong scope (E)** — same as CW104 but for effects (use
`every_*` / `random_*` and scope transitions to reach the expected scope).

效果用在了错误的作用域,处理方式同 CW104(常用 `every_*`、`random_*` 进入目标作用域)。

## CW106

**Scope command in wrong scope (E)** — the scope-change command itself is not
valid from the current scope.

作用域切换命令本身不能从当前作用域使用。

## CW107

**Event runs every tick (I)** — the event has no trigger limiter and is
evaluated constantly, which hurts performance. Add `is_triggered_only = yes`,
`fire_only_once = yes`, or `mean_time_to_happen`.

事件没有触发限制,每个 tick 都会被评估,影响性能。
加上 `is_triggered_only = yes`、`fire_only_once = yes` 或 `mean_time_to_happen`。

## CW108

**research_leader missing area (E)** — the `research_leader` trigger requires
an `area` field.

`research_leader` 缺少必填的 `area` 字段。

## CW109

**research_leader area mismatch (I)** — the `research_leader` area differs
from the technology's area.

`research_leader` 的 `area` 与科技本身的 `area` 不一致。

## CW110

**Technology missing category (E)** — the technology has no `category`.

科技缺少 `category` 字段。

## CW111

**Button effect not found (E)** — the GUI button references an effect that is
not defined.

界面按钮引用的效果未定义。

## CW112

**Sprite not found (E)** — the `GFX_` sprite is not defined. Define it in a
`spriteTypes` block in an `interface/*.gfx` file, or fix the name.

图标(sprite)未定义。在 `interface/*.gfx` 的 `spriteTypes` 块中定义,或修正 `GFX_` 名称拼写。

## CW113

**File not found (E)** — the referenced file path does not exist. Paths are
case sensitive.

引用的文件不存在。注意路径**大小写敏感**,检查目录、文件名和扩展名是否完全一致。

## CW114

**Unknown static modifier (E)** — the static modifier is not defined in
`common/static_modifiers`.

未知静态修正:未在 `common/static_modifiers` 中定义。

## CW115

**Static modifier scope (W)** — the static modifier is possibly used in the
wrong scope (experimental check).

静态修正可能用在了错误的作用域(实验性检查)。

## CW116

**Scope command as leaf (E)** — a scope command was used as `scope = value`;
the message suggests the intended block form (`did you mean ...`).

作用域命令被写成了 `作用域 = 值` 的形式,按报错给出的 `did you mean` 提示改为块形式。

## CW117

**Variable never defined (E)** — the script variable (`@var`) is never defined.

脚本变量(`@var`)从未定义。在文件顶部定义它,或检查拼写。

## CW118

**Unknown modifier (E)** — the modifier is not recognized (experimental check).

未知修正(实验性检查)。检查拼写或确认对应修正类型存在。

## CW119

**Modifier in wrong scope (E)** — the modifier is not valid in the current
scope (experimental check).

修正用在了错误的作用域(实验性检查)。

## CW120

**Possible pretrigger (I)** — this trigger could be moved to the pretrigger
block for better performance.

该触发条件可以移到 pretrigger(预触发)以提升性能,可用代码操作自动修复。

## CW121

**Empty if (W)** — the `if` block contains no effects.

这个 `if` 块没有任何效果内容,是空的;补充内容或删除它。

## CW122

**Quoted inline loc key (I)** — localisation keys should not be quoted when
used inline.

内联使用本地化键时不要加引号,否则可能出现意外行为。

## CW220

**Event target never saved (E)** — the event (or events it calls) uses an
`event_target:` that is not saved by any event leading here. Save it with
`save_event_target_as` first.

事件链中使用的 `event_target:` 从未被保存。先用 `save_event_target_as` 保存,
并确保所有能到达此处的事件路径都设置了它。

## CW221

**Event target may not be saved (W)** — like CW220, but the target is only
set on some paths leading to this event.

同 CW220,但目标只在部分事件路径上被设置——存在未设置就使用的可能。

## CW222

**Event id not defined (W)** — the referenced event id does not exist. Check
the namespace and number, and that the event file is loaded.

引用的事件 ID 不存在。检查 `namespace` 与编号,确认事件文件在 `events/` 目录且已加载。

## CW223

**NOT with multiple children (I)** — `NOT` with several conditions is
ambiguous; use `NOR` (none may be true) or `NAND` (not all true).

`NOT` 带多个子条件有歧义:想"全部为假"用 `NOR`,想"并非全部为真"用 `NAND`。

## CW224

**Redundant boolean operator (I)** — the logic operator wraps a single child
and can be removed.

这个逻辑运算符是多余的(只包了一个子条件),可以直接去掉。

## CW225

**Loc reference doesn't exist (I)** — the localisation string references
(`$KEY$`) another key that doesn't exist in that language.

本地化文本中 `$KEY$` 引用的键在该语言中不存在。

## CW226

**Invalid loc command (I)** — the localisation string uses a `[Command]` that
doesn't exist.

本地化文本中使用的 `[命令]` 不存在,检查拼写。

## CW227

**Section template not found (E)** — the ship section template is not defined.

舰船区段模板未定义。

## CW228

**Section slot not found (E)** — the section template has no slot with this name.

区段模板上不存在该名称的插槽。

## CW229

**Component template not found (E)** — the component template is not defined.

组件模板未定义。

## CW230

**Component/slot size mismatch (W)** — the component size does not match the
slot size.

组件尺寸与插槽尺寸不匹配。

## CW231

**Unused technology (W)** — the technology is not referenced anywhere.

该科技没有被任何地方引用。

## CW232

**Mesh not defined (E)** — the referenced PDX mesh does not exist.

引用的模型网格(mesh)未定义,检查 `.gfx` 中的 entity/mesh 定义。

## CW233

**Entity not defined (E)** — the referenced entity (or its culture fallback)
does not exist in the `.asset` files.

引用的实体(entity)在 `.asset` 文件中未定义(或对应 culture 的回退也不存在)。

## CW234

**Placeholder localisation (I)** — the localisation key still has the
REPLACE_ME placeholder for this language.

该本地化键在此语言中还是占位符(REPLACE_ME),记得填入正式文本。

## CW235

**Modifier value 0 (W)** — modifiers are additive, so a value of 0 does nothing.

修正值为 0:修正是加法叠加的,写 0 没有任何效果。

## CW236

**Deprecated nested if/else (W)** — nested if/else in effects was deprecated
in Stellaris 2.1; use `else_if`.

效果中嵌套 if/else 的旧写法已废弃(2.1 起),改用 `else_if`。

## CW237

**Ambiguous if/else (I)** — 2.1 changed nested `if = { if else }` behaviour;
verify this still works as intended.

2.1 改变了嵌套 `if = { if else }` 的行为,确认这段逻辑仍符合预期。

## CW238

**else without if (E)** — an `else`/`else_if` has no preceding `if`.

`else`/`else_if` 前面缺少对应的 `if`。

## CW239

**Unused definition (W)** — the definition is expected to be referenced
somewhere but is not used.

该定义应当被引用但没有任何地方使用它。

## CW240

**Unexpected value (rule check)** — the value doesn't match the CWT rule:
wrong type (`Expecting an integer/float/yes or no/date, got ...`), out of
range (`Expecting a value between ...`), wrong enum (`Expecting a "..."
value, e.g. ...`), or an undefined reference (`Expected value of type ...,
got '...'`). When a similarly-named definition exists, the message appends
`(did you mean '...'?)`.

值不符合规则:类型错误(需要整数/小数/yes或no/日期)、超出取值范围、
不在枚举列表中,或引用了不存在的定义(`Expected value of type X` 表示
此处需要一个已定义的 X,检查拼写或先创建该定义)。
如果存在相近名称,报错会附带 `did you mean '...'?` 建议,通常直接采纳即可。

## CW241

**Unexpected property (rule check)** — the key is not valid here per the CWT
rules; usually a typo or a field placed in the wrong block.

该键不应出现在这里:通常是键名拼写错误,或字段放错了块。对照 vanilla 同类定义检查。

## CW242

**Wrong number of fields (rule check)** — `Missing X, expecting at least N`
means a required field is absent; `Too many X, expecting at most N` means a
field appears too often.

字段数量不符:`Missing X` 表示缺少必填字段;`Too many X` 表示字段重复次数超限,删除多余项。

## CW243

**Target wrong scope (E)** — the referenced target exists but is in the wrong
scope for this usage.

引用的目标存在,但其作用域与此处要求不符。

## CW244

**Invalid target (E)** — the value is not a valid scope target here.

该值不是有效的作用域目标(需要事件目标、变量或作用域链接)。

## CW245

**Error in target link (E)** — a link inside the target chain was used from
the wrong scope.

目标链中的某个作用域链接不能从当前作用域使用。

## CW246

**Variable not set (I)** — the variable is read but never set; it evaluates
as 0 at runtime.

变量从未被 `set_variable` 设置,运行时按 0 处理。

## CW247

**Trigger/effect/modifier wrong scope (E)** — per the CWT rules, this name is
not valid in the current scope.

按规则,该触发/效果/修正不能用于当前作用域,用作用域切换进入预期作用域。

## CW248

**Invalid scope command (E)** — the scope-change command is not recognized.

无效的作用域命令。

## CW249

**Expecting variable or number (I)** — the value must be a variable or a number.

此处需要变量或数字。

## CW250

**Planet killer fields missing (E)** — a planet-killer weapon is missing
required supporting definitions.

行星毁灭武器缺少必需的配套定义(见报错原文)。

## CW251

**Unnecessary boolean operator (W)** — `AND`/`OR` wrapping a single condition
can be removed.

`AND`/`OR` 只包了一个条件,是多余的,可以去掉。

## CW252

**Retired (H)** — this check no longer exists; the diagnostic can be ignored.

已退役的检查项,可忽略。

## CW253

**Deprecated set_name variant (I)** — use `set_name` for consistency.

建议统一使用 `set_name`。

## CW254

**Wrong localisation encoding (E)** — localisation `.yml` files must be
UTF-8 with BOM. Use VS Code's "Save with Encoding → UTF-8 with BOM".

本地化文件必须是 **UTF-8 with BOM** 编码。用 VS Code 状态栏编码菜单
"通过编码保存 → UTF-8 with BOM" 重新保存。

## CW255

**Loc file name missing language (E)** — the file name must contain (ideally
end with) `l_<language>.yml`, e.g. `my_mod_l_english.yml`.

本地化文件名需要包含语言后缀,例如 `my_mod_l_english.yml`、`my_mod_l_simp_chinese.yml`。

## CW256

**Loc file missing language header (E)** — the first line must be the
language header, e.g. `l_english:`.

本地化文件第一行必须是语言头,例如 `l_english:` 或 `l_simp_chinese:`。

## CW257

**Loc file language mismatch (E)** — the language in the file name differs
from the header language.

文件名里的语言与文件头声明的语言不一致,两者必须相同。

## CW258

**Loc file name position (I)** — the file name should end with
`l_<language>.yml`.

建议本地化文件名以 `l_<语言>.yml` 结尾。

## CW259

**Recursive loc reference (E)** — the localisation string references itself.

本地化文本引用了它自己,会造成无限递归。

## CW260

**Loc command wrong scope (E)** — the `[Command]` in the localisation string
is used from the wrong scope.

本地化文本中的 `[命令]` 作用域错误。

## CW261

**Duplicate definition (E)** — the key is defined multiple times for a type
that does not allow overrides. Search the workspace for the other definition
and remove or rename one.

同名定义重复,且该类型不允许覆盖。全局搜索该名称,删除或重命名其中一份。
注意不同目录的覆盖规则不同(FIOS/LIOS/DUPL)。

## CW262

**Unexpected property — node (rule check)** — see CW241; this variant is
reported on a block. When a similarly-named key is valid here, the message
appends `(did you mean '...'?)`.

同 CW241(报在块上):该块不应出现在这里,检查键名拼写与所属块。
如果存在相近的合法键名,报错会附带 `did you mean '...'?` 建议。

## CW263

**Unexpected property — leaf (rule check)** — see CW241; this variant is
reported on a `key = value` line. When a similarly-named key is valid here,
the message appends `(did you mean '...'?)`.

同 CW241(报在 `键 = 值` 行上)。如果存在相近的合法键名,
报错会附带 `did you mean '...'?` 建议。

## CW264

**Unexpected property — leaf value (rule check)** — see CW241; this variant
is reported on a bare value.

同 CW241(报在裸值上)。

## CW265

**Unexpected property — value clause (rule check)** — see CW241; this
variant is reported on a value block.

同 CW241(报在值块上)。

## CW266

**Loc command not in data type (E/W)** — the `[Command]` does not exist on
the data type at that position in the chain.

本地化命令链中,该 `[命令]` 在对应数据类型上不存在。

## CW267

**Unexpected alias value (rule check)** — the value does not match the alias
key's expectation.

值不符合别名键的要求(见报错原文中的期望值)。

## CW268

**Loc text missing quotes (W)** — the localisation text should start and end
with double quotes: `key:0 "text"`.

本地化文本需要用英文双引号包裹:`key:0 "文本"`。

## CW269

**Optimisation hint (H)** — the trigger list can be merged into the suggested
form for better performance.

性能优化建议:可按提示合并触发条件列表。

## CW270

**Too many decimal places (W)** — only 3 decimal places are supported here.

数值精度过高,此处最多支持 3 位小数。

## CW271

**Integer expected (W)** — the value must be an integer.

此处需要整数。

## CW272

**Rule-defined custom error** — a custom error message defined by the CWT
rules; follow the message text.

由 CWT 规则自定义的错误,按报错原文处理。

## CW273

**Modifier type not defined (W)** — the modifier's type is used but not defined.

修正类型未定义但被使用。

## CW274

**inline_script error (E/W)** — expanding this `inline_script` produces an
error. Check the related-information entries for the real location inside the
script file.

`inline_script` 展开后产生错误。查看诊断的"相关信息"定位脚本文件内部的实际出错位置。

## CW274D

**Definition causes call-site error (I)** — this scripted definition
(`scripted_trigger` / `scripted_effect` / script value / `inline_script`)
expands cleanly on its own, but produces an error when expanded at a call site.
This informational hint is placed on the definition; see the related-information
entry for the call site, and `CW274` for the error reported there.

该脚本定义(`scripted_trigger` / `scripted_effect` / 脚本值 / `inline_script`)
本身没有问题,但在某个调用点展开后会报错。此提示标在定义处,
查看诊断的"相关信息"定位出错的调用点,实际错误见 `CW274`。

## CW275

**Loc key unexpected characters (W)** — the localisation key contains
characters that may not render correctly.

本地化键含有异常字符(如全角符号、不可见字符),可能无法正常显示。

## CW276

**Unknown type key (rule check)** — the CWT rules reference a type key that is
not defined. Follow the message text; this is usually a CWT rules file problem
rather than your script.

CWT 规则引用了未定义的类型键(type key)。按报错原文处理,
通常是 CWT 规则文件的问题而非脚本本身。

## CW277

**Obsolete type key (rule check)** — the referenced type key is obsolete and
should no longer be used. Follow the message text for the replacement.

引用的类型键(type key)已过时,不应再使用。按报错原文中的提示改用新写法。

---

# Shader diagnostics (CWFX) / Shader 诊断

`CWFX` codes are reported by the PDX shader (`.shader` / `.fxh`) language
features. Lossless-front-end failures (`CWFX101`–`CWFX104`) default to
**Error**; reference, Include, stage, and binding findings default to
**Warning**.

`CWFX` 错误码由 PDX Shader(`.shader` / `.fxh`)语言功能报告。
无损前端失败(`CWFX101`–`CWFX104`)默认严重度为 **Error**；引用、Include、
阶段和资源绑定类诊断默认严重度为 **Warning**。

## CWFX001

**Undefined MainCode reference (W)** — an `Effect` references a `VertexShader`
or `PixelShader` MainCode that is not defined in the effect's compile unit
(the root `.shader` file plus its transitive `Includes`). Check the MainCode
name, or add the file that defines it to `Includes`.

Effect 引用了未定义的 `VertexShader` / `PixelShader` MainCode(解析范围是当前
编译单元:根 `.shader` 文件及其 `Includes` 传递闭包)。检查名称拼写,
或把定义该 MainCode 的文件加入 `Includes`。

Note: vanilla Stellaris 4.4.6 ships a few such references
(`PixelLineLegacy`, `VertexPdxMeshShieldHitEffectSkinned`) that resolve to
nothing on disk — they are engine-provided or legacy entry points, recorded as
pending-classification compatibility samples. Do not auto-fix them.

注意:原版 Stellaris 4.4.6 中存在少量此类引用(`PixelLineLegacy`、
`VertexPdxMeshShieldHitEffectSkinned`),在磁盘上没有对应定义,可能是引擎内置
或遗留入口,已记录为待分类兼容样本。**不要**对它们应用自动修复。

## CWFX002

**Undefined ConstantBuffer reference (W)** — a MainCode references a
`ConstantBuffer` that is not defined in the current compile unit.

MainCode 引用了当前编译单元中未定义的 `ConstantBuffer`。

## CWFX003

**Undefined render state reference (W)** — an `Effect` references a
`BlendState`, `DepthStencilState`, or `RasterizerState` that is not defined in
the current compile unit.

Effect 引用了当前编译单元中未定义的渲染状态
(`BlendState` / `DepthStencilState` / `RasterizerState`)。

## CWFX004

**Include problem (W)** — an `Includes` entry cannot be resolved: the file is
not loaded (missing), matches more than one file (ambiguous, never silently
resolved), forms an include cycle, or exceeds the hard depth/member analysis
budget. Budget exhaustion returns a bounded partial compile unit and is never
treated as successful complete analysis.

`Includes` 条目无法解析:文件未加载(缺失)、匹配到多个文件(歧义,绝不静默
任选其一)、构成 include 循环，或超过深度/成员硬预算。预算耗尽时返回有界
partial 编译单元，绝不会伪装成完整分析成功。

## CWFX101

**Unterminated Shader string (E)** — the outer FX DSL or HLSL token stream
reached end-of-file before a quoted string closed. The parser preserves the
remaining source for recovery, but semantic edits are blocked until the quote
is repaired. No automatic fix is offered because the intended closing point is
ambiguous.

**Shader 字符串未闭合 (E)** — 外层 FX DSL 或 HLSL token 流在引号闭合前到达
文件末尾。parser 会保留剩余源码用于恢复，但修复引号前会阻止语义编辑；由于
无法证明正确的闭合位置，不提供自动修复。

## CWFX102

**Unterminated comment or preprocessor condition (E)** — a block comment or
one or more `#if/#ifdef/#ifndef` frames are not closed. The diagnostic is
variant-sensitive. Close the comment or add the matching `#endif`; automatic
Agent edits require an unambiguous matching opener.

**注释或预处理条件未闭合 (E)** — 块注释或一个以上
`#if/#ifdef/#ifndef` frame 未闭合。该诊断区分条件变体；请闭合注释或补充匹配
的 `#endif`，Agent 只有在 opener 唯一明确时才允许自动修改。

## CWFX103

**Unterminated block/HLSL region or unmatched conditional directive (E)** —
an FX/HLSL delimiter is missing, or `#elif`, `#else`, or `#endif` has no active
matching conditional. Repair the delimiter/directive structure before relying
on symbols after this point. No broad brace-insertion quick fix is allowed.

**块/HLSL 区域未闭合或条件指令不匹配 (E)** — FX/HLSL delimiter 缺失，或
`#elif`、`#else`、`#endif` 没有活动的匹配条件。依赖后续符号前必须先修复
delimiter/指令结构；禁止提供大范围自动补括号 quick fix。

## CWFX104

**Malformed declaration/delimiter/macro name (E)** — a declaration or macro
is missing its required name, or a closing delimiter appears without a matching
opener. This is a local syntax failure; fixes may only replace an explicitly
selected malformed token and must not guess an engine identifier.

**声明、delimiter 或宏名称格式错误 (E)** — 声明/宏缺少必需名称，或 closing
delimiter 没有匹配 opener。该错误属于局部语法失败；修复只能替换明确选中的
错误 token，不得猜测引擎标识符。

## CWFX402

**Stage-restricted intrinsic used from a vertex entry (W)** — a pixel-stage
intrinsic such as `ddx`, `ddy`, `fwidth`, or `clip` is reachable in a vertex
MainCode region. The finding is stage- and variant-specific. Move the operation
to a pixel path or replace it manually; no automatic semantic rewrite is safe.

**Vertex 入口使用阶段受限 intrinsic (W)** — `ddx`、`ddy`、`fwidth`、`clip`
等 pixel-stage intrinsic 出现在 vertex MainCode 可达路径。该诊断区分 stage 与
variant；请移动到 pixel 路径或人工替换，不允许自动语义改写。

## CWFX403

**Potential resource-register collision (W)** — two declarations can be active
in the same platform variant and use the same register class/index. Declarations
whose presence conditions are mutually exclusive do not conflict. Renumbering
is never automatic because engine and renderer bindings may be ABI-sensitive.

**潜在资源寄存器冲突 (W)** — 两个声明可在同一平台变体生效，并使用相同
register class/index；presence condition 互斥的声明不冲突。由于引擎与 renderer
绑定可能属于 ABI，绝不自动改寄存器编号。

## Target taxonomy for new codes / 新错误码的目标分组

The current CWFX001–CWFX004 mapping is frozen for compatibility. **New**
shader diagnostics are grouped by range (this is the target taxonomy; the
ranges below are not all in use yet):

现有 CWFX001–CWFX004 映射为兼容性而冻结。**新增** Shader 诊断按号段分组
(下表为目标分组策略,并非所有号段都已启用):

| Range / 号段 | Category / 类别 | Examples / 示例 |
| --- | --- | --- |
| `CWFX1xx` | Lexer / syntax / preprocessor 词法/语法/预处理 | unclosed `[[`, illegal directive, macro recursion, unsatisfiable branch |
| `CWFX2xx` | Project / include / override 项目/Include/覆盖 | missing include, ambiguity, cycle, casing, overridden source |
| `CWFX3xx` | Name / type / HLSL 名称/类型 | undefined symbol, duplicate declaration, ambiguous overload, type/member errors |
| `CWFX4xx` | Effect / stage / render state Effect/阶段/渲染状态 | MainCode stage mismatch, invisible state, incompatible interface semantic |
| `CWFX5xx` | Runtime / ABI / reachability 运行时/ABI/可达性 | unreachable new effect, dangerous rename, stale ABI version |
| `CWFX9xx` | Analysis limits 分析限制 | unknown engine symbol, unsupported conditional expression, analysis budget exceeded |

Rules / 规则:

- A published code never changes meaning without notice; retiring a code beats
  redefining it.
- Each diagnostic definition must declare: default severity, suppressible
  scope, whether it is variant-specific, whether a quick fix is allowed, the
  agent auto-edit policy, a doc link, and a test fixture.
- The vanilla baseline does not require zero diagnostics; it requires zero
  unclassified errors and zero new unknown warnings. Known compatibility
  warnings enter the versioned baseline with a reason and are re-audited after
  upgrades.
- Unknown-state classifications such as `engine_or_unreferenced` are
  informational only and must never receive delete quick-fixes.

- 已发布的错误码不得无说明改变含义;弃用一个码优于重新定义它。
- 每个诊断定义必须包含:默认严重度、可抑制范围、是否区分 variant、
  是否允许 quick fix、Agent 自动修改政策、文档链接和测试 fixture。
- Vanilla 基线不要求"零诊断",而要求"零未分类 error、零新增未知 warning"。
  已知兼容告警带版本和原因进入基线,升级后必须重新审计。
- `engine_or_unreferenced` 一类的未知状态分类仅为提示信息,
  永远不得提供删除类 quick fix。

## CW998

**Rules error** — an error raised by the CWT rules engine; follow the message
text.

CWT 规则引擎报告的错误,按报错原文处理。

## CW999

**Custom error** — a generic validation error; follow the message text.
Common forms include `Expecting a defined parts list of ...` and
`Unknown type referenced ...` (usually a CWT rules problem rather than your
script).

通用验证错误,按报错原文处理。常见形式如 `Unknown type referenced X`
通常是 CWT 规则文件的问题而非脚本本身。

---

## CWT001

**CWT syntax / parse error (E)** — a `.cwt` rule file could not be parsed.
Variants mirror the script codes: `CWT001_MISSING_CLOSE_BRACE`,
`CWT001_UNMATCHED_CLOSE_BRACE`, `CWT001_RECOVERY_SKIPPED_BLOCK` /
`CWT001_STRUCTURAL_RECOVERY`. Fix the syntax error first; parser recovery can
make follow-up diagnostics incomplete.

CWT 规则文件语法/解析错误。变体与脚本诊断对应:
`CWT001_MISSING_CLOSE_BRACE`(漏写 `}`)、`CWT001_UNMATCHED_CLOSE_BRACE`(多写 `}`)、
`CWT001_RECOVERY_SKIPPED_BLOCK` / `CWT001_STRUCTURAL_RECOVERY`(解析恢复跳过损坏的
顶层块)。先修复语法错误;恢复期间其余诊断可能不完整。

## CWT101

**Unknown CWT directive (W)** — a `## name = value` comment whose name is not
a known rule option. Free-form prose comments (e.g. `##Checks if ...`) are not
flagged; only the structured `name = value` form is validated.

未知的 CWT 指令(`## name = value` 形式)。自由文本注释(如 `##Checks if ...`)
不会被标记;只校验结构化的 `名称 = 值` 形式。

## CWT102

**Illegal directive value (E)** — a known directive carries an invalid value,
e.g. `## cardinality = banana` (bounds must be numbers or `inf`) or an illegal
`## severity`. Variant `CWT104` fires when a no-value option (like `## required`)
receives a value, or a value-requiring option is bare.

已知指令携带非法值,如 `## cardinality = banana`(边界必须是数字或 `inf`)或
非法的 `## severity`。变体 `CWT104` 在无值选项(如 `## required`)被赋值或
需要值的选项缺少值时触发。

## CWT110 / CWT111 / CWT112

**Invalid declaration inside a root block (W)** — `types` may only contain
`type[...]` declarations (`CWT110`), `enums` only `enum[...]` /
`complex_enum[...]` (`CWT111`), `values` only `value[...]` (`CWT112`).

根块内的非法声明:`types` 只允许 `type[...]`(`CWT110`)、`enums` 只允许
`enum[...]`/`complex_enum[...]`(`CWT111`)、`values` 只允许 `value[...]`(`CWT112`)。

## CWT113

**Empty declaration name (E)** — a declaration like `type[]` has no name.

声明名称为空,如 `type[]`。

## CWT200

**Unknown field expression (W)** — a token that looks like a field expression
(bracketed form, `$...`, `<...>`) is not a known expression family.

形似字段表达式(方括号形式、`$...`、`<...>`)但不在已知表达式族中。

## CWT201

**Malformed field expression (E)** — a known expression family has invalid
arguments, e.g. `int[0..banana]` (bounds must be numbers or `inf`).

已知表达式族的参数非法,如 `int[0..banana]`(边界必须是数字或 `inf`)。

## CWT301

**Undefined reference (W)** — a field expression references a symbol that the
project never defines (`enum[x]`, `scope[x]`, `scope_group[x]`, `<type>`,
`<type.subtype>`). Only reported for symbol kinds the project itself defines,
so built-in game-side symbols (scripted enums, flag value sets, external
types) stay silent; the report appears only after the project index is ready.

字段表达式引用了项目从未定义的符号(`enum[x]`、`scope[x]`、`scope_group[x]`、
`<type>`、`<type.subtype>`)。只对项目自身定义过的符号类别报告,因此游戏侧
内置符号(脚本化 enum、flag value set、外部类型)保持静默;且只在项目索引
就绪后发布。

## CWT302

**Duplicate type declaration (E)** — the same `type[x]` is declared twice in
one file. Duplicate enums, aliases and subtypes are legitimate multi-rule
patterns in CWT and are not reported; cross-file type overrides are a modding
pattern and are not reported either.

同一文件内重复声明 `type[x]`。CWT 中重复的 enum/alias/subtype 是合法的多规则
写法,不报告;跨文件 type 覆盖是 mod 常规做法,同样不报告。

## CWT401

**Inject cycle (E)** — `## inject` chains form a loop (`a.cwt` injects
`b.cwt`, which injects `a.cwt`). Fix one of the inject targets.

`## inject` 链形成循环(`a.cwt` 注入 `b.cwt`,`b.cwt` 又注入 `a.cwt`)。
修复其中一个注入目标。

## CWT900

**Candidate rules rejected (I)** — the edited rule files cannot produce a
usable rules model (parse failure or blocking diagnostic), so the active game
rules are kept (last-known-good). Fix the reported `CWT0xx`/`CWT1xx`/`CWT2xx`
diagnostics to retry; activation is automatic on the next valid candidate.

编辑中的规则文件无法生成可用的规则模型(解析失败或存在阻止诊断),因此
保留当前生效的游戏规则(last-known-good)。修复报告的 `CWT0xx`/`CWT1xx`/
`CWT2xx` 诊断后自动重试激活。

## CWT901

**Rule activation failed (E)** — the validated candidate could not be swapped
into the game model (an exception during the hot swap). The previous rules
remain active; the message carries the rules generation and the failure
reason. Retry happens automatically on the next candidate rebuild.

已验证的候选规则无法热替换进游戏模型(热替换过程抛出异常)。之前的规则
保持生效;消息包含规则 generation 与失败原因。下一次候选重建会自动重试。

## Reserved CWT ranges / CWT 预留码段

The CWT document pipeline reserves the following ranges. Codes are published
here before release and stay stable (handoff doc
[`cwt-language-support-handoff.md`](cwt-language-support-handoff.md) §6.1).

CWT 文档管线预留以下码段,发布前写入本文并保持稳定:

| Range / 码段 | Purpose / 用途 | Examples / 示例 |
| --- | --- | --- |
| `CWT001`–`CWT099` | Parser / structure recovery / 解析与结构恢复 | `CWT001`(已发布) |
| `CWT100`–`CWT199` | Root blocks and directives / 根块与指令 | unknown root block, illegal `## cardinality` |
| `CWT200`–`CWT299` | Field expressions / 字段表达式 | unknown expression, illegal argument range |
| `CWT300`–`CWT399` | Project symbols and references / 项目符号与引用 | undefined enum/type/alias, duplicate definition |
| `CWT400`–`CWT499` | Cross-file consistency / 跨文件一致性 | inject cycle, scope inheritance cycle |
| `CWT900`–`CWT999` | Activation and degradation / 激活与降级 | candidate rules rejected, last-known-good retained |
