# Test and Release Quality Gate Implementation Plan

## Goal

Add a quality gate that catches broken builds, missing release artifacts, manifest drift, localisation key drift, and high-risk UI regressions before packaging a VSIX.

## Current Signals

- Root `package.json` and `release/package.json` currently have different versions.
- Unit tests, integration tests, lint, TypeScript compile, Rollup, and VSCE packaging already exist as separate commands.
- Packaging instructions live in `.agents/workflows/package.md`.
- Webview and release artifacts are easy to break if compile and packaging steps are not run together.

## Quality Gate Checks

Start with these checks:

1. TypeScript compile and Rollup bundle.
2. ESLint.
3. Unit tests.
4. Optional VS Code integration tests.
5. Root/release manifest version consistency.
6. Required release files exist.
7. NLS keys referenced by manifest exist in `package.nls.json` and `package.nls.zh.json`.
8. Webview bundle files exist and are non-empty.
9. Server binaries exist for the intended release target.
10. VSIX dry-run or package command succeeds.

## Phase 1: Add Release Check Script

1. Add a script under `scripts/` or `tools/release/`.
2. Implement manifest consistency checks.
3. Implement required file checks.
4. Implement NLS key checks.
5. Print a concise report with pass/fail sections.

## Phase 2: Wire npm Scripts

Add scripts such as:

```json
{
  "check:release": "node tools/release/check-release.js",
  "verify": "npm run lint && npm run compile && npm run test:unit && npm run check:release"
}
```

Keep integration tests separate if they are slower or require VS Code Electron.

## Phase 3: Add CI

1. Add GitHub Actions for:
   - install dependencies
   - lint
   - compile
   - unit tests
   - release checks
2. Cache npm and .NET dependencies.
3. Add a separate manual workflow for VSIX packaging.

## Phase 4: Add Webview Visual Checks

1. Add browser-based smoke tests for webview HTML bundles.
2. Add screenshot baselines for key panels.
3. Run visual checks in a separate job or optional local command.

## Phase 5: Release Automation

1. Add a version sync command that updates root and release manifests together.
2. Generate or validate changelog entries.
3. Package VSIX only after the quality gate passes.
4. Produce a release report with artifact names, versions, and checks performed.

## Acceptance Criteria

- A single command can validate release readiness.
- Version mismatches fail loudly.
- Missing manifest NLS keys fail loudly.
- Missing webview bundles or server outputs fail loudly.
- CI runs the fast gate on every PR.
- Packaging uses the same checks as local release preparation.

## Risks

- Integration tests may be flaky in CI and should not block the first gate.
- Server binary expectations may differ by platform.
- Visual baselines need careful maintenance to avoid noisy failures.

## Suggested First PR

Implement `check:release` for manifest version, NLS keys, and required release artifacts. This catches real release mistakes without touching product behavior.
