# Stellaris Engine-Cost Annotation Tooling / 引擎成本标注工具

Scripts in this directory extract and merge reverse-engineered engine-cost metadata (`## cost`, `## engine`, `## engine_evidence`) for `submodules/cwtools-stellaris-config/config/*.cwt`.

This pipeline is intentionally separate from `tools/rules-sync/` (which tracks Paradox script documentation drift).

| Script | Role |
| --- | --- |
| `extract-engine-cost.cjs` | Extracts per-command cost tiers and evidence line numbers from a decompiled Stellaris C++ dump. |
| `merge-engine-cost.cjs` | **Sole write entry for `## cost` annotations.** Updates an entry only when extracted evidence is more specific; preserves manually curated finer tiers (e.g. `o(n)_galaxy`, `script_eval`, `scope_copy`) on conflict and reports conflicts. |

## Re-anchoring after a game update / 游戏更新后重锚流程

```powershell
# 1. Extract cost data from the new decompiled dump
node tools/engine-cost/extract-engine-cost.cjs <new-dump.cpp> --rules submodules/cwtools-stellaris-config/config --out .rules-sync/engine-cost.json

# 2. Conservatively merge into CWT rules (review dry-run conflicts / upgrades first)
npm run engine:cost:merge -- .rules-sync/engine-cost.json --rules submodules/cwtools-stellaris-config/config
```

## Rules / 维护纪律

- Facts live in `.cwt` annotations (`## cost`, `## engine`, `## engine_evidence`, `## sync_effect`); the F# backend (`STLValidation.fs`, `HoverPerformance.fs`) only classifies tiers and never hardcodes per-command tables.
- Never hand-edit individual `dump L<line>` references during routine rules sync; always re-anchor in batch via `merge-engine-cost.cjs`.
- Documentation log drift (`config/logs/*`) is audited by `tools/rules-sync/` (`report` command), not here.
- Architecture and validator decisions are documented in [`.agents/notes/implemented/feature/2026-09-29-engine-cost-fact-driven-validators.md`](../../.agents/notes/implemented/feature/2026-09-29-engine-cost-fact-driven-validators.md) and [`docs/diagnostic-codes.md`](../../docs/diagnostic-codes.md) (`CW279`–`CW289`).
