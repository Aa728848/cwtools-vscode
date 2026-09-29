# 09 scripted_trigger / scripted_effect / inline_script：加载时与运行时成本

**一句话结论：这三者的开销几乎全在"加载时"。** 运行时 scripted_trigger 和 scripted_effect 只多一次间接调用，inline_script 就等于把代码原样粘贴过来。三者的差别体现在加载时间、内存占用，以及同样的参数是否能复用一个实例。

---

## 1. ✅ 运行时：scripted_trigger / scripted_effect 几乎零开销

```c
// CScriptedTrigger::ActualEvaluate 6750319
plVar2 = *(long **)(param_1 + 0xc0);            // 加载时已经构建好的 CAndTrigger 实例
if (param_1[0xd8] == 0) { lVar6 = (**(code **)(**(long **)plVar2[0xf] + 0xd8))(); … 比较 … }   // 当作数值比较时
else return (**(code **)(*plVar2 + 0x10))();     // 普通用法：直接调用子 trigger 的 Evaluate

// CScriptedEffect::ExecuteActual 5900055
if (*(long **)(param_1 + 0x110) != 0) (**(code **)(**(long **)(param_1 + 0x110) + 0x48))();
```
- **不拷贝作用域，不查字符串，不替换参数**。参数（`$PARAM$`）在加载时就已经展开成独立的 trigger 或 effect 树了。
- 与直接把内容写在原处相比，只多 1–2 次虚调用。**所以"把 scripted_trigger 展开成内联代码来提速"没有意义。**
- **真正决定运行时开销的是 trigger 或 effect 本身的内容**，也就是其中的迭代器、作用域跳转、flag 检查等，见 02 和 08。

---

## 2. ✅ 带参数的 scripted_trigger / scripted_effect：每组不同的参数，就要完整生成一次源码并重新解析

**流程**（`CScriptedTrigger::BuildFromSource` 6749986，`CScriptedEffect::BuildFromSource` 5899543）：
1. 用参数数组 `CPdxArray<pair<CString,CString>>` 作为键，经 `SArgsHasher` 哈希后查 `CMetaScriptObjectInstanceRepository`。
   - **参数完全相同就复用同一个实例**，这是好的设计：100 个调用点只要参数一样，就只生成一次。
2. 未命中时调用 `CMetaScriptTemplate::GenerateSource`（893150）：
   ```c
   _M_replace(param_2, 0, …, template_source, strlen(template_source));   // 复制整份模板源码
   ProcessSourceForMacros(this, param_2, args);                         // 处理 [[PARAM] … ]
   if (*(int *)(this + 0xcc) == 0) ProcessSourceForArguments(param_2, args, this + 0xa0);
   else { ParseForArguments(this, param_2, &tmp, 0, false);             // 模板带 [[宏]] 时：每次实例化都重新扫描一遍找参数位置
          ProcessSourceForArguments(param_2, args, &tmp); }
   ::CString::ReplaceAll(param_2,"\\[","[");                            // 4 次无条件的全文扫描，处理转义
   ::CString::ReplaceAll(param_2,"\\]","]");
   ::CString::ReplaceAll(param_2,"\\|","|");
   ::CString::ReplaceAll(param_2,"\\$","$");
   ```
3. 然后依次构造 `CBlob`、`CMemoryFile`、`CTextLexer` 和 `CReader`，**从头词法分析、解析生成的源码**，每个字符都要走 05-E2 里那个慢速词法分析器。

**复杂度**（L 为模板源码长度，M 为 `[[宏]]` 的个数）：
- `ProcessSourceForMacros`（893428）：**每处理一个宏，就用"前缀子串 + 宏体 + 后缀子串"把整个字符串重建一遍**（`GetSubstring` ×2、`operator+=`、`_M_replace` 整串）。所以是 O(M × L)，并伴随多次堆分配。
- 带宏的模板每次实例化都要重新运行 `ParseForArguments`（前一步的宏替换改变了参数位置），又是一遍 O(L)。
- 4 次 `ReplaceAll`：4 × O(L)，不管源码里有没有转义字符。
- 最后是完整的解析，O(L)，常数很大。

**什么时候会变慢**：参数取值很多的模板，例如用参数传入 100 个不同的 `$TYPE$`，每一种都是一次完整的"生成源码 + 解析"。如果模板很长，还带大量 `[[宏]]`，加载时间会明显增加。

**引擎侧优化**：
- 模板只解析一次，生成"片段列表 + 参数槽"，实例化时直接拼接，不要反复 `_M_replace` 整串；
- 转义处理只在模板里真的有 `\` 时才做；
- 更进一步：把模板解析成带参数节点的 AST，实例化时只替换参数节点，完全跳过重新词法分析。

---

## 3. ✅ inline_script：纯文本宏，**每个调用点**都要复制源码、替换参数、完整重新解析，**不去重**

`CreateInlineScriptReader`（8096479–8096719）：
```c
lVar4 = CPdxRobinHoodTable<…SInlineScript…>::Find<CString>(CInlineScriptDatabase::_pInstance, name);  // 按名字查找，哈希
__s = *(char **)(lVar4 + 0x70);  __n = strlen(__s);  memcpy(__dest, __s, __n);                     // 复制整份脚本源码
do {                                                                                              // 对每个参数
    CString::CString(&tmp, "$");  tmp += name;  tmp += "$";
    CString::ReplaceAll(source, tmp, value);                                                      // 全文替换一次
} while (++param != end);
InternalCreateReader(param_1, reader, path, source);                                             // 基于替换后的文本新建 CReader，从头词法分析
```
- **每个调用点**：一次 O(L) 的复制，P 次 O(L) 的 `ReplaceAll`（P 为参数个数），再加一次完整的词法分析和解析。开销是 O((P+1)·L)，加上解析成本。
- **没有去重**：同一个 inline_script，用同样的参数写在 200 个地方，就要复制、替换、解析 200 次，并生成 **200 棵独立的 trigger/effect 树**。这和 scripted_trigger 按参数复用实例不同。
- **嵌套的 inline_script** 会在解析过程中递归展开，所以开销是相乘的。
- 名字写错时会调用 `CLogger` 并 `ostream::flush()` 写日志（8096546–8096570），只在加载时发生，影响不大。
- **运行时**：和手写的内联代码完全一样，没有额外开销。但因为每个调用点都是独立的对象树，**内存占用和缓存压力更大**。同样的逻辑复制成几百份，指令缓存和数据缓存的命中率都会下降。

---

## 4. 三者对比与 mod 选择建议

| | 运行时开销 | 相同参数的多个调用点 | 不同参数 | 加载成本 | 内存 |
|---|---|---|---|---|---|
| 直接内联手写 | 基准 | —— | —— | 每处解析一次 | 每处一份 |
| `scripted_trigger`/`scripted_effect` 无参数 | 基准 + 1–2 次虚调用 | **共享一个实例** | —— | 只解析一次 | **一份** |
| 带参数 | 基准 + 1–2 次虚调用 | **共享一个实例**（按参数哈希） | 每组参数：复制源码 + O(M·L) 宏处理 + 4 次 ReplaceAll + 完整解析 | 取决于不同参数的组数 | 每组参数一份 |
| `inline_script` | 基准 | **每个调用点单独一份** | 每个调用点：复制 + P 次 ReplaceAll + 完整解析 | 取决于调用点数 × 嵌套层数 | **每个调用点一份** |

**建议**：
1. **同样的逻辑在很多地方复用时，用 scripted_trigger 或 scripted_effect，不要用 inline_script**。运行时一样快，但加载只做一次，内存也只有一份。
2. inline_script 适合真正需要"在不同位置生成不同结构"的场合，例如生成整个事件、整个建筑定义或 GUI 片段，这些是 scripted_* 做不到的。**不要**把它当成通用函数来调用几百次。
3. 带参数的 scripted_*：尽量减少**不同参数组合**的数量。例如同一个 `$TYPE$` 取 100 个值，就会实例化 100 次。可以考虑拆成"无参数的公共部分"加"很小的带参数部分"。
4. 很长的模板里尽量少用 `[[PARAM] … ]` 宏，每个宏都要让整个源码重建一遍。
5. 运行时要优化的是**内容本身**：迭代器（02）、作用域跳转（08-B8）、flag 和变量（08-A）、game_rules（08-C）。把 scripted_trigger 拆开或内联，对运行时没有帮助。
