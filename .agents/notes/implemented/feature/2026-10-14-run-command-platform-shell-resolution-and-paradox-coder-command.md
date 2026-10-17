# Agent Note: run_command 按平台智能选择 Shell 并放行 paradox-coder 命令能力

Status: implemented

## Problem

`run_command` 的 `shell=auto` 解析策略是硬编码的：Windows 恒为 `powershell.exe`（Windows PowerShell 5.1），macOS/Linux 恒为 `/bin/sh`。这带来三个问题：

1. **更优解释器在场也不用**：主机已安装 PowerShell 7+（`pwsh`）时 auto 仍走 5.1；Unix 侧有 `bash` 时 auto 仍走最简 POSIX `sh`，与用户在终端里的真实体验不一致。
2. **审批载荷不透明**：权限审批卡片的 `preflight.shell` 记录的是请求值 `auto`，用户看不到命令实际将交给哪个解释器执行。
3. **Paradox 子代理能力错配**：`paradox-coder` 作为实现类子代理被 `SUB_AGENT_EXCLUDES_SET` 一刀切排除 `run_command`，批量机械改写、批量校验等确需脚本的场景只能低效逐文件调用结构化工具；提示词中"PDXScript 分析禁用 run_command"的绝对化劝阻也与放行诉求冲突。
4. **沙箱不可用报错不可操作**：`SandboxUnavailableError` 只说一句"没有可用沙箱"，未告知用户/模型可操作的恢复路径。

## Decision

### 1. 探测优先的 auto shell 解析（`client/extension/ai/tools/externalTools.ts`）

新增模块级 `resolveRunCommandShell(requested, platform, execFile?)`，参照 `detectSandboxBackendAsync` 的 probe + 进程级缓存写法：

```text
Windows:  auto/pwsh ──probe pwsh.exe──✓ 主版本 ≥7──→ pwsh.exe（描述 pwsh-7）
                          │ ✗（缺失/超时/版本 <7/输出不可解析）
                          ├─ requested=auto ──→ powershell.exe（描述 powershell-<major>）
                          └─ requested=pwsh ──→ powershell.exe + stderr 前置双语回退说明
         显式 powershell ──→ powershell.exe（不探测 pwsh）
Unix:     auto ──/bin/sh -c "command -v bash"──✓──→ bash -c（不 source profile，保持确定性）
                          │ ✗
                          └─→ /bin/sh -c
         显式 bash ──→ bash -lc（维持历史行为）；显式 sh ──→ /bin/sh -c
```

- **探测**：pwsh 用 `pwsh.exe -NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.Major"`（3s 超时，退出码 0 且主版本 ≥7 才采纳）；bash 经 `/bin/sh -c 'command -v bash'` 探测。powershell.exe 被选中时同样探测一次主版本用于审批描述。
- **缓存**：`shellMajorVersionCache`（按 exe）与 `cachedBashAvailability` 进程级缓存，**失败同样缓存为不可用**，每个会话每种 shell 至多探测一次；`__resetShellDetectionCacheForTests()` 供测试重置；可选 `execFile` 注入参数使单测无需真起进程。
- **cmd 不进入任何回退链**；UTF-8 输出前缀与 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` 参数仅对 `pwsh`/`powershell` 家族注入；auto 解析出的 bash 用 `-c` 而非 `-lc`，只有显式 `shell=bash` 维持 `-lc`。

### 2. 解析时机前移到审批之前

`detectSandboxBackendAsync` 与 shell 解析从 spawn 前移到权限请求之前（两者均有会话级缓存，总时延不变）：

- `preflightPayload.shell` 从请求值（`auto`）改为**解析后描述**（`pwsh-7` / `powershell-5` / `bash` / `sh`），请求值保留为新字段 `requestedShell`，审批 UI 可见真实解释器。
- WSL bubblewrap 沙箱强制 `/bin/sh` 的判定与两条拒绝（PowerShell cmdlet、显式 PowerShell shell）随之前移，命令不可执行时不再先弹审批再报错；WSL 路径语义本身未动。

### 3. 模型可见契约与提示词同步

- `definitions.ts` 的 `run_command` 描述说明 auto 解析优先级（Windows: pwsh 7+ → powershell；macOS/Linux: bash → sh）与各 shell 值语义；`shell` 参数 enum 不变。
- `modePrompts.ts` 的 `RUN_COMMAND_SHELL_NOTE`/`ENV_VAR_SYNTAX_NOTE` 反映 pwsh 优先（Windows 始终是 PowerShell 家族，`$env:` 提示保持有效）；注入点不变。
- paradox 多代理编排提示中"禁用 run_command 做 PDXScript 分析"弱化为"优先结构化工具；确需批量脚本处理（大规模机械改写、批量校验）时 run_command 可用，仍受策略引擎约束"。

### 4. paradox-coder 放行命令能力

`agentProfileCatalog.ts` 内置 `paradox-coder` 增加 `subagentCapabilities: { command: true }`，经 `effectiveToolPolicy.ts` 既有豁免分支放行 `run_command`（`manage_process` 仍被排除）。只读分析类（explore/planner/reviewer）与专门写作类（localization-writer/localization-translator/gui-expert）profile 保持不放行。放行不等于免审批：策略引擎、命令预检、审批边界仍然生效。子代理物理沙箱 `orchestrator/subAgentSandbox.ts` 原先把 `run_command` 的豁免硬编码为 `general-coder`，现改为按 profile 目录的 `subagentCapabilities.command` 声明判定，与策略层语义一致，见 [无强制沙箱后端时的审批式降级与子代理命令能力对齐](../architecture/2026-10-17-command-sandbox-degrade-with-consent-and-subagent-command-capability.md)。

### 5. 沙箱不可用报错双语可操作化（`sandboxRunner.ts`）

`SandboxUnavailableError` 按平台给出恢复路径（Windows：安装原生沙箱助手或配置 WSL2+bubblewrap；Linux/macOS：安装 bubblewrap/sandbox-exec），并说明最后手段是 `requestEscalation=true` + `unsandboxed=true` 向用户申请一次性明确批准的绕过；不泄露内部 helper 路径细节。

> **后续变更（行为已反转）**：`run_command` 不再在该错误处死路。无强制后端时改为强制一次"仅本次无沙箱运行"审批后直连执行，无人值守仍拒绝；`SandboxUnavailableError` 与 broker 抛错仅作为纵深防御保留。详见 [无强制沙箱后端时的审批式降级与子代理命令能力对齐](../architecture/2026-10-17-command-sandbox-degrade-with-consent-and-subagent-command-capability.md)。

## Alternatives considered

1. **auto 解析的 bash 也用 `-lc`（登录 shell）**：否决。登录 shell 会 source 用户 profile，输出与行为随用户环境漂移，破坏命令执行的确定性；显式 `shell=bash` 维持 `-lc` 仅为兼容既有行为。
2. **把 cmd 加入 Windows 回退链末端**：否决。cmd 从未被该工具选用，其 quoting/转义语义与 PowerShell 差异大，引入第三条家族会放大预检与审批的语义盲区。
3. **给 gui-expert / localization-writer 一并放行 command**：否决（本次）。两者是窄专门写作 profile，结构化工具足够；paradox-coder 是唯一通用实现类 paradox 子代理。后续确有需求可单独放行，`subagentCapabilities` 机制已通用。
4. **显式 `shell=pwsh` 不可用时直接报错**：否决。回退 powershell.exe 与显式 `shell=powershell` 行为一致且语义兼容（同为 PowerShell 家族），用 stderr 前置双语说明保留了可见性；报错只会强迫模型多一轮无效重试。
5. **审批载荷仍记请求值、仅在实际 spawn 时才解析**：否决。审批卡片是用户知情同意的唯一依据，必须展示真实将执行的解释器；探测结果有会话级缓存，前移不增加总时延。

## Consequences

- **直接收益**：装有 PowerShell 7+ 的 Windows 主机 auto 命令获得现代解释器（更好的错误流、null 安全、跨平台一致语法）；Unix 侧 auto 获得 bash 特性；审批卡片透明展示 `pwsh-7` 等真实 shell。
- **能力面**：paradox-coder 子代理可执行批量脚本处理，`deepseekSupport.test.ts` 的语义从"paradox 子代理一律被拒"翻转为"声明 command 能力的 profile 放行"，并新增 localization-writer 拒绝对照。
- **约束**：shell 解析依赖进程级缓存，同一会话内 pwsh 的安装/卸载不会被感知（重启扩展宿主后生效）；探测注入参数 `execFile` 仅供测试使用。
- **MCP 面**：`run_command` 不在只读 MCP 工具面内，`npm run generate:mcp-schema` 对 `submodules/cwtools-mcp` 无 diff，子模块无需提交，根指针不变；子模块 build 与 39 项契约测试已验证全绿。
- **已知张力**：`SLIM_SUB_AGENT_RULE` 提示词仍写"NEVER use `run_command`"，这是 slim 变体的提示级保守约束，与策略级能力放行并存（general-coder 时代即如此设计），本次未改动。
- **验证**：`npm run typecheck:test` 0 error；目标套件 `agentToolSafety`/`commandPreflight`/`approvalBoundary`/`deepseekSupport`/`promptBuilderContext` + 新增 `runCommandShellResolution.test.ts`（11 例：pwsh 命中/回退/版本 <7/输出不可解析/显式 pwsh 回退说明/显式 powershell 不探测/Unix auto→bash/无 bash 回退 sh/显式 bash -lc/显式 sh/无 cmd 回退链）共 198 passing / 0 failing；全量 `npm run test:unit` 通过。
