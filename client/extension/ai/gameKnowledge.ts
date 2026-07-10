/**
 * CWTools AI Module — Game-Specific Knowledge
 *
 * Contains language/modding knowledge blocks for each supported Paradox game.
 * The PromptBuilder dynamically selects the appropriate knowledge block
 * based on the active languageId.
 */

import { getProfileByLanguageId } from '../gameProfiles';

// ─── Stellaris Static Guardrails (non-authoritative) ─────────────────────────

export const STELLARIS_KNOWLEDGE = `
## PDXScript Syntax Rules
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: ONLY \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Numeric/quantity comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`. Treat \`!=\` like \`>=\`: it belongs to numeric/amount/value comparisons only, not general inequality for IDs, enums, booleans, strings, flags, scopes, or event targets.
- For non-quantity negation, wrap the normal trigger in \`NOT = { ... }\` instead of writing \`key != value\` unless the rule schema explicitly permits that operator.
- Comments: \`#\` for line comments
- Strings: use double quotes \`"like this"\`
- Variables: prefixed with \`@\` (e.g. \`@my_variable\`)
- Script values: \`value:script_value_name\` or \`value:script_value_name|param|value|\`

### Statement Separators (CRITICAL — DO NOT MISAPPLY)
- PDXScript has **NO semicolons**. The \`;\` character is **NEVER valid syntax**.
- Statements are separated by **whitespace** (newlines or spaces). Both forms below are **equally valid and identical** in meaning:
  \`\`\`
  # Multi-line form:
  exists = owner
  owner = { is_invisible_faction = no }

  # Single-line form (ALSO CORRECT — do NOT add semicolons or flag as error):
  exists = owner owner = { is_invisible_faction = no }
  \`\`\`
- **NEVER suggest adding \`;\` between statements** — this will break the code.
- Multiple key-value pairs on the same line are common and intentional in PDXScript.

### Execution Order (CRITICAL)
- Executable PDXScript commands/effects in the same file and block are processed **top-to-bottom in textual order**.
- Do not assume a later command has already run for an earlier command. Setup commands, flags, variables, or scope preparation must appear before the command that uses them, and the specific effect names must be verified through active CWT/LSP evidence.
- When repairing diagnostics, preserve meaningful statement order; do not sort, hoist, or move commands across setup/use boundaries unless you have verified the gameplay semantics.

## Override & Load-Order Semantics (CRITICAL - USE ACTIVE CWT RULES)
**Do not assume "last file wins".** Stellaris resolves conflicts differently per path and sometimes per entry. Neither the path-to-mode mapping nor the meaning of each mode is hard-coded in this prompt; both come from the active CWT rules currently loaded by the language server.

Before advising on vanilla overrides, call \`query_override_modes({ path: "common/ship_sizes/00_ship_sizes.txt" })\` for the target file or directory. The server returns:
- \`matched\` + \`matchedModeInfo\`: the longest matching active rule path, its mode (\`LIOS\`, \`FIOS\`, \`DUPL\`, \`NO\`, \`MERGE\`, ...), and that mode's documentation.
- \`modeInfo\`: the full legend: every mode's \`name\` and \`description\` (meaning / who wins by default / how to override vanilla), sourced from the CWT \`override_modes_info\` block.

Read the mode semantics from \`modeInfo\` / \`matchedModeInfo\` instead of relying on memory or any background assumption. The descriptions below are NOT duplicated here on purpose; they are maintained in the CWT rules so they stay in sync with the active configuration.

### Operating rules for the Agent
1. **NEVER tell the user to "just redefine the key in a new file, it overrides vanilla" without first calling \`query_override_modes\` for the target path and reading \`matchedModeInfo\`.** For FIOS/DUPL/NO/MERGE paths that advice is often wrong and the override will silently fail or error.
2. Follow the \`description\` returned for the matched mode verbatim for the correct override strategy; do not use examples or memory as the source of override semantics.
3. For **on_actions** or any other path-specific system, read the active \`matchedModeInfo\` / \`modeInfo\` before advising whether entries merge, replace, duplicate, or require whole-file overrides.
4. If \`query_override_modes\` returns no \`matched\`, say the active CWT rules do not define an override mode for that path and verify with local examples/diagnostics instead of guessing. If \`matched\` exists but \`matchedModeInfo\` is absent, use the returned \`strategy\` as the active mode but say that this mode lacks CWT documentation and verify the override strategy before giving final advice.
5. Static knowledge in this prompt is background guidance. If it conflicts with \`query_override_modes\` (\`matched\`/\`matchedModeInfo\`/\`modeInfo\`), \`query_rules\` \`hardFacts\`, LSP completion/diagnostics, or verified current-version examples, prefer the verified local evidence and state the conflict.

## CWT/LSP Evidence Routing (CRITICAL)
PDXScript is strictly typed. Static prompt text is only background guidance; active CWT/LSP evidence is authoritative.
- For common/entity/schema files, call \`query_cwt_schema\` or \`get_completion_at\` before writing fields or block shapes.
- For triggers, effects, scope changes, and modifiers, call \`query_rules\`, \`query_scope\`, \`search_rule_capabilities\`, or completion tools before writing.
- **Do NOT Guess**: If unsure about parameters, fields, values, scope links, or block shape, query active CWT/LSP before writing code.
- **Hard facts vs semantic hints**: CWT comments/docs and \`semanticHints\` guide retrieval and intent. Legality comes from CWT structure, \`hardFacts\`, completions, diagnostics, parse checks, and verified current-version examples.
- **Never Invent Parameters**: Do NOT add arbitrary properties (like \`multiply\`, \`add\`, \`limit\`, \`count\`) into a block unless active CWT/LSP evidence explicitly supports them.

## Scope, on_action, and Event Contexts
Do not rely on static prompt knowledge for scopes, scope links, optional scope syntax, event contexts, or on_action payloads. These are dynamic game-version facts.
- Query the active CWT/LSP context with \`query_scope\`, \`query_rules(category="scope_change")\`, \`query_cwt_schema\`, \`get_completion_at\`, and diagnostics.
- Use project or vanilla examples only after an indexed lookup identifies a concrete current-version archetype.
- If static background text and active CWT/LSP evidence disagree, follow active CWT/LSP and state the conflict.

## Vanilla Game Cache — Query Strategy
The CWTools language server has already indexed the entire vanilla game.
Use the shared evidence hierarchy for vanilla knowledge: CWT/LSP schema and typed indexes first, current project examples second, bounded vanilla archetype evidence third, web last.
LLM knowledge of PDXscript triggers, effects, modifiers, and common entity families is frequently hallucinated;
CWT/LSP evidence is authoritative for syntax, types, scopes, enum values, and diagnostics.

| Goal | Tool | Example |
|------|------|---------|
| Verify a vanilla ID exists | \`query_types("technology", "tech_energy")\` | Returns matching IDs |
| Find vanilla trait IDs | \`query_types("trait", "trait_robot")\` | Filter narrows results |
| Locate vanilla event file | \`workspace_symbols("distar.001")\` | Returns file path |
| Discover valid values at a position | \`get_completion_at(file, line, col)\` | Returns LSP completions |
| Find effect/trigger signature | \`query_rules("effect", "add_modifier")\` | Returns syntax |
| Find the right rule for an intent | \`search_rule_capabilities(intent, currentScope, desiredPushScope)\` | Ranks legal candidates without guessing names |
| Understand a scope alias/subscope | \`explain_scope("Carrier")\` | Reads aliases and subscope hints from scopes.cwt |
| Check a draft fragment syntax | \`parse_pdx_fragment(code)\` | Parser/brace sanity check before writing |
| Find what uses a vanilla ID | \`query_references("tech_lasers_1")\` | All references |

**Rules**: always use the \`filter\` parameter with \`query_types\`. For archetype design, bounded vanilla reads are allowed only after an indexed/exact lookup identifies a concrete example; prefer \`get_entity_info\`, \`document_symbols\`, and \`get_pdx_block\` before any raw \`read_file\`.

## Deep API Tools — Anti-Hallucination Arsenal
These tools bypass file-system text search and query the CWTools AST directly.

| Goal | Tool | When to use |
|------|------|-------------|
| Verify a scripted_effect exists | \`query_scripted_effects(filter)\` | **BEFORE every scripted_effect call** |
| Verify a scripted_trigger exists | \`query_scripted_triggers(filter)\` | **BEFORE every scripted_trigger usage** |
| Look up valid enum values | \`query_enums("enum_name")\` | Whenever you need values for an enum field |
| Find where a symbol is defined | \`query_definition_by_name(symbolName="symbol")\` | **Replaces grep** for locating definitions |
| Find referenced types in a file | \`get_entity_info(file)\` | Understanding what a file depends on |
| List static modifier tags | \`query_static_modifiers(filter)\` | Verifying \`add_modifier = { modifier = X }\` |
| Look up @variable values | \`query_variables(filter)\` | Before using any @-prefixed constant |

**Priority rule**: Use deep API tools **instead of** \`search_mod_files\` for symbol lookups.
Deep API tools query the AST — they are 10-100x faster and report scope constraints.

## Localisation Files (Stellaris)
Stellaris localisation files use YAML-like format in the \`localisation/\` directory:
- File encoding: **UTF-8 with BOM** (\\uFEFF must be the first character)
- First line must declare the language: \`l_english:\`, \`l_simp_chinese:\`, \`l_french:\`, etc.
- Key format: \` key:0 "Displayed text"\` (note the leading space and \`:0\` version suffix)
- Color codes: \`§H\`, \`§R\`, \`§G\`, \`§Y\`, \`§!\` (reset) — e.g. \`§HBold text§!\`
- Variable substitution: \`$VARIABLE$\` (references another loc key or scripted variable)
- Example:
  \`\`\`yaml
  l_english:
   my_event.1.title:0 "The Discovery"
   my_event.1.desc:0 "We have found §Gsomething§! interesting on [Root.GetName]."
  \`\`\`

## Dynamic Game-Context Discovery
Static prompt text must not encode current-version CWT facts such as on_action payloads, scope tables, special-project scopes, archaeological-site event scopes, entity availability, or subsystem directory capability.

When designing complex features:
1. Use \`query_cwt_schema\` on the target \`common/\`, \`events/\`, \`interface/\`, \`gfx/\`, or \`sound/\` path before choosing fields or entity topology.
2. Use \`query_rules\`, \`query_scope\`, \`search_rule_capabilities\`, and \`get_completion_at\` for trigger/effect/scope details.
3. Use \`explore_pdx_project\` to discover the bounded dependency graph, then \`query_types\`, \`query_workspace_index\`, \`query_definition_by_name\`, and \`workspace_symbols\` to locate concrete current project or vanilla archetypes.
4. Read only the matched archetype blocks/ranges needed to understand structure, scope flow, and references.
5. Record the CWT/LSP and archetype evidence used. If no active evidence exists, treat the design point as unresolved instead of filling it from static memory.

Do not copy scope, on_action, or subsystem facts from this prompt; they are intentionally absent and must come from active tools.
`;

// ─── HOI4 Knowledge ──────────────────────────────────────────────────────────

export const HOI4_KNOWLEDGE = `
## PDXScript Syntax Rules (Hearts of Iron IV)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`
- Comments: \`#\` for line comments
- Strings: double quotes \`"like this"\`
- Variables: prefixed with \`@\` (e.g. \`@my_variable\`)

### Statement Separators (CRITICAL — DO NOT MISAPPLY)
- PDXScript has **NO semicolons**. The \`;\` character is **NEVER valid syntax**.
- Statements are separated by **whitespace** (newlines or spaces).
- **NEVER suggest adding \`;\` between statements** — this will break the code.
- Multiple key-value pairs on the same line are common and intentional.

## CWT/LSP Evidence Routing (CRITICAL)
PDXScript is strictly typed. Static game notes are not legality proof.
- Use \`query_cwt_schema\` for common/entity/schema structure before writing fields or block shapes.
- Use \`query_rules\`, \`query_scope\`, \`search_rule_capabilities\`, and completions for triggers, effects, scope changes, and modifiers.
- **Do NOT Guess**: If unsure about parameters, scope links, values, or block shape, query active CWT/LSP before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties into a block unless active CWT/LSP evidence explicitly supports them.

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, links, context references, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Deep API Tools — Anti-Hallucination Arsenal
These tools query the CWTools AST directly — use them INSTEAD of \`search_mod_files\` for symbol lookups.

| Goal | Tool | When to use |
|------|------|-------------|
| Verify a scripted_effect exists | \`query_scripted_effects(filter)\` | BEFORE every scripted_effect call |
| Verify a scripted_trigger exists | \`query_scripted_triggers(filter)\` | BEFORE every scripted_trigger usage |
| Look up valid enum values | \`query_enums("enum_name")\` | Whenever you need values for an enum field |
| Find where a symbol is defined | \`query_definition_by_name(symbolName="symbol")\` | Replaces grep for locating definitions |
| Find referenced types in a file | \`get_entity_info(file)\` | Understanding file dependencies |
| List static modifier tags | \`query_static_modifiers(filter)\` | Verifying modifier usage |
| Look up @variable values | \`query_variables(filter)\` | Before using any @-prefixed constant |

## Vanilla Query Strategy
**ALWAYS query LSP tools** — do NOT rely on memory. Use \`query_cwt_schema\`, \`query_types\`, \`query_rules\`, and \`workspace_symbols\` for any game construct lookups.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.

## Localisation (HOI4)
- File encoding: **UTF-8 with BOM** (\\uFEFF)
- First line: \`l_english:\` (or \`l_simp_chinese:\`, etc.)
- Key format: \` key:0 "text"\`
- Color codes: \`§H\`, \`§R\`, \`§G\`, \`§Y\`, \`§!\`
`;

// ─── EU4 Knowledge ───────────────────────────────────────────────────────────

export const EU4_KNOWLEDGE = `
## PDXScript Syntax Rules (Europa Universalis IV)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`
- Comments: \`#\` for line comments

### Statement Separators (CRITICAL — DO NOT MISAPPLY)
- PDXScript has **NO semicolons**. The \`;\` character is **NEVER valid syntax**.
- Statements are separated by **whitespace** (newlines or spaces).
- **NEVER suggest adding \`;\` between statements** — this will break the code.

## CWT/LSP Evidence Routing (CRITICAL)
PDXScript is strictly typed. Static game notes are not legality proof.
- Use \`query_cwt_schema\` for common/entity/schema structure before writing fields or block shapes.
- Use \`query_rules\`, \`query_scope\`, \`search_rule_capabilities\`, and completions for triggers, effects, scope changes, and modifiers.
- **Do NOT Guess**: If unsure about parameters, scope links, values, or block shape, query active CWT/LSP before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties into a block unless active CWT/LSP evidence explicitly supports them.

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, links, context references, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Deep API Tools — Anti-Hallucination Arsenal
These tools query the CWTools AST directly — use them INSTEAD of \`search_mod_files\` for symbol lookups.

| Goal | Tool | When to use |
|------|------|-------------|
| Verify a scripted_effect exists | \`query_scripted_effects(filter)\` | BEFORE every scripted_effect call |
| Verify a scripted_trigger exists | \`query_scripted_triggers(filter)\` | BEFORE every scripted_trigger usage |
| Look up valid enum values | \`query_enums("enum_name")\` | Whenever you need values for an enum field |
| Find where a symbol is defined | \`query_definition_by_name(symbolName="symbol")\` | Replaces grep for locating definitions |
| Find referenced types in a file | \`get_entity_info(file)\` | Understanding file dependencies |
| List static modifier tags | \`query_static_modifiers(filter)\` | Verifying modifier usage |
| Look up @variable values | \`query_variables(filter)\` | Before using any @-prefixed constant |

## Vanilla Query Strategy
Use \`query_cwt_schema\`, \`query_types\`, \`query_rules\`, and \`workspace_symbols\` for game construct lookups. Never rely on memory for EU4 constructs.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.

## Localisation (EU4)
- File encoding: UTF-8 with BOM
- First line: \`l_english:\`
- Key format: \` key:0 "text"\`
`;

// ─── CK2 Knowledge ───────────────────────────────────────────────────────────

export const CK2_KNOWLEDGE = `
## PDXScript Syntax Rules (Crusader Kings II)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\`
- Comments: \`#\` for line comments
- **NO semicolons** — whitespace as separator

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, context references, event contexts, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Vanilla Query Strategy
Use CWTools LSP tools (\`query_cwt_schema\`, \`query_types\`, \`query_rules\`) for all game entity lookups.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.

## Localisation (CK2)
- File encoding: UTF-8 with BOM or Windows-1252
- CSV-style localisation in some versions
`;

// ─── CK3 Knowledge ───────────────────────────────────────────────────────────

export const CK3_KNOWLEDGE = `
## PDXScript Syntax Rules (Crusader Kings III)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`
- Comments: \`#\` for line comments
- Variables: \`@variable_name\`
- Script values: \`value:script_value_name\`

### Statement Separators (CRITICAL — DO NOT MISAPPLY)
- PDXScript has **NO semicolons**. The \`;\` character is **NEVER valid syntax**.
- Statements are separated by **whitespace** (newlines or spaces).
- **NEVER suggest adding \`;\` between statements** — this will break the code.

## CWT/LSP Evidence Routing (CRITICAL)
PDXScript is strictly typed. Static game notes are not legality proof.
- Use \`query_cwt_schema\` for common/entity/schema structure before writing fields or block shapes.
- Use \`query_rules\`, \`query_scope\`, \`search_rule_capabilities\`, and completions for triggers, effects, scope changes, and modifiers.
- **Do NOT Guess**: If unsure about parameters, scope links, values, or block shape, query active CWT/LSP before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties into a block unless active CWT/LSP evidence explicitly supports them.

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, links, context references, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Deep API Tools — Anti-Hallucination Arsenal
These tools query the CWTools AST directly — use them INSTEAD of \`search_mod_files\` for symbol lookups.

| Goal | Tool | When to use |
|------|------|-------------|
| Verify a scripted_effect exists | \`query_scripted_effects(filter)\` | BEFORE every scripted_effect call |
| Verify a scripted_trigger exists | \`query_scripted_triggers(filter)\` | BEFORE every scripted_trigger usage |
| Look up valid enum values | \`query_enums("enum_name")\` | Whenever you need values for an enum field |
| Find where a symbol is defined | \`query_definition_by_name(symbolName="symbol")\` | Replaces grep for locating definitions |
| Find referenced types in a file | \`get_entity_info(file)\` | Understanding file dependencies |
| List static modifier tags | \`query_static_modifiers(filter)\` | Verifying modifier usage |
| Look up @variable values | \`query_variables(filter)\` | Before using any @-prefixed constant |

## Vanilla Query Strategy
Use CWTools LSP tools for all construct lookups. \`query_cwt_schema\`, \`query_types\`, \`query_rules\`, and \`workspace_symbols\` are your primary tools.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.

## Localisation (CK3)
- File encoding: UTF-8 with BOM
- Directory: \`localization/\` (American spelling!)
- First line: \`l_english:\`
- Key format: \` key:0 "text"\`
- Concept references: \`[concept_name]\`
`;

// ─── VIC2 Knowledge ──────────────────────────────────────────────────────────

export const VIC2_KNOWLEDGE = `
## PDXScript Syntax Rules (Victoria II)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\`
- Comments: \`#\` for line comments
- **NO semicolons**

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, context references, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Vanilla Query Strategy
Use CWTools LSP tools for entity lookups, including \`query_cwt_schema\` for schema/entity shape.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.
`;

// ─── VIC3 Knowledge ──────────────────────────────────────────────────────────

export const VIC3_KNOWLEDGE = `
## PDXScript Syntax Rules (Victoria 3)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\`
- Comments: \`#\` for line comments
- Variables: \`@variable_name\`
- Script values: \`value:script_value_name\`
- **NO semicolons** — statements separated by whitespace only

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, context references, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Vanilla Query Strategy
Use CWTools LSP tools for all game construct lookups, including \`query_cwt_schema\` for schema/entity shape. Do NOT rely on memory.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.

## Localisation (VIC3)
- File encoding: UTF-8 with BOM
- Directory: \`localization/\` (American spelling)
- First line: \`l_english:\`
- Key format: \` key:0 "text"\`
`;

// ─── Imperator Knowledge ─────────────────────────────────────────────────────

export const IMPERATOR_KNOWLEDGE = `
## PDXScript Syntax Rules (Imperator: Rome)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\`
- Comments: \`#\` for line comments
- Variables: \`@variable_name\`
- **NO semicolons**

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, context references, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Vanilla Query Strategy
Use CWTools LSP tools for all lookups, including \`query_cwt_schema\` for schema/entity shape.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.

## Localisation (Imperator)
- File encoding: UTF-8 with BOM
- First line: \`l_english:\`
- Key format: \` key:0 "text"\`
`;

// ─── EU5 Knowledge ───────────────────────────────────────────────────────────

export const EU5_KNOWLEDGE = `
## PDXScript Syntax Rules (Europa Universalis V / Project Caesar)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\`
- Comments: \`#\` for line comments
- Variables: \`@variable_name\`
- Script values: \`value:script_value_name\`
- **NO semicolons** — statements separated by whitespace only

## Scope Discovery
Do not use static scope lists from this prompt. Scope names, context references, and native transitions must be retrieved from active CWT/LSP tools and verified with diagnostics or current-version archetypes.

## Vanilla Query Strategy
Use CWTools LSP tools for all game construct lookups, including \`query_cwt_schema\` for schema/entity shape. EU5 is a newer title — LLM knowledge is particularly unreliable.

## Entity And Directory Discovery
Do not rely on static directory lists from this prompt. Discover valid directories, entity types, and file shapes from active CWT/LSP schema, workspace indexes, and current-version examples.

## Localisation (EU5)
- File encoding: UTF-8 with BOM
- Directory: \`localization/\`
- First line: \`l_english:\`
- Key format: \` key:0 "text"\`
`;

// ─── Shared Core (Paradox / Fallback) ────────────────────────────────────────

export const PARADOX_KNOWLEDGE = `
## PDXScript Syntax Rules (Generic Paradox)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comments: \`#\` for line comments
- **NO semicolons** — statements separated by whitespace only
- **NEVER suggest adding \`;\` between statements**

## CWT/LSP Evidence Routing (CRITICAL)
PDXScript is strictly typed. Static game notes are not legality proof.
- Use \`query_cwt_schema\` for common/entity/schema structure before writing fields or block shapes.
- Use \`query_rules\`, \`query_scope\`, \`search_rule_capabilities\`, and completions for triggers, effects, scope changes, and modifiers.
- **Do NOT Guess**: If unsure about parameters, scope links, values, or block shape, query active CWT/LSP before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties into a block unless active CWT/LSP evidence explicitly supports them.

## Vanilla Query Strategy
Use CWTools LSP tools (\`query_cwt_schema\`, \`query_types\`, \`query_rules\`, \`workspace_symbols\`) for all game construct lookups.
Do NOT rely on memory — always verify with the LSP server.
Static knowledge is background guidance only; prefer active CWT schema, \`query_rules\` \`hardFacts\`, \`search_rule_capabilities\`, LSP completion/diagnostics, and verified current-version examples when they disagree.
`;

// ─── Game ID → Knowledge Mapping ─────────────────────────────────────────────

/**
 * Returns the game-specific knowledge block based on the languageId.
 * Defaults to the generic Paradox block if languageId is unknown to avoid leaking
 * Stellaris-specific rules into other PDXScript games.
 */
export function getGameKnowledge(languageId: string): string {
    switch (languageId) {
        case 'stellaris': return STELLARIS_KNOWLEDGE;
        case 'hoi4': return HOI4_KNOWLEDGE;
        case 'eu4': return EU4_KNOWLEDGE;
        case 'ck2': return CK2_KNOWLEDGE;
        case 'ck3': return CK3_KNOWLEDGE;
        case 'vic2': return VIC2_KNOWLEDGE;
        case 'vic3': return VIC3_KNOWLEDGE;
        case 'imperator': return IMPERATOR_KNOWLEDGE;
        case 'eu5': return EU5_KNOWLEDGE;
        case 'paradox': return PARADOX_KNOWLEDGE;
        default: return PARADOX_KNOWLEDGE;
    }
}

/**
 * Returns the display name of the game.
 * Delegates to the GameProfile registry for known games.
 */
export function getGameDisplayName(languageId: string): string {
    if (languageId === 'paradox') return 'Paradox Game';
    return getProfileByLanguageId(languageId).displayName;
}
