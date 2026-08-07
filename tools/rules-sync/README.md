# Stellaris rules sync

These tools compare current Stellaris script documentation and vanilla files with the CWT rule baseline. Start with `scan` or `check`. Commands that can change rule data are called out below.

## Run a command

From the repository root:

```powershell
.\sync-stellaris-rules.cmd
.\sync-stellaris-rules.cmd scan
.\sync-stellaris-rules.cmd check
.\sync-stellaris-rules.cmd update
```

With no argument, the script opens an interactive `scan` / `check` / `update` menu. The same operations are available through npm:

```powershell
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
```

## Inputs and output

| Input | Default |
| --- | --- |
| Script documentation | `%USERPROFILE%\Documents\Paradox Interactive\Stellaris\logs\script_documentation` |
| Vanilla `common/` | Auto-detected from `D:\Steam\steamapps\common\Stellaris\common`, or set with `STELLARIS_COMMON` |
| CWT config | `submodules\cwtools-stellaris-config\config` |
| Generated output | `.rules-sync\stellaris` |

## Modes

| Mode | Behaviour |
| --- | --- |
| `scan` | Writes `rules.generated.json` and generated CWT candidates. |
| `check` | Runs a scan, compares it with current rules, and writes `check\rules-sync-check-report.json`. Use `--ci` to exit with code 2 when drift is found. |
| `update` | Writes append-only candidates under `update\generated` for manual review. It does not silently replace maintained rules. |
| `report` | Writes a self-contained HTML report to `report\rules-sync-report.html` and opens it unless `--no-open` is supplied. |
| `contracts` | Compares vanilla scope comments with CWT scope annotations and writes review material under `scope-contracts`. |

`contracts` is read-only by default. `--apply` adds only missing, high-confidence annotations. Existing conflicts require the separately reviewed `--apply-conflicts` option.

Only effects and triggers become generated CWT candidates. Modifiers and scopes remain in `rules.generated.json` because the server loads them from game logs. The vanilla scan also reports `common_missing_rule` when a populated `common/` folder has no matching CWT type path.

## Shader ABI refresh

When `report` can find a Stellaris installation, it also refreshes the Shader ABI data before producing the report. Pass `--no-shader-abi` when you need the report to leave rule data untouched.

The refresh has three steps:

1. `CWToolsCLI` parses `gfx/FX` through the shared `PdxShaderRuntime` implementation and records a `stellaris.exe` fingerprint in `.rules-sync/stellaris/shader-abi/shader-abi-inventory.json`.
2. `shader-abi-sync.ts` merges the inventory into `config/shader/abi-catalog.json`, `abi-audit.json`, and `renderer-contracts.json`. Reviewed entries keep their evidence while their declarations exist; new declarations receive `automatic_inventory` evidence and `rename_policy = forbidden`; vanished declarations and contracts are removed.
3. The HTML report shows the version transition, executable identity change, and carried, added, or removed entries. A JSON copy is written to `.rules-sync/stellaris/shader-abi/shader-abi-merge-report.json`; pre-merge files are backed up under `.rules-sync/stellaris/shader-abi/previous/`.

The scanner intentionally reuses the F# Shader parser. Do not add a second TypeScript parser for this workflow. On a fresh checkout, restore `submodules/cwtools/CWToolsCLI/CWToolsCLI.fsproj` if the CLI is not available yet.

## 中文说明

这些工具用于对比当前 Stellaris 脚本文档、原版文件和 CWT 规则基线。一般先运行 `scan` 或 `check`：

- `scan` 生成扫描结果和候选规则。
- `check` 生成差异报告；加 `--ci` 后，发现漂移会以退出码 2 结束。
- `update` 只把候选内容追加到 `update\generated`，需要人工审阅。
- `report` 生成可独立打开的 HTML 报告；加 `--no-open` 可禁止自动打开。
- `contracts` 对比原版作用域注释与 CWT 标注；默认只读，`--apply` 只补充缺失且高置信的内容。

`report` 在找到 Stellaris 安装时还会刷新 Shader ABI 数据，这一步会修改 `config/shader/` 下的维护文件。需要完全只读的报告时，请传入 `--no-shader-abi`。合并前文件会备份到 `.rules-sync/stellaris/shader-abi/previous/`，结果同时写入 HTML 和 JSON 报告。

Shader 扫描复用 `CWToolsCLI` 与 `PdxShaderRuntime`，不在 TypeScript 中维护第二套解析器。全新检出如果尚未还原 CLI，请先 restore `submodules/cwtools/CWToolsCLI/CWToolsCLI.fsproj`。
