/**
 * CWTools AI Module — Game-Specific Knowledge
 *
 * Contains language/modding knowledge blocks for each supported Paradox game.
 * The PromptBuilder dynamically selects the appropriate knowledge block
 * based on the active languageId.
 */

import { getProfileByLanguageId } from '../gameProfiles';

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

## Override & Load-Order Semantics (CRITICAL — DO NOT ASSUME "LAST FILE WINS")
**The single most common misconception is that every file/entry is overridden by the last one loaded.** This is FALSE. Stellaris resolves conflicts differently **per folder, and sometimes per entry**. Mods load AFTER vanilla, and later mods after earlier ones (alphabetically by filename within a folder, then by mod load order). Whether "your version" wins depends on the folder's resolution mode:

| Mode | Meaning | Who wins by default | How to override vanilla |
|------|---------|---------------------|--------------------------|
| **LIOS** | Last In, Only Served | The **last**-loaded definition of a key | Redefine the same key — your mod loads after vanilla, so it wins. The intuitive case. |
| **FIOS** | First In, Only Served | The **first**-loaded definition (so **vanilla wins** by default!) | Your file must load **before** the vanilla file — name it to sort earlier (e.g. \`00_\`/\`!\` prefix). Simply redefining a key in a normal file does **NOT** override; vanilla keeps priority. |
| **FIXES** | First wins, error logged | The first definition; later duplicate keys are rejected with an "already exists" error | Replace the original file or out-sort it. Redefining the key logs an error and your version is **ignored**. |
| **DUPL** | Duplicates kept | **Both** entries are kept (additive/merge) — can corrupt the entity | Usually you must override the **entire file** (replace whole file by same path), not add a same-key entry. |
| **NO** | Cannot individually overwrite | Existing entries cannot be replaced at all | Replace the **whole file**. For some (e.g. \`on_actions\`) new entries **merge** with existing ones rather than overwrite. |

### Per-folder resolution (verified-against-the-table reference — confirm before relying on it)
- **LIOS (redefine the key, your file wins)** — most \`common/\` definitions: \`buildings\`, \`districts\`, \`technology\`*, \`traditions\`, \`tradition_categories\`, \`ascension_perks\`, \`edicts\`, \`policies\`, \`decisions\`, \`relics\`, \`armies\`, \`anomalies\`, \`archaeological_site_types\`, \`bombardment_stances\`, \`country_types\`, \`crisis_levels\`, \`crisis_objectives\`, \`deposits\`, \`deposit_categories\`, \`economic_categories\`, \`espionage_assets\`, \`ethics\`, \`event_chains\`, \`first_contact\`, \`game_rules\`, \`governments/civics\`, \`intel_categories\`, \`intel_levels\`, \`leader_classes\`, \`mandates\`, \`megastructures\`, \`message_types\`, \`personalities\`, \`pop_factions\`, \`pop_faction_types\`, \`pop_jobs\`, \`resolutions\`, \`resolution_categories\`, \`script_values\`, \`scripted_triggers\`, \`scripted_modifiers\`, \`sector_types\`, \`ship_types\`, \`species_archetypes\`, \`species_classes\`, \`species_rights\`, \`starbase_buildings\`, \`starbase_levels\`, \`starbase_modules\`, \`starbase_types\`, \`star_classes\`, \`static_modifiers\`, \`war_goals\`.
- **FIOS (vanilla wins unless you out-sort the filename earlier)** — \`governments\` & \`governments/authorities\` (specific override impossible — entire override only), \`pop_jobs\`-style tag overrides, \`ship_sizes\`, \`ship_behaviors\`, \`diplomatic_actions\`, \`solar_system_initializers\`, \`special_projects\`, \`colony_automation\`, \`component_slot_templates\`, \`scripted_loc\`, \`start_screen_messages\` (first valid entry per location is used, rest discarded).
- **FIXES (first wins, "already exists" error if you redefine)** — \`scripted_effects\`, \`component_sets\`, \`component_templates\`, \`global_ship_designs\`.
- **DUPL (both kept — override the whole file)** — \`name_lists\`, \`strategic_resources\` (must replace the whole file or the name breaks), \`planet_classes\` (DUPL breaks habitability modifiers if partially overwritten), \`inline_scripts\`, \`observation_station_missions\`.
- **NO / merge-only (cannot overwrite a single entry)** — \`section_templates\` ("Duplicate section template found" — replace the whole file), \`on_actions\` (cannot modify existing entries; new entries are **merged** with the same-named entry — so to change vanilla behaviour you append, you do not redefine), \`traits\` (entire override only).
- **\`defines\`**: redefine the specific define, **but the enclosing block must be included as well** (e.g. wrap your override in its \`NGameplay = { ... }\` block).
- **Localisation / events / interface / fonts**: generally LIOS (last loaded wins). Events are usually LIOS but be careful — verify per case.

\* \`technology\` is mostly LIOS in practice but emits a DUPL-type "already exists" error; to fully override you may need to also carry the \`potential\` block from the vanilla entry.

### Operating rules for the Agent
1. **NEVER tell the user to "just redefine the key in a new file, it overrides vanilla" without first checking the folder's resolution mode.** For FIOS/FIXES/DUPL/NO folders that advice is wrong and the override will silently fail or error.
2. For **FIOS** targets, the correct guidance is to **name the file so it sorts before the vanilla file** (or replace the whole file), not to rely on load order.
3. For **DUPL / NO** targets, instruct the user to **replace the entire vanilla file** (same relative path/filename) rather than add a single same-key entry.
4. For **on_actions**, remember entries **merge** — to extend vanilla behaviour, add a new \`on_actions\` block with the same on_action name (its contents are appended); to *remove* vanilla behaviour you must overwrite the whole file.
5. This table is from community testing and is **not exhaustive or guaranteed per version** ("not everything could be tested extensively"). When override behaviour matters, **verify** against the project's CWT rules, vanilla file layout, and the user's game version before finalizing; state the resolution mode you are assuming.

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
Treat common logical scope links as plausible hardcoded native links, then verify before final blueprint/build with \`query_scope\`, \`query_rules(category="scope_change")\`, completions, diagnostics, or a verified project/vanilla archetype. Do NOT reject them solely because an explicit scope_change rule is missing; do NOT finalize them solely from memory.

### Optional Scope Operator \`scope?\` (NEW syntax — DO NOT flag as an error)
Recent Stellaris versions support the **optional / null-safe scope operator**: a trailing \`?\` on a scope link. \`scope? = { ... }\` is shorthand for "enter \`scope\` only if it exists" — it folds an existence guard into the scope change itself.
- These two forms are **equivalent**:
  \`\`\`
  # Old form — explicit existence guard:
  exists = owner
  owner = { ... }

  # New form — optional scope (SAME meaning, do NOT reject):
  owner? = { ... }
  \`\`\`
- Works on chained links too: \`owner.capital_scope? = { ... }\` enters the block only if \`owner.capital_scope\` resolves to a valid scope.
- **NEVER flag \`scope?\` as a syntax error or suggest removing the \`?\`.** It is valid modern PDXScript.
- When the target scope may be null/absent, prefer \`scope? = { ... }\` over a separate \`exists = scope\` line — it is more concise and avoids the scope being entered on a non-existent target.
- Still verify the underlying scope link is real (via \`query_scope\` / completions); the \`?\` only changes existence handling, not whether the link itself is valid.

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

## Complex Entity Archetypes (Cascading Trigger Pipelines)

When designing entities that span multiple game subsystems, think in terms of a
**cascading trigger pipeline** — each node triggers the next, potentially crossing
scope boundaries. ALL scope data below is verified against CWTools .cwt rules.

### Archaeological Site Pipeline Pattern
\`\`\`
[on_action / MTTH] → [archaeological_site] → stage fleet_events → [special_project] → [relic/reward]
\`\`\`
- Site STAGE events are **fleet_event** (this=fleet, from=archaeological_site) — NOT planet_event!
- \`archaeology = yes\` flag is MANDATORY on all stage events
- Access country via \`owner = { }\`, access planet via \`from = { planet = { } }\`
- special_project on_success scope depends on its \`event_scope\` field:
  - \`event_scope = ship_event\` → this = ship, from = creation scope
  - \`event_scope = planet_event\` → this = planet, from = creation scope
  - \`event_scope = country_event\` → this = country, from = creation scope
- Chain sites use scripted_effects to spawn next site within fleet scope
- Final stage grants relic via \`owner = { add_relic = r_xxx }\`
- Use \`save_event_target_as\` in site events + \`event_target:\` in project for scope persistence

### General Event Chain Pattern
\`\`\`
1. Entry trigger (on_action / MTTH / situation / anomaly / planet_event)
2. Branch events (player choices create diverging paths via options)
3. Follow-ups via on_actions (physical triggers), MTTH (probabilistic), or days = X (hard delay)
4. Resolution event (grants rewards, clears flags/variables)
\`\`\`
- Use \`set_country_flag\` / \`set_global_flag\` to track chain state
- Use \`event_target:\` to pass scope references across chain links
- Use \`saved_event_target:\` for cross-event scope persistence

### Scope Chain Rules (Verified from CWTools .cwt Rules)

#### Archaeological Site Scopes (source: anomalies_and_archaeology.cwt)
| Context | this | from | ROOT |
|---------|------|------|------|
| weight | planet | — | planet |
| allow / potential | fleet | archaeological_site | fleet |
| visible / on_visible | country | archaeological_site | country |
| on_create | archaeological_site | — | archaeological_site |
| on_roll_failed | fleet | archaeological_site | fleet |
| stage event | fleet | archaeological_site | fleet |
| on_arch_stage_finished | fleet | archaeological_site | fleet |
| on_arch_site_finished | fleet | archaeological_site | fleet |

#### Special Project Scopes (source: special_projects.cwt)
| Context | this | from | Notes |
|---------|------|------|-------|
| fail_trigger / abort_trigger | country | event_scope (MIGHT NOT EXIST) | push_scope = country |
| on_success | event_scope* | creation scope | *depends on event_scope field |
| on_fail / on_cancel | country | creation scope | push_scope = country |

#### Common Scope Transitions
| From | To | Mechanism | Notes |
|------|----|-----------|-------|
| Fleet | Country | \`owner = { ... }\` | In fleet_event |
| Fleet | Planet | \`from = { planet = { } }\` or \`orbit = { }\` | Via arc site's planet |
| Country | Planet | \`capital_scope\` / \`random_owned_planet\` | |
| Planet | Country | \`owner = { ... }\` | |
| System | Planet | \`random_system_planet = { ... }\` | |
| Any | Saved | \`event_target:name = { ... }\` | Cross-event persistence |

### on_action Trigger Points (Verified from on_actions.csv)

#### Planet-Scope (this=planet, root=planet)
- \`on_colonized\` — planet colonized
- \`on_building_complete\` — building finished
- \`on_district_complete\` — district finished
- \`on_blocker_cleared\` — blocker cleared
- \`on_colony_1_year_old\` ... \`on_colony_10_years_old\` — colony age milestones

#### Planet-Scope with FROM=country (this=planet, from=country)
- \`on_terraforming_complete\` — terraforming done
- \`on_planet_transfer\` — planet transferred
- \`on_planet_conquer\` — planet conquered

#### Country-Scope (this=country, root=country)
- \`on_tech_increased\` — technology completed
- \`on_monthly_pulse_country\` — monthly pulse
- \`on_yearly_pulse_country\` — yearly pulse

#### Ship/Fleet-Scope
- \`on_survey\` — survey completed (this=ship, from=planet)
- \`on_planet_surveyed\` — planet surveyed (this=planet, from=country, fromfrom=fleet)
- \`on_entering_system_fleet\` — fleet enters system (this=fleet, from=system)

#### Archaeological on_actions
- \`on_arch_stage_finished\` — excavation stage done (this=fleet, from=archaeological_site)
- \`on_arch_site_finished\` — excavation complete (this=fleet, from=archaeological_site)
- \`on_relic_activated\` — relic activated (this=country, root=country)

## Deep Coupling Subsystem Reference (Engine-First Design)
When designing complex features spanning multiple game subsystems, think in terms of
**engine entities, not text-only event chains**. The following layers are available for
cross-system coupling and should be considered during blueprint planning:

### Stellaris common/ Design Space Review
Before planning a complex event chain, inventory \`common/\` and build a capability map. Do not treat
"richness" as adding random subsystems; treat it as choosing the right engine entities for entry,
progression, player agency, rewards, AI behavior, and cleanup.

Recommended directory families to consider (verify availability with \`list_directory("common")\`, \`query_types\`, and CWT rules for the user's install/config):
- **Entry hooks and flow control**: \`common/on_actions\`, \`common/event_chains\`, \`common/scripted_effects\`, \`common/scripted_triggers\`, \`common/script_values\`, \`common/game_rules\`.
- **Exploration and progression anchors**: \`common/anomalies\` (\`anomaly_category\`), \`common/archaeological_site_types\` (\`archaeological_site_type\`), \`common/special_projects\`, \`common/situations\`, \`common/astral_rifts\`, \`common/astral_actions\`, \`common/first_contact\`, \`common/intel_categories\`, \`common/intel_levels\`, \`common/storm_types\`.
- **Map and spatial presence**: \`common/solar_system_initializers\`, \`common/star_classes\`, \`common/planet_classes\`, \`common/deposits\`, \`common/deposit_categories\`, \`common/megastructures\`, \`common/bypass\`, \`common/ambient_objects\`, \`common/dust_clouds\`, \`common/terraform_links\`.
- **Rewards and economy**: \`common/relics\`, \`common/artifact_actions\`, \`common/technology\`, \`common/buildings\`, \`common/districts\`, \`common/pop_jobs\`, \`common/pop_categories\`, \`common/resources\`, \`common/static_modifiers\`, modifier category enums, \`common/decisions\`, \`common/edicts\`, \`common/policies\`, \`common/traits\`, \`common/ascension_perks\`, \`common/traditions\`.
- **Political, diplomatic, and AI context**: \`common/personalities\`, \`common/country_types\`, \`common/federation_laws\` / \`common/federation_perks\` / \`common/federation_types\`, \`common/galactic_focuses\`, \`common/resolution_categories\`, \`common/resolutions\`, \`common/espionage_operation_categories\`, \`common/espionage_assets\`, \`common/espionage_operation_types\`, \`common/agreement_terms\`, \`common/agreement_term_values\`, \`common/agreement_presets\`, \`common/agreement_resources\`, \`common/pop_faction_types\`, \`common/ethics\`, \`common/governments\`, \`common/governments/civics\`, \`common/governments/authorities\`, \`common/governments/councilors\`.

For each serious candidate, record whether it is selected, what concrete entity type it contributes,
which scope it operates in, and why it is better than a pure event-only implementation. Also record
why rejected common directories are not used, so the design stays broad without becoming fragmented.

### Layer 1 — Spatial & Map (physical presence on the star map)
- \`solar_system_initializers\`: Generate dedicated physical star systems
- \`ambient_objects\` / \`dust_clouds\`: Environmental entities within systems
- \`megastructures\`: Repairable or constructible mega-scale structures

### Layer 2 — Dynamic Progression (time-spanning mechanics with player participation)
- \`situations\`: Long-term crises/celebrations with staged progression, monthly ticks, and dedicated UI
- \`archaeological_site_types\`: Multi-stage excavation with randomized branching
- \`special_projects\` / \`astral_rifts\`: Tasks requiring physical ship/leader dispatch

### Layer 3 — Player Agency & Economy (interactive tools for the player)
- \`decisions\`: Planet-scoped player actions
- \`edicts\` / \`policies\`: Empire-wide resource allocation and modifiers
- \`relics\`: Permanent passive bonuses with activatable effects (\`active_effect\`)
- \`buildings\` / \`pop_jobs\` / \`districts\`: Micro-economic entity rewards

### Layer 4 — Listeners, Hooks & Delays (seamless event flow triggers)
- \`on_actions\`: Native hooks (\`on_entering_system_fleet\`, \`on_planet_surveyed\`, \`on_arch_site_finished\`, etc.)
- \`MTTH (mean_time_to_happen)\`: Probabilistic time-based triggers for organic pacing
- \`days = X\` delays can be **combined** with the above as fallback triggers

### Golden Architecture A: Immersive Exploration Loop
\\\`\\\`\\\`
Entry (anomaly/tech) → spawn_system (initializer) → on_entering_system_fleet (on_action)
  → archaeological_site / special_project (progression) → relic + technology + decisions (resolution)
\\\`\\\`\\\`

### Golden Architecture B: Empire Crisis Mechanism
\\\`\\\`\\\`
Entry (MTTH/on_yearly_pulse/tech) → situation (staged progression with static_modifiers)
  → edicts + decisions (player agency) → on_fail/on_success (multi-ending resolution)
\\\`\\\`\\\`
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

## Strict Adherence to query_rules Schema (CRITICAL)
PDXScript is strictly typed. You MUST EXACTLY follow the syntax returned by the \`query_rules\` tool.
- **Do NOT Guess**: If unsure about parameters, you MUST use \`query_rules\` before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties into a block unless explicitly listed.

## HOI4 Scope System
HOI4 scopes: Country, State, Character, Division, MilitaryIndustrialOrganization, Operative
You can chain scopes using dot notation or nested blocks. Treat logical native links as hypotheses to verify with CWT/LSP evidence before final code.
- \`ROOT\`, \`FROM\`, \`PREV\` — context-relative references
- \`owner\` → State to Country
- \`capital\` → Country to State
- \`controller\` → State to Country
- \`tag\` → Country identifier
Treat logical scope transitions as plausible until verified; do not reject or approve them solely from model memory.

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
**ALWAYS query LSP tools** — do NOT rely on memory. Use \`query_types\`, \`query_rules\`, \`workspace_symbols\` for any game construct lookups. LLM knowledge of HOI4 constructs is frequently hallucinated.

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
- Boolean values: \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`
- Comments: \`#\` for line comments

### Statement Separators (CRITICAL — DO NOT MISAPPLY)
- PDXScript has **NO semicolons**. The \`;\` character is **NEVER valid syntax**.
- Statements are separated by **whitespace** (newlines or spaces).
- **NEVER suggest adding \`;\` between statements** — this will break the code.

## Strict Adherence to query_rules Schema (CRITICAL)
PDXScript is strictly typed. You MUST EXACTLY follow the syntax returned by the \`query_rules\` tool.
- **Do NOT Guess**: If unsure about parameters, you MUST use \`query_rules\` before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties into a block unless explicitly listed.

## EU4 Scope System
EU4 scopes: Country, Province, TradeNode, Advisor, Monarch, Heir, Consort, RebelFaction
You can chain scopes using dot notation or nested blocks. Treat logical transitions as native-link hypotheses to verify with CWT/LSP evidence before final code.
- \`ROOT\`, \`FROM\`, \`PREV\` — context-relative references
- \`owner\` → Province to Country
- \`capital_scope\` → Country to Province
- \`controller\` → Province to Country
Treat logical scope transitions as plausible until verified; do not reject or approve them solely from model memory.

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
Use \`query_types\`, \`query_rules\`, \`workspace_symbols\` for game construct lookups. Never rely on memory for EU4 constructs — LLM knowledge is frequently hallucinated.

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
- Boolean values: \`yes\` or \`no\` (NEVER \`true\`/\`false\`)
- Comparison operators in triggers: \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`
- Comments: \`#\` for line comments
- Variables: \`@variable_name\`
- Script values: \`value:script_value_name\`

### Statement Separators (CRITICAL — DO NOT MISAPPLY)
- PDXScript has **NO semicolons**. The \`;\` character is **NEVER valid syntax**.
- Statements are separated by **whitespace** (newlines or spaces).
- **NEVER suggest adding \`;\` between statements** — this will break the code.

## Strict Adherence to query_rules Schema (CRITICAL)
PDXScript is strictly typed. You MUST EXACTLY follow the syntax returned by the \`query_rules\` tool.
- **Do NOT Guess**: If unsure about parameters, you MUST use \`query_rules\` before writing code.
- **Never Invent Parameters**: Do NOT add arbitrary properties into a block unless explicitly listed.

## CK3 Scope System
CK3 scopes: Character, Title, Province, County, Duchy, Kingdom, Empire, Culture, Faith, Dynasty, House
- \`root\`, \`scope:character\`, \`prev\` — context references
- CK3 uses data types extensively — scopes are strongly typed
- \`liege\`, \`vassal\` → Character to Character
- \`capital_province\` → Title to Province
- \`holder\` → Title to Character
- \`faith\`, \`culture\` → Character to Faith/Culture
Treat logical scope transitions as plausible until verified; do not reject or approve them solely from model memory.

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
Use CWTools LSP tools for all construct lookups. \`query_types\`, \`query_rules\`, \`workspace_symbols\` are your primary tools. LLM knowledge of CK3 constructs is frequently hallucinated — always verify with the LSP.

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
