# Incremental Index and Knowledge Layer Implementation Plan

## Goal

Create a shared indexing layer for workspace files, vanilla cache files, localisation keys, symbols, and cross-file references. The index should feed LSP features, AI tools, previews, vanilla compare, and future game profiles from one consistent source.

## Current Signals

- Localisation indexing already moved toward workspace-wide watching.
- AI tools query definitions, rules, sprites, sounds, files, and project context.
- LSP and extension host both perform file and symbol work.
- Large Paradox mods and vanilla directories make repeated scans expensive.

## Scope

The first version should index:

- workspace file inventory
- vanilla cache file inventory
- localisation keys
- top-level PDXScript symbols
- sprite and asset IDs
- event IDs and references
- technology IDs and prerequisites

Do not attempt full semantic validation in the first version. The index should be fast, incremental, and queryable.

## Proposed Contract

```ts
export interface WorkspaceIndex {
    status(): IndexStatus;
    refresh(reason: RefreshReason): Promise<void>;
    updateFile(uri: vscode.Uri): Promise<void>;
    removeFile(uri: vscode.Uri): Promise<void>;
    querySymbols(query: SymbolQuery): Promise<SymbolResult[]>;
    queryLocalisation(key: string): Promise<LocalisationResult[]>;
    queryAssets(query: AssetQuery): Promise<AssetResult[]>;
}
```

## Phase 1: Audit Existing Scanners

1. Identify file scanning logic in:
   - `locDecorations.ts`
   - `eventChainParser.ts`
   - `techTreeParser.ts`
   - `entityAssetParser.ts`
   - AI file and LSP tools
   - vanilla compare
2. Record duplicate parsing patterns.
3. Choose which parser outputs can be cached safely.

## Phase 2: Build Index Service Skeleton

1. Add `client/extension/indexing/`.
2. Add an `IndexService` owned by extension activation.
3. Add file watchers with debounced update queues.
4. Add status reporting and logging through existing error/reporting patterns.
5. Keep initial index in memory; avoid persistence until the query model stabilizes.

## Phase 3: Localisation and Symbols

1. Move localisation key indexing behind the new service.
2. Add top-level symbol extraction using the existing tokenizer/parser where practical.
3. Add query APIs consumed by AI tools and editor features.
4. Add cache invalidation for changed and deleted files.

## Phase 4: Assets and Graph Data

1. Add sprite and asset ID indexing.
2. Add event reference indexing for event chain previews.
3. Add technology dependency indexing for tech tree previews.
4. Ensure preview panels can request indexed data instead of rescanning every time.

## Phase 5: LSP and AI Integration

1. Let AI tools query the index for common lookups before falling back to deeper scans.
2. Add index status to AI context so the agent knows whether data is fresh.
3. Explore whether the F# backend should receive index hints or remain independently authoritative.

## Phase 6: Tests and Performance

1. Add unit tests for add/update/delete file indexing.
2. Add fixture-based tests for localisation, symbol, sprite, event, and technology queries.
3. Add performance tests using a large fixture folder or generated files.
4. Track cold index time, incremental update time, and memory use.

## Acceptance Criteria

- Common symbol, localisation, and asset lookups go through one service.
- File changes update the index incrementally.
- Preview panels can avoid full workspace rescans for indexed data.
- AI tools can report whether index results are fresh.
- Tests cover stale-file removal and duplicate symbol handling.

## Risks

- Index ownership can blur boundaries with the F# LSP backend.
- Large vanilla caches may require persistence later.
- Watcher storms during checkout or rules sync need debouncing and cancellation.

## Suggested First PR

Create the index service skeleton and move localisation indexing behind it, with no behavior change in the editor UI.
