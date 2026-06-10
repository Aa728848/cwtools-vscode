# CWTools Diagnostic Codes / 验证错误码说明

Reference for the `CWxxx` error codes reported by CWTools validation. Each
section heading is the error code, so diagnostics link here directly via the
error-code link in the Problems panel.

本页是 CWTools 验证错误码的速查表。问题面板中点击错误码即可跳转到对应小节。
每节包含:错误含义、常见原因和修复方法。

Severity legend / 严重度: **E** Error, **W** Warning, **I** Information, **H** Hint.

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

## CW275

**Loc key unexpected characters (W)** — the localisation key contains
characters that may not render correctly.

本地化键含有异常字符(如全角符号、不可见字符),可能无法正常显示。

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
