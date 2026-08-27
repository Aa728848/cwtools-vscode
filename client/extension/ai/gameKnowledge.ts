/**
 * Stable Agent policy for resolving Paradox knowledge.
 *
 * Current-game facts intentionally do not live here. Rule names, scopes,
 * entity families, directories, operator support, event shapes, localisation
 * conventions, and override behaviour belong to the active profile/CWT rules
 * and the CWTools LSP model. Keeping this module policy-only also makes the
 * prompt prefix small and safe to cache across rule revisions.
 */

import { getKnownProfileByLanguageId } from '../gameProfiles';

export const PARADOX_KNOWLEDGE = `
## Current-game knowledge resolution
This prompt intentionally contains no game-version rule tables, scope lists, entity-ID lists, directory capability tables, event-key lists, operator tables, localisation examples, or override-mode meanings. Retrieve those facts from the active CWT rules and CWTools LSP model when the task needs them.

### Evidence routing
- Rule legality and scope: use \`query_rules\`, \`query_scope\`, \`explain_scope\`, \`search_rule_capabilities\`, and position-aware completions. Pass exact scopes returned by CWT/LSP instead of translating them through prompt examples.
- Entity and file shape: use \`query_cwt_schema\` for the actual target path, then \`query_types\`, \`go_to_definition\`, and \`get_entity_info\` for typed definitions and references.
- Syntax and operators: use \`parse_pdx_fragment\`, completions, and fresh diagnostics. Do not infer an operator, field, parameter, or block form from another game or an older version.
- Project behaviour: use \`query_project_knowledge\` and \`explore_pdx_project\`, then read only the matched current project or vanilla archetype blocks needed for the decision.
- Overrides: use \`query_override_modes\` for the exact intended target path and obey its returned \`decision\` as authoritative. Never assume a generic load-order rule, reuse the procedure from a different returned strategy, or contradict \`decision.requiredApproach\` / \`decision.forbiddenApproaches\`. File naming, same-key redefinition, and whole-file replacement are strategy-specific choices, not interchangeable techniques.
- Localisation: use the active game profile and \`write_localisation\`; do not reproduce encoding, directory, header, or key-shape conventions from prompt memory.

### Decision boundary
CWT structure, hard facts, completions, typed definitions, parse results, and fresh diagnostics are legality evidence. CWT comments, documentation, project examples, and vanilla archetypes help explain intent but do not prove runtime gameplay behaviour. If active sources are missing or disagree, keep the fact unresolved and report the source/revision instead of filling it from model memory.

IDs/numeric suffixes and source order/layout never prove causality. Typed edges prove only direction/kind. Treat no indexed incoming edge as \`unknown\`, not an entry point; stale/partial gaps prove nothing.

Executable statements may be order-sensitive. Preserve source order unless current rule evidence and a verified archetype establish that reordering is safe. Validate the integrated final file after writing.

### Shader safety gate (.shader / .fxh)
- Effect names may be EXE ABI. Before rename/delete, call \`explain_shader_reachability\` and obey renamePolicy.
- A new Effect runs only through a data call, effectFile convention, or known engine entry.
- Visibility depends on root + Includes + platform. Repository search proves nothing; use \`query_shader_symbol\` and \`query_shader_compile_unit\`.
- In \`interface/*.gfx\`, effectFile selects a file; UI state then selects convention Effects such as \`Up/Down/Over/Disable/Text*\`. \`effect_file_convention_candidate\` does not make every Effect reachable. Check \`query_shader_callers\` for \`interfaceSprite\`, \`rendererSubtype\`, and the enclosing block; use the Shader project-knowledge edges to trace static \`.gui -> GFX_* -> shader file\` uses and renderer inputs.
- Before edits query reachability, callers, and compile units; afterward run \`validate_shader\` on every affected root.
- \`engine_or_unreferenced\` means reachability is unknown, not dead code. Never suggest deleting it.
- If Shader tools fail, report it and remain read-only; never guess semantics.
`;

/**
 * Compatibility exports retain the previous module surface without retaining
 * separate game fact blocks. Every profile now shares the same evidence policy.
 */
export const STELLARIS_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const HOI4_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const EU4_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const CK2_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const CK3_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const VIC2_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const VIC3_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const IMPERATOR_KNOWLEDGE = PARADOX_KNOWLEDGE;
export const EU5_KNOWLEDGE = PARADOX_KNOWLEDGE;

/** Return a stable policy header; all mutable facts are queried at run time. */
export function getGameKnowledge(languageId: string): string {
    const profile = getKnownProfileByLanguageId(languageId);
    const label = profile?.displayName ?? 'Generic Paradox';
    return `## ${label} PDXScript modding\n${PARADOX_KNOWLEDGE}`;
}

export function getGameDisplayName(languageId: string): string {
    return getKnownProfileByLanguageId(languageId)?.displayName ?? 'Paradox Game';
}
