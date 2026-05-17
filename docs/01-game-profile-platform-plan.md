# GameProfile Platform Implementation Plan

## Goal

Turn game-specific behavior into an explicit `GameProfile` layer so Stellaris remains the first-class path while HOI4, EU4, CK2/3, VIC2/3, Imperator, EU5, and future Paradox games can be added without scattering conditional logic across the extension, AI tools, and webviews.

## Current Signals

- Language contributions and cache settings already list multiple games in `release/package.json`.
- Most rules, test fixtures, and product copy are still Stellaris-centered.
- AI game knowledge exists under `client/extension/ai/gameKnowledge.ts`, but game behavior is not yet a shared contract.
- Visual preview commands are currently bound to folder/file patterns that mostly assume Stellaris structures.

## Proposed Contract

Create a profile model owned by the extension host:

```ts
export interface GameProfile {
    id: string;
    displayName: string;
    languageId: string;
    fileExtensions: string[];
    cacheSettingKey: string;
    rulesSettingKey: string;
    vanillaRootHints: string[];
    localisation: LocalisationProfile;
    folders: GameFolderProfile;
    previews: PreviewCapabilityProfile;
    ai: GameAiProfile;
}
```

The profile should be consumed by extension commands, cache discovery, LSP startup settings, AI prompt building, and preview eligibility checks.

## Phase 1: Inventory and Boundary Mapping

1. Search for hard-coded game names and folder assumptions in:
   - `client/extension/`
   - `client/extension/ai/`
   - `client/webview/`
   - `release/package.json`
   - `src/Main/`
2. Classify each usage as:
   - manifest contribution
   - cache/rules selection
   - language behavior
   - AI prompt behavior
   - preview feature behavior
   - test fixture behavior
3. Produce a short internal table of required fields for the first profile version.

## Phase 2: Add Profile Registry

1. Add a new module such as `client/extension/gameProfiles.ts`.
2. Define the `GameProfile` interfaces and a registry map.
3. Add Stellaris as the canonical complete profile.
4. Add partial profiles for other games with explicit capability flags.
5. Add helper functions:
   - `getProfileByLanguageId`
   - `getProfileForDocument`
   - `getProfileForWorkspace`
   - `getDefaultProfile`

## Phase 3: Migrate Extension Host Consumers

1. Replace hard-coded cache setting lookups with profile-derived setting keys.
2. Replace preview command eligibility checks where possible with profile capability checks.
3. Update file explorer and vanilla compare logic to resolve folder meanings through the active profile.
4. Keep existing command IDs stable to avoid breaking users.

## Phase 4: Migrate AI Consumers

1. Move game-specific prompt fragments behind `GameAiProfile`.
2. Update `promptBuilder.ts` to accept an active profile.
3. Ensure AI tools that query game IDs or rules include the profile ID in their context.
4. Add profile-aware warnings when a tool is available for Stellaris but not for the active game.

## Phase 5: Testing

1. Add unit tests for profile resolution from language ID, file path, and workspace hints.
2. Add tests for capability gating, especially preview commands.
3. Add tests that non-Stellaris profiles do not receive Stellaris-only AI assumptions.
4. Add at least one minimal fixture for a second game profile.

## Acceptance Criteria

- A new game can be introduced by adding one registry entry plus manifest language contributions.
- Stellaris behavior remains unchanged.
- Preview commands are gated by profile capabilities, not scattered path checks.
- AI prompt construction receives an explicit game profile.
- Tests cover profile resolution and at least one non-Stellaris path.

## Risks

- Moving too much at once could destabilize current Stellaris behavior.
- The F# backend may still need game-specific settings that are not exposed cleanly through the TypeScript side.
- Some preview features may be genuinely Stellaris-only and should remain capability-gated rather than over-generalized.

## Suggested First PR

Create the profile registry, wire only read-only consumers, and add tests. Leave command behavior unchanged except for using the registry to answer questions it already answers today.
