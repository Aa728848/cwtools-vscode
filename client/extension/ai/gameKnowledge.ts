/**
 * CWTools AI Module — Game-Specific Knowledge
 *
 * Contains language/modding knowledge blocks for each supported Paradox game.
 * The PromptBuilder dynamically selects the appropriate knowledge block
 * based on the active languageId.
 */

// ─── Stellaris Knowledge (full, authoritative) ───────────────────────────────

export const STELLARIS_KNOWLEDGE = `
## PDXScript Syntax Rules
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: ONLY \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\` (use \`==\` not \`=\` for comparison)
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

## Strict Adherence to query_rules Schema (CRITICAL)
PDXScript is strictly typed. You MUST EXACTLY follow the syntax returned by the \`query_rules\` tool.
- **Do NOT Guess**: If unsure about parameters, you MUST use \`query_rules\` before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties (like \`multiply\`, \`add\`, \`limit\`, \`count\`) into a block unless explicitly listed.
- **Interpreting Syntax**:
  - If syntax is \`yes/no\` or \`bool\`, use \`trigger = yes\`.
  - If syntax is \`scope[...]\`, \`scope_group[...]\`, or \`<target>\`, use a scope target (e.g., \`FROM\`, \`event_target:X\`). **NEVER** use \`{ }\` code blocks for scopes! Example: \`is_background_planet = FROM\`.
  - ONLY use a \`{ ... }\` block if the syntax explicitly shows \`{ ... }\` or \`clause\`.
- **Unsupported Math**: If an effect (e.g. \`subtract_variable\`, \`add_modifier\`) doesn't support a math parameter like \`multiply = X\`, you MUST use workarounds:
  1. **Inline Script Value**: \`value = { value = my_var multiply = 4 }\`
  2. **Temp Variables**: Use \`multiply_variable\` on a \`temp_var\` beforehand.

## Scope System & Scope Links (CRITICAL)
Every block operates within a scope (Country, Planet, Ship, Fleet, Pop, Leader, …).
You can chain scopes using dot notation (e.g. \`owner.capital.owner\`) or nested blocks (\`owner = { capital_scope = { ... } }\`).
**CRITICAL**: Do NOT reject logical scope links (like \`leader.planet\`, \`leader.owner\`, \`planet.owner\`, \`pop.planet\`) just because you cannot find an explicit "scope_change" rule for them. Many scope links (like \`owner\`, \`planet\`, \`fleet\`, \`army\`, \`leader\`, \`system\`) are hardcoded native properties that work seamlessly across logical entity transitions.
- A leader can absolutely transition to \`owner\`, \`planet\`, \`fleet\`, or \`army\`.
- A pop can transition to \`planet\`, \`owner\`, \`faction\`.
- \`from\` / \`root\` / \`prev\` are used for context-relative references.
Assume logical scope transitions are VALID unless the LSP explicitly throws an error during \`validate_code\`. Do NOT proactively declare them "illegal" in your plans or reviews based on your own assumptions.

## Vanilla Game Cache — Query Strategy
The CWTools language server has already indexed the entire vanilla game.
**ALWAYS query LSP tools** — do NOT rely on memory, do NOT read vanilla game files directly.
LLM knowledge of PDXscript triggers, effects, and modifiers is frequently hallucinated;
the LSP server is the ONLY authoritative source for these constructs.

| Goal | Tool | Example |
|------|------|---------|
| Verify a vanilla ID exists | \`query_types("technology", "tech_energy")\` | Returns matching IDs |
| Find vanilla trait IDs | \`query_types("trait", "trait_robot")\` | Filter narrows results |
| Locate vanilla event file | \`workspace_symbols("distar.001")\` | Returns file path |
| Discover valid values at a position | \`get_completion_at(file, line, col)\` | Returns LSP completions |
| Find effect/trigger signature | \`query_rules("effect", "add_modifier")\` | Returns syntax |
| Find what uses a vanilla ID | \`query_references("tech_lasers_1")\` | All references |

**Rules**: always use the \`filter\` parameter with \`query_types\`; never call \`read_file\` on vanilla files.

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
`;

// ─── HOI4 Knowledge ──────────────────────────────────────────────────────────

export const HOI4_KNOWLEDGE = `
## PDXScript Syntax Rules (Hearts of Iron IV)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comments: \`#\` for line comments
- Strings: double quotes \`"like this"\`
- Variables: prefixed with \`@\` (e.g. \`@my_variable\`)
- **NO semicolons** — statements are separated by whitespace only

### Statement Separators (CRITICAL)
- PDXScript has **NO semicolons**. The \`;\` character is **NEVER valid syntax**.
- **NEVER suggest adding \`;\` between statements** — this will break the code.

## HOI4 Scope System
HOI4 scopes: Country, State, Character, Division, MilitaryIndustrialOrganization
You can chain scopes using dot notation. Assume logical native links are valid.
- \`ROOT\`, \`FROM\`, \`PREV\` — context-relative references
- \`owner\` → State to Country
- \`capital\` → Country to State

## Vanilla Query Strategy
**ALWAYS query LSP tools** — do NOT rely on memory. Use \`query_types\`, \`query_rules\`, \`workspace_symbols\` for any game construct lookups.

## HOI4 Modding Entities
Common directories: \`common/national_focus\`, \`common/ideas\`, \`common/technologies\`, \`common/decisions\`, \`events/\`, \`history/\`

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
- Boolean values: \`yes\` or \`no\`
- Comments: \`#\` for line comments
- **NO semicolons** — statements separated by whitespace only
- **NEVER suggest adding \`;\` between statements**

## EU4 Scope System
EU4 scopes: Country, Province, TradeNode, Advisor, Monarch, Heir, Consort
You can chain scopes using dot notation. Assume logical transitions (like \`owner\`, \`capital\`) are valid natively.
- \`ROOT\`, \`FROM\`, \`PREV\` — context-relative references
- \`owner\` → Province to Country
- \`capital_scope\` → Country to Province

## Vanilla Query Strategy
Use \`query_types\`, \`query_rules\`, \`workspace_symbols\` for game construct lookups. Never rely on memory for EU4 constructs.

## EU4 Modding Entities
Key directories: \`common/ideas\`, \`common/policies\`, \`common/national_ideas\`, \`decisions/\`, \`events/\`, \`missions/\`, \`history/\`

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

## CK2 Scope System
CK2 scopes: Character, Title, Province, Offmap, Wonder
- \`ROOT\`, \`FROM\`, \`FROMFROM\` — context-relative references
- Event triggers often work with character scopes

## Vanilla Query Strategy
Use CWTools LSP tools (\`query_types\`, \`query_rules\`) for all game entity lookups.

## CK2 Modding Entities
Key directories: \`common/\`, \`events/\`, \`decisions/\`, \`history/\`

## Localisation (CK2)
- File encoding: UTF-8 with BOM or Windows-1252
- CSV-style localisation in some versions
`;

// ─── CK3 Knowledge ───────────────────────────────────────────────────────────

export const CK3_KNOWLEDGE = `
## PDXScript Syntax Rules (Crusader Kings III)
- Key-value pairs: \`key = value\`
- Code blocks: \`key = { ... }\`
- Boolean values: \`yes\` or \`no\`
- Comments: \`#\` for line comments
- Variables: \`@variable_name\`
- Script values: \`value:script_value_name\`
- **NO semicolons** — statements separated by whitespace only

## CK3 Scope System
CK3 scopes: Character, Title, Province, County, Duchy, Kingdom, Empire, Culture, Faith, Dynasty, House
- \`root\`, \`scope:character\`, \`prev\` — context references
- CK3 uses data types extensively — scopes are strongly typed

## Vanilla Query Strategy
Use CWTools LSP tools for all construct lookups. \`query_types\`, \`query_rules\`, \`workspace_symbols\` are your primary tools.

## CK3 Modding Entities
Key directories: \`common/\`, \`events/\`, \`gfx/\`, \`gui/\`, \`localization/\`

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

## VIC2 Scope System
Scopes: Country, Province, Pop
- \`THIS\`, \`FROM\` — context references

## Vanilla Query Strategy
Use CWTools LSP tools for entity lookups.

## VIC2 Modding Entities
Key directories: \`common/\`, \`events/\`, \`decisions/\`, \`history/\`
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

## VIC3 Scope System
VIC3 scopes: Country, State, StateRegion, Market, Pop, Building, InterestGroup, PoliticalMovement
- \`root\`, \`scope:country\`, \`prev\` — context references
- VIC3 uses strongly-typed scopes similar to CK3

## Vanilla Query Strategy
Use CWTools LSP tools for all game construct lookups. Do NOT rely on memory.

## VIC3 Modding Entities
Key directories: \`common/\`, \`events/\`, \`gfx/\`, \`gui/\`, \`localization/\`

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

## Imperator Scope System
Scopes: Country, Province, Character, Family, Pop
- \`ROOT\`, \`FROM\`, \`PREV\` — context references

## Vanilla Query Strategy
Use CWTools LSP tools for all lookups.

## Imperator Modding Entities
Key directories: \`common/\`, \`events/\`, \`decisions/\`, \`localization/\`

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

## EU5 Scope System
EU5 uses strongly-typed scopes similar to CK3/VIC3.
- \`root\`, \`scope:country\`, \`prev\` — context references

## Vanilla Query Strategy
Use CWTools LSP tools for all game construct lookups. EU5 is a newer title — LLM knowledge is particularly unreliable.

## EU5 Modding Entities
Key directories: \`common/\`, \`events/\`, \`gfx/\`, \`gui/\`, \`localization/\`

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

## Strict Adherence to query_rules Schema (CRITICAL)
PDXScript is strictly typed. You MUST EXACTLY follow the syntax returned by the \`query_rules\` tool.
- **Do NOT Guess**: If unsure about parameters, you MUST use \`query_rules\` before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties (like \`multiply\`, \`add\`, \`limit\`, \`count\`) into a block unless explicitly listed.
- **Interpreting Syntax**:
  - If syntax is \`yes/no\` or \`bool\`, use \`trigger = yes\`.
  - If syntax is \`scope[...]\`, \`scope_group[...]\`, or \`<target>\`, use a scope target (e.g., \`FROM\`, \`event_target:X\`). **NEVER** use \`{ }\` code blocks for scopes!
  - ONLY use a \`{ ... }\` block if the syntax explicitly shows \`{ ... }\` or \`clause\`.
- **Unsupported Math**: If an effect doesn't support a math parameter like \`multiply = X\`, use workarounds:
  1. **Inline Script Value**: \`value = { value = my_var multiply = 4 }\`
  2. **Temp Variables**: Use \`multiply_variable\` on a \`temp_var\` beforehand.

## Vanilla Query Strategy
Use CWTools LSP tools (\`query_types\`, \`query_rules\`, \`workspace_symbols\`) for all game construct lookups.
Do NOT rely on memory — always verify with the LSP server.
`;

// ─── Game ID → Knowledge Mapping ─────────────────────────────────────────────

/**
 * Returns the game-specific knowledge block based on the languageId.
 * Defaults to Stellaris (the most comprehensive block) if languageId is unknown.
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
        default: return STELLARIS_KNOWLEDGE;
    }
}

/**
 * Returns the display name of the game.
 */
export function getGameDisplayName(languageId: string): string {
    switch (languageId) {
        case 'stellaris': return 'Stellaris';
        case 'hoi4': return 'Hearts of Iron IV';
        case 'eu4': return 'Europa Universalis IV';
        case 'ck2': return 'Crusader Kings II';
        case 'ck3': return 'Crusader Kings III';
        case 'vic2': return 'Victoria II';
        case 'vic3': return 'Victoria 3';
        case 'imperator': return 'Imperator: Rome';
        case 'eu5': return 'Europa Universalis V';
        case 'paradox': return 'Paradox Game';
        default: return 'Stellaris';
    }
}
