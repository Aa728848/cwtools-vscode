# 08 补充：flag、变量、事件目标、GameRule、科技计数、舰队管理器、AoE/连锁武器

这一轮根据用户提出的疑点逐条核实。每一节开头给出结论：**成立**、**部分成立**或**不成立**，并附上代码证据。标 ✅ 的是我亲自读过代码确认的。

---

## A. flag 与变量：检查成本不同，flag 没有索引

### A1 ✅ `has_flag` / `has_global_flag` 是线性扫描（结论：成立）
- `CHasFlagTrigger::ActualEvaluate`（6751401–6751426）：
  ```c
  lVar2 = (**(code **)(*(long *)this + 0xf8))(this,param_1);      // 取得作用域上的 CPdxIntegerFlags
  if (0 < (int)*(uint *)(lVar2 + 0x1c)) {
    uVar3 = 0;
    do {
      if (*(short *)(*(long *)(lVar2 + 0x10) + uVar3 * 2) == sVar1) return …;
      uVar3 = uVar3 + 1;
    } while (*(uint *)(lVar2 + 0x1c) != uVar3);
  }
  ```
  每个对象的 flag 就是一个无序的 `ushort` 数组，检查一次是 O(该对象的 flag 数)。没有哈希，没有位图，也没有排序。
- **global flag 的设计问题**：`CHasGlobalFlagTrigger::GetFlags`（6770446）和 `CSetGlobalFlagEffect::AccessFlags`（5936176）都返回 `g_CurrentGameState + 0x490`。全游戏所有的 global flag，也就是原版加上每个 mod 的全部 global flag，都塞在**同一个**线性数组里。mod 越多，数组越长，**每一次** `has_global_flag` 都要把它整个扫一遍。大量 mod 用 global flag 做"只做一次"的开关，而且从不清理，数组只会越来越长。
- `CSetGlobalFlagEffect::AccessFlags` 每次调用还要检查 `g_AllowGlobalGameStateAccess`，并调用 `CRandomLog::IsEnabled`（开销很小）。

### A2 ✅ `set_*_flag` 是 O(n)（结论：成立）
- `CSetFlagEffect::ExecuteActual`（5905818）→ `CPdxIntegerFlags::SetFlag`（7062097）。`SetFlag` 先对整个数组线性扫描查重，没找到才追加到 3 个平行数组里（flag、日期、天数）。
- `remove_*_flag` → `ClearFlag`（约 7062160）同样是线性查找，然后与末尾交换删除。
- 每天还有 `UpdateFlags`（7062208）对每个 flag 容器扫描一遍，处理带 `days =` 的过期。

### A3 ✅ 动态 flag（`flag@scope`）每次求值都要拼字符串，名字永不回收（结论：成立，并发现一个正确性问题）
- `CHasFlagTrigger` 发现 `this+0x230 != 0`（动态 flag）时调用 `GetDynamicFlag`（1584388）。每次求值都要做：
  1. `ProcessDynamicFlag`（1584280）：构造一整个 `CEventScope`，执行 `CEventTarget::GetScope`，`CString::Reserve`，把名字和对象 ID 转成字符串后拼接，最后析构这个作用域；
  2. `CPdxIntegerFlags::GetFlagIndex`（7062704）：计算 Murmur 哈希，在 robin-hood 表里探查；
  3. 然后才进入 A1 那样的线性扫描。
- **名字永不回收，而且有 65535 的上限**：`set_flag = foo@this` 经 `CreateDynamicFlag`（1584339）→ `CPdxIntegerFlags::CreateFlagIndex`（7062381），把拼好的字符串永久插入全局表 `_AllFlags` / `_AllFlagsReverse`，没有任何删除路径。flag ID 是 `ushort`：
  ```c
  if (_AllFlags._8_2_ == -1) { uVar6 = CONCAT62(uVar7,0xffff); }   // 7062405：表满后直接返回 0xffff，不写日志
  ```
  给每个星球或人口打 `xxx@this` 的 mod，每个对象都会永久占用一个名字，整局游戏都不释放。表满以后，**所有新名字（包括之后才解析的静态 flag 和事件目标名）都会静默变成 0xffff**。
- **✅ 已实测**（见 B8-(6) 末尾的汇总表）：表满时不写任何日志；新 flag 静默设置失败，但 flag 之间不会串号，因为 `SetFlag` 拒绝 `0xffff`；**事件目标会串号**。动态名是"基础名 + 十进制 ID"直接拼接，**不带 `@`**，所以 `a1@(ID 23)` 和 `a12@(ID 3)` 会撞名。名字表是进程级的，只有重启游戏才会清空。

### A4 flag 与变量的成本对比
| 操作 | 实现 | 复杂度 | 每次的固定开销 |
|---|---|---|---|
| `has_flag` 静态 | 无序 `ushort` 数组线性扫描 | O(对象上的 flag 数) | 很小（2 字节比较） |
| `has_global_flag` | **全局共用的一个**数组线性扫描 | O(全部 global flag 数) | 很小，但 N 可能很大 |
| `has_flag = x@scope` 动态 | 构造作用域 + 拼字符串 + 哈希 + 线性扫描 | O(flag 数) + 字符串 | **大**（堆分配、字符串、作用域构造和析构） |
| `set_flag` | 线性查重 + 追加 3 个数组 | O(flag 数) | 中 |
| `check_variable` | robin-hood 哈希（`CVariables::GetVariable` 1596830） | 平均 O(1) | 中：每次都要重新对名字算 `PMurHash32`，并构造 `CString("local_")` 再 `StartsWith` |
| `value = my_var`（同作用域，非字面量） | 见 A5：**也会先完整拷贝一次作用域** | O(1) + 拷贝 | 中到大 |
| `value = owner.var` 跨作用域 | 见 A5 / B3：拷贝 + 每段一次递归解析 + 拷贝赋值 | O(1) + 链长 × 拷贝 | **大** |

### A5 ✅ 变量：有没有上限？跨作用域读写有没有额外开销？

**存储**：
- `local_` 开头的变量存在事件根作用域的容器里（`CEventScope::AccessVariables`，即 `+0x48` → `CVariables`）。
- 其他变量存在**对象自己身上**：`CEventScope::GetSavedVariables`（2468904）按作用域类型走一个大 switch，再按 ID 从数据库取对象，返回对象里的 `CVariables`（例如恒星基地 `+0x1398`、局势 `+0x308`、殖民地的载体 `+0x268`）。这一步是 O(1)。
- `CVariables` 是 `CPdxUnorderedMap<CString, CFixedPoint>`，一张 robin-hood 哈希表（最大负载因子 0x3f666666 = 0.9）。

**数量上限：没有硬上限**（和 flag 不同）：
- 变量名以 `CString` 形式直接作为键，**不经过** `_AllFlags` 那个 16 位 ID 表，所以没有 65535 的限制，表满了会自动扩容。
- 代价是每个对象的每个变量都存一份完整的 `CString` 键：**名字超过 15 个字符就要单独堆分配**，每次访问都要对整个名字算一遍 `PMurHash32`。名字越长，哈希和比较越慢。变量也会随对象一起写进存档，多了会让存档变大。
- 以"每个人口组 / 每个星球都 `set_variable`"的方式大规模使用，会带来明显的内存和存档体积增长，但不会像动态 flag 那样撞上上限。

**数值上限**：
- `CFixedPoint` 是 **int64，按 100000 缩放**（见 `CMultiplyVariableEffect` 6108327：`(lVar6 * lVar5) / 100000`）：
  - 精度 **0.00001**；
  - 范围约 **±92,233,720,368,547**（2⁶³ / 10⁵）。
- **`change_variable` 没有溢出检查**（`CChangeVariableEffect::ExecuteActual` 6107468）：
  ```c
  CVariables::SetVariable(this_00, pCVar1, lVar2 + lVar3);   // 裸 64 位加法：溢出后静默回绕成负数
  ```
- `multiply_variable`（6108326）：两个原始值都小于 0xb504f333（约 30370.6）时直接相乘再除以 10⁵；否则用"大数拆成整数部分和小数部分"的分段乘法，避免中间结果溢出，但**最终结果超过范围时仍然会溢出**。
- `divide_variable`（6108623）会检查除数为 0，并分段除法以保持精度。
- `multiply_variable` / `divide_variable` 在变量**不存在**时会写错误日志（6108342、6108601），`change_variable` 不存在时当作 0 处理。
- 注：变量值用在其他地方（本地化显示、modifier、某些转成 32 位整数的 trigger）时是否还会被截断，没有逐一核实。

**读取开销：凡是"值来自变量"的地方都会拷贝一次作用域，跨作用域读取还要再加**：

`CFixedPointVariableValue::GetValue(CEventScope const&)`（1595036–1595293）是 `set_variable = { value = … }`、`change_variable`、`check_variable = { value = … }`、`multiply_variable` 等所有"值"参数的求值入口：
```c
if (*(long *)(this + 0x208) == 0) { uVar3 = *(this + 0x220); }         // 字面量：直接返回，没有开销
else {
  CEventScope::CEventScope(local_310, param_1);                        // 1595062：不管是不是跨作用域，都完整拷贝一次（带容器时深拷贝）
  do { … 按 token 类型 switch …                                         //   逐个遍历 token 链
       pCVar4 = *(CEventTarget **)(pCVar4 + 0x188); } while (pCVar4);
  CEventTarget::GetScope(local_1a0, this_00);                          // 有作用域前缀时：递归解析（见 B8，每一段一次拷贝）
  CEventScope::operator=(local_310, local_1a0);                        //   再做一次拷贝赋值（又一次 Copy）
  … 析构 local_1a0 …
  // 没有作用域前缀时走 caseD_3249：
  uVar3 = GetValueInternal(this, local_310);                           // 1595277：在拷贝出来的作用域上查变量
  … 析构 local_310 …
}
```
然后 `GetValueInternal` → `GetVariablePointer`（1584602）：每次都构造 `CString("local_")` 并执行 `StartsWith`，再对变量名算 `PMurHash32`，最后在 robin-hood 表里查找。

| 写法 | 开销 |
|---|---|
| `value = 5`（字面量） | 几乎为 0 |
| `value = my_var`（同作用域） | **1 次完整的作用域拷贝和析构**（事件根作用域带事件目标或 `local_` 变量时，还要深拷贝整个容器）+ 构造一次 `"local_"` 字符串 + 一次哈希查找 |
| `value = owner.my_var` / `prev.my_var` / `event_target:x.my_var`（跨作用域） | 上面那些，**再加上**：链上每一段一次递归 `GetScope`（每段一次作用域拷贝加析构，见 B8），外加一次拷贝赋值 |
| 在别的作用域上**写**变量：`owner = { set_variable = … }` | 一次作用域切换（B8），然后在该对象上做一次哈希写入。写入本身是 O(1) |

**结论**：
- 同作用域读变量本身不贵，但每次都要**白拷贝一次作用域**，这纯属实现上的浪费（非 const 重载 1594736 就不拷贝）。
- 跨作用域读取的额外开销和链的长度成正比，每一段都要一次作用域拷贝；如果事件带着局部状态，每次拷贝还要深拷贝容器。
- 在高频循环里（例如 `every_owned_pop_group` 里写 `check_variable = { which = x value = owner.y }`），更好的做法是**先在外层把值读到当前作用域**（`set_variable = { which = tmp value = owner.y }` 只做一次），循环里只和 `tmp` 比较；或者先切换作用域再比较（`owner = { check_variable = … }`）。
- 变量名尽量**短于 16 个字符**，避免每个对象、每个变量都要堆分配，同时也让哈希更快。
- 会不断累加的变量要自己钳制（`clamp_variable`，或者先判断再加），否则 `change_variable` 溢出后会静默变成负数。

**结论**：
- 对象上 flag 少（几个到几十个）时，静态 `has_flag` 比 `check_variable` 更便宜，因为不用哈希字符串。
- global flag 数量多时，`has_global_flag` 会变慢，可以改用 global 变量或 global 事件目标（后者是排序数组，O(log n)）。
- **动态 flag 是最贵的一种**，还会永久占用名字空间。

**引擎修复**：
- 每个对象的 flag 改成排序数组加二分，或者用小位图；global flag 用哈希集合；
- 动态 flag 改用（基础 flag ID，对象 ID）的二元组做键，不再生成字符串名；
- 变量名在解析时就预先算好哈希。

---

## B. 事件目标（event target）

总体结论：**成立**。名字查找的复杂度（局部 O(n)、global O(log n)）本身还算可以接受，但还有 O(1) 的优化空间；真正的大头是每次跳转都要构造、深拷贝、析构一整个作用域，以及动态名字（见 **B8**，基于 Windows 反汇编）。

### B0 已经做对的部分（仍有优化空间，见 B8-(4)）
- 静态的 `event_target:x` 在**解析时**就转成了 16 位 flag ID（`CEventTarget::ParseForSpecialValues` 约 2482032：`strncmp(..."event_target:")` → `CreateFlagIndex`），求值时没有字符串操作。
- global 事件目标存放在**排序数组**里（`CGameState+0x138`）：`GetSavedEventTarget`（437384）和 `ClearSavedEventTargetFromArray`（437219）用 lower_bound 二分查找；`SaveEventTargetToArray`（436523）是有序插入。

### B1 局部（事件链）目标：先回溯到根，再线性扫描（影响：低）
- `CEventScope::GetSavedEventTarget`（2476257）和 `SaveEventTarget`（2476160）都是先 `do { this = *(this+0x38); } while (...)` 回溯到根作用域，再对无序数组做线性扫描。保存时同样先线性查重，再追加到末尾。
- 规模一般 N=1–30、深度 1–6，所以开销可以忽略，只是和 global 那边的排序实现不一致。

### B2 ✅ 作用域拷贝会深拷贝事件目标容器，而拷贝永不被读（影响：中；详见 02-S3）
- `CEventScope::Copy`（2467761）：`*(this+0x38) = *(param_1+0x38)` 让拷贝的根指针指回原作用域的根；随后 2467811 用 `PdxMakeScopedPtr<CEventTargetContainer>` 深拷贝 `+0x48`：`operator_new(0x50)`，复制两个 `CSavedEventTarget` 数组，再复制局部变量的 `CString→CFixedPoint` 哈希表。
- **即使拷贝的是根作用域，这份拷贝也用不上**：读取方都沿 `+0x38` 回到原作用域的根。唯一直接读自身 `+0x48` 的 `SwapEventTargetContainerWithBaseScope`（2476128）没有调用方。
- **快照拷贝会放大这个开销**：`CEventScope::CopyInternalScopes`（2468427）为 root、from、prev 各分配一次 `operator_new(0x170)` 并拷贝，再递归处理；root 和 prev 常常是同一个对象，却被拷贝两次。约 106 个调用点，包括 `CDelayedEvent` 的构造和赋值（2289163/2289181/2289208）、`CActiveEventChain`、`COnActionCommand`、舰队行动、任务等。
- **影响**：每个排队中或延迟的事件、每次 on_action、每个事件链快照，都要为所有 saved target 和 `local_` 变量付出堆分配和字符串复制，而且作用域链上每一层都付一次。

### B3 ✅ 跨作用域读取变量时深拷贝调用方的作用域，然后丢弃（影响：中）
- `CFixedPointVariableValue::GetValue(CEventScope const&) const`（1595036）：
  ```c
  if (*(long *)(this + 0x208) == 0) { uVar3 = *(this + 0x220); }       // 字面值
  else {
    CEventScope::CEventScope((CEventScope *)local_310,param_1);        // 完整 Copy（含 +0x48 深拷贝）
    … 逐个遍历 token 链的大 switch …
    CEventTarget::GetScope(…);  CEventScope::operator=(local_310, …);  // 拷贝出来的容器随即被丢弃
  ```
- 只要值是从另一个作用域读取的（例如 `value = owner.my_var`、`event_target:x.var`），**每次求值**都要做一次这样的拷贝。trigger、effect 和 script value 都会走到这里，每月、每日的 pulse 也一样。非 const 的重载（1594736）不做这次拷贝，说明它是不必要的。
- **修复**：直接用 `GetScope` 的结果构造作用域，或者改走非 const 的路径。

### B4 每次解析 `event_target:` 都要构造并析构一整个 `CEventScope`（影响：中；置信度：对象构造高，总开销中）
- `CEventTarget::GetScope` 按值返回一个约 0x170 字节的 `CEventScope`。每个调用方都要析构它：`CPdxHybridArray<CEventScopeParameter,4>` 的析构、3 次虚删除（`+0x50/58/60`），以及 `SDelete<CEventTargetContainer>`。例如 `GetScopeCountry`（2485538）、`ProcessDynamicFlag`（1584280）、`CVariableValue::ProcessScope`（1594446）。
- 解析顺序（从 `CGameText::GetScope` 394991 推断）是先查局部（线性），无效再查 global。所以只存在于 global 的名字每次都要先付一次失败的局部扫描。
- 注：`CEventTarget::GetScope(CEventScope&, char const*)` 本体没能反编译出来（2483482），这一条是从它的调用方推断的。

### B5 动态事件目标名（`save_event_target_as = x@root`）：每次使用都拼字符串，永不回收，表满后静默冲突（影响：对 mod 高）
- 每次使用都走 A3 的 `ProcessDynamicFlag`：嵌套一次 `GetScope`，拼字符串，哈希查找。
- 保存时 `CreateDynamicFlag` 把名字永久加入 `_AllFlags`，与普通 flag **共用同一个** 65535 的空间。
- `CSaveEventTargetAsEffect::ExecuteActual`（5976208）和 `CSaveGlobalEventTargetAsEffect`（约 5976500）**不检查 `0xffff`**。表满后，所有保存失败的动态目标都写到同一个键 `0xffff` 上，互相覆盖。

### B6 global 事件目标从不自动清理（影响：低）
- 只能通过 `clear_global_event_target`（5976809）或 `clear_global_event_targets`（437444）移除，没有任何清理已失效对象的逻辑。它们只占内存和存档体积，不影响正确性。

### B7 tooltip 会往 global tooltip 数组里写入（影响：低，只影响 UI）
- `CSaveGlobalEventTargetAsEffect::GetDesc`（约 5976440）在生成 tooltip 时调用 `SaveEventTargetTooltip`，插入 `CGameState+0x150`。

### B8 ✅ 深挖：作用域跳转与事件目标的真实成本（反汇编了 Windows 4.5 `stellaris.exe`）

Linux 反编译里 `CEventTarget::GetScope` 是空的，所以这一节直接反汇编了 Windows 版 `stellaris.exe`：先用错误字符串 `"Script Error: Invalid context switch"` 找到 `CContextTrigger::Evaluate`（RVA 0x16dd040）和 `CContextEffect::Execute`（RVA 0x1948b20），它们的第一个调用都是 `GetScope`，**RVA 0x352950**，约 4900 条指令。

**前面 B0 说"静态名字查找是好的"，这个说法太宽松了，这里更正。** 真正的成本不在二分或线性查找本身，而在下面几点。每一点都有明确的优化空间。

#### (1) 每解析一段，都要先完整拷贝一次源作用域
```
352950: sub rsp, 0x748                   ; 每层递归约 1.8 KB 栈帧
35298d: call 0x1403909e0                 ; = CEventScope(CEventScope const&)：设置 +0x30/38/40=this，+0x70 HybridArray，然后调用 Copy
3529a9: mov ecx, dword ptr [r13 + 0x68]  ; 之后才按 token（prev/from/root/owner/…）分派
```
`0x1403909e0` 最后调用的 `0x140393ee0` 就是 `Copy`：源作用域的 `+0x48` 不为空时，执行 `operator new`（0x1420213e8），再做两次 `CPdxArray<CSavedEventTarget>` 拷贝（0x397040）和一次 `CString→CFixedPoint` 哈希表拷贝（0x397480）。**只要事件的根作用域存过任何事件目标或 `local_` 变量，之后每一次作用域切换都要把这些东西整份深拷贝一遍**，然后在析构时整份释放。

#### (2) 点号链 `prev.prev.from` 是逐段递归，每段一次完整的作用域构造、拷贝和析构
```
357136: mov rax,[r14+0x30]; mov [rsi+0x30],rax; mov [rsi+0x40],r14   ; 结果的 prev 指向输入
357142: lea rcx,[r13+0x188]; call 0x14034ef00                        ; 还有下一段吗？
35716f: call 0x140352950                                             ; 递归 GetScope(下一段, 输入=当前结果)
35717a: call 0x140390c40                                             ; move 赋值回结果
357183: call 0x140236060                                             ; 析构临时 CEventScope
```
- `prev.prev.prev.from` 就是 **4 层递归**。每层都有：一次 `CEventScope` 构造和 `Copy`（带容器时加上深拷贝）、一次 move 赋值、一次析构，以及 1.8 KB 的栈帧。
- **每次引用都要重新解析整条链**，没有缓存。同一个事件里写 5 次 `prev.prev.from = { … }`，就是 20 次递归。
- 部分关键字本身就是复合跳转，每一步还要构造、析构一个临时 `CEventTarget`（约 0x1a0 字节）。例如 354eeb–354f4c 处先 `CEventTarget(0x2c99)` 递归一次，再 `CEventTarget(0x2b52)` 从上一步结果再递归一次；354acd 处是 `CEventTarget(0x2a19)` 递归一次。
- 调用方（如 `CContextTrigger::Evaluate` 6747717）拿到的结果还要再析构一次：`~CPdxHybridArray`、3 次虚删除、`SDelete<CEventTargetContainer>`。

**理想的开销**：`prev`/`from`/`root` 只是指针跳转，每段应该是 O(1) 的几条指令。**现在的开销**：每段几百到上千条指令；如果根作用域带容器，每段还要额外做 1 次 malloc、2 次数组拷贝和 1 次哈希表拷贝（键是 `CString`，超过 15 个字符就要堆分配），最后再全部释放。

#### (3) 切换失败且没写 `?` 时，会把整个作用域序列化进内存文件
`CContextTrigger::Evaluate`（Linux 6747720–6747761）和 `CContextEffect::Execute`（5897546–5897588）在目标无效、又没有 `?` 标记（`+0x199`）时，会依次执行 `CBlob`、`CMemoryFile`（`operator_new(0xa0)`）、`CWriter`，然后调用 `param_1->vtbl[0x18]`，**把当前作用域完整写出来**，拼成错误日志。所以常常失败的 `prev.prev.from = { … }`（例如事件从不同入口触发时 `from` 链可能不存在）每次都要付出序列化加写日志的代价。
- **mod 侧**：可能不存在的跳转一律写成 `from.from? = { … }` 或 `event_target:x? = { … }`（`?` 会让解析时置 `this[0x199]`），或者先用 `exists = prev.prev.from` 判断。

#### (4) 事件目标存放在哪里，查找的实际代价
| 类型 | 存储位置 | 元素 | 查找 | 额外开销 |
|---|---|---|---|---|
| 局部（`save_event_target_as`） | 根作用域的 `+0x48` → `CEventTargetContainer`（0x50 字节：两个 `CPdxArray<CSavedEventTarget>`，即目标和 tooltip 目标，再加局部变量的 `CVariables` 哈希表） | `CSavedEventTarget`，**46 字节（0x2e）不对齐步长**，键是 `+0x2c` 处的 `ushort` | 先沿 `+0x38` 回溯到根，再**线性**扫描 | 保存时先线性查重再追加；另一个重载 `SaveEventTarget(CSavedEventTarget const&)`（2468263）直接追加、不查重 |
| global（`save_global_event_target_as`） | `CGameState+0x138`（tooltip 副本在 `+0x150`） | 同上 46 字节 | 有序数组上 lower_bound **二分** | `CGameState::GetSavedEventTarget`（437384）**每次查找都构造并析构一个临时 `CSavedEventTarget`**；插入和删除要 memmove |
| 解析顺序（Windows 3578fe–357960） | — | — | 先查局部（`0x394350`），无效再查第二个局部表（`0x3942f0`），还无效才查 global（`0x26eb40`） | **只存在于 global 的目标每次都要先付两次失败的局部扫描** |

**关于"前缀树"**：名字在**解析时**就已经通过 `CreateFlagIndex` 变成了 16 位整数 ID（`ParseForSpecialValues` 约 2482032），运行时不再比较字符串。所以这里其实用不着前缀树，更好的做法是**直接按 ID 索引，做到 O(1)**：
- global：用 65536 项的稀疏表或开放寻址的 `ushort→slot` 哈希，取代二分，也省掉每次查找构造、析构临时对象的开销；
- 局部：每个事件链只需要一张按 ID 索引的小表（或排序的小数组），不要每次都回溯到根再线性扫描；
- 查找顺序：给每个名字记一个"这是局部名还是 global 名"的位，避免无谓的局部扫描；
- **最大的收益其实在返回值上**：`GetScope` 应该返回一个 8–12 字节的轻量引用（类型 + 对象 ID），而不是一个 0x170 字节、需要深拷贝和析构的 `CEventScope`；子作用域共享根作用域的容器指针，不再拷贝。这一项改动就能同时消除 (1)(2)，以及 B2、B3 里的全部拷贝。

#### (5) ✅ `save_event_target_as = x@scope` 同样走动态 flag 那条路
```c
// CSaveEventTargetAsEffect::ExecuteActual 5976212
if (*(long *)(this + 0xd8) == 0) uVar1 = *(ushort *)(this + 0xb8);          // 静态名：解析时就有 ID
else uVar1 = CreateDynamicFlag(param_1,(CEventTarget *)(this + 0xf0),...);  // x@scope：每次执行都拼字符串
CEventScope::SaveEventTarget(param_1,uVar1,param_1);
```
- **保存时**：每次执行都要做 `ProcessDynamicFlag`：一次嵌套的 `GetScope`（包含上面 (1) 的作用域拷贝）、`CString::Reserve`、两次 `operator+=`（名字和对象 ID）、一次 Murmur 哈希，再把名字**永久**插入 `_AllFlags`。
- **读取时**（`event_target:x@scope`）：Windows 3578cf 处先调用 `0x1409f8a10` 解析动态名，同样是嵌套 `GetScope` 加字符串拼接和哈希，然后才进入 (4) 的查找。
- **与 flag 共用同一个 65535 空间**：每个不同的 `x@<对象>` 都永久占用一个 ID；表满后返回 `0xffff`，而 `SaveEventTarget` 不检查这个值，于是所有保存失败的名字都落到同一个键上，**互相覆盖，并且不报任何错**。

#### (6) ✅ `@` 动态事件目标的完整问题清单（`save_event_target_as = x@scope` / `save_global_event_target_as = x@scope` / `event_target:x@scope`）

**名字是怎么生成的**：
- 加载时，`ReadAsDynamicFlag`（1584003）用 `CString::Find(param_1,'@',0)` 在第一个 `@` 处切开：前半部分是基础名（存进 effect 的 `+0xc0`），后半部分用 `CStaticLexer::FindTok` 转成 token，再构造成一个 `CEventTarget`（存进 `+0xf0`，可以是 `root`、`from`、`owner`、`event_target:y` 等任意作用域链）。
- 运行时由 `ProcessDynamicFlag`（1584280）拼接：
  ```c
  CString::Reserve(param_1, size + 10);
  CEventTarget::GetScope(local_1a0, target);      // 解析 @ 后面的作用域：B8 的全部开销（递归、作用域拷贝）
  if (CScopeObjectReference::IsValid()) {
      param_1 += 基础名;
      param_1 += CString(local_190);              // local_190 = 解析出的作用域 +0x10，也就是对象的完整 32 位 ID（含代号位），转成十进制
  }
  ```
  然后 `CreateDynamicFlag` / `GetDynamicFlag` 对这个字符串做 Murmur 哈希，在 `_AllFlags` 里查找或插入。

**存在的问题**：

1. **每次使用都有固定的高开销**：保存和读取都要 1 次 `GetScope`（包括作用域拷贝，`@` 后面是链时还要逐段递归）、1 次 `Reserve`、2 次 `operator+=`、1 次整数转字符串、1 次 Murmur 哈希加 robin-hood 探查，最后才去做 B8-(4) 的事件目标查找。而静态名在解析时就已经有 16 位 ID 了，这些步骤一个都不需要。

2. **每个不同的对象都会永久占用一个全局 ID**，而且和所有 flag 共用同一个 65535 空间（A3）：`CreateFlagIndex` 同时把字符串插入 `_AllFlags` 和 `_AllFlagsReverse`，整局游戏都不释放。
   - **因为用的是带代号位的完整 ID**，对象销毁后槽位被复用，新对象的 ID 也不同，所以不会串到新对象上（这是好的）。但副作用是：在舰船、人口组、领袖这类**不断生灭**的对象上用 `@this`，会源源不断地产生新名字，**消耗 ID 空间的速度远超对象的实际数量**。

3. **表满后静默冲突**：`CreateFlagIndex` 返回 `0xffff`，`CSaveEventTargetAsEffect::ExecuteActual`（5976230）不检查这个值，照样执行 `SaveEventTarget(param_1, 0xffff, …)`。于是**所有保存失败的动态目标都写到同一个键 `0xffff` 上**，互相覆盖。

4. **推断出的读取串号问题**（置信度：中）：读取时用的是 `GetDynamicFlag` → `GetFlagIndex`，没找到就返回 `0xffff`，并不新建名字。所以 `event_target:x@y` 读一个**从未保存过**的名字时，查找键就是 `0xffff`；如果之前有任何一次动态保存因为表满失败、落在了 `0xffff` 上，**这次读取就会拿到那个毫不相干的对象**，而不是"不存在"。

5. **`@` 后面的作用域无效时，每次都写一行错误日志**：
   - `ProcessDynamicFlag` 在作用域无效时返回空串；
   - 保存路径 `CreateDynamicFlag` 会格式化并写入 `"Could not create dynamic flag '%s' with target '%s' in scope: '%s' at %s"`，然后返回 `0xffff`（于是又落到第 3 条）；
   - 读取路径 `GetDynamicFlag(..., true)` 会写 `"Could not get dynamic flag …"`。
   - 每次都要调用 `GetTokenString`、`GetScopeTypeTokenFromEnum` 并格式化字符串。在循环或 pulse 里触发时，这是持续的开销，还会让 error.log 膨胀。

6. **目标数组只增不减**：每个不同的 `x@对象` 在事件目标数组里都是**单独一条记录**。global 数组是有序的，插入时要 memmove，是 O(n)；而且 global 目标从不自动清理（B6），失效对象对应的记录会一直留着，还会写进存档。批量执行 `save_global_event_target_as = x@this` 会让这个数组和存档都不断膨胀。

7. **✅ 实测：拼接时没有分隔符，不同的基础名会撞到同一个名字**。在运行中的游戏里读取 `_AllFlagsReverse`，全部 65535 个名字里**没有一个带 `@`**，动态名就是"基础名"和"十进制 ID"直接拼在一起（例如 `stress30898`）。所以：
   - `foo1@(ID 23)` 和 `foo12@(ID 3)` 都会变成 `foo123`，**两个不同的动态名会指向同一个 flag 或事件目标**；
   - 动态名还可能和某个恰好叫 `foo123` 的**静态** flag 撞名。
   - 基础名以数字结尾时尤其危险（`wave1@this`、`wave12@this`……）。

8. **✅ 实测：名字表是进程级的，读档和开新局都不会清空**。在同一个进程里连开三局：
   - 相同的"基础名 + ID"字符串会复用已有的条目；
   - 不同的字符串会一直累积，直到 65535。
   只有退出游戏才能清空。**长时间游玩、反复读档，或者一个会不断生成新动态名的 mod，都可能在一次会话里把表填满**；之后读档时，存档里带的新 flag 名也无法再分配 ID（推断）。

**表满后的影响范围**（引擎共 75 处 `CreateFlagIndex` 调用，只有"表满后才第一次出现的新名字"会受影响）：
| 类别 | 是否受影响 | 表现 |
|---|---|---|
| 脚本文件里直接写出来的 flag 名、事件目标名 | ❌ 不受影响 | 启动加载脚本时就已分配 ID（本次测试的 modlist 启动时约占用 1.2 万个） |
| 表满前已经出现过的动态名、引擎内置名 | ❌ 不受影响 | 已有 ID，`CreateFlagIndex` 先 Find，直接返回 |
| 新的动态 flag `x@y` | ✅ 静默失效 | 设置失败，`has_*_flag` 永远为假 |
| 新的动态事件目标 `x@y` | ✅ **串号（最危险）** | 全部存进 `0xffff` 互相覆盖；读取任何新名字都拿到最后一次存进去的对象，effect 可能作用到错误的对象上 |
| **读档**（✅ 代码确认） | ✅ **flag 丢失 + 事件目标串号，存档后永久** | `CPdxIntegerFlags::ReadMember`（7062284 / 7062294）：`sVar2 = CreateFlagIndex(name); … if (sVar2 != -1) InsertAtEmplace(…)`，申请失败的 flag **直接跳过、不写日志**。`CSavedEventTarget::ReadMember`（2479392）：`*(this+0x2c) = CreateFlagIndex(name)`，**不检查**，所有申请失败的目标都以 `0xffff` 为键进入数组。这时再存档，丢掉的 flag 就永久消失了。**这不只发生在"同一进程反复读档"时：如果一个存档本身包含的不同 flag/目标名超过"65535 − 游戏数据已占用的名字数"（本次 modlist 约 5.3 万），即使重启后读取也会丢数据** |
| 引擎按需创建的内置名字（第一次用到发生在表满之后时） | ✅ 对应机制悄悄失灵 | 例如 `"has_negotiated_trade_deal"`（`CTradeDeal::ExecuteAccept` 1538545）、`"has_ever_appeared"`（`CAmbientObjectGraphicsManager::Update`）、灵能光环、星界裂隙阶段事件、`add_point_of_interest` 的 POI ID（`CPointOfInterest::SetIDIfInvalid` 1038351，拿到 `0xffff` 即 `GetErrorFlag`，被当作无效） |
| 控制台里输入的新名字 | ✅ | 同上 |

**实际风险**：纯原版正常游玩几乎不可能填满。风险组合是"**mod 大量使用 `@` 动态名**"加上"**同一次启动里长时间游玩或反复读档**"，因为每读一个档都会带进一批新名字，只增不减。可以用 `tools/live_flags.py` 随时查看占用率。

**实测结果汇总**（2026-09-29，Windows 4.5.1，控制台测试见 `console_tests/dynamic_flag_tests.md`，内存读取工具 `tools/live_flags.py`）：
| 结论 | 状态 |
|---|---|
| 名字表上限 65535，表满后**不写任何日志** | ✅ 实测：`_AllFlags+8`（下一个 ID）= 0xffff，名字数 = 65535，error.log 里没有任何相关错误 |
| 表满后**静态 flag 静默设置失败**（`SetFlag` 拒绝 `0xffff`，所以 flag 之间不会串号） | ✅ 实测：`probe_set_9/10/12` 没有进入名字表，玩家国家身上也没有这几个 flag，也没有 ID 为 0xffff 的条目；T3 探针始终没有 alias |
| 表满后**事件目标会串号**：保存落在 `0xffff`，读取从未保存过的名字也得到 `0xffff`，于是拿到别的对象 | ✅ 实测：T4b 输出 "ALIAS"；T4a 的 "saved and found" 其实也是同一原因（`dyntgt0` 并不在名字表里） |
| 动态名没有分隔符，存在跨基础名的撞名 | ✅ 实测：65535 个名字里 0 个带 `@`；`stress123` 只有一个 ID（10150） |
| 读取路径不会创建新名字 | ✅ Windows 反汇编：`GetScope` 调用的 0x9f8a10 是 `GetDynamicFlag`，它调用 `GetFlagIndex`（0x1a7dc00），只查找不插入 |
| 名字表跨读档和新局持续存在 | ✅ 实测：同一进程开了 3 局，名字一直累积 |

**mod 建议**：
- 动态名的基础名**不要以数字结尾**；如果一定要带数字，就在末尾加一个非数字的分隔字符（例如 `wave1_@this`），避免 `wave1`+`23` 和 `wave12`+`3` 撞名。
- 能用静态名就用静态名。需要"按对象区分"时，优先在对象本身上存变量或 flag（`set_variable` 没有 65535 上限，见 A5），或者直接在对象的作用域里操作，而不是用 `x@对象` 去全局命名。
- 绝不要在舰船、人口组、领袖这类频繁生灭的对象上批量用 `@this` 保存目标。
- 用 `x@scope` 之前，先确认 `@` 后面的作用域存在（`exists`），避免每次都写错误日志并落到 `0xffff`。
- 不再需要的 global 动态目标，及时 `clear_global_event_target`。

#### mod 写法建议（按收益排序）
1. **同一条链只解析一次**：把 `prev.prev.from = { A }  prev.prev.from = { B }` 改成 `prev = { prev = { from = { A B } } }`，或者直接写成一个 `prev.prev.from = { A B }` 块。每多写一次引用，就多一整条链的递归和拷贝。
2. **在做大量作用域切换的事件里，少用 `local_` 变量和局部事件目标**：只要根作用域带有容器，之后每一跳都要把它整份深拷贝一遍。必须用时，尽量放在没有深层跳转的地方。
3. **可能失败的跳转都加 `?`**，否则每次失败都要序列化作用域并写日志。
4. **不要用 `x@this` 这种动态名批量保存目标**（比如对每个星球或人口都保存一个）。改用变量，或者在对象上打静态 flag。
5. 需要跨事件共享的对象，用 global 目标（有序数组，O(log n)），而不是在很多事件里反复从局部链上找。

---

## C. ✅ `CGameRules`（`common/game_rules`）完全不缓存（结论：成立）
- 以 `CGameRules::CanColonizePlanet`（372249–372351）为例，其余 80 多个 `CGameRules::Can*/Is*` 都是同一个模板：
  ```c
  CEventScope::CEventScope(&local_1a8);  SetCountry(&local_1a8, country);
  CEventScope::CEventScope(&local_318);  SetPlanet(&local_318, planet);
  uVar1 = CScriptedRule::Evaluate((CScriptedRule *)(this + 0x1040), &local_318, reason, 0, 0);
  … 析构两个 CEventScope（HybridArray、3 次虚删除、SDelete）…
  ```
  每次调用都要构造、析构两个完整的作用域，再从头求值一遍脚本规则。**没有任何按参数的记忆化，也没有按日的缓存。**
- **高频调用点**（本报告其他章节已提到）：
  - `CanAiAssignGovernor`：领袖窗口打开期间，每帧对每个殖民地调用一次（01-U5）；
  - `CanColonyReceiveAutoMigration`：每月按"来源 × 目的地"调用（03-P7）；
  - `CanPopGroupVote` / `CanPopGroupJoinFactions`：按人口组调用；
  - `IsCountryPsionic`：战斗中每次命中调用一次（见 F）。
- **修复**：只依赖国家的规则（如 `IsCountryPsionic`、`CanHaveRobotPops`、`CanSubjugateEmpires`）按国家每天缓存一次；有两个参数的规则按（国家，对象）在每个 tick 内缓存。
- **mod 侧**：`game_rules` 里的脚本要极其便宜，它们会以难以预料的高频率被调用。

---

## D. ✅ 已研究科技数量：每次都扫描已研究数组（结论：成立）
- `num_researched_techs` → `CNumResearchedTechsTrigger::GetTriggerValue`（6853583）→ `CTechnologyStatus::CalcTotalTechLevels`（1504173–1504236）：对全部已研究条目（`this+0x20`，步长 0x28，数量 `+0x2c`）求和 `+8` 字段，每次调用都是 O(T)，结果不缓存。编译器做了 8 路展开，每个元素的开销很小。
- `num_researched_techs_of_tier` → `CalcNumTechsOfTier`（1504302–1504323）：同样是 O(T)，而且每个元素还要**多跳一次指针**（`*(entry+0x10) + 0x658`，取科技对应的 tier），缓存未命中更多。
- `CalcNumRareTechs`（1509335）和 `CalcNumDangerousTechs`（1509360）也都是全量扫描。
- 对比：`has_technology`（`CTechnologyStatus::HasTechnology` 1504273）通过下标表直接定位，是 O(1)，没问题。
- **规模**：T 是 400–1000+（大型科技 mod 加上可重复科技）。在 AI 权重、科技 `weight_modifier`、按月 pulse 里对每个国家反复求值时，开销会叠加。
- **修复**：在研究完成时增量维护总数和按 tier 的计数器。

---

## E. 舰队管理器和舰船计数

结论：**部分成立**。舰船**总数**和舰队规模其实是缓存的；没有缓存的是**按设计、按尺寸**的计数。最贵的调用方在舰队管理器 UI 和"增援"按钮里，不在每日模拟里。

### E0 ✅ 已缓存、是 O(1) 的部分（纠正"舰队不缓存舰船数"）
- 舰队的舰船数组长度就是 `fleet+0x32c`，O(1)。
- `fleet_size` trigger（`CFleetSizeTrigger::GetTriggerValue` 6807131）直接读 `fleet+0x1280`，这是缓存的舰队规模：由 `CFleet::UpdateFleetSize`（3218690）全量计算，`RemoveShipAtIndex`（3224228）增量更新。
- 舰队战力：`CFleet::GetMilitaryPower`（3240187）读缓存 `+0x308`。
- 国家的舰队规模和已用海军容量：`country+0x2fe8` / `+0x2ff0`，只在舰队增删和 `CalcCachedEmpireData` 时重算；`used_naval_capacity_integer` 是 O(1)。

### E1 ✅ 按设计计数没有缓存：`CountShipsForDesign` 遍历舰队的每一艘船
- `CFleetTemplateManager::CountShipsForDesign`（3418183）：对舰队的每艘船做一次数据库查找，再调用 4 次虚函数（设计的 `+0x10`/`+0x50` 和船的 `+0x480` 子对象的 `+0x10`/`+0x50`），必要时还调用 `GetDesignToUse`。
- `CountReinforcementsForDesign`（3418250）：遍历排队中的增援舰队（`fleet+0x1240/+0x124c`），对每一支调用 `CountShipsForDesign`。
- `CalcWantedShipsToReinforce`（3417618–3417752）：对模板里的每个设计，**两轮循环**分别调用 `CountReinforcementsForDesign` 和 `CountShipsForDesign`。每个模板的开销是 **D × (S + 2R)** 次舰船访问（D 为设计数，S 为舰船数，R 为增援舰船数）。
- `CalcAllShipsToReinforce`（3415801）遍历国家的**所有模板**，于是总开销是 **Σ模板 D·(S+2R) ≈ 平均设计数 × 全国舰船数 × 4 次虚调用**，再加上每个模板的 `CalcBuildLocations`。这正对应"遍历舰队 → 遍历舰船设计 → 遍历舰队每艘船"。

### E2 ✅ 舰队管理器窗口打开时，每秒重算 7–18 次，按时间节流而不是按 dirty
- `CFleetManagerView::Update`（4069992）：`this[0x2d90] = NGuiUtil::ShouldUpdateExpensiveThisFrame(8)`，置位时调用 `CalcAllShipsToReinforce`。
- `ShouldUpdateExpensiveThisFrame`（4345938）的实现是 `(int)(clock*100) % 8 == 0`，也就是每 80 ms 中有 10 ms 为真。60 fps 时约每秒 7 次，144 fps 时约每秒 18 次。**什么都没变也会一直重算。**
- **修复**：按国家缓存 `SCalcShipsToReinforceResult`，在 `OnShipAdded` / `OnShipRemoved` / `OnShipUpgraded`（3413785–3414043，这些钩子已经存在）、模板编辑、建造队列变化时置 dirty。

### E3 舰队管理器每帧的其他工作（置信度：高）
- **模板网格**：每个模板项每帧调用 `CFleet::BuildFleetOffensivePowerString`（3236985），逐船调用 `CShip::CalcMilitaryPower(true)`，合计每帧 O(全国舰船数)，而舰队战力明明已经缓存在 `fleet+0x308`。
- **选中模板的设计列表**：`CFleetManagerCurrentTemplateShipDesignGridEntry::Update`（4087286）对每个设计调用两次 `CountShipsForDesign`（4087382/4087548），再调用 `CFleetTemplate::CanAddDesign`（4087550）。
- **`CanAddDesign`**（3410281）→ `CCountryFleetsManager::CalcTotalShipsOfSize`（2178944）：遍历全国舰队 × `CountShipsWithShipSize`（逐船），再加上 `CalcShipsUnderConstructionOfSize`（扫描建造队列）；随后调用 `CalculateRelatedReservedCapacity`（3410669），里面还有设计数 × `CountShipsForDesign`。在调用 `CalcTotalShipsOfSize` 之前没有看到"该尺寸是否有数量上限"的判断。
- **合计**：每帧约 D_选中 × (全国舰船数 + 建造队列 + D·S)。
- **修复**：按国家维护 `ships_by_size[]` 和 `ships_by_design[]` 计数器，在已有的 `+0x1280` 增量更新处一并维护；`BuildFleetOffensivePowerString` 改读缓存的 `+0x308`。

### E4 联邦舰队和银河防卫军的已用容量每次都重算
- `CFederation::CalcUsedNavalCapacity`（2494713）每次调用都要遍历领袖国的舰队，再遍历**所有成员国**的全部建造队列条目（每项一次虚 `dynamic_cast`）。`CGalacticDefenseForce::CalcUsedNavalCapacity`（2567203）类似。
- 它会被 `CalcCurrentFleetSizeForOwner`（3417300）调用，于是对每个联邦模板都要在 E2 的每秒 7–18 次重算里再执行一遍。

### E5 `num_ships` trigger 是逐船计数
- `CNumShipsTrigger::CountShipsInScope`（6839977）：舰队作用域是 O(S)，每艘船一次虚调用（`+0x88`，大概是"是否存活"）；国家作用域是全部舰队 × 全部舰船。因为要过滤存活状态，所以不能直接用 `+0x32c`。
- **修复**：在 `+0x2fe8` 旁边维护一个按国家的存活舰船计数器。
- **mod 侧**：优先用 O(1) 的 `fleet_size` 和 `used_naval_capacity_integer`，少在高频 trigger 里用国家作用域的 `num_ships`。

---

## F. AoE（collateral）与连锁（chain）武器

结论：**部分成立**。"O(星系内舰船数)"和"连锁 O(连锁次数 × 星系内舰船数)"都成立。但物种特质那一项**不是**乘在每个候选舰船上的，而是只乘在**实际命中**的舰船上；而且扫的是**受击方**控制国主物种的特质，不是开火方的。

### F1 ✅ 代码位置与嵌套
都在 `CWeaponComponent::Shoot`（1965405–1965885）里，由 `CWeaponComponent::MicroUpdateSerial`（1965313）在**单线程**中、每次武器开火时调用（开火由冷却控制，不是每 tick 都开火）。武器模板字段：collateral 伤害在 `+0x1218/+0x1220`，`collateral_range` 在 `+0x1228`；chain 伤害在 `+0x1230/+0x1238`，`chain_range` 在 `+0x1240`，`chain_count` 在 `+0x1248`（由 tooltip 字符串 `CMP_WEAPON_TT_COLLATERAL_*` / `CMP_WEAPON_TT_CHAIN_*` 确认，1962411–1962506）。

**AoE**（1965630–1965745）：遍历目标所在星系的每支舰队（`system+0x1038`），再遍历每支舰队的每艘船（`+800/+0x32c`）：
```c
cVar5 = CCountry::IsHostileCached(GetController(ship), GetController(shooter));   // 1965691，O(1) 字节表
if (cVar5 != '\0') {
  local_1c0 = CCelestialCoordinate::CalcDistance(target, ship);
  cVar5 = CCelestialDistance::IsGreaterThan(&local_1c0, collateral_range);         // 1965698
  if (cVar5 == '\0') {
    CShip::ApplyModifier(shooter, info, ship, tmpl);                               // 1965719：特质开销从这里开始
    ship->vtbl[0x80](...);                                                          // 扣血
```

**连锁**（1965752–1965850）：外层按跳数循环，最多 `chain_count` 次；**每一跳都重新扫描整个星系**，在上一个目标 `chain_range` 范围内用蓄水池抽样随机挑一个，每个候选调用一次 `CRandom`；然后对选中的目标执行一次 `ApplyModifier`（1965843）。

### F2 ✅ 物种特质从哪里来
`CShip::ApplyModifier`（3531817）→ `SAttackModifierTargetableControllerInfo::CreateSettings`（1879640）→ `CGameRules::IsCountryPsionic(受击方控制国)`（1879662，定义在 384894）：
- 构造一个完整的 `CEventScope`，求值脚本规则 `is_country_psionic = { is_psionic = yes }`，不缓存（见 C）；
- `is_psionic` 展开后是：两次 `has_tradition`（线性扫描已采纳的传统，`CCountry::HasTradition` 2079991），然后 `owner_main_species` → `has_psionic_species_trait`，即 5 次 `has_trait`（线性扫描物种特质，`CHasTrait::ActualEvaluate` 6760360）。
- 每次命中还有若干次 `CModifier` 表的线性查找，O(M)。
- 开火方的 `IsCountryPsionic` 也会调用，但只在开火方的 modifier 表里有 0x22b 时，每发一次。

### F3 复杂度
S 为星系内舰船数（包括中立和友方，会被敌对检查过滤掉）；K 为 AoE 范围内的命中数；C 为 `chain_count`；T 为特质数；Tr 为已采纳传统数；M 为 modifier 条目数。

| | 每发 |
|---|---|
| AoE | O(S) 次廉价检查 + O(K × (5T + 2Tr + 脚本开销 + M)) |
| 连锁 | O(C × S) 次廉价检查和 RNG 调用 + O(C × (5T + 2Tr + 脚本开销 + M)) |

- AoE 在大舰队密集编队时，K 会接近整支敌方舰队，这时退化成近似 S × (T + Tr)，也就是用户说的那种情况。
- 连锁真正的乘法项是 C × S 的全星系重扫，特质开销只额外加 C 次，不会和 S 相乘。
- **原版使用情况**：AoE 只有 Perdition Beam（范围 40）、离子炮（20）和方舟舰 Devastator（50），都是冷却很长的 XL/泰坦/巨像/防御槽武器；原版没有武器设置 `chain_count`，连锁武器都来自 mod。官方文档 `common/component_templates/000_documentation.txt:174` 自己也写了："WARNING: Both collateral_damage and chain_damage are performance intensive, use sparingly."
- **例子**：一个 mod 连锁武器 C=5，100 门同时开火，星系里有 1000 艘船，每个开火 tick 约 50 万次候选访问。每次访问包括两次 TPdxRef 查找、3 次虚调用、两次 `GetController`、一次敌对检查和一次距离计算。

### F4 修复
1. `IsCountryPsionic` 按国家每天缓存（只依赖国家），或者在每个战斗 tick 内按（攻击方，受击方）国家对缓存 `CreateSettings` 的结果。这样特质、传统和脚本开销就全部消失了。
2. 每个星系每个 tick 只构建一次"敌对可命中舰船"扁平数组（附带坐标），再按最大 `collateral_range`/`chain_range` 做网格分桶，每次 AoE 或每跳只查邻近的格子。
3. 连锁每跳用网格做范围查询，最后只取一次随机下标，不要对每个候选都调用 `CRandom`。
4. 开火方的控制国、`SAttackModifierAttackerInfo::Create`（约 10 次 modifier 查找）这些每发不变的量，提到"每发"级别计算，不要"每个受击目标"算一次。

**mod 侧**：连锁武器的 `chain_count` 要保守设置，并避免装配到大量小船上；`collateral_range` 越大越贵。
