# Stellaris Rules Sync / Stellaris 规则同步工具

[English](#english) | [中文](#zh-cn)

<a id="english"></a>

## English

These tools compare current Stellaris script documentation and vanilla files against the CWT rule baseline. Start with `scan` or `check`; commands that modify rule data are noted below.

### Run a command

From the repository root:

```powershell
.\sync-stellaris-rules.cmd          # Interactive scan / check / update menu
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
npm run rules:stellaris:optional-fields
```

### Inputs and outputs

| Input / Output | Default |
| --- | --- |
| Script documentation | `%USERPROFILE%\Documents\Paradox Interactive\Stellaris\logs\script_documentation` |
| Vanilla `common/` | Auto-detected from local Steam install, or set via `STELLARIS_COMMON` |
| CWT config | `submodules\cwtools-stellaris-config\config` |
| Generated output | `.rules-sync\stellaris` |

### Modes

| Mode | Behavior |
| --- | --- |
| `scan` | Writes `rules.generated.json` and generated CWT candidates (effects and triggers only; modifiers/scopes come from game logs). |
| `check` | Compares scan output against current rules and writes `check\rules-sync-check-report.json`. Pass `--ci` to exit with code `2` on drift. |
| `update` | Writes append-only candidates under `update\generated` for manual review without overwriting maintained rules. |
| `report` | Generates a self-contained HTML report at `report\rules-sync-report.html` (pass `--no-open` to skip opening the browser). |
| `contracts` | Compares vanilla scope comments against CWT scope annotations under `scope-contracts`. Read-only by default; `--apply` adds missing high-confidence annotations, while `--apply-conflicts` updates conflicting ones. |
| `optional-fields` | Audits `config/logs/*_docs.log` against CWT aliases to flag documented-optional fields still required (`1..1` default, causing `CW242` false positives). Also runs inside `check` and `report`. Add `## cardinality = 0..1` above confirmed optional fields. |

### Shader ABI refresh

When `report` locates a Stellaris installation, it also refreshes Shader ABI metadata under `config/shader/` (pass `--no-shader-abi` for a strictly read-only report):

1. `CWToolsCLI` parses `gfx/FX` via the shared `PdxShaderRuntime` implementation and records the executable fingerprint in `.rules-sync/stellaris/shader-abi/shader-abi-inventory.json`.
2. `shader-abi-sync.ts` merges the inventory into `config/shader/abi-catalog.json`, `abi-audit.json`, and `renderer-contracts.json` (preserving audited evidence, marking new entries `automatic_inventory` with `rename_policy = forbidden`, and removing vanished entries).
3. Pre-merge backups are written under `.rules-sync/stellaris/shader-abi/previous/` and a JSON merge summary accompanies the HTML report.

Never add a parallel TypeScript Shader parser for this workflow. On a fresh checkout, restore `submodules/cwtools/CWToolsCLI/CWToolsCLI.fsproj` if the CLI is not yet built.

---

<a id="zh-cn"></a>

## 中文

本工具集用于对比当前 Stellaris 脚本文档、原版文件与 CWT 规则基线。日常建议先运行 `scan` 或 `check`；会修改规则数据的命令在下表单独标出。

### 运行命令

在仓库根目录执行：

```powershell
.\sync-stellaris-rules.cmd          # 交互式 scan / check / update 菜单
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
npm run rules:stellaris:optional-fields
```

### 输入与输出

| 项目 | 默认位置 |
| --- | --- |
| 脚本文档日志 | `%USERPROFILE%\Documents\Paradox Interactive\Stellaris\logs\script_documentation` |
| 原版 `common/` | 自动探测本机 Steam 安装目录，或通过 `STELLARIS_COMMON` 显式指定 |
| CWT 规则目录 | `submodules\cwtools-stellaris-config\config` |
| 生成产物目录 | `.rules-sync\stellaris` |

### 运行模式

| 模式 | 行为说明 |
| --- | --- |
| `scan` | 输出 `rules.generated.json` 与候选 CWT（仅生成 effect/trigger；modifier 与 scope 由服务端直接读游戏日志）。 |
| `check` | 与现有规则比对并写出 `check\rules-sync-check-report.json`；传入 `--ci` 时存在漂移将以退出码 `2` 结束。 |
| `update` | 仅向 `update\generated` 追加候选规则供人工审阅，不静默覆盖既有规则。 |
| `report` | 生成可独立打开的 `report\rules-sync-report.html`（传入 `--no-open` 不自动打开浏览器）。 |
| `contracts` | 比对原版作用域注释与 CWT 标注并输出到 `scope-contracts`。默认只读；`--apply` 仅补缺失的高置信标注，`--apply-conflicts` 处理冲突项。 |
| `optional-fields` | 审计 `config/logs/*_docs.log` 与 CWT alias，检出文档标为可选但规则仍默认必填（`1..1`）导致 `CW242` 误报的字段（`check` 与 `report` 会自动包含）。确认后在该字段上方补 `## cardinality = 0..1`。 |

### Shader ABI 刷新

当 `report` 探测到 Stellaris 安装目录时，还会自动刷新 `config/shader/` 下的 Shader ABI 数据（需要完全只读报告请传 `--no-shader-abi`）：

1. `CWToolsCLI` 复用共享 `PdxShaderRuntime` 解析 `gfx/FX`，并将可执行文件指纹写入 `.rules-sync/stellaris/shader-abi/shader-abi-inventory.json`。
2. `shader-abi-sync.ts` 将清单合并到 `config/shader/abi-catalog.json`、`abi-audit.json` 与 `renderer-contracts.json`（保留已审核证据，新条目记为 `automatic_inventory` 且 `rename_policy = forbidden`，移除已消失条目）。
3. 合并前文件备份至 `.rules-sync/stellaris/shader-abi/previous/`，同时输出 JSON 合并摘要与 HTML 报告。

严禁在 TypeScript 中另写第二套 Shader 解析器。全新检出如尚未构建 CLI，请先还原 `submodules/cwtools/CWToolsCLI/CWToolsCLI.fsproj`。
