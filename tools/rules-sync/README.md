# Stellaris rules sync quick use

From the repository root, use:

```powershell
.\sync-stellaris-rules.cmd
.\sync-stellaris-rules.cmd scan
.\sync-stellaris-rules.cmd check
.\sync-stellaris-rules.cmd update
```

Running `sync-stellaris-rules.cmd` without arguments opens an interactive `scan` / `check` / `update` selection menu.

NPM shortcuts are also available:

```powershell
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
```

Default inputs:

- Script documentation: `%USERPROFILE%\Documents\Paradox Interactive\Stellaris\logs\script_documentation`
- Vanilla common: auto-detected from `D:\Steam\steamapps\common\Stellaris\common` or `STELLARIS_COMMON`
- CWT config: `submodules\cwtools-stellaris-config\config`
- Output: `.rules-sync\stellaris`

Modes:

- `scan` writes `rules.generated.json` and generated CWT candidates.
- `check` scans, compares with current CWT config, and writes `check\rules-sync-check-report.json`.
- `update` scans and writes append-only generated candidates under `update\generated` for review.
- `report` compares fresh game `script_documentation` and vanilla `common/` against the
  config baseline (`config\logs\*` plus CWT files) and writes a self-contained visual
  HTML report to `report\rules-sync-report.html` (added/removed/changed triggers,
  effects, modifiers, scopes, localisation commands, plus folder coverage and
  definition-field-level findings). The report opens in the browser automatically;
  pass `--no-open` to skip. When a Stellaris install is found, `report` also scans
  the Shader ABI inventory and auto-merges it into `config\shader` first (see
  below); pass `--no-shader-abi` for a fully read-only report.
- `contracts` extracts adjacent `Scope` / `This` / `Root` / `FromFrom...` comments
  from vanilla `on_actions` and `game_rules`, compares them with CWT
  `replace_scope`, and writes JSON plus reviewable CWT candidates under
  `scope-contracts`. It is read-only by default; pass `--apply` to add only missing,
  high-confidence annotations. Existing conflicting annotations are never replaced
  unless the separately reviewed `--apply-conflicts` option is supplied.

## Shader ABI auto merge / Shader ABI 自动合并

`report` mode includes the Shader ABI upgrade automatically:

`report` 模式已内置 Shader ABI 升级流程：

1. CWToolsCLI parses the game `gfx/FX` corpus with the authoritative CWTools Shader
   parser and fingerprints `stellaris.exe` into
   `.rules-sync/stellaris/shader-abi/shader-abi-inventory.json`.
2. `shader-abi-sync.ts` merges that inventory directly into
   `config/shader/abi-catalog.json`, `config/shader/abi-audit.json`, and
   `config/shader/renderer-contracts.json`:
   - reviewed catalog entries carry forward (keeping their evidence) while their
     Effect declaration still exists;
   - every other scanned Effect declaration is registered with
     `automatic_inventory` evidence and `rename_policy = forbidden`;
   - entries and renderer contracts whose declarations vanished are removed.
3. The HTML report gains a Shader ABI section with the version transition, EXE
   identity change, carried/added/dropped entries, and contract changes. A
   machine-readable copy lives at
   `.rules-sync/stellaris/shader-abi/shader-abi-merge-report.json`, and the
   pre-merge files are backed up under `.rules-sync/stellaris/shader-abi/previous/`.

1. CWToolsCLI 使用 CWTools 权威 Shader 解析器扫描游戏 `gfx/FX` 并记录
   `stellaris.exe` 指纹，输出 `.rules-sync/stellaris/shader-abi/shader-abi-inventory.json`。
2. `shader-abi-sync.ts` 将该清单直接自动合并进 `config/shader/abi-catalog.json`、
   `config/shader/abi-audit.json` 与 `config/shader/renderer-contracts.json`：
   已审核条目在声明仍存在时结转并保留原证据；其余扫描到的 Effect 声明一律以
   `automatic_inventory` 证据、`rename_policy = forbidden` 自动收录；声明已消失的
   条目与渲染器契约会被移除。
3. HTML 报告新增 Shader ABI 区块，展示版本变迁、EXE 指纹变化、结转/新增/移除条目
   与契约变化。机器可读副本见
   `.rules-sync/stellaris/shader-abi/shader-abi-merge-report.json`，合并前的文件
   备份在 `.rules-sync/stellaris/shader-abi/previous/`。

The scanner is hosted by `CWToolsCLI` and calls `PdxShaderRuntime`; it does not
maintain a second TypeScript Shader parser. If the CLI has not been restored on a
fresh checkout, run an explicit `dotnet restore` for
`submodules/cwtools/CWToolsCLI/CWToolsCLI.fsproj` first.

扫描器由 `CWToolsCLI` 承载并调用 `PdxShaderRuntime`，不会在 TypeScript 中维护第二套
Shader 解析器。全新检出若尚未还原 CLI，请先显式执行对应项目的 `dotnet restore`。

Only effects and triggers are converted into generated CWT candidates. Modifiers and scopes stay in `rules.generated.json` because they are loaded from the game logs directly.

Vanilla `common/` is scanned by default. The check report includes `common_missing_rule` entries when a vanilla common folder has `.txt` files but no matching CWT `type[...] path = "game/common/..."` coverage.

Use `--ci` if a check with drift should exit with code `2`.
