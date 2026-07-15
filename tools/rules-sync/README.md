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
  pass `--no-open` to skip. Read-only: it never modifies the config.
- `contracts` extracts adjacent `Scope` / `This` / `Root` / `FromFrom...` comments
  from vanilla `on_actions` and `game_rules`, compares them with CWT
  `replace_scope`, and writes JSON plus reviewable CWT candidates under
  `scope-contracts`. It is read-only by default; pass `--apply` to add only missing,
  high-confidence annotations. Existing conflicting annotations are never replaced
  unless the separately reviewed `--apply-conflicts` option is supplied.

Only effects and triggers are converted into generated CWT candidates. Modifiers and scopes stay in `rules.generated.json` because they are loaded from the game logs directly.

Vanilla `common/` is scanned by default. The check report includes `common_missing_rule` entries when a vanilla common folder has `.txt` files but no matching CWT `type[...] path = "game/common/..."` coverage.

Use `--ci` if a check with drift should exit with code `2`.
