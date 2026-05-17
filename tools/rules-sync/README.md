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
```

Default inputs:

- Script documentation: `%USERPROFILE%\Documents\Paradox Interactive\Stellaris\logs\script_documentation`
- CWT config: `submodules\cwtools-stellaris-config\config`
- Output: `.rules-sync\stellaris`

Modes:

- `scan` writes `rules.generated.json` and generated CWT candidates.
- `check` scans, compares with current CWT config, and writes `check\rules-sync-check-report.json`.
- `update` scans and writes append-only generated candidates under `update\generated` for review.

Only effects and triggers are converted into generated CWT candidates. Modifiers and scopes stay in `rules.generated.json` because they are loaded from the game logs directly.

Use `--ci` if a check with drift should exit with code `2`.
