/**
 * Client-side diagnostic localization: replaces CWTools validation messages
 * with a Chinese translation + fix advice when the VS Code display language is
 * Chinese (appends an English 💡 advice line otherwise), and normalizes the
 * `source` field so the Problems panel shows "CWTools(CW102)" instead of
 * "CW102(CW102)".
 *
 * The F# server hardcodes English diagnostic text (CWTools Validation.fs), so
 * translation happens here, keyed by message shape + CW error code. The
 * ignore-list matching in extension.ts runs against the original server
 * message BEFORE this enrichment; symbols stay quoted inside the Chinese text
 * so the ignore-manager's quoted-key extraction keeps working.
 *
 * This module is intentionally free of any `vscode` import so it can be unit
 * tested directly.
 */

export const HINT_PREFIX = '\n💡 ';

/** Structural subset of vscode.Diagnostic that this module reads/writes. */
export interface EnrichableDiagnostic {
    message: string;
    source?: string;
    code?: string | number | { value: string | number; target?: unknown };
}

interface DiagnosticRule {
    /** Optional CW code allowlist; checked only when the diagnostic carries a code. */
    codes?: string[];
    pattern: RegExp;
    /** Chinese translation + advice. */
    zh: (m: RegExpExecArray) => string;
    /** Optional English advice (only where it adds something beyond the message). */
    en?: (m: RegExpExecArray) => string;
}

// Ordered: more specific patterns must come before generic ones.
const RULES: DiagnosticRule[] = [
    // ---- CWT rule-file editing (CWT0xx-CWT9xx) ----
    {
        codes: ['CWT900'],
        pattern: /^Candidate rules rejected \((.*)\); the previous rules remain active\./,
        zh: m => `候选规则因 ${m[1]} 被拒绝；继续使用上一份有效规则。修复已报告的错误后会自动重试。`,
        en: () => 'Fix the reported CWT errors; the last-known-good rules remain active until the next valid snapshot.',
    },
    {
        codes: ['CWT901'],
        pattern: /^CWT rules activation failed \(generation (\d+)\): (.*); the previous rules remain active\./,
        zh: m => `CWT 规则激活失败（generation ${m[1]}）：${m[2]}；继续使用上一份有效规则。修复问题后重新保存规则以重试。`,
        en: () => 'The validated swap failed; the last-known-good rules remain active. Save after fixing the reported cause to retry.',
    },
    {
        codes: ['CWT102'],
        pattern: /^Illegal value '(.*)' for directive '## (.*)'\.$/,
        zh: m => `指令 '## ${m[2]}' 的值 '${m[1]}' 非法。例如 ## cardinality 需要 "N..M" 或 "N..inf" 形式的边界。`,
        en: () => 'Check the directive value shape: cardinality bounds must be numbers or inf.',
    },
    {
        codes: ['CWT101'],
        pattern: /^Unknown CWT directive '## (.*)'\./,
        zh: m => `未知的 CWT 指令 '## ${m[1]}'。已知指令列表见规则指南。`,
        en: () => 'The directive name is not a known CWT rule option; see the rule guide for the list.',
    },
    {
        codes: ['CWT201'],
        pattern: /^Malformed '(.*)' field expression: '(.*)'\.$/,
        zh: m => `字段表达式 '${m[2]}' 格式错误:参数不合法(如 int[0..banana] 的边界必须是数字或 inf)。`,
        en: () => 'Fix the field expression arguments; numeric bounds must be numbers or inf.',
    },
    {
        codes: ['CWT200'],
        pattern: /^Unknown field expression '(.*)'\.$/,
        zh: m => `未知的字段表达式 '${m[1]}'。检查拼写,或参考规则指南中的字段表达式清单。`,
        en: () => 'Unknown field expression; check the spelling against the expression reference.',
    },
    {
        codes: ['CWT301'],
        pattern: /^Reference to undefined symbol '(.*)'\./,
        zh: m => `引用了未定义的符号 '${m[1]}'。在规则文件中定义它,或检查拼写。`,
        en: () => 'Define the referenced symbol in a rule file, or check the spelling.',
    },
    {
        codes: ['CWT302'],
        pattern: /^Type '(.*)' is declared more than once/,
        zh: m => `类型 '${m[1]}' 在本文件中声明了多次;后面的声明会覆盖前面的。`,
        en: () => 'Remove the duplicate type declaration in this file.',
    },
    {
        codes: ['CWT401'],
        pattern: /^## inject forms a cycle through '(.*)'\./,
        zh: m => `## inject 通过 '${m[1]}' 形成循环。删除其中一个注入以打破循环。`,
        en: () => 'Break the inject cycle by removing one of the inject targets.',
    },
    // ---- Stellaris custom validators (CW999) ----
    {
        codes: ['CW999'],
        pattern: /^In scripted_action, user_scope must be the first entry and scope must be the second entry$/,
        zh: () => '在 scripted_action 中，第一项必须是 user_scope，第二项必须是 scope。',
        en: () => 'Move user_scope to the first entry and scope to the second entry in the same scripted_action block.',
    },

    // ---- Syntax / structure (CW001*, CW002) ----
    {
        pattern: /^Missing '\}' for '\{' opened at line (\d+) col (\d+)/,
        zh: m => `缺少右花括号 "}":第 ${m[1]} 行第 ${m[2]} 列的 "{" 没有闭合,从那里向下检查块结构。`,
        en: m => `Start checking block structure downward from the unclosed "{" at line ${m[1]}.`,
    },
    {
        pattern: /^Unmatched '\}' - no matching '\{' found/,
        zh: () => '多余的右花括号 "}":没有与之配对的 "{",通常是上方某处多删/多写了一个括号。',
    },
    {
        pattern: /^Skipped structurally invalid top-level block around lines (\d+)-(\d+)/,
        zh: m => `第 ${m[1]}-${m[2]} 行的顶层块结构无效,已被解析器跳过;先修复该块的语法,其余报错才可信。`,
        en: () => 'Fix this block first; other diagnostics in the file may be stale until it parses.',
    },
    {
        pattern: /^Parser recovery parsed (\d+) healthy top-level block/,
        zh: () => '文件存在语法错误,解析器只恢复了部分内容;在语法错误修复前,本文件的规则校验结果可能不完整。',
    },
    {
        codes: ['CW002'],
        pattern: /mixed key\/values and values/i,
        zh: () => '块内同时出现 "键 = 值" 和裸值,通常是某一行漏写了等号 "="。',
    },

    // ---- Unknown trigger / effect / modifier (CW102/103/114/118) ----
    {
        pattern: /^unknown trigger (\S+) used\.?$/,
        zh: m => `未知触发条件(trigger)"${m[1]}":检查拼写;它也可能是效果(effect)误用在触发块里,或来自未启用的 DLC/前置模组。`,
        en: () => 'Check spelling; it may also be an effect misplaced in a trigger block.',
    },
    {
        pattern: /^unknown effect (\S+) used\.?$/,
        zh: m => `未知效果(effect)"${m[1]}":检查拼写;它也可能是触发条件误用在效果块里,或来自未启用的 DLC/前置模组。`,
        en: () => 'Check spelling; it may also be a trigger misplaced in an effect block.',
    },
    {
        pattern: /^unknown static modifier (\S+) used\.?$/,
        zh: m => `未知静态修正(static modifier)"${m[1]}":检查拼写,或确认它已在 static_modifiers 中定义。`,
    },
    {
        pattern: /^unknown modifier (\S+) used\./,
        zh: m => `未知修正(modifier)"${m[1]}":检查拼写,或确认对应的修正类型存在。`,
    },

    // ---- Scope errors (CW104/105/106/115/119/243/245/247/260) ----
    {
        pattern: /^(\S+) (trigger|effect|scope command|modifier|static modifier possibly) used in incorrect scope\. In (.+?) but expected (.+?)(?:\.|$)/,
        zh: m => `"${m[1]}" 用在了错误的作用域:当前是 ${m[3]},需要 ${m[4]}。用作用域切换(如 owner、from、prev)进入正确作用域,或把这段移到正确的块里。`,
        en: () => 'Use a scope change (owner / from / prev / ...) to reach the expected scope, or move this line into the right block.',
    },
    {
        pattern: /^Trigger\/Effect\/Modifier (\S+) used in wrong scope\. In (.+?) but expect (.+)$/,
        zh: m => `"${m[1]}" 用在了错误的作用域:当前是 ${m[2]},需要 ${m[3]}。用作用域切换(如 owner、from、prev)进入正确作用域。`,
        en: () => 'Use a scope change (owner / from / prev / ...) to reach the expected scope.',
    },
    {
        pattern: /^Target "(.+)" has incorrect scope\. Is (.+?) but expect (.+)$/,
        zh: m => `目标 "${m[1]}" 的作用域不对:当前是 ${m[2]},需要 ${m[3]}。`,
    },
    {
        pattern: /^Error in target\. Link (\S+) was used in scope (.+?) but expected (.+)$/,
        zh: m => `作用域链接 "${m[1]}" 不能在 ${m[2]} 作用域中使用(需要 ${m[3]})。`,
    },
    {
        pattern: /^(\S+) is not a target\. Expected a target in scope\(s\) (.+)$/,
        zh: m => `"${m[1]}" 不是有效的作用域目标,此处需要 ${m[2]} 作用域中的目标(事件目标、变量或作用域链接)。`,
    },
    {
        pattern: /^Invalid scope command (\S+)/,
        zh: m => `无效的作用域命令 "${m[1]}"。`,
    },
    {
        pattern: /^Loc command (\S+) used in wrong scope\. In (.+?) but expected (.+)$/,
        zh: m => `本地化命令 "${m[1]}" 作用域错误:当前是 ${m[2]},需要 ${m[3]}。`,
    },
    {
        codes: ['CW116'],
        pattern: /^(\S+) scope command used incorrectly, did you mean (.+)$/,
        zh: m => `作用域命令 "${m[1]}" 用法错误,是否想写:${m[2]}`,
    },

    // ---- Localisation (CW100/225/226/234/254/255/256/257/258/259/266/268/275) ----
    {
        pattern: /^Localisation key (\S+) is not defined for (.+)$/,
        zh: m => `本地化键 "${m[1]}" 在语言 ${m[2]} 中未定义:在对应的 localisation 文件中补上这一键。`,
        en: () => 'Add this key to the localisation file for that language.',
    },
    {
        pattern: /^Localisation key (\S+) is a placeholder for (.+)$/,
        zh: m => `本地化键 "${m[1]}" 在 ${m[2]} 中还是占位符(REPLACE_ME),记得填入正式文本。`,
    },
    {
        pattern: /^Localisation key "(.+)" references "(.+)" which doesn't exist in (.+)$/,
        zh: m => `本地化键 "${m[1]}" 引用的 "$${m[2]}$" 在 ${m[3]} 中不存在。`,
    },
    {
        pattern: /^Localisation key "(.+)" uses command "(.+)" which doesn't exist$/,
        zh: m => `本地化键 "${m[1]}" 使用了不存在的命令 "${m[2]}",检查 [命令] 的拼写。`,
    },
    {
        pattern: /^Localisation key (\S+) uses command (\S+) which does not exist in data type (\S+)/,
        zh: m => `本地化键 "${m[1]}" 的命令 "${m[2]}" 在数据类型 ${m[3]} 上不存在。`,
    },
    {
        pattern: /^Localisation files must be UTF-8 BOM/,
        zh: () => '本地化文件必须是 UTF-8 with BOM 编码:用 VS Code 右下角编码菜单选 "通过编码保存 → UTF-8 with BOM"。',
        en: () => 'Use the encoding picker in the status bar: "Save with Encoding → UTF-8 with BOM".',
    },
    {
        pattern: /^Localisation file name should contain (?:\(and ideally end with\) )?"l_language\.yml"/,
        zh: () => '本地化文件名需要包含语言后缀,例如 my_mod_l_english.yml、my_mod_l_simp_chinese.yml。',
    },
    {
        pattern: /^Localisation file should start with "l_language:"/,
        zh: () => '本地化文件第一行必须是语言头,例如 "l_english:" 或 "l_simp_chinese:"。',
    },
    {
        pattern: /^Localisation file's name has language (\S+) doesn't match the header language (\S+)/,
        zh: m => `文件名里的语言(${m[1]})和文件头声明的语言(${m[2]})不一致,两者需保持相同。`,
    },
    {
        pattern: /^Localisation file name should end with "l_language\.yml"/,
        zh: () => '建议本地化文件名以语言后缀结尾,例如 ..._l_english.yml。',
    },
    {
        pattern: /^This localisation string refers to itself/,
        zh: () => '这条本地化文本引用了它自己,会导致无限递归。',
    },
    {
        pattern: /^Localisation key (\S+) doesn't start and end with double quotes/,
        zh: m => `本地化键 "${m[1]}" 的文本需要用英文双引号包裹:key:0 "文本"。`,
    },
    {
        pattern: /^Localisation key (\S+) contains unexpected characters/,
        zh: m => `本地化键 "${m[1]}" 含有异常字符,可能无法正常显示;检查是否混入了全角符号或不可见字符。`,
    },
    {
        codes: ['CW122'],
        pattern: /^Localisation key (\S+) should not be quoted when used inline/,
        zh: m => `内联使用本地化键 "${m[1]}" 时不要加引号,否则可能出现意外行为。`,
    },

    // ---- Value type expectations (CW240/249/267/270/271 + FieldValidators) ----
    {
        pattern: /^Expecting yes or no, got (\S+)/,
        zh: m => `此处只能填 yes 或 no,而不是 "${m[1]}"。`,
    },
    {
        pattern: /^Expecting an integer, got (\S+)/,
        zh: m => `此处需要整数,而不是 "${m[1]}"。`,
    },
    {
        pattern: /^Expecting a float, got (\S+)/,
        zh: m => `此处需要数字(可带小数),而不是 "${m[1]}"。`,
    },
    {
        pattern: /^Expecting an? percentage, got (\S+)/,
        zh: m => `此处需要百分比(如 50%),而不是 "${m[1]}"。`,
    },
    {
        pattern: /^Expecting a date, got (\S+)/,
        zh: m => `此处需要日期(如 2200.1.1),而不是 "${m[1]}"。`,
    },
    {
        pattern: /^Expecting a value between (\S+) and (\S+)/,
        zh: m => `数值必须在 ${m[1]} 到 ${m[2]} 之间。`,
    },
    {
        pattern: /^Expecting a "(.+?)" value, e\.g\.? (.+)$/,
        zh: m => `此处需要 "${m[1]}" 枚举值,例如 ${m[2]}。`,
    },
    {
        pattern: /^Expecting value (\S+)/,
        zh: m => `此处的值必须是 ${m[1]}。`,
    },
    {
        pattern: /^Expected value of type ([A-Za-z0-9_.:-]+)(?:, got '([^']*)')?(?: \(did you mean '([^']+)'\?\))?/,
        zh: m => {
            const got = m[2] ? `"${m[2]}" 不存在` : '当前写的名称不存在';
            const advice = m[3] ? `,是否想写 "${m[3]}"?` : ',检查拼写或先创建对应定义。';
            return `此处需要引用一个已定义的 "${m[1]}":${got}${advice}`;
        },
        en: m => m[3]
            ? `Closest existing ${m[1]}: '${m[3]}'.`
            : 'The referenced name does not exist; check spelling or define it first.',
    },
    {
        pattern: /^Expected defined value of (\S+), got (\S+)/,
        zh: m => `此处需要 ${m[1]} 中已定义的值,而 "${m[2]}" 不在其中。`,
    },
    {
        pattern: /^Expected a (\S+) value, got (\S+)/,
        zh: m => `此处需要 ${m[1]} 类型的值,而不是 "${m[2]}"。`,
    },
    {
        pattern: /^Expecting a variable or number$/,
        zh: () => '此处需要一个变量或数字。',
    },
    {
        pattern: /^Expected an integer$/,
        zh: () => '此处需要整数。',
    },
    {
        pattern: /^Value too small, only 3 decimal places are supported/,
        zh: () => '数值精度过高:此处最多支持 3 位小数。',
    },
    {
        pattern: /^Unknown type referenced (\S+)/,
        zh: m => `规则引用了未知类型 "${m[1]}",通常是 CWT 规则文件的问题而非脚本本身。`,
    },

    // ---- Rule structure: unexpected / missing / too many (CW241/242/262-265) ----
    {
        pattern: /^(\S+) is unexpected in (\S+?)(?: \(did you mean '([^']+)'\?\))?$/,
        zh: m => m[3]
            ? `"${m[1]}" 不应出现在 "${m[2]}" 中,是否想写 "${m[3]}"?`
            : `"${m[1]}" 不应出现在 "${m[2]}" 中:键名拼写错误,或这个字段不属于该块;对照 vanilla 同类定义检查。`,
        en: m => m[3]
            ? `Closest valid key here: '${m[3]}'.`
            : 'Either the key is misspelled or it does not belong in this block; compare with a vanilla definition.',
    },
    {
        pattern: /^Missing clause, expecting at least (\d+)/,
        zh: m => `缺少必需的子块(至少需要 ${m[1]} 个)。`,
    },
    {
        pattern: /^Missing (.+?), expecting at least (\d+)/,
        zh: m => `缺少必填字段 ${m[1]}(至少需要 ${m[2]} 个)。`,
        en: () => 'Add the required field to this block.',
    },
    {
        pattern: /^Too many clauses, expecting at most (\d+)/,
        zh: m => `子块数量过多(最多 ${m[1]} 个)。`,
    },
    {
        pattern: /^Too many (?:n |l |lv )?(.+?), expecting at most (\d+)/,
        zh: m => `字段 ${m[1]} 出现次数过多(最多 ${m[2]} 个),删除多余的重复项。`,
    },

    // ---- Definitions & references (CW101/112/113/117/222/227-233/246/261/273) ----
    {
        pattern: /^Sprite type (\S+) not found$/,
        zh: m => `图标 "${m[1]}" 未定义:需要在 interface/*.gfx 的 spriteTypes 中定义,或检查 GFX_ 名称拼写。`,
        en: () => 'Define it in a spriteTypes block under interface/*.gfx, or fix the GFX_ name.',
    },
    {
        pattern: /^File (.+) not found, this is case sensitive$/,
        zh: m => `找不到文件 "${m[1]}":路径大小写敏感,检查文件是否存在、扩展名与大小写是否完全一致。`,
        en: () => 'The path is case sensitive; verify the file exists with this exact casing.',
    },
    {
        pattern: /^The event id (\S+) is not defined$/,
        zh: m => `事件 ID "${m[1]}" 未定义:检查 namespace 与编号,或确认事件文件已在 events/ 目录中。`,
    },
    {
        pattern: /^Key (\S+) of type (\S+) is defined multiple times$/,
        zh: m => `"${m[1]}"(类型 ${m[2]})被重复定义:全局搜索该名称,删除或重命名多余的那份。`,
        en: () => 'Search the workspace for the other definition and remove or rename one of them.',
    },
    {
        pattern: /^The variable (\S+) has not been set$/,
        zh: m => `变量 "${m[1]}" 从未被 set_variable 设置过,运行时会按 0 处理。`,
    },
    {
        pattern: /^(\S+) variable is never defined$/,
        zh: m => `变量 "${m[1]}" 从未定义。`,
    },
    {
        pattern: /^Modifier type (\S+) is not defined but is used$/,
        zh: m => `修正类型 "${m[1]}" 未定义但被使用了。`,
    },
    {
        pattern: /^Mesh (\S+) is not defined$/,
        zh: m => `模型网格(mesh)"${m[1]}" 未定义:检查 .gfx 中的 entity/mesh 定义。`,
    },
    {
        pattern: /^Entity (\S+) is not defined/,
        zh: m => `实体(entity)"${m[1]}" 未定义:检查 .asset 文件中的 entity 定义。`,
    },
    {
        pattern: /^Section template (\S+) can not be found$/,
        zh: m => `舰船区段模板 "${m[1]}" 不存在。`,
    },
    {
        pattern: /^Component template (\S+) can not be found$/,
        zh: m => `组件模板 "${m[1]}" 不存在。`,
    },
    {
        pattern: /^Button effect (\S+) not found$/,
        zh: m => `按钮效果 "${m[1]}" 未定义。`,
    },
    {
        codes: ['CW101'],
        pattern: /^(\S+) is not defined$/,
        zh: m => `"${m[1]}" 未定义。`,
    },

    // ---- Performance / style hints (CW107/121/223/224/235/236/238/251/274) ----
    {
        codes: ['CW107'],
        pattern: /runs on every tick/,
        zh: () => '该事件没有触发限制,会每个 tick 评估一次,影响性能:加上 is_triggered_only、fire_only_once 或 mean_time_to_happen。',
    },
    {
        pattern: /^This 'if' trigger contains no effects/,
        zh: () => '这个 if 块里没有任何效果,是空的。',
    },
    {
        pattern: /^Do not use NOT with multiple children/,
        zh: () => 'NOT 带多个子条件时语义有歧义:多个条件想全部取反用 NOR,想"并非全部"用 NAND。',
    },
    {
        pattern: /^This boolean operator is redundant/,
        zh: () => '这个逻辑运算符是多余的,可以去掉。',
    },
    {
        pattern: /^This (\S+) is unnecessary$/,
        zh: m => `这个 ${m[1]} 是多余的,可以去掉。`,
    },
    {
        pattern: /^Modifier (\S+) has value 0/,
        zh: m => `修正 "${m[1]}" 的值是 0:修正是加法叠加的,写 0 没有任何效果。`,
    },
    {
        pattern: /^Nested if\/else in effects was deprecated/,
        zh: () => '效果中嵌套 if/else 的旧写法已在 2.1 版本废弃,改用 else_if。',
    },
    {
        pattern: /^An else\/else_if is missing a preceding if/,
        zh: () => 'else/else_if 前面缺少对应的 if。',
    },
    {
        pattern: /^This usage of inline_script results in an error, see related/,
        zh: () => '这个 inline_script 展开后产生了错误:查看"相关信息"定位脚本内部的实际出错位置。',
        en: () => 'Check the related information entries for the actual error location inside the inline script.',
    },
    {
        codes: ['CW274D'],
        pattern: /^This (.+?) (\S+) results in an error when expanded at a call site/,
        zh: m => `${m[1]} "${m[2]}" 本身没问题,但在调用点展开后会报错:查看"相关信息"定位出错的调用点,实际错误见 CW274。`,
        en: () => 'This definition expands cleanly on its own; see the related information entry for the call site where it errors.',
    },
    {
        codes: ['CW220', 'CW221'],
        pattern: /require the event target\(s\) (\S+) but they (?:are|may) not/,
        zh: m => `事件目标 ${m[1]} 在到达此处的事件链中未必已通过 save_event_target_as 设置,使用前先确保已保存。`,
    },
];

function codeOf(diag: EnrichableDiagnostic): string | undefined {
    return diagnosticCodeString(diag.code);
}

/**
 * Extracts the CW error code as a string from a vscode.Diagnostic `code`
 * value, which may be a plain string/number or — once the server attaches a
 * `codeDescription` link — an object of shape `{ value, target }`.
 */
export function diagnosticCodeString(code: unknown): string | undefined {
    if (code === undefined || code === null) return undefined;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
    if (typeof code === 'object' && 'value' in code) {
        const value = (code as { value: string | number }).value;
        return value === undefined || value === null ? undefined : String(value);
    }
    return undefined;
}

/**
 * Returns the hint line (without the prefix) for a diagnostic message, or
 * undefined when no curated rule matches. Exported for tests.
 */
export function buildDiagnosticHint(message: string, code: string | undefined, isChinese: boolean): string | undefined {
    const firstLine = (message.split('\n', 1)[0] ?? message).trim();
    const normalizedCode = code?.toUpperCase();
    for (const rule of RULES) {
        if (rule.codes && normalizedCode && !rule.codes.some(c => normalizedCode.startsWith(c))) continue;
        const match = rule.pattern.exec(firstLine);
        if (!match) continue;
        if (isChinese) return rule.zh(match);
        return rule.en?.(match);
    }
    return undefined;
}

/**
 * Enriches diagnostics in place: normalizes `source` to "CWTools" when the
 * server left the error code there, and localizes the message. When the VS
 * Code display language is Chinese and a curated rule matches, the message is
 * fully replaced by the Chinese translation (which restates the error and the
 * fix); otherwise the original message is kept and an English 💡 advice line
 * is appended when available. Idempotent — a replaced Chinese message matches
 * no English rule, and appended messages carry the hint marker.
 */
export function enrichDiagnosticsInPlace(diagnostics: EnrichableDiagnostic[], isChinese: boolean): void {
    for (const diag of diagnostics) {
        if (!diag.source || /^CW\d/i.test(diag.source)) {
            diag.source = 'CWTools';
        }
        if (diag.message.includes(HINT_PREFIX)) continue;
        const hint = buildDiagnosticHint(diag.message, codeOf(diag), isChinese);
        if (!hint) continue;
        if (isChinese) {
            diag.message = hint;
        } else {
            diag.message += HINT_PREFIX + hint;
        }
    }
}

export function diagnosticMatchesIgnoredKey(
    diag: { message: string; relatedInformation?: readonly { message: string }[] },
    key: string,
): boolean {
    if (diag.message.includes(key)) return true;
    return (diag.relatedInformation ?? []).some(ri => ri.message.includes(key));
}

// ---- Localisation warning folding ----

/** Localisation diagnostic codes exposed by the Rust language-server contract. */
const LOCALISATION_CODES = new Set([
    'CW100', 'CW225', 'CW226', 'CW234', 'CW254', 'CW255',
    'CW256', 'CW257', 'CW258', 'CW259', 'CW260', 'CW266',
    'CW268', 'CW275',
]);

export type LocalisationDiagnosticFilterMode = 'off' | 'problems' | 'all';

export function isLocalisationDiagnostic(diag: Pick<EnrichableDiagnostic, 'code'>): boolean {
    const code = diagnosticCodeString(diag.code)?.toUpperCase().split('_', 1)[0];
    return code !== undefined && LOCALISATION_CODES.has(code);
}

export function filterLocalisationDiagnostics<T extends EnrichableDiagnostic>(diagnostics: readonly T[]): T[] {
    return diagnostics.filter(diagnostic => !isLocalisationDiagnostic(diagnostic));
}

const WARNING_SEVERITY = 1; // vscode.DiagnosticSeverity.Warning
const INFORMATION_SEVERITY = 2; // vscode.DiagnosticSeverity.Information

export interface FoldableRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

/** Structural subset of vscode.Diagnostic the folder reads/writes. */
export interface FoldableDiagnostic extends EnrichableDiagnostic {
    severity?: number;
    range: FoldableRange;
    relatedInformation?: { location: { uri: unknown; range: FoldableRange }; message: string }[];
}

function localisationCodeOf(diag: FoldableDiagnostic): string | undefined {
    const code = codeOf(diag)?.toUpperCase().split('_', 1)[0];
    return code && isLocalisationDiagnostic(diag) ? code : undefined;
}

/**
 * Folds repeated same-code localisation warnings within one file into a single
 * Problems-panel entry whose relatedInformation lists every occurrence — the
 * same presentation CW274 inline_script call-site errors use. Only warnings
 * are folded; errors stay individual, and single occurrences pass through
 * untouched. The merged entry keeps the first occurrence's range/data so
 * quick fixes at that position still work.
 */
export function foldLocalisationWarnings<T extends FoldableDiagnostic>(
    diagnostics: readonly T[],
    uri: unknown,
    isChinese: boolean,
): T[] {
    const groups = new Map<string, T[]>();
    for (const diag of diagnostics) {
        if (diag.severity !== WARNING_SEVERITY) continue;
        const code = localisationCodeOf(diag);
        if (!code) continue;
        const group = groups.get(code);
        if (group) group.push(diag);
        else groups.set(code, [diag]);
    }
    if (![...groups.values()].some(group => group.length > 1)) return diagnostics.slice();

    const result: T[] = [];
    for (const diag of diagnostics) {
        const group = diag.severity === WARNING_SEVERITY
            ? groups.get(localisationCodeOf(diag) ?? '')
            : undefined;
        if (!group || group.length < 2) {
            result.push(diag);
            continue;
        }
        if (diag !== group[0]) continue;
        const message = isChinese
            ? `本地化警告 ×${group.length}（${localisationCodeOf(diag)}）——展开此条目查看每一处。`
            : `${group.length} localisation warnings (${localisationCodeOf(diag)}) — expand this entry for each occurrence.`;
        result.push({
            ...diag,
            message,
            relatedInformation: group.map(member => ({
                location: { uri, range: member.range },
                message: member.message,
            })),
        });
    }
    return result;
}

/**
 * Folds repeated CW274D definition hints into one Problems-panel entry per
 * definition. Each server diagnostic already points at one failing call site
 * through relatedInformation, so folding must flatten those existing
 * locations rather than replacing them with the repeated definition range.
 */
export function foldRelatedCallSiteInformation<T extends FoldableDiagnostic>(
    diagnostics: readonly T[],
    isChinese: boolean,
): T[] {
    const groupKey = (diag: T): string | undefined => {
        if (diag.severity !== INFORMATION_SEVERITY) return undefined;
        if (codeOf(diag)?.toUpperCase() !== 'CW274D') return undefined;
        if (!diag.relatedInformation?.length) return undefined;
        const { start, end } = diag.range;
        return JSON.stringify([
            start.line, start.character, end.line, end.character, diag.message,
        ]);
    };

    const groups = new Map<string, T[]>();
    for (const diag of diagnostics) {
        const key = groupKey(diag);
        if (!key) continue;
        const group = groups.get(key);
        if (group) group.push(diag);
        else groups.set(key, [diag]);
    }
    if (![...groups.values()].some(group => group.length > 1)) return diagnostics.slice();

    const result: T[] = [];
    for (const diag of diagnostics) {
        const key = groupKey(diag);
        const group = key ? groups.get(key) : undefined;
        if (!group || group.length < 2) {
            result.push(diag);
            continue;
        }
        if (diag !== group[0]) continue;
        const relatedInformation = group.flatMap(member => member.relatedInformation ?? []);
        const countSuffix = isChinese
            ? `（${relatedInformation.length} 个调用点）`
            : ` (${relatedInformation.length} call sites)`;
        result.push({
            ...diag,
            message: diag.message + countSuffix,
            relatedInformation,
        });
    }
    return result;
}
