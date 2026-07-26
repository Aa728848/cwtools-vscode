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
npm run rules:stellaris:shader-abi
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
  pass `--no-open` to skip. Read-only: it never modifies the config.
- `contracts` extracts adjacent `Scope` / `This` / `Root` / `FromFrom...` comments
  from vanilla `on_actions` and `game_rules`, compares them with CWT
  `replace_scope`, and writes JSON plus reviewable CWT candidates under
  `scope-contracts`. It is read-only by default; pass `--apply` to add only missing,
  high-confidence annotations. Existing conflicting annotations are never replaced
  unless the separately reviewed `--apply-conflicts` option is supplied.
- `shader-abi` uses the authoritative CWTools Shader parser to inventory `gfx/FX`,
  fingerprint `stellaris.exe`, scan Effect-name strings as candidates, and emit
  `shader-abi-inventory.json`, `shader-abi-upgrade-report.json`, plus catalog/audit
  drafts under `.rules-sync/stellaris/shader-abi`. It never auto-promotes an entry.

## Shader ABI game-version upgrades / Shader ABI 游戏版本升级

Generate a fail-closed review pack after Stellaris updates:

游戏更新后生成保守的人工审核包：

```powershell
npm run rules:stellaris:shader-abi -- `
  --game-path "C:\Program Files (x86)\Steam\steamapps\common\Stellaris" `
  --version 4.4.7
```

The scanner is hosted by `CWToolsCLI` and calls `PdxShaderRuntime`; it does not
maintain a second TypeScript Shader parser. If the CLI has not been restored on a
fresh checkout, run an explicit `dotnet restore` for
`submodules/cwtools/CWToolsCLI/CWToolsCLI.fsproj` first.

扫描器由 `CWToolsCLI` 承载并调用 `PdxShaderRuntime`，不会在 TypeScript 中维护第二套
Shader 解析器。全新检出若尚未还原 CLI，请先显式执行对应项目的 `dotnet restore`。

Across a changed game version, Shader corpus, declaration inventory, or EXE hash,
the generated catalog draft starts empty. Old entries appear as requiring review;
string matches and missing textual callers never carry them forward. Review all four
audit stages, then apply only explicitly reviewed files:

只要游戏版本、Shader 语料、声明清单或 EXE 哈希发生变化，catalog 草案就从空清单开始；
旧条目进入待复核列表，字符串命中或无文本调用不会自动继承。完成四阶段审核后，才可应用
两份明确审核过的文件：

```powershell
npm run rules:stellaris:shader-abi -- `
  --game-path "C:\Program Files (x86)\Steam\steamapps\common\Stellaris" `
  --version 4.4.7 `
  --reviewed-catalog ".rules-sync\stellaris\shader-abi\abi-catalog.reviewed.json" `
  --reviewed-audit ".rules-sync\stellaris\shader-abi\abi-audit.reviewed.json" `
  --apply
```

`--apply` fails unless both artifacts match the fresh version, corpus hashes, EXE
identity, catalog identities, and completed evidence stages.

只有当两份产物与最新版本、语料哈希、EXE 身份、catalog 身份及全部已完成证据阶段完全一致时，
`--apply` 才会写入配置。

Only effects and triggers are converted into generated CWT candidates. Modifiers and scopes stay in `rules.generated.json` because they are loaded from the game logs directly.

Vanilla `common/` is scanned by default. The check report includes `common_missing_rule` entries when a vanilla common folder has `.txt` files but no matching CWT `type[...] path = "game/common/..."` coverage.

Use `--ci` if a check with drift should exit with code `2`.
